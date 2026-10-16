@echo off
rem Mixtape launcher (run from scripts\windows). Usage: start-mixtape.cmd        full setup + start + open browser
rem                          start-mixtape.cmd app    quiet: start the server hidden (used by the desktop shortcut)
setlocal
cd /d "%~dp0..\.."
set "MODE=%~1"
set "LOG=%CD%\setup-log.txt"
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
if /i not "%MODE%"=="app" echo Mixtape setup %DATE% %TIME% > "%LOG%"

where node >nul 2>&1
if errorlevel 1 (
  echo NODE_MISSING >> "%LOG%"
  echo Node.js is not installed. Get the LTS installer from https://nodejs.org then run this again.
  if /i not "%MODE%"=="app" pause
  exit /b 1
)

rem --- Use a local proxy (Clash etc.) if one is listening and none is set ---
if not defined HTTPS_PROXY (
  for %%P in (7897 7890 10809 1080) do (
    if not defined HTTPS_PROXY (
      netstat -an | find "127.0.0.1:%%P " | find "LISTENING" >nul && set "HTTPS_PROXY=http://127.0.0.1:%%P"
    )
  )
)
if defined HTTPS_PROXY (
  set "HTTP_PROXY=%HTTPS_PROXY%"
  set "NO_PROXY=localhost,127.0.0.1,::1"
  set "NODE_USE_ENV_PROXY=1"
)

if /i "%MODE%"=="app" (
  set "MIXTAPE_NO_BROWSER=1"
  node bin\mixtape.js serve >> "%CD%\server-log.txt" 2>&1
  exit /b
)

node -v >> "%LOG%" 2>&1
echo PROXY=%HTTPS_PROXY% >> "%LOG%"
where claude >> "%LOG%" 2>&1
if errorlevel 1 (
  echo CLAUDE_CLI_MISSING >> "%LOG%"
) else (
  call claude mcp remove mixtape -s user >nul 2>&1
  call claude mcp add -s user mixtape -- node "%CD%\bin\mixtape.js" mcp >> "%LOG%" 2>&1
  echo MCP_REGISTERED >> "%LOG%"
)
echo ---- doctor ---- >> "%LOG%"
node bin\mixtape.js doctor >> "%LOG%" 2>&1
rem restart a running player so it picks up new code
for /f "tokens=5" %%a in ('netstat -ano ^| find "127.0.0.1:4321 " ^| find "LISTENING"') do taskkill /PID %%a /F >nul 2>&1
echo ---- serve ---- >> "%LOG%"
start "Mixtape player" /min cmd /c node bin\mixtape.js serve ^>^> server-log.txt 2^>^&1
echo SERVER_STARTED >> "%LOG%"
