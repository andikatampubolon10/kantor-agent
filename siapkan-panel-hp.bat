@echo off
rem Siapkan akses panel Joko dari HP lewat Tailscale (lihat siapkan-panel-hp.ps1).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0siapkan-panel-hp.ps1"
echo.
pause
