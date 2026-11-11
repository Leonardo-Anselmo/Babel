# One-time setup for the bot's desktop app (a window to start, stop and set up the bot).
# Started by install-app.bat. Safe to run again.
#
# It downloads the app's runtime (Electron: about 160 MB, 390 MB unpacked) into
# %LOCALAPPDATA%\WinslowApp, outside OneDrive, checks it against its published
# checksum, then opens the app once, which puts a shortcut named after the bot on
# your desktop and in the Start menu. Delete that folder and the shortcuts to remove it.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is far slower with its progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$electronVersion = '44.9.3'
$electronSha256 = '41a1ffa0541cb0f2c9b9fe920dd2cef1793ad0ea2ada1a9582958880f4d1b23c'
$electronUrl = "https://github.com/electron/electron/releases/download/v$electronVersion/electron-v$electronVersion-win32-x64.zip"

$appDir = $PSScriptRoot  # the desktop folder inside the bot folder
$localBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME '.local/share' }
$installDir = Join-Path $localBase 'WinslowApp'
$runtimeDir = Join-Path $installDir "electron-v$electronVersion"
# Renamed from electron.exe, so Task Manager shows the app by name (its first name).
$exe = Join-Path $runtimeDir 'Winslow.exe'

function Say([string]$text, [string]$color = 'Gray') {
  Write-Host $text -ForegroundColor $color
}

try {
  Say "Setting up the bot's desktop app." 'Cyan'
  # Its files can't be replaced while it runs.
  if (Get-Process -Name 'Winslow' -ErrorAction SilentlyContinue) {
    throw 'The app is open. Close it (that stops the bot too), then run this again.'
  }
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null

  if (Test-Path $exe) {
    Say "    The app runtime is already there ($runtimeDir)."
  } else {
    Say "Downloading the app runtime (Electron $electronVersion, about 160 MB). This can take a few minutes..."
    $zip = Join-Path $installDir "electron-v$electronVersion.zip"
    Invoke-WebRequest -Uri $electronUrl -OutFile $zip -UseBasicParsing
    $hash = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $electronSha256) {
      Remove-Item $zip -Force
      throw "The download didn't match its published checksum ($hash). Try again later."
    }
    Say '    Checksum OK. Unpacking...'
    $partial = "$runtimeDir.partial"
    if (Test-Path $partial) { Remove-Item $partial -Recurse -Force }
    if (Test-Path $runtimeDir) { Remove-Item $runtimeDir -Recurse -Force }  # an unfinished earlier try
    # Much faster than Expand-Archive in Windows PowerShell 5.1.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $partial)
    Rename-Item -Path (Join-Path $partial 'electron.exe') -NewName 'Winslow.exe'
    Rename-Item -Path $partial -NewName (Split-Path -Leaf $runtimeDir)
    Remove-Item $zip -Force
  }

  # Older runtimes from earlier versions of this setup are no longer used.
  Get-ChildItem -Path $installDir -Directory -Filter 'electron-v*' |
    Where-Object { $_.FullName -ne $runtimeDir } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

  Say 'Opening the app and adding the shortcuts...'
  Start-Process -FilePath $exe -ArgumentList @("`"$appDir`"", '--install-shortcuts') -WorkingDirectory (Split-Path -Parent $appDir)
  Say ''
  Say 'Done. From now on, open the app from the shortcut on your desktop or in the Start menu (named after your bot).' 'Green'
  exit 0
} catch {
  Say ''
  Say "Setup stopped: $($_.Exception.Message)" 'Red'
  Say 'Nothing is broken: start-windows.bat still works as before.' 'Yellow'
  exit 1
}
