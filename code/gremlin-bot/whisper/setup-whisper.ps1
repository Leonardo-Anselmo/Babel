# One-time setup for free speech-to-text on your NVIDIA graphics card (Whisper).
# Started by setup-whisper.bat. Safe to run again: finished steps are skipped or redone cleanly.
#
# Everything goes into %LOCALAPPDATA%\WinslowWhisper (outside OneDrive):
#   bin\uv.exe   a small tool that installs a private copy of Python
#   python\      that private Python 3.12 (nothing is installed system-wide)
#   venv\        faster-whisper and the NVIDIA cuBLAS library (about 750 MB)
#   models\      the Whisper large-v3 model (about 3 GB)
# Delete that folder to remove it all.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is far slower with its progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$uvVersion = '0.12.24'
$uvSha256 = '7c38608c8a18ee137d748a1773053b07ec8f3a30fab49aebaa6f4e4efeceb019'
$uvUrl = "https://github.com/astral-sh/uv/releases/download/$uvVersion/uv-x86_64-pc-windows-msvc.zip"

$botDir = Split-Path -Parent $PSScriptRoot

# The same settings the bot uses: WHISPER_MODEL and WHISPER_HOME in .env (only these are read).
function Read-Setting([string]$name, [string]$default) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value) { return $value }
  $envFile = Join-Path $botDir '.env'
  if (Test-Path $envFile) {
    foreach ($line in Get-Content -Path $envFile) {
      if ($line -match "^\s*$name\s*=\s*(.*?)\s*$" -and $Matches[1]) { return $Matches[1].Trim('"', "'") }
    }
  }
  return $default
}
$model = Read-Setting 'WHISPER_MODEL' 'large-v3'
$defaultHome = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'WinslowWhisper' } else { Join-Path $HOME '.local/share/winslow-whisper' }
$whisperHome = Read-Setting 'WHISPER_HOME' $defaultHome
$binDir = Join-Path $whisperHome 'bin'
$uv = Join-Path $binDir 'uv.exe'
$venv = Join-Path $whisperHome 'venv'
$py = Join-Path $venv 'Scripts\python.exe'
$server = Join-Path $PSScriptRoot 'server.py'
$requirements = Join-Path $PSScriptRoot 'requirements-windows.txt'
$dataDir = Join-Path $botDir 'data'
$logFile = Join-Path $dataDir 'whisper-setup.log'

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Set-Content -Path $logFile -Value "Whisper setup started $(Get-Date -Format 's')" -Encoding UTF8

function Say([string]$text, [string]$color = 'Gray') {
  Write-Host $text -ForegroundColor $color
  Add-Content -Path $logFile -Value $text -Encoding UTF8
}

# Runs a program, shows and logs its output, returns its exit code. (Windows PowerShell
# turns a program's normal stderr chatter into errors, so that is switched off here.)
function Run([string]$exe, [string[]]$arguments) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $global:LASTEXITCODE = $null
  try {
    & $exe @arguments 2>&1 | ForEach-Object {
      $line = "$_"
      if ($line.Trim()) {
        Write-Host "    $line"
        Add-Content -Path $logFile -Value "    $line" -Encoding UTF8
      }
    }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $old
  }
}

# Runs a program quietly and returns what it printed (empty if it isn't there or fails).
function Capture([string]$exe, [string[]]$arguments) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $exe @arguments 2>$null
    return ($out | Out-String).Trim()
  } catch {
    return ''
  } finally {
    $ErrorActionPreference = $old
  }
}

$ok = $false
try {
  Say 'Setting up free speech-to-text on your graphics card (Whisper).' 'Cyan'
  Say "It downloads about 4 GB into $whisperHome. This takes a few minutes." 'Cyan'
  Say ''

  # The bot restarts its speech server if it stops, which would clash with reinstalling it.
  $bot = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'src[\\/]index\.js' }
  if ($bot) {
    Say 'The bot looks like it is running. Close its window first.' 'Yellow'
    Read-Host 'Then press Enter to continue' | Out-Null
  }

  Say 'Step 1 of 5: checking your graphics card and disk space'
  $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if (-not $smi) { throw 'No NVIDIA driver found (nvidia-smi is missing). Install the latest driver from nvidia.com/drivers, then run this again.' }
  $gpu = ((Capture $smi.Source @('--query-gpu=name,memory.total,driver_version', '--format=csv,noheader')) -split "`n" | Select-Object -First 1)
  if (-not $gpu) { throw 'nvidia-smi did not report a graphics card.' }
  Say "    $gpu"
  New-Item -ItemType Directory -Force -Path $whisperHome | Out-Null
  $root = [System.IO.Path]::GetPathRoot($whisperHome)
  $freeGb = [math]::Round((New-Object System.IO.DriveInfo $root).AvailableFreeSpace / 1GB, 1)
  Say "    $freeGb GB free on $root"
  if ($freeGb -lt 8) { throw "Not enough disk space: $freeGb GB free, about 8 GB needed." }
  $sys32 = Join-Path $env:SystemRoot 'System32'
  $missing = @('msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll') | Where-Object { -not (Test-Path (Join-Path $sys32 $_)) }
  if ($missing) {
    throw "The Microsoft Visual C++ Redistributable is missing ($($missing -join ', ')). Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe, then run this again."
  }

  Say 'Step 2 of 5: getting uv (it installs a private copy of Python)'
  if (-not (Test-Path $uv) -or -not ((Capture $uv @('--version')) -match [regex]::Escape($uvVersion))) {
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $zip = Join-Path $whisperHome 'uv.zip'
    Invoke-WebRequest -Uri $uvUrl -OutFile $zip -UseBasicParsing
    $hash = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $uvSha256) {
      Remove-Item $zip -Force
      throw "The uv download didn't match its published checksum ($hash). Try again later."
    }
    Expand-Archive -Path $zip -DestinationPath $binDir -Force
    Remove-Item $zip -Force
  }
  Say "    $(Capture $uv @('--version'))"

  # Keep uv's Python and download cache inside our folder, and ignore any personal uv settings.
  $env:UV_PYTHON_INSTALL_DIR = Join-Path $whisperHome 'python'
  $env:UV_CACHE_DIR = Join-Path $whisperHome 'cache'
  $env:UV_NO_CONFIG = '1'

  Say 'Step 3 of 5: installing Python 3.12 and the speech libraries (about 750 MB)'
  # A copy of the speech server left running from before would lock these files.
  $ours = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($whisperHome, [System.StringComparison]::OrdinalIgnoreCase) })
  if ($ours.Count) {
    Say '    stopping the speech server that is still running'
    foreach ($proc in $ours) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
    Wait-Process -Id ($ours | ForEach-Object { $_.ProcessId }) -Timeout 30 -ErrorAction SilentlyContinue
  }
  $code = Run $uv @('venv', $venv, '--python', '3.12', '--managed-python', '--clear', '--no-progress')
  if ($code -ne 0) { throw "Creating the Python environment failed (uv exit code $code)." }
  $code = Run $uv @('pip', 'install', '--python', $py, '--require-hashes', '-r', $requirements, '--no-progress')
  if ($code -ne 0) { throw "Installing the speech libraries failed (uv exit code $code)." }

  Say "Step 4 of 5: downloading the Whisper $model model (up to 3 GB)"
  $code = Run $py @('-E', '-s', $server, '--download', '--model', $model, '--home', $whisperHome)
  if ($code -ne 0) { throw "Downloading the model failed (exit code $code). Run setup again: it picks up where it stopped." }

  Say 'Step 5 of 5: testing it on your graphics card'
  $sample = Join-Path $dataDir 'voice-test.wav'
  if (Test-Path $sample) {
    $code = Run $py @('-E', '-s', $server, '--self-test', $sample, '--model', $model, '--home', $whisperHome)
    if ($code -eq 4) { throw 'The model loaded but heard nothing in the voice sample. See data\whisper-setup.log.' }
  } else {
    $code = Run $py @('-E', '-s', $server, '--check', '--model', $model, '--home', $whisperHome)
  }
  if ($code -ne 0) { throw "The test on your graphics card failed (exit code $code). See data\whisper-setup.log." }

  $ok = $true
  Say ''
  Say 'WHISPER_SETUP_OK' 'DarkGray'
  Say 'Done. Start the bot again (stop it first if it is running).' 'Green'
  Say 'The start-up check should now show speech-to-text running on your graphics card.' 'Green'
} catch {
  Say ''
  Say "Setup stopped: $($_.Exception.Message)" 'Red'
  Say 'Nothing is broken. Until this works, the bot hears through Deepgram if it has a Deepgram key.' 'Yellow'
} finally {
  Add-Content -Path $logFile -Value "Finished $(Get-Date -Format 's'), success: $ok" -Encoding UTF8
}
if (-not $ok) { exit 1 }
