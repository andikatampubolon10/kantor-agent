@echo off
echo ====================================================
echo   Menghentikan Antigravity WhatsApp Assistant...
echo ====================================================
taskkill /F /IM cloudflared.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8795') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo ✅ Server dan tunnel telah dihentikan.
timeout /t 3

