'use strict';
/* Ligação ao Firebase (projeto golaco-ac746).
   - Firestore: todos os dados (utilizadores, saldo, apostas, depósitos, saques, sessões).
   - Authentication: contas com e-mail e senha (as senhas ficam guardadas pela Google).
   O servidor usa o Admin SDK com uma conta de serviço: só ele lê/escreve na base.
   O navegador nunca fala direto com o Firebase. */

const fs = require('node:fs');
const path = require('node:path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

// configuração web do projeto (valores públicos)
const WEB_CONFIG = {
  apiKey: process.env.FIREBASE_API_KEY || 'AIzaSyBoIfqxrDX7Hjzn4Se3bBpVlM330xJIEAk',
  projectId: process.env.FIREBASE_PROJECT_ID || 'golaco-ac746',
};

const EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST;

function credentials() {
  if (EMULATOR) return { projectId: WEB_CONFIG.projectId };
  const file = path.resolve(__dirname, process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS || 'firebase-service-account.json');
  if (!fs.existsSync(file)) {
    console.error(`\n[Firebase] Falta a chave da conta de serviço: ${file}
  Só quer testar no seu computador? Use  npm run dev  (base de dados de teste, não precisa de chave).
  Para ligar à base de dados REAL (só a equipa autorizada):
  1. Abra https://console.firebase.google.com/project/${WEB_CONFIG.projectId}/settings/serviceaccounts/adminsdk
  2. Clique em "Gerar nova chave privada"
  3. Guarde o ficheiro nesta pasta com o nome firebase-service-account.json\n`);
    process.exit(1);
  }
  const sa = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (sa.project_id !== WEB_CONFIG.projectId) console.warn(`[Firebase] Atenção: a chave é do projeto "${sa.project_id}", não de "${WEB_CONFIG.projectId}".`);
  return { credential: cert(sa), projectId: sa.project_id };
}

const app = initializeApp(credentials());
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });
const auth = getAuth(app);

/* API REST do Firebase Authentication (a mesma que o SDK do navegador usa).
   Lança um erro com .authCode (ex.: INVALID_LOGIN_CREDENTIALS). */
async function identity(method, body) {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST
    ? `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com`
    : 'https://identitytoolkit.googleapis.com';
  let r;
  try {
    r = await fetch(`${host}/v1/accounts:${method}?key=${WEB_CONFIG.apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Firebase-Locale': 'pt-BR' }, // e-mails em português
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
  } catch { const err = new Error('Sem ligação ao Firebase Authentication'); err.authCode = 'NETWORK'; throw err; }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error?.message || `HTTP ${r.status}`);
    err.authCode = String(data.error?.message || '').split(' ')[0];
    throw err;
  }
  return data;
}
const continueUrl = () => (process.env.SITE_URL ? { continueUrl: process.env.SITE_URL } : {});

// confere e-mail + senha; devolve o uid
async function verifyPassword(email, password) {
  return (await identity('signInWithPassword', { email, password, returnSecureToken: false })).localId;
}
// e-mail "redefinir senha" (enviado pelo Firebase)
async function sendPasswordReset(email) {
  await identity('sendOobCode', { requestType: 'PASSWORD_RESET', email, ...continueUrl() });
}
// e-mail "confirme o seu endereço" (enviado pelo Firebase)
async function sendEmailVerification(uid) {
  const token = await auth.createCustomToken(uid);
  const { idToken } = await identity('signInWithCustomToken', { token, returnSecureToken: true });
  await identity('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken, ...continueUrl() });
}

// referências às coleções
const col = {
  users: () => db.collection('users'),
  user: (uid) => db.collection('users').doc(uid),
  txs: (uid) => db.collection('users').doc(uid).collection('transactions'),
  bets: (uid) => db.collection('users').doc(uid).collection('bets'),
  openBets: () => db.collection('openBets'),
  deposits: () => db.collection('deposits'),
  withdrawals: () => db.collection('withdrawals'),
  sessions: () => db.collection('sessions'),
  cpfs: () => db.collection('cpfs'),
  webhookEvents: () => db.collection('webhookEvents'),
  adminLogs: () => db.collection('adminLogs'),
  // catálogo gerido pela equipa no painel (modalidades, campeonatos, eventos e mercados manuais)
  catSports: () => db.collection('catalogSports'),
  catLeagues: () => db.collection('catalogLeagues'),
  manualEvents: () => db.collection('manualEvents'),
  manualMarkets: () => db.collection('manualMarkets'), // mercados extra da equipa em jogos da fonte, por id do jogo
  liveAlerts: () => db.collection('liveAlerts'), // apostas ao vivo suspeitas (livewatch.js)
};

/* Confere se as regras do Firestore bloqueiam o acesso público (sem login).
   Devolve true se estiver bloqueado, false se estiver ABERTO, null se não deu para testar. */
async function rulesAreLocked() {
  if (EMULATOR) return true;
  try {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${WEB_CONFIG.projectId}/databases/(default)/documents/users?pageSize=1&key=${WEB_CONFIG.apiKey}`, { signal: AbortSignal.timeout(10000) });
    if (r.status === 403) return true;
    if (r.status === 200) return false;
    return null;
  } catch { return null; }
}

module.exports = { db, auth, FieldValue, col, verifyPassword, sendPasswordReset, sendEmailVerification, identity, rulesAreLocked, WEB_CONFIG, EMULATOR };
