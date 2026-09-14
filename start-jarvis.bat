@echo off
rem JARVIS launcher - starts the brain (bridge) and the face (web UI)
set "PATH=C:\nvm4w\nodejs;%USERPROFILE%\.local\bin;%PATH%"
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem Brain: OpenRouter (if openrouter.env has a real key), else Claude Code login
rem ---------------------------------------------------------------------------
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
) else (
  echo Brain: Claude Code login
)

echo Starting JARVIS bridge (the brain) in WRITES mode...
start "JARVIS bridge" /min cmd /c "%~dp0bridge-openrouter.bat > bridge-writes.out.log 2>&1"
timeout /t 3 /nobreak >nul

echo Starting JARVIS web UI (the face)...
start "JARVIS face" /min cmd /c "npm run dev > dev.out.log 2>&1"
timeout /t 5 /nobreak >nul

echo.
echo Opening http://localhost:5173 in Chrome...
start "" chrome.exe "http://localhost:5173"
echo.
echo JARVIS is running. Close the two minimized windows to stop him.
timeout /t 10 >nul
