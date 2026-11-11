#!/usr/bin/env bash
# Installs or updates Gremlin on an Ubuntu/Debian server.
# deploy-to-server.bat runs this for you; you never need to run it by hand.
#
# What it does:
#   - first time: automatic security updates, and a firewall that only lets SSH in
#     (the bot needs no open ports; it only makes outgoing connections)
#   - installs Node.js 22 if needed
#   - builds the new version next to the running one, tests your keys, then swaps
#     it in. If the new version won't start, it puts the old one back.
#   - runs the bot as a locked-down background service that restarts on crash and reboot
set -euo pipefail
umask 022

SRC="${1:-/tmp/gremlin-upload}"
APP=/opt/gremlin-bot
NEXT=/opt/gremlin-bot.next
PREV=/opt/gremlin-bot.prev
SVC=gremlin
USER_NAME=gremlin
HOME_DIR=/var/lib/gremlin
DATA_DIR=$HOME_DIR/data

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run this as root (the deploy script uses sudo for you)."
command -v apt-get >/dev/null || fail "This script expects Ubuntu or Debian."
[ -f "$SRC/package.json" ] || fail "Can't find the uploaded bot files in $SRC."

# The upload contains your .env (API keys), so always delete it when done.
case "$SRC" in
  /tmp/*) trap 'rm -rf "$SRC" /tmp/gremlin-upload.tgz' EXIT ;;
esac

export DEBIAN_FRONTEND=noninteractive
# Fresh servers run their own updates for a few minutes after boot; wait for the lock instead of failing.
APT_OPTS=(-y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

apt_update() {
  # The package-list lock isn't covered by DPkg::Lock::Timeout, so retry while
  # the server finishes its own first-boot updates.
  local i
  for i in $(seq 1 60); do
    if apt-get "${APT_OPTS[@]}" update; then return 0; fi
    echo "Package lists are busy (the server is still doing its own first-boot updates). Retrying in 5 seconds ($i/60)..."
    sleep 5
  done
  return 1
}

node_ok() { # usage: node_ok /path/to/node
  [ -x "$1" ] || return 1
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' 2>/dev/null
}

install_node_tarball() {
  # Fallback: official build from nodejs.org, checksum-verified.
  local arch base file sums
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) echo "Unsupported CPU: $(uname -m)" >&2; return 1 ;;
  esac
  base=https://nodejs.org/dist/latest-v22.x
  sums="$(mktemp)"
  curl -fsSLo "$sums" "$base/SHASUMS256.txt" || return 1
  file="$(awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2}' "$sums" | head -n1)"
  [ -n "$file" ] || return 1
  curl -fsSLo "/tmp/$file" "$base/$file" || return 1
  (cd /tmp && grep " $file\$" "$sums" | sha256sum -c -) || return 1
  tar -xJf "/tmp/$file" -C /usr/local --strip-components=1 --no-same-owner
  rm -f "/tmp/$file" "$sums"
  hash -r
}

FIRST_RUN=0
[ -f /etc/systemd/system/$SVC.service ] || FIRST_RUN=1

if [ "$FIRST_RUN" -eq 1 ]; then
  say "First-time server setup"
  if command -v cloud-init >/dev/null; then cloud-init status --wait >/dev/null 2>&1 || true; fi
  # Small servers need swap so npm installs don't run out of memory.
  if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 1500000 ] && ! swapon --show | grep -q .; then
    fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  apt_update || fail "Couldn't refresh the package lists. Wait a few minutes and deploy again."
  apt-get "${APT_OPTS[@]}" upgrade
  apt-get "${APT_OPTS[@]}" install ca-certificates curl gnupg ufw unattended-upgrades rsync xz-utils

  say "Automatic security updates"
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades

  say "Firewall: block everything incoming except SSH"
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow OpenSSH >/dev/null
  ufw --force enable
fi

# The service needs a system-wide Node 22.12+ (not one installed under a home folder).
NODE_BIN=""
for candidate in /usr/bin/node /usr/local/bin/node; do
  if node_ok "$candidate"; then NODE_BIN="$candidate"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  say "Installing Node.js 22"
  if curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get "${APT_OPTS[@]}" install nodejs && node_ok /usr/bin/node; then
    NODE_BIN=/usr/bin/node
  else
    echo "NodeSource install didn't work; using the official nodejs.org build instead."
    install_node_tarball || fail "Couldn't install Node.js. Check the server's internet connection and run the deploy again."
    node_ok /usr/local/bin/node || fail "Node.js install finished but the version is still too old."
    NODE_BIN=/usr/local/bin/node
  fi
fi
NPM_BIN="$(dirname "$NODE_BIN")/npm"
[ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm)"
echo "Node.js $("$NODE_BIN" -v) at $NODE_BIN"

if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --home-dir "$HOME_DIR" --create-home --shell /usr/sbin/nologin "$USER_NAME"
fi
mkdir -p "$DATA_DIR"
chown "$USER_NAME":"$USER_NAME" "$HOME_DIR" "$DATA_DIR"
chmod 750 "$HOME_DIR" "$DATA_DIR"

say "Preparing the new version"
rm -rf "$NEXT"
mkdir -p "$NEXT"
rsync -a --chmod=D755,F644 \
  --exclude node_modules --exclude data --exclude .env --exclude .server \
  "$SRC/" "$NEXT/"
# Created private from the start (umask 077), then shared with the service account below.
if [ -f "$SRC/.env" ]; then
  (umask 077; sed 's/\r$//' "$SRC/.env" > "$NEXT/.env")
elif [ -f "$APP/.env" ]; then
  (umask 077; cp "$APP/.env" "$NEXT/.env")
else
  fail "No .env was uploaded. Create one next to package.json on your PC, then deploy again."
fi
chown root:"$USER_NAME" "$NEXT/.env"
chmod 640 "$NEXT/.env"

say "Installing libraries"
(cd "$NEXT" && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" ci --omit=dev --no-audit --no-fund) \
  || fail "Installing libraries failed. The running bot (if any) was left untouched."

say "Testing your keys"
if (cd "$NEXT" && timeout 180 runuser -u "$USER_NAME" -- env DATA_DIR="$DATA_DIR" "$NODE_BIN" src/check.js); then
  echo "All checks passed."
else
  printf '\033[1;33mSome checks failed (see the FAIL lines above).\033[0m\n'
  answer=y
  if [ -t 0 ]; then
    read -r -p "Fix them in .env and deploy again (recommended), or start anyway? Type y to start anyway [y/N]: " answer || answer=n
  fi
  case "$answer" in
    y|Y|yes|YES) echo "Starting anyway." ;;
    *) rm -rf "$NEXT"; fail "Deploy cancelled. The running bot (if any) was left untouched." ;;
  esac
fi

say "Switching to the new version"
systemctl stop "$SVC" 2>/dev/null || true
rm -rf "$PREV"
[ -d "$APP" ] && mv "$APP" "$PREV"
mv "$NEXT" "$APP"

cat > /etc/systemd/system/$SVC.service <<UNIT
[Unit]
Description=Gremlin Discord voice bot
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$APP
ExecStart=$NODE_BIN src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=DATA_DIR=$DATA_DIR
# Lock it down: it can only write to its own data folder.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=$DATA_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
CapabilityBoundingSet=
MemoryMax=600M

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SVC" >/dev/null 2>&1
systemctl restart "$SVC"
restarts_before="$(systemctl show -p NRestarts --value "$SVC" 2>/dev/null || echo 0)"

say "Starting up"
sleep 12
restarts_after="$(systemctl show -p NRestarts --value "$SVC" 2>/dev/null || echo 0)"
if ! systemctl is-active --quiet "$SVC" || [ "$restarts_after" != "$restarts_before" ]; then
  journalctl -u "$SVC" -n 30 --no-pager || true
  if [ -d "$PREV" ]; then
    printf '\n\033[1;31mThe new version keeps crashing (log above). Putting the previous version back.\033[0m\n'
    systemctl stop "$SVC" || true
    rm -rf "$APP"
    mv "$PREV" "$APP"
    systemctl restart "$SVC"
  fi
  fail "Gremlin did not start cleanly. Read the log lines above for the reason."
fi
journalctl -u "$SVC" -n 15 --no-pager || true
printf '\n\033[1;32mGremlin is running.\033[0m Watch live logs any time with server-logs.bat on your PC.\n'
