@echo off
rem One-time setup: free speech-to-text on your NVIDIA graphics card (Whisper).
rem Downloads about 4 GB into %LOCALAPPDATA%\WinslowWhisper (not OneDrive). Safe to run again.
title Whisper setup
cd /d "%~dp0"
rem Clicking inside this window would pause the setup (Windows "QuickEdit"): turn that off here.
powershell -NoProfile -Command "$t=Add-Type -PassThru -Name Q -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")]public static extern System.IntPtr GetStdHandle(int h);[DllImport(\"kernel32.dll\")]public static extern bool GetConsoleMode(System.IntPtr h,out uint m);[DllImport(\"kernel32.dll\")]public static extern bool SetConsoleMode(System.IntPtr h,uint m);';$h=$t::GetStdHandle(-10);[uint32]$m=0;if($t::GetConsoleMode($h,[ref]$m)){[void]$t::SetConsoleMode($h,($m -bor 0x80) -band (-bnot 0x40))}" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0whisper\setup-whisper.ps1"
echo.
pause
