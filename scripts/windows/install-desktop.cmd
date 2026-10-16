@echo off
rem Installs Mixtape as a Windows desktop app (Start Menu + Desktop shortcuts) and launches it.
setlocal
cd /d "%~dp0..\.."
set "LOG=%CD%\install-desktop-log.txt"
echo Mixtape desktop install %DATE% %TIME% > "%LOG%"
where node >nul 2>&1 || (echo NODE_MISSING >> "%LOG%" & echo Install Node.js LTS from https://nodejs.org first. & pause & exit /b 1)

if not defined HTTPS_PROXY (
  for %%P in (7897 7890 10809 1080) do (
    if not defined HTTPS_PROXY (
      netstat -an | find "127.0.0.1:%%P " | find "LISTENING" >nul && set "HTTPS_PROXY=http://127.0.0.1:%%P"
    )
  )
)
if defined HTTPS_PROXY set "HTTP_PROXY=%HTTPS_PROXY%"
echo PROXY=%HTTPS_PROXY% >> "%LOG%"

echo Building the Mixtape desktop app (downloads Electron, about 100 MB)...
node desktop\build-desktop.mjs >> "%LOG%" 2>&1
type "%LOG%" | find "RESULT:"

rem stop the browser-mode player so the app owns port 4321
for /f "tokens=5" %%a in ('netstat -ano ^| find "127.0.0.1:4321 " ^| find "LISTENING"') do taskkill /PID %%a /F >nul 2>&1

findstr /b "electron" desktop\install-result.txt >nul && (
  start "" "%LOCALAPPDATA%\Programs\Mixtape\Mixtape.exe"
) || (
  start "" wscript.exe "%CD%\desktop\Mixtape.vbs"
)
echo LAUNCHED >> "%LOG%"
echo.
echo Done. Mixtape is on your Desktop and in the Start menu.
timeout /t 6
