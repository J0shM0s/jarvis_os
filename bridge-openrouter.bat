@echo off
rem Starts the JARVIS brain stack: model proxy + bridge.
rem   - openrouter.env with a real key  -> OpenRouter via local brain proxy
rem   - otherwise                       -> your Claude Code login
cd /d "%~dp0"
set "PATH=C:\nvm4w\nodejs;%USERPROFILE%\.local\bin;%PATH%"

set "ANTHROPIC_BASE_URL="
set "ANTHROPIC_AUTH_TOKEN="
set "ANTHROPIC_API_KEY="
set "JARVIS_MODEL="
set "JARVIS_EFFORT="

if exist openrouter.env (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("openrouter.env") do set "%%A=%%B"
)

if defined OPENROUTER_API_KEY if not "%OPENROUTER_API_KEY:~0,5%"=="PASTE" (
  echo [brain] OpenRouter via local proxy - target: %OPENROUTER_MODEL%
  if not defined OPENROUTER_MODEL set "OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free"
  rem The CLI validates model ids against its own catalog before sending
  rem anything, so it asks for a name it knows; the proxy rewrites it.
  start "JARVIS proxy" /min cmd /c "node brain-proxy.mjs > brain-proxy.out.log 2>&1"
  timeout /t 2 /nobreak >nul
  set "ANTHROPIC_BASE_URL=http://127.0.0.1:8790"
  rem API-key mode (not AUTH_TOKEN): with a key the CLI trusts the catalog
  rem served by the base URL instead of validating against Anthropic.
  set "ANTHROPIC_AUTH_TOKEN="
  set "ANTHROPIC_API_KEY=%OPENROUTER_API_KEY%"
  set "JARVIS_MODEL=claude-sonnet-4-5"
  set "ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-sonnet-4-5"
  set "ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-5"
  set "ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-4-5"
  set "DISABLE_TELEMETRY=1"
  set "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1"
) else (
  echo [brain] Claude Code login
  set "JARVIS_EFFORT=high"
)

set "JARVIS_ALLOW_WRITES=1"
rem A stuck tool call (e.g. waiting on a Google login) fails after 90s
rem so JARVIS reports the failure instead of spinning forever.
set "MCP_TOOL_TIMEOUT=90000"
set "MCP_TIMEOUT=30000"

npm run bridge
