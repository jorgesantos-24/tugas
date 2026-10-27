'use strict';
/* Verifica a configuração antes de operar: Firebase, regras, login por e-mail, BravoPay, admins e dados da empresa.
   Uso: npm run verificar */

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* sem .env */ }

const ok = (m) => console.log('  \x1b[32m✔\x1b[0m ' + m);
const bad = (m, fix) => { console.log('  \x1b[31m✘\x1b[0m ' + m + (fix ? '\n      → ' + fix : '')); problems++; };
const warn = (m, fix) => console.log('  \x1b[33m!\x1b[0m ' + m + (fix ? '\n      → ' + fix : ''));
let problems = 0;

(async () => {
  console.log('\nVerificação do TUGAS\n');

  console.log('Ficheiros');
  fs.existsSync(path.join(ROOT, '.env')) ? ok('.env encontrado') : bad('Falta o ficheiro .env', 'copie .env.example para .env e preencha');
  const saFile = path.resolve(ROOT, process.env.FIREBASE_SERVICE_ACCOUNT || 'firebase-service-account.json');
  if (!fs.existsSync(saFile)) { bad(`Falta a chave do Firebase (${path.basename(saFile)})`, 'Console Firebase > Configurações do projeto > Contas de serviço > Gerar nova chave privada'); return finish(); }
  ok('Chave da conta de serviço do Firebase encontrada');

  console.log('\nFirebase');
  const FB = require(path.join(ROOT, 'firebase.js'));
  try { await FB.col.users().limit(1).get(); ok(`Firestore ligado (projeto ${FB.WEB_CONFIG.projectId})`); }
  catch (e) {
    if (e.code === 5) bad('O Firestore ainda não foi criado', `https://console.firebase.google.com/project/${FB.WEB_CONFIG.projectId}/firestore → Criar banco de dados`);
    else bad('Não liga ao Firestore: ' + e.message);
    return finish();
  }
  const locked = await FB.rulesAreLocked();
  if (locked === true) ok('Regras do Firestore bloqueiam o acesso público');
  else if (locked === false) bad('As regras do Firestore estão ABERTAS: qualquer pessoa pode alterar saldos', 'cole firestore.rules em Firestore > Regras e clique Publicar');
  else warn('Não consegui testar as regras do Firestore', 'confira à mão que estão iguais a firestore.rules');
  try {
    await FB.verifyPassword('verificacao-inexistente@tugas.invalid', 'x1234567');
  } catch (e) {
    if (e.authCode === 'OPERATION_NOT_ALLOWED') bad('Login por e-mail/senha está desativado', 'Authentication > Sign-in method > E-mail/senha > Ativar');
    else if (['EMAIL_NOT_FOUND', 'INVALID_LOGIN_CREDENTIALS', 'INVALID_PASSWORD'].includes(e.authCode)) ok('Login por e-mail/senha ativo');
    else if (/API key/i.test(e.message)) bad('A apiKey do Firebase foi recusada: ' + e.message, 'confira FIREBASE_API_KEY ou as restrições da chave no Google Cloud');
    else warn('Resposta inesperada do Firebase Auth: ' + e.message);
  }
  try { await FB.auth.createCustomToken('verificacao'); ok('Envio de e-mails (confirmação / nova senha) pode ser usado'); }
  catch (e) { bad('Não consigo gerar tokens para enviar e-mails: ' + e.message, 'use a chave da conta "firebase-adminsdk" do projeto'); }

  console.log('\nEquipa');
  const admins = String(process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  admins.length ? ok('Administradores: ' + admins.join(', ')) : bad('Nenhum administrador definido', 'ADMIN_EMAILS=seu@email.com no .env (o e-mail tem de ser confirmado)');

  console.log('\nBravoPay (depósitos)');
  const BP = require(path.join(ROOT, 'bravopay.js'));
  if (!BP.enabled) warn('Sem BRAVOPAY_API_KEY: o site corre em modo DEMO (depósitos fictícios)');
  else {
    try {
      const r = await fetch((process.env.BRAVOPAY_API_URL || 'https://bravopay.club/api/v1') + '/me', { headers: { Authorization: 'Bearer ' + process.env.BRAVOPAY_API_KEY }, signal: AbortSignal.timeout(10000) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) ok(`Chave da BravoPay válida (conta: ${d.name || d.email || d.id})`);
      else bad(`A BravoPay recusou a chave (HTTP ${r.status} ${d.error?.code || ''})`, 'gere uma nova em https://bravopay.club/dashboard/api-keys');
    } catch (e) { bad('Sem ligação à BravoPay: ' + e.message); }
    BP.webhookEnabled ? ok('Segredo do webhook definido') : warn('Sem BRAVOPAY_WEBHOOK_SECRET: os depósitos só são confirmados por consulta (até ~1 min)', 'crie o webhook em https://bravopay.club/dashboard/integracoes quando tiver o site num endereço público');
  }

  console.log('\nMoviOdds (jogos, odds e resultados)');
  try {
    const r = await fetch('https://moviodds.com/odds?sport=soccer&groups=40', { signal: AbortSignal.timeout(20000) });
    const d = await r.json();
    r.ok ? ok(`A responder: ${(d.matches || []).length} jogos de futebol com 1X2`) : bad('A MoviOdds respondeu HTTP ' + r.status);
  } catch (e) { bad('Sem ligação à MoviOdds: ' + e.message); }

  console.log('\nDados da empresa (aparecem no rodapé e nas páginas legais)');
  for (const [k, label] of [['COMPANY_NAME', 'Razão social'], ['COMPANY_CNPJ', 'CNPJ'], ['SPA_LICENSE', 'Nº da autorização SPA/MF'], ['SUPPORT_EMAIL', 'E-mail de suporte']]) {
    process.env[k] ? ok(`${label}: ${process.env[k]}`) : warn(`${label} por preencher (${k} no .env)`);
  }
  finish();
})().catch((e) => { console.error(e); process.exit(1); });

function finish() {
  console.log(problems ? `\n\x1b[31m${problems} problema(s) por resolver.\x1b[0m\n` : '\n\x1b[32mTudo pronto.\x1b[0m\n');
  process.exit(problems ? 1 : 0);
}
