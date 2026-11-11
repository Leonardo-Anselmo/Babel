@echo off
rem Double-click to upload Gremlin to your server and (re)start it.
rem Run it again any time you change .env, persona.md or lore.md.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
echo.
pause
