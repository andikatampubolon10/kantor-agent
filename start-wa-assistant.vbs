' VBScript Runner untuk menjalankan Antigravity WhatsApp Assistant secara tersembunyi (tanpa jendela CMD)
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "d:\My Github Repo in here\kantor-agent"
WshShell.Run """C:\Program Files\nodejs\node.exe"" ""d:\My Github Repo in here\kantor-agent\wa-assistant.mjs""", 0, False

