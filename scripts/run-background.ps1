# JARVIS background runner — unsichtbar, eine Instanz, Logs in .log Dateien
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# Nur eine Instanz per Mutex
$mutex = New-Object System.Threading.Mutex($false, "Global\JARVIS_Background")
if (-not $mutex.WaitOne(0)) { exit }

$env:PATH = "C:\nvm4w\nodejs;$env:USERPROFILE\.local\bin;$env:PATH"

# Falls Bridge schon läuft (Port 8787), nichts neu starten — nur Browser öffnen
try {
  $tcp = New-Object System.Net.Sockets.TcpClient
  $ar = $tcp.BeginConnect("127.0.0.1",8787,$null,$null)
  $wait = $ar.AsyncWaitHandle.WaitOne(800,$false)
  if ($wait -and $tcp.Connected) { $tcp.Close(); Start-Process "http://localhost:5173" -ErrorAction SilentlyContinue; $mutex.ReleaseMutex(); exit }
  $tcp.Close()
} catch {}

# Env wie in start-jarvis.bat
$env:ANTHROPIC_BASE_URL = ""
$env:ANTHROPIC_AUTH_TOKEN = ""
$env:JARVIS_MODEL = ""
if (Test-Path "$root\openrouter.env") {
  Get-Content "$root\openrouter.env" | ForEach-Object {
    if ($_ -match "^\s*#") { return }
    if ($_ -match "^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$") { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
  }
}

# Brain proxy falls nötig
$useProxy = $false
if ($env:BRAIN_PRIORITY -like "*ollama*") { $useProxy = $true }
if ($env:OPENROUTER_API_KEY -and $env:OPENROUTER_API_KEY.Substring(0,5).ToLower() -ne "paste") { $useProxy = $true }

if ($useProxy) {
  if (-not $env:BRAIN_PROXY_PORT) { $env:BRAIN_PROXY_PORT = "8790" }
  if (-not $env:OPENROUTER_MODEL) { $env:OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free" }
  if (-not $env:BRAIN_PRIORITY) { $env:BRAIN_PRIORITY = "openrouter,ollama" }
  Start-Process -FilePath "C:\nvm4w\nodejs\node.exe" -ArgumentList "brain-proxy.mjs" -WindowStyle Hidden -RedirectStandardOutput "$root\brain-proxy.out.log" -RedirectStandardError "$root\brain-proxy.err.log" -WorkingDirectory $root
  Start-Sleep -Seconds 2
  $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$($env:BRAIN_PROXY_PORT)"
  if ($env:BRAIN_PROXY_SECRET) { $env:ANTHROPIC_CUSTOM_HEADERS = "x-brain-secret: $($env:BRAIN_PROXY_SECRET)" }
  $env:ANTHROPIC_AUTH_TOKEN = ""
  $env:ANTHROPIC_API_KEY = if ($env:OPENROUTER_API_KEY) { $env:OPENROUTER_API_KEY } else { "sk-jarvis-local" }
  $env:JARVIS_MODEL = "claude-sonnet-4-5"
  $env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-sonnet-4-5"
  $env:ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-4-5"
  $env:ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-sonnet-4-5"
  $env:CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1"
  $env:DISABLE_TELEMETRY = "1"
}

$env:JARVIS_ALLOW_WRITES = "1"
$env:MCP_TOOL_TIMEOUT = "90000"
$env:MCP_TIMEOUT = "30000"

# Bridge + Vite als Hidden-Prozesse
Start-Process -FilePath "C:\nvm4w\nodejs\node.exe" -ArgumentList "bridge/server.mjs" -WindowStyle Hidden -RedirectStandardOutput "$root\bridge-writes.out.log" -RedirectStandardError "$root\bridge-writes.out.log" -WorkingDirectory $root
Start-Sleep -Seconds 3
Start-Process -FilePath "C:\nvm4w\nodejs\node.exe" -ArgumentList "node_modules/vite/bin/vite.js" -WindowStyle Hidden -RedirectStandardOutput "$root\dev.out.log" -RedirectStandardError "$root\dev.out.log" -WorkingDirectory $root
Start-Sleep -Seconds 5

# Browser öffnen
$edge = $null
if (Test-Path "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe") { $edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" }
elseif (Test-Path "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }

if ($edge) {
  Start-Process -FilePath $edge -ArgumentList "--app=http://localhost:5173 --app-window-size=1280,900"
} else {
  Start-Process "http://localhost:5173"
}
$mutex.ReleaseMutex()
