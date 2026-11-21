@echo off
rem Buka panel admin Joko di browser dan masuk otomatis dengan token lokal.
cd /d "%~dp0"
if not exist ".joko-admin-token" (
  echo Token admin belum ada. Jalankan Joko dulu ^(start-wa-assistant.bat^), lalu coba lagi.
  pause
  exit /b 1
)
set /p JOKO_ADMIN_TOKEN=<.joko-admin-token
start "" "http://127.0.0.1:8795/admin#token=%JOKO_ADMIN_TOKEN%"
set JOKO_ADMIN_TOKEN=
