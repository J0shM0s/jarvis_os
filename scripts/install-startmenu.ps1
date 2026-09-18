# Legt JARVIS ins Windows Startmenü (per Suche "JARVIS" startbar)
# Ausführen: powershell -ExecutionPolicy Bypass -File scripts\install-startmenu.ps1

$root = Split-Path $PSScriptRoot -Parent
$startMenu = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
$ws = New-Object -ComObject WScript.Shell

# 1. Haupt-Shortcut: startet hidden
$lnk = $ws.CreateShortcut("$startMenu\JARVIS.lnk")
$lnk.TargetPath = "wscript.exe"
$lnk.Arguments = """$root\start-jarvis-hidden.vbs"""
$lnk.WorkingDirectory = $root
$lnk.Description = "J.A.R.V.I.S. starten (Hintergrund)"
$lnk.IconLocation = "$root\public\favicon.svg"
# Falls favicon.svg kein Icon liefert, nutze Edge-Icon
if (-not (Test-Path "$root\public\favicon.svg")) { $lnk.IconLocation = "shell32.dll,21" }
$lnk.Save()
Write-Host "✓ Startmenü: JARVIS.lnk erstellt -> tippe 'JARVIS' in Windows-Suche"

# 2. Stop-Shortcut
$lnk2 = $ws.CreateShortcut("$startMenu\JARVIS stoppen.lnk")
$lnk2.TargetPath = "wscript.exe"
$lnk2.Arguments = """$root\stop-jarvis.vbs"""
$lnk2.WorkingDirectory = $root
$lnk2.Description = "JARVIS Hintergrund stoppen"
$lnk2.IconLocation = "shell32.dll,27"
$lnk2.Save()
Write-Host "✓ Startmenü: JARVIS stoppen.lnk erstellt"

# 3. Optional: Autostart
$choice = Read-Host "Beim Windows-Start automatisch starten? (j/n)"
if ($choice -eq "j" -or $choice -eq "J") {
  $auto = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\JARVIS.lnk"
  Copy-Item "$startMenu\JARVIS.lnk" $auto -Force
  Write-Host "✓ Autostart aktiviert"
}

Write-Host "`nFertig! Drücke Win und tippe JARVIS"
