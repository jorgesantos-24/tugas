'use strict';
/* MINES — navegador. O servidor decide tudo (onde estão as minas, prêmios, saldo);
   aqui desenhamos o tabuleiro, tocamos os sons e mandamos as jogadas. */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (v) => BRL.format(v || 0);
const fx = (m) => Number(m).toFixed(2).replace('.', ',') + 'x';
const num2 = (v) => Number(v).toFixed(2).replace('.', ',');
const parseNum = (s) => { const n = parseFloat(String(s ?? '').replace(/\s|R\$|x/gi, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const hhmm = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem storage */ } };

async function api(method, url, body) {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  let data = {};
  try { data = await r.json(); } catch { /* vazio */ }
  if (!r.ok) { const e = new Error(data.error || 'Falha de comunicação com o servidor.'); e.status = r.status; throw e; }
  return data;
}
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
function openModal(html) {
  $('#modal').innerHTML = `<button class="close" data-close>×</button>` + html;
  $('#modal').classList.add('show'); $('#overlay').classList.add('show');
}
function closeModal() { $('#modal').classList.remove('show'); $('#overlay').classList.remove('show'); }
const setHtml = (el, html) => { if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; return true; } return false; };

/* ---------------- estado ---------------- */
const G = {
  user: null, testMode: false, st: null, game: null, last: null,
  amount: lsGet('mn_amount', 5), mines: lsGet('mn_mines', 3),
  busy: false, pending: null, side: lsGet('mn_side', 'all'), my: null, myAt: 0,
};
const EDGE_DEF = 0.03;
// mesma fórmula do servidor (só para mostrar a escada de multiplicadores)
function multFor(k, m) {
  if (k <= 0) return 1;
  let x = 1 - (G.st?.limits.edge ?? EDGE_DEF);
  for (let i = 0; i < k; i++) x *= (25 - i) / (25 - m - i);
  return Math.floor(x * 100 + 1e-9) / 100;
}

/* ---------------- sons (gerados no navegador) ---------------- */
const SND = { on: lsGet('mn_sound', true), ctx: null };
function audio() {
  if (!SND.on) return null;
  if (!SND.ctx) { try { SND.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  if (SND.ctx.state === 'suspended') SND.ctx.resume().catch(() => {});
  return SND.ctx.state === 'running' ? SND.ctx : null;
}
function blip(freqs, dur = 0.09, type = 'sine', vol = 0.12) {
  const a = audio(); if (!a) return;
  freqs.forEach((f, i) => {
    const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + i * dur;
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + dur * 1.8);
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur * 2);
  });
}
function boom() {
  const a = audio(); if (!a) return;
  const len = Math.floor(a.sampleRate * 0.7), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  f.type = 'lowpass'; f.frequency.value = 900; g.gain.value = 0.25;
  src.buffer = buf; src.connect(f); f.connect(g); g.connect(a.destination); src.start();
  blip([150, 70], 0.12, 'sine', 0.18);
}
const sndGem = (k) => blip([600 + k * 45, 900 + k * 60], 0.06, 'sine', 0.11);
const sndBet = () => blip([520], 0.05, 'triangle', 0.08);
const sndCash = () => blip([660, 880, 1320], 0.08, 'sine', 0.12);
function renderSound() { $('#soundBtn').textContent = SND.on ? '🔊' : '🔇'; }

/* ---------------- servidor ---------------- */
async function loadMe() {
  try {
    const d = await api('GET', '/api/me');
    G.user = d.user; G.testMode = !!d.testMode;
    $('#testBar').hidden = !G.testMode;
    if (d.minesCert) $('#certInfo').textContent = 'Mines · certificado ' + d.minesCert;
  } catch { /* tenta de novo depois */ }
  renderWallet();
}
async function poll() {
  try {
    const d = await api('GET', '/api/mines/state');
    G.st = d;
    if (!G.busy) { // não mexe no jogo enquanto uma jogada está a caminho
      if (d.game) G.game = d.game;
      else if (G.game && G.game.status === 'open') G.game = null;
    }
    renderAll();
  } catch { /* sem ligação: tenta de novo */ }
}

/* ---------------- jogadas ---------------- */
async function start() {
  if (!G.user) return openLogin();
  const lim = G.st?.limits;
  if (lim && (G.amount < lim.min || G.amount > lim.max)) return toast(`Aposta entre ${money(lim.min)} e ${money(lim.max)}.`, 'err');
  if (G.amount > G.user.balance) return toast('Saldo insuficiente.', 'err');
  G.busy = true; renderAll();
  try {
    const d = await api('POST', '/api/mines/start', { amount: G.amount, mines: G.mines });
    G.game = d.game; G.last = null; G.user = d.user; sndBet(); renderWallet();
  } catch (e) { toast(e.message, 'err'); }
  G.busy = false; renderAll();
}
async function reveal(cell) {
  const g = G.game;
  if (!g || g.status !== 'open' || G.busy || g.revealed.includes(cell)) return;
  G.busy = true; G.pending = cell; renderAll();
  try {
    const d = await api('POST', '/api/mines/reveal', { cell });
    G.game = d.game;
    if (d.game.status === 'lost') onLost(cell);
    else if (d.game.status === 'won') { G.user = d.user; renderWallet(); onWon(d.game, true); }
    else sndGem(d.game.revealed.length);
  } catch (e) { toast(e.message, 'err'); }
  G.busy = false; G.pending = null; renderAll();
}
function randomCell() {
  const g = G.game; if (!g || g.status !== 'open') return;
  const free = [...Array(25).keys()].filter((i) => !g.revealed.includes(i));
  reveal(free[Math.floor(Math.random() * free.length)]);
}
async function cashOut() {
  const g = G.game;
  if (!g || g.status !== 'open' || !g.revealed.length || G.busy) return;
  G.busy = true; renderAll();
  try {
    const d = await api('POST', '/api/mines/cashout', {});
    G.game = d.game; G.user = d.user; renderWallet(); onWon(d.game, false);
  } catch (e) { toast(e.message, 'err'); }
  G.busy = false; renderAll();
}
function onLost() {
  boom();
  const st = $('.mn-stage'); st.classList.remove('shake'); void st.offsetWidth; st.classList.add('shake');
  floatMsg(`<small>Boom! Encontrou uma mina</small>− ${money(G.game.stake)}`, 'bad');
  afterEnd();
}
function onWon(g, auto) {
  sndCash();
  floatMsg(`<small>${auto ? 'Todas as casas seguras! ' : ''}Você sacou ${fx(g.mult)}</small>+ ${money(g.payout)}`, 'ok');
  afterEnd();
}
function afterEnd() {
  G.last = G.game;
  setTimeout(() => { poll(); if (G.side === 'my') loadMy(true); }, 300);
}
function floatMsg(html, kind) {
  const el = document.createElement('div');
  el.className = 'dc-float mn-float ' + kind; el.innerHTML = html;
  $('#fx').appendChild(el); setTimeout(() => el.remove(), 1900);
}

/* ---------------- desenho ---------------- */
const GEM = `<svg viewBox="0 0 64 64" class="mn-ic"><defs><linearGradient id="gm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7dffb6"/><stop offset=".55" stop-color="#1fd36f"/><stop offset="1" stop-color="#0a8f3c"/></linearGradient></defs><path d="M16 8h32l12 16-28 34L4 24z" fill="url(#gm)"/><path d="M4 24h56M16 8l8 16 8-16 8 16 8-16M24 24l8 34 8-34" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="2" stroke-linejoin="round"/></svg>`;
const BOMB = `<svg viewBox="0 0 64 64" class="mn-ic"><defs><radialGradient id="bm" cx=".35" cy=".35" r=".8"><stop offset="0" stop-color="#ff7a86"/><stop offset=".5" stop-color="#ee2b3f"/><stop offset="1" stop-color="#7a1020"/></radialGradient></defs><circle cx="30" cy="36" r="20" fill="url(#bm)"/><rect x="34" y="10" width="10" height="9" rx="2" transform="rotate(35 39 14)" fill="#3a3f45"/><path d="M44 10q6-6 10 0" fill="none" stroke="#ffcc1f" stroke-width="3" stroke-linecap="round"/><circle cx="55" cy="8" r="3.5" fill="#ffdc4f"/><circle cx="23" cy="29" r="5" fill="rgba(255,255,255,.45)"/></svg>`;

function boardHtml() {
  const g = G.game && (G.game.status === 'open' ? G.game : G.last || G.game);
  const open = G.game && G.game.status === 'open';
  let html = '';
  for (let i = 0; i < 25; i++) {
    let cls = 'mn-cell', inner = '';
    if (g) {
      const isRev = g.revealed.includes(i), isMine = g.minesAt && g.minesAt.includes(i);
      if (isRev) { cls += ' gem'; inner = GEM; }
      else if (g.status !== 'open' && isMine) { cls += ' bomb' + (g.hit === i ? ' hit' : ' ghost'); inner = BOMB; }
      else if (g.status !== 'open') { cls += ' gem ghost'; inner = GEM; }
    }
    if (G.pending === i) cls += ' pending';
    const can = open && !G.busy && !(g && g.revealed.includes(i));
    html += `<button class="${cls}" data-cell="${i}" ${can ? '' : 'disabled'}>${inner}</button>`;
  }
  return html;
}

function controlsHtml() {
  const g = G.game, open = g && g.status === 'open';
  const lock = open || G.busy ? 'disabled' : '';
  const quick = [1, 3, 5, 10, 24];
  const amt = open ? g.stake : G.amount, mn = open ? g.mines : G.mines; // durante o jogo mostra o que foi apostado
  let btn;
  if (!G.user) btn = `<button class="dc-go bet mn-go" data-act="login">Entrar<small>para jogar</small></button>`;
  else if (open) btn = g.revealed.length
    ? `<button class="dc-go cash mn-go" data-act="cash" ${G.busy ? 'disabled' : ''}>Sacar<b>${money(g.payout)}</b><small>${fx(g.mult)}</small></button>`
    : `<button class="dc-go done mn-go" disabled>Escolha uma casa<small>abra a 1.ª casa para poder sacar</small></button>`;
  else btn = `<button class="dc-go bet mn-go" data-act="start" ${G.busy ? 'disabled' : ''}>Apostar<b>${money(G.amount)}</b></button>`;
  return `<div class="mn-field"><label>Valor da aposta</label>
      <div class="dc-amt"><button data-act="minus" ${lock}>−</button><input data-f="amount" inputmode="decimal" value="${num2(amt)}" ${lock}><button data-act="plus" ${lock}>+</button></div>
      <div class="dc-chips">${['½', '2x', 10, 50].map((v) => `<button data-chip="${v}" ${lock}>${v}</button>`).join('')}</div>
    </div>
    <div class="mn-field"><label>Minas <span class="muted">· mais minas, prêmios maiores</span></label>
      <div class="mn-mines">
        <select data-f="mines" ${lock}>${Array.from({ length: 24 }, (_, i) => i + 1).map((n) => `<option value="${n}" ${n === mn ? 'selected' : ''}>${n} ${n === 1 ? 'mina' : 'minas'}</option>`).join('')}</select>
        <div class="mn-quick">${quick.map((n) => `<button data-mines="${n}" class="${n === mn ? 'active' : ''}" ${lock}>${n}</button>`).join('')}</div>
      </div>
    </div>
    ${btn}
    ${open ? `<button class="mn-rand" data-act="random" ${G.busy ? 'disabled' : ''}>🎲 Casa aleatória</button>` : ''}`;
}

function ladderHtml() {
  const g = G.game && G.game.status === 'open' ? G.game : null;
  const m = g ? g.mines : G.mines, k = g ? g.revealed.length : 0;
  const n = 25 - m;
  const items = [];
  for (let i = 1; i <= n; i++) items.push(`<span class="${i === k ? 'cur' : i < k ? 'past' : ''}"><small>${i}</small>${fx(multFor(i, m))}</span>`);
  return items.join('');
}

function renderAll() {
  const panel = $('#controls'), a = document.activeElement;
  if (!(panel.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT'))) setHtml(panel, controlsHtml());
  setHtml($('#board'), boardHtml());
  const g = G.game, open = g && g.status === 'open';
  const shown = open ? g : G.last;
  $('#multNow').textContent = fx(open ? g.mult : shown && shown.status === 'won' ? shown.mult : 1);
  $('#multNext').textContent = open && g.next ? fx(g.next) : '—';
  $('#payNow').textContent = open ? money(g.payout) : shown && shown.status === 'won' ? money(shown.payout) : '—';
  $('.mn-stage').classList.toggle('live', !!open);
  const lad = $('#ladder');
  if (setHtml(lad, ladderHtml())) { const c = lad.querySelector('.cur'); if (c) c.scrollIntoView({ block: 'nearest', inline: 'center' }); }
  renderSide();
}

/* ---------------- lateral: Todas / Minhas / Top ---------------- */
async function loadMy(force) {
  if (!G.user) { G.my = null; return renderSide(); }
  if (!force && G.my && Date.now() - G.myAt < 5000) return;
  try { G.my = (await api('GET', '/api/mines/my')).games; G.myAt = Date.now(); } catch { G.my = []; }
  renderSide();
}
function renderSide() {
  const st = G.st;
  document.querySelectorAll('#sideTabs button').forEach((b) => b.classList.toggle('active', b.dataset.side === G.side));
  if (!st) return;
  let head = '', body = '';
  const row = (p, left) => `<div class="dc-pl ${p.status}"><span class="nm">${left}</span><span>${money(p.stake)}</span><span class="m">${p.status === 'won' ? fx(p.mult) : '💣'}</span><span class="p">${p.status === 'won' ? money(p.payout) : ''}</span></div>`;
  if (G.side === 'all') {
    head = `<span>Últimos jogos</span><span>Aposta · Multi · Prêmio</span>`;
    body = st.feed.length ? st.feed.map((p) => row(p, `${esc(p.name)} <i class="mn-tag">${p.mines}💣</i>`)).join('')
      : `<div class="dc-empty">Ainda ninguém jogou. Seja o primeiro!</div>`;
  } else if (G.side === 'my') {
    head = `<span>Seus últimos jogos</span><span>Aposta · Multi · Prêmio</span>`;
    if (!G.user) body = `<div class="dc-empty">Entre na sua conta para ver o seu histórico.</div>`;
    else if (!G.my) body = `<div class="dc-empty">Carregando...</div>`;
    else body = G.my.length ? G.my.map((p) => `<button class="mn-myrow" data-game="${esc(p.id)}">${row(p, `<span class="t">${hhmm(p.at)} · ${p.mines}💣 · ${p.picks} ${p.picks === 1 ? 'casa' : 'casas'}</span>`)}</button>`).join('')
      : `<div class="dc-empty">Ainda não jogou Mines.</div>`;
  } else {
    head = `<span>Maiores prêmios (24h)</span><span>Aposta · Multi · Prêmio</span>`;
    body = st.top.length ? st.top.map((w, n) => row({ ...w, status: 'won' }, `${n < 3 ? ['🥇', '🥈', '🥉'][n] : n + 1 + '.'} ${esc(w.name)}`)).join('')
      : `<div class="dc-empty">Ainda não houve prêmios hoje.</div>`;
  }
  setHtml($('#sideHead'), head);
  setHtml($('#sideBody'), body);
}

function renderWallet() {
  setHtml($('#wallet'), G.user
    ? `${G.testMode ? '<button class="btn dc-dev" data-act="credit" title="Só existe nos emuladores">+ R$ 1.000 teste</button>' : '<a class="btn btn-green" href="/">Depositar</a>'}<div class="balance"><small>Saldo</small><span>${money(G.user.balance)}</span></div>`
    : `<button class="btn btn-green" data-act="login">Entrar</button>`);
  renderAll();
}

/* ---------------- login e verificação ---------------- */
function openLogin() {
  openModal(`<h3>Entrar</h3><p class="sub">Entre na sua conta para jogar.</p>
    <form class="dc-form" id="loginForm"><label>E-mail</label><input name="email" type="email" autocomplete="email" required>
    <label>Senha</label><input name="password" type="password" autocomplete="current-password" required>
    <div class="err" id="loginErr"></div><button class="btn btn-green btn-block">Entrar</button></form>
    <p class="sub" style="margin:12px 0 0">Sem conta? <a href="/" style="color:var(--green)">Cadastre-se no site</a>.</p>`);
  setTimeout(() => $('#loginForm input').focus(), 30);
}
async function showGame(id) {
  try {
    const { game: g } = await api('GET', '/api/mines/game?id=' + encodeURIComponent(id));
    const grid = Array.from({ length: 25 }, (_, i) => `<i class="${g.minesAt.includes(i) ? 'b' : ''}"></i>`).join('');
    openModal(`<h3>Jogo ${g.status === 'won' ? fx(g.mult) : '💣'}</h3><p class="sub">${new Date(g.at).toLocaleString('pt-BR')} · ${g.mines} ${g.mines === 1 ? 'mina' : 'minas'}</p>
      <div class="mn-mini">${grid}</div>
      <div class="muted" style="font-size:12px">ID do jogo</div><div class="dc-mono">${esc(g.id)}</div>
      <div class="muted" style="font-size:12px">Hash mostrado ANTES do jogo — sha256(semente)</div><div class="dc-mono">${esc(g.hash)}</div>
      <div class="muted" style="font-size:12px">Semente revelada DEPOIS</div><div class="dc-mono">${esc(g.seed)}</div>
      <p>${g.hashOk ? '<span class="dc-ok">✓ Conferido:</span> o hash bate com a semente e as minas saem de HMAC-SHA256(semente, ID).' : '<b style="color:#ff6b6b">Falhou a verificação.</b>'}</p>`);
  } catch (e) { toast(e.message, 'err'); }
}
function showFair() {
  openModal(`<h3>Jogo verificável</h3><p class="sub">Ninguém (nem a casa) pode mudar onde estão as minas depois de o jogo começar.</p>
    <ol style="padding-left:18px;line-height:1.6;margin:0 0 10px">
      <li>Quando aposta, o servidor sorteia uma semente secreta e mostra o <b>hash</b> dela (código do jogo atual abaixo).</li>
      <li>As minas são escolhidas por um baralhamento feito com HMAC-SHA256(semente, ID do jogo). Retorno médio ao jogador: 97%.</li>
      <li>No fim, a semente é revelada. Em "Minhas", clique num jogo para conferir.</li>
    </ol>
    <div class="muted" style="font-size:12px">Hash do jogo atual</div><div class="dc-mono">${esc(G.game?.status === 'open' ? G.game.hash : '— comece um jogo —')}</div>`);
}

/* ---------------- eventos ---------------- */
const saveCfg = () => { lsSet('mn_amount', G.amount); lsSet('mn_mines', G.mines); };
document.addEventListener('click', async (e) => {
  audio(); // o navegador só deixa tocar som depois de um clique
  const t = e.target.closest('button, [data-close]');
  if (!t) { if (e.target.id === 'overlay') closeModal(); return; }
  if (t.dataset.close !== undefined) return closeModal();
  if (t.id === 'fairBtn') return showFair();
  if (t.id === 'soundBtn') { SND.on = !SND.on; lsSet('mn_sound', SND.on); if (SND.on) audio(); return renderSound(); }
  if (t.dataset.cell) return reveal(+t.dataset.cell);
  if (t.dataset.game) return showGame(t.dataset.game);
  if (t.dataset.side) { G.side = t.dataset.side; lsSet('mn_side', G.side); if (G.side === 'my') loadMy(true); return renderSide(); }
  if (t.dataset.mines) { G.mines = +t.dataset.mines; saveCfg(); return renderAll(); }
  if (t.dataset.chip) {
    const c = t.dataset.chip;
    G.amount = c === '½' ? Math.max(1, Math.round(G.amount * 50) / 100) : c === '2x' ? Math.round(G.amount * 200) / 100 : +c;
    saveCfg(); return renderAll();
  }
  switch (t.dataset.act) {
    case 'login': return openLogin();
    case 'credit':
      try { const d = await api('POST', '/api/dev/credit', {}); G.user = d.user; renderWallet(); toast('+ R$ 1.000 de saldo de teste', 'ok'); } catch (err) { toast(err.message, 'err'); }
      return;
    case 'minus': G.amount = Math.max(1, Math.round((G.amount - (G.amount > 10 ? 5 : 1)) * 100) / 100); saveCfg(); return renderAll();
    case 'plus': G.amount = Math.round((G.amount + (G.amount >= 10 ? 5 : 1)) * 100) / 100; saveCfg(); return renderAll();
    case 'start': return start();
    case 'cash': return cashOut();
    case 'random': return randomCell();
  }
});
document.addEventListener('change', (e) => {
  const f = e.target.dataset.f;
  if (f === 'amount') G.amount = Math.max(1, parseNum(e.target.value) || 1);
  if (f === 'mines') G.mines = Math.min(24, Math.max(1, +e.target.value || 3));
  if (!f) return;
  saveCfg(); e.target.blur(); renderAll();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.closest('#controls input')) e.target.blur();
  if (e.key === 'Escape') closeModal();
});
document.addEventListener('focusout', () => setTimeout(renderAll, 0));
document.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.id === 'loginForm') {
    const f = new FormData(e.target);
    try {
      await api('POST', '/api/login', { email: f.get('email'), password: f.get('password') });
      closeModal(); await loadMe(); poll(); if (G.side === 'my') loadMy(true);
    } catch (err) { $('#loginErr').textContent = err.message; }
  }
});

/* ---------------- arranque ---------------- */
renderSound();
loadMe().then(() => { setInterval(loadMe, 15000); if (G.side === 'my') loadMy(true); });
poll();
setInterval(poll, 3000);
