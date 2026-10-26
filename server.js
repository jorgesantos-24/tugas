'use strict';
/* TUGAS — servidor da casa de apostas.
   - Contas: Firebase Authentication (e-mail e senha); sessão por cookie HttpOnly
   - Dados: Firestore (perfis, saldo, extrato, apostas, depósitos, saques, sessões)
   - Depósitos: PIX pela BravoPay. Saques: pedido do jogador, pago À MÃO pela equipa no painel /admin
   - Sem chave da BravoPay, depósitos e saques ficam indisponíveis
   - Lê placares e odds do feed público da ESPN

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
     pgsoftTxns/{txn_id}               rodadas dos slots já processadas (idempotência)
     catalogSports/{key}, catalogLeagues/{key}   modalidades e campeonatos criados pela equipa
     manualEvents/{id}                 eventos criados pela equipa (com os seus mercados)
     manualMarkets/{evId}              mercados extra da equipa em jogos reais da ESPN */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// carrega o ficheiro .env (chaves da BravoPay, Firebase, dados da empresa), se existir
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* sem .env */ }
const M = require('./public/markets.js');
const BP = require('./bravopay.js');
const FB = require('./firebase.js');
const VF = require('./verify.js'); // segunda fonte de resultados (API-Football)
const { db, auth, FieldValue, col, verifyPassword, sendPasswordReset, sendEmailVerification, WEB_CONFIG, EMULATOR } = FB;

const PORT = Number(process.env.PORT) || 3000;
const PUB = path.join(__dirname, 'public');
const API = 'https://site.api.espn.com/apis/site/v2/sports/';
const FAST_MS = 5000, SLOW_MS = 120000; // ao vivo: 5 s (só as ligas com jogos a decorrer); completo: 2 min
// tempo de aprovação: ao vivo 25s (configurável) para dar tempo de o feed apanhar o que acontece no campo
const LIVE_DELAY_MS = Number(process.env.LIVE_BET_DELAY || 25) * 1000, PRE_DELAY_MS = 800, CASHOUT_DELAY_MS = 2000;
const LIVE_CASHOUT_DELAY_MS = Number(process.env.LIVE_CASHOUT_DELAY || process.env.LIVE_BET_DELAY || 25) * 1000;
const SESSION_DAYS = 30;
// nome do cookie de sessão: o Firebase Hosting (domínio próprio à frente do Cloud Run) só deixa passar "__session"
const COOKIE = '__session';
const MAX_WIN = 50000000; // R$ 500.000 em centavos
// mercados calculados (Ambas Marcam, Placar Exato...): aposta e prêmio máximos mais baixos
const DERIVED_MAX_STAKE = Math.round(Number(process.env.DERIVED_MAX_STAKE || 200) * 100);
const DERIVED_MAX_WIN = Math.round(Number(process.env.DERIVED_MAX_WIN || 10000) * 100);
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
};

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
    payout: fromCents(b.payout), placedAt: b.placedAt, settledAt: b.settledAt, legs: b.legs,
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

/* ---------------- feed ESPN ---------------- */
const events = new Map();
let feedVersion = 0, feedCache = null, lastFeedOk = 0, lastBump = 0;

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function fetchLeague(lg, date) {
  if (!lg || !lg.path) return null; // campeonato da equipa: não vem da ESPN
  try {
    const d = await fetchJSON(`${API}${lg.path}/scoreboard${date ? `?dates=${date}` : ''}`);
    return (d.events || []).map((e) => M.parseEvent(e, lg)).filter(Boolean);
  } catch { return null; }
}
// A ESPN organiza os jogos por dia no horário de Nova Iorque. Os pedidos usam sempre esse calendário,
// seja qual for o relógio do servidor (no Cloud Run é UTC; no Brasil é UTC-3).
const ET_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const etDay = (t) => ET_FMT.format(new Date(t)).replace(/-/g, '');

// fetchedAt = quando o pedido à ESPN começou. Uma resposta mais antiga (ex.: a atualização completa,
// que demora alguns segundos) nunca substitui um placar mais recente já recebido.
function mergeEvents(list, fetchedAt) {
  const t = now();
  let changed = false;
  const same = (a, b) => { const { fetchedAt: x, ...ra } = a; const { fetchedAt: y, ...rb } = b; return JSON.stringify(ra) === JSON.stringify(rb); };
  for (const ev of list) {
    const old = events.get(ev.id);
    if (old && old.fetchedAt > fetchedAt) continue;
    ev.fetchedAt = fetchedAt;
    if (old) {
      const scored = old.state === 'in' && ev.state === 'in' && (ev.home.score !== old.home.score || ev.away.score !== old.away.score);
      if (scored) { ev.suspendedUntil = t + 20000; ev.goalAt = t; }
      else { ev.suspendedUntil = old.suspendedUntil; ev.goalAt = old.goalAt; }
    }
    ev.cm = extraMarketsOf(ev.id);
    if (!old || !same(old, ev)) changed = true;
    events.set(ev.id, ev);
  }
  return changed;
}

// atualização completa e atualização ao vivo correm em separado: a completa não bloqueia a ao vivo
const refreshing = { full: false, live: false };
async function refresh(full) {
  const kind = full ? 'full' : 'live';
  if (refreshing[kind]) return;
  refreshing[kind] = true;
  try {
    const t = now();
    const jobs = [];
    if (full) {
      // todas as ligas: ontem (resultados), hoje, amanhã e depois de amanhã (calendário da ESPN)
      const days = [...new Set([etDay(t - DAY), etDay(t), etDay(t + DAY), etDay(t + 2 * DAY)])];
      for (const l of M.LEAGUES) if (l.path) for (const d of days) jobs.push(fetchLeague(l, d));
    } else {
      // só as ligas com jogos ao vivo / a começar / com apostas em aberto, no dia certo de cada jogo
      const want = new Map();
      const add = (lg, ts) => { if (!M.LEAGUE_BY_KEY[lg]?.path) return; if (!want.has(lg)) want.set(lg, new Set()); want.get(lg).add(etDay(ts)); };
      for (const ev of events.values()) {
        const dt = ev.date - t;
        if (ev.state === 'in' || (ev.state === 'pre' && dt < 45 * 60000 && dt > -6 * 3600000)) add(ev.league, +ev.date);
      }
      for (const b of openBets.values()) for (const l of b.legs) if (!l.result) add(l.league, l.startsAt);
      for (const [lg, days] of want) for (const d of days) jobs.push(fetchLeague(M.LEAGUE_BY_KEY[lg], d));
    }
    const res = (await Promise.all(jobs)).filter(Boolean);
    let changed = false;
    if (res.length || !full) {
      changed = mergeEvents(res.flat(), t);
      if (res.length) lastFeedOk = now();
    }
    if (full) for (const [id, ev] of events) if (!ev.manual && t - ev.date > 36 * 3600000) { events.delete(id); changed = true; }
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
    if (ev && ev.state === 'in') snap.set(id, { h: ev.home.score, a: ev.away.score, state: ev.state, period: ev.period ?? null });
  }
  return snap;
}
async function refreshEvents(evIds) {
  const t = now();
  const pairs = new Set([...evIds].map((id) => events.get(id)).filter((ev) => ev && !ev.manual).map((ev) => `${ev.league}|${etDay(+ev.date)}`));
  const res = await Promise.all([...pairs].map((p) => { const [lg, d] = p.split('|'); return M.LEAGUE_BY_KEY[lg] ? fetchLeague(M.LEAGUE_BY_KEY[lg], d) : null; }));
  const list = res.filter(Boolean).flat();
  if (list.length) { mergeEvents(list, t); feedVersion++; feedCache = null; }
}
// devolve o motivo da recusa, ou null se nada mudou desde o pedido
function liveChanged(snap, t0) {
  for (const [id, s] of snap) {
    const ev = events.get(id);
    if (!ev || ev.state !== s.state) return 'o jogo mudou de estado durante a aprovação';
    if (ev.home.score !== s.h || ev.away.score !== s.a || (ev.goalAt && ev.goalAt >= t0)) return 'houve gol durante a aprovação';
    if (M.isSuspended(ev)) return 'mercado suspenso durante a aprovação';
  }
  return null;
}

function findSel(key) {
  const ev = events.get(String(key).split('|')[0]);
  if (!ev) return { ev: null, sel: null };
  return { ev, sel: M.selections(ev).find((s) => s.key === key) || null };
}

function feedPayload() {
  if (!feedCache) {
    const list = [...events.values()].map(({ goalAt, fetchedAt, ...ev }) => ({ ...ev, goalAt: goalAt || null }));
    feedCache = { etag: `"v${feedVersion}"`, body: JSON.stringify({ lastFeedOk, catalog: catalogCache, events: list }) };
  }
  return feedCache;
}

/* ---------------- catálogo da equipa ----------------
   Modalidades, campeonatos, eventos e mercados criados no painel /admin. Ficam em memória
   (ligação em tempo real ao Firestore) e entram no feed ao lado dos jogos da ESPN.
   Os mercados da equipa são liquidados quando a equipa marca o resultado no painel. */
const catSports = new Map(), catLeagues = new Map();
const manualEvents = new Map();  // eventos da equipa (cada um com os seus mercados)
const manualMarkets = new Map(); // id do jogo da ESPN -> { markets } (mercados extra em jogos reais)
let catalogCache = null;

// o que o site vê de cada mercado: só os abertos e suspensos, sem resultados
function pubMarkets(list) {
  const out = (list || []).filter((m) => m.status !== 'settled')
    .map((m) => ({ id: m.id, name: m.name, status: m.status, maxStake: m.maxStake ?? null, sels: m.sels.map((s) => ({ id: s.id, name: s.name, odds: s.odds })) }));
  return out.length ? out : null;
}
const extraMarketsOf = (evId) => pubMarkets(manualMarkets.get(evId)?.markets);
// mercados da equipa de um evento (manual ou da ESPN), com resultados
const teamMarkets = (evId) => (manualEvents.get(evId) || manualMarkets.get(evId))?.markets || [];

function publicCatalog() {
  const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt;
  const sports = [...catSports.values()].filter((s) => !s.hidden).sort(byOrder).map((s) => ({ key: s.id, name: s.name, icon: s.icon }));
  const visible = (k) => (M.SPORTS[k] && !M.SPORTS[k].custom) || sports.some((s) => s.key === k);
  const leagues = [...catLeagues.values()].filter((l) => !l.hidden && visible(l.sport)).sort(byOrder)
    .map((l) => ({ key: l.id, name: l.name, country: l.country || '', sport: l.sport }));
  return { sports, leagues };
}

function manualToEvent(d) {
  const lg = M.LEAGUE_BY_KEY[d.league];
  const side = (name, score, id) => ({ id, name, short: name, logo: '', score: d.state === 'pre' ? null : score ?? 0, form: '' });
  return {
    id: d.id, manual: true, league: d.league, leagueName: lg.name, country: lg.country, sport: lg.sport, path: null,
    date: new Date(d.startsAt), state: d.state, completed: d.state === 'post', statusName: '',
    clock: d.clock || (d.state === 'post' ? 'Encerrado' : d.state === 'in' ? 'Ao vivo' : undefined),
    home: side(d.home, d.score?.h, 'h'), away: side(d.away, d.score?.a, 'a'), details: [], venue: '', markets: null, cm: pubMarkets(d.markets),
  };
}

// reconstrói tudo o que depende do catálogo (corre a cada mudança no Firestore)
function applyCatalog() {
  catalogCache = publicCatalog();
  M.setCatalog(catalogCache);
  for (const [id, ev] of events) if (ev.manual) events.delete(id);
  for (const d of manualEvents.values()) if (!d.archived && M.LEAGUE_BY_KEY[d.league]) events.set(d.id, manualToEvent(d));
  for (const ev of events.values()) if (!ev.manual) ev.cm = extraMarketsOf(ev.id);
  feedVersion++; feedCache = null;
}

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
const summaryTried = new Map();
async function eventFromSummary(leg) {
  if (now() - (summaryTried.get(leg.evId) || 0) < 60000) return null;
  summaryTried.set(leg.evId, now());
  try {
    const d = await fetchJSON(`${API}${leg.path}/summary?event=${leg.evId}`);
    const c = d.header?.competitions?.[0];
    if (!c) return null;
    return M.parseEvent({ id: leg.evId, date: c.date, competitions: [c], status: c.status }, M.LEAGUE_BY_KEY[leg.league]);
  } catch { return null; }
}

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
  if (ok) openBets.delete(bet.id);
  return ok;
}

// as duas atualizações chamam isto: se já estiver a correr, a próxima (daqui a 5 s) apanha o que faltar
let settling = false;
async function settleBets() {
  if (settling) return;
  settling = true;
  try { await settleAll(); } finally { settling = false; }
}
async function settleAll() {
  for (const row of [...openBets.values()]) {
    try {
      const legs = structuredClone(row.legs);
      let changed = false;
      for (const leg of legs) {
        if (leg.result) continue;
        if (leg.market === 'custom') { if (settleCustomLeg(leg)) changed = true; continue; }
        let ev = events.get(leg.evId);
        if (!ev && now() - row.placedAt > 3 * 3600000) ev = await eventFromSummary(leg);
        // futebol: só paga se a segunda fonte (API-Football) confirmar o placar da ESPN
        if (VF.enabled && ev && ev.state === 'post' && ev.sport === 'soccer') {
          const v = await VF.check(ev);
          if (v.state !== 'ok') continue; // à espera, ou divergente / não encontrado → painel
        }
        if (M.settleLeg(leg, ev)) changed = true;
      }
      const anyLost = legs.some((l) => l.result === 'lost');
      const allDone = legs.every((l) => l.result);
      if (anyLost || allDone) {
        const payout = anyLost ? 0 : Math.round(row.stake * legs.reduce((p, l) => p * M.outcomeFactor(l.value, l.odds), 1));
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
    ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ETag: p.etag, 'Cache-Control': 'no-cache' });
    ctx.res.end(p.body);
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
    liveDelay: LIVE_DELAY_MS / 1000, liveCashoutDelay: LIVE_CASHOUT_DELAY_MS / 1000,
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
      const evIds = tk.keys.map((k) => String(k).split('|')[0]);
      if (new Set(evIds).size !== evIds.length) fail(400, 'Seleções do mesmo jogo não podem ser combinadas.');
      return { keys: tk.keys.map(String), seen: Array.isArray(tk.odds) ? tk.odds : [], stake };
    });
    const total = parsed.reduce((a, tk) => a + tk.stake, 0);
    if (total > u.balance) fail(400, 'Saldo insuficiente. Faça um depósito.');
    let live = false;
    for (const tk of parsed) for (const k of tk.keys) {
      const { ev, sel } = findSel(k);
      if (!sel || sel.locked || M.isSuspended(ev)) fail(409, 'Uma das seleções está suspensa. Remova-a do boletim.');
      if (ev.state === 'in') live = true;
    }
    if (userLocks.has(u.id)) fail(429, 'Aguarde a confirmação da aposta anterior.');
    userLocks.add(u.id);
    try {
      // atraso de aceitação (como as casas reais fazem, sobretudo ao vivo) e revalidação
      const t0 = now();
      const liveIds = new Set(parsed.flatMap((tk) => tk.keys.map((k) => String(k).split('|')[0])));
      const snap = liveSnapshot(liveIds);
      await sleep(live ? LIVE_DELAY_MS : PRE_DELAY_MS);
      if (snap.size) await refreshEvents(snap.keys()); // placar mais recente antes de decidir
      const liveReason = liveChanged(snap, t0);
      const placed = [], rejected = [];
      for (let i = 0; i < parsed.length; i++) {
        const tk = parsed[i];
        const legs = [];
        let reason = null;
        if (liveReason && tk.keys.some((k) => snap.has(String(k).split('|')[0]))) { rejected.push({ index: i, reason: liveReason }); continue; }
        for (let j = 0; j < tk.keys.length; j++) {
          const { ev, sel } = findSel(tk.keys[j]);
          if (!sel || sel.locked || M.isSuspended(ev)) { reason = 'mercado suspenso'; break; }
          if (!acceptAny && tk.seen[j] != null && Number(tk.seen[j]) !== sel.odds) { reason = 'odds alteradas'; break; }
          if (sel.maxStake && tk.stake > sel.maxStake) { reason = `aposta máxima no mercado "${sel.marketName}": ${brl(sel.maxStake)}`; break; }
          legs.push({
            key: sel.key, evId: ev.id, league: ev.league, path: ev.path, sport: ev.sport, market: sel.market, pick: sel.pick, line: sel.line ?? null,
            name: sel.name, marketName: sel.marketName, event: `${ev.home.short} x ${ev.away.short}`, leagueName: ev.leagueName,
            startsAt: +ev.date, liveAtPlacement: ev.state === 'in' ? `${ev.clock} (${ev.home.score}-${ev.away.score})` : null, odds: sel.odds, result: null,
          });
        }
        if (reason) { rejected.push({ index: i, reason }); continue; }
        const odds = M.round2(legs.reduce((p, l) => p * l.odds, 1));
        const potential = Math.round(tk.stake * odds);
        if (potential > MAX_WIN) { rejected.push({ index: i, reason: 'prêmio máximo de R$ 500.000 excedido' }); continue; }
        // mercados calculados pelo modelo: limites mais baixos (proteção contra erros do modelo)
        if (legs.some((l) => M.DERIVED_MARKETS.has(l.market))) {
          if (tk.stake > DERIVED_MAX_STAKE) { rejected.push({ index: i, reason: `aposta máxima neste mercado: ${brl(DERIVED_MAX_STAKE)}` }); continue; }
          if (potential > DERIVED_MAX_WIN) { rejected.push({ index: i, reason: `prêmio máximo neste mercado: ${brl(DERIVED_MAX_WIN)}` }); continue; }
        }
        const id = betId();
        const bet = {
          id, userId: u.id, type: legs.length > 1 ? 'multiple' : 'single', stake: tk.stake, odds, potential,
          status: 'open', payout: null, placedAt: now(), settledAt: null, legs,
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
        } catch (e) {
          if (!(e instanceof HttpError)) console.error('Erro ao gravar aposta:', e.message);
          rejected.push({ index: i, reason: e instanceof HttpError ? e.message : 'erro ao gravar a aposta' });
        }
      }
      return { placed, rejected, user: await meUser(u.id) };
    } finally { userLocks.delete(u.id); }
  },

  'POST /api/cashout': async (ctx) => {
    const u = requireUser(ctx);
    const id = String(ctx.body.id || '');
    if (!/^[0-9A-Z]{8,16}$/.test(id)) fail(404, 'Aposta não encontrada.');
    const s = await col.bets(u.id).doc(id).get();
    if (!s.exists) fail(404, 'Aposta não encontrada.');
    if (s.data().status !== 'open') fail(409, 'Esta aposta já foi encerrada.');
    if (!M.cashoutFactor(publicBet(s.data()), findSel)) fail(409, 'Cash Out indisponível no momento.');
    // ao vivo: mesma proteção das apostas (espera, placar novo, recusa se houve gol)
    const t0 = now();
    const snap = liveSnapshot(new Set(s.data().legs.filter((l) => !l.result).map((l) => l.evId)));
    await sleep(snap.size ? LIVE_CASHOUT_DELAY_MS : CASHOUT_DELAY_MS);
    if (snap.size) {
      await refreshEvents(snap.keys());
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
    openBets.delete(id);
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
const SLOTS_GAMES = Object.keys(SLOTS_GAMES_MAP);
const slotName = (code) => SLOTS_GAMES_MAP[code] || 'Slot';

// 1) O jogo pergunta o saldo (antes de cada rodada)
routes['POST /api/pgsoft/gold_api/user_balance'] = async (ctx) => {
  const code = String(ctx.body.user_code || '');
  const u = await getUser(code, true);
  if (!u || u.blocked) return { msg: 'INVALID_USER' };
  return { msg: 'SUCCESS', user_balance: fromCents(u.balance), currency: 'BRL' };
};

// 2) O jogo comunica o resultado da rodada (débito/crédito). Idempotente por txn_id.
routes['POST /api/pgsoft/gold_api/game_callback'] = async (ctx) => {
  const b = ctx.body || {};
  const s = b.slot || {};
  const uid = String(b.user_code || '');
  const txnId = String(s.txn_id || '') || payId('T');
  const bet = toCents(s.bet || 0);
  const win = toCents(s.win || 0);

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
  db, col, auth, FieldValue, runTx, addTx, getUser, dirty, fail, now, brl, fromCents, toCents, dayStart, dayKey, DAY,
  requireUser, authInfo, authState, endSessions, openWithdrawals, pendingDeposits, depositWindow, ADMIN_EMAILS, BP, SITE,
  openBets, M, eventInfo: (id) => events.get(id) || null, VF,
});
// painel: modalidades, campeonatos, eventos e mercados da equipa
require('./catalog.js')(routes, {
  col, runTx, fail, now, fromCents, toCents, M, requireAdmin: ADM.requireAdmin, log: ADM.log,
  events, openBets, catSports, catLeagues, manualEvents, manualMarkets, applyCatalog, settle: settleQueued,
});

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
}

/* ---------------- servidor HTTP ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const PAGES = { '/': '/index.html', '/admin': '/admin.html', '/termos': '/termos.html', '/privacidade': '/privacidade.html', '/jogo-responsavel': '/jogo-responsavel.html' };

function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
  if (/^\/(decola|mines)(\.html|\.js|\.css)?$/.test(p)) { if (p.startsWith('/mines') ? !MINES : !CASINO) { res.writeHead(404); res.end('Não encontrado'); return; } if (p === '/decola' || p === '/mines') p += '.html'; }
  p = PAGES[p] || p;
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep) || /app\.old\.js$/.test(file)) { res.writeHead(404); res.end('Não encontrado'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Não encontrado'); return; }
    const h = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (p === '/admin.html') h['X-Robots-Tag'] = 'noindex, nofollow';
    res.writeHead(200, h);
    res.end(data);
  });
}

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

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
  if (req.method === 'POST' && url.pathname === '/api/webhooks/bravopay') return handleWebhook(req, res);

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
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(out));
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
  console.log('A carregar jogos e odds ao vivo...');
  await refresh(true);
  console.log(`${events.size} eventos carregados.`);
  setInterval(() => refresh(false), FAST_MS);
  setInterval(() => refresh(true), SLOW_MS);
  setInterval(purgeSessions, 3600000);
  if (BP.enabled) {
    console.log(VF.enabled ? 'Resultados de futebol: ESPN + confirmação na API-Football (divergências vão para o painel).' : 'Resultados: só ESPN (defina APIFOOTBALL_KEY no .env para a dupla verificação no futebol).');
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