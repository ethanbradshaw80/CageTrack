@echo off
REM ============================================================
REM  Start CageTrack - double-click this file to launch the
REM  dashboard. It starts the local server and opens your browser.
REM  To stop it later, just close the server window that pops up.
REM ============================================================
cd /d "%~dp0"
start "CageTrack Server" powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0dev-server.ps1"
timeout /t 2 /nobreak >nul
start "" http://localhost:5522
exit
