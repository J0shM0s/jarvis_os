' Stoppt alle JARVIS Hintergrund-Prozesse
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -Command ""Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*jarvis*' -or $_.CommandLine -like '*bridge*' } | Stop-Process -Force; taskkill /FI ""WINDOWTITLE eq JARVIS*"" /F 2>nul""", 0, False
MsgBox "JARVIS gestoppt (falls lief).", 64, "JARVIS"
