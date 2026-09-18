@echo off
rem JARVIS launcher — jetzt komplett unsichtbar (keine Terminals)
rem Startet Bridge + Face im Hintergrund via hidden VBS
cd /d "%~dp0"
if "%1"=="--show" goto SHOW
rem Hidden Start (Standard)
wscript.exe "%~dp0start-jarvis-hidden.vbs"
echo JARVIS gestartet im Hintergrund (keine Fenster).
echo Browser oeffnet in wenigen Sekunden auf http://localhost:5173
echo Beenden mit: stop-jarvis.vbs oder Tray -> Beenden
timeout /t 3 >nul
exit /b

:SHOW
rem Alter sichtbarer Modus nur mit --show (Debug)
set "PATH=C:\nvm4w\nodejs;%USERPROFILE%\.local\bin;%PATH%"
set "ANTHROPIC_BASE_URL="
set "ANTHROPIC_AUTH_TOKEN="
set "JARVIS_MODEL="
if exist openrouter.env (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("openrouter.env") do set "%%A=%%B"
)
if defined OPENROUTER_API_KEY if not "%OPENROUTER_API_KEY:~0,5%"=="PASTE" (
  echo Brain: OpenRouter (%OPENROUTER_MODEL%)
  set "ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1"
  set "ANTHROPIC_AUTH_TOKEN=%OPENROUTER_API_KEY%"
  set "JARVIS_MODEL=%OPENROUTER_MODEL%"
) else echo Brain: Claude Code login
echo Starting JARVIS bridge (WRITES)...
start "JARVIS bridge" /min cmd /c "%~dp0bridge-openrouter.bat > bridge-writes.out.log 2>&1"
timeout /t 3 /nobreak >nul
echo Starting JARVIS face...
start "JARVIS face" /min cmd /c "npm run dev > dev.out.log 2>&1"
timeout /t 5 /nobreak >nul
set "EDGE_EXE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if defined EDGE_EXE ( start "" "%EDGE_EXE%" "http://localhost:5173" ) else start "" "http://localhost:5173"
echo JARVIS laeuft (sichtbar). Fenster schliessen zum Stoppen.
timeout /t 10 >nul
