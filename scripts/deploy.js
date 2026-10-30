'use strict';
/* Publica o TUGAS no Google Cloud Run (São Paulo).
   Uso: npm run deploy            (precisa de "gcloud auth login" feito uma vez)
   - Lê o .env local.
   - As chaves (Firebase, BravoPay, MoviOdds) vão para o Secret Manager — nunca para dentro da imagem.
   - O resto das configurações vai como variáveis de ambiente do serviço.
   - 1 instância, sempre ligada, CPU sempre ativa (placares, liquidação e PIX correm em segundo plano). */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROJECT = process.env.GCP_PROJECT || 'golaco-ac746';
const REGION = process.env.GCP_REGION || 'southamerica-east1';
const SERVICE = process.env.GCP_SERVICE || 'tugas';

const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const sh = (cmd, opts = {}) => {
  if (!opts.quiet) console.log('  $ ' + cmd.replace(/--data-file=\S+/, '--data-file=(ficheiro temporário)'));
  return execSync(cmd, { stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', shell: true });
};
const tryCap = (cmd) => { try { return sh(cmd, { capture: true, quiet: true }).trim(); } catch { return null; } };
const g = (args) => `gcloud ${args} --project=${PROJECT} --quiet`;

// segredos: nome no Secret Manager -> conteúdo
const SECRETS = { 'tugas-firebase-sa': fs.readFileSync(path.resolve(ROOT, env.FIREBASE_SERVICE_ACCOUNT || 'firebase-service-account.json'), 'utf8') };
const SECRET_ENV = { BRAVOPAY_API_KEY: 'tugas-bravopay-key', BRAVOPAY_WEBHOOK_SECRET: 'tugas-bravopay-webhook', MOVIODDS_KEY: 'tugas-moviodds-key', SMTP_PASS: 'tugas-smtp-pass' };
for (const [k, name] of Object.entries(SECRET_ENV)) if (env[k]) SECRETS[name] = env[k];

// variáveis normais (sem segredos, sem vazias)
// chaves de serviços que já não se usam (API-Football, BoltOdds): não vão para o serviço
const RETIRED = ['APIFOOTBALL_KEY', 'BOLTODDS_API_KEY'];
const SKIP = new Set([...Object.keys(SECRET_ENV), ...RETIRED, 'FIREBASE_SERVICE_ACCOUNT', 'PORT', 'GOOGLE_APPLICATION_CREDENTIALS']);
const plain = { ...Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== '' && !SKIP.has(k))), TRUST_PROXY: '1', FIREBASE_SERVICE_ACCOUNT: '/secrets/firebase/key.json' };

(async () => {
  console.log(`\nA publicar o TUGAS no Cloud Run — projeto ${PROJECT}, região ${REGION}\n`);
  const acct = tryCap('gcloud auth list --filter=status:ACTIVE --format="value(account)"');
  if (!acct) { console.error('Sem sessão no gcloud. Corra primeiro: gcloud auth login'); process.exit(1); }
  console.log('Conta Google: ' + acct);

  console.log('\n1) Ativar os serviços necessários (só demora da primeira vez)');
  sh(g('services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com'));

  const num = tryCap(`gcloud projects describe ${PROJECT} --format="value(projectNumber)"`);
  const runtimeSA = `${num}-compute@developer.gserviceaccount.com`;

  console.log('\n2) Guardar as chaves no Secret Manager');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tugas-'));
  try {
    for (const [name, value] of Object.entries(SECRETS)) {
      const f = path.join(tmp, name);
      fs.writeFileSync(f, value);
      const exists = tryCap(g(`secrets describe ${name} --format="value(name)"`));
      if (!exists) sh(g(`secrets create ${name} --replication-policy=automatic --data-file="${f}"`));
      else {
        const cur = tryCap(g(`secrets versions access latest --secret=${name}`));
        if (cur !== value.trim()) sh(g(`secrets versions add ${name} --data-file="${f}"`)); else console.log(`  ${name}: sem alterações`);
      }
      sh(g(`secrets add-iam-policy-binding ${name} --member=serviceAccount:${runtimeSA} --role=roles/secretmanager.secretAccessor`) + ' >NUL 2>&1 || exit 0', { quiet: true });
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  console.log('\n3) Construir e publicar (alguns minutos)');
  const envFile = path.join(os.tmpdir(), `tugas-env-${Date.now()}.yaml`);
  fs.writeFileSync(envFile, Object.entries(plain).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n');
  const secretFlags = [`/secrets/firebase/key.json=tugas-firebase-sa:latest`]
    .concat(Object.entries(SECRET_ENV).filter(([, n]) => SECRETS[n]).map(([k, n]) => `${k}=${n}:latest`)).join(',');
  try {
    sh(g([
      `run deploy ${SERVICE}`, '--source=.', `--region=${REGION}`, '--allow-unauthenticated',
      '--min-instances=1', '--max-instances=1', '--no-cpu-throttling', '--cpu=2', '--memory=4Gi', // 2 CPUs: o worker das odds (feeds/bigjson.js) e a limpeza de memória correm ao lado do servidor; o futebol completo (~118 MB de JSON) chega a ~800 MB no pico, e no worker existe por momentos em duas cópias
      // cada navegador com o tempo real aberto (GET /api/stream) ocupa uma ligação: 80 seria pouco para uma instância só
      '--concurrency=1000', '--timeout=3600', '--cpu-boost',
      `--env-vars-file="${envFile}"`, `--set-secrets="${secretFlags}"`,
    ].join(' ')));
  } finally { fs.rmSync(envFile, { force: true }); }

  const url = tryCap(g(`run services describe ${SERVICE} --region=${REGION} --format="value(status.url)"`));
  console.log(`\nPublicado: ${url}\nPainel da equipa: ${url}/admin\nWebhook da BravoPay: ${url}/api/webhooks/bravopay\n`);
})().catch((e) => { console.error('\nFalhou:', e.message); process.exit(1); });
