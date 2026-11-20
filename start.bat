@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ==================================================
echo   Count-It-Keep-It ERP - Starting Backend + Frontend
echo ==================================================
echo.

if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not on PATH.
  echo Run setup.bat first to install Node.js and project dependencies.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] node_modules not found. Running npm install first...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo Backend API:  http://127.0.0.1:3001
echo Frontend Web: http://localhost:8080
echo.
start /b cmd /c "timeout /t 3 >nul & start http://localhost:8080"
call npm run dev
if errorlevel 1 (
  echo.
  echo [ERROR] One or more servers exited with an error.
  pause
  exit /b 1
)
