' Menjalankan Joko (WhatsApp Assistant) secara tersembunyi lewat supervisor:
' restart otomatis bila crash, satu instance saja, log harian di folder logs\.
' Dipanggil otomatis saat login (folder Startup Windows).
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "d:\My Github Repo in here\kantor-agent"
WshShell.Run """C:\Program Files\nodejs\node.exe"" ""d:\My Github Repo in here\kantor-agent\joko-supervisor.mjs""", 0, False
