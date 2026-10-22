'use strict';
/* Arranca o TUGAS em modo de TESTE no próprio computador — não precisa de chave do Firebase.
   Uso: npm run dev   (abre http://localhost:3100)
   - Usa os emuladores do Firebase: base de dados e contas de teste, apagadas ao fechar.
   - Nunca toca no Firestore de produção, na BravoPay nem na API-Football. Nada aqui é dinheiro real.
   - Precisa de: Node.js 22.13+, Firebase CLI (npm install -g firebase-tools) e Java 11+ (para os emuladores). */

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || '3100';

const has = (cmd) => spawnSync(`${cmd} --version`, { shell: true, stdio: 'ignore' }).status === 0;
if (!has('firebase')) { console.error('\nFalta o Firebase CLI. Instale com:  npm install -g firebase-tools\n'); process.exit(1); }
if (!has('java')) { console.error('\nFalta o Java (11 ou mais recente), que os emuladores do Firebase precisam.\nInstale em https://adoptium.net e volte a correr: npm run dev\n'); process.exit(1); }

console.log(`\nTUGAS — modo de teste local (sem chaves, sem dinheiro real)\nA ligar os emuladores... depois abra http://localhost:${PORT}\n(use o botão "+ R$ 1.000 teste" para ter saldo; Ctrl+C para sair)\n`);

// "emulators:exec" liga os emuladores, define FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST,
// corre o servidor e desliga tudo no fim
const child = spawn('firebase emulators:exec --only firestore,auth --project golaco-ac746 "node server.js"', {
  cwd: ROOT, shell: true, stdio: 'inherit',
  env: { ...process.env, CASINO_TEST: '1', NO_EXTERNAL: '1', PORT, SITE_URL: `http://localhost:${PORT}` },
});
child.on('exit', (code) => process.exit(code ?? 0));
