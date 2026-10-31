@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul

echo ==================================================
echo   IMCProxy-Free
echo   Build
echo ==================================================
echo.

where node >nul 2>&1
if errorlevel 1 goto node_missing
where npm >nul 2>&1
if errorlevel 1 goto node_missing

echo [1/2] Installing dependencies...
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto dependency_error

echo.
echo [2/2] Compiling TypeScript...
echo.
call npm run build
if errorlevel 1 goto build_error

echo.
echo [Success] Build complete!
echo.
pause
exit /b 0

:node_missing
echo.
echo [Error] Node.js and npm are required.
echo Download and install the Node.js LTS release, then run this file again.
echo.
pause
exit /b 1

:dependency_error
echo.
echo [Error] Dependency installation failed.
echo Check your network connection and npm configuration.
echo.
pause
exit /b 1

:build_error
echo.
echo [Error] Build failed! Please check the errors above.
echo.
pause
exit /b 1
