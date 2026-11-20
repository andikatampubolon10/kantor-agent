@echo off
cd /d "d:\My Github Repo in here\kantor-agent"
echo ====================================================
echo   Menghentikan Joko (WhatsApp Assistant)...
echo ====================================================
if not exist logs mkdir logs
rem 1) Minta supervisor berhenti rapi (supervisor tidak akan me-restart Joko lagi)
echo stop> "logs\joko-supervisor.stop"
ping -n 7 127.0.0.1 >nul
rem 2) Cadangan: hentikan paksa supervisor & proses yang masih memakai port 8795
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'joko-supervisor\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
for /f "tokens=5" %%a in ('netstat -aon ^| findstr "127.0.0.1:8795" ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
if exist "logs\joko-supervisor.stop" del "logs\joko-supervisor.stop"
echo Joko telah dihentikan.
timeout /t 3
