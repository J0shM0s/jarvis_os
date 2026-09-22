# JARVIS Tasks installieren — BrainSync + Proaktiv Briefing (ohne Admin via schtasks)
$root = Split-Path $PSScriptRoot -Parent
$node = "C:\nvm4w\nodejs\node.exe"
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { Write-Error "node nicht gefunden"; exit 1 }

function Install-Task($name, $time, $scriptPath, $argList) {
  $tr = "`"$node`" `"$root\$scriptPath`" $argList"
  schtasks /Delete /TN $name /F 2>$null | Out-Null
  $out = schtasks /Create /TN $name /SC DAILY /ST $time /TR $tr /F 2>&1
  if ($LASTEXITCODE -eq 0) { Write-Host "Task $name taeglich $time -> $scriptPath $argList" }
  else { Write-Host "Fehler $name : $out" }
}

Install-Task "JARVIS-Proactive" "08:00" "scripts\proactive.mjs" "--toast"
Install-Task "JARVIS-BrainSync" "20:00" "scripts\brain-sync.mjs" "--push"

Write-Host ""
Write-Host "Fertig! Aufgaben in Aufgabenplanung -> JARVIS-*"
Write-Host "Test: schtasks /Run /TN JARVIS-Proactive"
Write-Host "Anzeigen: schtasks /Query /TN JARVIS-Proactive /FO LIST"
