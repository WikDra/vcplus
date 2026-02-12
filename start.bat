@echo off
echo ========================================
echo   VC+ Server Launcher (Windows)
echo ========================================
echo.

cd /d "%~dp0"

:: Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed!
    echo Download from: https://nodejs.org/
    pause
    exit /b 1
)

echo [1/2] Installing dependencies...
call npm install

echo.
echo [2/2] Starting VC+ server...
echo.
node server/index.js

pause
