@echo off
rem Stdio wrapper: loads google-oauth.env, then runs workspace-mcp.
rem Claude Code spawns this whenever JARVIS needs Gmail/Calendar/Tasks.
cd /d "%~dp0"
if not exist google-oauth.env exit /b 1
for /f "usebackq tokens=1,* delims==" %%A in ("google-oauth.env") do set "%%A=%%B"
set "OAUTHLIB_INSECURE_TRANSPORT=1"
rem Pin the OAuth callback. This exact URI must be listed under "Authorized
rem redirect URIs" on the OAuth client in Google Cloud Console, or Google
rem answers the sign-in with "Error 400: redirect_uri_mismatch".
set "WORKSPACE_MCP_PORT=8000"
set "GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8000/oauth2callback"
rem Neutralise any global PYTHONPATH: a leftover patch dir on this machine
rem injects sitecustomize.py that prints to stdout and corrupts MCP framing.
set "PYTHONPATH="
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
uvx workspace-mcp --single-user --tools gmail calendar tasks
