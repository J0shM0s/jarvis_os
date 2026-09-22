@echo off
setlocal EnableDelayedExpansion
rem ============================================================================
rem  JARVIS - einziger Startpunkt (ersetzt start-jarvis.bat + bridge-openrouter.bat)
rem  Doppelklick          -> hidden (keine Fenster, Browser oeffnet automatisch)
rem  start.bat --show     -> sichtbar (Debug, 2 minimierte Fenster + Logs)
rem  start.bat --help     -> Hilfe
rem ============================================================================
cd /d "%~dp0"

if /I "%~1"=="--help" goto HELP
if /I "%~1"=="-h" goto HELP
if /I "%~1"=="help" goto HELP
if /I "%~1"=="--show" goto SHOW

:HIDDEN
rem --- Standard: hidden Start ohne Konsolenflackern -------------------------
rem Wurde start.bat direkt gedoppelklickt, kurz ein CMD-Fenster sichtbar.
rem Fuer 100% flackerfrei das VBS doppelklicken (start-jarvis-hidden.vbs).
rem Hier delegieren wir an das PS1, das alles hidden spawned.
echo JARVIS startet im Hintergrund...
wscript.exe "%~dp0start-jarvis-hidden.vbs" 2>nul
if errorlevel 1 (
  rem Fallback falls wscript/VBS fehlt: direkt PS1 hidden starten
  powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\run-background.ps1"
)
echo JARVIS gestartet (hidden). Browser oeffnet gleich auf http://localhost:5173
echo Beenden mit: stop-jarvis.vbs  oder  Tray - Beenden
timeout /t 3 >nul
exit /b 0

:SHOW
rem --- Sichtbarer Debug-Modus ---------------------------------------------
echo [JARVIS] start --show  (sichtbarer Debug-Modus)

rem ---- Node finden (nvm-Pfad ist nur Fallback, nicht Pflicht) ------------
set "NODE_EXE=node"
where node >nul 2>nul && set "NODE_EXE=node"
if exist "C:\nvm4w\nodejs\node.exe" set "NODE_EXE=C:\nvm4w\nodejs\node.exe"
where node >nul 2>nul
if errorlevel 1 if not exist "C:\nvm4w\nodejs\node.exe" (
  echo [ERR] node nicht gefunden. Bitte Node.js 20+ installieren: https://nodejs.org
  pause
  exit /b 1
)
set "PATH=C:\nvm4w\nodejs;%USERPROFILE%\.local\bin;%PATH%"

rem ---- Env reset + openrouter.env laden (einheitlich, # als Kommentar) ----
set "ANTHROPIC_BASE_URL="
set "ANTHROPIC_AUTH_TOKEN="
set "ANTHROPIC_API_KEY="
set "ANTHROPIC_CUSTOM_HEADERS="
set "JARVIS_MODEL="
set "JARVIS_EFFORT="
if exist openrouter.env (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("openrouter.env") do (
    if not "%%A"=="" set "%%A=%%B"
  )
)
if not defined BRAIN_PROXY_PORT set "BRAIN_PROXY_PORT=8790"

rem ---- Proxy-Entscheidung (einheitlich mit run-background.ps1) ------------
rem use_proxy wenn BRAIN_PRIORITY ollama enthaelt ODER echter OpenRouter-Key
set "USE_PROXY="
if defined BRAIN_PRIORITY (
  echo %BRAIN_PRIORITY% | findstr /I "ollama" >nul && set "USE_PROXY=1"
)
if defined OPENROUTER_API_KEY (
  if /I not "%OPENROUTER_API_KEY:~0,5%"=="PASTE" set "USE_PROXY=1"
)

if defined USE_PROXY (
  echo [brain] Proxy-Modus - Details: brain-proxy.out.log
  if not defined OPENROUTER_MODEL set "OPENROUTER_MODEL=inclusionai/ling-3.0-flash-vl:free"
  if not defined BRAIN_PRIORITY set "BRAIN_PRIORITY=openrouter,ollama"
  rem Wenn Proxy schon laeuft (Port belegt) nicht nochmal starten -> EADDRINUSE vermeiden
  powershell -NoProfile -Command "$c=New-Object System.Net.Sockets.TcpClient; try{ $a=$c.BeginConnect('127.0.0.1',%BRAIN_PROXY_PORT%,$null,$null); $w=$a.AsyncWaitHandle.WaitOne(500,$false); if($w -and $c.Connected){exit 1} }catch{} exit 0" >nul 2>nul
  if errorlevel 1 (
    echo [brain] Proxy laeuft bereits auf Port %BRAIN_PROXY_PORT% - wiederverwendet
  ) else (
    if "%NODE_EXE%"=="node" (
      start "JARVIS proxy" /min cmd /c "node brain-proxy.mjs > brain-proxy.out.log 2>&1"
    ) else (
      start "JARVIS proxy" /min cmd /c ""%NODE_EXE%" brain-proxy.mjs > brain-proxy.out.log 2>&1"
    )
    timeout /t 2 /nobreak >nul
  )
  set "ANTHROPIC_BASE_URL=http://127.0.0.1:%BRAIN_PROXY_PORT%"
  if defined BRAIN_PROXY_SECRET set "ANTHROPIC_CUSTOM_HEADERS=x-brain-secret: %BRAIN_PROXY_SECRET%"
  set "ANTHROPIC_AUTH_TOKEN="
  set "ANTHROPIC_API_KEY=%OPENROUTER_API_KEY%"
  if not defined ANTHROPIC_API_KEY set "ANTHROPIC_API_KEY=sk-jarvis-local"
  set "JARVIS_MODEL=claude-sonnet-4-5"
  set "ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-sonnet-4-5"
  set "ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-5"
  set "ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-4-5"
  set "DISABLE_TELEMETRY=1"
  set "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1"
) else (
  echo [brain] Claude Code Login
  set "JARVIS_EFFORT=high"
)

set "JARVIS_ALLOW_WRITES=1"
set "MCP_TOOL_TIMEOUT=90000"
set "MCP_TIMEOUT=30000"

echo [JARVIS] Bridge starten...
if "%NODE_EXE%"=="node" (
  start "JARVIS bridge" /min cmd /c "node bridge/server.mjs > bridge-writes.out.log 2>&1"
) else (
  start "JARVIS bridge" /min cmd /c ""%NODE_EXE%" bridge/server.mjs > bridge-writes.out.log 2>&1"
)
timeout /t 3 /nobreak >nul

echo [JARVIS] Face (Vite) starten...
if "%NODE_EXE%"=="node" (
  start "JARVIS face" /min cmd /c "node node_modules/vite/bin/vite.js > dev.out.log 2>&1"
) else (
  start "JARVIS face" /min cmd /c ""%NODE_EXE%" node_modules/vite/bin/vite.js > dev.out.log 2>&1"
)
timeout /t 5 /nobreak >nul

rem ---- Browser oeffnen ----------------------------------------------------
set "EDGE_EXE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if defined EDGE_EXE (
  start "" "%EDGE_EXE%" "http://localhost:5173"
) else (
  start "" "http://localhost:5173"
)
echo [JARVIS] laeuft. Logs: bridge-writes.out.log / dev.out.log / brain-proxy.out.log
echo [JARVIS] Fenster schliessen zum Stoppen, oder stop-jarvis.vbs nutzen.
timeout /t 4 >nul
exit /b 0

:HELP
echo Usage: start.bat [--show ^| --help]
echo.
echo   Ohne Argument  - Hidden Start (Standard, Doppelklick)
echo   --show         - Sichtbarer Debug-Modus (minimierte Fenster)
echo   --help         - Diese Hilfe
echo.
echo Weitere Tools: authorize-google.bat, register-google-mcp.bat
exit /b 0
