@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ==================================================
echo   Count-It-Keep-It ERP - Fast Setup (/frontend + /backend)
echo ==================================================
echo.

if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"

where node >nul 2>&1
if not errorlevel 1 goto :node_ready

echo [!] Node.js was not found on this machine.
echo.
where winget >nul 2>&1
if errorlevel 1 (
  echo Please install Node.js 20 LTS from https://nodejs.org/ and re-run setup.bat.
  pause
  exit /b 1
)

set "INSTALL_NODE="
set /p INSTALL_NODE="Install Node.js LTS automatically using winget now? [Y/N]: "
if /I not "%INSTALL_NODE%"=="Y" goto :node_missing

winget install -e --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements
if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"

where node >nul 2>&1
if not errorlevel 1 goto :node_ready

:node_missing
echo.
echo [!] Node.js is still unavailable in this terminal.
echo If you just installed it, close this window and run setup.bat again.
pause
exit /b 1

:node_ready
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
for /f "delims=" %%v in ('npm -v') do set "NPM_VER=%%v"
echo [OK] Node.js %NODE_VER% / npm %NPM_VER% detected.
echo.

if not exist "backend\.env" (
  if exist "backend\.env.example" (
    copy /Y "backend\.env.example" "backend\.env" >nul
    echo [INFO] Created backend\.env from backend\.env.example.
  )
)

echo [1/3] Installing workspace dependencies (packages/shared + frontend + backend)...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)
echo.

echo [2/3] Checking monorepo TypeScript types...
call npm run typecheck
if errorlevel 1 (
  echo [ERROR] TypeScript type check reported errors.
  pause
  exit /b 1
)
echo.

echo [3/3] Verifying frontend production build...
call npm --prefix frontend run build
if errorlevel 1 (
  echo [ERROR] Frontend build failed.
  pause
  exit /b 1
)
echo.

echo [NEXT] Edit backend\.env to set your PostgreSQL DATABASE_URL, then run:
echo          npm run db:migrate
echo        Then launch both servers with start.bat
echo.
echo ==================================================
echo   Setup complete! Run start.bat to launch the ERP.
echo ==================================================
pause
