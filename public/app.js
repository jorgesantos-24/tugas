'use strict';
/* TUGAS — site da casa de apostas (navegador).
   Os dados (jogos, odds, conta, saldo, apostas) vêm do servidor (server.js).
   Funções partilhadas (selections, cashoutFactor, ...) estão em markets.js. */

const EVENTS_MS = 5000;   // busca de jogos/odds ao servidor
const ACCOUNT_MS = 10000; // busca de saldo/apostas

/* ---------------- estado ---------------- */
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem storage */ } };

const S = {
  site: {}, // dados da empresa (/api/site): e-mail de suporte, CNPJ...
  events: new Map(), leagueEvents: new Map(), oddsCache: new Map(), moves: new Map(), boosts: [], // boosts: Super Odds (/api/boosts)
  view: 'home', league: null, sport: null, eventId: null, query: '', sportTab: 'all', openSport: null, openCountries: new Set(), betOpen: new Set(), openMkts: new Set(),
  slipTab: 'slip', slipMode: 'single', slip: [], stakes: {}, comboStake: '', bbq: {},
  acceptAnyLocal: lsGet('gl_acceptAny', true), streamHidden: lsGet('gl_streamHidden', false),
  user: null, bets: [], tx: [], payments: { live: false }, games: {},
  placing: false, cashoutConfirm: null, cashoutBusy: null,
  loaded: false, failed: false, lastUpdate: null, etag: null, keepScroll: false,
};
const acceptAny = () => (S.user ? S.user.acceptAny : S.acceptAnyLocal);

/* ---------------- utilidades ---------------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (v) => BRL.format(v || 0);
const fmtOdd = (o) => (o == null ? '-' : o.toFixed(2));
const parseMoney = (s) => { const n = parseFloat(String(s ?? '').replace(/\s|R\$/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return isFinite(n) ? round2(n) : 0; };
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const hhmm = (d) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateLabel = (d) => {
  const t = new Date(); const tm = new Date(); tm.setDate(t.getDate() + 1);
  if (sameDay(d, t)) return 'Hoje ' + hhmm(d);
  if (sameDay(d, tm)) return 'Amanhã ' + hhmm(d);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hhmm(d);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const initials = (n) => String(n || '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

/* Atualiza um bloco da página mudando só o que mudou (em vez de apagar e desenhar tudo de novo).
   Com innerHTML a cada atualização das odds: as filas laterais voltavam ao início, os emblemas recarregavam
   (tudo piscava), no telemóvel a página saltava e o relógio alternava "60'" / "60:01".
   Cada jogo/odd/bloco é reconhecido pelo id, data-ev ou data-key (mesmo que a lista mude de ordem).
   Não mexe: no texto dos relógios (o contador é que os atualiza), no valor de um campo a ser escrito,
   nem numa transmissão (iframe/vídeo) com o mesmo endereço. */
const morphKey = (n) => (n.nodeType === 1 ? n.id || n.getAttribute('data-ev') || n.getAttribute('data-key') || '' : '');
const sameKind = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName);
function morphAttrs(a, b) {
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) {
    if (a.getAttribute(name) === value) continue;
    if (name === 'value' && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a === document.activeElement) continue;
    a.setAttribute(name, value);
    if (name === 'value' && 'value' in a) a.value = value;
  }
}
function morphNode(a, b) {
  if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
  const clock = a.classList.contains('kclk') && a.dataset.t0 === b.dataset.t0 && a.dataset.s === b.dataset.s;
  morphAttrs(a, b);
  if (clock || a.tagName === 'IFRAME' || a.tagName === 'VIDEO') return;
  morphChildren(a, b);
}
function morphChildren(from, to) {
  const old = [...from.childNodes], keyed = new Map(), loose = [];
  for (const n of old) { const k = morphKey(n); if (k && !keyed.has(k)) keyed.set(k, n); else loose.push(n); }
  const used = new Set();
  let li = 0, ref = from.firstChild;
  for (const nn of [...to.childNodes]) {
    const k = morphKey(nn);
    let m = null;
    if (k) { const o = keyed.get(k); if (o && !used.has(o) && sameKind(o, nn)) m = o; }
    else { while (li < loose.length && used.has(loose[li])) li++; const o = loose[li]; if (o && sameKind(o, nn) && !morphKey(o)) { m = o; li++; } }
    while (ref && used.has(ref)) ref = ref.nextSibling;
    if (m) { used.add(m); morphNode(m, nn); if (m === ref) ref = ref.nextSibling; else from.insertBefore(m, ref); }
    else from.insertBefore(nn, ref);
  }
  for (const n of old) if (!used.has(n) && n.parentNode === from) from.removeChild(n);
}
function morph(el, html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  morphChildren(el, t.content);
}
// emblemas que não carregaram: ficam com as iniciais (não se volta a tentar a cada atualização)
const badLogos = new Set();
window.badLogo = (img) => { badLogos.add(img.getAttribute('src')); img.outerHTML = `<i class="crest">${esc(img.dataset.ini || '?')}</i>`; };

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  const box = $('#toasts');
  if (!box) { console.warn('[toast]', msg); return; } // sem o contentor não rebenta quem chamou
  box.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch { /* vazio */ }
  if (!r.ok) { const e = new Error(data.error || 'Falha de comunicação. Tente de novo.'); e.status = r.status; throw e; }
  return data;
}

/* ---------------- jogos e odds ---------------- */
const findSel = (key) => {
  const ev = S.events.get(String(key).split('|')[0]);
  if (!ev) return { ev: null, sel: null };
  return { ev, sel: selections(ev).find((s) => s.key === key) || null };
};

// partial = só alguns jogos (tempo real): os outros ficam como estão
function mergeEvents(list, partial = false) {
  const now = Date.now();
  const seen = new Set();
  for (const ev of list) {
    seen.add(ev.id);
    const old = S.events.get(ev.id);
    for (const s of selections(ev)) {
      const prev = S.oddsCache.get(s.key);
      if (prev && prev !== s.odds) S.moves.set(s.key, { dir: s.odds > prev ? 'up' : 'down', until: now + 6000 });
      S.oddsCache.set(s.key, s.odds);
    }
    S.events.set(ev.id, ev);
    if (!S.leagueEvents.has(ev.league)) S.leagueEvents.set(ev.league, new Set());
    S.leagueEvents.get(ev.league).add(ev.id);
  }
  if (partial) return;
  for (const id of [...S.events.keys()]) if (!seen.has(id)) S.events.delete(id);
  for (const set of S.leagueEvents.values()) for (const id of [...set]) if (!seen.has(id)) set.delete(id);
}

/* Mercados completos: a lista de jogos (/api/events) só traz o vencedor e a linha principal do total.
   O jogo aberto, os do boletim e os das apostas em aberto recebem todos os mercados (/api/events/full). */
const fullIds = () => [...new Set([
  ...(S.view === 'event' && S.eventId ? [S.eventId] : []), ...S.slip.map((s) => s.evId),
  ...S.bets.filter((b) => b.status === 'open').flatMap((b) => b.legs.map((l) => l.evId)),
])].filter((id) => S.events.has(id)).slice(0, 40);
async function loadFull(ids = fullIds()) {
  if (!ids.length) return;
  try {
    const r = await fetch('/api/events/full?ids=' + ids.map(encodeURIComponent).join(','), { cache: 'no-store' });
    if (!r.ok) return;
    const now = Date.now();
    for (const f of (await r.json()).events) {
      const ev = S.events.get(f.id);
      if (!ev) continue;
      ev.markets = f.markets; ev.stats = f.stats; ev.details = f.details || []; ev.track = f.track; ev.fullAt = now;
      if (f.home?.form) ev.home.form = f.home.form;
      if (f.away?.form) ev.away.form = f.away.form;
      for (const s of selections(ev)) {
        const prev = S.oddsCache.get(s.key);
        if (prev && prev !== s.odds) S.moves.set(s.key, { dir: s.odds > prev ? 'up' : 'down', until: now + 6000 });
        S.oddsCache.set(s.key, s.odds);
      }
    }
  } catch { /* fica com os mercados principais até à próxima atualização */ }
}

/* Tempo real: o servidor empurra cada jogo que muda (GET /api/stream, Server-Sent Events).
   - Os jogos abertos aqui (página do jogo, boletim, apostas em aberto) vêm com os mercados completos no próprio
     fluxo: o servidor sabe quais são por POST /api/stream/watch (enviado quando a lista muda).
   - O servidor manda um "ping" a cada 10 s. Sem nada há 25 s, o fluxo conta como parado (ex.: um proxy a
     segurá-lo) e a lista volta a ser pedida a cada 5 s; com ele vivo, a lista é só reserva (a cada 30 s). */
const streamAlive = () => S.streamSid && Date.now() - (S.streamAt || 0) < 25000;
let watchKey = '', watchT = 0;
function syncWatch() {
  if (!S.streamSid) return;
  const ids = fullIds();
  const key = S.streamSid + '|' + ids.join(',');
  if (key === watchKey || watchT) return;
  watchT = setTimeout(async () => {
    watchT = 0;
    const now = fullIds(), k = S.streamSid + '|' + now.join(',');
    if (k === watchKey) return;
    watchKey = k;
    try { await api('POST', '/api/stream/watch', { sid: S.streamSid, ids: now }); } catch { watchKey = ''; }
  }, 300);
}
function applyEvents(d, partial) {
  const offset = Date.now() - (d.now || Date.now());
  if (d.catalog) setCatalog(d.catalog); // modalidades e campeonatos criados pela equipa (painel → Esportes e mercados)
  for (const l of d.leagues || []) addLeague(l);
  for (const e of d.events || []) if (e.removed) S.events.delete(e.id);
  const fix = (ev) => ({
    ...ev, date: new Date(ev.date),
    suspendedUntil: ev.suspendedUntil ? ev.suspendedUntil + offset : 0,
    goalAt: ev.goalAt ? ev.goalAt + offset : 0,
    clockT0: ev.clockT0 ? ev.clockT0 + offset : 0,
  });
  const list = (d.events || []).filter((e) => !e.removed && LEAGUE_BY_KEY[e.league]).map(fix);
  // os mercados completos que já tínhamos não se perdem com a versão leve (só os principais)
  for (const ev of list) { const old = S.events.get(ev.id); if (old?.fullAt && !(d.full || []).some((f) => f.id === ev.id)) { ev.markets = mergeLight(old.markets, ev.markets); ev.stats = old.stats; ev.details = old.details; ev.track = old.track; ev.fullAt = old.fullAt; } }
  for (const f of d.full || []) {
    if (!LEAGUE_BY_KEY[f.league]) continue;
    const i = list.findIndex((e) => e.id === f.id);
    const ev = { ...fix(f), nsel: (f.markets || []).reduce((n, mk) => n + mk.sels.length, 0), fullAt: Date.now() };
    if (i >= 0) list[i] = ev; else list.push(ev);
  }
  mergeEvents(list, partial);
}
// a versão leve traz só o vencedor e a linha principal: atualiza esses no conjunto completo que já existia
function mergeLight(full, light) {
  if (!full) return light;
  if (!light) return full.map((mk) => ({ ...mk, sels: mk.sels.map((x) => ({ ...x, lock: true })) }));
  const key = (mk) => `${mk.k}|${mk.per ?? ''}`;
  const lk = new Map(light.map((mk) => [key(mk), mk]));
  return full.map((mk) => {
    const l = lk.get(key(mk));
    if (!l) return mk;
    const byPick = new Map(l.sels.map((x) => [`${x.pick}|${x.line ?? ''}|${x.base ?? ''}`, x]));
    return { ...mk, sels: mk.sels.map((x) => byPick.get(`${x.pick}|${x.line ?? ''}|${x.base ?? ''}`) || x) };
  });
}
// redesenho pelo tempo real: junta as atualizações (no máximo 1x/s) e espera que a pessoa pare de deslizar o ecrã
let paintT = 0, lastPaint = 0, lastScroll = 0;
addEventListener('scroll', () => { lastScroll = Date.now(); }, { passive: true, capture: true }); // capture: apanha também as filas laterais
addEventListener('touchmove', () => { lastScroll = Date.now(); }, { passive: true });
function schedulePaint() {
  if (paintT) return;
  const wait = Math.max(0, 1000 - (Date.now() - lastPaint), 700 - (Date.now() - lastScroll));
  paintT = setTimeout(() => {
    paintT = 0;
    if (Date.now() - lastScroll < 700) { schedulePaint(); return; } // ainda a deslizar
    lastPaint = Date.now();
    requestAnimationFrame(() => { S.keepScroll = true; safeRender(); });
  }, wait);
}
async function startStream() {
  if (!window.EventSource) return;
  // no domínio do site (Firebase Hosting) o fluxo ficava retido: liga-se direto ao servidor (S.site.streamUrl)
  try { await S.sitePromise; } catch { /* sem dados do site: fica no próprio endereço */ }
  const base = S.site?.streamUrl && new URL(S.site.streamUrl).origin !== location.origin ? S.site.streamUrl : '';
  let es = null, raf = 0;
  const paint = () => schedulePaint();
  const connect = () => {
    es = new EventSource(base + '/api/stream?watch=' + encodeURIComponent(fullIds().join(',')));
    es.addEventListener('hello', (msg) => {
      let d; try { d = JSON.parse(msg.data); } catch { return; }
      S.streamSid = d.sid; S.streamAt = Date.now(); S.live = true; watchKey = '';
      for (const l of d.leagues || []) addLeague(l);
      syncWatch();
    });
    es.addEventListener('ping', () => { S.streamAt = Date.now(); });
    es.onerror = () => { S.live = false; }; // o navegador volta a ligar sozinho
    es.onmessage = (msg) => {
      let d; try { d = JSON.parse(msg.data); } catch { return; }
      S.streamAt = Date.now(); S.live = true;
      applyEvents(d, true);
      S.lastUpdate = Date.now(); S.etag = null; // a próxima lista completa vem inteira
      paint();
    };
  };
  connect();
  // separador escondido muito tempo: o navegador pode ter cortado a ligação sem avisar → liga de novo ao voltar
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || streamAlive() || !es) return;
    try { es.close(); } catch { /* */ }
    S.streamSid = null; connect();
    loadEvents().then((ch) => { if (ch) safeRender(); });
  });
}

async function loadEvents() {
  try {
    const r = await fetch('/api/events', { headers: S.etag ? { 'If-None-Match': S.etag } : {}, cache: 'no-store' });
    if (r.status === 304) { S.failed = false; return false; }
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    S.etag = r.headers.get('ETag');
    // torneios de ténis (criados na hora pelo servidor) e jogos; os abertos aqui mantêm os mercados completos
    applyEvents({ ...d, now: Number(r.headers.get('X-Server-Now')) || Date.now() }, false);
    await loadFull(); // a lista só traz os mercados principais: os jogos abertos/no boletim/apostados recebem tudo
    S.lastUpdate = d.lastFeedOk ? d.lastFeedOk + (Date.now() - (Number(r.headers.get('X-Server-Now')) || Date.now())) : null;
    S.failed = false; S.loaded = true;
    return true;
  } catch {
    S.failed = true; S.loaded = true;
    return true;
  }
}

// espera de uma aposta ao vivo: a maior das modalidades dos jogos ao vivo do boletim (+1 s para confirmar o placar)
const liveWait = (evs) => {
  const d = S.liveDelays || {};
  const list = evs.filter((e) => e && e.state === 'in').map((e) => d[e.sport] || 8);
  return (list.length ? Math.max(...list) : 8) + 1;
};

/* ---------------- conta ---------------- */
const ST_PT = { open: 'Aberta', won: 'Ganha', lost: 'Perdida', void: 'Devolvida', cashout: 'Cash Out' };
const RES_PT = { won: 'Ganhou', halfwon: 'Meio ganho', void: 'Devolvida', halflost: 'Meia perda', lost: 'Perdeu' };

async function loadAccount(silent) {
  try {
    const { user, payments, liveDelays, casino, games, testMode } = await api('GET', '/api/me');
    S.testMode = !!testMode; // servidor de teste (emuladores): sem BravoPay, com saldo de teste
    S.casino = !!casino; S.games = games || {}; document.body.classList.toggle('has-casino', S.casino);
    if (liveDelays) S.liveDelays = liveDelays; // segundos de espera ao vivo, por modalidade
    S.user = user;
    if (payments) { S.payments = payments; document.body.classList.toggle('live-pay', !!payments.live); }
    if (user) {
      const { bets } = await api('GET', '/api/bets');
      S.bets = bets;
    } else S.bets = [];
  } catch { /* servidor indisponível: mantém o estado */ }
}
function setUser(user) { if (user) S.user = user; renderHeader(); }

/* ---------------- boletim ---------------- */
function toggleSel(key) {
  let jump = false;
  const i = S.slip.findIndex((s) => s.key === key);
  if (i >= 0) { S.slip.splice(i, 1); delete S.stakes[key]; }
  else {
    const { ev, sel } = findSel(key);
    if (!sel || sel.locked || isSuspended(ev)) { toast('Mercado suspenso', 'err'); return; }
    if (S.slip.length >= 20) { toast('Máximo de 20 seleções', 'err'); return; }
    const same = S.slip.filter((s) => s.evId === ev.id).length;
    if (same && !bbOk(ev)) toast('Várias seleções deste jogo: só como apostas simples', 'err');
    else if (same >= BB_MAX) { toast(`Criar aposta: máximo de ${BB_MAX} seleções por jogo`, 'err'); return; }
    S.slip.push({ key, evId: ev.id, odds: sel.odds });
    // Criar aposta: o boletim mostra logo a odd calculada aqui; a do servidor substitui-a quando chegar
    const grp = S.slip.filter((s) => s.evId === ev.id);
    const loc = grp.length > 1 && bbOk(ev) && !bbOf(grp) ? bbLocal(ev, grp) : undefined;
    if (loc?.mine) S.bbq[bbKey(grp)] = { odds: loc.mine, at: 0, local: true };
    // segunda seleção do mesmo jogo de futebol ou basquete: vira Criar aposta (múltipla)
    if (S.slip.length >= 2 && (!hasConflict() || (same && bbOk(ev)))) S.slipMode = 'multiple';
    // e, na página desse jogo, abre a aba Criar aposta
    if (same === 1 && bbOk(ev) && S.view === 'event' && S.eventId === ev.id && !(S.evTab?.id === ev.id && S.evTab.tab === 'bb')) { S.evTab = { id: ev.id, tab: 'bb' }; jump = true; }
  }
  if (S.slip.length < 2) S.slipMode = 'single';
  S.slipTab = 'slip';
  render();
  // sobe até às abas para se ver o quadro do Criar aposta
  if (jump) document.querySelector('.ev-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  ensureBB();
}

/* Criar aposta: seleções do mesmo jogo de futebol ou basquete (antes do início ou ao vivo) numa odd só, calculada pelo servidor */
const BB_MAX = 6;
// MMA, hóquei e tênis de mesa: Criar aposta só antes do jogo (odd do Bet Builder da bet365, sem motor no navegador)
const BB365_ONLY = new Set(['mma', 'hockey', 'tabletennis']);
const bbOk = (ev) => !!ev && (ev.sport === 'soccer' || ev.sport === 'tennis' || (ev.sport === 'basketball' && !(ev.state === 'in' && ev.league === 'ncaab')) || (BB365_ONLY.has(ev.sport) && ev.state === 'pre')) && (ev.state === 'pre' || (ev.state === 'in' && !ev.awaiting)) && !ev.manual;
// motor do Criar aposta no navegador (/bbengine.js): futebol BBE, basquete BBK
const bbEng = (ev) => (ev?.sport === 'basketball' ? window.BBK : ev?.sport === 'tennis' ? window.BBT : ev?.sport === 'soccer' ? window.BBE : null);
const slipGroups = () => { const g = new Map(); for (const s of S.slip) g.set(s.evId, [...(g.get(s.evId) || []), s]); return g; };
const bbKey = (list) => list.map((s) => s.key).sort().join('~');
const bbOf = (list) => S.bbq[bbKey(list)] || null;
let bbBusy = false;
async function ensureBB(force = false) {
  const need = [...slipGroups().values()].filter((g) => g.length > 1 && bbOk(findSel(g[0].key).ev))
    .filter((g) => { const q = bbOf(g); return force || !q || Date.now() - q.at > 15000; });
  if (!need.length || bbBusy) return;
  bbBusy = true;
  for (const g of need) if (!bbOf(g)) S.bbq[bbKey(g)] = { busy: true, at: Date.now() };
  try {
    const { groups } = await api('POST', '/api/betbuilder/price', { groups: need.map((g) => g.map((s) => s.key)) });
    // a odd calculada no navegador (local) não conta como odd anterior: não aparece riscada
    need.forEach((g, i) => { const old = bbOf(g); S.bbq[bbKey(g)] = { ...groups[i], prev: old?.local ? null : old?.odds ?? old?.prev ?? null, at: Date.now() }; });
  } catch { need.forEach((g) => { S.bbq[bbKey(g)] = { reason: 'não foi possível calcular a odd', at: Date.now() - 10000 }; }); }
  bbBusy = false;
  renderSlip();
  // aba Criar aposta aberta neste jogo: o quadro de cima mostra a odd nova
  if (S.view === 'event' && S.evTab?.id === S.eventId && S.evTab.tab === 'bb') { S.keepScroll = true; renderMain(); }
}
setInterval(() => { if (!document.hidden && S.slip.length > 1) ensureBB(); }, 5000);
/* aba Criar aposta com seleções escolhidas: cada odd do jogo mostra quanto a aposta fica a valer ao juntá-la (0 = não junta).
   Calcula-se aqui no navegador, na hora: o servidor manda uma vez o modelo do jogo (/api/betbuilder/model) e o motor
   é o mesmo do servidor (/bbengine.js). A odd da aposta é sempre a do servidor (/api/betbuilder/price).
   Sem modelo (ainda a chegar ou falhou): pede as odds ao servidor (S.bbPrev), como antes. */
let bbShow = null; // odds recalculadas do jogo a desenhar (só enquanto se desenha a aba Criar aposta)
let bbMine = null; // odd da aposta deste jogo, mostrada nas seleções já escolhidas (aba Criar aposta, 2 ou mais)
const bbM = new Map(); // evId → { at, v, E, src: { chave: cotação }, memo: Map(bbKey → { at, odds, mine }) }
const bbLoading = new Set();
async function ensureModel(ev, force = false) {
  if (!bbEng(ev) || !bbOk(ev) || bbLoading.has(ev.id)) return;
  const c = bbM.get(ev.id);
  /* ao vivo as odds e o jogo mudam a cada segundo: modelo novo a cada 5 s (o servidor refá-lo a cada 8 s); no basquete
     a cada 10 s, porque preparar os jogadores custa ~3 s de contas no navegador (feitas aos bocados, ver warmModel) */
  const every = ev.state !== 'in' ? 90000 : ev.sport === 'basketball' ? 10000 : ev.sport === 'tennis' ? 8000 : 5000;
  if (c && Date.now() - c.at < (force ? 5000 : every)) return;
  bbLoading.add(ev.id);
  try {
    const r = await api('GET', `/api/betbuilder/model?ev=${encodeURIComponent(ev.id)}`);
    if (!r.model) throw new Error(r.reason);
    // o mesmo motor do servidor que já temos: fica (com as contas já feitas)
    if (c?.E && c.v === r.model.v) c.at = Date.now();
    else {
      const eng = bbEng(ev), E = eng.fromParams(r.model);
      E.m = { home: r.model.home, away: r.model.away, quotes: [], live: r.model.live || null };
      E.v = r.model.v;
      // basquete: cada seleção preparada aos bocados antes de trocar de modelo (o antigo serve entretanto) — de uma
      // vez eram 2,6 s de página parada a cada modelo ao vivo
      if (eng.legFor) await warmModel(eng, E, ev, r.src || {});
      bbM.set(ev.id, { at: Date.now(), v: r.model.v, E, src: r.src || {}, maxOdds: r.maxOdds || Infinity, memo: new Map() });
      // primeira conta já agora (prepara cada seleção do jogo no motor; os cliques seguintes ficam em milissegundos)
      if (!eng.legFor) setTimeout(() => { const ev2 = S.events.get(ev.id), first = ev2 && selections(ev2).find((s) => s.bb && !s.locked); if (first) bbLocal(ev2, [{ key: first.key, evId: ev.id }]); }, 30);
    }
  } catch { bbM.set(ev.id, { ...(c || {}), at: Date.now() - 60000 }); } // falhou: tenta outra vez daqui a 30 s
  bbLoading.delete(ev.id);
  if (S.view === 'event' && S.eventId === ev.id && S.evTab?.id === ev.id && S.evTab.tab === 'bb') { S.keepScroll = true; renderMain(); }
}
// as seleções do jogo no motor, ~30 ms de cada vez (os jogadores do basquete são simulados um a um)
async function warmModel(eng, E, ev, src) {
  const ev2 = S.events.get(ev.id) || ev;
  const qs = selections(ev2).filter((s) => s.bb && !s.locked && src[s.key]).map((s) => src[s.key]);
  let t = performance.now();
  for (const q of qs) {
    try { eng.legFor(E, q); } catch { /* a seleção fica de fora, como no servidor */ }
    if (performance.now() - t > 30) { await new Promise((r) => setTimeout(r, 0)); t = performance.now(); }
  }
}
// { odds: { chave: odd }, mine: odd das escolhidas (2 ou mais) } pelo motor do navegador; undefined sem modelo
function bbLocal(ev, mine) {
  const c = bbM.get(ev.id);
  if (!c?.E || !mine.length) return undefined;
  const k = bbKey(mine), hit = c.memo.get(k);
  if (hit && Date.now() - hit.at < (ev.state === 'in' ? 2000 : 5000)) return hit;
  const items = mine.map((s) => { const { sel } = findSel(s.key); return { key: s.key, name: sel?.name || '', q: c.src[s.key] || null, odds: sel?.odds ?? s.odds }; });
  const chosen = new Set(mine.map((s) => s.key));
  const cands = selections(ev).filter((s) => s.bb && !s.locked && !chosen.has(s.key)).map((s) => ({ key: s.key, q: c.src[s.key] || null, odds: s.odds }));
  // mercados novos no jogo que o modelo ainda não tem: pede-o outra vez
  if (cands.some((x) => !x.q)) queueMicrotask(() => ensureModel(ev, true));
  let out = { at: Date.now(), odds: null, mine: null };
  try {
    out.odds = items.every((it) => it.q) ? bbEng(ev).preview(c.E, items, cands) : null;
    if (items.length > 1 && out.odds) out.mine = bbEng(ev).quote(c.E, items).odds || null;
    // odd máxima do Criar aposta (a mesma do servidor)
    if (out.odds) for (const k in out.odds) if (out.odds[k] > c.maxOdds) out.odds[k] = c.maxOdds;
    if (out.mine > c.maxOdds) out.mine = c.maxOdds;
  } catch (e) { console.error('[Criar aposta]', e); return undefined; }
  if (c.memo.size > 60) c.memo.clear();
  c.memo.set(k, out);
  return out;
}
let bbpBusy = false;
async function ensurePreview() {
  const ev = S.view === 'event' && S.events.get(S.eventId);
  if (!bbOk(ev) || BB365_ONLY.has(ev.sport) || S.evTab?.id !== ev.id || S.evTab.tab !== 'bb') return; // sem motor: odds da aba ficam as simples
  const mine = S.slip.filter((s) => s.evId === ev.id);
  if (!mine.length || bbpBusy || bbLocal(ev, mine) !== undefined) return;
  const k = bbKey(mine), c = S.bbPrev;
  if (c && c.k === k && Date.now() - c.at < 15000) return;
  bbpBusy = true;
  try { const r = await api('POST', '/api/betbuilder/preview', { keys: mine.map((s) => s.key) }); S.bbPrev = { k, at: Date.now(), odds: r.odds || null }; }
  catch { S.bbPrev = { k, at: Date.now() - 10000, odds: null }; }
  bbpBusy = false;
  if (S.view === 'event' && S.eventId === ev.id) { S.keepScroll = true; renderMain(); }
}
// conflito: duas seleções do mesmo jogo que não formam um Criar aposta válido
const hasConflict = () => [...slipGroups().values()].some((g) => g.length > 1 && !(bbOf(g)?.odds));
const slipOdds = (items) => {
  let o = 1;
  for (const g of slipGroups().values()) o *= g.length > 1 ? bbOf(g)?.odds || 1 : (items.find((i) => i.s.key === g[0].key)?.sel?.odds || 1);
  return o;
};
function slipState() {
  return S.slip.map((s) => {
    const { ev, sel } = findSel(s.key);
    return { s, ev, sel, suspended: !sel || sel.locked || isSuspended(ev), changed: !!sel && sel.odds !== s.odds };
  });
}

async function placeBets() {
  if (S.placing) return;
  if (!S.user) { openLogin('Entre na sua conta para apostar.'); return; }
  if (isPaused()) { pausedNotice(); return; }
  const all = slipState();
  if (!all.length) return;
  // múltipla: é uma aposta só, precisa de todas as seleções abertas; simples: seguem as abertas, as suspensas ficam no boletim
  const held = S.slipMode === 'multiple' ? [] : all.filter((i) => i.suspended && parseMoney(S.stakes[i.s.key]) >= 1);
  if (S.slipMode === 'multiple' && all.some((i) => i.suspended)) { toast('Remova as seleções suspensas', 'err'); return; }
  const items = S.slipMode === 'multiple' ? all : all.filter((i) => !i.suspended);
  if (!items.length) { toast(all.length > 1 ? 'As seleções estão suspensas. Tente de novo em instantes.' : 'Esta seleção está suspensa. Tente de novo em instantes.', 'err'); return; }
  if (items.some((i) => i.changed) && !acceptAny()) { toast('As odds mudaram. Aceite as alterações.', 'err'); return; }
  let tickets;
  if (S.slipMode === 'multiple') {
    if (hasConflict()) { const bad = [...slipGroups().values()].find((g) => g.length > 1 && !bbOf(g)?.odds); toast(bbOf(bad)?.reason ? `Criar aposta: ${bbOf(bad).reason}` : bbOf(bad)?.busy ? 'A calcular a odd do Criar aposta…' : 'Seleções do mesmo jogo não podem ser combinadas', 'err'); return; }
    const stake = parseMoney(S.comboStake);
    if (stake < 1) { toast('Valor mínimo: R$ 1,00', 'err'); return; }
    const bb = {};
    for (const [evId, g] of slipGroups()) if (g.length > 1) bb[evId] = bbOf(g).odds;
    tickets = [{ keys: items.map((i) => i.s.key), odds: items.map((i) => i.s.odds), stake, ...(Object.keys(bb).length ? { bb } : {}) }];
  } else {
    tickets = [];
    for (const it of items) {
      const stake = parseMoney(S.stakes[it.s.key]);
      if (stake > 0 && stake < 1) { toast('Valor mínimo: R$ 1,00', 'err'); return; }
      if (stake >= 1) tickets.push({ keys: [it.s.key], odds: [it.s.odds], stake });
    }
    if (!tickets.length) { toast(held.length ? 'As seleções com valor estão suspensas. Tente de novo em instantes.' : 'Informe o valor da aposta', 'err'); return; }
  }
  const total = tickets.reduce((a, t) => a + t.stake, 0);
  if (total > S.user.balance + 1e-9) { toast('Saldo insuficiente. Faça um depósito.', 'err'); openDeposit(); return; }

  S.placing = true; renderSlip();
  try {
    const res = await api('POST', '/api/bets', { tickets, acceptAny: acceptAny() });
    setUser(res.user);
    for (const r of res.rejected) toast(`Aposta recusada: ${r.reason}`, 'err');
    if (res.rejected.length) ensureBB(true); // odd do Criar aposta pode ter mudado
    if (held.length) toast(held.length > 1 ? `${held.length} apostas não enviadas: seleções suspensas (ficam no boletim)` : 'Uma aposta não foi enviada: seleção suspensa (fica no boletim)', 'err');
    if (res.placed.length) {
      const placedKeys = new Set(res.placed.flatMap((p) => p.bet.legs.map((l) => l.key)));
      S.slip = S.slip.filter((s) => !placedKeys.has(s.key));
      for (const k of placedKeys) delete S.stakes[k];
      if (S.slipMode === 'multiple') S.comboStake = '';
      S.bets = [...res.placed.map((p) => p.bet), ...S.bets];
      toast(res.placed.length > 1 ? `${res.placed.length} apostas realizadas!` : `Aposta realizada! Código ${res.placed[0].bet.id}`, 'ok');
      if (!S.slip.length) S.slipTab = 'open';
      if (S.slip.length < 2) S.slipMode = 'single';
    }
  } catch (e) {
    if (!sessionExpired(e, 'apostar')) toast(e.message, 'err');
  }
  S.placing = false;
  render();
}

async function doCashout(id) {
  S.cashoutConfirm = null; S.cashoutBusy = id; render();
  try {
    const res = await api('POST', '/api/cashout', { id });
    setUser(res.user);
    toast(`Cash Out realizado: ${money(res.value)}`, 'ok');
    await loadAccount();
  } catch (e) { if (!sessionExpired(e, 'fazer o Cash Out')) toast(e.message, 'err'); }
  S.cashoutBusy = null; render();
}
// sessão terminou no servidor (401): em vez do aviso vermelho, abre o login com uma mensagem clara
function sessionExpired(e, what) {
  if (!e || e.status !== 401) return false;
  S.user = null; S.bets = [];
  openLogin(`A sua sessão terminou. Entre novamente para ${what}.`);
  return true;
}
const cashoutValue = (bet) => {
  if (bet.status !== 'open' || bet.bb) return null; // Criar aposta: sem Cash Out
  const f = cashoutFactor(bet, findSel);
  if (!f) return null;
  const v = Math.floor(bet.stake * 100 * f) / 100;
  return v >= 0.1 ? v : null;
};

/* ---------------- render: lista ---------------- */
function oddBtn(sel, ev, opts = {}) {
  if (!sel) return `<span class="odd empty ${opts.cls || ''}"><span class="val">-</span></span>`;
  const inSlip = S.slip.some((s) => s.key === sel.key);
  const mv = S.moves.get(sel.key);
  const move = mv && mv.until > Date.now() ? mv.dir : '';
  // a seta continua a animação de onde ia (não recomeça a cada redesenho)
  const mvStyle = move ? ` style="--d:-${((6000 - (mv.until - Date.now())) / 1000).toFixed(2)}s"` : '';
  const label = esc(opts.wide ? sel.name : sel.lbl);
  if (isSuspended(ev) || sel.locked) return `<span class="odd lock ${opts.cls || ''}" title="Suspenso"><span class="lbl">${label}</span><span class="val">🔒</span></span>`;
  // aba Criar aposta: a odd já junta com as escolhidas; as que não combinam ficam bloqueadas
  const bx = !inSlip && bbShow ? bbShow[sel.key] : undefined;
  if (bx === 0) return `<span class="odd lock bb-off ${opts.cls || ''}" title="Não combina com a sua aposta"><span class="lbl">${label}</span><span class="val">—</span></span>`;
  if (bx) return `<button class="odd bb-x ${opts.cls || ''}" data-key="${esc(sel.key)}"><span class="lbl">${label}</span><span class="val">${fmtOdd(bx)}</span></button>`;
  const shown = inSlip && bbMine ? bbMine : sel.odds;
  return `<button class="odd ${inSlip ? 'sel' : ''} ${move} ${opts.cls || ''}"${mvStyle} data-key="${esc(sel.key)}"><span class="lbl">${label}</span><span class="val">${fmtOdd(shown)}</span></button>`;
}

/* Futebol ao vivo: relógio ao segundo (22:30, 47:12, 93:05). O HTML leva o minuto (muda pouco, não obriga a redesenhar)
   e o contador abaixo troca-o pelos segundos, uma vez por segundo, sem redesenhar a página. */
const SOCCER_CLOCK = (ev) => ev.sport === 'soccer' && ev.state === 'in' && !ev.awaiting && ev.clock !== 'Intervalo' && (ev.clockT0 || ev.clockSecs != null);
const mmss = (secs) => { secs = Math.max(0, Math.floor(secs)); return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`; };
function clockHtml(ev, fallback = '') {
  const txt = esc(ev.clock || fallback);
  if (!SOCCER_CLOCK(ev)) return txt;
  const now = ev.clockT0 ? mmss((Date.now() - ev.clockT0) / 1000) : mmss(Number(ev.clockSecs));
  return ev.clockT0 ? `<span class="kclk" data-t0="${ev.clockT0}">${now}</span>` : `<span class="kclk" data-s="${ev.clockSecs}">${now}</span>`;
}
function tickClocks() {
  const t = Date.now();
  for (const el of document.querySelectorAll('.kclk')) {
    const v = el.dataset.t0 ? mmss((t - Number(el.dataset.t0)) / 1000) : mmss(Number(el.dataset.s));
    if (el.textContent !== v) el.textContent = v;
  }
}
setInterval(() => { if (!document.hidden) tickClocks(); }, 1000);

function timeCell(ev) {
  if (ev.outright) return `<b style="color:#fff">🏆</b><br>até ${ev.date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`;
  if (ev.state === 'in') return `<span class="lv"><span class="live-dot"></span>${clockHtml(ev, 'Ao vivo')}</span>`;
  const dd = ev.date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  if (ev.state === 'post') return `<span>${esc(ev.clock)}</span><br><span>${dd}</span>`;
  return `<b style="color:#fff">${hhmm(ev.date)}</b><br>${sameDay(ev.date, new Date()) ? 'Hoje' : dd}`;
}

// emblema da equipa; sem emblema, as iniciais num círculo (se a imagem falhar, também)
const crestText = (t) => initials(String(t.short || t.name || '').replace(/[^\p{L}\p{N} ]/gu, '')) || '?'; // só letras/números (vai dentro do onerror)
const crest = (t) => (t.logo && !badLogos.has(t.logo) ? `<img src="${esc(t.logo)}" alt="" loading="lazy" data-ini="${esc(crestText(t))}" onerror="badLogo(this)">` : `<i class="crest">${crestText(t)}</i>`);
function teamLine(t, ev, other) {
  const showScore = ev.state !== 'pre' && t.score != null;
  const won = ev.state === 'post' && showScore && t.score > other.score;
  // ténis ao vivo: bola em quem serve e pontos do game atual
  const side = t.id === 'h' ? 0 : 1;
  const serve = ev.state === 'in' && ev.serve === (side ? 'away' : 'home') ? '<i class="serve" title="Ao serviço"></i>' : '';
  const pt = ev.state === 'in' && ev.point ? `<span class="pt">${esc(ev.point[side])}</span>` : '';
  return `<div class="team-line ${won ? 'won' : ''}">${crest(t)}<span class="nm">${esc(t.name)}${serve}</span>${pt}${showScore ? `<span class="sc">${t.score}</span>` : ''}</div>`;
}

// seleções que aparecem na linha do jogo: 1X2 (futebol) ou vencedor; sem estes, o primeiro mercado da equipa (até 3 seleções)
function mainSels(ev, sels) {
  const by = (m, p) => sels.find((s) => s.market === m && s.pick === p);
  if (!by('ml', 'home')) {
    const first = sels.find((s) => s.market === 'custom');
    if (first) return sels.filter((s) => s.market === 'custom' && s.pick.split('.')[0] === first.pick.split('.')[0]).slice(0, 3);
  }
  return ev.sport === 'soccer' ? [by('ml', 'home'), by('ml', 'draw'), by('ml', 'away')] : [by('ml', 'home'), by('ml', 'away')];
}

function evRow(ev) {
  const sels = selections(ev);
  const by = (m, p) => sels.find((s) => s.market === m && s.pick === p);
  const main = mainSels(ev, sels);
  const tk = ev.sport === 'tennis' ? 'gtotal' : 'total'; // ténis: total de games
  const custom = LEAGUE_BY_KEY[ev.league]?.custom; // campeonato da equipa: sem colunas de total
  const tot = custom ? [] : [by(tk, 'over'), by(tk, 'under')];
  const goal = ev.goalAt && Date.now() - ev.goalAt < 12000;
  const oddsHtml = ev.state === 'post' ? '' :
    main.map((s) => oddBtn(s, ev)).join('') + (custom ? '' : '<span class="gap col-total"></span>' + tot.map((s) => oddBtn(s, ev, { cls: 'col-total' })).join(''));
  return `<div class="ev-row ${goal ? 'goal' : ''} ${ev.state === 'in' ? 'live' : ''}" data-ev="${ev.id}">
    <div class="ev-time">${timeCell(ev)}</div>
    <div class="ev-teams">${ev.outright ? `<div class="team-line"><span class="nm">${esc(ev.home.name)}</span></div><div class="out-close">${isSuspended(ev) ? 'Apostas encerradas' : 'Apostas até ' + dateLabel(ev.date)}</div>` : teamLine(ev.home, ev, ev.away) + teamLine(ev.away, ev, ev.home)}</div>
    <div class="ev-odds">${oddsHtml}</div>
    <div class="ev-more">${ev.state !== 'post' && sels.length ? '+' + (ev.nsel || sels.length) : ''}</div>
  </div>`;
}

/* Listas grandes ("Todos", "Hoje"... chegam a ~1800 jogos e 50 mil elementos): desenhar tudo a cada mudança de odd
   congelava a página 1-2 s por segundo. Mostra-se só os primeiros "max" jogos; ao chegar ao fim entram mais. */
const LIST_STEP = 100;
S.listLimit = LIST_STEP;
function leagueBlocks(list, max = Infinity) {
  const groups = new Map();
  for (const ev of list) { if (!groups.has(ev.league)) groups.set(ev.league, []); groups.get(ev.league).push(ev); }
  const keys = [...groups.keys()].sort((a, b) => LEAGUE_BY_KEY[a].order - LEAGUE_BY_KEY[b].order || LEAGUE_BY_KEY[a].name.localeCompare(LEAGUE_BY_KEY[b].name));
  let left = max;
  const html = keys.map((k) => {
    if (left <= 0) return '';
    const lg = LEAGUE_BY_KEY[k];
    const evs = groups.get(k).sort((a, b) => (b.state === 'in') - (a.state === 'in') || a.date - b.date).slice(0, left);
    left -= evs.length;
    const soc = lg.sport === 'soccer';
    const allPost = evs.every((e) => e.state === 'post');
    return `<section class="league">
      <div class="league-head">${SPORTS[lg.sport].icon} ${esc(lg.name)} <span class="country">· ${esc(lg.country)}</span>
        ${allPost || lg.custom ? '' : `<div class="cols">${soc ? '<span>1</span><span>X</span><span>2</span>' : '<span>Casa</span><span>Fora</span>'}<span class="gap col-total"></span><span class="col-total">Mais</span><span class="col-total">Menos</span><span style="width:44px" class="col-more"></span></div>`}
      </div>
      ${evs.map(evRow).join('')}
    </section>`;
  }).join('');
  const rest = list.length - Math.min(list.length, max);
  return rest > 0 ? html + `<button class="btn btn-ghost btn-block more-games" data-action="more" style="margin:12px 0">Mostrar mais jogos (${rest})</button>` : html;
}
// ao aparecer o botão "Mostrar mais jogos" no ecrã, carrega os seguintes sozinho
const moreObs = 'IntersectionObserver' in window ? new IntersectionObserver((list) => {
  if (list.some((e) => e.isIntersecting)) { moreObs.disconnect(); S.listLimit += LIST_STEP; S.keepScroll = true; renderMain(); }
}, { rootMargin: '600px' }) : null;

// jogos que acabaram e esperam o resultado não aparecem no site (o cliente vê o resultado nas apostas)
const listed = () => [...S.events.values()].filter((e) => !e.awaiting);

function filtered(pred) {
  const q = S.query.trim().toLowerCase();
  const tab = ['home', 'live', 'all'].includes(S.view) && S.sportTab !== 'all' ? S.sportTab : null;
  return listed().filter((ev) => pred(ev) && (!tab || ev.sport === tab) && (!q || `${ev.home.name} ${ev.away.name} ${ev.leagueName}`.toLowerCase().includes(q)));
}

function sportTabs() {
  const evs = listed().filter((e) => e.state !== 'post' && (S.view !== 'live' || e.state === 'in'));
  const sports = Object.entries(SPORTS).filter(([k]) => evs.some((e) => e.sport === k));
  if (S.sportTab !== 'all' && !sports.some(([k]) => k === S.sportTab)) S.sportTab = 'all';
  const btn = (k, label, n) => `<button class="${S.sportTab === k ? 'active' : ''}" data-sporttab="${k}">${label}<span class="tab-cnt">${n}</span></button>`;
  return `<div class="tabs sport-tabs">${btn('all', 'Todos', evs.length)}${sports.map(([k, sp]) => btn(k, `${sp.icon} ${esc(sp.name)}`, evs.filter((e) => e.sport === k).length)).join('')}</div>`;
}
const isToday = (ev) => sameDay(ev.date, new Date());
const isTomorrow = (ev) => { const t = new Date(); t.setDate(t.getDate() + 1); return sameDay(ev.date, t); };

/* ---------------- carrossel de destaques (topo da página inicial) ---------------- */
// slides: conta (criar / 1.º depósito), jogo ao vivo em destaque, cassino
function homeHero(live) {
  if (S.user && isPaused()) return homeBanner(); // conta em pausa: só o aviso, sem promover jogos
  const slides = [];
  // marca: cores de Portugal e o mascote Galo Tuga
  slides.push(`<div class="hb-slide hb-brand">
      <div class="hb-txt"><small><span class="hb-flag" aria-hidden="true"></span>TugasBet</small><b>Futebol com sotaque <span class="hb-pt">português</span></b><p>Odds ao vivo, cassino e PIX na hora. Bora com o Galo Tuga!</p>
      <span class="hb-cta">${S.user ? '<button class="hb-btn" data-view="live">Apostar ao vivo</button>' : '<button class="hb-btn" data-action="register">Entrar no time</button>'}</span></div>
      <img class="hb-galo" src="/img/galo-tuga.svg" alt="Galo Tuga, o mascote da TugasBet"></div>`);
  if (!S.user) slides.push(`<div class="hb-slide hb-acc">
      <div class="hb-txt"><small>Bem-vindo à TugasBet</small><b>Crie sua conta em 1 minuto</b><p>Deposite via PIX e aposte nos jogos que estão rolando agora.</p>
      <span class="hb-cta"><button class="hb-btn" data-action="register">Cadastrar</button><button class="hb-btn hb-btn-ghost" data-action="login">Entrar</button></span></div>
      <img class="hb-art hb-logo" src="/img/logo.png" alt=""></div>`);
  else if (S.user.balance <= 0 && !S.bets.length) slides.push(`<div class="hb-slide hb-acc">
      <div class="hb-txt"><small>Olá, ${esc(S.user.name.split(' ')[0])}</small><b>Faça seu primeiro depósito</b><p>Via PIX: o saldo é creditado em segundos.</p>
      <span class="hb-cta"><button class="hb-btn" data-action="deposit">Depositar</button></span></div>
      <img class="hb-art hb-logo" src="/img/logo.png" alt=""></div>`);
  // jogo ao vivo em destaque: de preferência um com odds abertas, pela ordem das ligas
  const withOdds = live.filter((e) => e.markets);
  const ev = (withOdds.length ? withOdds : live).slice().sort((a, b) => (LEAGUE_BY_KEY[a.league]?.order ?? 999) - (LEAGUE_BY_KEY[b.league]?.order ?? 999))[0];
  if (ev) {
    const team = (t) => `<span class="hb-team">${crest(t)}<em>${esc(t.short)}</em></span>`;
    slides.push(`<div class="hb-slide hb-live">
      <div class="hb-txt"><small><span class="live-dot"></span>Ao vivo · ${clockHtml(ev)}</small><b>${esc(ev.home.short)} x ${esc(ev.away.short)}</b><p>${esc(ev.leagueName)} · ${live.length} jogos ao vivo agora</p>
      <span class="hb-cta"><button class="hb-btn" data-ev="${ev.id}">Apostar</button><button class="hb-btn hb-btn-ghost" data-view="live">Ver todos</button></span></div>
      <div class="hb-art hb-match">${team(ev.home)}<span class="hb-score">${ev.home.score ?? 0}<small>:</small>${ev.away.score ?? 0}</span>${team(ev.away)}</div></div>`);
  }
  const g = S.casino && casinoGames().find((x) => !isSoon(x));
  if (g) slides.push(`<div class="hb-slide hb-casino">
      <img class="hb-bg" src="${g.img}" alt="" onerror="this.onerror=null;this.style.display='none'">
      <div class="hb-txt"><small>Cassino</small><b>${esc(g.name)}</b><p>Com o mesmo saldo das suas apostas.</p>
      <span class="hb-cta">${gameLink(g, 'hb-btn', 'Jogar agora <span aria-hidden="true">▶</span>')}</span></div></div>`);
  if (!slides.length) return '';
  const dots = slides.length > 1 ? `<div class="hb-dots">${slides.map((_, i) => `<button type="button" data-hb="${i}" aria-label="Destaque ${i + 1}"></button>`).join('')}</div>` : '';
  return `<div class="hb" id="homeHero" data-n="${slides.length}"><div class="hb-track">${slides.join('')}</div>${dots}</div>`;
}
// mostra o slide atual (chamado depois de desenhar a página e a cada troca)
function heroShow(i, instant) {
  const hb = document.getElementById('homeHero'); if (!hb) return;
  const n = +hb.dataset.n || 1;
  S.heroIdx = ((i % n) + n) % n;
  const tr = hb.querySelector('.hb-track');
  if (instant) tr.style.transition = 'none';
  tr.style.transform = `translateX(-${S.heroIdx * 100}%)`;
  if (instant) { void tr.offsetWidth; tr.style.transition = ''; }
  hb.querySelectorAll('.hb-dots button').forEach((b, k) => b.classList.toggle('on', k === S.heroIdx));
}
// troca sozinho a cada 6 s (para enquanto o rato/dedo está em cima ou a aba está escondida)
let heroHold = false;
setInterval(() => { if (!heroHold && !document.hidden) heroShow((S.heroIdx || 0) + 1); }, 6000);
document.addEventListener('mouseover', (e) => { heroHold = !!e.target.closest('#homeHero'); });
let heroTouchX = null;
document.addEventListener('touchstart', (e) => { if (e.target.closest('#homeHero')) { heroHold = true; heroTouchX = e.touches[0].clientX; } }, { passive: true });
document.addEventListener('touchend', (e) => {
  if (heroTouchX == null) return;
  const dx = e.changedTouches[0].clientX - heroTouchX; heroTouchX = null; heroHold = false;
  if (Math.abs(dx) > 40) heroShow((S.heroIdx || 0) + (dx < 0 ? 1 : -1));
}, { passive: true });

function heroCard(ev) {
  const sels = mainSels(ev, selections(ev)).filter(Boolean);
  const live = ev.state === 'in';
  const when = live ? `<span class="live-dot"></span>${clockHtml(ev)}` : `<span style="color:var(--muted)">${esc(dateLabel(ev.date))}</span>`;
  return `<div class="hero-card" data-ev="${ev.id}">
    <div class="hero-top"><span class="lg">${SPORTS[ev.sport].icon} ${esc(ev.leagueName)}${ev.stream ? ' <span class="tv" title="Com transmissão">📺</span>' : ''}</span><span style="color:var(--red);font-weight:700;display:flex;gap:5px;align-items:center">${when}</span></div>
    <div class="hero-teams">
      <div class="hero-team">${crest(ev.home)}${esc(ev.home.short)}</div>
      <div class="hero-score">${live ? `${ev.home.score ?? 0}:${ev.away.score ?? 0}` : '<small style="color:var(--muted)">x</small>'}</div>
      <div class="hero-team">${crest(ev.away)}${esc(ev.away.short)}</div>
    </div>
    <div class="hero-odds">${sels.length ? sels.map((s) => oddBtn(s, ev)).join('') : '<span class="muted" style="font-size:12px">Mercados suspensos</span>'}</div>
  </div>`;
}

/* ---------------- Super Odds ----------------
   Combinações escolhidas pelo sistema (ligas top) com a odd aumentada: no topo da página inicial e das modalidades.
   Um clique põe as seleções no boletim como Criar aposta; a odd é a do servidor (/api/betbuilder/price). */
async function loadBoosts() {
  try { const r = await api('GET', '/api/boosts'); S.boosts = r.boosts || []; } catch { /* fica a lista anterior */ }
}
function boostsBlock(sport, league) {
  const list = S.boosts.filter((b) => (!sport || b.sport === sport) && (!league || S.events.get(b.evId)?.league === league) && S.events.get(b.evId)?.state === 'pre');
  if (!list.length) return '';
  const cards = list.map((b) => {
    const ev = S.events.get(b.evId);
    const on = b.legs.every((l) => S.slip.some((s) => s.key === l.key)) && S.slip.filter((s) => s.evId === b.evId).length === b.legs.length;
    return `<div class="boost-card ${on ? 'on' : ''}" data-boost="${esc(b.id)}">
      <div class="boost-top"><span class="boost-tag">⚡ Super Odd</span><span class="lg">${SPORTS[ev.sport].icon} ${esc(ev.leagueName)} · ${esc(dateLabel(ev.date))}</span></div>
      <div class="boost-match">${esc(ev.home.name)} x ${esc(ev.away.name)}</div>
      <div class="boost-legs">${b.legs.map((l) => `<div class="boost-leg"><span class="bb-dot"></span><div><div>${esc(l.name)}</div><div class="si-market">${esc(l.marketName)}</div></div></div>`).join('')}</div>
      <div class="boost-odds"><span class="old">${fmtOdd(b.base)}</span><span class="new">${fmtOdd(b.odds)}</span></div>
    </div>`;
  }).join('');
  return `<div class="section-head"><h2>⚡ Super Odds</h2><span class="muted">odds aumentadas</span></div><div class="hero boosts">${cards}</div>`;
}
// as seleções da Super Odd no boletim (no lugar das que lá estavam desse jogo); outro clique tira-as
async function addBoost(id) {
  const b = S.boosts.find((x) => x.id === id);
  if (!b) return;
  const mine = S.slip.filter((s) => s.evId === b.evId);
  const same = mine.length === b.legs.length && b.legs.every((l) => mine.some((s) => s.key === l.key));
  S.slip = S.slip.filter((s) => s.evId !== b.evId);
  if (!same) {
    if (S.slip.length + b.legs.length > 20) { toast('Máximo de 20 seleções', 'err'); return; }
    for (const l of b.legs) S.slip.push({ key: l.key, evId: b.evId, odds: l.odds });
  }
  S.slipMode = S.slip.length >= 2 ? 'multiple' : 'single';
  S.slipTab = 'slip';
  render();
  if (!same) { await loadFull([b.evId]); ensureBB(true); render(); }
}

function homeBanner() {
  if (!S.user) return `<div class="banner"><div><h3>Crie sua conta grátis</h3><p>Cadastre-se em 1 minuto, deposite via PIX e aposte nos jogos que estão rolando agora.</p></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-ghost" data-action="login">Entrar</button><button class="btn btn-green" data-action="register">Cadastrar</button></div></div>`;
  if (isPaused()) return `<div class="banner"><div><h3>Conta em pausa</h3><p>Até ${fmtDT(S.user.excludedUntil)} não pode depositar nem apostar. Pode sacar o saldo quando quiser.</p></div><button class="btn btn-ghost" data-action="withdraw">Sacar</button></div>`;
  if (S.user.balance <= 0 && !S.bets.length) return `<div class="banner"><div><h3>Olá, ${esc(S.user.name.split(' ')[0])}! Faça seu primeiro depósito</h3><p>Deposite via PIX: o saldo é creditado em segundos.</p></div><button class="btn btn-green" data-action="deposit">Depositar</button></div>`;
  return '';
}

/* ---------------- cassino ---------------- */
const CASINO_GAMES = [
  { abrir: 'fortune-tiger', name: 'Fortune Tiger', tag: 'PG Soft', href: '#', desc: 'O tigre que paga', img: '/img/slots/fortune-tiger.webp' },
  { abrir: 'fortune-ox', name: 'Fortune Ox', tag: 'PG Soft', href: '#', desc: 'Touro da fortuna', img: '/img/slots/fortune-ox.webp' },
  { id: 'decola', name: 'Aviator', tag: 'Crash', href: '/decola', desc: 'Quanto mais alto, maior o multiplicador', img: '/img/decola-capa.webp?v=4' },
  { id: 'mines', name: 'Mines', tag: 'Minas', href: '/mines', desc: 'Encontre os diamantes e fuja das minas', img: '/img/mines-capa.webp?v=1' },
  { abrir: 'fortune-dragon', name: 'Fortune Dragon', tag: 'PG Soft', href: '#', desc: 'Dragão da fortuna', img: '/img/slots/fortune-dragon.webp' },
  { abrir: 'fortune-rabbit', name: 'Fortune Rabbit', tag: 'PG Soft', href: '#', desc: 'Coelho da sorte', img: '/img/slots/fortune-rabbit.webp' },
  { abrir: 'fortune-mouse', name: 'Fortune Mouse', tag: 'PG Soft', href: '#', desc: 'Rato da fortuna', img: '/img/slots/fortune-mouse.webp' },
  { abrir: 'bikini-paradise', name: 'Bikini Paradise', tag: 'PG Soft', href: '#', desc: 'Praia e prémios', img: '/img/slots/bikini-paradise.webp' },
  { abrir: 'jungle-delight', name: 'Jungle Delight', tag: 'PG Soft', href: '#', desc: 'Selva selvagem', img: '/img/slots/jungle-delight.webp' },
  { abrir: 'ganesha-gold', name: 'Ganesha Gold', tag: 'PG Soft', href: '#', desc: 'Deus da prosperidade', img: '/img/slots/ganesha-gold.webp' },
  { abrir: 'double-fortune', name: 'Double Fortune', tag: 'PG Soft', href: '#', desc: 'Fortuna em dobro', img: '/img/slots/double-fortune.webp' },
  { abrir: 'dragon-tiger-luck', name: 'Dragon Tiger Luck', tag: 'PG Soft', href: '#', desc: 'Dragão contra tigre', img: '/img/slots/dragon-tiger-luck.webp' },
  { abrir: 'ninja-raccoon', name: 'Ninja Raccoon Frenzy', tag: 'PG Soft', href: '#', desc: 'Guaxinim ninja', img: '/img/slots/ninja-raccoon.webp' },
  { abrir: 'lucky-clover', name: 'Lucky Clover Lady', tag: 'PG Soft', href: '#', desc: 'Trevo da sorte', img: '/img/slots/lucky-clover.webp' },
  { abrir: 'ultimate-striker', name: 'Ultimate Striker', tag: 'PG Soft', href: '#', desc: 'Futebol e prémios', img: '/img/slots/ultimate-striker.webp' },
  { abrir: 'prosper-ftree', name: 'Prosperity Fortune Tree', tag: 'PG Soft', href: '#', desc: 'Árvore da prosperidade', img: '/img/slots/prosper-ftree.webp' },
  { abrir: 'chicky-run', name: 'Chicky Run', tag: 'PG Soft', href: '#', desc: 'A galinha corredora', img: '/img/slots/chicky-run.webp' },
  { abrir: 'butterfly-blossom', name: 'Butterfly Blossom', tag: 'PG Soft', href: '#', desc: 'Borboletas douradas', img: '/img/slots/butterfly-blossom.webp' },
  { abrir: 'piggy-gold', name: 'Piggy Gold', tag: 'PG Soft', href: '#', desc: 'Porquinho da fortuna', img: '/img/slots/piggy-gold.webp' },
  { abrir: 'wild-bandito', name: 'Wild Bandito', tag: 'PG Soft', href: '#', desc: 'Fora da lei', img: '/img/slots/wild-bandito.webp' },
  { abrir: 'zombie-outbreak', name: 'Zombie Outbreak', tag: 'PG Soft', href: '#', desc: 'Zumbis na cidade', img: '/img/slots/zombie-outbreak.webp' },
  { abrir: 'majestic-ts', name: 'Majestic Treasures', tag: 'PG Soft', href: '#', desc: 'Tesouros majestosos', img: '/img/slots/majestic-ts.webp' },
  { abrir: 'thai-river', name: 'Thai River Wonders', tag: 'PG Soft', href: '#', desc: 'Rio tailandês', img: '/img/slots/thai-river.webp' },
  { abrir: 'gdn-ice-fire', name: 'Guardians of Ice & Fire', tag: 'PG Soft', href: '#', desc: 'Gelo e fogo', img: '/img/slots/gdn-ice-fire.webp' },
  { abrir: 'rise-apollo', name: 'Rise of Apollo', tag: 'PG Soft', href: '#', desc: 'O deus do sol', img: '/img/slots/rise-apollo.webp' },
  { abrir: 'wild-bounty-sd', name: 'Wild Bounty Showdown', tag: 'PG Soft', href: '#', desc: 'Caça ao tesouro', img: '/img/slots/wild-bounty-sd.webp' },
  { abrir: 'treasures-aztec', name: 'Treasures of Aztec', tag: 'PG Soft', href: '#', desc: 'Tesouros astecas', img: '/img/slots/treasures-aztec.webp' },
  { abrir: 'three-cz-pigs', name: 'Three Crazy Piggies', tag: 'PG Soft', href: '#', desc: 'Três porquinhos', img: '/img/slots/three-cz-pigs.webp' },
];
// Aviator e Mines só se estiverem ligados no servidor; os slots aparecem sempre ("Em breve" até haver licença oficial)
const casinoGames = () => CASINO_GAMES.filter((g) => (S.games && (g.abrir ? true : S.games[g.id])));
// provisório: só estes jogos podem ser jogados; os restantes aparecem como indisponíveis
const CASINO_AVAILABLE = new Set(['decola', 'mines', 'fortune-tiger', 'fortune-ox']);
const isSoon = (g) => !CASINO_AVAILABLE.has(g.abrir || g.id) || (!!g.abrir && !S.games.slots);
const casinoCard = (g) => isSoon(g)
  ? `<div class="cg-card soon" title="${esc(g.name)} — em breve" aria-disabled="true"><div class="cg-art"><img src="${g.img}" class="cg-cover" alt="${esc(g.name)}" loading="lazy" onerror="this.onerror=null;this.style.display='none'"><span class="cg-soon">Em breve</span></div></div>`
  : `<a class="cg-card" href="${g.href}"${g.abrir ? ` data-abrir="${g.abrir}" data-nome="${esc(g.name)}"` : ''} title="${esc(g.name)}"><div class="cg-art"><img src="${g.img}" class="cg-cover" alt="${esc(g.name)}" loading="lazy" onerror="this.onerror=null;this.style.display='none'"></div></a>`;
// página inicial: uma fila só com os jogos disponíveis (Fortune Tiger e Fortune Ox primeiro)
function homeCasino() {
  if (!S.casino) return '';
  const games = casinoGames().filter((g) => !isSoon(g));
  if (!games.length) return '';
  // data-key: o bloco só é recriado quando a lista de jogos muda (ver renderMain)
  return `<div id="homeCasino" data-key="${esc(games.map((g) => g.abrir || g.id).join(','))}">
    <div class="section-head"><h2>Cassino</h2><a href="/cassino" class="see-all" data-view="casino">Ver todos ›</a></div>
    <div class="cg-grid cg-row">${games.map(casinoCard).join('')}</div></div>`;
}
// abre um jogo: os slots usam data-abrir, o Aviator e o Mines têm página própria
const gameLink = (g, cls, inner) =>
  `<a class="${cls}" href="${g.href}"${g.abrir ? ` data-abrir="${g.abrir}" data-nome="${esc(g.name)}"` : ''} title="${esc(g.name)}">${inner}</a>`;
// faixa do topo do cassino: um só destaque (o primeiro jogo disponível, o Fortune Tiger)
function casinoHero() {
  const g = casinoGames().find((x) => !isSoon(x));
  if (!g) return '';
  return gameLink(g, 'cg-hero', `<img class="cg-hero-bg" src="${g.img}" alt="" onerror="this.onerror=null;this.style.display='none'">
    <span class="cg-hero-txt"><small>Em destaque</small><b>${esc(g.name)}</b>
    <span class="cg-hero-play">Jogar agora <span aria-hidden="true">▶</span></span></span>`);
}
function renderCasino() {
  if (!S.casino) return `<div class="empty-state">O cassino não está disponível neste momento.</div>`;
  const card = casinoCard;
  return `${casinoHero()}
    <div class="section-head"><h2>Jogos</h2><span class="muted">${casinoGames().filter((g) => !isSoon(g)).length} disponíveis</span></div>
    <div class="cg-grid">${casinoGames().map(card).join('')}</div>
    <p class="muted" style="font-size:12px;margin-top:18px">18+ · Jogue com responsabilidade. Os seus limites de perda e a pausa da conta valem também para o cassino.</p>`;
}

function renderMain() {
  const main = $('#main');
  if (!S.loaded) return;
  if (S.failed && !S.events.size) {
    S.lastMainHtml = null;
    main.innerHTML = `<div class="empty-state">Não foi possível carregar os jogos. Tentaremos de novo automaticamente.</div>`;
    return;
  }
  const scrollY = window.scrollY;
  let html = '';
  const v = S.view;
  if (v === 'event') html = renderEvent();
  else if (v === 'mybets') html = renderMyBetsPage();
  else if (v === 'casino') html = renderCasino();
  else {
    const live = filtered((e) => e.state === 'in');
    if (v === 'home') {
      html += homeHero(live);
      html += boostsBlock();
      html += homeCasino();
      html += sportTabs();
      const featured = live.filter((e) => e.markets || e.cm).sort((a, b) => LEAGUE_BY_KEY[a.league].order - LEAGUE_BY_KEY[b.league].order).slice(0, 8);
      if (featured.length) html += `<div class="section-head"><span class="live-dot"></span><h2>Ao vivo agora</h2><span class="muted">${live.length} eventos</span></div><div class="hero">${featured.map(heroCard).join('')}</div>`;
      const upcoming = filtered((e) => !e.outright && e.state === 'pre' && (isToday(e) || isTomorrow(e)) && (e.markets || e.cm) && !isSuspended(e));
      // longo prazo (campeão, artilheiro...): enquanto as apostas estiverem abertas
      const longTerm = filtered((e) => e.outright && e.cm && !isSuspended(e)).sort((a, b) => a.date - b.date);
      if (longTerm.length) html += `<div class="section-head"><h2>🏆 Longo prazo</h2><span class="muted">${longTerm.length} mercados</span></div>` + leagueBlocks(longTerm);
      html += `<div class="section-head"><h2>Próximos jogos</h2></div>`;
      html += upcoming.length ? leagueBlocks(upcoming, S.listLimit) : `<div class="empty-state">Nenhum jogo com odds disponível hoje.</div>`;
    } else {
      const titles = { all: 'Todos os jogos', live: 'Ao vivo', today: 'Hoje', tomorrow: 'Amanhã', results: 'Resultados', league: LEAGUE_BY_KEY[S.league]?.name, sport: SPORTS[S.sport]?.name };
      const preds = {
        live: (e) => e.state === 'in',
        all: (e) => e.state !== 'post',
        today: (e) => isToday(e) && e.state !== 'post',
        tomorrow: (e) => isTomorrow(e) && e.state === 'pre',
        results: (e) => e.state === 'post',
        league: (e) => e.league === S.league,
        sport: (e) => e.sport === S.sport && e.state !== 'post',
      };
      const list = filtered(preds[v]);
      if (v === 'live' || v === 'all') html += sportTabs();
      if (v === 'sport') html += boostsBlock(S.sport);
      if (v === 'league') html += boostsBlock(null, S.league);
      if (v === 'sport' || v === 'league') html += sportTop(v === 'sport' ? (e) => e.sport === S.sport : (e) => e.league === S.league);
      html += `<div class="section-head">${v === 'live' ? '<span class="live-dot"></span>' : ''}<h2>${esc(titles[v])}</h2><span class="muted">${list.length} eventos</span></div>`;
      if (v === 'league') {
        const lv = list.filter((e) => e.state === 'in'), pre = list.filter((e) => e.state === 'pre'), post = list.filter((e) => e.state === 'post');
        if (lv.length) html += leagueBlocks(lv);
        if (pre.length) html += leagueBlocks(pre);
        if (post.length) html += `<div class="section-head"><h2 style="font-size:16px">Resultados</h2></div>` + leagueBlocks(post);
        if (!list.length) html += `<div class="empty-state">Sem jogos desta liga hoje ou amanhã.</div>`;
      } else {
        html += list.length ? leagueBlocks(list, S.listLimit) : `<div class="empty-state">${v === 'live' ? 'Nenhum jogo ao vivo neste momento. Veja os próximos jogos em "Hoje".' : 'Nenhum evento encontrado.'}</div>`;
      }
    }
  }
  // nada mudou: não mexe na página (evita que as imagens pisquem a cada atualização)
  if (html === S.lastMainHtml && main.firstChild) { S.keepScroll = true; return; }
  // página diferente (outra vista/jogo): desenha de novo; a mesma página: muda só o que mudou (filas laterais,
  // emblemas, transmissão e posição ficam como estão — antes tudo era recriado a cada atualização e piscava)
  const pageKey = `${S.view}|${S.eventId || ''}|${S.league || ''}|${S.sport || ''}`;
  if (S.mainPage !== pageKey || !main.firstChild) { main.innerHTML = html; S.mainPage = pageKey; }
  else morph(main, html);
  S.lastMainHtml = html;
  tickClocks();
  if (moreObs) { moreObs.disconnect(); const mb = main.querySelector('.more-games'); if (mb) moreObs.observe(mb); }
  heroShow(S.heroIdx || 0, true);
  // a posição mantém-se sozinha; repô-la com scrollTo interrompia o deslize do dedo no telemóvel
  S.keepScroll = true;
}

/* topo de cada modalidade/liga, como na página inicial: transmissões, jogos ao vivo a deslizar (ou, sem jogos ao vivo,
   os mais importantes a seguir: ligas principais primeiro, por hora) */
function sportTop(pred) {
  const pool = filtered((e) => pred(e) && e.state !== 'post' && !e.outright);
  const order = (a, b) => (LEAGUE_BY_KEY[a.league]?.order ?? 999) - (LEAGUE_BY_KEY[b.league]?.order ?? 999) || a.date - b.date;
  let out = '';
  const tv = pool.filter((e) => e.stream).sort(order).slice(0, 10);
  if (tv.length) out += `<div class="section-head"><h2>📺 Assistir ao vivo</h2><span class="muted">${tv.length} com transmissão</span></div><div class="hero">${tv.map(heroCard).join('')}</div>`;
  const live = pool.filter((e) => e.state === 'in' && (e.markets || e.cm) && !e.stream).sort(order).slice(0, 10);
  if (live.length) out += `<div class="section-head"><span class="live-dot"></span><h2>Ao vivo agora</h2><span class="muted">${pool.filter((e) => e.state === 'in').length} eventos</span></div><div class="hero">${live.map(heroCard).join('')}</div>`;
  else {
    const next = pool.filter((e) => e.state === 'pre' && (e.markets || e.cm) && !isSuspended(e) && e.date - Date.now() < 36 * 3600000).sort(order).slice(0, 10);
    if (next.length) out += `<div class="section-head"><h2>⭐ Jogos em destaque</h2></div><div class="hero">${next.map(heroCard).join('')}</div>`;
  }
  return out;
}

/* mercados fechados (botão +/-): mostram só as linhas à volta da principal (odds mais equilibradas) ou as primeiras
   seleções; quem quiser ver tudo carrega no + */
const MKT_ROWS = 5, MKT_SELS = 8;
const mktOpen = (ev, name) => S.openMkts.has(`${ev.id}|${name}`);
function mainWindow(rows) {
  if (rows.length <= MKT_ROWS) return rows;
  const gap = ([, r]) => (r[0] && r[1] ? Math.abs(r[0].odds - r[1].odds) : Infinity);
  let best = 0;
  rows.forEach((x, i) => { if (gap(x) < gap(rows[best])) best = i; });
  const from = Math.max(0, Math.min(best - Math.floor(MKT_ROWS / 2), rows.length - MKT_ROWS));
  return rows.slice(from, from + MKT_ROWS);
}

// totais e handicaps dos mercados automáticos: uma linha por fila (Mais | Menos, ou casa | fora)
function linesTable(list, ev, open = true) {
  if (!list.length || !list.every((s) => s.cside && s.cline != null)) return '';
  const total = list[0].cside === 'over' || list[0].cside === 'under';
  const rows = new Map();
  for (const s of list) {
    const k = total ? s.cline : (s.cside === 'home' ? s.cline : -s.cline);
    if (!rows.has(k)) rows.set(k, {});
    rows.get(k)[total ? (s.cside === 'over' ? 0 : 1) : (s.cside === 'home' ? 0 : 1)] = s;
  }
  const head = total ? ['Mais de', 'Menos de'] : [ev.home.short, ev.away.short];
  const cell = (s, lbl) => (s ? oddBtn({ ...s, name: lbl }, ev, { wide: true, cls: 'wide-odd' }) : '<span class="odd empty wide-odd"><span class="val">-</span></span>');
  return `<div class="lines-tbl${total ? ' tot' : ''}"><div class="ln-head">${total ? '<span></span>' : ''}<span>${esc(head[0])}</span><span>${esc(head[1])}</span></div>
    ${(open ? (x) => x : mainWindow)([...rows].sort((a, b) => a[0] - b[0])).map(([k, r]) => `<div class="ln-row">${total ? `<span class="ln">${k}</span>` : ''}${cell(r[0], total ? '' : fmtLine(r[0]?.cline ?? k))}${cell(r[1], total ? '' : fmtLine(r[1]?.cline ?? -k))}</div>`).join('')}</div>`;
}

const EMPTY_ODD = '<span class="odd empty wide-odd"><span class="val">-</span></span>';
const oddCell = (ev, name) => (s) => (s ? oddBtn(name == null ? s : { ...s, name }, ev, { wide: true, cls: 'wide-odd' }) : EMPTY_ODD);
const cap = (t) => String(t).replace(/^./, (c) => c.toUpperCase());

/* margem de vitória e par/ímpar de cada equipa (pick "mh=..." / "par=h:..." casa, "ma=..." / "par=a:..." visitante):
   uma coluna por equipa, com o nome no topo e só a margem (ou Par/Ímpar) nos botões, por ordem da margem */
function teamCols(list, ev, open = true) {
  const sideOf = (s) => (/^(mh=|par=h:)/.test(String(s.pick)) ? 'h' : /^(ma=|par=a:)/.test(String(s.pick)) ? 'a' : null);
  if (!list.every(sideOf)) return '';
  const num = (s) => parseFloat(s.name) || 0;
  const col = (t, side) => list.filter((s) => sideOf(s) === side).map((s) => ({ ...s, name: String(s.name).startsWith(t.name) ? s.name.slice(t.name.length).trim() : s.name })).sort((x, y) => num(x) - num(y));
  return twoCols(col(ev.home, 'h'), col(ev.away, 'a'), ev, open);
}
function twoCols(h, a, ev, open) {
  if (!h.length || !a.length) return '';
  const n = open ? Math.max(h.length, a.length) : Math.min(Math.max(h.length, a.length), MKT_ROWS);
  const cell = oddCell(ev);
  return `<div class="lines-tbl"><div class="ln-head"><span>${esc(ev.home.name)}</span><span>${esc(ev.away.name)}</span></div>
    ${Array.from({ length: n }, (_, i) => `<div class="ln-row">${cell(h[i])}${cell(a[i])}</div>`).join('')}</div>`;
}
/* qualquer mercado em que todas as opções começam pelo nome de uma equipa/jogador ("Lucia Szabova por decisão",
   "Ondrej Mezera: mais de 38.5"): uma coluna por lado, sem repetir o nome */
function nameCols(list, ev, open = true) {
  const H = ev.home.name, A = ev.away.name, h = [], a = [], rest = [];
  const [first, second] = H.length >= A.length ? [[H, h], [A, a]] : [[A, a], [H, h]];
  for (const s of list) {
    const n = String(s.name), m = n.startsWith(first[0]) ? first : n.startsWith(second[0]) ? second : null;
    if (!m) { rest.push(s); continue; } // empate / "nenhum": fica por baixo, a toda a largura
    // tira o separador (": ", " - ", " e ") mas não o sinal de uma linha ("-2.5")
    const lbl = n.slice(m[0].length).replace(/^\s*(?:[:,]|[–—-](?=\s))?\s*/, '').replace(/^(?:e|and)\s+/i, '').replace(/^\((.*)\)$/, '$1').trim();
    if (!lbl) return '';
    m[1].push({ ...s, name: cap(lbl) });
  }
  if (rest.length > 2) return '';
  const cols = twoCols(h, a, ev, open);
  return cols && rest.length ? cols.replace(/<\/div>$/, rest.map((s) => `<div class="ln-row cs1">${oddCell(ev)(s)}</div>`).join('') + '</div>') : cols;
}

/* combinações em tabela: a fila (equipa, empate, "Mais de 2.5") à esquerda e o resto em colunas (Mais | Menos,
   Sim | Não, Ambas marcam Sim | Não). Picks: "res=home;tot=gt:239.5", "hc=home:-1.5;tot=lt:239.5", "res=home;bx=yes:100",
   "res=draw;btts=no", "tot=gt:2.5;btts=yes" */
const COMBO_RE = /^(res=(home|draw|away)|hc=(home|away):(-?[\d.]+)|tot=(gt|lt):([\d.]+));(tot|bx|btts)=(gt|lt|yes|no)(?::([\d.]+))?$/;
function comboGrid(list, ev) {
  const ps = list.map((s) => COMBO_RE.exec(String(s.pick)));
  if (!ps.every(Boolean) || new Set(ps.map((p) => p[7])).size > 1) return '';
  const kind = ps[0][7], byLine = new Map();
  list.forEach((s, i) => {
    const [, row, rs, hs, hl, tou, tl, , c, ln = ''] = ps[i], side = rs || hs;
    const label = side ? (side === 'draw' ? 'Empate' : ev[side].name + (hs ? ' ' + fmtLine(Number(hl)) : '') + (kind === 'bx' ? ' vence' : '')) : `${tou === 'gt' ? 'Mais' : 'Menos'} de ${tl}`;
    const rank = side ? { home: 0, draw: 1, away: 2 }[side] : tou === 'gt' ? 0 : 2;
    if (!byLine.has(ln)) byLine.set(ln, new Map());
    const rows = byLine.get(ln);
    if (!rows.has(row)) rows.set(row, { rank, label, tl: Number(tl) || 0 });
    rows.get(row)[c === 'gt' || c === 'yes' ? 0 : 1] = s;
  });
  const cell = oddCell(ev, '');
  const head = (ln) => (kind === 'bx' ? [`Os dois fazem ${ln}+: Sim`, 'Não'] : kind === 'btts' ? ['Ambas marcam: Sim', 'Não'] : [`Mais de ${ln}`, `Menos de ${ln}`]);
  return [...byLine].sort((a, b) => a[0] - b[0]).map(([ln, rows]) => `<div class="lines-tbl combo"><div class="ln-head"><span></span>${head(ln).map((h) => `<span>${esc(h)}</span>`).join('')}</div>
    ${[...rows.values()].sort((a, b) => a.tl - b.tl || a.rank - b.rank).map((r) => `<div class="ln-row"><span class="ln-team">${esc(r.label)}</span>${cell(r[0])}${cell(r[1])}</div>`).join('')}</div>`).join('');
}

/* "Sim X" / "Não X" (pick "tot=in:1-2" e "!tot=in:1-2"): uma fila por X, com Sim | Não */
function yesNoTable(list, ev, open = true) {
  if (list[0].market !== 'pcond' || !list.every((s) => /^(Sim|Não)\s+\S/.test(String(s.name)))) return '';
  const rows = new Map();
  for (const s of list) {
    const p = String(s.pick), k = p.replace(/^!/, ''), lbl = String(s.name).replace(/^(Sim|Não)\s+/, '').replace(/^\((.*)\)$/, '$1');
    if (!rows.has(k)) rows.set(k, { label: cap(lbl) });
    rows.get(k)[p.startsWith('!') ? 1 : 0] = s;
  }
  const cell = oddCell(ev, '');
  const rs = (open ? (x) => x : mainWindow)([...rows]);
  return `<div class="lines-tbl combo"><div class="ln-head"><span></span><span>Sim</span><span>Não</span></div>
    ${rs.map(([, r]) => `<div class="ln-row"><span class="ln-team">${esc(r.label)}</span>${cell(r[0])}${cell(r[1])}</div>`).join('')}</div>`;
}

/* total a 3 opções (pick "tot=gt:6" / "tot=eq:6" / "tot=lt:6"): uma fila por número, com Mais de | Exatamente | Menos de */
function threeWayTotal(list, ev, open = true) {
  const ps = list.map((s) => /^tot=(gt|eq|lt):(\d+(?:\.\d+)?)$/.exec(String(s.pick)));
  if (!ps.every(Boolean) || !ps.some((p) => p[1] === 'eq')) return '';
  const rows = new Map();
  list.forEach((s, i) => { const [, c, n] = ps[i]; if (!rows.has(n)) rows.set(n, {}); rows.get(n)[{ gt: 0, eq: 2, lt: 1 }[c]] = s; });
  const cell = oddCell(ev, '');
  const rs = (open ? (x) => x : mainWindow)([...rows].sort((a, b) => a[0] - b[0]));
  return `<div class="lines-tbl tot3"><div class="ln-head"><span></span><span>Mais de</span><span>Exatamente</span><span>Menos de</span></div>
    ${rs.map(([n, r]) => `<div class="ln-row"><span class="ln">${n}</span>${cell(r[0])}${cell(r[2])}${cell(r[1])}</div>`).join('')}</div>`;
}

/* total de uma equipa (pick "home:over", com linha): uma tabela Mais | Menos por equipa, a casa primeiro */
function teamLines(list, ev, open = true) {
  if (list[0].market !== 'pteam' || !list.every((s) => /^(home|away):(over|under)$/.test(String(s.pick)) && s.line != null)) return '';
  return ['home', 'away'].map((side) => {
    const sub = list.filter((s) => s.pick.startsWith(side)).map((s) => ({ ...s, cside: s.pick.split(':')[1], cline: s.line }));
    return sub.length ? `<div class="tl-team">${esc(ev[side].name)}</div>${linesTable(sub, ev, open)}` : '';
  }).join('');
}

/* placar exato (futebol, hóquei, sets e placar do set no ténis; pick "2-1" = casa-fora): três colunas — vitória da casa, empate, vitória de fora —
   cada uma da odd mais baixa para a mais alta; "outro placar" fica por baixo */
function scoreCols(list, ev, open = true) {
  if (!['cs', 'pcs', 'tscs', 'sets'].includes(list[0].market)) return '';
  const cols = [[], [], []], rest = [];
  for (const s of list) {
    const m = /^(\d+)-(\d+)$/.exec(String(s.pick));
    if (!m) { rest.push(s); continue; }
    const h = +m[1], a = +m[2];
    cols[h > a ? 0 : h === a ? 1 : 2].push({ ...s, name: `${h}-${a}` });
  }
  if (!cols[0].length && !cols[2].length) return '';
  cols.forEach((c) => c.sort((x, y) => x.odds - y.odds));
  const used = cols.map((c, i) => [c, [ev.home.name, 'Empate', ev.away.name][i]]).filter(([c]) => c.length);
  const max = Math.max(...used.map(([c]) => c.length)), n = open ? max : Math.min(max, MKT_ROWS);
  const cell = oddCell(ev);
  return `<div class="lines-tbl" style="--c:${used.length}"><div class="ln-head cs">${used.map(([, h]) => `<span>${esc(h)}</span>`).join('')}</div>
    ${Array.from({ length: n }, (_, i) => `<div class="ln-row cs">${used.map(([c]) => cell(c[i])).join('')}</div>`).join('')}
    ${n === max ? rest.map((s) => `<div class="ln-row cs1">${cell(s)}</div>`).join('') : ''}</div>`;
}

/* jogadores (basquete "10#away#James Harden"; futebol "2#home#Nome", com ou sem equipa; marcadores do hóquei
   "home#Nome"): grelha com os jogadores à esquerda (casa primeiro, separados por equipa) e as linhas em cima ("10+",
   "A qualquer momento"); fechado mostra MKT_PL por equipa */
const MKT_PL = 4;
const PL_COL = { 'score or assist': 'Marca ou assiste', 'or assist': 'Marca ou assiste', 'ou assist': 'Marca ou assiste', assist: 'Assiste', score: 'Marca', '': 'Marca' };
function playerGrid(list, ev, open = true) {
  if (!['bp', 'pp', 'hgs'].includes(list[0].market)) return '';
  const cols = new Map(), teams = { home: new Map(), away: new Map(), '': new Map() };
  for (const s of list) {
    const parts = String(s.pick).split('#'), [side, pl] = parts.length >= 3 ? [parts[1], parts.slice(2).join('#')] : [parts[0], parts[1]];
    if (!teams[side] || !pl) return '';
    const nm = String(s.name), raw0 = nm.includes(' — ') ? nm.split(' — ')[1] : nm.split(pl).join(' ').replace(/\s+/g, ' ').trim();
    const raw = raw0.replace(/^Marca (?=\d)/, '').replace(/^Marca a qualquer/, 'A qualquer').replace(/ a marcar$/, ''); // marcadores do hóquei: "Primeiro", "2+"
    const n = /^(\d+)(?:\+| ou mais)/.exec(raw);
    const col = n ? `n${n[1]}` : raw;
    if (!cols.has(col)) cols.set(col, { key: n ? Number(n[1]) : -1, idx: cols.size, label: n ? `${n[1]}+` : PL_COL[raw.toLowerCase()] || cap(raw) });
    if (!teams[side].has(pl)) teams[side].set(pl, {});
    teams[side].get(pl)[col] = s;
  }
  // só linhas ("10+", "15+"): por número; com nomes ("Primeiro", "2+"): pela ordem da fonte
  const cs = [...cols].sort((a, b) => ([...cols.values()].some((c) => c.key < 0) ? a[1].idx - b[1].idx : a[1].key - b[1].key));
  const cell = oddCell(ev, '');
  const block = (side) => {
    const ps = [...teams[side]].slice(0, open ? undefined : MKT_PL);
    return ps.length ? (side ? `<div class="pl-team">${esc(ev[side].name)}</div>` : '') + ps.map(([pl, r]) => `<span class="pl-name">${esc(pl)}</span>${cs.map(([c]) => cell(r[c])).join('')}`).join('') : '';
  };
  return `<div class="pl-wrap"><div class="pl-grid" style="--n:${cs.length}"><span class="pl-name pl-h"></span>${cs.map(([, c]) => `<span class="pl-h">${esc(c.label)}</span>`).join('')}${block('home')}${block('away')}${block('')}</div></div>`;
}
/* jogadores do basquete num cartão só: um botão por estatística (Pontos, Rebotes...), filtro por equipa e, dentro,
   a linha mais/menos (uma fila por jogador: linha | Mais | Menos) e as marcas "N ou mais" em grelha.
   Antes eram ~20 mercados empilhados e a mais/menos virava uma escada com uma coluna por linha. */
const BP_FAM = [
  ['pts', 'Pontos'], ['reb', 'Rebotes'], ['ast', 'Assistências'], ['tpm', 'Cestas de 3'], ['pra', 'Pts + Reb + Ast'],
  ['pr', 'Pts + Reb'], ['pa', 'Pts + Ast'], ['ar', 'Ast + Reb'], ['stl', 'Roubos'], ['blk', 'Tocos'], ['sb', 'Roubos + Tocos'],
  ['dd', 'Duplo / triplo-duplo', ['dd', 'td']], ['fb', 'Primeiro lance', ['fb', 'fa']],
];
const bpStat = (s) => String(s.per ?? '').split('|')[0];
const bpIsOU = (l) => l.every((s) => / — (Mais|Menos) de /.test(s.name));
function bpPanel(lists, ev) {
  const all = lists.flat();
  // ao vivo a fonte não diz a equipa: vem do box score, que abrevia o nome ("D Avdija")
  const short = (n) => { const [f = '', ...r] = String(n).trim().split(/\s+/); return `${f[0] || ''} ${r.join(' ')}`.toLowerCase(); };
  const roster = new Map();
  for (const w of ['home', 'away']) for (const x of ev.stats?.players?.[w] || []) roster.set(String(x.n).toLowerCase(), w).set(short(x.n), w);
  const fix = (s) => {
    const p = String(s.pick).split('#'), n = p.slice(2).join('#'), w = roster.get(n.toLowerCase()) || roster.get(short(n));
    return p.length >= 3 && !p[1] && w ? { ...s, pick: [p[0], w, ...p.slice(2)].join('#') } : s;
  };
  const sideOf = (s) => String(s.pick).split('#')[1] || '';
  const fams = BP_FAM.filter(([k, , ks = [k]]) => all.some((s) => ks.includes(bpStat(s))));
  if (!fams.length) return '';
  const [fk, , fks = [fk]] = fams.find(([k]) => k === S.bpStat) || fams[0];
  const team = ['home', 'away'].includes(S.bpTeam) ? S.bpTeam : 'all';
  const open = mktOpen(ev, `bp:${fk}`);
  const secs = lists.filter((l) => fks.includes(bpStat(l[0])))
    .map((l) => l.map(fix).filter((s) => team === 'all' || sideOf(s) === team || !sideOf(s)))
    .filter((l) => l.length).sort((a, b) => bpIsOU(b) - bpIsOU(a));
  // as marcas na mesma ordem da linha mais/menos (os de linha mais alta em cima)
  const lineOf = new Map();
  for (const s of secs.filter(bpIsOU).flat()) { const m = / — (?:Mais|Menos) de ([\d.]+)$/.exec(s.name); if (m) lineOf.set(String(s.pick).split('#').slice(2).join('#'), Number(m[1])); }
  const rank = (s) => lineOf.get(String(s.pick).split('#').slice(2).join('#')) ?? -1;
  for (const l of secs) if (!bpIsOU(l)) l.sort((a, b) => rank(b) - rank(a));
  let more = false;
  const body = secs.map((l) => {
    const ou = bpIsOU(l), mile = !ou && l.every((s) => / ou mais$/.test(s.name));
    const title = ou ? 'Mais / menos' : mile ? 'Marcas (N ou mais)' : String(l[0].marketName).replace(/ do jogador.*$/, '');
    let grid;
    if (ou) grid = bpOuTable(l, ev, open);
    else { grid = playerGrid(l, ev, open); if (!open && grid !== playerGrid(l, ev, true)) more = true; }
    if (ou && !open && grid !== bpOuTable(l, ev, true)) more = true;
    return `<div class="bp-sec"><div class="bp-sub">${esc(title)}</div>${grid}</div>`;
  }).join('') || '<div class="empty-state" style="padding:16px">Sem linhas desta equipa.</div>';
  const chip = (attr, v, on, label) => `<button class="${on ? 'active' : ''}" data-${attr}="${v}">${esc(label)}</button>`;
  const teams = new Set(all.map(fix).map(sideOf));
  return `<div class="market bp-panel"><div class="market-head">Jogadores${ev.state === 'in' ? '<small>Ao vivo</small>' : ''}</div>
    <div class="bp-chips">${fams.map(([k, label]) => chip('bpstat', k, k === fk, label)).join('')}</div>
    ${teams.has('home') && teams.has('away') ? `<div class="bp-teams">${chip('bpteam', 'all', team === 'all', 'Todos')}${chip('bpteam', 'home', team === 'home', ev.home.name)}${chip('bpteam', 'away', team === 'away', ev.away.name)}</div>` : ''}
    ${body}${more || open ? `<button class="mkt-tog" data-mkt="bp:${fk}">${open ? 'Mostrar menos ▴' : 'Mostrar todos os jogadores ▾'}</button>` : ''}</div>`;
}
// mais/menos: jogador | linha | Mais | Menos, por equipa (casa primeiro), os de linha mais alta em cima
function bpOuTable(list, ev, open) {
  const rows = new Map();
  for (const s of list) {
    const [, side = '', ...pl] = String(s.pick).split('#'), name = pl.join('#'), m = / — (Mais|Menos) de ([\d.]+)$/.exec(s.name);
    if (!m) continue;
    const r = rows.get(name) || { side, name, line: Number(m[2]) };
    r[m[1] === 'Mais' ? 'o' : 'u'] = s; rows.set(name, r);
  }
  const cell = oddCell(ev, '');
  const block = (side) => {
    const rs = [...rows.values()].filter((r) => r.side === side).sort((a, b) => b.line - a.line).slice(0, open ? undefined : MKT_PL);
    return rs.length ? (side ? `<div class="pl-team">${esc(ev[side].name)}</div>` : '') + rs.map((r) => `<span class="pl-name">${esc(r.name)}</span><span class="bp-line">${r.line}</span>${cell(r.o)}${cell(r.u)}`).join('') : '';
  };
  return `<div class="pl-wrap"><div class="pl-grid bp-ou"><span class="pl-name pl-h"></span><span class="pl-h">Linha</span><span class="pl-h">Mais</span><span class="pl-h">Menos</span>${block('home')}${block('away')}${block('')}</div></div>`;
}
// a tabela de cada mercado (a primeira que serve), aberta e como fica agora; null = botões normais
const GRIDS =[linesTable, teamLines, teamCols, comboGrid, yesNoTable, threeWayTotal, scoreCols, playerGrid, nameCols];
function marketGrid(list, ev, open) {
  for (const g of GRIDS) { const full = g(list, ev, true); if (full) return { full, body: open ? full : g(list, ev, false) }; }
  return null;
}

/* Secções da página do jogo. Cada secção diz que seleções mostra; um mercado pode estar em várias
   (ex.: "Vencedor do 1º set" aparece em "1º set" e em "Sets"). */
// secções dos mercados da equipa (vêm com "cat" do leitor da fonte)
const CAT_LABEL = {
  pop: 'Principais', goals: 'Gols', hcp: 'Handicaps e totais', halves: '1º / 2º tempo', corners: 'Escanteios', cards: 'Cartões',
  players: 'Jogadores', stats: 'Estatísticas', quarters: 'Quartos', periods: 'Períodos', points: 'Ponto a ponto', games: 'Games',
  sets: 'Sets', serve: 'Saque', other: 'Outros',
};
const catLabel = (c) => CAT_LABEL[c] || (/^map(\d+)$/.test(c) ? `Mapa ${c.slice(3)}` : 'Outros');
function eventTabs(ev) {
  const base = sportTabsOf(ev);
  // os mercados da equipa entram na secção com o mesmo nome; os que não têm secção própria ganham uma
  // mercados com secção da fonte (da equipa e por parte do jogo) entram na secção com o mesmo nome
  const tabs = base.map((t) => (t.id === 'all' ? t : { ...t, has: (s) => (s.cat ? s.cat === t.id : t.has(s)) }));
  const cats = [...new Set(selections(ev).filter((s) => s.cat).map((s) => s.cat))].filter((c) => !tabs.some((t) => t.id === c));
  cats.sort((a, b) => (a === 'other') - (b === 'other') || a.localeCompare(b, undefined, { numeric: true }));
  // futebol e basquete: "Criar aposta" antes de "Todos", só com as seleções que o motor sabe juntar
  const bb = bbOk(ev) ? [{ id: 'bb', label: 'Criar aposta', has: (s) => !!s.bb }] : [];
  return bb.concat(tabs, cats.map((c) => ({ id: c, label: catLabel(c), has: (s) => s.cat === c })));
}
/* aba Criar aposta: as seleções deste jogo no boletim e a odd junta (calculada pelo servidor) */
function bbPanel(ev) {
  const mine = S.slip.filter((s) => s.evId === ev.id);
  if (mine.length < 2) return `<div class="bb-hint"><span class="bb-tag">Criar aposta</span><span>${mine.length ? 'Escolha mais uma seleção deste jogo para juntar numa odd só' : `Escolha de 2 a ${BB_MAX} seleções deste jogo e junte numa odd só`}</span></div>`;
  const q = bbOf(mine);
  return `<div class="slip-bb bb-panel ${q?.reason ? 'bad' : ''}">
    <div class="bb-head"><span class="bb-tag ${q?.boost ? 'boost' : ''}">${q?.boost ? '⚡ Super Odd' : 'Criar aposta'}</span><span class="bb-odd">${q?.odds ? `${q.boost && q.base ? `<span class="old">${fmtOdd(q.base)}</span>` : q.prev && q.prev !== q.odds ? `<span class="old">${fmtOdd(q.prev)}</span>` : ''}${fmtOdd(q.odds)}` : q?.reason ? '—' : '…'}</span></div>
    <div class="bb-chain">${mine.map((s) => { const { sel } = findSel(s.key); return `<div class="bb-leg ${s.key === q?.bad ? 'bad' : ''}"><button class="x" data-remove="${esc(s.key)}" title="Remover">×</button><span class="bb-dot"></span><div><div>${esc(sel ? sel.name : 'Seleção indisponível')}</div><div class="si-market">${esc(sel ? sel.marketName : '')}</div></div></div>`; }).join('')}</div>
    ${q?.reason ? `<div class="si-warn red">${esc(q.reason)}</div>` : !q?.odds ? '<div class="si-warn">A calcular a odd…</div>' : ''}
  </div>`;
}
function sportTabsOf(ev) {
  const K = (...ks) => (s) => ks.includes(s.market);
  const setOf = (s) => Number(String(s.per ?? '').split(/[:/]/)[0]) || 0;
  const all = { id: 'all', label: 'Todos', has: () => true };
  if (ev.sport === 'esports') {
    // um separador por mapa (os mercados da equipa trazem "mapN"; o vencedor do mapa também entra)
    const maps = [...new Set(selections(ev).filter((s) => s.market === 'emw').map((s) => s.per))].sort();
    return [all, { id: 'pop', label: 'Principais', has: K('ml', 'ecs', 'emh', 'e1m') },
      ...maps.map((n) => ({ id: `map${n}`, label: `Mapa ${n}`, has: (s) => s.market === 'emw' && s.per === n }))];
  }
  if (ev.sport === 'tennis') {
    // ao vivo: "set atual" em vez de "1º set"
    const n = ev.state === 'in' ? (ev.home.score || 0) + (ev.away.score || 0) + 1 : 1;
    const SET_K = ['tsw', 'tscs', 'tscg', 'tsca', 'tsgt', 'tsgh', 'tslead', 'tsafter', 'tsrace', 'tstbw', 'tsbrk', 'tgw', 'tgs', 'tgd', 'tgsw', 'tgpw', 'tgpd'];
    return [all,
      { id: 'pop', label: 'Principais', has: (s) => K('ml', 'sets', 'tsets', 'gtotal', 'gspread', 'tmrt')(s) || (s.market === 'tsw' && setOf(s) === n) },
      { id: 'set', label: `${n}º set`, has: (s) => (SET_K.includes(s.market) && setOf(s) === n) || (s.market === 'tpbrk' && String(s.per).endsWith(`:${n}`)) },
      { id: 'sets', label: 'Sets', has: K('sets', 'tsets', 'tsw', 'tscs', 'tscg', 'tsca', 'tsgt', 'tstbw', 'tcast', 'tstraight', 'tdist', 'tdr', 'ttb') },
      { id: 'games', label: 'Games', has: K('tgw', 'tgs', 'tgd', 'tgsw', 'tgpw', 'tgpd', 'tslead', 'tsafter', 'tsrace', 'toe') },
      { id: 'serve', label: 'Saque', has: K('tfswin', 'tfsg', 'tfsw', 'tfsd', 'tsbrk', 'tfbrk', 'tpbrk', 'tbrk') },
      { id: 'hcp', label: 'Handicaps e totais', has: K('gspread', 'gtotal', 'tsgh', 'tsgt', 'tpgw', 'tmrt', 'ttb', 'tbrk', 'tpbrk') },
      { id: 'players', label: 'Jogadores', has: K('tpto', 'tpgw', 'tace', 'tdf') },
    ];
  }
  if (ev.sport === 'tabletennis') {
    return [all,
      { id: 'pop', label: 'Principais', has: K('ml', 'ttsh', 'ttcs', 'ttpt') },
      { id: 'sets', label: 'Sets', has: K('ttcs', 'ttgw', 'ttgh', 'ttgt', 'ttgwt', 'ttgp', 'ttgm', 'ttgx', 'ttdr') },
      { id: 'pts', label: 'Pontos', has: K('ttpt', 'ttph', 'ttgt', 'ttgh', 'ttgp', 'ttmp', 'ttoe', 'ttrt') },
    ];
  }
  if (ev.sport === 'mma') {
    return [all,
      { id: 'pop', label: 'Principais', has: K('ml', 'fmov') },
      { id: 'rounds', label: 'Rounds', has: K('total', 'fround', 'fdist') },
    ];
  }
  if (ev.sport === 'soccer') {
    return [all,
      { id: 'pop', label: 'Principais', has: K('ml', 'dc', 'dnb', 'btts') },
      { id: 'goals', label: 'Gols', has: K('total', 'btts') },
      { id: 'hcp', label: 'Handicaps', has: K('spread') },
      { id: 'cs', label: 'Placar exato', has: K('cs') },
    ];
  }
  return [all,
    { id: 'pop', label: 'Principais', has: K('ml', 'mlr', 'dcr') },
    { id: 'hcp', label: 'Handicaps e totais', has: K('spread', 'total') },
  ];
}
// evento de longo prazo: título, prazo de fechamento e os mercados (lista de participantes)
function renderOutright(ev, sels) {
  const closed = isSuspended(ev);
  let html = `<a href="#" class="back" data-action="back">← Voltar</a>
  <div class="ev-detail-head">
    <div class="hero-top"><span>${SPORTS[ev.sport].icon} ${esc(ev.leagueName)} · ${esc(ev.country)}</span><span>🏆 Longo prazo</span></div>
    <div class="out-title">${esc(ev.home.name)}</div>
    <div class="big-clock" style="color:var(--muted);text-align:center">${closed ? 'Apostas encerradas — à espera do resultado' : 'Apostas até ' + dateLabel(ev.date)}</div>
  </div>`;
  const groups = {};
  for (const s of sels) (groups[s.marketName] ||= []).push(s);
  if (!sels.length) html += `<div class="empty-state">Nenhum mercado aberto para este evento.</div>`;
  for (const [name, list] of Object.entries(groups)) {
    const c = list[0].cclose;
    html += `<div class="market"><div class="market-head">${esc(name)}${c ? `<small>${Date.now() >= c ? 'fechado' : 'até ' + dateLabel(new Date(c))}</small>` : ''}</div><div class="market-body many">${list.map((s) => oddBtn(s, ev, { wide: true, cls: 'wide-odd' })).join('')}</div></div>`;
  }
  return html;
}

// transmissão do jogo: o player fica entre as marcas STREAM_* e o renderMain nunca o recria enquanto for o mesmo (não recarrega o vídeo)
const STREAM_A = '<!--stream-->', STREAM_B = '<!--/stream-->';
function streamSrc(st) {
  const h = encodeURIComponent(location.hostname || 'localhost'), id = encodeURIComponent(st.id);
  if (st.type === 'twitch') return `https://player.twitch.tv/?channel=${id}&parent=${h}&muted=true`;
  if (st.type === 'twitch-video') return `https://player.twitch.tv/?video=${id}&parent=${h}&muted=true`;
  if (st.type === 'youtube') return `https://www.youtube.com/embed/${id}?autoplay=1&mute=1`;
  if (st.type === 'youtube-channel') return `https://www.youtube.com/embed/live_stream?channel=${id}&autoplay=1&mute=1`;
  if (st.type === 'kick') return `https://player.kick.com/${id}?muted=true`;
  return null;
}
function streamBlock(ev) {
  const src = ev.stream && ev.state !== 'post' ? streamSrc(ev.stream) : null;
  if (!src) return '';
  const head = `<div class="stream-head"><span>${ev.state === 'in' ? '<span class="live-dot"></span> ' : ''}📺 Transmissão</span><button class="link-btn" data-action="stream-toggle">${S.streamHidden ? 'Mostrar' : 'Esconder'}</button></div>`;
  if (S.streamHidden) return head;
  return head + STREAM_A + `<div class="stream-box" id="streamBox" data-src="${esc(src)}"><iframe src="${esc(src)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" title="Transmissão"></iframe></div>` + STREAM_B;
}

// mercado liquidado pela equipa: aviso no cabeçalho do mercado (o pagamento sai depois de a equipa confirmar)
const manualNote = (list) => (list[0]?.manual ? '<small title="Resultado confirmado pela equipe depois do jogo; aposta máxima mais baixa">confirmado pela equipa</small>' : '');

function renderEvent() {
  const ev = S.events.get(S.eventId);
  if (!ev) return `<a href="#" class="back" data-action="back">← Voltar</a><div class="empty-state">Evento não encontrado.</div>`;
  if (ev.outright) return renderOutright(ev, selections(ev));
  if (ev.awaiting) return `<a href="#" class="back" data-action="back">← Voltar</a><div class="empty-state">Este jogo terminou. O resultado das suas apostas aparece em <a href="/minhas-apostas" data-view="mybets">Minhas apostas</a>.</div>`;
  const sels = selections(ev);
  const groups = {};
  for (const s of sels) (groups[s.marketName] ||= []).push(s);
  /* o mesmo nome com vencedor, handicap e total juntos (ex.: "1º período" no hóquei) fica em três mercados; os
     marcadores do hóquei ("Marcadores — Primeiro a marcar", "— Último"...) ficam numa só grelha */
  const SPLIT = { pml2: 'vencedor', p1x2: 'vencedor', pspr: 'handicap', ptot: 'total' };
  const regrouped = {};
  for (const [n, l] of Object.entries(groups)) {
    delete groups[n];
    if (new Set(l.map((s) => s.market)).size > 1 && l.every((s) => SPLIT[s.market])) for (const s of l) (regrouped[`${n}: ${SPLIT[s.market]}`] ||= []).push(s);
    else if (l[0].market === 'hgs' && n.includes(' — ')) { const [base, col] = n.split(' — '); (regrouped[base] ||= []).push(...l.map((s) => ({ ...s, name: `${String(s.pick).split('#')[1]} — ${col}` }))); }
    else regrouped[n] = l;
  }
  Object.assign(groups, regrouped);
  // intervalo / final na ordem da bet365: primeiro os que acabam com a casa a ganhar, depois os da visitante
  const HTFT = ['home-home', 'draw-home', 'away-home', 'home-away', 'draw-away', 'away-away', 'home-draw', 'draw-draw', 'away-draw'];
  // os outros: casa primeiro, depois o que não é de nenhuma equipa (empate, "outro resultado"), depois a visitante
  const sideRank = (s) => (String(s.name).includes(ev.home.name) ? 0 : String(s.name).includes(ev.away.name) ? 2 : 1);
  for (const l of Object.values(groups)) {
    if (l[0].market === 'phtft') l.splice(0, l.length, ...l.map((s) => ({ ...s, name: String(s.name).replace(' - ', ' / ') })).sort((a, b) => HTFT.indexOf(a.pick) - HTFT.indexOf(b.pick)));
    else if (l.some((s) => sideRank(s) !== 1)) l.sort((a, b) => sideRank(a) - sideRank(b));
    // Sim antes de Não; períodos/tempos/quartos por ordem, com o empate no fim
    else if (l.every((s) => /^(Sim|Não)$/.test(s.name))) l.sort((a, b) => (a.name === 'Não') - (b.name === 'Não'));
    else if (['hphs', 'phs'].includes(l[0].market)) l.sort((a, b) => /tie/.test(a.pick) - /tie/.test(b.pick) || String(a.pick).localeCompare(String(b.pick)));
  }
  const form =(f) => (f ? `<div class="form">${f.split('').slice(-5).map((c) => `<i class="${c}">${c === 'W' ? 'V' : c === 'L' ? 'D' : 'E'}</i>`).join('')}</div>` : '');
  const status = ev.state === 'in' ? `<div class="big-clock"><span class="live-dot"></span> ${clockHtml(ev)}${ev.alive ? ` · 👥 ${ev.alive.h} v ${ev.alive.a}` : ''}</div>`
    : `<div class="big-clock" style="color:var(--muted)">${ev.state === 'post' ? esc(ev.clock) : dateLabel(ev.date)}</div>`;
  const score = ev.state === 'pre' ? 'vs' : `${ev.home.score ?? 0} : ${ev.away.score ?? 0}`;
  let html = `<a href="#" class="back" data-action="back">← Voltar</a>
  <div class="ev-detail-head">
    <div class="hero-top"><span>${SPORTS[ev.sport].icon} ${esc(ev.leagueName)} · ${esc(ev.country)}</span><span>${esc(ev.venue)}</span></div>
    <div class="ev-detail-teams">
      <div class="hero-team">${crest(ev.home)}${esc(ev.home.name)}${form(ev.home.form)}</div>
      <div><div class="big-score">${score}</div>${status}${shootoutHtml(ev)}</div>
      <div class="hero-team">${crest(ev.away)}${esc(ev.away.name)}${form(ev.away.form)}</div>
    </div>
  </div>${streamBlock(ev)}`;
  if (ev.state !== 'post') {
    if ((ev.suspendedUntil || 0) > Date.now()) html += `<div class="suspended-banner">🔒 Mercados suspensos temporariamente (gol / lance perigoso). Reabrem em instantes.</div>`;
    if (!sels.length) html += `<div class="empty-state">Nenhum mercado aberto para este evento no momento.</div>`;
    // secções (como na bet365): só aparecem as que têm mercados; "Todos" mostra tudo
    const tabs = eventTabs(ev).filter((t) => t.id === 'all' || sels.some((s) => t.has(s)));
    let tab = S.evTab?.id === ev.id ? S.evTab.tab : 'all';
    if (!tabs.some((t) => t.id === tab)) tab = 'all';
    const cur = tabs.find((t) => t.id === tab);
    if (tabs.length > 2) html += `<div class="tabs ev-tabs">${tabs.map((t) => `<button class="${t.id === tab ? 'active' : ''}${t.id === 'bb' ? ' bb-tab' : ''}" data-evtab="${t.id}">${esc(t.label)}<span class="tab-cnt">${t.id === 'all' ? Object.keys(groups).length : new Set(sels.filter((s) => t.has(s)).map((s) => s.marketName)).size}</span></button>`).join('')}</div>`;
    if (tab === 'bb') html += bbPanel(ev);
    // odds recalculadas com as escolhidas (só as do pedido para as escolhidas de agora)
    const mine = S.slip.filter((s) => s.evId === ev.id), mineKey = bbKey(mine);
    const loc = tab === 'bb' ? bbLocal(ev, mine) : undefined;
    bbShow = tab !== 'bb' || !mineKey ? null : loc !== undefined ? loc.odds : S.bbPrev?.k === mineKey ? S.bbPrev.odds : null;
    bbMine = tab === 'bb' && mine.length > 1 ? bbOf(mine)?.odds || loc?.mine || null : null;
    // modelo do jogo pedido logo ao abrir a página (o primeiro clique já calcula na hora)
    // basquete e ténis ao vivo: só para quem usa o Criar aposta (aba aberta ou seleção deste jogo no boletim)
    if (bbOk(ev) && (ev.sport === 'soccer' || ev.state !== 'in' || tab === 'bb' || S.slip.some((s) => s.evId === ev.id))) queueMicrotask(() => ensureModel(ev));
    if (tab === 'bb') queueMicrotask(ensurePreview);
    // totais e handicaps aparecem em tabela (uma linha por fila); no Criar aposta só as seleções que o motor junta
    let entries = tab === 'bb' ? Object.entries(groups).map(([n, l]) => [n, l.filter((s) => s.bb)]).filter(([, l]) => l.length)
      : Object.entries(groups).filter(([, list]) => cur.has(list[0]));
    // mercados em par (um por equipa, ex.: "Total de pontos: X"): o da casa logo antes do da visitante
    for (let i = 0; i < entries.length; i++) {
      const nm = entries[i][0];
      if (!nm.includes(ev.away.name)) continue;
      const j = entries.findIndex(([n]) => n === nm.replace(ev.away.name, ev.home.name));
      if (j > i) entries.splice(i, 0, entries.splice(j, 1)[0]);
    }
    // mercados da equipa em melhor de 3, 5...: os da partida primeiro, depois um bloco por mapa (nome e quem o escolheu)
    const multi = new Set(entries.map(([, l]) => l[0].cgroup).filter(Boolean)).size > 1;
    if (multi) {
      const gnum = (g) => (g ? parseInt(g.replace(/\D+/g, ''), 10) || 0 : -1);
      entries = entries.map((e, i) => [e, i]).sort((x, y) => gnum(x[0][1][0].cgroup) - gnum(y[0][1][0].cgroup) || x[1] - y[1]).map(([e]) => e);
    }
    let lastGroup;
    // jogadores do basquete: um cartão só, onde aparece o primeiro deles
    const bpLists = entries.filter(([, l]) => l[0].market === 'bp').map(([, l]) => l);
    for (const [rawName, list] of entries) {
      if (list[0].market === 'bp') { if (list === bpLists[0]) html += bpPanel(bpLists, ev); continue; }
      const g = list[0].cgroup || null;
      if (g !== lastGroup && multi) {
        const mi = ev.maps?.[(parseInt(String(g).replace(/\D+/g, ''), 10) || 0) - 1];
        const extra = mi ? [mi.name, mi.pick ? `escolha de ${(mi.pick === 'h' ? ev.home : ev.away).name}` : ''].filter(Boolean).join(' · ') : '';
        html += `<div class="map-head">${esc(g || 'Partida')}${extra ? `<small> · ${esc(extra)}</small>` : ''}</div>`;
      }
      lastGroup = g;
      const name = g && rawName.startsWith(g + ' — ') ? rawName.slice(g.length + 3) : rawName;
      const cc = list[0].cclose; // prazo de fechamento próprio do mercado
      const note = cc ? `<small>${Date.now() >= cc ? 'fechado' : 'apostas até ' + dateLabel(new Date(cc))}</small>` : manualNote(list) || (ev.state === 'in' ? '<small>Ao vivo</small>' : '');
      const open = mktOpen(ev, rawName);
      const grid = marketGrid(list, ev, open), full = grid?.full;
      const body = grid ? grid.body : `<div class="market-body${list.length > 4 ? ' many' : ''}">${(open ? list : list.slice(0, MKT_SELS)).map((s) => oddBtn(s, ev, { wide: true, cls: 'wide-odd' })).join('')}</div>`;
      // só tem botão quem tem mais do que cabe fechado
      const tog = (full ? body !== full : list.length > MKT_SELS) || open ? `<button class="mkt-tog" data-mkt="${esc(rawName)}">${open ? 'Mostrar menos ▴' : 'Mostrar mais ▾'}</button>` : '';
      html += `<div class="market"><div class="market-head">${esc(name)}${note}</div>${body}${tog}</div>`;
    }
  }
  bbShow = bbMine = null;
  html += statsPanel(ev);
  const tl = (ev.details || []).filter((d) => d.goal || d.red || d.yellow);
  if (tl.length) {
    html += `<div class="section-head" style="margin-top:16px"><h2 style="font-size:16px">Lances</h2></div><div class="timeline">` +
      tl.slice().reverse().map((d) => `<div class="tl-item ${d.teamId === ev.away.id ? 'away' : ''}"><span class="min">${esc(d.min)}</span><span>${d.goal ? '⚽' : d.red ? '🟥' : '🟨'}</span><span>${esc(d.player)}${d.pen ? ' (pên.)' : ''}${d.own ? ' (contra)' : ''}</span></div>`).join('') + `</div>`;
  }
  return html;
}

/* Estatísticas ao vivo (vêm da fonte pelo servidor, já traduzidas): parciais por período/set/mapa e barras casa x fora */
function statsPanel(ev) {
  const st = ev.state === 'in' ? ev.stats : null;
  if (!st || (!st.rows?.length && !st.periods && !st.players)) return '';
  let html = `<div class="section-head" style="margin-top:16px"><h2 style="font-size:16px">Estatísticas ao vivo</h2></div><div class="live-stats">`;
  const p = st.periods;
  if (p && p.labels?.length) {
    const cells = (list) => p.labels.map((_, i) => `<td>${esc(list[i] ?? '')}</td>`).join('');
    html += `<div class="ls-table"><table><thead><tr><th></th>${p.labels.map((l) => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>` +
      `<tr><td class="ls-team">${esc(ev.home.short)}</td>${cells(p.home)}</tr><tr><td class="ls-team">${esc(ev.away.short)}</td>${cells(p.away)}</tr></tbody></table></div>`;
  }
  for (const [label, h, a, pct] of st.rows || []) {
    const tot = pct ? 100 : h + a;
    const wh = tot > 0 ? Math.round((100 * h) / (pct ? Math.max(h + a, 1) : tot)) : 50;
    const fmt = (v) => (pct ? `${Math.round(v)}%` : String(Math.round(v * 100) / 100));
    html += `<div class="ls-row"><div class="ls-vals"><b>${fmt(h)}</b><span>${esc(label)}</span><b>${fmt(a)}</b></div>` +
      `<div class="ls-bar"><i style="width:${wh}%"></i><i style="width:${100 - wh}%"></i></div></div>`;
  }
  return html + '</div>' + playersPanel(ev, st.players);
}
/* Basquete: pontos, rebotes e assistências de cada jogador ao vivo; a barra cresce com os pontos (o maior do jogo = cheia) */
function playersPanel(ev, P) {
  if (!P) return '';
  const all = [...(P.home || []), ...(P.away || [])];
  const top = Math.max(10, ...all.map((x) => x.p));
  const team = (t, list) => !list?.length ? '' : `<div class="lp-team">${crest(t)}<b>${esc(t.short || t.name)}</b><span class="lp-h">PTS · REB · AST</span></div>` +
    list.map((x) => `<div class="lp-row"><div class="lp-vals"><span class="lp-n">${x.on ? '<i class="lp-on" title="Em quadra"></i>' : ''}${esc(x.n)}</span>` +
      `<b>${x.p}</b><span>${x.r}</span><span>${x.a}</span></div><div class="trk-bar"><i style="width:${Math.round((100 * x.p) / top)}%"></i></div></div>`).join('');
  return `<div class="section-head" style="margin-top:16px"><h2 style="font-size:16px">Jogadores ao vivo</h2></div><div class="live-stats lp">${team(ev.home, P.home)}${team(ev.away, P.away)}</div>`;
}

/* ---------------- render: apostas ---------------- */
/* Acompanhamento da seleção, como na bet365: quantos já há (cur) e o número que a decide (need).
   "Mais de 2.5 escanteios" com 1 → 1/3 (33%); "Menos de" perde ao chegar a need. null = mercado sem contagem. */
function legTrack(l, ev) {
  if (l.market === 'bp') { // basquete: pontos/rebotes/assistências do jogador, a crescer ao vivo
    const get = BP_FIELD[String(l.per ?? '').split('|')[0]], n = bpNeed(l);
    const p = ev && ev.state !== 'pre' && get && n && ev.track?.bp ? bpPlayer(l, ev.track.bp) : null;
    const v = p ? get(p) : null;
    return Number.isFinite(v) ? { cur: v, need: n.need, under: n.under } : null;
  }
  if (!ev || ev.sport !== 'soccer' || ev.state === 'pre') return null;
  const T = ev.track || {};
  const sc = [ev.home.score, ev.away.score];
  if (!sc.every(Number.isFinite)) return null;
  const firstHalf = ev.state === 'in' && !T.ht && /^(\d+)'$/.test(ev.clock || '') && parseInt(ev.clock, 10) < 45;
  const scope = l.market === 'total' ? 'ft' : String(l.per ?? '').split('|')[0];
  if (l.market === 'pp') {
    const stat = scope, get = PP_FIELD[stat], need = Number(String(l.pick).split('#')[0]);
    const p = get && T.pl ? ppPlayer(l, T.pl) : null;
    const v = p ? get(p) : null;
    return Number.isFinite(v) && need >= 1 ? { cur: v, need, under: false } : null;
  }
  const pair = scope === 'ft' ? sc : scope === 'h1' ? T.ht || (firstHalf ? sc : null) : scope === 'h2' ? (T.ht ? [sc[0] - T.ht[0], sc[1] - T.ht[1]] : firstHalf ? [0, 0] : null)
    : scope === 'corners' ? T.c : scope === 'cards' ? T.y : null;
  if (!Array.isArray(pair) || !pair.every(Number.isFinite)) return null;
  // linha inteira com "exatamente" (ex.: escanteios "Mais de 8" / "Menos de 8"): pick tot=gt:N | tot=lt:N
  const pc = l.market === 'pcond' && /^tot=(gt|lt):(\d+)$/.exec(String(l.pick));
  if (pc) {
    const n = Number(pc[2]), cur = pair[0] + pair[1];
    return pc[1] === 'gt' ? { cur, need: n + 1, under: false } : { cur, need: n, under: true };
  }
  if (!Number.isFinite(l.line)) return null;
  let cur;
  if (l.market === 'total' || l.market === 'ptot') cur = pair[0] + pair[1];
  else if (l.market === 'pteam') cur = String(l.pick).startsWith('home') ? pair[0] : pair[1];
  else return null;
  const under = String(l.pick).endsWith('under');
  if (!under && !String(l.pick).endsWith('over')) return null;
  return { cur, need: Math.floor(l.line) + 1, under };
}
function trackHtml(l, ev, bet) {
  if (l.result) {
    if (!/won/.test(l.result)) return '';
    const paid = bet.status !== 'open' || bet.type !== 'multiple';
    return `<div class="trk ok"><div class="trk-bar"><i style="width:100%"></i></div><b>✓ ${paid ? 'Pago' : 'Ganha'}</b></div>`;
  }
  const t = legTrack(l, ev);
  if (!t) return '';
  const pct = Math.min(100, Math.round((t.cur / t.need) * 100));
  const label = t.under ? `${t.cur} <small>máx. ${t.need - 1}</small>` : `${t.cur}/${t.need}`;
  return `<div class="trk ${t.under ? 'u' : ''}${!t.under && t.cur >= t.need ? ' ok' : ''}"><div class="trk-bar"><i style="width:${pct}%"></i></div><b>${label}</b></div>`;
}

// o jogo da seleção: emblemas e nomes (do jogo em memória; senão, do nome guardado na aposta "Casa x Fora")
/* disputa de pênaltis (ESPN): cada cobrança com ✅ (marcou) ou ❌ (errou) e o jogador; compact = linha curta do boletim */
function shootoutHtml(ev, compact = false) {
  const so = ev?.shootout;
  if (!so) return '';
  if (!so.home.length && !so.away.length) return so.done ? '' : (compact ? `<div class="pk-line"><span class="live-dot"></span> Pênaltis a começar…</div>` : `<div class="pk-box"><div class="pk-title"><span class="live-dot"></span> Disputa de pênaltis a começar…</div></div>`);
  const kicks = (list) => list.map((k) => `<span class="pk ${k.ok ? 'ok' : 'no'}" title="${esc(k.n || 'Cobrança ' + (list.indexOf(k) + 1))}: ${k.ok ? 'marcou' : 'errou'}">${k.ok ? '✅' : '❌'}</span>`).join('');
  const title = so.done ? 'Pênaltis (final)' : '<span class="live-dot"></span> Pênaltis ao vivo';
  if (compact) return `<div class="pk-line">${title} <b>${so.score[0]}-${so.score[1]}</b> · ${kicks(so.home)} <span class="muted">|</span> ${kicks(so.away)}</div>`;
  const row = (t, list, n) => `<div class="pk-row"><span class="pk-team">${esc(t.short)}</span><span class="pk-kicks">${kicks(list)}</span><b class="pk-n">${n}</b></div>
    ${list.some((k) => k.p) ? `<div class="pk-names">${list.map((k, i) => `${i + 1}. ${esc(k.p || '—')} ${k.ok ? '✓' : '✗'}`).join(' · ')}</div>` : ''}`;
  return `<div class="pk-box"><div class="pk-title">${title}</div>${row(ev.home, so.home, so.score[0])}${row(ev.away, so.away, so.score[1])}</div>`;
}
function legGame(l, ev) {
  const [hn, an] = String(l.event || '').split(' x ');
  // jogo já fora da lista: os emblemas vêm com a aposta (l.logos)
  const h = ev?.home?.logo ? ev.home : { ...(ev?.home || { name: hn || '', short: hn || '' }), logo: ev?.home?.logo || l.logos?.[0] || '' };
  const a = ev?.away?.logo ? ev.away : { ...(ev?.away || { name: an || '', short: an || '' }), logo: ev?.away?.logo || l.logos?.[1] || '' };
  const live = ev && ev.state === 'in' && !ev.awaiting;
  const score = ev && ev.state !== 'pre' && Number.isFinite(ev.home.score) ? `<b class="bg-score${live ? ' live' : ''}">${ev.home.score}-${ev.away.score}</b>` : '<span class="bg-x">x</span>';
  const sub = !ev ? esc(l.leagueName || '') : ev.awaiting ? 'Jogo terminado · aguardando resultado' : live ? `<span class="ls">● ${clockHtml(ev)}</span> · ${esc(ev.leagueName)}`
    : ev.state === 'pre' ? `${dateLabel(ev.date)} · ${esc(ev.leagueName)}` : `Encerrado · ${esc(ev.leagueName)}`;
  return `<div class="bet-game"><span class="bg-team">${crest(h)}<span>${esc(h.name)}</span></span>${score}<span class="bg-team away"><span>${esc(a.name)}</span>${crest(a)}</span></div>
    <div class="bg-sub">${sub}</div>${shootoutHtml(ev, true)}`;
}

const legCls = (l) => !l.result ? '' : l.result.includes('won') ? 'won' : l.result.includes('lost') ? 'lost' : 'void';
// fold = página "Minhas apostas": o cartão começa fechado e abre com um toque (S.betOpen guarda os abertos)
function betCard(bet, fold = false) {
  const closed = fold && !S.betOpen.has(bet.id);
  const bbSeen = new Set();
  const legHtml = (l, ev) => `<div class="leg ${legCls(l)}${l.bb ? ' in-bb' : ''}">
      ${l.bb ? '<span class="bb-dot"></span>' : legGame(l, ev)}
      <div class="lp"><span>${esc(l.name)}</span><span style="color:var(--yellow)">${l.bb ? '' : fmtOdd(l.odds)}</span></div>
      <div class="lm">${esc(l.marketName)}</div>
      ${l.result ? `<span class="lm">${RES_PT[l.result]} · ${l.early ? `decidida ${esc(l.final)}` : `Final ${esc(l.final)}`}</span>` : ''}
      ${trackHtml(l, ev, bet)}
    </div>`;
  const legs = closed ? '' : bet.legs.map((l) => {
    const ev = S.events.get(l.evId);
    if (!l.bb) return legHtml(l, ev);
    // Criar aposta: o jogo uma vez, com a odd do grupo, e as seleções por baixo ligadas por uma linha
    if (bbSeen.has(l.bb)) return '';
    bbSeen.add(l.bb);
    const grp = bet.legs.filter((x) => x.bb === l.bb);
    return `<div class="bb-group">
      <div class="bb-card-head"><span class="bb-tag">Criar aposta</span><span>${grp.length} seleções</span><b style="color:var(--yellow)">${fmtOdd(bet.bb?.[l.bb]?.odds)}</b></div>
      ${legGame(l, ev)}
      <div class="bb-chain">${grp.map((x) => legHtml(x, ev)).join('')}</div>
    </div>`;
  }).join('');
  let action = '';
  if (bet.status === 'open') {
    const co = cashoutValue(bet);
    if (S.cashoutBusy === bet.id) action = `<button class="cashout-btn" disabled>${bet.legs.some((l) => !l.result && S.events.get(l.evId)?.state === 'in') ? `Aprovando Cash Out (até ${liveWait(bet.legs.filter((l) => !l.result).map((l) => S.events.get(l.evId)))}s)...` : 'Processando Cash Out...'}</button>`;
    else if (co) action = `<button class="cashout-btn ${S.cashoutConfirm === bet.id ? 'confirm' : ''}" data-cashout="${bet.id}">${S.cashoutConfirm === bet.id ? `Confirmar Cash Out ${money(co)}` : `Cash Out ${money(co)}`}</button>`;
    else action = `<button class="cashout-btn" disabled>Cash Out indisponível</button>`;
  }
  const nbb = Object.keys(bet.bb || {}).length;
  const type = nbb && bet.legs.every((l) => l.bb) && nbb === 1 ? `Criar aposta (${bet.legs.length})` : bet.type === 'multiple' ? `Múltipla (${bet.legs.length})${nbb ? ' · Criar aposta' : ''}` : 'Simples';
  const status = `<span class="bet-status st-${bet.status}">${ST_PT[bet.status]}</span>`;
  const when = new Date(bet.placedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (closed) {
    const what = bet.type === 'multiple'
      ? `<span class="bet-dots">${bet.legs.map((l) => `<i class="${legCls(l)}"></i>`).join('')}</span>`
      : `<span class="bet-pick">${esc(bet.legs[0].name)} <span style="color:var(--yellow)">@${fmtOdd(bet.legs[0].odds)}</span></span>`;
    return `<div class="bet-card bet-fold">
      <button class="bet-sum" data-betopen="${bet.id}">
        <span class="bet-head"><span class="bet-type">${type}</span>${status}<span class="bet-chev">›</span></span>
        ${what}
        <span class="bet-line">${money(bet.stake)} · odd ${fmtOdd(bet.odds)} → <b>${money(bet.status === 'open' ? bet.potential : bet.payout)}</b> · ${when}</span>
      </button>
      ${action}
    </div>`;
  }
  return `<div class="bet-card${fold ? ' bet-fold open' : ''}">
    ${fold ? `<button class="bet-sum" data-betopen="${bet.id}"><span class="bet-head"><span class="bet-type">${type}</span>${status}<span class="bet-chev">›</span></span></button>`
      : `<div class="bet-head"><span class="bet-type">${type}</span>${status}</div>`}
    ${legs}
    <div class="bet-foot"><span>Aposta<br><b>${money(bet.stake)}</b></span><span style="text-align:center">Odd<br><b>${fmtOdd(bet.odds)}</b></span>
      <span style="text-align:right">${bet.status === 'open' ? 'Retorno potencial' : 'Retorno'}<br><b>${money(bet.status === 'open' ? bet.potential : bet.payout)}</b></span></div>
    ${action}
    <div style="margin-top:8px;font-size:11px;color:var(--muted)">Cód. ${bet.id} · ${new Date(bet.placedAt).toLocaleString('pt-BR')}</div>
  </div>`;
}

function renderMyBetsPage() {
  if (!S.user) return `<div class="section-head"><h2>Minhas apostas</h2></div><div class="empty-state">Entre na sua conta para ver suas apostas.<br><br><button class="btn btn-green" data-action="login">Entrar</button></div>`;
  const open = S.bets.filter((b) => b.status === 'open'), done = S.bets.filter((b) => b.status !== 'open');
  const tab = S.betsTab || 'open';
  const list = tab === 'open' ? open : done;
  const ret = done.reduce((a, b) => a + (b.payout || 0), 0), staked = done.reduce((a, b) => a + b.stake, 0);
  return `<div class="section-head"><h2>Minhas apostas</h2></div>
    <div class="tabs"><button class="${tab === 'open' ? 'active' : ''}" data-betstab="open">Abertas (${open.length})</button><button class="${tab === 'done' ? 'active' : ''}" data-betstab="done">Encerradas (${done.length})</button></div>
    ${tab === 'done' && done.length ? `<div class="banner" style="background:var(--panel)"><p class="muted">Total apostado <b style="color:#fff">${money(staked)}</b> · Total retornado <b style="color:#fff">${money(ret)}</b> · Resultado <b style="color:${ret - staked >= 0 ? 'var(--green)' : 'var(--red)'}">${money(ret - staked)}</b></p></div>` : ''}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px">${list.map((b) => betCard(b, true)).join('') || `<div class="empty-state" style="grid-column:1/-1">Nenhuma aposta ${tab === 'open' ? 'aberta' : 'encerrada'}.</div>`}</div>`;
}

function renderSlip() {
  const open = S.bets.filter((b) => b.status === 'open');
  $('#slipCount').textContent = S.slip.length;
  $('#openCount').textContent = open.length;
  $('#slipFabCount').textContent = S.slip.length;
  document.querySelectorAll('.slip-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.slipTab));
  const body = $('#slipBody');
  if (S.slipTab === 'open') {
    morph(body, !S.user ? `<div class="slip-empty"><div class="ic">🔐</div>Entre na sua conta para ver as apostas abertas.<br><br><button class="btn btn-green" data-action="login">Entrar</button></div>`
      : open.length ? open.map((b) => betCard(b)).join('') : `<div class="slip-empty"><div class="ic">🎫</div>Você não tem apostas abertas.</div>`);
    tickClocks();
    return;
  }
  if (!S.slip.length) {
    body.innerHTML = `<div class="slip-empty"><div class="ic">📋</div><b>Seu boletim está vazio</b><br><br>Clique em uma odd para adicionar a seleção.</div>`;
    $('#slipFabOdds').textContent = '';
    return;
  }
  const items = slipState();
  const conflict = hasConflict();
  const multi = S.slipMode === 'multiple';
  const totalOdds = round2(multi ? slipOdds(items) : items.reduce((p, i) => p * (i.sel ? i.sel.odds : 1), 1));
  $('#slipFabOdds').textContent = multi ? '@ ' + fmtOdd(totalOdds) : '';
  const bbAble = [...slipGroups().values()].every((g) => g.length < 2 || bbOk(findSel(g[0].key).ev));
  let html = `<div class="slip-mode"><button class="${!multi ? 'active' : ''}" data-mode="single">Simples</button><button class="${multi ? 'active' : ''}" data-mode="multiple" ${S.slip.length < 2 || !bbAble ? 'disabled' : ''}>Múltipla</button></div>`;
  const groups = slipGroups(), shown = new Set();
  for (const { s, ev, sel, suspended, changed } of items) {
    // múltipla: as seleções do mesmo jogo aparecem juntas num quadro "Criar aposta" com a odd do grupo
    const grp = multi && groups.get(s.evId);
    if (grp && grp.length > 1) {
      if (shown.has(s.evId)) continue;
      shown.add(s.evId);
      const q = bbOf(grp), gi = grp.map((g) => items.find((i) => i.s.key === g.key));
      const bad = q?.bad;
      html += `<div class="slip-bb ${q?.reason || gi.some((i) => i.suspended) ? 'bad' : ''}">
        <div class="bb-head"><span class="bb-tag ${q?.boost ? 'boost' : ''}">${q?.boost ? '⚡ Super Odd' : 'Criar aposta'}</span><span class="bb-odd">${q?.odds ? `${q.boost && q.base ? `<span class="old">${fmtOdd(q.base)}</span>` : q.prev && q.prev !== q.odds ? `<span class="old">${fmtOdd(q.prev)}</span>` : ''}${fmtOdd(q.odds)}` : q?.reason ? '—' : '…'}</span></div>
        <div class="si-event">${ev ? esc(evLabel(ev)) : ''}</div>
        <div class="bb-chain">${gi.map((i) => `<div class="bb-leg ${i.s.key === bad ? 'bad' : ''}"><button class="x" data-remove="${esc(i.s.key)}" title="Remover">×</button><span class="bb-dot"></span><div><div>${esc(i.sel ? i.sel.name : 'Seleção indisponível')}</div><div class="si-market">${esc(i.sel ? i.sel.marketName : '')}</div></div></div>`).join('')}</div>
        ${q?.reason ? `<div class="si-warn red">${esc(q.reason)}</div>` : !q?.odds ? '<div class="si-warn">A calcular a odd…</div>' : ''}
      </div>`;
      continue;
    }
    const stake = S.stakes[s.key] || '';
    const ret = sel ? parseMoney(stake) * sel.odds : 0;
    html += `<div class="slip-item ${suspended ? 'bad' : ''}">
      <button class="x" data-remove="${esc(s.key)}" title="Remover">×</button>
      <div class="si-pick"><span>${esc(sel ? sel.name : 'Seleção indisponível')}</span><span class="si-odds">${changed ? `<span class="old">${fmtOdd(s.odds)}</span>` : ''}${sel ? fmtOdd(sel.odds) : '-'}</span></div>
      <div class="si-market">${esc(sel ? sel.marketName : '')}</div>
      <div class="si-event">${ev ? `${ev.state === 'in' ? `<span class="live-dot"></span><b style="color:var(--red)">${clockHtml(ev)}</b> ${ev.home.score}-${ev.away.score} · ` : ''}${esc(evLabel(ev))}` : ''}</div>
      ${suspended ? `<div class="si-warn red">🔒 ${!sel && ev && ev.markets ? 'Linha alterada — mercado indisponível' : 'Mercado suspenso'}</div>` : changed ? `<div class="si-warn">A odd mudou de ${fmtOdd(s.odds)} para ${fmtOdd(sel.odds)}</div>` : ''}
      ${!multi ? `<div class="stake-row"><label class="stake"><span>R$</span><input inputmode="decimal" data-stake="${esc(s.key)}" value="${esc(stake)}" placeholder="0,00"></label><div class="ret">Retorno<b>${money(ret)}</b></div></div>` : ''}
    </div>`;
  }
  if (conflict && !multi) html += `<div class="si-warn" style="margin-bottom:8px">${[...groups.values()].some((g) => g.length > 1 && bbOk(findSel(g[0].key).ev)) ? 'Seleções do mesmo jogo: use Múltipla para o Criar aposta.' : 'Seleções do mesmo jogo não podem ser combinadas em múltipla.'}</div>`;
  let totalStake;
  if (multi) {
    totalStake = parseMoney(S.comboStake);
    html += `<div class="slip-summary">
      <div class="sum-line"><span>Odd total</span><b style="color:var(--yellow)">${fmtOdd(totalOdds)}</b></div>
      <label class="stake" style="margin-top:8px"><span>R$</span><input inputmode="decimal" id="comboStake" value="${esc(S.comboStake)}" placeholder="Valor da aposta"></label>
      <div class="quick">${[10, 25, 50, 100].map((v) => `<button data-quick="${v}">+${v}</button>`).join('')}</div>
      <div class="sum-line big" style="margin-top:10px"><span>Retorno potencial</span><b id="potRet">${money(totalStake * totalOdds)}</b></div>
    </div>`;
  } else {
    totalStake = items.reduce((a, i) => a + parseMoney(S.stakes[i.s.key]), 0);
    const totalRet = items.reduce((a, i) => a + (i.sel ? parseMoney(S.stakes[i.s.key]) * i.sel.odds : 0), 0);
    html += `<div class="slip-summary"><div class="sum-line"><span>Total apostado</span><b id="totStake">${money(totalStake)}</b></div><div class="sum-line big"><span>Retorno potencial</span><b id="potRet">${money(totalRet)}</b></div></div>`;
  }
  html += `<label class="check"><input type="checkbox" id="acceptAny" ${acceptAny() ? 'checked' : ''}> Aceitar qualquer alteração de odds</label>`;
  if (items.some((i) => i.changed) && !acceptAny()) html += `<button class="btn btn-ghost btn-block" data-action="accept" style="margin-bottom:8px">Aceitar alterações</button>`;
  const live = items.some((i) => i.ev?.state === 'in');
  const label = !S.user ? 'Entrar para apostar' : S.placing ? (live ? `Aprovando aposta ao vivo (até ${liveWait(items.map((i) => i.ev))}s)...` : 'Processando...') : `Apostar ${money(totalStake)}`;
  html += `<button class="btn btn-green btn-block" data-action="place" ${S.placing ? 'disabled' : ''}>${label}</button>
    <button class="clear-link" data-action="clear">Limpar boletim</button>`;
  morph(body, html); // muda só o que mudou (o relógio e os valores escritos não piscam)
  tickClocks();
}

/* ---------------- render: sidebar / header ---------------- */
function renderSidebar() {
  const evs = listed();
  const liveN = evs.filter((e) => e.state === 'in').length;
  const item = (view, label, cnt) => `<button class="side-item ${S.view === view ? 'active' : ''}" data-view="${view}">${label}<span class="cnt ${view === 'live' && cnt ? 'live' : ''}">${cnt ?? ''}</span></button>`;
  // telemóvel: o menu do topo fica escondido, então "Minhas apostas" vem aqui
  const openN = S.user ? S.bets.filter((b) => b.status === 'open').length : 0;
  let html = `<div class="side-mobile"><div class="side-title">Minha conta</div>
    ${item('mybets', '🎫 Minhas Apostas', openN || '')}</div>
    <div class="side-title">Esportes</div>
    ${item('home', '🏠 Destaques', '')}
    ${item('live', '<span class="live-dot"></span> Ao Vivo', liveN)}`;
  html += `<div class="side-title">Modalidades</div>`;
  html += `<button class="side-item side-sport ${S.view === 'all' ? 'active' : ''}" data-view="all"><span class="ic">🏆</span>Todos<span class="cnt">${evs.filter((e) => e.state !== 'post').length}</span></button>`;
  const curSport = S.view === 'league' ? LEAGUE_BY_KEY[S.league]?.sport : S.view === 'sport' ? S.sport : null;
  for (const [sk, sp] of Object.entries(SPORTS)) {
    const lgs = LEAGUES.filter((l) => l.sport === sk && S.leagueEvents.get(l.key)?.size);
    if (!lgs.length) continue;
    const open = S.openSport === sk;
    const sLive = evs.filter((e) => e.sport === sk && e.state === 'in').length;
    const sCnt = evs.filter((e) => e.sport === sk && e.state !== 'post').length;
    html += `<button class="side-item side-sport ${open ? 'open' : ''} ${curSport === sk ? 'cur' : ''}" data-togglesport="${sk}"><span class="ic">${sp.icon}</span>${esc(sp.name)}<span class="cnt ${sLive ? 'live' : ''}">${sLive ? '● ' + sLive : sCnt}</span><span class="chev">›</span></button>`;
    if (!open) continue;
    html += `<div class="side-leagues${S.sideAnim === sk ? ' anim' : ''}">`;
    if (lgs.length > 1) html += `<button class="side-item ${S.view === 'sport' && S.sport === sk ? 'active' : ''}" data-sport="${sk}">Todos<span class="cnt">${sCnt}</span></button>`;
    const lgBtn = (l, extra = '') => {
      const le = evs.filter((e) => e.league === l.key);
      const lv = le.filter((e) => e.state === 'in').length;
      return `<button class="side-item ${extra}${S.view === 'league' && S.league === l.key ? 'active' : ''}" data-league="${l.key}">${esc(l.name)}<span class="cnt ${lv ? 'live' : ''}">${lv ? '● ' + lv : le.filter((e) => e.state !== 'post').length}</span></button>`;
    };
    const byCountry = sk === 'soccer' && lgs.some((l) => l.dyn); // futebol: países que abrem e fecham
    if (byCountry) {
      // "Principais" no topo; e cada país mostra TODAS as suas ligas (as principais primeiro, depois as outras)
      const ALIAS = { EUA: 'Estados Unidos', Europa: 'Internacional', 'América do Sul': 'Internacional' };
      const ctry = (l) => ALIAS[l.country] || l.country || 'Outros';
      const main = lgs.filter((l) => !l.dyn);
      if (main.length) html += `<div class="side-sub">Principais</div>` + main.map((l) => lgBtn(l)).join('');
      if (S.view === 'league' && LEAGUE_BY_KEY[S.league]?.dyn) S.openCountries.add(ctry(LEAGUE_BY_KEY[S.league])); // a liga aberta mostra o seu país
      const countries = [...new Set(lgs.map(ctry))].sort((a, b) => (a === 'Outros') - (b === 'Outros') || (a === 'Internacional' ? -1 : b === 'Internacional' ? 1 : a.localeCompare(b, 'pt-BR')));
      html += `<div class="side-sub" data-countries-title>Países</div>`;
      for (const c of countries) {
        const cl = lgs.filter((l) => ctry(l) === c).sort((a, b) => (a.dyn ? 1 : 0) - (b.dyn ? 1 : 0) || (a.dyn && b.dyn ? a.name.localeCompare(b.name, 'pt-BR') : 0));
        const ce = evs.filter((e) => cl.some((l) => l.key === e.league) && e.state !== 'post');
        const clive = ce.filter((e) => e.state === 'in').length;
        const op = S.openCountries.has(c);
        html += `<button class="side-item side-country ${op ? 'open' : ''}" data-togglecountry="${esc(c)}">${esc(c)}<span class="cnt ${clive ? 'live' : ''}">${clive ? '● ' + clive : ce.length}</span><span class="chev">›</span></button>`;
        if (op) html += cl.map((l) => lgBtn(l, 'side-cl ')).join('');
      }
    } else {
      let circuit = null;
      for (const l of lgs) {
        if (l.dyn && l.country !== circuit) {
          // ténis: um título por circuito (ATP, WTA, Challenger, ITF) antes dos seus torneios
          circuit = l.country; html += `<div class="side-sub">${esc(circuit)}</div>`;
        }
        html += lgBtn(l);
      }
    }
    html += `</div>`;
  }
  if (S.casino) {
    // só a entrada "Cassino"; os jogos ficam na página do cassino
    html += `<div class="side-casino-sep"></div>
    <button class="side-item side-sport ${S.view === 'casino' ? 'active' : ''}" data-view="casino"><span class="ic">🎲</span>Cassino</button>`;
  }
  S.sideAnim = null;
  // só mexe no menu se mudou (redesenhar a cada atualização fazia-o piscar e perder a posição)
  const sb = $('#sidebar');
  if (sb.dataset.html !== html) { morph(sb, html); sb.dataset.html = html; }
  $('#liveCountNav').textContent = liveN;
  $('#liveCountBn').textContent = liveN > 99 ? '99+' : liveN || '';
  document.querySelectorAll('.topnav a').forEach((a) => a.classList.toggle('active', a.dataset.view === S.view || (a.dataset.view === 'home' && !['live', 'mybets', 'casino'].includes(S.view))));
}

function renderHeader() {
  const w = $('#wallet');
  if (S.user) {
    w.innerHTML = `<button class="balance" data-action="account" title="Minha conta"><small>Saldo</small><span>${money(S.user.balance)}</span></button>
      <button class="btn btn-green" data-action="deposit">Depositar</button>
      <button class="avatar" data-action="account" title="${esc(S.user.name)}">${esc(initials(S.user.name))}</button>`;
  } else {
    w.innerHTML = `<button class="btn btn-ghost" data-action="login">Entrar</button><button class="btn btn-green" data-action="register">Cadastrar</button>`;
  }
  // no cassino não há apostas esportivas: esconde o botão do Boletim
  document.body.classList.toggle('view-casino', S.view === 'casino');
  // barra de baixo: marca a secção atual
  document.querySelectorAll('#bottomNav [data-bn]').forEach((b) => b.classList.toggle('active', b.dataset.bn === S.view));
  if (S.lastUpdate) $('#lastUpdate').textContent = '· Última atualização ' + new Date(S.lastUpdate).toLocaleTimeString('pt-BR');
}

function render() {
  const sk = $('#skeleton'); if (sk && S.loaded) sk.remove();
  renderHeader(); renderSidebar(); renderMain(); renderSlip();
  syncWatch(); // o servidor passa a mandar os mercados completos dos jogos abertos aqui
}
// não redesenha campos com foco (para não perder o que está a ser escrito)
function safeRender() {
  // a pessoa está a deslizar o ecrã: redesenha quando parar (não trava o deslize)
  if (Date.now() - lastScroll < 700) { schedulePaint(); return; }
  const a = document.activeElement;
  if (a && a.tagName === 'INPUT') { renderHeader(); renderSidebar(); if (!a.closest('#main')) renderMain(); if (!a.closest('#slip')) renderSlip(); return; }
  render();
}

/* ---------------- modais ---------------- */
function openModal(html) {
  $('#modal').innerHTML = `<button class="close" data-action="close-modal">×</button>` + html;
  $('#modal').classList.add('show'); $('#overlay').classList.add('show');
  const first = $('#modal input'); if (first) setTimeout(() => first.focus(), 30);
}
function closeModal() { $('#modal').classList.remove('show'); $('#overlay').classList.remove('show'); closeDrawers(); }
const formErr = (msg) => { const el = $('#formErr'); if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; } };
const busy = (btn, on, text) => { if (!btn) return; if (on) { btn.dataset.txt = btn.textContent; btn.textContent = text || 'Aguarde...'; btn.disabled = true; } else { btn.textContent = btn.dataset.txt || btn.textContent; btn.disabled = false; } };

let afterAuth = null;
function openLogin(msg) {
  openModal(`<h3>Entrar</h3><p class="sub">${esc(msg || 'Bem-vindo de volta!')}</p>
    <form id="loginForm" autocomplete="on">
      <label class="lbl">E-mail</label><input class="inp" name="email" type="email" autocomplete="email" required>
      <label class="lbl">Senha</label><div class="pw"><input class="inp" name="password" type="password" autocomplete="current-password" required><button type="button" class="eye" data-action="eye">👁</button></div>
      <div style="text-align:right;margin-top:6px"><a href="#" data-action="forgot" class="link" style="font-size:12px">Esqueci minha senha</a></div>
      <div class="form-err" id="formErr"></div>
      <button class="btn btn-green btn-block" type="submit">Entrar</button>
    </form>
    <div class="note">Não tem conta? <a href="#" data-action="register" class="link">Cadastre-se grátis</a></div>
    <div class="note" style="margin-top:6px">Precisa de ajuda? <a href="/sac.html" class="link">Atendimento (SAC)</a></div>`);
}
function openForgot() {
  openModal(`<h3>Recuperar senha</h3><p class="sub">Informe o e-mail da sua conta. Vamos enviar um link para criar uma nova senha.</p>
    <form id="forgotForm"><label class="lbl">E-mail</label><input class="inp" name="email" type="email" autocomplete="email" required>
    <div class="form-err" id="formErr"></div><button class="btn btn-green btn-block" type="submit" style="margin-top:14px">Enviar link</button></form>
    <div class="note"><a href="#" data-action="login" class="link">Voltar ao login</a></div>`);
}
function openRegister() {
  const max = new Date(); max.setFullYear(max.getFullYear() - 18);
  openModal(`<h3>Criar conta</h3><p class="sub">Leva 1 minuto. Vamos enviar um e-mail para confirmar o seu endereço.</p>
    <form id="registerForm" autocomplete="on">
      <label class="lbl">Nome completo</label><input class="inp" name="name" autocomplete="name" required minlength="3">
      <label class="lbl">E-mail</label><input class="inp" name="email" type="email" autocomplete="email" required>
      <label class="lbl">CPF</label><input class="inp" name="cpf" id="regCpf" inputmode="numeric" autocomplete="off" placeholder="000.000.000-00" maxlength="14" required>
      <label class="lbl">Data de nascimento</label><input class="inp" name="birthdate" type="date" required max="${max.toISOString().slice(0, 10)}">
      <label class="lbl">Senha</label><div class="pw"><input class="inp" name="password" type="password" autocomplete="new-password" required minlength="8" placeholder="Mín. 8 caracteres, letras e números"><button type="button" class="eye" data-action="eye">👁</button></div>
      <label class="check" style="margin:12px 0"><input type="checkbox" name="terms" required> <span>Tenho 18 anos ou mais e aceito os <a href="/termos" target="_blank" class="link">termos de uso</a>, a <a href="/privacidade" target="_blank" class="link">política de privacidade</a> e a <a href="/jogo-responsavel" target="_blank" class="link">política de jogo responsável</a>.</span></label>
      <div class="form-err" id="formErr"></div>
      <button class="btn btn-green btn-block" type="submit">Criar conta</button>
    </form>
    <div class="note">Já tem conta? <a href="#" data-action="login" class="link">Entrar</a></div>`);
}

async function submitAuth(form, kind) {
  const fd = Object.fromEntries(new FormData(form));
  if (kind === 'register') {
    fd.terms = !!form.terms.checked;
    fd.cpf = String(fd.cpf || '').replace(/\D/g, '');
    if (fd.cpf.length !== 11) { formErr('Informe o CPF completo (11 números).'); return; }
  }
  const btn = form.querySelector('button[type=submit]');
  formErr(''); busy(btn, true);
  try {
    const { user } = await api('POST', kind === 'login' ? '/api/login' : '/api/register', fd);
    S.user = user;
    await loadAccount('first');
    closeModal();
    toast(kind === 'login' ? `Olá, ${user.name.split(' ')[0]}!` : `Conta criada! Enviámos um e-mail de confirmação para ${user.email}.`, 'ok');
    render();
    if (kind === 'register') openDeposit();
    else if (afterAuth) { const f = afterAuth; afterAuth = null; f(); }
  } catch (e) { formErr(e.message); busy(btn, false); }
}

let depState = { amount: 1000, method: 'pix' };
function openDeposit() {
  if (!S.user) { afterAuth = openDeposit; openLogin('Entre para depositar.'); return; }
  if (isPaused()) return pausedNotice();
  // servidor de teste: não há PIX real, oferece saldo fictício
  if (!S.payments.live && S.testMode) return openModal(`<h3>Depósito (modo de teste)</h3><p class="sub">Este é o servidor de teste: não há PIX nem dinheiro real. Adicione saldo fictício para testar apostas e jogos.</p><button class="btn btn-green btn-block" data-action="dev-credit">+ R$ 1.000 de saldo de teste</button>`);
  if (!S.payments.live) return openModal(`<h3>Pagamentos indisponíveis</h3><p class="sub">Os pagamentos estão temporariamente indisponíveis. Tente de novo em instantes.</p><button class="btn btn-green btn-block" data-action="close-modal">OK</button>`);
  return openPixDeposit();
}
/* ---------- PIX real (BravoPay) ---------- */
const maskCpf = (s) => { const d = String(s).replace(/\D/g, '').slice(0, 11); return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2'); };
function openPixDeposit() {
  const P = S.payments;
  const chips = [20, 50, 100, 250, 500, 1000].filter((c) => c >= P.depositMin);
  if (depState.amount < P.depositMin) depState.amount = chips[0];
  const lim = S.user.depositLimit != null ? `<div class="note" style="margin:-4px 0 12px">Seu limite diário de depósito: <b>${money(S.user.depositLimit)}</b></div>` : '';
  const cpf = S.user.cpf ? '' : `<label class="lbl">CPF do titular da conta</label><input class="inp" id="depCpf" inputmode="numeric" autocomplete="off" placeholder="000.000.000-00" maxlength="14" value="${esc(depState.cpf || '')}" style="margin-bottom:14px">
    <div class="note" style="margin:-8px 0 14px;text-align:left">O PIX tem de sair de uma conta no seu CPF. Os saques serão enviados para a chave PIX deste CPF.</div>`;
  openModal(`<h3>Depositar via PIX</h3><p class="sub">Pague com o app do seu banco. O saldo é creditado assim que o pagamento for confirmado.</p>
    <div class="chips">${chips.map((c) => `<button class="${depState.amount === c ? 'active' : ''}" data-chip="${c}">${money(c).replace(',00', '')}</button>`).join('')}</div>
    <label class="field"><span>R$</span><input id="depAmount" inputmode="decimal" value="${String(depState.amount).replace('.', ',')}"></label>
    ${cpf}${lim}
    <div class="form-err" id="formErr"></div>
    <button class="btn btn-green btn-block" data-action="do-deposit">Gerar PIX</button>
    <div class="note">Mín. ${money(P.depositMin)} · Máx. ${money(P.depositMax)} por depósito</div>`);
}

let qrLib = null;
function loadQrLib() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  if (!qrLib) qrLib = new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
    s.onload = () => ok(window.qrcode); s.onerror = () => { qrLib = null; ko(new Error('QR indisponível')); };
    document.head.appendChild(s);
  });
  return qrLib;
}
async function drawQr(dep) {
  const box = $('#pixQr'); if (!box) return;
  const q = dep.pixQr || '';
  if (/^(data:image|https?:)/.test(q)) { box.innerHTML = `<img alt="QR Code PIX" src="${esc(q)}">`; return; }
  if (/^[A-Za-z0-9+/=]{200,}$/.test(q)) { box.innerHTML = `<img alt="QR Code PIX" src="data:image/png;base64,${q}">`; return; }
  try {
    const qrcode = await loadQrLib();
    const qr = qrcode(0, 'M'); qr.addData(dep.pixCode); qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  } catch { box.innerHTML = '<div class="muted">Use o código copia e cola abaixo.</div>'; }
}

let depPoll = null;
function showPix(dep) {
  openModal(`<h3>Pague ${money(dep.amount)} via PIX</h3><p class="sub">Leia o QR Code ou use o PIX copia e cola no app do seu banco.</p>
    <div class="pix-box" id="pixBox" data-dep="${esc(dep.id)}">
      <div class="pix-qr" id="pixQr"><div class="spinner"></div></div>
      <label class="lbl">PIX copia e cola</label>
      <div class="pix-copy"><input class="inp" id="pixCode" readonly value="${esc(dep.pixCode)}"><button class="btn btn-green" data-action="copy-pix">Copiar</button></div>
      <div class="pix-wait"><span class="dot-pulse"></span> Aguardando pagamento · expira em <b id="pixTimer">--:--</b></div>
    </div>
    <div class="note">O saldo é creditado automaticamente. Pode fechar esta janela; o crédito acontece na mesma.</div>`);
  drawQr(dep);
  clearInterval(depPoll);
  let last = 0;
  depPoll = setInterval(async () => {
    const box = $('#pixBox');
    if (!box || box.dataset.dep !== dep.id || !$('#modal').classList.contains('show')) { clearInterval(depPoll); return; }
    const left = Math.max(0, dep.expiresAt - Date.now());
    $('#pixTimer').textContent = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
    if (Date.now() - last < 3000) return;
    last = Date.now();
    try {
      const { deposit, user } = await api('GET', '/api/deposit?id=' + encodeURIComponent(dep.id));
      if (deposit.status === 'PAID') {
        clearInterval(depPoll); setUser(user); render();
        openModal(`<div class="success"><div class="ic">✓</div><h3>Depósito confirmado</h3><p class="sub">${money(deposit.amount)} creditado no seu saldo.</p><button class="btn btn-green btn-block" data-action="close-modal">Começar a apostar</button></div>`);
      } else if (deposit.status !== 'PENDING' || left === 0) {
        clearInterval(depPoll);
        openModal(`<h3>PIX expirado</h3><p class="sub">Este código já não pode ser pago. Se já pagou, o valor será creditado assim que for confirmado.</p><button class="btn btn-green btn-block" data-action="deposit">Gerar novo PIX</button>`);
      }
    } catch { /* tenta de novo no próximo ciclo */ }
  }, 1000);
}

async function doDeposit() {
  {
    const v = parseMoney($('#depAmount').value);
    const P = S.payments;
    if (v < P.depositMin || v > P.depositMax) { formErr(`Valor entre ${money(P.depositMin)} e ${money(P.depositMax)}.`); return; }
    depState.amount = v;
    const cpfEl = $('#depCpf');
    const cpf = cpfEl ? cpfEl.value.replace(/\D/g, '') : undefined;
    if (cpfEl && cpf.length !== 11) { formErr('Informe o CPF completo.'); return; }
    const btn = document.querySelector('[data-action="do-deposit"]');
    formErr(''); busy(btn, true, 'Gerando PIX...');
    try {
      const { deposit, user } = await api('POST', '/api/deposit', { amount: v, cpf });
      setUser(user); showPix(deposit);
    } catch (e) { busy(btn, false); formErr(e.message); if (e.message.includes('CPF') && S.user.cpf == null) loadAccount(); }
  }
}
function pausedNotice() {
  openModal(`<h3>Conta em pausa</h3><p class="sub">A sua conta está em pausa até <b>${new Date(S.user.excludedUntil).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</b>. Durante a pausa não pode depositar nem apostar. Pode sacar o saldo a qualquer momento.</p>
    <button class="btn btn-ghost btn-block" data-action="withdraw">Sacar saldo</button>`);
}
const isPaused = () => S.user && S.user.excludedUntil && S.user.excludedUntil > Date.now();
const verifyBox = (msg) => `<div class="verify-box"><p>${msg}</p><div class="acc-actions"><button class="btn btn-green" data-action="verify-check">Já confirmei</button><button class="btn btn-ghost" data-action="verify-resend">Reenviar e-mail</button></div></div>`;

function openWithdraw() {
  if (S.payments.live) {
    const P = S.payments;
    let body;
    if (!S.user.cpf) body = `<div class="note" style="text-align:left;margin:0 0 12px">A sua conta não tem CPF registado. Faça um depósito por PIX para o registar, ou contacte o suporte.</div>`;
    else if (!S.user.emailVerified) body = verifyBox(`Para sacar, confirme primeiro o seu e-mail. Enviámos um link para <b>${esc(S.user.email)}</b> (veja também o spam).`);
    else body = `<div class="kv"><span>Chave PIX (CPF do titular)</span><b>${esc(S.user.cpf)}</b></div>
      <label class="field" style="margin-top:12px"><span>R$</span><input id="wdAmount" inputmode="decimal" placeholder="0,00"></label>
      <div class="form-err" id="formErr"></div>
      <button class="btn btn-green btn-block" data-action="do-withdraw">Solicitar saque</button>
      <div class="note">Mín. ${money(P.withdrawMin)} · Pagamento em ${esc(P.withdrawEta)} · Enviado só para a chave PIX do seu CPF</div>`;
    openModal(`<h3>Sacar via PIX</h3><p class="sub">Saldo disponível: <b>${money(S.user.balance)}</b></p>${body}`);
    return;
  }
  openModal(`<h3>Pagamentos indisponíveis</h3><p class="sub">Os pagamentos estão temporariamente indisponíveis. Tente de novo em instantes.</p><button class="btn btn-green btn-block" data-action="close-modal">OK</button>`);
}
async function doWithdraw() {
  const v = parseMoney($('#wdAmount').value);
  {
    if (v < S.payments.withdrawMin) { formErr(`Saque mínimo: ${money(S.payments.withdrawMin)}.`); return; }
    if (v > S.user.balance) { formErr('Saldo insuficiente.'); return; }
    const btn = document.querySelector('[data-action="do-withdraw"]');
    formErr(''); busy(btn, true, 'Enviando...');
    try {
      const { user } = await api('POST', '/api/withdraw', { amount: v });
      setUser(user); render();
      openModal(`<div class="success"><div class="ic">✓</div><h3>Pedido de saque recebido</h3><p class="sub">${money(v)} para a chave PIX ${esc(S.user.cpf)}.<br>Nossa equipe confere e envia o PIX em ${esc(S.payments.withdrawEta)}. Acompanhe no Extrato.</p><button class="btn btn-green btn-block" data-action="close-modal">OK</button></div>`);
    } catch (e) { busy(btn, false); formErr(e.message); loadAccount().then(() => renderHeader()); }
  }
}

const WD_LABEL = { PENDING: 'pendente', PROCESSING: 'em processamento', PAID: 'pago', REJECTED: 'recusado', CANCELED: 'cancelado', CREATING: 'pendente', FAILED: 'falhou', REVIEW: 'em análise', DUPLICATE: 'cancelado' };
const LIMITS = [
  ['depositLimit', 'Limite de depósito (24 horas)'],
  ['lossLimitDay', 'Limite de perda por dia'],
  ['lossLimitMonth', 'Limite de perda por mês'],
];
const PAUSES = [[1, '24 horas'], [7, '7 dias'], [30, '30 dias'], [90, '3 meses'], [180, '6 meses'], [365, '1 ano'], [1825, '5 anos']];
const fmtDT = (t) => new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

let accTab = 'profile';
async function openAccount(tab) {
  if (!S.user) { openLogin(); return; }
  if (tab) accTab = tab;
  const u = S.user;
  const tabs = [['profile', 'Perfil'], ['tx', 'Extrato'], ['security', 'Segurança'], ['limits', 'Jogo responsável']];
  let body = '';
  if (accTab === 'profile') {
    body = `<div class="acc-balance"><span class="muted">Saldo disponível</span><b>${money(u.balance)}</b></div>
      <div class="acc-actions"><button class="btn btn-green" data-action="deposit">Depositar</button><button class="btn btn-ghost" data-action="withdraw">Sacar</button></div>
      ${isPaused() ? `<div class="verify-box"><p>Conta em pausa até <b>${fmtDT(u.excludedUntil)}</b>.</p></div>` : ''}
      ${u.emailVerified ? '' : verifyBox(`Confirme o seu e-mail <b>${esc(u.email)}</b> para poder sacar. Veja a caixa de entrada e o spam.`)}
      <div class="kv"><span>Nome</span><b>${esc(u.name)}</b></div>
      <div class="kv"><span>E-mail</span><b>${esc(u.email)} ${u.emailVerified ? '<span class="ok-tag">confirmado</span>' : ''}</b></div>
      <div class="kv"><span>Nascimento</span><b>${new Date(u.birthdate + 'T00:00:00').toLocaleDateString('pt-BR')}</b></div>
      ${u.cpf ? `<div class="kv"><span>CPF</span><b>${esc(u.cpf)}</b></div>` : ''}
      <div class="kv"><span>Membro desde</span><b>${new Date(u.createdAt).toLocaleDateString('pt-BR')}</b></div>
      <a class="acc-sac" href="/minhas-apostas" data-view="mybets"><span class="acc-sac-ic">🎫</span><span><b>Minhas apostas</b><small>Apostas abertas e histórico das encerradas</small></span><span class="acc-sac-go">›</span></a>
      <a class="acc-sac" href="/sac.html"><span class="acc-sac-ic">🎧</span><span><b>Atendimento (SAC)</b><small>Dúvidas sobre depósitos, saques e apostas</small></span><span class="acc-sac-go">›</span></a>
      <a class="acc-sac acc-sac-mail" href="mailto:${esc(S.site.supportEmail || 'suporte@tugasbet.com')}"><span class="acc-sac-ic">✉️</span><span><b>E-mail do suporte</b><small>${esc(S.site.supportEmail || 'suporte@tugasbet.com')}</small></span><span class="acc-sac-go">›</span></a>
      ${u.isAdmin ? '<a class="btn btn-ghost btn-block" style="margin-top:16px" href="/admin">Abrir o painel da equipe</a>' : ''}
      <button class="btn btn-ghost btn-block" style="margin-top:10px" data-action="logout">Sair da conta</button>`;
  } else if (accTab === 'tx') {
    body = `<div class="tx-list" id="txList"><div class="spinner"></div></div>`;
  } else if (accTab === 'security') {
    body = `<form id="pwForm">
      <label class="lbl">Senha atual</label><input class="inp" name="current" type="password" autocomplete="current-password" required>
      <label class="lbl">Nova senha</label><input class="inp" name="next" type="password" autocomplete="new-password" required minlength="8" placeholder="Mín. 8 caracteres, letras e números">
      <div class="form-err" id="formErr"></div>
      <button class="btn btn-green btn-block" type="submit">Alterar senha</button>
      <div class="note">Ao alterar a senha, as sessões em outros dispositivos são encerradas.</div></form>`;
  } else {
    const limRow = ([k, label]) => {
      const L = u.limits[k];
      const pend = L.pending ? `<div class="note" style="text-align:left;margin:4px 0 0">Passa a ${L.pending.value == null ? 'sem limite' : money(L.pending.value)} em ${fmtDT(L.pending.at)}.</div>` : '';
      const used = k === 'lossLimitDay' ? ` · perda hoje: ${money(Math.max(0, u.lossToday))}` : k === 'lossLimitMonth' ? ` · perda no mês: ${money(Math.max(0, u.lossMonth))}` : '';
      return `<div class="lim-row"><label class="lbl">${label} <span class="muted">— atual: ${L.value == null ? 'sem limite' : money(L.value)}${used}</span></label>
        <div style="display:flex;gap:8px"><label class="field" style="flex:1;margin:0"><span>R$</span><input id="lim_${k}" inputmode="decimal" placeholder="Sem limite" value="${L.value != null ? String(L.value).replace('.', ',') : ''}"></label>
        <button class="btn btn-green" data-limit="${k}">Salvar</button><button class="btn btn-ghost" data-limit="${k}" data-clear="1" title="Remover limite">✕</button></div>${pend}</div>`;
    };
    body = `<p class="sub">Baixar um limite vale na hora. Subir ou remover só passa a valer 24 horas depois.</p>
      ${LIMITS.map(limRow).join('')}
      <div class="form-err" id="formErr"></div>
      <div class="lim-row"><label class="lbl">Lembrete de tempo de jogo</label>
        <select class="inp" id="realityCheck">${[[0, 'Desligado'], [15, 'A cada 15 minutos'], [30, 'A cada 30 minutos'], [60, 'A cada 1 hora'], [120, 'A cada 2 horas']].map(([m, l]) => `<option value="${m}" ${u.realityCheck === m ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="lim-row"><label class="lbl">Fazer uma pausa / autoexclusão</label>
        ${isPaused() ? `<p class="sub">Conta em pausa até <b>${fmtDT(u.excludedUntil)}</b>.</p>` : ''}
        <p class="sub" style="margin:0 0 8px">Durante a pausa não pode depositar nem apostar (pode sacar). <b>Não é possível cancelar antes do fim.</b></p>
        <div class="chips">${PAUSES.map(([dd, l]) => `<button data-pause="${dd}">${l}</button>`).join('')}</div></div>
      <div class="note">Aposte apenas o que pode perder. Precisa de ajuda? Ligue para o CVV no <b>188</b> ou procure os Jogadores Anónimos. <a href="/jogo-responsavel" target="_blank" class="link">Saiba mais</a></div>`;
  }
  openModal(`<div class="acc-head"><div class="avatar big">${esc(initials(u.name))}</div><div><h3>${esc(u.name)}</h3><p class="sub" style="margin:0">${esc(u.email)}</p></div></div>
    <div class="tabs acc-tabs">${tabs.map(([k, l]) => `<button class="${accTab === k ? 'active' : ''}" data-acctab="${k}">${l}</button>`).join('')}</div>
    ${body}`);
  if (accTab === 'tx') {
    try {
      const { tx } = await api('GET', '/api/transactions');
      const el = $('#txList');
      if (el) el.innerHTML = tx.length ? tx.map((t) => `<div class="tx"><span>${esc(t.type)}${t.status ? ` <em class="tx-st st-${esc(t.status.toLowerCase())}">${esc(WD_LABEL[t.status] || t.status)}</em>` : ''}
        <small>${new Date(t.at).toLocaleString('pt-BR')}${t.ref ? ' · ' + esc(t.ref) : ''}${t.note ? ' · ' + esc(t.note) : ''}</small>
        ${t.type === 'Saque PIX' && t.status === 'PENDING' ? `<button class="link" style="font-size:12px;padding:0" data-wdcancel="${esc(t.ref)}">Cancelar pedido</button>` : ''}</span>
        <span class="${t.amount >= 0 ? 'plus' : 'minus'}">${t.amount >= 0 ? '+' : ''}${money(t.amount)}</span></div>`).join('') : '<div class="muted" style="padding:10px 0">Sem movimentações.</div>';
    } catch (e) { const el = $('#txList'); if (el) el.textContent = e.message; }
  }
}

/* lembrete de tempo de jogo (jogo responsável) */
const sessionStart = (() => { try { const v = +sessionStorage.getItem('gl_start'); if (v) return v; const t = Date.now(); sessionStorage.setItem('gl_start', t); return t; } catch { return Date.now(); } })();
let lastReminder = Date.now();
setInterval(() => {
  const m = S.user && S.user.realityCheck;
  if (!m || Date.now() - lastReminder < m * 60000) return;
  lastReminder = Date.now();
  const mins = Math.round((Date.now() - sessionStart) / 60000);
  openModal(`<h3>Hora de uma pausa?</h3><p class="sub">Você está no site há <b>${mins >= 60 ? Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min' : mins + ' min'}</b>.<br>Perda hoje: <b>${money(Math.max(0, S.user.lossToday || 0))}</b>.</p>
    <div class="acc-actions"><button class="btn btn-green" data-action="close-modal">Continuar</button><button class="btn btn-ghost" data-action="logout">Sair</button></div>
    <div class="note"><a href="#" class="link" data-acctab="limits">Definir limites ou fazer uma pausa</a></div>`);
}, 30000);

async function logout() {
  try { await api('POST', '/api/logout'); } catch { /* ignora */ }
  S.user = null; S.bets = []; S.slipTab = 'slip';
  closeModal(); toast('Você saiu da conta'); go('home');
}

/* ---------------- navegação / eventos ---------------- */
/* rotas: cada secção tem o seu endereço (o servidor devolve o index.html para todas) */
const ROUTES = { home: '/', live: '/ao-vivo', mybets: '/minhas-apostas', casino: '/cassino', all: '/todos', today: '/hoje', tomorrow: '/amanha', results: '/resultados' };
function pathFor() {
  if (S.view === 'league' && S.league) return '/liga/' + encodeURIComponent(S.league);
  if (S.view === 'sport' && S.sport) return '/esporte/' + encodeURIComponent(S.sport);
  if (S.view === 'event' && S.eventId) return '/evento/' + encodeURIComponent(S.eventId);
  return ROUTES[S.view] || '/';
}
// lê o endereço atual e devolve a secção correspondente (endereço desconhecido → esportes)
function routeFromPath() {
  if (location.hash === '#cassino') return { view: 'casino' }; // links antigos
  const p = location.pathname.replace(/\/+$/, '') || '/';
  const m = p.match(/^\/(liga|esporte|evento)\/([^/]+)$/);
  if (m) {
    let id; try { id = decodeURIComponent(m[2]); } catch { return { view: 'home' }; }
    if (m[1] === 'liga') return LEAGUE_BY_KEY[id] ? { view: 'league', league: id } : { view: 'home' };
    if (m[1] === 'esporte') return SPORTS[id] ? { view: 'sport', sport: id } : { view: 'home' };
    return { view: 'event', eventId: id };
  }
  if (p === '/esportes') return { view: 'home' };
  const view = Object.keys(ROUTES).find((k) => ROUTES[k] === p);
  return { view: view || 'home' };
}
function syncUrl(replace) {
  const path = pathFor();
  if (location.pathname + location.hash === path) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
}
function go(view, extra = {}, opts = {}) {
  Object.assign(S, { view, league: null, sport: null }, extra);
  S.keepScroll = false; S.listLimit = LIST_STEP;
  if (!opts.fromHistory) syncUrl(opts.replace);
  closeDrawers(); render(); window.scrollTo(0, 0);
  // página do jogo: mostra logo o que há e completa com todos os mercados (se já vieram antes do clique, nada a esperar)
  if (view === 'event' && S.eventId && !fullFresh(S.eventId)) prefetchFull(S.eventId).then(() => { if (S.view === 'event') { S.keepScroll = true; safeRender(); } });
}
/* Mercados completos pedidos antes do clique: rato parado em cima do jogo (120 ms) ou dedo a tocar nele.
   Quando o clique chega, o pedido já vai a meio ou já voltou. Um só pedido por jogo de cada vez. */
const fullPending = new Map(); // id do jogo → pedido em curso
const fullFresh = (id) => { const ev = S.events.get(id); return !!ev?.fullAt && Date.now() - ev.fullAt < 15000; };
function prefetchFull(id) {
  if (fullPending.has(id)) return fullPending.get(id);
  const p = loadFull([id]).finally(() => fullPending.delete(id));
  fullPending.set(id, p);
  return p;
}
const intentOf = (e) => e.target.closest?.('[data-ev]')?.dataset.ev;
let hoverT = 0;
document.addEventListener('mouseover', (e) => {
  clearTimeout(hoverT);
  const id = intentOf(e);
  if (id && S.events.has(id) && !fullFresh(id)) hoverT = setTimeout(() => prefetchFull(id), 120);
});
document.addEventListener('touchstart', (e) => { const id = intentOf(e); if (id && S.events.has(id) && !fullFresh(id)) prefetchFull(id); }, { passive: true });
// botões voltar/avançar do navegador
window.addEventListener('popstate', () => { const r = routeFromPath(); go(r.view, r, { fromHistory: true }); });
function closeDrawers() { $('#sidebar').classList.remove('open'); $('#slip').classList.remove('open'); document.documentElement.classList.remove('drawer-open'); if (!$('#modal').classList.contains('show')) $('#overlay').classList.remove('show'); }

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a, .ev-row, .boost-card, .hero-card');
  if (!t) return;
  // Ctrl/Cmd/Shift + clique num link de secção: deixa o navegador abrir noutra aba
  if (t.tagName === 'A' && (e.ctrlKey || e.metaKey || e.shiftKey) && /^\/([^/]|$)/.test(t.getAttribute('href') || '')) return;
  const d = t.dataset;
  if (d.abrir) { // slots: abre o jogo (sem conta: pede login e abre o jogo logo a seguir)
    e.preventDefault();
    const abrir = () => window.abrirFortuneTiger && window.abrirFortuneTiger(d.abrir, d.nome);
    if (!S.user) { afterAuth = abrir; openLogin(`Entre na sua conta para jogar ${d.nome || 'este jogo'}.`); return; }
    abrir(); return;
  }
  if (d.key) { e.stopPropagation(); toggleSel(d.key); return; }
  if (d.boost) { addBoost(d.boost); return; }
  if (d.cashout) {
    if (S.cashoutConfirm === d.cashout) doCashout(d.cashout);
    else { S.cashoutConfirm = d.cashout; render(); setTimeout(() => { if (S.cashoutConfirm === d.cashout) { S.cashoutConfirm = null; render(); } }, 5000); }
    return;
  }
  if (d.remove) { toggleSel(d.remove); return; }
  if (d.mode) { S.slipMode = d.mode; renderSlip(); if (d.mode === 'multiple') ensureBB(); return; }
  if (d.tab) { S.slipTab = d.tab; renderSlip(); return; }
  if (d.quick) { S.comboStake = String(round2(parseMoney(S.comboStake) + +d.quick)).replace('.', ','); renderSlip(); return; }
  if (d.chip) { depState.amount = +d.chip; if ($('#depCpf')) depState.cpf = $('#depCpf').value; openDeposit(); return; }
  if (d.method) { depState.amount = parseMoney($('#depAmount').value) || depState.amount; depState.method = d.method; openDeposit(); return; }
  if (d.betstab) { S.betsTab = d.betstab; renderMain(); return; }
  if (d.betopen) { S.betOpen.has(d.betopen) ? S.betOpen.delete(d.betopen) : S.betOpen.add(d.betopen); S.keepScroll = true; renderMain(); return; }
  if (d.acctab) { e.preventDefault(); openAccount(d.acctab); return; }
  if (d.limit) {
    const val = d.clear ? null : (parseMoney($('#lim_' + d.limit).value) || null);
    try { const r = await api('POST', '/api/account/limits', { key: d.limit, value: val }); setUser(r.user); toast(r.scheduled ? 'Pedido registado: o novo limite vale daqui a 24 horas.' : 'Limite atualizado', 'ok'); openAccount('limits'); }
    catch (err) { formErr(err.message); }
    return;
  }
  if (d.pause) {
    const label = (PAUSES.find((p) => p[0] === +d.pause) || [])[1];
    openModal(`<h3>Pausar a conta por ${esc(label)}?</h3><p class="sub">Durante este tempo não vai conseguir depositar nem apostar. <b>Não dá para cancelar antes do fim.</b> Pode sacar o seu saldo normalmente.</p>
      <div class="acc-actions"><button class="btn btn-ghost" data-acctab="limits">Voltar</button><button class="btn btn-green" data-pauseok="${d.pause}">Sim, pausar</button></div>`);
    return;
  }
  if (d.pauseok) {
    try { const { user } = await api('POST', '/api/account/pause', { days: +d.pauseok, confirm: true }); setUser(user); S.slip = []; render(); toast('Conta em pausa até ' + fmtDT(user.excludedUntil), 'ok'); openAccount('limits'); }
    catch (err) { toast(err.message, 'err'); }
    return;
  }
  if (d.wdcancel) {
    try { const { user } = await api('POST', '/api/withdraw/cancel', { id: d.wdcancel }); setUser(user); toast('Pedido de saque cancelado; o valor voltou ao saldo.', 'ok'); openAccount('tx'); }
    catch (err) { toast(err.message, 'err'); }
    return;
  }
  if (d.league) { e.preventDefault(); go('league', { league: d.league }); return; }
  if (d.sport) { e.preventDefault(); go('sport', { sport: d.sport }); return; }
  // o desporto abre a sua página (Super Odds no topo) e as ligas; outro clique na mesma página só fecha a lista
  if (d.togglesport) {
    const sk = d.togglesport, here = S.view === 'sport' && S.sport === sk;
    S.openSport = here && S.openSport === sk ? null : sk; S.sideAnim = S.openSport;
    if (here) renderSidebar(); else { e.preventDefault(); go('sport', { sport: sk }); }
    return;
  }
  if (d.togglecountry != null) { const c = d.togglecountry; if (S.openCountries.has(c)) S.openCountries.delete(c); else S.openCountries.add(c); renderSidebar(); return; }
  if (d.sporttab) { S.sportTab = d.sporttab; S.listLimit = LIST_STEP; S.keepScroll = true; renderMain(); return; }
  if (d.evtab) { S.evTab = { id: S.eventId, tab: d.evtab }; S.keepScroll = true; renderMain(); return; }
  if (d.bpstat || d.bpteam) { if (d.bpstat) S.bpStat = d.bpstat; else S.bpTeam = d.bpteam; S.keepScroll = true; renderMain(); return; }
  if (d.mkt != null) { const k = `${S.eventId}|${d.mkt}`; if (S.openMkts.has(k)) S.openMkts.delete(k); else S.openMkts.add(k); S.keepScroll = true; renderMain(); return; }
  if (d.action === 'stream-toggle') { S.streamHidden = !S.streamHidden; lsSet('gl_streamHidden', S.streamHidden); S.keepScroll = true; renderMain(); return; }
  if (d.hb != null) { heroShow(+d.hb); return; }
  if (d.view) { e.preventDefault(); if ($('#modal').classList.contains('show')) closeModal(); go(d.view); return; }
  if (d.ev) { S.prevView = S.view === 'event' ? S.prevView : { view: S.view, league: S.league, sport: S.sport }; go('event', { eventId: d.ev }); return; }
  if (!d.action) return;
  if (t.tagName === 'A') e.preventDefault();
  switch (d.action) {
    case 'place': placeBets(); break;
    case 'more': S.listLimit += LIST_STEP; S.keepScroll = true; renderMain(); break;
    case 'clear': S.slip = []; S.stakes = {}; S.comboStake = ''; S.slipMode = 'single'; render(); break;
    case 'accept': S.slip.forEach((s) => { const { sel } = findSel(s.key); if (sel) s.odds = sel.odds; }); for (const q of Object.values(S.bbq)) q.prev = null; renderSlip(); break;
    case 'back': { const p = S.prevView || { view: 'home' }; go(p.view, { league: p.league, sport: p.sport }); } break;
    case 'login': afterAuth = null; openLogin(); break; // login pedido pelo próprio jogador: não reabre nada pendente
    case 'register': openRegister(); break;
    case 'account': openAccount('profile'); break;
    case 'logout': logout(); break;
    case 'deposit': openDeposit(); break;
    case 'dev-credit': try { const { user } = await api('POST', '/api/dev/credit', {}); setUser(user); closeModal(); render(); toast('+ R$ 1.000 de saldo de teste', 'ok'); } catch (err) { toast(err.message, 'err'); } break;
    case 'do-deposit': doDeposit(); break;
    case 'withdraw': openWithdraw(); break;
    case 'do-withdraw': doWithdraw(); break;
    case 'close-modal': afterAuth = null; closeModal(); break;
    case 'forgot': openForgot(); break;
    case 'verify-resend': try { await api('POST', '/api/account/verify-email'); toast('E-mail enviado. Veja a caixa de entrada e o spam.', 'ok'); } catch (err) { toast(err.message, 'err'); } break;
    case 'verify-check': try { const { user } = await api('POST', '/api/account/verify-check'); setUser(user); if (user.emailVerified) { toast('E-mail confirmado ✓', 'ok'); closeModal(); } else toast('Ainda não confirmado. Abra o link do e-mail que enviámos.', 'err'); } catch (err) { toast(err.message, 'err'); } break;
    case 'copy-pix': {
      const inp = $('#pixCode'); inp.select();
      try { await navigator.clipboard.writeText(inp.value); } catch { document.execCommand('copy'); }
      t.textContent = 'Copiado!'; setTimeout(() => { t.textContent = 'Copiar'; }, 2000);
    } break;
    case 'eye': { const inp = t.parentElement.querySelector('input'); inp.type = inp.type === 'password' ? 'text' : 'password'; } break;
  }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'loginForm') submitAuth(f, 'login');
  else if (f.id === 'registerForm') submitAuth(f, 'register');
  else if (f.id === 'forgotForm') {
    const btn = f.querySelector('button[type=submit]'); formErr(''); busy(btn, true);
    try { await api('POST', '/api/password-reset', Object.fromEntries(new FormData(f))); openModal('<div class="success"><div class="ic">✓</div><h3>Verifique o seu e-mail</h3><p class="sub">Se existir uma conta com esse e-mail, enviámos um link para criar uma nova senha. Veja também o spam.</p><button class="btn btn-green btn-block" data-action="login">Voltar ao login</button></div>'); }
    catch (err) { formErr(err.message); busy(btn, false); }
  }
  else if (f.id === 'pwForm') {
    const btn = f.querySelector('button[type=submit]'); formErr(''); busy(btn, true);
    try { await api('POST', '/api/account/password', Object.fromEntries(new FormData(f))); toast('Senha alterada', 'ok'); openAccount('profile'); }
    catch (err) { formErr(err.message); busy(btn, false); }
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.stake) {
    S.stakes[t.dataset.stake] = t.value;
    const items = slipState();
    const row = t.closest('.slip-item'); const it = items.find((i) => i.s.key === t.dataset.stake);
    if (row && it?.sel) row.querySelector('.ret b').textContent = money(parseMoney(t.value) * it.sel.odds);
    const ts = items.reduce((a, i) => a + parseMoney(S.stakes[i.s.key]), 0);
    const tr = items.reduce((a, i) => a + (i.sel ? parseMoney(S.stakes[i.s.key]) * i.sel.odds : 0), 0);
    if ($('#totStake')) $('#totStake').textContent = money(ts);
    if ($('#potRet')) $('#potRet').textContent = money(tr);
    const btn = document.querySelector('[data-action="place"]'); if (btn && !S.placing && S.user) btn.textContent = `Apostar ${money(ts)}`;
  } else if (t.id === 'comboStake') {
    S.comboStake = t.value;
    const odds = round2(slipOdds(slipState()));
    if ($('#potRet')) $('#potRet').textContent = money(parseMoney(t.value) * odds);
    const btn = document.querySelector('[data-action="place"]'); if (btn && !S.placing && S.user) btn.textContent = `Apostar ${money(parseMoney(t.value))}`;
  } else if (t.id === 'depCpf' || t.id === 'regCpf') {
    t.value = maskCpf(t.value);
  } else if (t.id === 'search') {
    S.query = t.value;
    if (['event', 'mybets', 'casino'].includes(S.view)) { S.view = 'today'; syncUrl(true); }
    renderMain();
  }
});
document.addEventListener('change', async (e) => {
  if (e.target.id === 'realityCheck') {
    try { const { user } = await api('POST', '/api/account/prefs', { realityCheck: +e.target.value }); setUser(user); lastReminder = Date.now(); toast('Lembrete guardado', 'ok'); } catch (err) { toast(err.message, 'err'); }
    return;
  }
  if (e.target.id !== 'acceptAny') return;
  const v = e.target.checked;
  if (S.user) {
    S.user.acceptAny = v;
    try { const { user } = await api('POST', '/api/account/prefs', { acceptAny: v }); setUser(user); } catch { /* ignora */ }
  } else { S.acceptAnyLocal = v; lsSet('gl_acceptAny', v); }
  renderSlip();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && e.target.id === 'depAmount') doDeposit();
});

$('#logoLink').onclick = (e) => { e.preventDefault(); go('home'); };
$('#overlay').onclick = () => { afterAuth = null; closeModal(); }; // fechou sem entrar: esquece a ação pendente
// gaveta aberta: a página de fundo fica parada (senão o dedo desliza a página em vez da gaveta)
$('#menuBtn').onclick = () => { $('#sidebar').classList.add('open'); $('#overlay').classList.add('show'); document.documentElement.classList.add('drawer-open'); };
$('#slipFab').onclick = () => { $('#slip').classList.add('open'); $('#overlay').classList.add('show'); document.documentElement.classList.add('drawer-open'); };

/* ---------------- slots (Fortune Tiger) ---------------- */
// o modal vive no index.html; aqui só expomos uma função para o site refrescar o saldo ao fechar
window.tugasRefreshSaldo = async () => { try { await loadAccount(); render(); } catch { /* ignora */ } };

/* ---------------- início ---------------- */
(async function start() {
  renderHeader();
  await Promise.all([loadEvents(), loadAccount('first')]);
  S.sitePromise = api('GET', '/api/site').then(({ site }) => {
    S.site = site || {};
    const parts = [site.company, site.cnpj && 'CNPJ ' + site.cnpj, site.license && 'Autorização SPA/MF: ' + site.license, site.supportEmail].filter(Boolean);
    const el = $('#siteInfo'); if (el) el.textContent = parts.join(' · ');
  }).catch(() => { });
  // abre a secção do endereço (ex.: /cassino, /ao-vivo, /liga/bra.1) e corrige endereços antigos/desconhecidos
  Object.assign(S, routeFromPath());
  syncUrl(true);
  loadBoosts().then(() => safeRender());
  setInterval(async () => { if (!document.hidden) { await loadBoosts(); safeRender(); } }, 60000);
  await loadFull(); // endereço de um jogo (/evento/...) e boletim guardado: mercados completos já na primeira vista
  render();
  startStream();
  let lastList = Date.now();
  setInterval(async () => {
    if (streamAlive() && Date.now() - lastList < 30000) return; // tempo real ligado: a lista completa é só reserva
    lastList = Date.now();
    if (await loadEvents()) safeRender();
  }, EVENTS_MS);
  setInterval(async () => { if (S.user) { await loadAccount(); safeRender(); } }, ACCOUNT_MS);
  // reabre mercados e apaga setas sem esperar o próximo ciclo
  setInterval(() => {
    const now = Date.now();
    if ([...S.events.values()].some((e) => e.suspendedUntil && e.suspendedUntil <= now && e.suspendedUntil > now - 1000)) safeRender();
  }, 1000);
})();