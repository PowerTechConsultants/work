@echo off
REM WorkTracker desktop trigger - starts the app on the stable port 42780
REM (API + built frontend on one origin) and opens http://localhost:42780.
REM Add --dev to the node command below for Vite live reload (API moves to 42781).
SETLOCAL
cd /d "%~dp0\.."
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH. Install Node.js 22+ and run this again.
  pause
  exit /b 1
)
node "desktop\launcher.cjs" %*
if errorlevel 1 pause
