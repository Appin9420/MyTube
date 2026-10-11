' Hidden launcher for the MyTube tray app (scheduled task MyTubeHeadlessServer).
' A .vbs is used so the logon start does not flash a console window.
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\MyTube\desktop\scripts\headless-server-tray.ps1""", 0, False
