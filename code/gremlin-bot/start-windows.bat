@echo off
rem Runs Gremlin on this PC (for testing before you put it on a server).
rem Close this window or press Ctrl+C to stop it.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org, install it, then run this again.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)"
if errorlevel 1 (
  echo Your Node.js is too old. Install the LTS version from https://nodejs.org, then run this again.
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Created .env. Fill in your keys in the Notepad window, save it, then run this again.
  notepad ".env"
  pause
  exit /b 0
)

if not exist "node_modules" (
  echo Installing libraries, one moment...
  call npm ci --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

call npm run check
if errorlevel 1 (
  echo.
  echo Some checks failed ^(see the FAIL lines above^). Usually a key in .env needs fixing.
  echo If it is only temporary, like ElevenLabs credits running out or a network hiccup, you can start anyway.
  choice /c YN /n /m "Start anyway? Press Y or N: "
  if errorlevel 2 (
    pause
    exit /b 1
  )
)

rem Clicking inside this window would pause the bot: Windows "QuickEdit" freezes a program
rem while text is selected. Turn QuickEdit off for this window only (harmless if it fails).
powershell -NoProfile -Command "$t=Add-Type -PassThru -Name Q -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")]public static extern System.IntPtr GetStdHandle(int h);[DllImport(\"kernel32.dll\")]public static extern bool GetConsoleMode(System.IntPtr h,out uint m);[DllImport(\"kernel32.dll\")]public static extern bool SetConsoleMode(System.IntPtr h,uint m);';$h=$t::GetStdHandle(-10);[uint32]$m=0;if($t::GetConsoleMode($h,[ref]$m)){[void]$t::SetConsoleMode($h,($m -bor 0x80) -band (-bnot 0x40))}" >nul 2>nul

echo.
echo Starting the bot. Leave this window open while you play. Close it to stop the bot.
call npm start
pause
