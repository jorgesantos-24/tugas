'use strict';
/* TUGAS — servidor da casa de apostas.
   - Contas: Firebase Authentication (e-mail e senha); sessão por cookie HttpOnly
   - Dados: Firestore (perfis, saldo, extrato, apostas, depósitos, saques, sessões)
   - Depósitos: PIX pela BravoPay. Saques: pedido do jogador, pago À MÃO pela equipa no painel /admin
   - Sem chave da BravoPay, depósitos e saques ficam indisponíveis
   - Jogos, placares, odds e resultados: MoviOdds (odds da bet365), ver feeds/moviodds.js

   Estrutura no Firestore:
     users/{uid}                       perfil, saldo (centavos), CPF, limites, pausa
     users/{uid}/transactions/{id}     extrato (depósitos, apostas, prêmios, saques...)
     users/{uid}/bets/{betId}          histórico de apostas do jogador
     openBets/{betId}                  cópia das apostas em aberto (para a liquidação automática)
     deposits/{id}                     cobranças PIX
     withdrawals/{id}                  pedidos de saque (PENDING → PROCESSING → PAID | REJECTED | CANCELED)
     cpfs/{cpf}                        garante 1 CPF por conta
     sessions/{sha256(token)}          sessões de login
     webhookEvents/{id}                webhooks da BravoPay já processados
     adminLogs/{id}                    tudo o que a equipa faz no painel
     pgsoftTxns/{txn_id}               rodadas dos slots já processadas (idempotência) */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
// o navegador aceita gzip? (a lista de jogos e as odds comprimem ~10x)
const acceptsGzip = (req) => /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
// carrega o ficheiro .env (chaves da BravoPay, Firebase, dados da empresa), se existir
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* sem .env */ }
const M = require('./public/markets.js');
const BP = require('./bravopay.js');
const FB = require('./firebase.js');
const FEED = require('./feeds/moviodds.js'); // jogos, odds e resultados
const BB = require('./feeds/betbuilder.js'); // Criar aposta (várias seleções do mesmo jogo numa odd)
const LOGOS = require('./feeds/logos.js');   // emblemas das equipas
const ESPN = require('./feeds/espn.js');     // futebol: resultado do prolongamento e dos penáltis
const { db, auth, FieldValue, col, verifyPassword, sendPasswordReset, sendEmailVerification, WEB_CONFIG, EMULATOR } = FB;

const PORT = Number(process.env.PORT) || 3000;
const PUB = path.join(__dirname, 'public');
const FAST_MS = 5000, SLOW_MS = 60000; // ao vivo: 5 s (só os jogos a decorrer); completo: 1 min
// tempo de aprovação: ao vivo 25s (configurável) para dar tempo de o feed apanhar o que acontece no campo
/* Espera antes de aceitar uma aposta / cash out ao vivo, por modalidade (segundos). Cobre o tempo entre o lance
   acontecer e a bet365 suspender o mercado (+ ~1-2 s até chegar cá). Ajustável no .env: LIVE_DELAY_SOCCER=8 ...
   Com várias modalidades no mesmo boletim vale a maior. Mínimo 3 s. */
const FRESH_SPORTS = new Set(['tabletennis', 'basketball']); // ver a aprovação ao vivo: odds lidas depois do pedido
const LIVE_DELAY_DEFAULT = { soccer: 8, hockey: 8, tennis: 6, basketball: 5, esports: 5, tabletennis: 6 };
const LIVE_DELAYS = Object.fromEntries(Object.entries(LIVE_DELAY_DEFAULT).map(([k, v]) => {
  const n = Number(process.env[`LIVE_DELAY_${k.toUpperCase()}`]);
  return [k, Math.max(3, Number.isFinite(n) && n > 0 ? n : v)];
}));
const liveDelayMs = (sports) => Math.max(...[...sports].map((s) => LIVE_DELAYS[s] ?? Math.max(...Object.values(LIVE_DELAYS))), 3) * 1000;
if (process.env.LIVE_BET_DELAY || process.env.LIVE_CASHOUT_DELAY) console.warn('[Ao vivo] LIVE_BET_DELAY / LIVE_CASHOUT_DELAY já não são usados: a espera agora é por modalidade (LIVE_DELAY_SOCCER, LIVE_DELAY_TENNIS...).');
const PRE_DELAY_MS = 800, CASHOUT_DELAY_MS = 2000;
const SESSION_DAYS = 30;
// nome do cookie de sessão: o Firebase Hosting (domínio próprio à frente do Cloud Run) só deixa passar "__session"
const COOKIE = '__session';
const MAX_WIN = 50000000; // R$ 500.000 em centavos
// mercados liquidados pela equipa (escanteios, cartões, jogadores...): aposta e prêmio máximos mais baixos
const MANUAL_MAX_STAKE = Math.round(Number(process.env.MANUAL_MAX_STAKE || 100) * 100);
const MANUAL_MAX_WIN = Math.round(Number(process.env.MANUAL_MAX_WIN || 5000) * 100);
// futebol fora das 24 ligas principais (ligas "fut.*"): limites mais baixos (mais risco de jogos combinados e menos verificação)
const MINOR_MAX_STAKE = Math.round(Number(process.env.MINOR_MAX_STAKE || 200) * 100);
const MINOR_MAX_WIN = Math.round(Number(process.env.MINOR_MAX_WIN || 5000) * 100);
const DAY = 24 * 3600000;
const BR_OFFSET = 3 * 3600000; // horário de Brasília (UTC-3)
const ADMIN_EMAILS = new Set(String(process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const SITE = {
  name: process.env.SITE_NAME || 'TUGAS',
  company: process.env.COMPANY_NAME || '',
  cnpj: process.env.COMPANY_CNPJ || '',
  license: process.env.SPA_LICENSE || '',
  supportEmail: process.env.SUPPORT_EMAIL || 'suporte@tugasbet.com',
  supportPhone: process.env.SUPPORT_PHONE || '',
  withdrawEta: process.env.WITHDRAW_ETA || 'até 24 horas',
  // tempo real direto ao Cloud Run: o Firebase Hosting (tugasbet.com) retém respostas em fluxo e o tempo real não passava
  streamUrl: EMULATOR ? '' : String(process.env.STREAM_URL || '').replace(/\/+$/, ''), // teste local: nunca o fluxo de produção
};
// sites que podem abrir o tempo real a partir de outro endereço (CORS em /api/stream)
const STREAM_ORIGINS = new Set([process.env.SITE_URL, process.env.CANONICAL_HOST && `https://${process.env.CANONICAL_HOST}`, process.env.CANONICAL_HOST && `https://www.${process.env.CANONICAL_HOST}`]
  .filter(Boolean).map((u) => { try { return new URL(u).origin; } catch { return null; } }).filter(Boolean));

/* ---------------- utilidades ---------------- */
const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toCents = (v) => Math.round(Number(v) * 100);
const fromCents = (c) => (c == null ? null : c / 100);
const betId = () => crypto.randomBytes(4).toString('hex').toUpperCase() + now().toString(36).slice(-4).toUpperCase();
const payId = (p) => p + crypto.randomBytes(6).toString('hex').toUpperCase();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isoMs = (s) => (s ? Date.parse(s) || null : null);
const brl = (c) => 'R$ ' + (c / 100).toFixed(2).replace('.', ',');
const inc = (n) => FieldValue.increment(n);
const dayKey = (t = now()) => 'd' + new Date(t - BR_OFFSET).toISOString().slice(0, 10).replace(/-/g, ''); // ex.: d20261021
const dayStart = (t = now()) => Math.floor((t - BR_OFFSET) / DAY) * DAY + BR_OFFSET;
const fmtDate = (t) => new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
// usa "status" (e não "code"): o Firestore lê err.code dentro das transações e repetiria a transação
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

function ageFrom(birth) {
  const b = new Date(birth + 'T00:00:00');
  if (isNaN(b)) return -1;
  const t = new Date();
  let a = t.getFullYear() - b.getFullYear();
  if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) a--;
  return a;
}
function validCpf(v) {
  const c = String(v || '').replace(/\D/g, '');
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return null;
  for (const n of [9, 10]) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(c[n])) return null;
  }
  return c;
}
const validPassword = (pw) => pw.length >= 8 && /[a-zA-Z]/.test(pw) && /\d/.test(pw);
const validEmail = (em) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em) && em.length <= 120;

/* ---------------- jogo responsável ----------------
   Limites: baixar (ou criar) vale na hora; subir ou remover só vale 24h depois.
   Perdas: o perfil guarda por dia (horário de Brasília) o total apostado e o total devolvido. */
const LIMIT_KEYS = ['depositLimit', 'lossLimitDay', 'lossLimitMonth'];
function effLimit(u, key) {
  const p = u.pendingLimits && u.pendingLimits[key];
  if (p && p.at <= now()) return p.value ?? null;
  return u[key] ?? null;
}
function lossStats(u) {
  const k = dayKey(), m = k.slice(0, 7);
  let day = 0, month = 0;
  for (const [key, v] of Object.entries(u.daily || {})) {
    const l = (v.staked || 0) - (v.returned || 0);
    if (key === k) day = l;
    if (key.startsWith(m)) month += l;
  }
  return { day, month };
}
const isExcluded = (u) => u.excludedUntil && u.excludedUntil > now();
const pausedMsg = (u) => `A sua conta está em pausa até ${fmtDate(u.excludedUntil)}. Pode sacar o saldo, mas não pode depositar nem apostar.`;

function publicUser(u, extra = {}) {
  const lim = (key) => {
    const p = u.pendingLimits && u.pendingLimits[key];
    return { value: fromCents(effLimit(u, key)), pending: p && p.at > now() ? { value: fromCents(p.value), at: p.at } : null };
  };
  const loss = lossStats(u);
  return {
    id: u.id, name: u.name, email: u.email, birthdate: u.birthdate, balance: fromCents(u.balance),
    depositLimit: fromCents(effLimit(u, 'depositLimit')), acceptAny: u.acceptAny !== false, createdAt: u.createdAt, lastLogin: u.lastLogin,
    cpf: u.cpf ? `***.${u.cpf.slice(3, 6)}.${u.cpf.slice(6, 9)}-**` : null,
    emailVerified: !!u.emailVerified, isAdmin: ADMIN_EMAILS.has(u.email),
    limits: { depositLimit: lim('depositLimit'), lossLimitDay: lim('lossLimitDay'), lossLimitMonth: lim('lossLimitMonth') },
    lossToday: fromCents(loss.day), lossMonth: fromCents(loss.month),
    excludedUntil: isExcluded(u) ? u.excludedUntil : null, realityCheck: u.realityCheck || 0,
    ...extra,
  };
}
function publicBet(b) {
  return {
    id: b.id, type: b.type, stake: fromCents(b.stake), odds: b.odds, potential: fromCents(b.potential), status: b.status,
    payout: fromCents(b.payout), placedAt: b.placedAt, settledAt: b.settledAt,
    ...(b.bb ? { bb: Object.fromEntries(Object.entries(b.bb).map(([k, g]) => [k, { odds: g.odds }])) } : {}), // Criar aposta: odd de cada grupo
    // emblemas das equipas de cada seleção: o site mostra-os mesmo depois de o jogo sair da lista
    legs: (b.legs || []).map((l) => {
      const [h, a] = String(l.event || '').split(' x ');
      return { ...l, logos: [LOGOS.logo(l.sport || 'soccer', h, 2e14, l.league) || '', LOGOS.logo(l.sport || 'soccer', a, 2e14, l.league) || ''] };
    }),
  };
}

// limite simples de tentativas (por IP ou por utilizador)
const attempts = new Map();
function rateLimit(who, key, max = 10, windowMs = 10 * 60000) {
  const k = key + who; const t = now();
  const list = (attempts.get(k) || []).filter((x) => t - x < windowMs);
  if (list.length >= max) fail(429, 'Muitas tentativas. Tente de novo em alguns minutos.');
  list.push(t); attempts.set(k, list);
}

/* ---------------- Firestore: caches e ajudas ----------------
   Só este servidor escreve na base, por isso pode guardar leituras em memória
   e apagá-las sempre que escreve (poupa leituras do Firestore). */
const userCache = new Map();  // uid -> { u, at }
const betsCache = new Map();  // uid -> { list, at }
const sessCache = new Map();  // sha256(token) -> { uid, expires, createdAt }
const authState = new Map();  // uid -> estado no Firebase Authentication
const dirty = (...uids) => uids.forEach((uid) => { userCache.delete(uid); betsCache.delete(uid); });

async function getUser(uid, fresh) {
  const c = userCache.get(uid);
  if (!fresh && c && now() - c.at < 30000) return c.u;
  const s = await col.user(uid).get();
  if (!s.exists) { userCache.delete(uid); return null; }
  const u = { id: s.id, ...s.data() };
  userCache.set(uid, { u, at: now() });
  return u;
}

// estado da conta no Firebase Authentication (desativada? e-mail confirmado? senha trocada?), guardado 2 min
async function authInfo(uid, fresh) {
  const c = authState.get(uid);
  if (!fresh && c && now() - c.at < 120000) return c;
  let info;
  try {
    const r = await auth.getUser(uid);
    info = { at: now(), disabled: r.disabled, emailVerified: r.emailVerified, validAfter: r.tokensValidAfterTime ? Date.parse(r.tokensValidAfterTime) : 0, lastSignIn: r.metadata.lastSignInTime || null };
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    info = { at: now(), missing: true };
  }
  authState.set(uid, info);
  if (info.emailVerified) {
    const u = await getUser(uid);
    if (u && !u.emailVerified) { await col.user(uid).update({ emailVerified: true }); dirty(uid); }
  }
  return info;
}

// transação do Firestore: tudo ou nada; repete sozinha se houver conflito
async function runTx(uids, fn) {
  try { return await db.runTransaction(fn); } finally { dirty(...uids); }
}
// lançamento no extrato (dentro de uma transação ou batch)
function addTx(w, uid, type, amount, ref, extra = {}) {
  const id = extra.id; delete extra.id;
  w.set(id ? col.txs(uid).doc(id) : col.txs(uid).doc(), { type, amount, ref: ref ?? null, at: now(), ...extra });
}

// mantém em memória o resultado de uma consulta do Firestore, em tempo real
function watch(query, map, label, onReady, onChange) {
  let ready = false;
  query.onSnapshot((snap) => {
    for (const ch of snap.docChanges()) {
      if (ch.type === 'removed') map.delete(ch.doc.id); else map.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
    }
    if (onChange) onChange();
    if (!ready) { ready = true; onReady && onReady(); }
  }, (err) => {
    console.error(`[Firebase] Ligação em tempo real (${label}) caiu: ${err.message}. A religar em 5s...`);
    setTimeout(() => watch(query, map, label, ready ? null : onReady, onChange), 5000);
  });
}
const watchReady = (query, map, label, onChange) => new Promise((ok) => watch(query, map, label, ok, onChange));

const openBets = new Map();        // apostas em aberto (todas as contas)
const pendingDeposits = new Map(); // PIX à espera de pagamento
const openWithdrawals = new Map(); // pedidos de saque à espera da equipa

/* ---------------- jogos e odds (feeds/moviodds.js) ---------------- */
const events = new Map();
const LW = require('./livewatch.js')({ col, inc, M, events, findSel, now }); // vigilância das apostas ao vivo
// liquidação antecipada: seleções já decididas pagas 2,5 min depois (sem esperar pelo fim do jogo)
// ténis ponto a ponto: placares de cada game gravados ao vivo → mercados de pontos (1º ponto, placar após N pontos...)
const POINTS = require('./feeds/points.js');
const EARLY = require('./early.js')({ M, TEN: require('./feeds/tennis.js'), events, liveStats: FEED.liveStats, now, POINTS, raceLog: (id) => raceLogs.get(id) || null, espnBox: (id) => { const x = espnLive.get(id); return x && now() - x.at < 90000 ? x.box : null; } });
let feedVersion = 0, feedCache = null, lastFeedOk = 0, lastBump = 0;
// resultado final: vale logo à primeira leitura (RESULT_CONFIRM_S > 0 obriga a lê-lo igual outra vez depois desse tempo)
const RESULT_CONFIRM_MS = Number(process.env.RESULT_CONFIRM_S || 0) * 1000;

// jogos com apostas em aberto (não podem sair da memória)
/* Apostas já fechadas (perdida, cash out) com seleções ainda por decidir: continuam a ser marcadas (ganha/perdida/
   devolvida) com as mesmas regras, só para o cliente ver o resultado de cada uma — o pagamento e o saldo não mudam.
   Saem da lista quando todas estão marcadas ou ao fim de 3 dias. */
const trail = new Map(); // id da aposta → { id, userId, legs, at }
const TRAIL_DAYS = 3;
const pendingRows = () => [...openBets.values(), ...trail.values()];
const openEvIds = () => new Set(pendingRows().flatMap((b) => b.legs.filter((l) => !l.result).map((l) => l.evId)));

// fetchedAt = quando o pedido começou. Uma resposta mais antiga (ex.: a atualização completa,
// que demora alguns segundos) nunca substitui um placar mais recente já recebido.
// fromWs = atualização pelo WebSocket: entra sempre (é a mais recente) e não mexe na ordem dos pedidos normais
function mergeEvents(list, fetchedAt, fromWs = false) {
  const t = now();
  let changed = false;
  const same = (a, b) => { const { fetchedAt: x, ...ra } = a; const { fetchedAt: y, ...rb } = b; return JSON.stringify(ra) === JSON.stringify(rb); };
  for (const ev of list) {
    const old = events.get(ev.id);
    if (old && (old.state === 'post' || (!fromWs && old.fetchedAt > fetchedAt))) continue;
    ev.fetchedAt = fromWs && old ? old.fetchedAt : fetchedAt;
    // emblemas: futebol primeiro; dentro de cada modalidade, ao vivo e jogos mais próximos
    const pr = (ev.sport === 'soccer' ? 0 : 1e13) + (ev.state === 'in' ? 0 : +ev.date);
    ev.home.logo = LOGOS.logo(ev.sport, ev.home.name, pr, ev.league); ev.away.logo = LOGOS.logo(ev.sport, ev.away.name, pr, ev.league);
    if (old) {
      // gol (futebol, hóquei): mercados suspensos 20 s. No basquete e no ténis o placar muda a toda a hora.
      const scored = M.GOAL_SPORTS.has(ev.sport) && old.state === 'in' && ev.state === 'in' && (ev.home.score !== old.home.score || ev.away.score !== old.away.score);
      if (scored) {
        ev.suspendedUntil = t + 20000; ev.goalAt = t;
        if (ev.home.score > old.home.score || ev.away.score > old.away.score) LW.goal(ev.id, ev.home.score > old.home.score ? 'home' : 'away', t);
      }
      else { ev.suspendedUntil = old.suspendedUntil; ev.goalAt = old.goalAt; }
      // relógio ao segundo: diferenças de 1-2 s entre leituras são ruído (não reenvia o jogo por isso)
      if (ev.clockT0 && old.clockT0 && Math.abs(ev.clockT0 - old.clockT0) <= 2000) ev.clockT0 = old.clockT0;
    }
    ev.cm = extraMarketsOf(ev.id); // mercados extra da equipa neste jogo (painel → Esportes e mercados)
    if (shootouts.has(ev.id)) ev.shootout = shootouts.get(ev.id).data; // pênaltis cobrança a cobrança (ESPN)
    if (!old || !same(old, ev)) { changed = true; touch(ev.id); }
    events.set(ev.id, ev);
  }
  return changed;
}

/* ---------------- tempo real para o navegador (Server-Sent Events: GET /api/stream) ----------------
   Cada jogo que muda é enviado logo aos navegadores ligados (no máximo a cada 150 ms), sem esperarem pela
   atualização seguinte. A lista completa (/api/events) continua a ser pedida de tempos a tempos, como reserva.
   - Para a lista vai só a versão leve do jogo, e só quando ela mudou de facto (a maioria das odds que mexem
     são de mercados que não aparecem na lista).
   - Cada navegador diz que jogos tem abertos (página do jogo, boletim, apostas): desses recebe os mercados
     completos no próprio fluxo (POST /api/stream/watch), sem pedidos extra.
   - A cada 10 s vai um "ping" com a hora: o navegador sabe que o fluxo está vivo (se um proxy o segurar, volta
     a pedir a lista de 5 em 5 s). */
const streams = new Map(); // id do fluxo → { res, out, watch: Set }
const touched = new Set();
const sentLight = new Map(); // jogo → { j: última versão leve enviada (texto), at, urgent }
const LIGHT_MIN_MS = 1000;   // na lista, cada jogo muda no máximo 1x/s (odds a mexer); gol, suspensão e início/fim vão na hora
let pushT = null, sentLeagues = '';
function touch(id) {
  touched.add(id);
  if (!pushT && streams.size) pushT = setTimeout(pushNow, 150);
}
// cada mensagem sai comprimida (gzip) e é empurrada logo (flush), sem esperar por mais dados
const sse = (st, data, ev) => {
  try { st.out.write(`${ev ? `event: ${ev}\n` : ''}data: ${data}\n\n`); if (st.out.flush) st.out.flush(); return true; } catch { return false; }
};
const urgentKey = (ev) => `${ev.state}|${ev.home.score}-${ev.away.score}|${ev.suspendedUntil || 0}|${ev.awaiting ? 1 : 0}|${ev.markets ? 1 : 0}`;
function pushNow() {
  pushT = null;
  if (!streams.size) { touched.clear(); sentLight.clear(); return; }
  const ids = [...touched]; touched.clear();
  feedVersion++; feedCache = null;
  const t = now();
  const light = [], fullJson = new Map();
  let later = false;
  for (const id of ids) {
    const ev = events.get(id);
    if (!ev) { sentLight.delete(id); light.push(`{"id":${JSON.stringify(id)},"removed":true}`); continue; }
    const j = JSON.stringify(lightEvent(ev));
    const last = sentLight.get(id);
    if (last && last.j === j) continue;
    const uk = urgentKey(ev);
    if (last && last.urgent === uk && t - last.at < LIGHT_MIN_MS) { touched.add(id); later = true; continue; } // vai no próximo envio
    sentLight.set(id, { j, at: t, urgent: uk });
    light.push(j);
  }
  if (later && !pushT) pushT = setTimeout(pushNow, 250);
  const lg = JSON.stringify(M.dynLeagues());
  const leagues = lg !== sentLeagues ? lg : null;
  sentLeagues = lg;
  const head = `{"now":${now()}${leagues ? `,"leagues":${leagues}` : ''},"events":[${light.join(',')}]`;
  for (const [sid, st] of streams) {
    // mercados completos dos jogos que este navegador tem abertos
    const full = [];
    for (const id of ids) {
      if (!st.watch.has(id)) continue;
      if (!fullJson.has(id)) { const ev = events.get(id); fullJson.set(id, ev ? JSON.stringify(fullEvent(ev)) : null); }
      if (fullJson.get(id)) full.push(fullJson.get(id));
    }
    if (!light.length && !full.length && !leagues) continue;
    if (!sse(st, `${head}${full.length ? `,"full":[${full.join(',')}]` : ''}}`)) streams.delete(sid);
  }
}
setInterval(() => {
  for (const [sid, st] of streams) if (!sse(st, `{"now":${now()}}`, 'ping')) streams.delete(sid);
  for (const id of sentLight.keys()) if (!events.has(id)) sentLight.delete(id);
}, 10000);
function handleStream(req, res) {
  if (streams.size >= MAX_STREAMS) { res.writeHead(503, { 'Retry-After': '15' }); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', Vary: 'Accept-Encoding', ...(acceptsGzip(req) ? { 'Content-Encoding': 'gzip' } : {}) });
  const sid = crypto.randomBytes(12).toString('base64url');
  const watch = new Set(String(new URL(req.url, 'http://x').searchParams.get('watch') || '').split(',').filter(Boolean).slice(0, 40));
  // gzip com flush a cada mensagem: ~10x menos dados (importante no telemóvel)
  let out = res;
  // janela pequena (≈64 KB de memória por navegador em vez de ≈256 KB): com 800 ligações cabe nos 512 MB
  if (acceptsGzip(req)) { out = zlib.createGzip({ level: 5, windowBits: 13, memLevel: 6 }); out.pipe(res); }
  const st = { res, out, watch };
  streams.set(sid, st);
  out.write('retry: 3000\n');
  sse(st, JSON.stringify({ sid, now: now(), leagues: M.dynLeagues() }), 'hello');
  req.on('close', () => { streams.delete(sid); if (out !== res) out.destroy(); });
}
const MAX_STREAMS = Number(process.env.MAX_STREAMS || 800); // abaixo da concorrência do Cloud Run (1000): sobra para os pedidos normais

/* WebSocket da MoviOdds: os jogos que mudam são reconstruídos e entram logo (gol → suspensão na hora).
   removed = jogos que a fonte tirou da oferta: ao vivo ficam logo bloqueados e a lista ao vivo é relida. */
let wsRefreshT = null;
function quickLiveRefresh(ms) { if (!wsRefreshT) wsRefreshT = setTimeout(() => { wsRefreshT = null; refresh(false); }, ms); }
function onWsChange(ids, removed = []) {
  const list = ids.map((id) => FEED.fromWs(id)).filter(Boolean);
  if (list.length && mergeEvents(list, now(), true)) { feedVersion++; feedCache = null; }
  let locked = false;
  for (const id of removed) {
    const ev = events.get(id);
    if (!ev || ev.state !== 'in' || !ev.markets) continue;
    ev.markets = ev.markets.map((mk) => ({ ...mk, sels: mk.sels.map((x) => ({ ...x, lock: true })) }));
    touch(id); locked = true;
  }
  if (locked) { feedVersion++; feedCache = null; quickLiveRefresh(1000); }
}
// ligação à MoviOdds caiu: as odds ao vivo voltam já aos pedidos normais (sem esperar pelo ciclo seguinte)
const onWsDown = () => quickLiveRefresh(200);
// jogos a seguir pelo WebSocket: ao vivo e os que começam nos próximos 15 min (ou começaram há pouco)
function wsWanted() {
  const t = now(), ids = [];
  for (const ev of events.values()) {
    if (ev.state === 'post' || ev.awaiting || ev.manual) continue;
    if (ev.state === 'in' || (+ev.date - t < 15 * 60000 && t - +ev.date < 6 * 3600000)) ids.push(ev.id);
  }
  return ids;
}

/* Jogos que deixaram de vir na lista da fonte:
   - ainda longe do início: saíram da oferta (some do site; se houver apostas, fica sem mercados);
   - já começaram: o jogo acabou (ou foi retirado) → fica à espera do resultado.
   A lista ao vivo só traz jogos a decorrer, por isso só serve para os jogos que estavam ao vivo.
   okSports = modalidades que responderam (uma que falhou não conta como "o jogo saiu"). */
function markMissing(seen, full, t, okSports) {
  let changed = false;
  const keep = openEvIds();
  for (const [id, ev] of events) {
    if (ev.manual || seen.has(id) || ev.state === 'post' || ev.awaiting || !okSports.has(ev.sport)) continue; // eventos da equipa não vêm da fonte
    if (!full && ev.state !== 'in') continue;
    if (ev.state === 'pre' && +ev.date > t + 10 * 60000) {
      if (!keep.has(id)) events.delete(id); else ev.markets = null;
    } else {
      Object.assign(ev, { awaiting: true, markets: null, clock: 'Aguardando resultado' });
    }
    changed = true;
    touch(id);
  }
  return changed;
}

// evento mínimo a partir de uma aposta (ex.: o servidor reiniciou depois de o jogo sair da lista)
function stubFromLeg(l) {
  // torneio de ténis que já saiu da lista (ex.: o servidor reiniciou): volta a existir para a aposta aparecer e ser paga
  if (!M.LEAGUE_BY_KEY[l.league]) M.addLeague({ key: l.league, name: l.leagueName, country: '', sport: l.sport || 'tennis', order: 999 });
  const [h, a] = String(l.event).split(' x ');
  // emblemas da cache (o jogo já saiu da lista, mas a aposta continua a mostrá-los)
  const team = (name, id) => ({ id, name, short: name, logo: LOGOS.logo(l.sport || 'soccer', name, 2e14, l.league) || '', score: null, form: '' });
  return {
    id: l.evId, league: l.league, leagueName: l.leagueName, country: M.LEAGUE_BY_KEY[l.league]?.country || '', sport: l.sport || 'soccer',
    date: new Date(l.startsAt), state: 'in', completed: false, statusName: '', clock: 'Aguardando resultado',
    home: team(h, 'h'), away: team(a, 'a'), details: [], venue: '', markets: null, awaiting: true, fetchedAt: 0,
  };
}

// procura o resultado dos jogos terminados (até 40 por minuto; cada jogo no máximo 1x/min; depois de 6h, 1x a cada 10 min)
const resultTried = new Map();
async function checkResults() {
  const t = now();
  let changed = false;
  const want = new Map();
  for (const ev of events.values()) if (ev.awaiting && ev.state !== 'post') want.set(ev.id, null);
  for (const b of pendingRows()) for (const l of b.legs) {
    if (!l.result && l.feed === 'moviodds' && !events.has(l.evId) && t - l.startsAt > 100 * 60000 && (M.LEAGUE_BY_KEY[l.league] || /^(ten|fut|mma|tt)\./.test(l.league || ''))) want.set(l.evId, l);
  }
  // primeiro os jogos com apostas em aberto, depois os que foram perguntados há mais tempo
  // (senão os primeiros 20 da lista, que às vezes nunca recebem resultado, ocupavam sempre a vez)
  const withBets = openEvIds();
  const order = [...want].sort(([a], [b]) => (withBets.has(b) - withBets.has(a)) || ((resultTried.get(a) || 0) - (resultTried.get(b) || 0)));
  let asked = 0;
  for (const [id, leg] of order) {
    const ev0 = events.get(id);
    const startsAt = ev0 ? +ev0.date : leg.startsAt;
    if (t - (resultTried.get(id) || 0) < (t - startsAt > 6 * 3600000 ? 600000 : 60000)) continue;
    if (++asked > 40) break;
    resultTried.set(id, t);
    let r;
    // MMA: a luta (nomes e data) serve para a procurar na ESPN
    try { r = await FEED.fetchResult(id, ev0 ? ev0.sport : leg.sport || 'soccer', ev0 || (['mma', 'tabletennis', 'basketball', 'hockey'].includes(leg.sport) ? stubFromLeg(leg) : null)); } catch (e) { console.error(`[Resultados] ${id}: ${e.message}`); continue; }
    if (!r) continue;
    const ev = ev0 || stubFromLeg(leg);
    if (!ev0) { events.set(id, ev); changed = true; }
    if (!r.done) { // parou antes do fim (ou placar ilegível): a equipa decide no painel
      if (ev.clock !== 'Resultado por confirmar') { ev.clock = 'Resultado por confirmar'; ev.resultNote = r.note; changed = true; }
      continue;
    }
    const { done, finishedAt, note, ...R } = r;
    const sig = JSON.stringify(R);
    const p = ev.pendingResult;
    if (RESULT_CONFIRM_MS > 0) {
      if (!p || p.sig !== sig) { ev.pendingResult = { sig, at: t }; continue; }
      if (t - p.at < RESULT_CONFIRM_MS) continue;
    }
    if (R.log) R.pts = POINTS.resolve(id, R.log); // ténis: sequência dos pontos de cada game (mercados de pontos)
    if (ev.sport === 'basketball' && raceLogs.has(id)) R.blog = raceLogs.get(id); // corrida a X pontos: leituras ao vivo
    Object.assign(ev, {
      state: 'post', completed: true, awaiting: false, markets: null, clock: 'Encerrado' + (R.alts ? ' (pênaltis)' : ''), pendingResult: null,
      result: R, resultNote: note || (R.alts ? 'decidido nos pênaltis: a fonte não diz quem ganhou; mercados do vencedor ficam para a equipa' : null),
      home: { ...ev.home, score: R.h }, away: { ...ev.away, score: R.a },
    });
    changed = true;
    touch(id);
    console.log(`[Resultados] ${M.evLabel(ev)}: ${M.resultText(R)}${note ? ` (${note})` : ''}`);
  }
  return changed;
}

/* Futebol: prolongamento e penáltis (a MoviOdds só regista os 90 minutos). Para jogos terminados com apostas em
   mercados de prolongamento/penáltis — ou de jogadores numa eliminatória empatada aos 90' — vai-se buscar o
   resultado à ESPN (a cada 2 min, durante 6 h). Sem resultado, essas apostas ficam para a equipa no painel. */
const etTried = new Map();
/* Disputa de pênaltis ao vivo, cobrança a cobrança.
   Fonte principal: a cronologia da MoviOdds ("Liverpool - Score 1st Penalty", "Chelsea - Miss 3rd Penalty"), ao vivo e
   em todas as ligas (28/10: à frente da ESPN). A ESPN (ligas que cobre) junta o nome de quem bateu, se as cobranças
   baterem certo. Fica no jogo (ev.shootout) para a página e o boletim. */
const shootouts = new Map(); // jogo → { data, at, espnAt, done }
const PK_LINE = /^(.+?) - (Score|Miss) (\d+)(?:st|nd|rd|th) Penalty$/i;
function shootoutFromTimeline(ev, tl) {
  if (!tl.some((x) => /^Penalty Shoot ?out$/i.test(String(x.text || '').trim()))) return null;
  const out = { home: [], away: [] };
  for (const x of tl) {
    const m = PK_LINE.exec(String(x.text || '').trim());
    if (!m) continue;
    const side = m[1] === ev.home.name ? 'home' : m[1] === ev.away.name ? 'away' : null;
    if (!side) continue;
    out[side][Number(m[3]) - 1] = { p: '', n: '', ok: /score/i.test(m[2]) };
  }
  for (const k of ['home', 'away']) out[k] = out[k].filter(Boolean);
  out.score = [out.home.filter((x) => x.ok).length, out.away.filter((x) => x.ok).length];
  out.done = ev.state === 'post';
  return out;
}
async function checkShootouts() {
  const t = now();
  for (const ev of events.values()) {
    if (ev.sport !== 'soccer' || ev.manual) continue;
    const cur = shootouts.get(ev.id);
    if (cur?.done) continue;
    if (ev.state === 'post' && t - (ev.result?.finishedAt || +ev.date + 2 * 3600000) > 3 * 3600000) continue;
    const tl = FEED.liveStats(ev.id)?.timeline || [];
    let data = shootoutFromTimeline(ev, tl);
    // ESPN: nomes de quem bateu (a cada 15 s, só nas ligas que cobre); sem cronologia da MoviOdds, a ESPN é a fonte
    let espn = cur?.espn || null;
    if ((data || cur?.data) && (!cur || t - (cur.espnAt || 0) >= 15000)) {
      try { espn = await ESPN.shootout(ev); } catch { /* fica o que havia */ }
    }
    if (!data && espn && (espn.home.length || espn.away.length)) data = espn;
    else if (data && espn) {
      for (const k of ['home', 'away']) data[k].forEach((x, i) => { const e = espn[k][i]; if (e && e.ok === x.ok) { x.p = e.p; x.n = e.n; } });
      if (espn.done) data.done = true;
    }
    if (!data && !cur) continue;
    shootouts.set(ev.id, { data: data || cur?.data || null, espn, at: t, espnAt: espn !== cur?.espn ? t : cur?.espnAt || 0, done: !!data?.done });
    if (data && JSON.stringify(ev.shootout) !== JSON.stringify(data)) { ev.shootout = data; touch(ev.id); feedVersion++; feedCache = null; }
  }
  for (const [id, x] of shootouts) if (!events.has(id) || t - x.at > 6 * 3600000) shootouts.delete(id);
}
setInterval(() => { checkShootouts().catch((e) => console.error('[Pênaltis]', e.message)); }, 5000);

/* Basquete ao vivo: pontos de cada quarto, pela ordem em que mudam (cada mensagem de estatísticas da MoviOdds).
   Serve a "corrida a X pontos" (quem chegou primeiro); só entram leituras em que os quartos somam o placar.
   No fim do jogo vai com o resultado (R.blog). */
const raceLogs = new Map(); // jogo → [{ hp, ap }]
function observeRace(id, st) {
  const ev = events.get(id);
  if (!ev || ev.sport !== 'basketball' || ev.state === 'post') return;
  const hp = st?.home?.periods, ap = st?.away?.periods;
  if (!Array.isArray(hp) || !Array.isArray(ap) || !hp.length || hp.length !== ap.length || ![...hp, ...ap].every(Number.isFinite)) return;
  const sum = (x) => x.reduce((s, v) => s + v, 0);
  if (sum(hp) !== st.home.points || sum(ap) !== st.away.points) return;
  const L = raceLogs.get(id) || [], last = L[L.length - 1];
  if (last && String(last.hp) === String(hp) && String(last.ap) === String(ap)) return;
  L.push({ hp: [...hp], ap: [...ap] });
  raceLogs.set(id, L);
}
setInterval(() => { for (const id of raceLogs.keys()) if (!events.has(id)) raceLogs.delete(id); }, 10 * 60000);

/* Basquete (NBA/WNBA) ao vivo: box score da ESPN dos jogos com apostas de jogadores em aberto (a cada 10 s).
   É a segunda fonte para pagar na hora quem passou a linha em rebotes, assistências, etc. (early.js). */
const espnLive = new Map(); // jogo → { box, at, tried }
async function checkBasketLive() {
  const t = now(), want = new Set();
  for (const b of pendingRows()) for (const l of b.legs) if (!l.result && l.market === 'bp') want.add(l.evId);
  for (const id of want) {
    const ev = events.get(id), cur = espnLive.get(id);
    if (!ev || ev.state !== 'in' || ev.sport !== 'basketball' || !BPL.LEAGUES.has(ev.league)) continue;
    if (cur && t - cur.tried < 10000) continue;
    let box = null;
    try { box = await ESPN.basketBox(ev, null, M.bpKey, true); } catch { /* tenta na próxima */ }
    espnLive.set(id, box ? { box, at: t, tried: t } : { ...cur, tried: t });
  }
  for (const id of espnLive.keys()) if (!want.has(id) || events.get(id)?.state !== 'in') espnLive.delete(id);
}
setInterval(() => { checkBasketLive().catch((e) => console.error('[Basquete ao vivo]', e.message)); }, 5000);

async function checkExtraTime() {
  const t = now();
  const want = new Map(); // jogo → precisa (pet = prolongamento/penáltis; pp = jogadores à espera)
  for (const b of pendingRows()) for (const l of b.legs) if (!l.result && (l.market === 'pet' || l.market === 'pp')) want.set(l.evId, want.get(l.evId) === 'pet' ? 'pet' : l.market);
  let changed = false;
  for (const [id, kind] of want) {
    const ev = events.get(id);
    if (!ev || ev.state !== 'post' || ev.sport !== 'soccer' || !ev.result || ev.result.et) continue;
    if (kind === 'pp' && !ev.result.needEt) continue;
    const ended = ev.result.finishedAt || +ev.date + 2 * 3600000;
    if (t - ended > 6 * 3600000) continue; // desistiu: fica para a equipa
    const tr = etTried.get(id) || 0;
    if (t - tr < 120000) continue;
    etTried.set(id, t);
    try {
      const et = await ESPN.extraTime(ev, [ev.result.h, ev.result.a]);
      if (!et) continue;
      ev.result = { ...ev.result, et };
      changed = true;
      console.log(`[Prolongamento] ${M.evLabel(ev)}: ${et.espn} → fim ${et.end}${et.pens ? `, penáltis ${et.pens.join('-')}` : ''}, passa ${et.qualified || '?'}`);
    } catch (e) { console.error(`[Prolongamento] ${M.evLabel(ev)}: ${e.message}`); }
  }
  for (const id of etTried.keys()) if (!want.has(id)) etTried.delete(id);
  if (changed) { feedVersion++; feedCache = null; }
  return changed;
}

// atualização completa e atualização ao vivo correm em separado: a completa não bloqueia a ao vivo
const refreshing = { full: false, live: false };
let lastFeedErr = '';
async function refresh(full) {
  const kind = full ? 'full' : 'live';
  if (refreshing[kind]) return;
  refreshing[kind] = true;
  try {
    const t = now();
    let changed = false;
    const { events: list, ok, errors } = await (full ? FEED.fetchAll() : FEED.fetchLive());
    const err = errors.join(' · ');
    if (err && err !== lastFeedErr) console.error(`[${FEED.name}] Erro ao atualizar ${full ? 'jogos' : 'ao vivo'}:`, err);
    lastFeedErr = err;
    if (ok.size) {
      changed = mergeEvents(list, t);
      if (markMissing(new Set(list.map((e) => e.id)), full, t, ok)) changed = true;
      lastFeedOk = now();
    }
    FEED.ws.want(wsWanted()); // WebSocket: segue os jogos ao vivo e os que vão começar
    if (full) {
      if (await checkResults()) changed = true;
      if (await checkExtraTime()) changed = true;
      const keep = openEvIds();
      for (const [id, ev] of events) if (!ev.manual && t - ev.date > 36 * 3600000 && !keep.has(id)) { events.delete(id); changed = true; }
    }
    // só muda a versão (e os navegadores só voltam a descarregar tudo) quando há novidades,
    // ou a cada 30 s para o "Última atualização" do site continuar a andar
    if (changed || now() - lastBump > 30000) { feedVersion++; feedCache = null; lastBump = now(); }
    await settleQueued();
  } catch (e) {
    console.error('Erro ao atualizar feed:', e.message);
  } finally { refreshing[kind] = false; }
}

/* Proteção das apostas e cash out ao vivo: guarda o estado dos jogos no pedido, espera,
   busca o placar mais recente e recusa se algo mudou (gol, suspensão, fim de jogo). */
function liveSnapshot(evIds) {
  const snap = new Map();
  for (const id of evIds) {
    const ev = events.get(id);
    if (ev && ev.state === 'in') snap.set(id, { h: ev.home.score, a: ev.away.score, state: ev.state, period: ev.period ?? null, clock: ev.clock });
  }
  return snap;
}
// placar e odds ao vivo mais recentes (um pedido só traz todos os jogos a decorrer)
async function refreshLiveNow(evIds) {
  const t = now();
  // só as modalidades dos jogos em causa (com centenas de jogos ao vivo, ler tudo atrasava a aprovação)
  const only = evIds ? [...new Set([...evIds].map((id) => events.get(id)?.sport).filter(Boolean))] : null;
  try {
    const { events: list, ok } = await FEED.fetchLive(only && only.length ? only : null);
    mergeEvents(list, t);
    markMissing(new Set(list.map((e) => e.id)), false, t, ok);
    feedVersion++; feedCache = null;
  } catch (e) { console.error(`[${FEED.name}] Erro ao confirmar ao vivo:`, e.message); }
}
// devolve o motivo da recusa, ou null se nada mudou desde o pedido
function liveChanged(snap, t0) {
  for (const [id, s] of snap) {
    const ev = events.get(id);
    if (!ev || ev.state !== s.state) return 'o jogo mudou de estado durante a aprovação';
    if (M.GOAL_SPORTS.has(ev.sport) && (ev.home.score !== s.h || ev.away.score !== s.a || (ev.goalAt && ev.goalAt >= t0))) return 'houve gol durante a aprovação';
    if (ev.manual && (ev.home.score !== s.h || ev.away.score !== s.a)) return 'o placar mudou durante a aprovação';
    // tênis de mesa: um ponto dura segundos (o placar do set em curso está no relógio, "2º set · 4-7")
    if (ev.sport === 'tabletennis' && (ev.home.score !== s.h || ev.away.score !== s.a || ev.clock !== s.clock)) return 'houve ponto durante a aprovação';
    if (M.isSuspended(ev)) return 'mercado suspenso durante a aprovação';
  }
  return null;
}

function findSel(key) {
  const ev = events.get(String(key).split('|')[0]);
  if (!ev) return { ev: null, sel: null };
  return { ev, sel: M.selections(ev).find((s) => s.key === key) || null };
}

/* ---------------- Criar aposta ----------------
   Várias seleções do mesmo jogo de futebol (antes do início) numa só odd, calculada pelo motor (feeds/betbuilder.js)
   a partir de todas as odds da bet365 desse jogo. Pode juntar-se a outros jogos numa múltipla. */
const bbEligible = (ev) => !!ev && !ev.manual && ev.sport === 'soccer' && !M.isSuspended(ev) && ((ev.state === 'pre' && now() < +ev.date) || (ev.state === 'in' && !ev.awaiting));
const BB_OFF = 'Criar aposta: só no futebol, antes do jogo ou ao vivo';
/* ao vivo: cotações de agora + o que já aconteceu (placar do site, intervalo, escanteios, cartões, jogadores).
   Só no tempo regulamentar; com expulsões os cartões ficam de fora (as casas contam o vermelho de formas diferentes). */
function bbLiveMatch(ev) {
  const x = FEED.bbLive(ev.id);
  if (!x) return null;
  const score = [ev.home.score, ev.away.score];
  if (!score.every(Number.isFinite) || !(x.minute >= 0) || x.minute > 88) return null; // perto do fim: tudo muda em segundos
  const st = x.st, ht = PARTS.soccerHT(st);
  if (ht && !(ht[0] <= score[0] && ht[1] <= score[1])) return null;
  const corners = Number.isFinite(st.home?.corners) && Number.isFinite(st.away?.corners) ? [st.home.corners, st.away.corners] : null;
  const cd = PARTS.soccerCards(st), cards = cd && !cd.reds && cd.lo[0] === cd.hi[0] && cd.lo[1] === cd.hi[1] ? cd.lo : null;
  return { home: x.home, away: x.away, quotes: x.quotes, live: { score, ht, half: ht ? 2 : 1, minute: x.minute, corners, cards, roster: PLAYERS.roster(st) || [] } };
}
const bbMatchOf = (ev) => (ev.state === 'in' ? bbLiveMatch(ev) : FEED.bbMatch(ev.id));
// seleção do site → cotação da bet365 de onde veio
function srcQuote(ev, o) {
  for (const mk of ev.markets || []) {
    if (mk.k !== o.market || String(mk.per ?? '') !== String(o.per ?? '')) continue;
    const s = mk.sels.find((x) => x.pick === o.pick && (x.line ?? null) === (o.line ?? null) && String(x.base ?? '') === String(o.base ?? ''));
    if (s) return s.q || null;
  }
  return null;
}
// odd de um grupo de seleções do mesmo jogo → { odds, params, items } ou { reason, bad? }
// maxAge: idade máxima do motor (na aceitação de uma aposta ao vivo: refeito com as cotações de agora)
function bbQuote(keys, maxAge) {
  const evId = String(keys[0]).split('|')[0], ev = events.get(evId);
  if (!bbEligible(ev)) return { reason: BB_OFF };
  const m = bbMatchOf(ev);
  const E = m && BB.engineFor(evId, m, maxAge);
  if (!E) return { reason: 'Criar aposta indisponível neste jogo' };
  const items = [];
  for (const key of keys) {
    const { sel } = findSel(key);
    if (!sel || sel.locked) return { reason: `mercado suspenso${sel?.name ? ` (${sel.name})` : ''}`, bad: key };
    const q = !sel.manual && srcQuote(ev, sel);
    items.push({ key, sel, q, odds: sel.odds, name: sel.name });
  }
  const r = BB.quote(E, items);
  return r.reason ? r : { ...r, items };
}
// aba Criar aposta: com as seleções já escolhidas deste jogo, a odd de juntar cada uma das outras (0 = não junta)
function bbPreview(keys) {
  const evId = String(keys[0]).split('|')[0], ev = events.get(evId);
  if (!bbEligible(ev)) return { reason: BB_OFF };
  const m = bbMatchOf(ev);
  const E = m && BB.engineFor(evId, m);
  if (!E) return { reason: 'Criar aposta indisponível neste jogo' };
  const items = [];
  for (const key of keys) {
    const { sel } = findSel(key);
    if (!sel || sel.locked) return { reason: `mercado suspenso${sel?.name ? ` (${sel.name})` : ''}`, bad: key };
    items.push({ key, q: !sel.manual && srcQuote(ev, sel), odds: sel.odds });
  }
  const mine = new Set(keys);
  const cands = M.selections(ev).filter((s) => s.bb && !s.locked && !mine.has(s.key)).map((s) => ({ key: s.key, q: srcQuote(ev, s), odds: s.odds }));
  const odds = BB.preview(E, items, cands);
  return odds ? { odds } : { reason: 'estas seleções não entram no Criar aposta' };
}

/* Criar aposta no navegador: o modelo do jogo (parâmetros do motor) e a cotação de cada seleção que entra.
   O navegador mostra as odds recalculadas na hora; a odd da aposta continua a ser a do servidor (/api/betbuilder/price). */
const BB_FIELDS = ['group_name', 'group_id', 'side', 'label', 'line', 'handicap', 'n2'];
function bbModel(evId) {
  const ev = events.get(evId);
  if (!bbEligible(ev)) return { reason: BB_OFF };
  const m = bbMatchOf(ev);
  const E = m && BB.engineFor(evId, m);
  if (!E) return { reason: 'Criar aposta indisponível neste jogo' };
  const src = {};
  for (const s of M.selections(ev)) {
    if (!s.bb) continue;
    const q = srcQuote(ev, s);
    if (q) src[s.key] = Object.fromEntries(BB_FIELDS.filter((k) => q[k] != null).map((k) => [k, q[k]]));
  }
  return { model: BB.modelOf(E), src };
}
// o motor (feeds/players.js + feeds/betbuilder.js) num só ficheiro para o navegador
let bbEngineJs = null;
function bbEngineFile() {
  if (bbEngineJs) return bbEngineJs;
  const wrap = (file, name) => `{const module={exports:{}},exports=module.exports;(function(){
${fs.readFileSync(path.join(__dirname, 'feeds', file), 'utf8')}
})();mods.${name}=module.exports;}
`;
  const js = `(function(){'use strict';const mods={};const require=(p)=>/players/.test(p)?mods.players:/markets/.test(p)?Markets:{};
${wrap('players.js', 'players')}${wrap('betbuilder.js', 'bb')}window.BBE=mods.bb;})();
`;
  const data = Buffer.from(js);
  bbEngineJs = { data, gz: zlib.gzipSync(data, { level: 9 }), etag: `"${crypto.createHash('sha1').update(data).digest('base64url').slice(0, 16)}"` };
  return bbEngineJs;
}

/* A lista de jogos leva só os mercados da linha do jogo (vencedor e linha principal do total) e o número total
   de seleções ("+N"). Os mercados completos de um jogo vêm de /api/events/full (página do jogo, boletim, apostas
   em aberto) — com dezenas de mercados por jogo de ténis, mandar tudo a cada 5 s pesaria vários MB. */
const LIST_KINDS = new Set(['ml', 'mlr', 'total', 'gtotal']);
function lightMarkets(markets) {
  if (!markets) return null;
  const out = [];
  for (const mk of markets) {
    if (!LIST_KINDS.has(mk.k) || mk.per != null) continue;
    if (mk.k === 'total' || mk.k === 'gtotal') {
      const line = mk.main ?? mk.sels[0]?.line;
      out.push({ ...mk, sels: mk.sels.filter((s) => s.line === line) });
    } else out.push(mk);
  }
  return out.length ? out : markets.slice(0, 1).map((mk) => ({ ...mk, sels: mk.sels.slice(0, 3) })); // sempre algo, para o jogo não parecer fechado
}
const publicEvent = ({ goalAt, fetchedAt, pendingResult, result, ...ev }) => ({ ...ev, goalAt: goalAt || null });
// jogo com os mercados completos (aberto, no boletim ou com apostas): leva também o acompanhamento das apostas
const fullEvent = (e) => {
  const track = e.sport === 'soccer' ? trackOf(e, e.result) : e.sport === 'basketball' ? basketTrack(e, e.result) : null;
  return track ? { ...publicEvent(e), track } : publicEvent(e);
};
/* Acompanhamento das apostas (barra de progresso, como na bet365): os números do jogo que as seleções contam.
   c = escanteios · y = cartões (amarelos + vermelhos) · ht = placar ao intervalo · pl = jogadores
   Ao vivo vêm das estatísticas da fonte; no fim, do resultado. Só vai nos jogos abertos (mercados completos). */
const PARTS = require('./feeds/parts.js'), PLAYERS = require('./feeds/players.js');
const PL_FIELDS = ['goals', 'shots', 'shots_on_target', 'assists', 'fouls', 'fouls_drawn', 'tackles', 'saves', 'passes', 'yellow_cards', 'red_cards'];
function trackOf(ev, R) {
  const fin2 = (x) => (Array.isArray(x) && x.every(Number.isFinite) ? x : null);
  if (ev.state === 'post' && R) {
    const cards = fin2(R.parts?.cards), hi = fin2(R.parts?.cardsHi);
    return { c: fin2(R.parts?.corners), y: cards && hi ? [cards[0] + (hi[0] - cards[0]) / 2, cards[1] + (hi[1] - cards[1]) / 2] : cards, ht: fin2(R.parts?.h1), pl: R.players || null };
  }
  const st = ev.state === 'in' ? FEED.liveStats(ev.id) : null;
  if (!st) return null;
  const cards = PARTS.soccerCards(st);
  const pl = (PLAYERS.roster(st) || []).map((p) => { const o = { key: p.key, side: p.side, played: p.played }; for (const f of PL_FIELDS) if (Number.isFinite(p[f])) o[f] = p[f]; return o; });
  return {
    c: Number.isFinite(st.home?.corners) && Number.isFinite(st.away?.corners) ? [st.home.corners, st.away.corners] : null,
    y: cards ? [cards.lo[0] + (cards.hi[0] - cards.lo[0]) / 2, cards.lo[1] + (cards.hi[1] - cards.lo[1]) / 2] : null,
    ht: PARTS.soccerHT(st), pl: pl.length ? pl : null,
  };
}
// basquete: pl = box score dos jogadores (ao vivo das estatísticas da fonte; no fim, do resultado)
const BPL = require('./feeds/bplayers.js');
function basketTrack(ev, R) {
  if (ev.state === 'post') return R?.bp ? { bp: R.bp } : null;
  const list = ev.state === 'in' ? BPL.roster(FEED.liveStats(ev.id)) : null;
  return list ? { bp: list.map(({ key, side, played, pts, reb, ast, tpm, stl, blk }) => ({ key, side, played, pts, reb, ast, tpm, stl, blk })) } : null;
}
// versão para a lista de jogos: só os mercados da linha do jogo + o número de seleções
function lightEvent(e) {
  const { stats, details, ...ev } = publicEvent(e); // estatísticas e lances só na página do jogo
  return { ...ev, markets: lightMarkets(ev.markets), nsel: (ev.markets || []).reduce((n, mk) => n + mk.sels.length, 0) };
}
// estado da fonte para o painel da equipa
function feedInfo() {
  const list = [...events.values()];
  return {
    source: FEED.name, lastFeedOk, events: list.length, live: list.filter((e) => e.state === 'in').length,
    browsers: streams.size, ws: FEED.ws.info(),
  };
}
/* A lista completa (~1,2 MB) só se volta a montar no máximo a cada FEED_REBUILD_MS: com o WebSocket as odds mudam
   várias vezes por segundo e montar + comprimir a cada pedido travava o servidor. Quem está ligado em tempo real
   recebe as mudanças pelo fluxo; a lista é só para a primeira carga e de reserva. */
const FEED_REBUILD_MS = 3000;
let feedBuiltAt = 0, lastFeed = null;
function feedPayload() {
  if (!feedCache && lastFeed && now() - feedBuiltAt < FEED_REBUILD_MS) return lastFeed;
  if (!feedCache) {
    feedBuiltAt = now();
    const list = [...events.values()].map(lightEvent);
    // leagues: campeonatos criados na hora (torneios de ténis), para o navegador os conhecer
    feedCache = lastFeed = { etag: `"v${feedVersion}"`, body: JSON.stringify({ lastFeedOk, leagues: M.dynLeagues(), catalog: catalogCache, events: list }) };
  }
  return feedCache;
}

/* ---------------- catálogo da equipa ----------------
   Modalidades, campeonatos, eventos e mercados criados no painel /admin ("Esportes e mercados"). Ficam em memória
   (ligação em tempo real ao Firestore) e entram no feed ao lado dos jogos da fonte. Os mercados da equipa são
   liquidados quando a equipa (ou o bot da transmissão) marca o resultado (catalog.js). */
const catSports = new Map(), catLeagues = new Map();
const manualEvents = new Map();  // eventos da equipa (cada um com os seus mercados)
const manualMarkets = new Map(); // id do jogo da fonte -> { markets } (mercados extra em jogos da fonte)
let catalogCache = null;

// o que o site vê de cada mercado: só os abertos e suspensos, sem resultados
function pubMarkets(list) {
  const out = (list || []).filter((m) => m.status !== 'settled')
    .map((m) => ({ id: m.id, name: m.name, status: m.status, maxStake: m.maxStake ?? null, group: m.group || null, closesAt: m.closesAt ?? null, sels: m.sels.filter((s) => !s.hidden).map((s) => ({ id: s.id, name: s.name, odds: s.odds, ...(s.locked ? { locked: true } : {}), ...(s.side ? { side: s.side, line: s.line ?? null } : {}) })) }))
    .filter((m) => m.sels.length); // mercado fechado na reta final: sai do site
  return out.length ? out : null;
}
function extraMarketsOf(evId) { return pubMarkets(manualMarkets.get(evId)?.markets); }
// mercados da equipa de um evento (da equipa ou da fonte), com resultados
const teamMarkets = (evId) => (manualEvents.get(evId) || manualMarkets.get(evId))?.markets || [];

function publicCatalog() {
  const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt;
  const sports = [...catSports.values()].filter((s) => !s.hidden).sort(byOrder).map((s) => ({ key: s.id, name: s.name, icon: s.icon }));
  const visible = (k) => (M.SPORTS[k] && !M.SPORTS[k].custom) || sports.some((s) => s.key === k);
  const leagues = [...catLeagues.values()].filter((l) => !l.hidden && visible(l.sport)).sort(byOrder)
    .map((l) => ({ key: l.id, name: l.name, country: l.country || '', sport: l.sport }));
  return { sports, leagues };
}

// emblema de uma equipa de um evento da equipa: o escrito no painel, senão o da Liquipedia (pelo jogo: R6, CS2, Valorant)
const manualLogo = (d, side, name) => d.logos?.[side] || (d.outright ? '' : LOGOS.logo('esports', name, 0, d.game || catLeagues.get(d.league)?.rules?.preset));
function manualToEvent(d) {
  const lg = M.LEAGUE_BY_KEY[d.league];
  const side = (name, score, id) => ({ id, name, short: name, logo: manualLogo(d, id, name), score: d.state === 'pre' ? null : score ?? 0, form: '' });
  return {
    id: d.id, manual: true, league: d.league, leagueName: lg.name, country: lg.country, sport: lg.sport,
    date: new Date(d.startsAt), state: d.state, completed: d.state === 'post', statusName: '',
    clock: d.clock || (d.state === 'post' ? 'Encerrado' : d.state === 'in' ? 'Ao vivo' : undefined),
    home: side(d.home, d.score?.h, 'h'), away: side(d.away, d.score?.a, 'a'), details: [], venue: '', markets: null, cm: pubMarkets(d.markets),
    // longo prazo (campeão, artilheiro...): sem adversário; as apostas fecham na data do evento
    ...(d.outright ? { outright: true, closesAt: d.startsAt } : {}),
    ...(d.stream ? { stream: { type: d.stream.type, id: d.stream.id } } : {}),
    // mapas da série (nome e quem escolheu) e jogadores vivos no round em curso
    ...(d.live?.maps?.some((m) => m.name || m.pick) ? { maps: d.live.maps } : {}),
    ...(d.state === 'in' && d.live?.alive && d.score && d.live.alive.x === d.score.h && d.live.alive.y === d.score.a ? { alive: { h: d.live.alive.h, a: d.live.alive.a } } : {}),
  };
}

// reconstrói tudo o que depende do catálogo (corre a cada mudança no Firestore) e avisa os navegadores ligados
function applyCatalog() {
  catalogCache = publicCatalog();
  M.setCatalog(catalogCache);
  for (const [id, ev] of events) if (ev.manual) { events.delete(id); touch(id); }
  for (const d of manualEvents.values()) if (!d.archived && M.LEAGUE_BY_KEY[d.league]) { events.set(d.id, manualToEvent(d)); touch(d.id); }
  for (const ev of events.values()) {
    if (ev.manual) continue;
    const cm = extraMarketsOf(ev.id);
    if (JSON.stringify(cm) !== JSON.stringify(ev.cm ?? null)) { ev.cm = cm; touch(ev.id); }
  }
  feedVersion++; feedCache = null;
}

setInterval(() => {
  let n = 0;
  for (const d of manualEvents.values()) {
    const ev = events.get(d.id);
    if (!ev || !ev.manual) continue;
    for (const [k, id] of [['home', 'h'], ['away', 'a']]) {
      const url = manualLogo(d, id, ev[k].name);
      if (url !== ev[k].logo) { ev[k] = { ...ev[k], logo: url }; touch(ev.id); n++; }
    }
  }
  if (n) { feedVersion++; feedCache = null; }
}, 20000).unref();

// seleção de um mercado da equipa: fica decidida quando a equipa liquida o mercado
const CUSTOM_RESULT = { won: 1, lost: -1, void: 0 };
function settleCustomLeg(leg) {
  const [mId, sId] = String(leg.pick).split('.');
  const mk = teamMarkets(leg.evId).find((m) => m.id === mId);
  if (!mk || mk.status !== 'settled') return false;
  const r = mk.sels.find((s) => s.id === sId)?.result || 'void'; // seleção removida: devolvida
  leg.result = r; leg.value = CUSTOM_RESULT[r] ?? 0;
  leg.final = mk.sels.filter((s) => s.result === 'won').map((s) => s.name).join(', ') || 'anulado';
  return true;
}

/* ---------------- liquidação ---------------- */
// fecha uma aposta (ganha, perdida, devolvida) e paga, se for o caso. Só acontece uma vez.
async function closeBet(bet, status, payout, legs, txType) {
  const ok = await runTx([bet.userId], async (t) => {
    const ref = col.openBets().doc(bet.id);
    if (!(await t.get(ref)).exists) return false; // já foi fechada
    t.delete(ref);
    t.update(col.bets(bet.userId).doc(bet.id), { status, payout, settledAt: now(), legs });
    if (payout > 0) {
      t.update(col.user(bet.userId), { balance: inc(payout), [`daily.${dayKey()}.returned`]: inc(payout) });
      addTx(t, bet.userId, txType, payout, bet.id);
    }
    return true;
  });
  if (ok) {
    openBets.delete(bet.id);
    if (legs.some((l) => !l.result)) addTrail({ id: bet.id, userId: bet.userId, legs, at: now() }).catch((e) => console.error('[Seleções por marcar]', e.message));
  }
  return ok;
}
async function addTrail(row) {
  trail.set(row.id, row);
  await col.trailBets().doc(row.id).set(row);
}
// marca as seleções que faltam nas apostas fechadas (mesmas regras); grava só as seleções
async function settleTrail() {
  const t = now();
  for (const row of [...trail.values()]) {
    try {
      if (t - row.at > TRAIL_DAYS * DAY) { trail.delete(row.id); await col.trailBets().doc(row.id).delete(); continue; }
      const legs = structuredClone(row.legs);
      let changed = false;
      for (const leg of legs) {
        if (leg.result || leg.market === 'custom') continue;
        if (M.settleLeg(leg, events.get(leg.evId))) changed = true;
        else if (EARLY.check('trail|' + row.id, leg)) changed = true;
      }
      if (!changed) continue;
      await col.bets(row.userId).doc(row.id).update({ legs }); // só as seleções: estado, pagamento e saldo ficam
      const done = legs.every((l) => l.result || l.market === 'custom');
      if (done) { trail.delete(row.id); await col.trailBets().doc(row.id).delete(); }
      else { trail.set(row.id, { ...row, legs }); await col.trailBets().doc(row.id).update({ legs }); }
      dirty(row.userId);
    } catch (e) { console.error(`Seleções por marcar da aposta ${row.id}:`, e.message); }
  }
}
/* ao arrancar: lista guardada + apostas fechadas dos últimos 3 dias que ficaram com seleções por marcar
   (as fechadas antes desta mudança, ex.: múltipla perdida no 1º jogo com os outros ainda a decorrer) */
async function loadTrail() {
  for (const d of (await col.trailBets().get()).docs) trail.set(d.id, d.data());
  const since = now() - TRAIL_DAYS * DAY;
  let found = 0;
  for (const u of (await col.users().get()).docs) {
    const qs = await col.bets(u.id).where('placedAt', '>=', since).get();
    for (const b of qs.docs) {
      const x = b.data();
      if (x.status === 'open' || trail.has(b.id) || !Array.isArray(x.legs) || !x.legs.some((l) => !l.result && l.market !== 'custom')) continue;
      await addTrail({ id: b.id, userId: u.id, legs: x.legs, at: x.settledAt || now() });
      found++;
    }
  }
  if (trail.size) console.log(`[Seleções por marcar] ${trail.size} apostas fechadas com seleções ainda a acompanhar (${found} encontradas agora)`);
}

/* odd final de uma aposta com seleções devolvidas (ou meio ganhas): cada seleção solta conta pela sua odd;
   cada Criar aposta conta pela odd do grupo e, com seleções anuladas, a odd é recalculada só com as que ficaram
   (mesmos números do modelo do momento da aposta; se ficar uma só, vale a odd dela nesse momento) */
function betFactor(row, legs) {
  let f = legs.filter((l) => !l.bb).reduce((p, l) => p * M.outcomeFactor(l.value, l.odds), 1);
  for (const [evId, g] of Object.entries(row.bb || {})) {
    const gl = legs.filter((l) => l.bb === evId);
    if (gl.every((l) => l.value === 1)) { f *= g.odds; continue; }
    try { f *= BB.requote(g.params, gl.filter((l) => l.value > 0).map((l) => ({ src: l.src, odds: l.odds }))); }
    catch (e) { console.error(`[Criar aposta] aposta ${row.id}: nova odd falhou (${e.message}); conta cada seleção pela sua odd`); f *= gl.filter((l) => l.value > 0).reduce((p, l) => p * l.odds, 1); }
  }
  return f;
}

// as duas atualizações chamam isto: se já estiver a correr, a próxima (daqui a 5 s) apanha o que faltar
let settling = false;
async function settleBets() {
  if (settling) return;
  settling = true;
  try { await settleAll(); } finally { settling = false; }
}
async function settleAll() {
  EARLY.tick(); // mercados abertos/fechados de cada jogo ao vivo (para o VAR)
  for (const row of [...openBets.values()]) {
    try {
      const legs = structuredClone(row.legs);
      let changed = false;
      for (const leg of legs) {
        if (leg.result) continue;
        if (leg.market === 'custom') { if (settleCustomLeg(leg)) changed = true; continue; } // mercado da equipa (painel)
        // o resultado já vem confirmado (lido duas vezes igual, ver checkResults)
        if (M.settleLeg(leg, events.get(leg.evId))) changed = true;
        else if (EARLY.check(row.id, leg)) { changed = true; console.log(`[Liquidação antecipada] aposta ${row.id}: ${leg.name} (${leg.marketName}, ${leg.event}) → ${leg.result} · ${leg.final}`); }
      }
      const anyLost = legs.some((l) => l.result === 'lost');
      const allDone = legs.every((l) => l.result);
      if (anyLost || allDone) {
        // todas ganhas: paga exatamente o "retorno potencial" mostrado (odd total arredondada a 2 casas);
        // com devolvidas / meio ganhas, recalcula com as odds de cada seleção
        const payout = anyLost ? 0 : legs.every((l) => l.value === 1) ? row.potential : Math.round(row.stake * betFactor(row, legs));
        const status = payout === 0 ? 'lost' : payout > row.stake ? 'won' : 'void';
        await closeBet(row, status, payout, legs, status === 'won' ? 'Prêmio' : 'Aposta devolvida');
      } else if (changed) {
        const b = db.batch();
        b.update(col.openBets().doc(row.id), { legs });
        b.update(col.bets(row.userId).doc(row.id), { legs });
        await b.commit();
        openBets.set(row.id, { ...row, legs });
        dirty(row.userId);
      }
    } catch (e) { console.error(`Erro ao liquidar aposta ${row.id}:`, e.message); }
  }
  await settleTrail();
}
// uma liquidação de cada vez (o feed e o painel podem pedir ao mesmo tempo)
let settleRun = Promise.resolve();
const settleQueued = () => (settleRun = settleRun.then(settleBets, settleBets));

/* ---------------- depósitos (BravoPay) ---------------- */
const DEP_MIN = toCents(process.env.DEPOSIT_MIN || 20), DEP_MAX = 5000000; // mínimo R$ 20 (configurável), máximo R$ 50.000
const WD_MIN = toCents(process.env.WITHDRAW_MIN || 30);  // saque mínimo
const PIX_EXPIRES = 30 * 60;                             // validade do QR Code: 30 min

/* Limite diário de depósito: o perfil guarda "depositLog" com os depósitos das últimas 24h
   (pagos = OK, PIX por pagar = P). Assim não é preciso consultar coleções inteiras. */
const depositWindow = (log) => (log || []).filter((e) => e.at > now() - DAY);
function checkDepositLimit(u, log, amt) {
  const lim = effLimit(u, 'depositLimit');
  if (lim == null) return;
  const used = log.reduce((s, e) => s + e.amount, 0);
  if (used + amt > lim) fail(400, `Limite diário de depósito atingido (restam ${brl(Math.max(0, lim - used))}).`);
}

function publicDeposit(d) {
  return { id: d.id, amount: fromCents(d.amount), status: d.status, pixCode: d.pixCode, pixQr: d.pixQr, expiresAt: d.expiresAt, paidAt: d.paidAt };
}

// aplica o estado vindo da BravoPay (webhook ou consulta). Idempotente: pode ser chamado várias vezes.
async function applyDepositStatus(depId, bt) {
  const st = String(bt.status || '').toUpperCase();
  let res = null;
  await runTx([], async (t) => {
    res = null;
    const depRef = col.deposits().doc(depId);
    const ds = await t.get(depRef);
    if (!ds.exists) return;
    const dep = ds.data();
    const userRef = col.user(dep.userId);
    const us = await t.get(userRef);
    const log = depositWindow(us.exists ? us.data().depositLog : []);
    if (st === 'PAID' && dep.status === 'PENDING') {
      /* A BravoPay pode devolver a MESMA cobrança para vários pedidos de PIX (ex.: o jogador clica
         "gerar PIX" várias vezes). Um pagamento só pode creditar UM depósito: se outro depósito com
         a mesma cobrança já foi pago (ou está em revisão), este fica DUPLICATE e não credita.
         A consulta é feita dentro da transação, por isso duas confirmações em simultâneo não passam as duas. */
      if (dep.bpId) {
        const sib = await t.get(col.deposits().where('bpId', '==', dep.bpId));
        if (sib.docs.some((d) => d.id !== depId && ['PAID', 'REVIEW', 'REFUNDED', 'CHARGEBACK'].includes(d.data().status))) {
          t.update(depRef, { status: 'DUPLICATE', note: 'mesma cobrança BravoPay de outro depósito já pago' });
          t.update(userRef, { depositLog: log.filter((e) => e.id !== dep.id) });
          res = { dep, kind: 'duplicate' }; return;
        }
      }
      if (bt.amount_cents != null && Number(bt.amount_cents) !== dep.amount) {
        t.update(depRef, { status: 'REVIEW', paidAmount: Number(bt.amount_cents), reviewReason: `valor pago ${brl(Number(bt.amount_cents))} diferente de ${brl(dep.amount)}` });
        res = { dep, kind: 'review' }; return;
      }
      t.update(depRef, { status: 'PAID', paidAt: isoMs(bt.paid_at) || now() });
      t.update(userRef, { balance: inc(dep.amount), depositLog: log.map((e) => (e.id === dep.id ? { ...e, st: 'OK' } : e)) });
      addTx(t, dep.userId, 'Depósito PIX', dep.amount, dep.id);
      res = { dep, kind: 'paid' };
    } else if ((st === 'EXPIRED' || st === 'FAILED') && dep.status === 'PENDING') {
      t.update(depRef, { status: st });
      t.update(userRef, { depositLog: log.filter((e) => e.id !== dep.id) });
      res = { dep, kind: 'closed' };
    } else if ((st === 'REFUNDED' || st === 'CHARGEBACK') && dep.status === 'PAID') {
      // estorno/MED: retira o valor do saldo (pode ficar negativo)
      t.update(depRef, { status: st, reversedAt: now() });
      t.update(userRef, { balance: inc(-dep.amount) });
      addTx(t, dep.userId, st === 'CHARGEBACK' ? 'Contestação de depósito' : 'Estorno de depósito', -dep.amount, dep.id);
      res = { dep, kind: 'reversed' };
    }
  });
  if (!res) return;
  dirty(res.dep.userId);
  pendingDeposits.delete(depId); // já não está PENDING (o listener confirma logo a seguir)
  if (res.kind === 'paid') console.log(`[BravoPay] Depósito ${depId} pago: ${brl(res.dep.amount)} (user ${res.dep.userId})`);
  if (res.kind === 'review') console.error(`[BravoPay] Depósito ${depId}: valor pago ${bt.amount_cents} difere do esperado ${res.dep.amount}. Ficou em REVIEW (ver painel).`);
  if (res.kind === 'duplicate') console.warn(`[BravoPay] Depósito ${depId} ignorado: cobrança ${res.dep.bpId} já creditada noutro depósito (user ${res.dep.userId})`);
  if (res.kind === 'reversed') console.warn(`[BravoPay] Depósito ${depId} ${st}: ${brl(res.dep.amount)} retirado do saldo do user ${res.dep.userId}`);
}

const depChecked = new Map(); // id -> última consulta à BravoPay
async function syncDeposit(dep) {
  if (!dep.bpId) return;
  depChecked.set(dep.id, now());
  try { await applyDepositStatus(dep.id, await BP.getTransaction(dep.bpId)); }
  catch (e) { console.error(`[BravoPay] Erro a consultar depósito ${dep.id}:`, e.message); }
}

// rede de segurança: confirma pagamentos mesmo se um webhook se perder (ou se o site corre em localhost)
let reconciling = false;
async function reconcileDeposits() {
  if (!BP.enabled || reconciling) return;
  reconciling = true;
  try {
    const t = now();
    const deps = [...pendingDeposits.values()].filter((d) => t - (depChecked.get(d.id) || 0) > 60000)
      .sort((a, b) => (depChecked.get(a.id) || 0) - (depChecked.get(b.id) || 0)).slice(0, 10);
    for (const d of deps) {
      if (t - d.createdAt > 48 * 3600000) await applyDepositStatus(d.id, { status: 'EXPIRED' });
      else await syncDeposit(d);
    }
  } catch (e) { console.error('[BravoPay] Erro na reconciliação:', e.message); }
  finally { reconciling = false; }
}

// POST /api/webhooks/bravopay — recebe o corpo BRUTO para validar a assinatura HMAC
async function handleWebhook(req, res) {
  const reply = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: code < 300, msg })); };
  let raw = '';
  try {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 1e6) return reply(413, 'too large'); chunks.push(c); }
    raw = Buffer.concat(chunks).toString('utf8');
  } catch { return reply(400, 'bad body'); }
  if (!BP.verifySignature(req.headers['bravopay-signature'] || req.headers['x-bravopay-signature'], raw)) {
    console.warn('[BravoPay] Webhook com assinatura inválida rejeitado.');
    return reply(401, 'invalid signature');
  }
  let evt;
  try { evt = JSON.parse(raw); } catch { return reply(400, 'bad json'); }
  if (!evt || !evt.id || !evt.type) return reply(400, 'bad event');
  const evtRef = col.webhookEvents().doc(String(evt.id).replace(/\//g, '_'));
  const data = evt.data || {};
  try {
    if ((await evtRef.get()).exists) return reply(200, 'duplicate');
    if (evt.type.startsWith('transaction.')) {
      // a mesma cobrança pode estar ligada a vários depósitos: o estado aplica-se a todos
      // (só um é creditado; os outros ficam DUPLICATE — ver applyDepositStatus)
      const depIds = new Set();
      const ext = String(data.external_reference || '');
      if (/^D[0-9A-F]{12}$/.test(ext) && (await col.deposits().doc(ext).get()).exists) depIds.add(ext);
      if (data.id) for (const d of (await col.deposits().where('bpId', '==', String(data.id)).get()).docs) depIds.add(d.id);
      const st = data.status || { 'transaction.paid': 'PAID', 'transaction.expired': 'EXPIRED', 'transaction.failed': 'FAILED', 'transaction.refunded': 'REFUNDED', 'transaction.chargeback': 'CHARGEBACK' }[evt.type];
      for (const depId of depIds) await applyDepositStatus(depId, { ...data, status: st });
    } // os saques são manuais: eventos withdrawal.* são ignorados
    await evtRef.set({ type: evt.type, at: now() });
    reply(200, 'ok');
  } catch (e) {
    console.error('[BravoPay] Erro a processar webhook:', e);
    reply(500, 'error'); // a BravoPay volta a tentar
  }
}

/* ---------------- sessões ---------------- */
async function startSession(ctx, uid) {
  const token = crypto.randomBytes(32).toString('hex');
  const s = { uid, expires: now() + SESSION_DAYS * 86400000, createdAt: now(), ip: ctx.ip || null, ua: String(ctx.req.headers['user-agent'] || '').slice(0, 200) };
  await col.sessions().doc(sha256(token)).set(s);
  await col.user(uid).update({ lastLogin: now() });
  dirty(uid);
  sessCache.set(sha256(token), s);
  ctx.setCookie(`${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${ctx.secure ? '; Secure' : ''}`);
}
async function endSessions(uid, exceptHash) {
  const qs = await col.sessions().where('uid', '==', uid).get();
  const b = db.batch();
  qs.docs.forEach((d) => { if (d.id !== exceptHash) { b.delete(d.ref); sessCache.delete(d.id); } });
  await b.commit();
}
async function sessionUser(token) {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const h = sha256(token);
  let s = sessCache.get(h);
  if (!s) {
    const d = await col.sessions().doc(h).get();
    if (!d.exists) return null;
    s = d.data(); sessCache.set(h, s);
  }
  if (s.expires < now()) { sessCache.delete(h); return null; }
  const u = await getUser(s.uid);
  if (!u || u.blocked) return null;
  let a = null;
  try { a = await authInfo(s.uid); } catch (e) { console.error('[Firebase] Erro a consultar a conta:', e.message); }
  if (a && (a.missing || a.disabled)) return null;
  if (a && a.validAfter && s.createdAt < a.validAfter) { // senha redefinida depois desta sessão
    sessCache.delete(h); col.sessions().doc(h).delete().catch(() => {});
    return null;
  }
  return u;
}
async function purgeSessions() {
  try {
    const qs = await col.sessions().where('expires', '<', now()).limit(400).get();
    if (qs.empty) return;
    const b = db.batch(); qs.docs.forEach((d) => { b.delete(d.ref); sessCache.delete(d.id); }); await b.commit();
  } catch (e) { console.error('[Firebase] Erro ao limpar sessões:', e.message); }
}

/* ---------------- handlers da API ---------------- */
const userLocks = new Set();
const LOGIN_BAD = new Set(['INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_EMAIL', 'MISSING_PASSWORD']);

function requireUser(ctx) {
  if (!ctx.user) fail(401, 'Entre na sua conta para continuar.');
  return ctx.user;
}
const meUser = async (uid) => publicUser(await getUser(uid, true));

const routes = {
  'GET /api/events': (ctx) => {
    const p = feedPayload();
    ctx.res.setHeader('X-Server-Now', String(now()));
    if (ctx.req.headers['if-none-match'] === p.etag) { ctx.res.writeHead(304, { ETag: p.etag }); ctx.res.end(); return; }
    const headers = { 'Content-Type': 'application/json; charset=utf-8', ETag: p.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
    if (acceptsGzip(ctx.req)) {
      if (!p.gz) p.gz = zlib.gzipSync(p.body, { level: 6 }); // uma compressão por versão da lista
      ctx.res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
      ctx.res.end(p.gz);
      return;
    }
    ctx.res.writeHead(200, headers);
    ctx.res.end(p.body);
  },

  // mercados completos de alguns jogos (página do jogo, boletim, apostas em aberto): ?ids=a,b,c (até 40)
  'GET /api/events/full': (ctx) => {
    const ids = String(new URL(ctx.req.url, 'http://x').searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 40);
    ctx.res.setHeader('X-Server-Now', String(now()));
    return { events: ids.map((id) => events.get(id)).filter(Boolean).map(fullEvent) };
  },

  // jogos abertos neste navegador (página do jogo, boletim, apostas): recebem os mercados completos pelo fluxo
  'POST /api/stream/watch': (ctx) => {
    const st = streams.get(String(ctx.body.sid || ''));
    if (!st) fail(404, 'Fluxo não encontrado.');
    st.watch = new Set((Array.isArray(ctx.body.ids) ? ctx.body.ids : []).map(String).filter((id) => id.length < 40).slice(0, 40));
    return { ok: true };
  },

  'GET /api/site': () => ({ site: SITE }),

  'POST /api/register': async (ctx) => {
    rateLimit(ctx.ip, 'reg', 20, 60 * 60000);
    const { name, email, password, birthdate, terms } = ctx.body;
    const nm = String(name || '').trim(), em = String(email || '').trim().toLowerCase(), pw = String(password || '');
    if (nm.length < 3 || nm.length > 80 || !/\s/.test(nm)) fail(400, 'Informe o nome completo.');
    if (!validEmail(em)) fail(400, 'E-mail inválido.');
    if (!validPassword(pw)) fail(400, 'A senha precisa de pelo menos 8 caracteres, com letras e números.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(birthdate || ''))) fail(400, 'Data de nascimento inválida.');
    const age = ageFrom(birthdate);
    if (age < 18) fail(400, 'É proibido apostar com menos de 18 anos.');
    if (age > 120) fail(400, 'Data de nascimento inválida.');
    if (!terms) fail(400, 'Aceite os termos e confirme que tem 18 anos ou mais.');
    const cpf = validCpf(ctx.body.cpf);
    if (!cpf) fail(400, 'CPF inválido. Confira os números.');
    if ((await col.cpfs().doc(cpf).get()).exists) fail(409, 'Já existe uma conta com este CPF. Se for sua, entre ou recupere a senha.');
    let rec;
    try { rec = await auth.createUser({ email: em, password: pw, displayName: nm }); }
    catch (e) {
      if (e.code === 'auth/email-already-exists') fail(409, 'Já existe uma conta com este e-mail.');
      if (e.code === 'auth/invalid-email') fail(400, 'E-mail inválido.');
      if (e.code === 'auth/invalid-password') fail(400, 'Senha inválida.');
      throw e;
    }
    try {
      // perfil + reserva do CPF juntos (se duas contas tentarem o mesmo CPF ao mesmo tempo, só uma fica)
      await runTx([rec.uid], async (t) => {
        const cpfRef = col.cpfs().doc(cpf);
        if ((await t.get(cpfRef)).exists) fail(409, 'Já existe uma conta com este CPF. Se for sua, entre ou recupere a senha.');
        t.create(cpfRef, { uid: rec.uid, at: now() });
        t.create(col.user(rec.uid), {
          name: nm, email: em, birthdate, cpf, balance: 0, depositLimit: null, lossLimitDay: null, lossLimitMonth: null,
          pendingLimits: {}, acceptAny: true, depositLog: [], daily: {}, emailVerified: false, blocked: false,
          excludedUntil: null, realityCheck: 0, createdAt: now(), lastLogin: null, termsAcceptedAt: now(), signupIp: ctx.ip || null,
        });
      });
    } catch (e) { await auth.deleteUser(rec.uid).catch(() => {}); throw e; }
    await startSession(ctx, rec.uid);
    sendEmailVerification(rec.uid).catch((e) => console.error('[Firebase] Não foi possível enviar o e-mail de confirmação:', e.message));
    return { user: await meUser(rec.uid) };
  },

  'POST /api/login': async (ctx) => {
    rateLimit(ctx.ip, 'login', 10, 10 * 60000);
    const em = String(ctx.body.email || '').trim().toLowerCase(), pw = String(ctx.body.password || '');
    if (!em || !pw) fail(401, 'E-mail ou senha incorretos.');
    let uid;
    try { uid = await verifyPassword(em, pw); }
    catch (e) {
      if (LOGIN_BAD.has(e.authCode)) fail(401, 'E-mail ou senha incorretos.');
      if (e.authCode === 'USER_DISABLED') fail(403, 'Esta conta está bloqueada. Contacte o suporte.');
      if (e.authCode === 'TOO_MANY_ATTEMPTS_TRY_LATER') fail(429, 'Muitas tentativas. Tente de novo em alguns minutos.');
      if (e.authCode === 'OPERATION_NOT_ALLOWED') console.error('[Firebase] Ative "E-mail/senha" em Authentication > Sign-in method no console do Firebase.');
      else console.error('[Firebase] Erro no login:', e.message);
      fail(503, 'Login indisponível no momento. Tente de novo mais tarde.');
    }
    const u = await getUser(uid, true);
    if (!u) fail(403, 'Conta sem perfil de jogador. Crie a conta pelo site.');
    if (u.blocked) fail(403, 'Esta conta está bloqueada. Contacte o suporte.');
    authState.delete(uid);
    await startSession(ctx, uid);
    return { user: await meUser(uid) };
  },

  'POST /api/logout': async (ctx) => {
    if (ctx.token) { const h = sha256(ctx.token); sessCache.delete(h); await col.sessions().doc(h).delete().catch(() => {}); }
    ctx.setCookie(`${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    return { ok: true };
  },

  // "esqueci a senha": o Firebase envia o e-mail com o link para criar uma nova senha
  'POST /api/password-reset': async (ctx) => {
    rateLimit(ctx.ip, 'reset', 5, 60 * 60000);
    const em = String(ctx.body.email || '').trim().toLowerCase();
    if (!validEmail(em)) fail(400, 'E-mail inválido.');
    try { await sendPasswordReset(em); }
    catch (e) { if (!['EMAIL_NOT_FOUND', 'INVALID_EMAIL'].includes(e.authCode)) console.error('[Firebase] Erro ao enviar redefinição de senha:', e.message); }
    return { ok: true }; // mesma resposta exista ou não a conta
  },

  'GET /api/me': (ctx) => ({
    user: ctx.user ? publicUser(ctx.user) : null,
    liveDelays: LIVE_DELAYS, // segundos de espera ao vivo por modalidade (aposta e cash out)
    payments: BP.enabled ? { live: true, depositMin: DEP_MIN / 100, depositMax: DEP_MAX / 100, withdrawMin: WD_MIN / 100, withdrawEta: SITE.withdrawEta } : { live: false },
    casino: CASINO || MINES || SLOTS, games: { decola: CASINO, mines: MINES, slots: SLOTS },
    slotsGames: SLOTS ? SLOTS_GAMES : [],
    casinoCert: CASINO ? CASINO_CERT || null : null, minesCert: MINES ? MINES_CERT || null : null, testMode: EMULATOR,
  }),

  'POST /api/account/verify-email': async (ctx) => {
    const u = requireUser(ctx);
    if (u.emailVerified) return { user: publicUser(u) };
    rateLimit(u.id, 'verify', 3, 60 * 60000);
    try { await sendEmailVerification(u.id); }
    catch (e) { console.error('[Firebase] Erro ao enviar confirmação de e-mail:', e.message); fail(503, 'Não foi possível enviar o e-mail agora. Tente mais tarde.'); }
    return { ok: true, user: publicUser(u) };
  },

  // o jogador carregou "já confirmei": consulta o Firebase na hora
  'POST /api/account/verify-check': async (ctx) => {
    const u = requireUser(ctx);
    rateLimit(u.id, 'vcheck', 20, 10 * 60000);
    await authInfo(u.id, true);
    return { user: await meUser(u.id) };
  },

  'GET /api/transactions': async (ctx) => {
    const u = requireUser(ctx);
    const qs = await col.txs(u.id).orderBy('at', 'desc').limit(100).get();
    return { tx: qs.docs.map((d) => { const t = d.data(); return { type: t.type, amount: fromCents(t.amount), ref: t.ref, at: t.at, status: t.status || null, note: t.note || null }; }) };
  },

  'GET /api/bets': async (ctx) => {
    const u = requireUser(ctx);
    let c = betsCache.get(u.id);
    if (!c || now() - c.at > 60000) {
      const qs = await col.bets(u.id).orderBy('placedAt', 'desc').limit(200).get();
      c = { list: qs.docs.map((d) => publicBet(d.data())), at: now() };
      betsCache.set(u.id, c);
    }
    return { bets: c.list };
  },

  'POST /api/deposit': async (ctx) => {
    const u = requireUser(ctx);
    if (isExcluded(u)) fail(403, pausedMsg(u));
    const amt = toCents(ctx.body.amount);
    if (!(amt >= DEP_MIN && amt <= DEP_MAX)) fail(400, `Valor entre ${brl(DEP_MIN)} e ${brl(DEP_MAX)}.`);
    const userRef = col.user(u.id);
    if (!BP.enabled) fail(503, 'Pagamentos temporariamente indisponíveis. Tente de novo em instantes.');
    rateLimit(u.id, 'dep', 10, 60 * 60000);
    const id = payId('D');
    const cpf = await runTx([u.id], async (t) => {
      const fu = (await t.get(userRef)).data();
      if (isExcluded(fu)) fail(403, pausedMsg(fu));
      let c = fu.cpf;
      if (!c) {
        c = validCpf(ctx.body.cpf);
        if (!c) fail(400, 'Informe um CPF válido. Ele precisa ser o do titular da conta.');
        const cs = await t.get(col.cpfs().doc(c));
        if (cs.exists && cs.data().uid !== u.id) fail(409, 'Este CPF já está ligado a outra conta.');
      }
      const log = depositWindow(fu.depositLog);
      checkDepositLimit(fu, log, amt);
      if (log.filter((e) => e.st === 'P' && e.until > now()).length >= 3) fail(429, 'Já tem 3 PIX por pagar. Pague um deles ou espere que expirem.');
      if (!fu.cpf) t.set(col.cpfs().doc(c), { uid: u.id, at: now() });
      t.update(userRef, { cpf: c, depositLog: [...log, { id, amount: amt, at: now(), st: 'P', until: now() + PIX_EXPIRES * 1000 }] });
      t.create(col.deposits().doc(id), { id, userId: u.id, userName: fu.name, userEmail: fu.email, amount: amt, status: 'CREATING', bpId: null, createdAt: now(), method: 'pix' });
      return c;
    });
    let bt;
    try {
      bt = await BP.createPix({
        amount_cents: amt, expires_in: PIX_EXPIRES, external_reference: id, description: `Depósito ${SITE.name}`,
        customer: { name: u.name, email: u.email, cpf }, metadata: { user_id: u.id, deposit_id: id },
      }, id);
      if (!bt?.id || !bt.pix?.copy_paste) throw new Error('resposta sem PIX');
    } catch (e) {
      console.error(`[BravoPay] Erro a criar PIX (${e.status ?? '-'} ${e.code ?? ''}):`, e.message, e.details ? JSON.stringify(e.details) : '');
      await runTx([u.id], async (t) => {
        const fu = (await t.get(userRef)).data();
        t.update(userRef, { depositLog: depositWindow(fu.depositLog).filter((x) => x.id !== id) });
        t.update(col.deposits().doc(id), { status: 'FAILED', failReason: String(e.code || e.message).slice(0, 200) });
      });
      fail(502, 'Não foi possível gerar o PIX agora. Tente de novo em instantes.');
    }
    const dep = {
      id, userId: u.id, amount: amt, status: 'PENDING', bpId: String(bt.id), pixCode: bt.pix.copy_paste, pixQr: bt.pix.qr_code || null,
      expiresAt: isoMs(bt.pix.expires_at) || now() + PIX_EXPIRES * 1000, createdAt: now(),
    };
    /* A BravoPay pode devolver uma cobrança que já existe (mesmo CPF e valor, ainda por pagar).
       Nesse caso não se cria outro depósito ligado à mesma cobrança: mostra-se o PIX que já existe. */
    const existing = await runTx([u.id], async (t) => {
      const sib = (await t.get(col.deposits().where('bpId', '==', dep.bpId))).docs.map((d) => d.data()).filter((d) => d.id !== id);
      if (!sib.length) {
        t.update(col.deposits().doc(id), { status: dep.status, bpId: dep.bpId, pixCode: dep.pixCode, pixQr: dep.pixQr, expiresAt: dep.expiresAt, fee: bt.fee_cents ?? null });
        return null;
      }
      const fu = (await t.get(userRef)).data();
      t.update(userRef, { depositLog: depositWindow(fu.depositLog).filter((x) => x.id !== id) });
      t.update(col.deposits().doc(id), { status: 'DUPLICATE', bpId: dep.bpId, note: `mesma cobrança BravoPay do depósito ${sib[0].id}` });
      return sib.find((d) => d.status === 'PENDING' && d.userId === u.id) || sib[0];
    });
    if (existing) {
      console.warn(`[BravoPay] PIX ${id}: a BravoPay devolveu a cobrança ${dep.bpId}, já usada pelo depósito ${existing.id}. Ficou DUPLICATE.`);
      if (existing.status === 'PENDING' && existing.userId === u.id) return { deposit: publicDeposit(existing), user: await meUser(u.id) };
      fail(502, 'Não foi possível gerar o PIX agora. Tente de novo em instantes.');
    }
    pendingDeposits.set(id, dep); depChecked.set(id, now());
    console.log(`[BravoPay] PIX gerado ${id}: ${brl(amt)} (user ${u.id})`);
    return { deposit: publicDeposit(dep), user: await meUser(u.id) };
  },

  // o navegador consulta enquanto o QR Code está aberto
  'GET /api/deposit': async (ctx) => {
    const u = requireUser(ctx);
    const id = String(new URL(ctx.req.url, 'http://x').searchParams.get('id') || '');
    if (!/^D[0-9A-F]{12}$/.test(id)) fail(404, 'Depósito não encontrado.');
    let d = pendingDeposits.get(id);
    if (d && d.userId === u.id && now() - (depChecked.get(id) || 0) > 5000) { await syncDeposit(d); d = null; }
    if (!d) { const s = await col.deposits().doc(id).get(); d = s.exists ? s.data() : null; }
    if (!d || d.userId !== u.id) fail(404, 'Depósito não encontrado.');
    return { deposit: publicDeposit(d), user: publicUser(await getUser(u.id, d.status !== 'PENDING')) };
  },

  /* Pedido de saque: o valor sai do saldo e fica reservado. A equipa paga o PIX
     manualmente e marca como pago no painel /admin (ou recusa, e o valor volta). */
  'POST /api/withdraw': async (ctx) => {
    const u = requireUser(ctx);
    const amt = toCents(ctx.body.amount);
    const userRef = col.user(u.id);
    if (!BP.enabled) fail(503, 'Pagamentos temporariamente indisponíveis. Tente de novo em instantes.');
    if (!(amt >= WD_MIN)) fail(400, `Saque mínimo: ${brl(WD_MIN)}.`);
    if (!u.cpf) fail(400, 'Faça um depósito por PIX antes de sacar (o CPF da conta fica registado no primeiro depósito).');
    const a = await authInfo(u.id, true);
    if (!a.emailVerified) fail(403, 'Confirme o seu e-mail antes de sacar. Enviámos um link para ' + u.email + '.');
    rateLimit(u.id, 'wd', 5, 60 * 60000);
    const id = payId('W');
    const wd = await runTx([u.id], async (t) => {
      const fu = (await t.get(userRef)).data();
      if (fu.blocked) fail(403, 'Conta bloqueada.');
      if (!fu.cpf) fail(400, 'CPF não registado.');
      if (amt > fu.balance) fail(400, 'Saldo insuficiente.');
      const w = {
        id, userId: u.id, userName: fu.name, userEmail: fu.email, amount: amt, status: 'PENDING',
        pixKey: fu.cpf, pixKeyType: 'cpf', createdAt: now(), updatedAt: now(), handledBy: null, note: null, ip: ctx.ip || null,
      };
      t.update(userRef, { balance: inc(-amt) });
      t.create(col.withdrawals().doc(id), w);
      addTx(t, u.id, 'Saque PIX', -amt, id, { id, status: 'PENDING' });
      return w;
    });
    openWithdrawals.set(id, wd);
    console.log(`[Saque] Novo pedido ${id}: ${brl(amt)} de ${u.name} (${u.email}). Pague no painel /admin.`);
    return { withdrawal: { id, amount: fromCents(amt), status: 'PENDING' }, user: await meUser(u.id) };
  },

  // o jogador desiste de um pedido que a equipa ainda não começou a tratar
  'POST /api/withdraw/cancel': async (ctx) => {
    const u = requireUser(ctx);
    const id = String(ctx.body.id || '');
    if (!/^W[0-9A-F]{12}$/.test(id)) fail(404, 'Saque não encontrado.');
    await runTx([u.id], async (t) => {
      const ref = col.withdrawals().doc(id);
      const s = await t.get(ref);
      if (!s.exists || s.data().userId !== u.id) fail(404, 'Saque não encontrado.');
      const w = s.data();
      if (w.status !== 'PENDING') fail(409, w.status === 'PROCESSING' ? 'A equipa já está a processar este saque. Contacte o suporte.' : 'Este saque já foi concluído.');
      t.update(ref, { status: 'CANCELED', updatedAt: now(), note: 'cancelado pelo jogador' });
      t.set(col.txs(u.id).doc(id), { status: 'CANCELED' }, { merge: true });
      t.update(col.user(u.id), { balance: inc(w.amount) });
      addTx(t, u.id, 'Saque cancelado', w.amount, id);
    });
    openWithdrawals.delete(id);
    return { user: await meUser(u.id) };
  },

  'POST /api/bets': async (ctx) => {
    const u = requireUser(ctx);
    if (isExcluded(u)) fail(403, pausedMsg(u));
    const { tickets, acceptAny } = ctx.body;
    if (!Array.isArray(tickets) || !tickets.length || tickets.length > 20) fail(400, 'Boletim inválido.');
    // validação inicial
    const parsed = tickets.map((tk) => {
      if (!Array.isArray(tk.keys) || !tk.keys.length || tk.keys.length > 20) fail(400, 'Boletim inválido.');
      const stake = toCents(tk.stake);
      if (!(stake >= 100)) fail(400, 'Valor mínimo por aposta: R$ 1,00.');
      const keys = tk.keys.map(String);
      if (new Set(keys).size !== keys.length) fail(400, 'Boletim inválido.');
      // várias seleções do mesmo jogo: só como Criar aposta (a odd do grupo é calculada mais abaixo)
      const byEv = new Map();
      for (const k of keys) { const e = k.split('|')[0]; byEv.set(e, [...(byEv.get(e) || []), k]); }
      for (const ks of byEv.values()) if (ks.length > BB.MAX_LEGS) fail(400, `Criar aposta: máximo de ${BB.MAX_LEGS} seleções por jogo.`);
      const bbSeen = tk.bb && typeof tk.bb === 'object' ? tk.bb : {};
      return { keys, seen: Array.isArray(tk.odds) ? tk.odds : [], stake, byEv, bbSeen };
    });
    // apostas com alguma seleção suspensa: recusadas uma a uma (as outras do boletim seguem); todas suspensas → erro
    const preRejected = new Map(); // índice → motivo
    parsed.forEach((tk, i) => {
      for (const k of tk.keys) {
        const { ev, sel } = findSel(k);
        if (!sel || sel.locked || M.isSuspended(ev)) { preRejected.set(i, `mercado suspenso${sel?.name ? ` (${sel.name})` : ''}`); return; }
      }
    });
    if (preRejected.size === parsed.length) fail(409, parsed.length > 1 ? 'As seleções estão suspensas. Tente de novo em instantes.' : 'Uma das seleções está suspensa. Remova-a do boletim.');
    const total = parsed.reduce((a, tk, i) => a + (preRejected.has(i) ? 0 : tk.stake), 0);
    if (total > u.balance) fail(400, 'Saldo insuficiente. Faça um depósito.');
    let live = false;
    parsed.forEach((tk, i) => { if (!preRejected.has(i)) for (const k of tk.keys) if (findSel(k).ev?.state === 'in') live = true; });
    if (userLocks.has(u.id)) fail(429, 'Aguarde a confirmação da aposta anterior.');
    userLocks.add(u.id);
    try {
      // atraso de aceitação (como as casas reais fazem, sobretudo ao vivo) e revalidação
      const t0 = now();
      const liveIds = new Set(parsed.flatMap((tk, i) => (preRejected.has(i) ? [] : tk.keys.map((k) => String(k).split('|')[0]))));
      const snap = liveSnapshot(liveIds);
      await sleep(live ? liveDelayMs([...snap.keys()].map((id) => events.get(id)?.sport)) : PRE_DELAY_MS);
      if (snap.size) await refreshLiveNow(snap.keys()); // placar mais recente antes de decidir
      let liveReason = liveChanged(snap, t0);
      /* tênis de mesa e basquete: a MoviOdds só volta a ler a bet365 a cada ~10 s (medido em 29/10: 2 a 16 s no tênis de
         mesa), e um ponto/cesta decide mercados em segundos. A aposta só entra com odds lidas DEPOIS do pedido (espera até
         20 s); sem leitura nova é recusada. Assim quem vê o jogo à frente não apanha odds de antes do ponto. */
      const fresh = [...snap.keys()].filter((id) => FRESH_SPORTS.has(events.get(id)?.sport));
      if (!liveReason && fresh.length) {
        const t0src = FEED.srcNow() - (now() - t0); // o pedido, no relógio da fonte
        const ok = () => fresh.every((id) => (FEED.polledAt(id) || 0) > t0src);
        for (let w = 0; !ok() && w < 40; w++) await sleep(500);
        if (!ok()) liveReason = 'odds por confirmar: a fonte não atualizou a partida a tempo';
        else { await refreshLiveNow(snap.keys()); liveReason = liveChanged(snap, t0); }
      }
      const placed = [], rejected = [];
      for (let i = 0; i < parsed.length; i++) {
        const tk = parsed[i];
        const legs = [];
        let reason = null;
        if (preRejected.has(i)) { rejected.push({ index: i, reason: preRejected.get(i) }); continue; }
        if (liveReason && tk.keys.some((k) => snap.has(String(k).split('|')[0]))) { rejected.push({ index: i, reason: liveReason }); continue; }
        // Criar aposta: odd de cada grupo de seleções do mesmo jogo (recalculada agora, no servidor)
        const bbq = {};
        for (const [evId, ks] of tk.byEv) {
          if (ks.length < 2) continue;
          const q = bbQuote(ks, events.get(evId)?.state === 'in' ? 2000 : undefined);
          if (q.reason) { reason = q.reason; break; }
          if (!acceptAny && tk.bbSeen[evId] != null && Number(tk.bbSeen[evId]) !== q.odds) { reason = 'odds alteradas'; break; }
          bbq[evId] = q;
        }
        if (reason) { rejected.push({ index: i, reason }); continue; }
        for (let j = 0; j < tk.keys.length; j++) {
          const { ev, sel } = findSel(tk.keys[j]);
          if (!sel || sel.locked || M.isSuspended(ev)) { reason = 'mercado suspenso'; break; }
          const grp = bbq[ev.id];
          if (!grp && !acceptAny && tk.seen[j] != null && Number(tk.seen[j]) !== sel.odds) { reason = 'odds alteradas'; break; }
          if (sel.maxStake && tk.stake > sel.maxStake) { reason = `aposta máxima no mercado "${sel.marketName}": ${brl(sel.maxStake)}`; break; }
          legs.push({
            key: sel.key, evId: ev.id, feed: ev.manual ? 'equipa' : 'moviodds', league: ev.league, sport: ev.sport, market: sel.market, pick: sel.pick, line: sel.line ?? null, base: sel.base ?? null, per: sel.per ?? null,
            name: sel.name, marketName: sel.marketName, event: M.evLabel(ev), leagueName: ev.leagueName,
            startsAt: +ev.date, liveAtPlacement: ev.state === 'in' ? `${ev.clock} (${ev.home.score}-${ev.away.score})` : null, odds: sel.odds, result: null,
            ...(grp ? { bb: ev.id, src: BB.srcOf(grp.items.find((x) => x.key === sel.key).q) } : {}),
          });
        }
        if (reason) { rejected.push({ index: i, reason }); continue; }
        // odd total: seleções soltas × odd de cada Criar aposta
        const odds = M.round2(legs.filter((l) => !l.bb).reduce((p, l) => p * l.odds, 1) * Object.values(bbq).reduce((p, g) => p * g.odds, 1));
        const potential = Math.round(tk.stake * odds);
        if (potential > MAX_WIN) { rejected.push({ index: i, reason: 'prêmio máximo de R$ 500.000 excedido' }); continue; }
        if (legs.some((l) => String(l.league).startsWith('fut.'))) {
          if (tk.stake > MINOR_MAX_STAKE) { rejected.push({ index: i, reason: `aposta máxima nesta competição: ${brl(MINOR_MAX_STAKE)}` }); continue; }
          if (potential > MINOR_MAX_WIN) { rejected.push({ index: i, reason: `prêmio máximo nesta competição: ${brl(MINOR_MAX_WIN)}` }); continue; }
        }
        // mercados liquidados pela equipa: limites mais baixos (dependem de uma pessoa confirmar o resultado)
        if (legs.some((l) => l.market === 'x')) {
          if (tk.stake > MANUAL_MAX_STAKE) { rejected.push({ index: i, reason: `aposta máxima neste mercado: ${brl(MANUAL_MAX_STAKE)}` }); continue; }
          if (potential > MANUAL_MAX_WIN) { rejected.push({ index: i, reason: `prêmio máximo neste mercado: ${brl(MANUAL_MAX_WIN)}` }); continue; }
        }
        const id = betId();
        const bet = {
          id, userId: u.id, type: legs.length > 1 ? 'multiple' : 'single', stake: tk.stake, odds, potential,
          status: 'open', payout: null, placedAt: now(), settledAt: null, legs,
          // Criar aposta: odd de cada grupo e os números do modelo (para refazer a conta se uma seleção for anulada)
          ...(Object.keys(bbq).length ? { bb: Object.fromEntries(Object.entries(bbq).map(([k, g]) => [k, { odds: g.odds, params: g.params }])) } : {}),
        };
        try {
          await runTx([u.id], async (t) => {
            const fu = (await t.get(col.user(u.id))).data();
            if (fu.blocked) fail(403, 'conta bloqueada');
            if (isExcluded(fu)) fail(403, 'conta em pausa');
            if (tk.stake > fu.balance) fail(400, 'saldo insuficiente');
            const loss = lossStats(fu);
            const ld = effLimit(fu, 'lossLimitDay'), lm = effLimit(fu, 'lossLimitMonth');
            if (ld != null && loss.day + tk.stake > ld) fail(400, `limite de perda diário (restam ${brl(Math.max(0, ld - loss.day))})`);
            if (lm != null && loss.month + tk.stake > lm) fail(400, `limite de perda mensal (restam ${brl(Math.max(0, lm - loss.month))})`);
            // regista o apostado do dia (e apaga dias com mais de 40 dias)
            const k = dayKey(), oldest = dayKey(now() - 40 * DAY);
            const daily = Object.fromEntries(Object.entries(fu.daily || {}).filter(([key]) => key >= oldest));
            daily[k] = { staked: (daily[k]?.staked || 0) + tk.stake, returned: daily[k]?.returned || 0 };
            t.create(col.bets(u.id).doc(id), bet);
            t.create(col.openBets().doc(id), bet);
            t.update(col.user(u.id), { balance: inc(-tk.stake), daily });
            addTx(t, u.id, 'Aposta', -tk.stake, id);
          });
          openBets.set(id, bet);
          placed.push({ index: i, bet: publicBet(bet) });
          if (live) LW.watch(bet, u); // revista 20 s e 45 s depois (gol logo a seguir / odd a cair)
        } catch (e) {
          if (!(e instanceof HttpError)) console.error('Erro ao gravar aposta:', e.message);
          rejected.push({ index: i, reason: e instanceof HttpError ? e.message : 'erro ao gravar a aposta' });
        }
      }
      return { placed, rejected, user: await meUser(u.id) };
    } finally { userLocks.delete(u.id); }
  },
  

  // Criar aposta: odd de cada grupo de seleções do mesmo jogo (o boletim pede quando muda)
  'POST /api/betbuilder/price': (ctx) => {
    rateLimit(ctx.ip, 'bb', 240, 60000);
    const groups = ctx.body.groups;
    if (!Array.isArray(groups) || !groups.length || groups.length > 10) fail(400, 'Pedido inválido.');
    return {
      groups: groups.map((ks) => {
        if (!Array.isArray(ks) || ks.length < 2 || ks.length > 20) return { reason: 'escolha pelo menos 2 seleções' };
        const keys = ks.map(String);
        if (new Set(keys.map((k) => k.split('|')[0])).size !== 1) return { reason: 'seleções de jogos diferentes' };
        const q = bbQuote(keys);
        return q.reason ? { reason: q.reason, bad: q.bad || null } : { odds: q.odds };
      }),
    };
  },

  // aba Criar aposta: a odd de cada seleção do jogo já somada às escolhidas (como na bet365)
  'GET /api/betbuilder/model': (ctx) => {
    rateLimit(ctx.ip, 'bbm', 60, 60000);
    return bbModel(String(new URL(ctx.req.url, 'http://x').searchParams.get('ev') || ''));
  },
  'POST /api/betbuilder/preview': (ctx) => {
    rateLimit(ctx.ip, 'bbp', 240, 60000);
    const ks = ctx.body.keys;
    if (!Array.isArray(ks) || !ks.length || ks.length > 20) fail(400, 'Pedido inválido.');
    const keys = ks.map(String);
    if (new Set(keys.map((k) => k.split('|')[0])).size !== 1) fail(400, 'Seleções de jogos diferentes.');
    return bbPreview(keys);
  },

  'POST /api/cashout': async (ctx) => {
    const u = requireUser(ctx);
    const id = String(ctx.body.id || '');
    if (!/^[0-9A-Z]{8,16}$/.test(id)) fail(404, 'Aposta não encontrada.');
    const s = await col.bets(u.id).doc(id).get();
    if (!s.exists) fail(404, 'Aposta não encontrada.');
    if (s.data().status !== 'open') fail(409, 'Esta aposta já foi encerrada.');
    if (s.data().bb) fail(409, 'Cash Out indisponível em apostas com Criar aposta.');
    if (!M.cashoutFactor(publicBet(s.data()), findSel)) fail(409, 'Cash Out indisponível no momento.');
    // ao vivo: mesma proteção das apostas (espera, placar novo, recusa se houve gol)
    const t0 = now();
    const snap = liveSnapshot(new Set(s.data().legs.filter((l) => !l.result).map((l) => l.evId)));
    await sleep(snap.size ? liveDelayMs([...snap.keys()].map((sid) => events.get(sid)?.sport)) : CASHOUT_DELAY_MS);
    if (snap.size) {
      await refreshLiveNow(snap.keys());
      const why = liveChanged(snap, t0);
      if (why) fail(409, `Cash Out recusado: ${why}.`);
    }
    let value = 0;
    await runTx([u.id], async (t) => {
      const ref = col.openBets().doc(id);
      const os = await t.get(ref);
      if (!os.exists) fail(409, 'Esta aposta já foi encerrada.');
      const fresh = os.data();
      const f = M.cashoutFactor(publicBet(fresh), findSel);
      if (!f) fail(409, 'Cash Out recusado: mercado suspenso.');
      value = Math.floor(fresh.stake * f);
      if (value < 10) fail(409, 'Cash Out indisponível no momento.');
      t.delete(ref);
      t.update(col.bets(u.id).doc(id), { status: 'cashout', payout: value, settledAt: now() });
      t.update(col.user(u.id), { balance: inc(value), [`daily.${dayKey()}.returned`]: inc(value) });
      addTx(t, u.id, 'Cash Out', value, id);
    });
    const cashLegs = openBets.get(id)?.legs;
    openBets.delete(id);
    // cash out: as seleções que faltam continuam a ser marcadas (só para mostrar o resultado de cada uma)
    if (cashLegs?.some((l) => !l.result)) addTrail({ id, userId: u.id, legs: cashLegs, at: now() }).catch((e) => console.error('[Seleções por marcar]', e.message));
    return { value: fromCents(value), user: await meUser(u.id) };
  },

  'POST /api/account/password': async (ctx) => {
    const u = requireUser(ctx);
    rateLimit(ctx.ip, 'pw', 10, 10 * 60000);
    try { await verifyPassword(u.email, String(ctx.body.current || '')); }
    catch (e) { if (LOGIN_BAD.has(e.authCode)) fail(400, 'Senha atual incorreta.'); throw e; }
    const pw = String(ctx.body.next || '');
    if (!validPassword(pw)) fail(400, 'A nova senha precisa de pelo menos 8 caracteres, com letras e números.');
    await auth.updateUser(u.id, { password: pw });
    authState.delete(u.id);
    // termina TODAS as sessões e abre uma nova neste aparelho
    await endSessions(u.id, null);
    await sleep(1100); // o Firebase guarda a hora da troca ao segundo
    await startSession(ctx, u.id);
    return { ok: true };
  },

  // limites de jogo responsável (um de cada vez)
  'POST /api/account/limits': async (ctx) => {
    const u = requireUser(ctx);
    const key = String(ctx.body.key || '');
    if (!LIMIT_KEYS.includes(key)) fail(400, 'Limite inválido.');
    const v = ctx.body.value;
    const cents = v == null || v === '' ? null : toCents(v);
    if (cents != null && !(cents >= 1000 && cents <= 100000000)) fail(400, 'Limite entre R$ 10 e R$ 1.000.000.');
    let scheduled = false;
    await runTx([u.id], async (t) => {
      const ref = col.user(u.id);
      const fu = (await t.get(ref)).data();
      const pend = { ...(fu.pendingLimits || {}) };
      let cur = fu[key] ?? null;
      if (pend[key] && pend[key].at <= now()) { cur = pend[key].value ?? null; }
      delete pend[key];
      let next = cur;
      if (cents != null && (cur == null || cents <= cur)) next = cents; // mais apertado: vale já
      else if (cents !== cur) { pend[key] = { value: cents, at: now() + DAY }; scheduled = true; } // mais folgado: só daqui a 24h
      t.update(ref, { [key]: next, pendingLimits: pend });
    });
    return { scheduled, user: await meUser(u.id) };
  },

  // pausa / autoexclusão: não pode ser desfeita antes do fim
  'POST /api/account/pause': async (ctx) => {
    const u = requireUser(ctx);
    const days = Number(ctx.body.days);
    if (![1, 7, 30, 90, 180, 365, 1825].includes(days)) fail(400, 'Período inválido.');
    if (ctx.body.confirm !== true) fail(400, 'Confirme a pausa.');
    const until = Math.max(u.excludedUntil || 0, now() + days * DAY);
    await col.user(u.id).update({ excludedUntil: until, excludedAt: now(), excludedDays: days });
    dirty(u.id);
    console.log(`[Jogo responsável] ${u.email} pausou a conta por ${days} dias.`);
    return { user: await meUser(u.id) };
  },

  'POST /api/account/prefs': async (ctx) => {
    const u = requireUser(ctx);
    const patch = {};
    if ('acceptAny' in ctx.body) patch.acceptAny = !!ctx.body.acceptAny;
    if ('realityCheck' in ctx.body) {
      const m = Number(ctx.body.realityCheck);
      if (![0, 15, 30, 60, 120].includes(m)) fail(400, 'Intervalo inválido.');
      patch.realityCheck = m;
    }
    if (Object.keys(patch).length) { await col.user(u.id).update(patch); dirty(u.id); }
    return { user: await meUser(u.id) };
  },
};

/* ---------------- Slots PG Soft — carteira seamless ----------------
   O jogo corre num serviço à parte (api-pgsoft-node). Este bloco é a "carteira":
   o jogo pergunta o saldo e comunica cada rodada; o Firestore é a única fonte de verdade.
   Vale para TODOS os jogos da lista: o saldo e as apostas são comuns a todos. */
const PGS_BASE = String(process.env.PGSOFT_API_URL || '').replace(/\/$/, '');
const PGS_AGENT = String(process.env.PGSOFT_AGENT_TOKEN || '');
const PGS_SECRET = String(process.env.PGSOFT_SECRET || '');
const SLOTS = !!(PGS_BASE && PGS_AGENT && PGS_SECRET);

// jogos disponíveis (o código tem de existir no serviço dos jogos)
const SLOTS_GAMES_MAP = {
  'fortune-tiger': 'Fortune Tiger',
  'fortune-ox': 'Fortune Ox',
  'fortune-dragon': 'Fortune Dragon',
  'fortune-rabbit': 'Fortune Rabbit',
  'fortune-mouse': 'Fortune Mouse',
  'bikini-paradise': 'Bikini Paradise',
  'jungle-delight': 'Jungle Delight',
  'ganesha-gold': 'Ganesha Gold',
  'double-fortune': 'Double Fortune',
  'dragon-tiger-luck': 'Dragon Tiger Luck',
  'ninja-raccoon': 'Ninja Raccoon Frenzy',
  'lucky-clover': 'Lucky Clover Lady',
  'ultimate-striker': 'Ultimate Striker',
  'prosper-ftree': 'Prosperity Fortune Tree',
  'chicky-run': 'Chicky Run',
  'butterfly-blossom': 'Butterfly Blossom',
  'piggy-gold': 'Piggy Gold',
  'wild-bandito': 'Wild Bandito',
  'zombie-outbreak': 'Zombie Outbreak',
  'majestic-ts': 'Majestic Treasures',
  'thai-river': 'Thai River Wonders',
  'gdn-ice-fire': 'Guardians of Ice & Fire',
  'rise-apollo': 'Rise of Apollo',
  'wild-bounty-sd': 'Wild Bounty Showdown',
  'treasures-aztec': 'Treasures of Aztec',
  'three-cz-pigs': 'Three Crazy Piggies',
};
// provisório: só estes slots podem ser abertos (os restantes estão indisponíveis)
const SLOTS_ENABLED = new Set(['fortune-tiger', 'fortune-ox']);
const SLOTS_GAMES = Object.keys(SLOTS_GAMES_MAP).filter((g) => SLOTS_ENABLED.has(g));
const slotName = (code) => SLOTS_GAMES_MAP[code] || 'Slot';

// 1) O jogo pergunta o saldo (antes de cada rodada)
routes['POST /api/pgsoft/gold_api/user_balance'] = async (ctx) => {
  const code = String(ctx.body.user_code || '');
  const u = await getUser(code, true);
  if (!u || u.blocked) return { msg: 'INVALID_USER' };
  return { msg: 'SUCCESS', user_balance: fromCents(u.balance), currency: 'BRL' };
};

// só o serviço dos slots conhece o PGSOFT_SECRET: ele envia-o como agent_secret em cada rodada
const PGS_SECRET_HASH = crypto.createHash('sha256').update(PGS_SECRET).digest();
const isSlotsService = (secret) => !!PGS_SECRET && typeof secret === 'string'
  && crypto.timingSafeEqual(crypto.createHash('sha256').update(secret).digest(), PGS_SECRET_HASH);

// 2) O jogo comunica o resultado da rodada (débito/crédito). Idempotente por txn_id.
routes['POST /api/pgsoft/gold_api/game_callback'] = async (ctx) => {
  const b = ctx.body || {};
  // sem a chave do serviço dos slots ninguém mexe no saldo (impede créditos forjados pelo navegador)
  if (!isSlotsService(b.agent_secret)) {
    console.warn(`[Slots] Rodada recusada: chave inválida (ip ${ctx.ip}, utilizador ${String(b.user_code || '?').slice(0, 64)})`);
    fail(403, 'Não autorizado.');
  }
  const s = b.slot || {};
  const uid = String(b.user_code || '');
  const txnId = String(s.txn_id || '') || payId('T');
  const bet = toCents(s.bet || 0);
  const win = toCents(s.win || 0);
  if (!(bet >= 0) || !(win >= 0)) fail(400, 'Valores inválidos.');

  const txRef = db.collection('pgsoftTxns').doc(txnId);
  if ((await txRef.get()).exists) { // já processámos esta rodada
    const cur = await getUser(uid, true);
    return { status: 1, msg: 'SUCCESS', user_balance: cur ? fromCents(cur.balance) : 0 };
  }

  let novo = 0;
  await runTx([uid], async (t) => {
    const ref = col.user(uid);
    const fu = (await t.get(ref)).data();
    if (!fu) fail(400, 'Utilizador inexistente.');
    novo = Math.max(0, fu.balance + win - bet);
    t.set(txRef, { uid, bet, win, delta: win - bet, game: s.game_code || null, at: now() });
    t.update(ref, { balance: novo });
    if (bet) addTx(t, uid, `${slotName(s.game_code)}: aposta`, -bet, txnId);
    if (win) addTx(t, uid, `${slotName(s.game_code)}: prémio`, win, txnId);
  });
  return { status: 1, msg: 'SUCCESS', user_balance: fromCents(novo) };
};

// 3) O site chama isto para abrir o jogo escolhido
routes['POST /api/slots/launch'] = async (ctx) => {
  const u = requireUser(ctx);
  if (!SLOTS) fail(503, 'Jogos de slots indisponíveis de momento.');
  const game = String((ctx.body && ctx.body.game) || 'fortune-tiger');
  if (!SLOTS_GAMES_MAP[game]) fail(400, 'Jogo desconhecido.');
  if (!SLOTS_ENABLED.has(game)) fail(403, 'Este jogo está indisponível no momento.');
  const me = await getUser(u.id, true);
  let j = null;
  try {
    const r = await fetch(`${PGS_BASE}/api/v1/game_launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentToken: PGS_AGENT, secretKey: PGS_SECRET,
        user_code: u.id, game_type: 'slot', provider_code: 'PGSOFT',
        game_code: game, user_balance: fromCents(me.balance),
      }),
      signal: AbortSignal.timeout(10000),
    });
    j = await r.json();
  } catch { fail(502, 'Servidor dos jogos não respondeu.'); }
  if (!j || j.status !== 1) fail(502, (j && j.message) || 'Não foi possível abrir o jogo.');
  return { url: j.launch_url };
};

// painel da equipa (/admin)
const ADM = require('./admin.js')(routes, {
  liveAlerts: (days) => LW.list(days),
  db, col, auth, FieldValue, runTx, addTx, getUser, dirty, fail, now, brl, fromCents, toCents, dayStart, dayKey, DAY,
  requireUser, authInfo, authState, endSessions, openWithdrawals, pendingDeposits, depositWindow, ADMIN_EMAILS, BP, SITE,
  openBets, M, eventInfo: (id) => events.get(id) || null, feedName: FEED.name, settle: settleQueued, feedInfo: () => feedInfo(), betFactor,
});
// painel → "Esportes e mercados": modalidades, campeonatos, eventos e mercados da equipa (odds automáticas por rounds)
require('./catalog.js')(routes, {
  col, runTx, fail, now, fromCents, toCents, M, requireAdmin: ADM.requireAdmin, log: ADM.log,
  events, openBets, catSports, catLeagues, manualEvents, manualMarkets, applyCatalog, settle: settleQueued,
});
// transmissão da partida servida pelo site (para o bot ler a imagem)
const STREAM = require('./streamsrc.js')(routes, { requireAdmin: ADM.requireAdmin, fail, manualEvents });
// bot da transmissão no servidor: lê o placar no vídeo do link da partida e administra o jogo sozinho
require('./streambot.js')(routes, { requireAdmin: ADM.requireAdmin, fail, manualEvents, variant: STREAM.variant, now });

/* Cassino (Decola e Mines)
   - Teste local: emuladores do Firebase + CASINO_TEST=1 (saldo de teste).
   - Produção (saldo real): CASINO_LIVE=1 e CASINO_CERT=<n.º do certificado do laboratório para esta versão do jogo>. */
const CASINO_CERT = String(process.env.CASINO_CERT || '').trim().slice(0, 80);
const CASINO = EMULATOR ? (!!process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.CASINO_TEST === '1')
  : (process.env.CASINO_LIVE === '1' && CASINO_CERT.length >= 3);
const crashGame = CASINO ? require('./crash.js')(routes, {
  db, runTx, addTx, col, inc, fail, now, brl, fromCents, toCents, requireUser, isExcluded, pausedMsg,
  lossStats, effLimit, dayKey, DAY, meUser, HttpError, EMULATOR, CASINO_CERT,
}) : null;
/* Mines tem chave própria (o certificado do Decola não cobre outro jogo):
   - Teste: igual ao cassino (emuladores + CASINO_TEST=1).
   - Produção: MINES_LIVE=1 e MINES_CERT=<n.º do certificado do Mines>. */
const MINES_CERT = String(process.env.MINES_CERT || '').trim().slice(0, 80);
const MINES = EMULATOR ? CASINO : (process.env.MINES_LIVE === '1' && MINES_CERT.length >= 3);
const minesGame = MINES ? require('./mines.js')(routes, {
  db, runTx, addTx, col, inc, fail, now, brl, fromCents, toCents, requireUser, isExcluded, pausedMsg,
  lossStats, effLimit, dayKey, DAY, meUser, HttpError, EMULATOR, CASINO_CERT: MINES_CERT,
}) : null;
if (EMULATOR) {
  // saldo de teste (só existe nos emuladores)
  routes['POST /api/dev/credit'] = async (ctx) => {
    const u = requireUser(ctx);
    await runTx([u.id], async (t) => {
      t.update(col.user(u.id), { balance: inc(100000) });
      addTx(t, u.id, 'Saldo de teste', 100000, null);
    });
    return { user: await meUser(u.id) };
  };
  /* testes (só nos emuladores): termina um jogo com o resultado dado e corre a liquidação
     corpo: { id, result: R } (R como em markets.js: { h, a, reg?, alts?, sets?, log?, aces?, dfs? }) */
  routes['POST /api/dev/finish'] = async (ctx) => {
    requireUser(ctx);
    const ev = events.get(String(ctx.body.id || ''));
    if (!ev) fail(404, 'Jogo não encontrado.');
    const R = ctx.body.result;
    if (!R || !Number.isFinite(R.h) || !Number.isFinite(R.a)) fail(400, 'Resultado inválido.');
    if (R.log && !R.pts) R.pts = POINTS.resolve(ev.id, R.log); // como num resultado real (checkResults)
    Object.assign(ev, { state: 'post', completed: true, awaiting: false, markets: null, clock: 'Encerrado', result: R, home: { ...ev.home, score: R.h }, away: { ...ev.away, score: R.a } });
    feedVersion++; feedCache = null; touch(ev.id);
    await settleQueued();
    return { ok: true };
  };
  // testes: liquida um mercado da equipa como se fosse no painel (sem precisar de conta de administrador)
  routes['POST /api/dev/settle-market'] = async (ctx) => {
    requireUser(ctx);
    return ADM.settleMarket(String(ctx.body.key || ''), ctx.body.results || {}, { email: 'teste@local', id: 'dev' }, 'teste automático');
  };
  routes['GET /api/dev/pending'] = async (ctx) => { requireUser(ctx); return { groups: ADM.pendingGroups() }; };
  // testes: suspende um jogo por N segundos (como depois de um gol)
  routes['POST /api/dev/suspend'] = async (ctx) => {
    requireUser(ctx);
    const ev = events.get(String(ctx.body.id || ''));
    if (!ev) fail(404, 'Jogo não encontrado.');
    ev.suspendedUntil = now() + (Number(ctx.body.seconds) || 30) * 1000;
    feedVersion++; feedCache = null;
    return { ok: true };
  };
}

/* ---------------- servidor HTTP ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const PAGES = { '/': '/index.html', '/admin': '/admin.html', '/termos': '/termos.html', '/privacidade': '/privacidade.html', '/jogo-responsavel': '/jogo-responsavel.html' };

function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
  if (/^\/(decola|mines)(\.html|\.js|\.css)?$/.test(p)) { if (p.startsWith('/mines') ? !MINES : !CASINO) { res.writeHead(404); res.end('Não encontrado'); return; } if (p === '/decola' || p === '/mines') p += '.html'; }
  // rotas do site (esportes, cassino, ao vivo...): todas abrem o index.html e o app.js mostra a secção certa
  if (/^\/(esportes|cassino|ao-vivo|minhas-apostas|todos|hoje|amanha|resultados)\/?$/.test(p) || /^\/(esporte|liga|evento)\/[^/]+\/?$/.test(p)) p = '/';
  p = PAGES[p] || p;
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep) || /app\.old\.js$/.test(file)) { res.writeHead(404); res.end('Não encontrado'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Não encontrado'); return; }
    // ficheiro guardado em memória (já comprimido) enquanto não mudar no disco
    let c = staticCache.get(file);
    if (!c || c.mtime !== st.mtimeMs) {
      let data;
      try { data = fs.readFileSync(file); } catch { res.writeHead(404); res.end('Não encontrado'); return; }
      const type = MIME[path.extname(file)] || 'application/octet-stream';
      const text = /^(text\/|application\/json|image\/svg)/.test(type);
      c = { data, type, mtime: st.mtimeMs, etag: `"${crypto.createHash('sha1').update(data).digest('base64url').slice(0, 16)}"`, gz: text && data.length > 1024 ? zlib.gzipSync(data, { level: 9 }) : null };
      staticCache.set(file, c);
    }
    // imagens: 1 dia no navegador; páginas, JS e CSS: o navegador confirma sempre (304 se não mudou)
    const h = { 'Content-Type': c.type, 'Cache-Control': c.type.startsWith('image/') && !c.type.includes('svg') ? 'public, max-age=86400' : 'no-cache', ETag: c.etag, Vary: 'Accept-Encoding' };
    if (p === '/admin.html') h['X-Robots-Tag'] = 'noindex, nofollow';
    if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, h); res.end(); return; }
    if (c.gz && acceptsGzip(req)) { res.writeHead(200, { ...h, 'Content-Encoding': 'gzip' }); res.end(c.gz); return; }
    res.writeHead(200, h);
    res.end(c.data);
  });
}
const staticCache = new Map();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 50000) { reject(new HttpError(413, 'Pedido muito grande.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}

// domínio principal; quando definido, os endereços antigos redirecionam para ele
const CANONICAL_HOST = String(process.env.CANONICAL_HOST || '').trim().toLowerCase();
const OLD_HOSTS = new Set(String(process.env.OLD_HOSTS || 'golaco-ac746.web.app,golaco-ac746.firebaseapp.com,golaco.web.app')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url, 'http://x');
  // endereços antigos (golaco-ac746.web.app...) → domínio novo; só páginas, nunca /api/ (webhooks e chamadas continuam a funcionar)
  if (CANONICAL_HOST && (req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
    const host = String((process.env.TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim().toLowerCase();
    if (OLD_HOSTS.has(host)) {
      res.writeHead(301, { Location: `https://${CANONICAL_HOST}${req.url}`, 'Cache-Control': 'public, max-age=3600' });
      return res.end();
    }
  }
  // emblemas da API-Football pelo nosso domínio (o media.api-sports.io é bloqueado no DNS de provedores brasileiros)
  const crest = (req.method === 'GET' || req.method === 'HEAD') && /^\/escudos\/(\d{1,7})\.png$/.exec(url.pathname);
  if (crest) return LOGOS.serveCrest(crest[1], res);
  if (url.pathname === '/bbengine.js') {
    const c = bbEngineFile(), h = { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', ETag: c.etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, h); return res.end(); }
    if (acceptsGzip(req)) { res.writeHead(200, { ...h, 'Content-Encoding': 'gzip' }); return res.end(c.gz); }
    res.writeHead(200, h); return res.end(c.data);
  }
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
  if (req.method === 'POST' && url.pathname === '/api/webhooks/bravopay') return handleWebhook(req, res);
  if (req.method === 'GET' && url.pathname === '/api/stream') { // odds ao vivo empurradas
    const origin = String(req.headers.origin || '');
    if (STREAM_ORIGINS.has(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin, Accept-Encoding'); }
    return handleStream(req, res);
  }

  const handler = routes[`${req.method} ${url.pathname}`];
  const cookies = [];
  const ctx = {
    // atrás de um proxy (Nginx, Cloudflare...) defina TRUST_PROXY=1 para usar o IP real do visitante
    req, res, ip: (process.env.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress,
    secure: req.headers['x-forwarded-proto'] === 'https',
    setCookie: (c) => cookies.push(c), token: parseCookies(req.headers.cookie)[COOKIE] || null, user: null, body: {},
  };
  try {
    if (!handler) fail(404, 'Rota inexistente.');
    // proteção básica contra pedidos de outros sites
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin) {
        // aceita o próprio endereço, o domínio original quando há proxy à frente (Firebase Hosting) e o SITE_URL
        const ok = new Set([req.headers.host]);
        if (process.env.TRUST_PROXY && req.headers['x-forwarded-host']) ok.add(String(req.headers['x-forwarded-host']).split(',')[0].trim());
        if (process.env.SITE_URL) { try { ok.add(new URL(process.env.SITE_URL).host); } catch { /* ignora */ } }
        let oh = null; try { oh = new URL(origin).host; } catch { /* inválido */ }
        if (!ok.has(oh)) fail(403, 'Origem não permitida.');
      }
      if (!String(req.headers['content-type'] || '').includes('application/json')) fail(415, 'Use JSON.');
      ctx.body = await readBody(req);
    }
    if (ctx.token) {
      ctx.user = await sessionUser(ctx.token);
      if (!ctx.user) ctx.setCookie(`${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`); // sessão inválida/expirada
    }
    const out = await handler(ctx);
    if (res.headersSent) return;
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    const body = JSON.stringify(out);
    if (body.length > 8192 && acceptsGzip(req)) { // ex.: mercados completos de vários jogos
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      res.end(zlib.gzipSync(body, { level: 6 }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (e) {
    if (res.headersSent) return;
    const code = e instanceof HttpError ? e.status : 500;
    if (code === 500) console.error(e);
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: code === 500 ? 'Erro interno.' : e.message }));
  }
});

(async () => {
  console.log(`A ligar ao Firebase (projeto ${WEB_CONFIG.projectId}${EMULATOR ? ', EMULADOR' : ''})...`);
  try { await col.users().limit(1).get(); }
  catch (e) {
    if (e.code === 5) console.error(`\n[Firebase] O Firestore ainda não foi criado. Abra https://console.firebase.google.com/project/${WEB_CONFIG.projectId}/firestore e clique em "Criar banco de dados".\n`);
    else if (e.code === 7) console.error('\n[Firebase] Sem permissão no Firestore. Gere a chave da conta de serviço "firebase-adminsdk" do mesmo projeto.\n');
    else console.error('\n[Firebase] Não foi possível ligar ao Firestore:', e.message, '\n');
    process.exit(1);
  }
  const locked = await FB.rulesAreLocked();
  if (locked === false) {
    console.error(`\n[Firebase] PERIGO: as regras do Firestore estão ABERTAS — qualquer pessoa pode ler e alterar saldos.
  Cole o conteúdo de firestore.rules em https://console.firebase.google.com/project/${WEB_CONFIG.projectId}/firestore/rules e clique Publicar.\n`);
    if (BP.enabled) { console.error('O servidor não arranca com pagamentos reais enquanto as regras estiverem abertas.'); process.exit(1); }
  }
  if (!ADMIN_EMAILS.size) console.warn('[Admin] Nenhum administrador definido. Ponha ADMIN_EMAILS=seu@email no .env para usar o painel /admin.');
  await Promise.all([
    watchReady(col.catSports(), catSports, 'modalidades', applyCatalog),
    watchReady(col.catLeagues(), catLeagues, 'campeonatos', applyCatalog),
    watchReady(col.manualEvents(), manualEvents, 'eventos da equipa', applyCatalog),
    watchReady(col.manualMarkets(), manualMarkets, 'mercados da equipa', applyCatalog),
    watchReady(col.openBets(), openBets, 'apostas abertas'),
    watchReady(col.deposits().where('status', '==', 'PENDING'), pendingDeposits, 'depósitos pendentes'),
    watchReady(col.withdrawals().where('status', 'in', ['PENDING', 'PROCESSING']), openWithdrawals, 'pedidos de saque'),
  ]);
  console.log(`Firebase ligado: ${openBets.size} apostas abertas, ${pendingDeposits.size} PIX pendentes, ${openWithdrawals.size} pedidos de saque por tratar.`);
  await LOGOS.start(); // emblemas (listas da ESPN) antes dos jogos, para já virem com imagem
  console.log(`A carregar jogos e odds ao vivo (${FEED.name})...`);
  // ténis: pontos guardados (sobrevivem a um reinício) e gravação de cada placar que chega
  await loadTrail().catch((e) => console.error('[Seleções por marcar] não carregou:', e.message));
  await POINTS.init({
    load: async (since) => (await col.pointLogs().where('at', '>=', since).get()).docs.map((d) => [d.id, d.data()]),
    save: (id, data) => col.pointLogs().doc(id).set(data),
  });
  FEED.ws.onStats((id, st) => { POINTS.observe(id, st); observeRace(id, st); });
  setInterval(() => POINTS.cleanup(), 3600000);
  FEED.ws.start(onWsChange, onWsDown); // odds e placar ao vivo empurrados pela MoviOdds
  // mercados de jogadores: que ligas trazem estatísticas por jogador (em segundo plano; até lá ficam fechados)
  FEED.loadPlayerCoverage().catch((e) => console.error('[Jogadores]', e.message));
  setInterval(() => FEED.loadPlayerCoverage().catch(() => {}), 12 * 3600000);
  await refresh(true);
  const nLive = [...events.values()].filter((e) => e.state === 'in').length;
  console.log(`${events.size} jogos carregados (${nLive} ao vivo).`);
  setInterval(() => refresh(false), FAST_MS);
  setInterval(() => refresh(true), SLOW_MS);
  setInterval(purgeSessions, 3600000);
  if (BP.enabled) {
    console.log(`Pagamentos: BravoPay ATIVO (depósitos PIX). Saques: manuais pelo painel /admin.${BP.webhookEnabled ? '' : '\n  Sem BRAVOPAY_WEBHOOK_SECRET: webhooks recusados, confirmação só por consulta.'}`);
    reconcileDeposits();
    setInterval(reconcileDeposits, 30000);
  } else console.warn('Pagamentos: DESLIGADOS — defina BRAVOPAY_API_KEY no .env. Depósitos e saques ficam indisponíveis.');
  if (SLOTS) console.log(`Slots PG Soft: LIGADOS (${SLOTS_GAMES.length} jogos).`);
  else console.log('Slots PG Soft: desligados — defina PGSOFT_API_URL, PGSOFT_AGENT_TOKEN e PGSOFT_SECRET no .env.');
  if (crashGame) await crashGame.start();
  if (minesGame) await minesGame.start();
  server.listen(PORT, () => console.log(`\n${SITE.name} a correr em http://localhost:${PORT}   ·   painel da equipa: http://localhost:${PORT}/admin\n`));
})();