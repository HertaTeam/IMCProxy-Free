@echo off
setlocal
cd /d "%~dp0"
title IMCProxy-Free - Build and Run
chcp 65001 >nul

echo ==================================================
echo   IMCProxy-Free
echo   Build and Run
echo ==================================================
echo.

where node >nul 2>&1
if errorlevel 1 goto node_missing
where npm >nul 2>&1
if errorlevel 1 goto node_missing

netstat -an | findstr ":25565" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [Warning] Port 25565 already has a listener.
  echo           Another proxy instance or a Minecraft server may be running.
  echo           Close it first, otherwise this run cannot start the proxy.
  echo.
)

echo [1/3] Installing dependencies...
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto dependency_error

echo.
echo [2/3] Compiling TypeScript...
echo.
call npm run build
if errorlevel 1 goto build_error

echo.
echo [Success] Build complete!
echo.
echo [3/3] Starting reverse proxy...
echo.
echo ---------------------------------------------------------------
echo  Type commands below and press Enter, for example:
echo    /help
echo    /loginimc YOUR_ACCOUNT YOUR_PASSWORD
echo    /imcstatus
echo  Note: if you cannot see what you type, just keep typing anyway -
echo        commands are still read line by line.
echo ---------------------------------------------------------------
echo.
call npm start
echo.
echo [Info] The reverse proxy has exited.
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
