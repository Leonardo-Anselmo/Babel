@echo off
rem Double-click to open your settings (.env) in Notepad.
cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env" >nul
start "" notepad ".env"
