@echo off
title TUGAS - servidor
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js nao encontrado. Instale em https://nodejs.org & pause & exit /b)
if not exist node_modules\firebase-admin (echo A instalar dependencias... & call npm install --no-fund --no-audit)
start "" http://localhost:3000
node server.js
pause
