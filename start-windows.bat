@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18+ is required. & pause & exit /b 1)
start "" http://localhost:3000
node server.js
pause
