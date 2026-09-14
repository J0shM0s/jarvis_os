@echo off
rem Registers the Google Workspace MCP server (Gmail, Calendar, Tasks)
rem with Claude Code at user scope, so JARVIS can reach it.
setlocal
cd /d "%~dp0"

set "PATH=%USERPROFILE%\.local\bin;C:\nvm4w\nodejs;%USERPROFILE%\.local\bin;%PATH%"

if not exist google-oauth.env (
  echo [setup] google-oauth.env not found.
  echo [setup] 1. Copy google-oauth.env.example to google-oauth.env
  echo [setup] 2. Paste your OAuth Client ID and Secret from Google Cloud Console
  echo [setup] See SETUP-GOOGLE.md in this folder for the 5-minute walkthrough.
  pause
  exit /b 1
)

echo [setup] Registering google-workspace MCP server with Claude Code...
call claude mcp add --scope user google-workspace -- cmd /c "%~dp0run-workspace-mcp.cmd"

if errorlevel 1 (
  echo [setup] claude mcp add failed.
  pause
  exit /b 1
)

echo.
echo [setup] Registered. Restart JARVIS, then just ask him something like:
echo [setup]   "Hey Jarvis - what does my day look like?"
echo [setup] The first Google question opens a sign-in window in your browser.
echo [setup] Approve it once; tokens are cached after that.
echo.
pause
