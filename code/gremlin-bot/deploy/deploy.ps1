# Uploads the bot to your server and (re)starts it. Run deploy-to-server.bat instead of this.
param([string]$Server)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$serverFile = Join-Path $PSScriptRoot '.server'
$saved = ''
if (Test-Path -LiteralPath $serverFile) {
  $raw = Get-Content -LiteralPath $serverFile -Raw
  if ($raw) { $saved = $raw.Trim() }
}

if (-not $Server) {
  if ($saved) {
    $answer = (Read-Host "Server [$saved] (press Enter to use it, or type a new one)").Trim()
    $Server = if ($answer) { $answer } else { $saved }
  } else {
    Write-Host 'What is your server login? It looks like root@203.0.113.10 (use your server''s IP address).'
    $Server = (Read-Host 'Server').Trim()
  }
}
if (-not $Server) { throw 'No server given.' }
if ($Server -notmatch '@') { $Server = "root@$Server" }

if (-not (Test-Path -LiteralPath (Join-Path $root '.env'))) {
  throw 'No .env file next to package.json. Copy .env.example to .env and fill in your keys first.'
}
# Windows' own tar (bsdtar). A GNU tar earlier in PATH would misread C:\ paths.
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $tar)) { $tar = 'tar' }

foreach ($cmd in 'ssh', 'scp', $tar) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "$cmd is missing. On Windows 10/11 it comes with the built-in OpenSSH Client (Settings > System > Optional features)."
  }
}

$archive = Join-Path $env:TEMP 'gremlin-upload.tgz'
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }

Write-Host "`nPacking the bot..." -ForegroundColor Cyan
& $tar -czf $archive --exclude=node_modules --exclude=data --exclude=.git --exclude=.server -C $root .
if ($LASTEXITCODE -ne 0) { throw 'Packing failed.' }

try {
  Write-Host "Uploading to $Server (the first time it asks whether to trust the server: type yes)..." -ForegroundColor Cyan
  scp $archive "${Server}:gremlin-upload.tgz"
  if ($LASTEXITCODE -ne 0) { throw 'Upload failed. Check the server address and that your SSH key was added when you created the server.' }
} finally {
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
}

Write-Host 'Installing and starting on the server (the first time takes a few minutes)...' -ForegroundColor Cyan
# The upload holds your keys: it lands in your private home folder (not the shared /tmp),
# is unpacked privately (umask 077), and is deleted by the setup script.
# (No double quotes in here: Windows PowerShell 5.1 mangles them when calling ssh.exe.)
$remote = 'set -e; umask 077; chmod 600 ~/gremlin-upload.tgz; rm -rf /tmp/gremlin-upload; mkdir -p /tmp/gremlin-upload; ' +
  'tar --no-same-owner --no-same-permissions --warning=no-unknown-keyword -xzf ~/gremlin-upload.tgz -C /tmp/gremlin-upload; ' +
  'rm -f ~/gremlin-upload.tgz; sed -i ''s/\r$//'' /tmp/gremlin-upload/deploy/setup-server.sh; ' +
  'if [ $(id -u) -eq 0 ]; then bash /tmp/gremlin-upload/deploy/setup-server.sh /tmp/gremlin-upload; ' +
  'else sudo bash /tmp/gremlin-upload/deploy/setup-server.sh /tmp/gremlin-upload; fi'
ssh -t $Server $remote
if ($LASTEXITCODE -ne 0) { throw 'Setup on the server reported a problem (see above).' }

# Remember the server only once a deploy has worked, so a typo never sticks.
Set-Content -LiteralPath $serverFile -Value $Server -NoNewline
Write-Host "`nDone. Gremlin is live. Use /join in Discord." -ForegroundColor Green
