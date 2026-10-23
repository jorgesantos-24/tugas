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
  events: new Map(), leagueEvents: new Map(), oddsCache: new Map(), moves: new Map(),
  view: 'home', league: null, sport: null, eventId: null, query: '', sportTab: 'all', openSport: null,
  slipTab: 'slip', slipMode: 'single', slip: [], stakes: {}, comboStake: '',
  acceptAnyLocal: lsGet('gl_acceptAny', true),
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

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  $('#toasts').appendChild(el);
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
  if (!r.ok) { const e = new Error(data.error || 'Falha de comunicação com o servidor.'); e.status = r.status; throw e; }
  return data;
}

/* ---------------- jogos e odds ---------------- */
const findSel = (key) => {
  const ev = S.events.get(String(key).split('|')[0]);
  if (!ev) return { ev: null, sel: null };
  return { ev, sel: selections(ev).find((s) => s.key === key) || null };
};

function mergeEvents(list) {
  const now = Date.now();
  const watched = new Set([...S.slip.map((s) => s.evId), ...S.bets.filter((b) => b.status === 'open').flatMap((b) => b.legs.map((l) => l.evId))]);
  const seen = new Set();
  for (const ev of list) {
    seen.add(ev.id);
    const old = S.events.get(ev.id);
    if (old) {
      if (old.state === 'in' && ev.state === 'in' && (ev.home.score !== old.home.score || ev.away.score !== old.away.score) && watched.has(ev.id))
        toast(`${SPORTS[ev.sport].icon} ${ev.home.short} ${ev.home.score} x ${ev.away.score} ${ev.away.short}`, 'ok');
      if (old.state === 'pre' && ev.state === 'in' && watched.has(ev.id)) toast(`Começou: ${ev.home.short} x ${ev.away.short}`);
    }
    for (const s of selections(ev)) {
      const prev = S.oddsCache.get(s.key);
      if (prev && prev !== s.odds) S.moves.set(s.key, { dir: s.odds > prev ? 'up' : 'down', until: now + 6000 });
      S.oddsCache.set(s.key, s.odds);
    }
    S.events.set(ev.id, ev);
    if (!S.leagueEvents.has(ev.league)) S.leagueEvents.set(ev.league, new Set());
    S.leagueEvents.get(ev.league).add(ev.id);
  }
  for (const id of [...S.events.keys()]) if (!seen.has(id)) S.events.delete(id);
  for (const set of S.leagueEvents.values()) for (const id of [...set]) if (!seen.has(id)) set.delete(id);
}

async function loadEvents() {
  try {
    const r = await fetch('/api/events', { headers: S.etag ? { 'If-None-Match': S.etag } : {}, cache: 'no-store' });
    const offset = Date.now() - Number(r.headers.get('X-Server-Now') || Date.now());
    if (r.status === 304) { S.failed = false; return false; }
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    S.etag = r.headers.get('ETag');
    const list = d.events.map((ev) => ({
      ...ev, date: new Date(ev.date),
      suspendedUntil: ev.suspendedUntil ? ev.suspendedUntil + offset : 0,
      goalAt: ev.goalAt ? ev.goalAt + offset : 0,
    }));
    mergeEvents(list);
    S.lastUpdate = d.lastFeedOk ? d.lastFeedOk + offset : null;
    S.failed = false; S.loaded = true;
    return true;
  } catch {
    S.failed = true; S.loaded = true;
    return true;
  }
}

/* ---------------- conta ---------------- */
const ST_PT = { open: 'Aberta', won: 'Ganha', lost: 'Perdida', void: 'Devolvida', cashout: 'Cash Out' };
const RES_PT = { won: 'Ganhou', halfwon: 'Meio ganho', void: 'Devolvida', halflost: 'Meia perda', lost: 'Perdeu' };

async function loadAccount(silent) {
  try {
    const { user, payments, liveDelay, liveCashoutDelay, casino, games } = await api('GET', '/api/me');
    S.casino = !!casino; S.games = games || {}; document.body.classList.toggle('has-casino', S.casino);
    if (liveDelay) { S.liveDelay = liveDelay; S.liveCashoutDelay = liveCashoutDelay; }
    S.user = user;
    if (payments) { S.payments = payments; document.body.classList.toggle('live-pay', !!payments.live); }
    if (user) {
      const { bets } = await api('GET', '/api/bets');
      if (silent !== 'first') {
        const before = new Map(S.bets.map((b) => [b.id, b.status]));
        for (const b of bets) {
          if (before.get(b.id) === 'open' && b.status !== 'open' && b.status !== 'cashout') {
            if (b.status === 'won') toast(`🏆 Aposta ganha! +${money(b.payout)}`, 'ok');
            else if (b.status === 'void') toast(`Aposta devolvida: ${money(b.payout)}`, 'ok');
            else toast(`Aposta ${b.id} perdida`, 'err');
          }
        }
      }
      S.bets = bets;
    } else S.bets = [];
  } catch { /* servidor indisponível: mantém o estado */ }
}
function setUser(user) { if (user) S.user = user; renderHeader(); }

/* ---------------- boletim ---------------- */
function toggleSel(key) {
  const i = S.slip.findIndex((s) => s.key === key);
  if (i >= 0) { S.slip.splice(i, 1); delete S.stakes[key]; }
  else {
    const { ev, sel } = findSel(key);
    if (!sel || isSuspended(ev)) { toast('Mercado suspenso', 'err'); return; }
    if (S.slip.length >= 20) { toast('Máximo de 20 seleções', 'err'); return; }
    S.slip.push({ key, evId: ev.id, odds: sel.odds });
    if (S.slip.length >= 2 && !hasConflict()) S.slipMode = 'multiple';
  }
  if (S.slip.length < 2) S.slipMode = 'single';
  S.slipTab = 'slip';
  render();
}
const hasConflict = () => new Set(S.slip.map((s) => s.evId)).size !== S.slip.length;
function slipState() {
  return S.slip.map((s) => {
    const { ev, sel } = findSel(s.key);
    return { s, ev, sel, suspended: !sel || isSuspended(ev), changed: !!sel && sel.odds !== s.odds };
  });
}

async function placeBets() {
  if (S.placing) return;
  if (!S.user) { openLogin('Entre na sua conta para apostar.'); return; }
  if (isPaused()) { pausedNotice(); return; }
  const items = slipState();
  if (!items.length) return;
  if (items.some((i) => i.suspended)) { toast('Remova as seleções suspensas', 'err'); return; }
  if (items.some((i) => i.changed) && !acceptAny()) { toast('As odds mudaram. Aceite as alterações.', 'err'); return; }
  let tickets;
  if (S.slipMode === 'multiple') {
    if (hasConflict()) { toast('Seleções do mesmo jogo não podem ser combinadas', 'err'); return; }
    const stake = parseMoney(S.comboStake);
    if (stake < 1) { toast('Valor mínimo: R$ 1,00', 'err'); return; }
    tickets = [{ keys: items.map((i) => i.s.key), odds: items.map((i) => i.s.odds), stake }];
  } else {
    tickets = [];
    for (const it of items) {
      const stake = parseMoney(S.stakes[it.s.key]);
      if (stake > 0 && stake < 1) { toast('Valor mínimo: R$ 1,00', 'err'); return; }
      if (stake >= 1) tickets.push({ keys: [it.s.key], odds: [it.s.odds], stake });
    }
    if (!tickets.length) { toast('Informe o valor da aposta', 'err'); return; }
  }
  const total = tickets.reduce((a, t) => a + t.stake, 0);
  if (total > S.user.balance + 1e-9) { toast('Saldo insuficiente. Faça um depósito.', 'err'); openDeposit(); return; }

  S.placing = true; renderSlip();
  try {
    const res = await api('POST', '/api/bets', { tickets, acceptAny: acceptAny() });
    setUser(res.user);
    for (const r of res.rejected) toast(`Aposta recusada: ${r.reason}`, 'err');
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
    toast(e.message, 'err');
    if (e.status === 401) { S.user = null; openLogin(); }
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
  } catch (e) { toast(e.message, 'err'); }
  S.cashoutBusy = null; render();
}
const cashoutValue = (bet) => {
  if (bet.status !== 'open') return null;
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
  const label = esc(opts.wide ? sel.name : sel.lbl);
  if (isSuspended(ev)) return `<span class="odd lock ${opts.cls || ''}" title="Suspenso"><span class="lbl">${label}</span><span class="val">🔒</span></span>`;
  return `<button class="odd ${inSlip ? 'sel' : ''} ${move} ${opts.cls || ''}" data-key="${esc(sel.key)}"><span class="lbl">${label}</span><span class="val">${fmtOdd(sel.odds)}</span></button>`;
}

function timeCell(ev) {
  if (ev.state === 'in') return `<span class="lv"><span class="live-dot"></span>${esc(ev.clock || 'Ao vivo')}</span>`;
  const dd = ev.date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  if (ev.state === 'post') return `<span>${esc(ev.clock)}</span><br><span>${dd}</span>`;
  return `<b style="color:#fff">${hhmm(ev.date)}</b><br>${sameDay(ev.date, new Date()) ? 'Hoje' : dd}`;
}

function teamLine(t, ev, other) {
  const showScore = ev.state !== 'pre' && t.score != null;
  const won = ev.state === 'post' && showScore && t.score > other.score;
  return `<div class="team-line ${won ? 'won' : ''}">${t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy">` : ''}<span class="nm">${esc(t.name)}</span>${showScore ? `<span class="sc">${t.score}</span>` : ''}</div>`;
}

function evRow(ev) {
  const sels = selections(ev);
  const by = (m, p) => sels.find((s) => s.market === m && s.pick === p);
  const main = ev.sport === 'soccer' ? [by('ml', 'home'), by('ml', 'draw'), by('ml', 'away')] : [by('ml', 'home'), by('ml', 'away')];
  const tot = [by('total', 'over'), by('total', 'under')];
  const goal = ev.goalAt && Date.now() - ev.goalAt < 12000;
  const oddsHtml = ev.state === 'post' ? '' :
    main.map((s) => oddBtn(s, ev)).join('') + '<span class="gap col-total"></span>' + tot.map((s) => oddBtn(s, ev, { cls: 'col-total' })).join('');
  return `<div class="ev-row ${goal ? 'goal' : ''} ${ev.state === 'in' ? 'live' : ''}" data-ev="${ev.id}">
    <div class="ev-time">${timeCell(ev)}</div>
    <div class="ev-teams">${teamLine(ev.home, ev, ev.away)}${teamLine(ev.away, ev, ev.home)}</div>
    <div class="ev-odds">${oddsHtml}</div>
    <div class="ev-more">${ev.state !== 'post' && sels.length ? '+' + sels.length : ''}</div>
  </div>`;
}

function leagueBlocks(list) {
  const groups = new Map();
  for (const ev of list) { if (!groups.has(ev.league)) groups.set(ev.league, []); groups.get(ev.league).push(ev); }
  const keys = [...groups.keys()].sort((a, b) => LEAGUE_BY_KEY[a].order - LEAGUE_BY_KEY[b].order);
  return keys.map((k) => {
    const lg = LEAGUE_BY_KEY[k];
    const evs = groups.get(k).sort((a, b) => (b.state === 'in') - (a.state === 'in') || a.date - b.date);
    const soc = lg.sport === 'soccer';
    const allPost = evs.every((e) => e.state === 'post');
    return `<section class="league">
      <div class="league-head">${SPORTS[lg.sport].icon} ${esc(lg.name)} <span class="country">· ${esc(lg.country)}</span>
        ${allPost ? '' : `<div class="cols">${soc ? '<span>1</span><span>X</span><span>2</span>' : '<span>Casa</span><span>Fora</span>'}<span class="gap col-total"></span><span class="col-total">Mais</span><span class="col-total">Menos</span><span style="width:44px" class="col-more"></span></div>`}
      </div>
      ${evs.map(evRow).join('')}
    </section>`;
  }).join('');
}

function filtered(pred) {
  const q = S.query.trim().toLowerCase();
  const tab = ['home', 'live', 'all'].includes(S.view) && S.sportTab !== 'all' ? S.sportTab : null;
  return [...S.events.values()].filter((ev) => pred(ev) && (!tab || ev.sport === tab) && (!q || `${ev.home.name} ${ev.away.name} ${ev.leagueName}`.toLowerCase().includes(q)));
}

function sportTabs() {
  const evs = [...S.events.values()].filter((e) => e.state !== 'post' && (S.view !== 'live' || e.state === 'in'));
  const sports = Object.entries(SPORTS).filter(([k]) => evs.some((e) => e.sport === k));
  if (S.sportTab !== 'all' && !sports.some(([k]) => k === S.sportTab)) S.sportTab = 'all';
  const btn = (k, label, n) => `<button class="${S.sportTab === k ? 'active' : ''}" data-sporttab="${k}">${label}<span class="tab-cnt">${n}</span></button>`;
  return `<div class="tabs sport-tabs">${btn('all', 'Todos', evs.length)}${sports.map(([k, sp]) => btn(k, `${sp.icon} ${esc(sp.name)}`, evs.filter((e) => e.sport === k).length)).join('')}</div>`;
}
const isToday = (ev) => sameDay(ev.date, new Date());
const isTomorrow = (ev) => { const t = new Date(); t.setDate(t.getDate() + 1); return sameDay(ev.date, t); };

function heroCard(ev) {
  const sels = selections(ev).filter((s) => s.market === 'ml');
  return `<div class="hero-card" data-ev="${ev.id}">
    <div class="hero-top"><span class="lg">${SPORTS[ev.sport].icon} ${esc(ev.leagueName)}</span><span style="color:var(--red);font-weight:700;display:flex;gap:5px;align-items:center"><span class="live-dot"></span>${esc(ev.clock || '')}</span></div>
    <div class="hero-teams">
      <div class="hero-team">${ev.home.logo ? `<img src="${esc(ev.home.logo)}" alt="">` : ''}${esc(ev.home.short)}</div>
      <div class="hero-score">${ev.home.score ?? 0}:${ev.away.score ?? 0}</div>
      <div class="hero-team">${ev.away.logo ? `<img src="${esc(ev.away.logo)}" alt="">` : ''}${esc(ev.away.short)}</div>
    </div>
    <div class="hero-odds">${sels.length ? sels.map((s) => oddBtn(s, ev)).join('') : '<span class="muted" style="font-size:12px">Mercados suspensos</span>'}</div>
  </div>`;
}

function homeBanner() {
  if (!S.user) return `<div class="banner"><div><h3>Crie sua conta grátis</h3><p>Cadastre-se em 1 minuto, deposite via PIX e aposte nos jogos que estão rolando agora.</p></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-ghost" data-action="login">Entrar</button><button class="btn btn-green" data-action="register">Cadastrar</button></div></div>`;
  if (isPaused()) return `<div class="banner"><div><h3>Conta em pausa</h3><p>Até ${fmtDT(S.user.excludedUntil)} não pode depositar nem apostar. Pode sacar o saldo quando quiser.</p></div><button class="btn btn-ghost" data-action="withdraw">Sacar</button></div>`;
  if (S.user.balance <= 0 && !S.bets.length) return `<div class="banner"><div><h3>Olá, ${esc(S.user.name.split(' ')[0])}! Faça seu primeiro depósito</h3><p>Deposite via PIX: o saldo é creditado em segundos.</p></div><button class="btn btn-green" data-action="deposit">Depositar</button></div>`;
  return '';
}

/* ---------------- cassino ---------------- */
const CASINO_GAMES = [
  { id: 'decola', name: 'Aviator', tag: 'Crash', href: '/decola', desc: 'Quanto mais alto, maior o multiplicador', img: 'img/decola-capa.webp?v=4' },
  { id: 'mines', name: 'Mines', tag: 'Minas', href: '/mines', desc: 'Encontre os diamantes e fuja das minas', img: 'img/mines-capa.webp?v=1' },
  { abrir: 'fortune-tiger', name: 'Fortune Tiger', tag: 'PG Soft', href: '#', desc: 'O tigre que paga', img: 'img/slots/fortune-tiger.webp' },
  { abrir: 'fortune-ox', name: 'Fortune Ox', tag: 'PG Soft', href: '#', desc: 'Touro da fortuna', img: 'img/slots/fortune-ox.webp' },
  { abrir: 'fortune-dragon', name: 'Fortune Dragon', tag: 'PG Soft', href: '#', desc: 'Dragão da fortuna', img: 'img/slots/fortune-dragon.webp' },
  { abrir: 'fortune-rabbit', name: 'Fortune Rabbit', tag: 'PG Soft', href: '#', desc: 'Coelho da sorte', img: 'img/slots/fortune-rabbit.webp' },
  { abrir: 'fortune-mouse', name: 'Fortune Mouse', tag: 'PG Soft', href: '#', desc: 'Rato da fortuna', img: 'img/slots/fortune-mouse.webp' },
  { abrir: 'bikini-paradise', name: 'Bikini Paradise', tag: 'PG Soft', href: '#', desc: 'Praia e prémios', img: 'img/slots/bikini-paradise.webp' },
  { abrir: 'jungle-delight', name: 'Jungle Delight', tag: 'PG Soft', href: '#', desc: 'Selva selvagem', img: 'img/slots/jungle-delight.webp' },
  { abrir: 'ganesha-gold', name: 'Ganesha Gold', tag: 'PG Soft', href: '#', desc: 'Deus da prosperidade', img: 'img/slots/ganesha-gold.webp' },
  { abrir: 'double-fortune', name: 'Double Fortune', tag: 'PG Soft', href: '#', desc: 'Fortuna em dobro', img: 'img/slots/double-fortune.webp' },
  { abrir: 'dragon-tiger-luck', name: 'Dragon Tiger Luck', tag: 'PG Soft', href: '#', desc: 'Dragão contra tigre', img: 'img/slots/dragon-tiger-luck.webp' },
  { abrir: 'ninja-raccoon', name: 'Ninja Raccoon Frenzy', tag: 'PG Soft', href: '#', desc: 'Guaxinim ninja', img: 'img/slots/ninja-raccoon.webp' },
  { abrir: 'lucky-clover', name: 'Lucky Clover Lady', tag: 'PG Soft', href: '#', desc: 'Trevo da sorte', img: 'img/slots/lucky-clover.webp' },
  { abrir: 'ultimate-striker', name: 'Ultimate Striker', tag: 'PG Soft', href: '#', desc: 'Futebol e prémios', img: 'img/slots/ultimate-striker.webp' },
  { abrir: 'prosper-ftree', name: 'Prosperity Fortune Tree', tag: 'PG Soft', href: '#', desc: 'Árvore da prosperidade', img: 'img/slots/prosper-ftree.webp' },
  { abrir: 'chicky-run', name: 'Chicky Run', tag: 'PG Soft', href: '#', desc: 'A galinha corredora', img: 'img/slots/chicky-run.webp' },
  { abrir: 'butterfly-blossom', name: 'Butterfly Blossom', tag: 'PG Soft', href: '#', desc: 'Borboletas douradas', img: 'img/slots/butterfly-blossom.webp' },
  { abrir: 'piggy-gold', name: 'Piggy Gold', tag: 'PG Soft', href: '#', desc: 'Porquinho da fortuna', img: 'img/slots/piggy-gold.webp' },
  { abrir: 'wild-bandito', name: 'Wild Bandito', tag: 'PG Soft', href: '#', desc: 'Fora da lei', img: 'img/slots/wild-bandito.webp' },
  { abrir: 'zombie-outbreak', name: 'Zombie Outbreak', tag: 'PG Soft', href: '#', desc: 'Zumbis na cidade', img: 'img/slots/zombie-outbreak.webp' },
  { abrir: 'majestic-ts', name: 'Majestic Treasures', tag: 'PG Soft', href: '#', desc: 'Tesouros majestosos', img: 'img/slots/majestic-ts.webp' },
  { abrir: 'thai-river', name: 'Thai River Wonders', tag: 'PG Soft', href: '#', desc: 'Rio tailandês', img: 'img/slots/thai-river.webp' },
  { abrir: 'gdn-ice-fire', name: 'Guardians of Ice & Fire', tag: 'PG Soft', href: '#', desc: 'Gelo e fogo', img: 'img/slots/gdn-ice-fire.webp' },
  { abrir: 'rise-apollo', name: 'Rise of Apollo', tag: 'PG Soft', href: '#', desc: 'O deus do sol', img: 'img/slots/rise-apollo.webp' },
  { abrir: 'wild-bounty-sd', name: 'Wild Bounty Showdown', tag: 'PG Soft', href: '#', desc: 'Caça ao tesouro', img: 'img/slots/wild-bounty-sd.webp' },
  { abrir: 'treasures-aztec', name: 'Treasures of Aztec', tag: 'PG Soft', href: '#', desc: 'Tesouros astecas', img: 'img/slots/treasures-aztec.webp' },
  { abrir: 'three-cz-pigs', name: 'Three Crazy Piggies', tag: 'PG Soft', href: '#', desc: 'Três porquinhos', img: 'img/slots/three-cz-pigs.webp' },
];
// só os jogos ligados no servidor; os slots dependem do serviço de slots estar ligado
const casinoGames = () => CASINO_GAMES.filter((g) => (S.games && (g.abrir ? S.games.slots : S.games[g.id])));
const casinoCard = (g) =>
  `<a class="cg-card" href="${g.href}"${g.abrir ? ` data-abrir="${g.abrir}" data-nome="${esc(g.name)}"` : ''} title="${esc(g.name)}"><div class="cg-art"><img src="${g.img}" class="cg-cover" alt="${esc(g.name)}" loading="lazy" onerror="this.onerror=null;this.style.display='none'"></div></a>`;
function homeCasino() {
  if (!S.casino) return '';
  return `<div class="section-head"><h2>Cassino</h2><a href="#cassino" class="see-all" data-view="casino">Ver todos ›</a></div>
    <div class="cg-grid cg-row">${casinoGames().map(casinoCard).join('')}</div>`;
}
function renderCasino() {
  if (!S.casino) return `<div class="empty-state">O cassino não está disponível neste momento.</div>`;
  const card = casinoCard;
  return `<div class="cg-hero"><h1>Cassino</h1></div>
    <div class="section-head"><h2>Jogos</h2><span class="muted">${casinoGames().filter((g) => !g.soon).length} disponíveis</span></div>
    <div class="cg-grid">${casinoGames().map(card).join('')}</div>
    <p class="muted" style="font-size:12px;margin-top:18px">18+ · Jogue com responsabilidade. Os seus limites de perda e a pausa da conta valem também para o cassino.</p>`;
}

function renderMain() {
  const main = $('#main');
  if (!S.loaded) return;
  if (S.failed && !S.events.size) {
    main.innerHTML = `<div class="empty-state">Não foi possível conectar ao servidor.<br>Verifique se o servidor está rodando (iniciar.bat) — tentaremos de novo automaticamente.</div>`;
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
      html += homeBanner();
      html += homeCasino();
      html += sportTabs();
      const featured = live.filter((e) => e.markets).sort((a, b) => LEAGUE_BY_KEY[a.league].order - LEAGUE_BY_KEY[b.league].order).slice(0, 8);
      if (featured.length) html += `<div class="section-head"><span class="live-dot"></span><h2>Ao vivo agora</h2><span class="muted">${live.length} eventos</span></div><div class="hero">${featured.map(heroCard).join('')}</div>`;
      const upcoming = filtered((e) => e.state === 'pre' && (isToday(e) || isTomorrow(e)) && e.markets);
      html += `<div class="section-head"><h2>Próximos jogos</h2></div>`;
      html += upcoming.length ? leagueBlocks(upcoming) : `<div class="empty-state">Nenhum jogo com odds disponível hoje.</div>`;
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
      html += `<div class="section-head">${v === 'live' ? '<span class="live-dot"></span>' : ''}<h2>${esc(titles[v])}</h2><span class="muted">${list.length} eventos</span></div>`;
      if (v === 'league') {
        const lv = list.filter((e) => e.state === 'in'), pre = list.filter((e) => e.state === 'pre'), post = list.filter((e) => e.state === 'post');
        if (lv.length) html += leagueBlocks(lv);
        if (pre.length) html += leagueBlocks(pre);
        if (post.length) html += `<div class="section-head"><h2 style="font-size:16px">Resultados</h2></div>` + leagueBlocks(post);
        if (!list.length) html += `<div class="empty-state">Sem jogos desta liga hoje ou amanhã.</div>`;
      } else {
        html += list.length ? leagueBlocks(list) : `<div class="empty-state">${v === 'live' ? 'Nenhum jogo ao vivo neste momento. Veja os próximos jogos em "Hoje".' : 'Nenhum evento encontrado.'}</div>`;
      }
    }
  }
  main.innerHTML = html;
  if (S.keepScroll) window.scrollTo(0, scrollY);
  S.keepScroll = true;
}

function renderEvent() {
  const ev = S.events.get(S.eventId);
  if (!ev) return `<a href="#" class="back" data-action="back">← Voltar</a><div class="empty-state">Evento não encontrado.</div>`;
  const sels = selections(ev);
  const groups = {};
  for (const s of sels) (groups[s.marketName] ||= []).push(s);
  const form = (f) => (f ? `<div class="form">${f.split('').slice(-5).map((c) => `<i class="${c}">${c === 'W' ? 'V' : c === 'L' ? 'D' : 'E'}</i>`).join('')}</div>` : '');
  const status = ev.state === 'in' ? `<div class="big-clock"><span class="live-dot"></span> ${esc(ev.clock)}</div>`
    : `<div class="big-clock" style="color:var(--muted)">${ev.state === 'post' ? esc(ev.clock) : dateLabel(ev.date)}</div>`;
  const score = ev.state === 'pre' ? 'vs' : `${ev.home.score ?? 0} : ${ev.away.score ?? 0}`;
  let html = `<a href="#" class="back" data-action="back">← Voltar</a>
  <div class="ev-detail-head">
    <div class="hero-top"><span>${SPORTS[ev.sport].icon} ${esc(ev.leagueName)} · ${esc(ev.country)}</span><span>${esc(ev.venue)}</span></div>
    <div class="ev-detail-teams">
      <div class="hero-team">${ev.home.logo ? `<img src="${esc(ev.home.logo)}" alt="">` : ''}${esc(ev.home.name)}${form(ev.home.form)}</div>
      <div><div class="big-score">${score}</div>${status}</div>
      <div class="hero-team">${ev.away.logo ? `<img src="${esc(ev.away.logo)}" alt="">` : ''}${esc(ev.away.name)}${form(ev.away.form)}</div>
    </div>
  </div>`;
  if (ev.state !== 'post') {
    if ((ev.suspendedUntil || 0) > Date.now()) html += `<div class="suspended-banner">🔒 Mercados suspensos temporariamente (gol / lance perigoso). Reabrem em instantes.</div>`;
    if (!sels.length) html += `<div class="empty-state">Nenhum mercado aberto para este evento no momento.</div>`;
    // os totais de gols ficam juntos e por ordem de linha (0.5, 1.5, 2.5...)
    let entries = Object.entries(groups);
    const isTot = ([n]) => /^Total de Gols — /.test(n);
    const firstTot = entries.findIndex(isTot);
    if (firstTot >= 0) {
      const tots = entries.filter(isTot).sort((a, b) => parseFloat(a[0].split('— ')[1]) - parseFloat(b[0].split('— ')[1]));
      entries = entries.filter((e) => !isTot(e));
      entries.splice(firstTot, 0, ...tots);
    }
    for (const [name, list] of entries) {
      html += `<div class="market"><div class="market-head">${esc(name)}${ev.state === 'in' ? '<small>Ao vivo · odds reais</small>' : ''}</div><div class="market-body${list.length > 4 ? ' many' : ''}">${list.map((s) => oddBtn(s, ev, { wide: true, cls: 'wide-odd' })).join('')}</div></div>`;
    }
  }
  const tl = ev.details.filter((d) => d.goal || d.red || d.yellow);
  if (tl.length) {
    html += `<div class="section-head" style="margin-top:16px"><h2 style="font-size:16px">Lances</h2></div><div class="timeline">` +
      tl.slice().reverse().map((d) => `<div class="tl-item ${d.teamId === ev.away.id ? 'away' : ''}"><span class="min">${esc(d.min)}</span><span>${d.goal ? '⚽' : d.red ? '🟥' : '🟨'}</span><span>${esc(d.player)}${d.pen ? ' (pên.)' : ''}${d.own ? ' (contra)' : ''}</span></div>`).join('') + `</div>`;
  }
  return html;
}

/* ---------------- render: apostas ---------------- */
function betCard(bet) {
  const legs = bet.legs.map((l) => {
    const ev = S.events.get(l.evId);
    let live = '';
    if (!l.result && ev) live = ev.state === 'in' ? `<span class="ls">● ${esc(ev.clock)} · ${ev.home.score}-${ev.away.score}</span>` : ev.state === 'pre' ? `<span class="lm">${dateLabel(ev.date)}</span>` : '';
    const cls = !l.result ? '' : l.result.includes('won') ? 'won' : l.result.includes('lost') ? 'lost' : 'void';
    return `<div class="leg ${cls}">
      <div class="lp"><span>${esc(l.name)}</span><span style="color:var(--yellow)">${fmtOdd(l.odds)}</span></div>
      <div class="lm">${esc(l.marketName)} · ${esc(l.event)}</div>
      ${l.result ? `<span class="lm">${RES_PT[l.result]} · Final ${esc(l.final)}</span>` : live}
    </div>`;
  }).join('');
  let action = '';
  if (bet.status === 'open') {
    const co = cashoutValue(bet);
    if (S.cashoutBusy === bet.id) action = `<button class="cashout-btn" disabled>${bet.legs.some((l) => !l.result && S.events.get(l.evId)?.state === 'in') ? `Aprovando Cash Out (até ${S.liveCashoutDelay || 25}s)...` : 'Processando Cash Out...'}</button>`;
    else if (co) action = `<button class="cashout-btn ${S.cashoutConfirm === bet.id ? 'confirm' : ''}" data-cashout="${bet.id}">${S.cashoutConfirm === bet.id ? `Confirmar Cash Out ${money(co)}` : `Cash Out ${money(co)}`}</button>`;
    else action = `<button class="cashout-btn" disabled>Cash Out indisponível</button>`;
  }
  return `<div class="bet-card">
    <div class="bet-head"><span class="bet-type">${bet.type === 'multiple' ? `Múltipla (${bet.legs.length})` : 'Simples'}</span><span class="bet-status st-${bet.status}">${ST_PT[bet.status]}</span></div>
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
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px">${list.map(betCard).join('') || `<div class="empty-state" style="grid-column:1/-1">Nenhuma aposta ${tab === 'open' ? 'aberta' : 'encerrada'}.</div>`}</div>`;
}

function renderSlip() {
  const open = S.bets.filter((b) => b.status === 'open');
  $('#slipCount').textContent = S.slip.length;
  $('#openCount').textContent = open.length;
  $('#slipFabCount').textContent = S.slip.length;
  document.querySelectorAll('.slip-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.slipTab));
  const body = $('#slipBody');
  if (S.slipTab === 'open') {
    body.innerHTML = !S.user ? `<div class="slip-empty"><div class="ic">🔐</div>Entre na sua conta para ver as apostas abertas.<br><br><button class="btn btn-green" data-action="login">Entrar</button></div>`
      : open.length ? open.map(betCard).join('') : `<div class="slip-empty"><div class="ic">🎫</div>Você não tem apostas abertas.</div>`;
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
  const totalOdds = round2(items.reduce((p, i) => p * (i.sel ? i.sel.odds : 1), 1));
  $('#slipFabOdds').textContent = multi ? '@ ' + fmtOdd(totalOdds) : '';
  let html = `<div class="slip-mode"><button class="${!multi ? 'active' : ''}" data-mode="single">Simples</button><button class="${multi ? 'active' : ''}" data-mode="multiple" ${S.slip.length < 2 || conflict ? 'disabled' : ''}>Múltipla</button></div>`;
  for (const { s, ev, sel, suspended, changed } of items) {
    const stake = S.stakes[s.key] || '';
    const ret = sel ? parseMoney(stake) * sel.odds : 0;
    html += `<div class="slip-item ${suspended ? 'bad' : ''}">
      <button class="x" data-remove="${esc(s.key)}" title="Remover">×</button>
      <div class="si-pick"><span>${esc(sel ? sel.name : 'Seleção indisponível')}</span><span class="si-odds">${changed ? `<span class="old">${fmtOdd(s.odds)}</span>` : ''}${sel ? fmtOdd(sel.odds) : '-'}</span></div>
      <div class="si-market">${esc(sel ? sel.marketName : '')}</div>
      <div class="si-event">${ev ? `${ev.state === 'in' ? `<span class="live-dot"></span><b style="color:var(--red)">${esc(ev.clock)}</b> ${ev.home.score}-${ev.away.score} · ` : ''}${esc(ev.home.short)} x ${esc(ev.away.short)}` : ''}</div>
      ${suspended ? `<div class="si-warn red">🔒 ${!sel && ev && ev.markets ? 'Linha alterada — mercado indisponível' : 'Mercado suspenso'}</div>` : changed ? `<div class="si-warn">A odd mudou de ${fmtOdd(s.odds)} para ${fmtOdd(sel.odds)}</div>` : ''}
      ${!multi ? `<div class="stake-row"><label class="stake"><span>R$</span><input inputmode="decimal" data-stake="${esc(s.key)}" value="${esc(stake)}" placeholder="0,00"></label><div class="ret">Retorno<b>${money(ret)}</b></div></div>` : ''}
    </div>`;
  }
  if (conflict) html += `<div class="si-warn" style="margin-bottom:8px">Seleções do mesmo jogo não podem ser combinadas em múltipla.</div>`;
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
  const label = !S.user ? 'Entrar para apostar' : S.placing ? (live ? `Aprovando aposta ao vivo (até ${S.liveDelay || 25}s)...` : 'Processando...') : `Apostar ${money(totalStake)}`;
  html += `<button class="btn btn-green btn-block" data-action="place" ${S.placing ? 'disabled' : ''}>${label}</button>
    <button class="clear-link" data-action="clear">Limpar boletim</button>`;
  body.innerHTML = html;
}

/* ---------------- render: sidebar / header ---------------- */
function renderSidebar() {
  const evs = [...S.events.values()];
  const liveN = evs.filter((e) => e.state === 'in').length;
  const item = (view, label, cnt) => `<button class="side-item ${S.view === view ? 'active' : ''}" data-view="${view}">${label}<span class="cnt ${view === 'live' && cnt ? 'live' : ''}">${cnt ?? ''}</span></button>`;
  let html = `<div class="side-title">Esportes</div>
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
    html += `<div class="side-leagues">`;
    if (lgs.length > 1) html += `<button class="side-item ${S.view === 'sport' && S.sport === sk ? 'active' : ''}" data-sport="${sk}">Todos<span class="cnt">${sCnt}</span></button>`;
    for (const l of lgs) {
      const le = evs.filter((e) => e.league === l.key);
      const lv = le.filter((e) => e.state === 'in').length;
      html += `<button class="side-item ${S.view === 'league' && S.league === l.key ? 'active' : ''}" data-league="${l.key}">${esc(l.name)}<span class="cnt ${lv ? 'live' : ''}">${lv ? '● ' + lv : le.filter((e) => e.state !== 'post').length}</span></button>`;
    }
    html += `</div>`;
  }
  if (S.casino) {
    html += `<div class="side-title side-casino-title">Cassino</div>
    <button class="side-item side-sport ${S.view === 'casino' ? 'active' : ''}" data-view="casino"><span class="ic">🎲</span>Todos os jogos<span class="cnt">${casinoGames().length}</span></button>
    ${S.games.decola ? `<a class="side-item side-sport" href="/decola"><span class="ic">✈️</span>Aviator</a>` : ''}
    ${S.games.mines ? `<a class="side-item side-sport" href="/mines"><span class="ic">💎</span>Mines<span class="cnt hot">NOVO</span></a>` : ''}
    ${S.games.slots ? CASINO_GAMES.filter((g) => g.abrir).map((g) => `<a class="side-item side-sport" href="#" data-abrir="${g.abrir}" data-nome="${esc(g.name)}"><span class="ic">🎰</span>${esc(g.name)}</a>`).join('') : ''}`;
  }
  $('#sidebar').innerHTML = html;
  $('#liveCountNav').textContent = liveN;
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
  if (S.lastUpdate) $('#lastUpdate').textContent = '· Última atualização ' + new Date(S.lastUpdate).toLocaleTimeString('pt-BR');
}

function render() {
  const sk = $('#skeleton'); if (sk && S.loaded) sk.remove();
  renderHeader(); renderSidebar(); renderMain(); renderSlip();
}
// não redesenha campos com foco (para não perder o que está a ser escrito)
function safeRender() {
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
    <div class="note">Não tem conta? <a href="#" data-action="register" class="link">Cadastre-se grátis</a></div>`);
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
      openModal(`<div class="success"><div class="ic">✓</div><h3>Pedido de saque recebido</h3><p class="sub">${money(v)} para a chave PIX ${esc(S.user.cpf)}.<br>A nossa equipa confere e envia o PIX em ${esc(S.payments.withdrawEta)}. Acompanhe no Extrato.</p><button class="btn btn-green btn-block" data-action="close-modal">OK</button></div>`);
    } catch (e) { busy(btn, false); formErr(e.message); loadAccount().then(() => renderHeader()); }
  }
}

const WD_LABEL = { PENDING: 'pendente', PROCESSING: 'em processamento', PAID: 'pago', REJECTED: 'recusado', CANCELED: 'cancelado', CREATING: 'pendente', FAILED: 'falhou', REVIEW: 'em análise' };
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
      ${u.isAdmin ? '<a class="btn btn-ghost btn-block" style="margin-top:16px" href="/admin">Abrir o painel da equipa</a>' : ''}
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
function go(view, extra = {}) {
  Object.assign(S, { view, league: null, sport: null }, extra);
  S.keepScroll = false;
  closeDrawers(); render(); window.scrollTo(0, 0);
}
function closeDrawers() { $('#sidebar').classList.remove('open'); $('#slip').classList.remove('open'); if (!$('#modal').classList.contains('show')) $('#overlay').classList.remove('show'); }

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a, .ev-row, .hero-card');
  if (!t) return;
  const d = t.dataset;
  if (d.abrir) { e.preventDefault(); if (window.abrirFortuneTiger) window.abrirFortuneTiger(d.abrir, d.nome); return; }// slots: abre o modal
  if (d.key) { e.stopPropagation(); toggleSel(d.key); return; }
  if (d.cashout) {
    if (S.cashoutConfirm === d.cashout) doCashout(d.cashout);
    else { S.cashoutConfirm = d.cashout; render(); setTimeout(() => { if (S.cashoutConfirm === d.cashout) { S.cashoutConfirm = null; render(); } }, 5000); }
    return;
  }
  if (d.remove) { toggleSel(d.remove); return; }
  if (d.mode) { S.slipMode = d.mode; renderSlip(); return; }
  if (d.tab) { S.slipTab = d.tab; renderSlip(); return; }
  if (d.quick) { S.comboStake = String(round2(parseMoney(S.comboStake) + +d.quick)).replace('.', ','); renderSlip(); return; }
  if (d.chip) { depState.amount = +d.chip; if ($('#depCpf')) depState.cpf = $('#depCpf').value; openDeposit(); return; }
  if (d.method) { depState.amount = parseMoney($('#depAmount').value) || depState.amount; depState.method = d.method; openDeposit(); return; }
  if (d.betstab) { S.betsTab = d.betstab; renderMain(); return; }
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
  if (d.togglesport) { S.openSport = S.openSport === d.togglesport ? null : d.togglesport; renderSidebar(); return; }
  if (d.sporttab) { S.sportTab = d.sporttab; S.keepScroll = true; renderMain(); return; }
  if (d.view) { e.preventDefault(); go(d.view); return; }
  if (d.ev) { S.prevView = S.view === 'event' ? S.prevView : { view: S.view, league: S.league, sport: S.sport }; go('event', { eventId: d.ev }); return; }
  if (!d.action) return;
  if (t.tagName === 'A') e.preventDefault();
  switch (d.action) {
    case 'place': placeBets(); break;
    case 'clear': S.slip = []; S.stakes = {}; S.comboStake = ''; S.slipMode = 'single'; render(); break;
    case 'accept': S.slip.forEach((s) => { const { sel } = findSel(s.key); if (sel) s.odds = sel.odds; }); renderSlip(); break;
    case 'back': { const p = S.prevView || { view: 'home' }; go(p.view, { league: p.league, sport: p.sport }); } break;
    case 'login': openLogin(); break;
    case 'register': openRegister(); break;
    case 'account': openAccount('profile'); break;
    case 'logout': logout(); break;
    case 'deposit': openDeposit(); break;
    case 'do-deposit': doDeposit(); break;
    case 'withdraw': openWithdraw(); break;
    case 'do-withdraw': doWithdraw(); break;
    case 'close-modal': closeModal(); break;
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
    const odds = slipState().reduce((p, i) => p * (i.sel ? i.sel.odds : 1), 1);
    if ($('#potRet')) $('#potRet').textContent = money(parseMoney(t.value) * odds);
    const btn = document.querySelector('[data-action="place"]'); if (btn && !S.placing && S.user) btn.textContent = `Apostar ${money(parseMoney(t.value))}`;
  } else if (t.id === 'depCpf' || t.id === 'regCpf') {
    t.value = maskCpf(t.value);
  } else if (t.id === 'search') {
    S.query = t.value;
    if (['event', 'mybets'].includes(S.view)) S.view = 'today';
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
$('#overlay').onclick = closeModal;
$('#menuBtn').onclick = () => { $('#sidebar').classList.add('open'); $('#overlay').classList.add('show'); };
$('#slipFab').onclick = () => { $('#slip').classList.add('open'); $('#overlay').classList.add('show'); };

/* ---------------- slots (Fortune Tiger) ---------------- */
// o modal vive no index.html; aqui só expomos uma função para o site refrescar o saldo ao fechar
window.tugasRefreshSaldo = async () => { try { await loadAccount(); render(); } catch { /* ignora */ } };

/* ---------------- início ---------------- */
(async function start() {
  renderHeader();
  await Promise.all([loadEvents(), loadAccount('first')]);
  api('GET', '/api/site').then(({ site }) => {
    const parts = [site.company, site.cnpj && 'CNPJ ' + site.cnpj, site.license && 'Autorização SPA/MF: ' + site.license, site.supportEmail].filter(Boolean);
    const el = $('#siteInfo'); if (el) el.textContent = parts.join(' · ');
  }).catch(() => { });
  if (location.hash === '#cassino' && S.casino) S.view = 'casino';
  render();
  setInterval(async () => { if (await loadEvents()) safeRender(); }, EVENTS_MS);
  setInterval(async () => { if (S.user) { await loadAccount(); safeRender(); } }, ACCOUNT_MS);
  // reabre mercados e apaga setas sem esperar o próximo ciclo
  setInterval(() => {
    const now = Date.now();
    if ([...S.events.values()].some((e) => e.suspendedUntil && e.suspendedUntil <= now && e.suspendedUntil > now - 1000)) safeRender();
  }, 1000);
})();