@echo off
rem Double-click to watch the bot's live log on your server. Close the window to stop watching.
set "SERVER="
if exist "%~dp0.server" set /p SERVER=<"%~dp0.server"
if "%SERVER%"=="" set /p SERVER=Server login (like root@203.0.113.10):
ssh -t %SERVER% "journalctl -u gremlin -n 100 -f"
pause
