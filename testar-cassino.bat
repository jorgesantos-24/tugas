@echo off
title TUGAS - TESTE LOCAL do cassino (Decola)
cd /d "%~dp0"
REM Teste local: emuladores do Firebase (base de dados e contas de TESTE, apagadas ao fechar).
REM Nao toca no Firestore de producao nem na BravoPay. Nada aqui e dinheiro real.
where node >nul 2>nul || (echo Node.js nao encontrado. Instale em https://nodejs.org & pause & exit /b)
where firebase >nul 2>nul || (echo Firebase CLI nao encontrado. Instale com: npm install -g firebase-tools & pause & exit /b)
if not exist node_modules\firebase-admin (echo A instalar dependencias... & call npm install --no-fund --no-audit)

echo A ligar os emuladores do Firebase (janela separada)...
start "TUGAS - emuladores (feche no fim do teste)" cmd /k firebase emulators:start --only firestore,auth --project golaco-ac746

echo A esperar pelos emuladores...
:espera
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient('127.0.0.1',9099)).Close();(New-Object Net.Sockets.TcpClient('127.0.0.1',8080)).Close();exit 0}catch{exit 1}" || goto espera

set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
set FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
set CASINO_TEST=1
set PORT=3100
REM sem pagamentos reais (BravoPay) nem consultas pagas (API-Football) no teste
set NO_EXTERNAL=1
set SITE_URL=http://localhost:3100

echo.
echo  Crie uma conta de teste em http://localhost:3100 e depois abra http://localhost:3100/decola
echo  (use o botao "+ R$ 1.000 teste" para ter saldo)
echo.
start "" http://localhost:3100/decola
node server.js
pause
