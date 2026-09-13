@echo off
title NUKETOWN (web build)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Node.js is not installed, so this cannot serve the game.
    echo   Install it from https://nodejs.org ^(any v18+^) and double-click again,
    echo   or deploy the folder to Vercel instead:  npm i -g vercel ^&^& vercel --prod
    echo.
    pause
    exit /b 1
)

echo.
echo   Starting the local server. Keep this window open while you play.
echo.
node scripts\serve.mjs 8420
pause
