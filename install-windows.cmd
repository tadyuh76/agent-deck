@echo off
rem Agent Deck for Windows: double-click to install or update.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\setup.ps1" %*
echo.
pause
