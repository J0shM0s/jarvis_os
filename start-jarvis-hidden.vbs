' JARVIS hidden launcher — no terminals visible
' Doppelklick startet Bridge + Face komplett im Hintergrund
' Beenden via Task-Manager oder stop-jarvis.vbs

Set WshShell = CreateObject("WScript.Shell")
curDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))

' PowerShell hidden starten (nutzt nvm nodejs)
WshShell.Run "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & curDir & "scripts\run-background.ps1""", 0, False
