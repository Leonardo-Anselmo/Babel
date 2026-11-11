@echo off
rem One-time setup for the bot's desktop app: a window to start, stop and set up the bot.
rem Afterwards, open it from the shortcut (named after your bot) on your desktop or in the Start menu.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop\install-app.ps1"
if errorlevel 1 (
  pause
  exit /b 1
)
timeout /t 5 >nul
