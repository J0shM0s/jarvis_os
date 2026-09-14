@echo off
rem One-time Google authorization helper.
rem Runs the server in HTTP mode so a visible browser flow can approve it.
cd /d "%~dp0"
for /f "usebackq tokens=1,* delims==" %%A in ("google-oauth.env") do set "%%A=%%B"
set "OAUTHLIB_INSECURE_TRANSPORT=1"
set "WORKSPACE_MCP_PORT=8000"
set "GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8000/oauth2callback"
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
echo [auth] server starting on http://localhost:8000 - keep this window open
echo [auth] a Google sign-in will open in Chrome. Click Allow.
uvx workspace-mcp --transport streamable-http --tools gmail calendar tasks > authorize.out.log 2>&1
