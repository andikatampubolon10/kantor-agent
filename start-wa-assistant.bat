@echo off
cd /d "d:\My Github Repo in here\kantor-agent"
title Joko - WhatsApp Assistant
echo ====================================================
echo   Memulai Joko (WhatsApp Assistant) di laptop...
echo ====================================================
wscript "start-wa-assistant.vbs"
echo Menunggu Joko siap...
ping -n 9 127.0.0.1 >nul
curl -s http://127.0.0.1:8795/
echo.
echo.
echo Joko berjalan di latar belakang (restart otomatis bila crash).
echo  - Status        : http://127.0.0.1:8795/
echo  - Tautkan WA    : http://127.0.0.1:8795/tautkan
echo  - Log harian    : %CD%\logs\
echo  - Hentikan      : stop-wa-assistant.bat
pause
