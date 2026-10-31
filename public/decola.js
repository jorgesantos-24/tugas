'use strict';
/* DECOLA — navegador. O servidor decide tudo (rodada, ponto de queda, saques);
   aqui desenhamos o voo com o relógio sincronizado com o servidor, tocamos os sons
   e gerimos a aposta automática (que só repete pedidos normais de aposta). */

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
const defSlot = { amount: 10, autoOn: false, auto: 2, mode: 'bet', abRounds: 10, abWin: '', abLoss: '' };
const G = {
  user: null, testMode: false, st: null, offset: 0, bestRtt: Infinity,
  slots: [0, 1].map((i) => ({ ...defSlot, ...lsGet('dc_slot' + i, {}), queued: false, busy: false, ab: null, settled: null, wonShown: null })),
  side: lsGet('dc_side', 'all'), my: null, myAt: 0, chatSeen: lsGet('dc_chatSeen', 0),
  crashShownAt: 0, flashAt: 0, lastPhase: null, lastHist: null,
};
const sNow = () => Date.now() + G.offset; // relógio do servidor
const saveSlot = (i) => { const s = G.slots[i]; lsSet('dc_slot' + i, { amount: s.amount, autoOn: s.autoOn, auto: s.auto, mode: s.mode, abRounds: s.abRounds, abWin: s.abWin, abLoss: s.abLoss }); };

/* ---------------- sons (gerados no navegador, sem ficheiros) ---------------- */
const SND = { on: lsGet('dc_sound', true), ctx: null, eng: null };
function audio() {
  if (!SND.on) return null;
  if (!SND.ctx) { try { SND.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  if (SND.ctx.state === 'suspended') SND.ctx.resume().catch(() => {});
  return SND.ctx.state === 'running' ? SND.ctx : null;
}
function engineStart() {
  const a = audio(); if (!a || SND.eng) return;
  const o = a.createOscillator(), o2 = a.createOscillator(), f = a.createBiquadFilter(), g = a.createGain();
  o.type = 'sawtooth'; o2.type = 'triangle'; o2.detune.value = -1200;
  f.type = 'lowpass'; f.frequency.value = 500; g.gain.value = 0;
  o.connect(f); o2.connect(f); f.connect(g); g.connect(a.destination);
  o.start(); o2.start();
  g.gain.linearRampToValueAtTime(0.035, a.currentTime + 0.8);
  SND.eng = { o, o2, f, g };
}
function engineSet(m) {
  if (!SND.eng) return;
  const a = SND.ctx, fr = 80 + Math.min(240, Math.log(m) * 85);
  SND.eng.o.frequency.setTargetAtTime(fr, a.currentTime, 0.15);
  SND.eng.o2.frequency.setTargetAtTime(fr, a.currentTime, 0.15);
  SND.eng.f.frequency.setTargetAtTime(400 + fr * 3, a.currentTime, 0.15);
}
function engineStop() {
  if (!SND.eng) return;
  const { o, o2, g } = SND.eng, a = SND.ctx;
  g.gain.setTargetAtTime(0, a.currentTime, 0.06);
  o.stop(a.currentTime + 0.4); o2.stop(a.currentTime + 0.4);
  SND.eng = null;
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
  f.type = 'lowpass'; f.frequency.value = 800; g.gain.value = 0.22;
  src.buffer = buf; src.connect(f); f.connect(g); g.connect(a.destination); src.start();
  blip([140, 70], 0.12, 'sine', 0.18);
}
const sndBet = () => blip([520], 0.05, 'triangle', 0.08);
const sndCash = () => blip([660, 880, 1320], 0.08, 'sine', 0.12);
const sndTick = () => blip([880], 0.03, 'square', 0.025);
function renderSound() { $('#soundBtn').textContent = SND.on ? '🔊' : '🔇'; }

/* ---------------- servidor ---------------- */
async function loadMe() {
  try {
    const d = await api('GET', '/api/me');
    G.user = d.user; G.testMode = !!d.testMode;
    $('#testBar').hidden = !G.testMode;
    if (d.casinoCert) $('#certInfo').textContent = 'Decola · certificado ' + d.casinoCert;
  } catch { /* tenta de novo depois */ }
  renderWallet();
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  const t0 = Date.now();
  try {
    const d = await api('GET', '/api/crash/state');
    const t1 = Date.now(), rtt = t1 - t0;
    // desvio do relógio: guarda a medição mais rápida (mais precisa)
    if (rtt <= G.bestRtt * 1.5 || !G.st) { G.offset = d.now - (t0 + rtt / 2); G.bestRtt = Math.min(G.bestRtt, rtt); }
    const prev = G.st;
    G.st = d;
    if (prev && prev.round.id !== d.round.id) onNewRound();
    if (prev && prev.round.phase !== 'CRASHED' && d.round.phase === 'CRASHED') onCrash(prev);
    if (d.round.phase === 'CRASHED') settleAuto(d);
    checkWins(d.mine);
    sendQueued();
    renderPanels(); renderSide(); renderHistory();
  } catch { /* sem ligação: tenta de novo */ }
  polling = false;
}
function schedulePoll() {
  const ph = G.st?.round.phase;
  setTimeout(async () => { await poll(); schedulePoll(); }, ph === 'FLYING' ? 200 : 450);
}

function onNewRound() { if (G.user) loadMe(); }
function onCrash(prev) {
  G.crashShownAt = performance.now(); G.flashAt = performance.now();
  engineStop(); boom();
  const st = $('#stage'); st.classList.remove('shake'); void st.offsetWidth; st.classList.add('shake');
  if (prev.mine.some((b) => b && b.status === 'open')) setTimeout(loadMe, 400);
  if (G.side === 'my') setTimeout(() => loadMy(true), 900);
}

// prêmios novos (manuais ou automáticos): som + aviso no palco
function checkWins(mine) {
  mine.forEach((b, i) => {
    const s = G.slots[i];
    if (b && b.status === 'won' && s.wonShown !== b.id) {
      s.wonShown = b.id; sndCash();
      const el = document.createElement('div');
      el.className = 'dc-float'; el.innerHTML = `<small>Você sacou ${fx(b.cashout)}</small>+ ${money(b.payout)}`;
      el.style.top = (56 + i * 14) + '%';
      $('#fx').appendChild(el); setTimeout(() => el.remove(), 1900);
    }
  });
}

/* ---------------- aposta automática ---------------- */
function startAuto(i) {
  if (!G.user) return openLogin();
  const s = G.slots[i];
  s.ab = { left: s.abRounds, pnl: 0, win: parseNum(s.abWin) || null, loss: parseNum(s.abLoss) || null };
  renderPanels(); sendQueued();
  if (G.st && G.st.round.phase !== 'BETTING') toast(`Aposta automática: começa na próxima rodada (${s.abRounds} rodadas).`);
}
function stopAuto(i, why) {
  const s = G.slots[i];
  if (!s.ab) return;
  s.ab = null; renderPanels();
  if (why) toast(`Painel ${i + 1}: aposta automática parada (${why}).`);
}
// no fim de cada rodada, conta o resultado das apostas automáticas
function settleAuto(d) {
  d.mine.forEach((b, i) => {
    const s = G.slots[i];
    if (!s.ab || !b || b.roundId !== d.round.id || s.settled === b.id) return;
    s.settled = b.id;
    s.ab.pnl = Math.round((s.ab.pnl + (b.payout || 0) - b.stake) * 100) / 100;
    s.ab.left--;
    if (s.ab.win != null && s.ab.pnl >= s.ab.win) return stopAuto(i, `lucro de ${money(s.ab.pnl)} atingido`);
    if (s.ab.loss != null && -s.ab.pnl >= s.ab.loss) return stopAuto(i, `perda de ${money(-s.ab.pnl)} atingida`);
    if (s.ab.left <= 0) return stopAuto(i, `terminou as rodadas · resultado ${s.ab.pnl >= 0 ? '+' : ''}${money(s.ab.pnl)}`);
  });
}

// apostas marcadas para a próxima rodada (manuais ou automáticas)
function sendQueued() {
  const st = G.st;
  if (!st || st.round.phase !== 'BETTING' || sNow() > st.round.betUntil - 400) return;
  G.slots.forEach((s, i) => {
    if (st.mine[i] || s.busy) return;
    if (s.queued) { s.queued = false; placeBet(i); } else if (s.ab && s.ab.left > 0) placeBet(i, true);
  });
}

async function placeBet(i, fromAuto) {
  if (!G.user) return openLogin();
  const s = G.slots[i], st = G.st;
  if (!st) return;
  const stop = (msg) => { if (fromAuto) stopAuto(i, msg); else toast(msg, 'err'); };
  if (s.amount < st.limits.min || s.amount > st.limits.max) return stop(`aposta entre ${money(st.limits.min)} e ${money(st.limits.max)}`);
  if (s.amount > G.user.balance) return stop('saldo insuficiente');
  if (st.round.phase !== 'BETTING' || sNow() > st.round.betUntil - 300) { if (!fromAuto) { s.queued = true; renderPanels(); } return; }
  s.busy = true; renderPanels();
  try {
    const d = await api('POST', '/api/crash/bet', { slot: i, amount: s.amount, auto: s.autoOn ? s.auto : null });
    G.st.mine = d.mine; G.user = d.user; renderWallet(); sndBet();
  } catch (e) { stop(e.message); }
  s.busy = false; renderPanels();
}
async function cancelBet(i) {
  const s = G.slots[i];
  if (s.queued) { s.queued = false; renderPanels(); return; }
  s.busy = true; renderPanels();
  try { const d = await api('POST', '/api/crash/cancel', { slot: i }); G.st.mine = d.mine; G.user = d.user; renderWallet(); }
  catch (e) { toast(e.message, 'err'); }
  s.busy = false; renderPanels();
}
async function cashOut(i) {
  const s = G.slots[i];
  s.busy = true; renderPanels();
  try {
    const d = await api('POST', '/api/crash/cashout', { slot: i });
    G.st.mine = d.mine; G.user = d.user; renderWallet(); checkWins(d.mine);
  } catch (e) { toast(e.message, 'err'); }
  s.busy = false; renderPanels();
}

/* ---------------- multiplicador atual (local) ---------------- */
function liveMult() {
  const r = G.st?.round;
  if (!r || r.phase !== 'FLYING' || !r.startAt) return 1;
  return Math.max(1, Math.floor(Math.exp((r.k * Math.max(0, sNow() - r.startAt)) / 1000) * 100) / 100);
}

/* ---------------- desenho ---------------- */
const cv = $('#cv'), ctx = cv.getContext('2d');
let W = 0, H = 0;
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = cv.getBoundingClientRect();
  W = r.width; H = r.height;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);

// estrelas/partículas do fundo (andam para trás durante o voo)
const stars = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), z: 0.3 + Math.random() * 0.7 }));
let lastFrame = performance.now();

function drawPlane(x, y, ang, sc) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(ang); ctx.scale(sc, sc);
  // rasto
  const tr = ctx.createLinearGradient(-60, 0, -24, 0);
  tr.addColorStop(0, 'rgba(255,200,61,0)'); tr.addColorStop(1, 'rgba(255,200,61,.55)');
  ctx.fillStyle = tr; ctx.beginPath(); ctx.moveTo(-24, -3); ctx.lineTo(-60, 0); ctx.lineTo(-24, 3); ctx.fill();
  // fuselagem
  ctx.fillStyle = '#ffc83d';
  ctx.beginPath();
  ctx.moveTo(28, 0); ctx.quadraticCurveTo(22, -8, 2, -7); ctx.lineTo(-18, -4); ctx.lineTo(-24, -15); ctx.lineTo(-30, -15);
  ctx.lineTo(-27, -2); ctx.lineTo(-29, 2); ctx.lineTo(-18, 5); ctx.lineTo(2, 7); ctx.quadraticCurveTo(22, 8, 28, 0);
  ctx.fill();
  // asa e faixa
  ctx.fillStyle = '#19c26b';
  ctx.beginPath(); ctx.moveTo(8, 1); ctx.lineTo(-8, 19); ctx.lineTo(-15, 19); ctx.lineTo(-6, 1); ctx.closePath(); ctx.fill();
  ctx.fillRect(-14, -1.5, 30, 3);
  // cabine
  ctx.fillStyle = '#0b2a3d';
  ctx.beginPath(); ctx.ellipse(16, -3, 5, 2.6, 0, 0, Math.PI * 2); ctx.fill();
  // hélice
  ctx.fillStyle = 'rgba(255,255,255,.8)';
  const p = Math.abs(Math.sin(performance.now() / 28)) * 13 + 2;
  ctx.fillRect(28, -p / 2, 2.5, p);
  ctx.restore();
}

function frame() {
  requestAnimationFrame(frame);
  if (!W) resize();
  const nowP = performance.now(), dt = Math.min(0.05, (nowP - lastFrame) / 1000); lastFrame = nowP;
  ctx.clearRect(0, 0, W, H);
  const r = G.st?.round;
  const pad = { l: 16, r: 26, t: 30, b: 24 };
  const flying = r && r.phase === 'FLYING' && r.startAt;
  const crashed = r && r.phase === 'CRASHED';

  let tSec = 0, m = 1;
  if (flying) { tSec = Math.max(0, sNow() - r.startAt) / 1000; m = liveMult(); }
  if (crashed && r.startAt) { m = r.crash; tSec = Math.log(r.crash) / r.k; }

  // fundo: estrelas
  const speed = flying ? 0.04 + Math.min(0.5, Math.log(m) * 0.12) : 0.006;
  for (const s of stars) {
    s.x -= speed * s.z * dt * 4; if (s.x < 0) { s.x += 1; s.y = Math.random(); }
    ctx.fillStyle = `rgba(255,255,255,${0.12 + s.z * 0.35})`;
    ctx.fillRect(s.x * W, s.y * H, s.z * 2, s.z * 2);
  }
  // grade
  ctx.strokeStyle = 'rgba(255,255,255,.04)'; ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) { const y = pad.t + ((H - pad.t - pad.b) * i) / 6; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke(); }

  const sc = Math.max(0.85, Math.min(1.6, W / 520));
  if (flying || (crashed && r.startAt)) {
    const tMax = Math.max(8, tSec * 1.15), mMax = Math.max(1.8, 1 + (m - 1) * 1.2);
    const X = (t) => pad.l + (t / tMax) * (W - pad.l - pad.r);
    const Y = (mm) => H - pad.b - ((mm - 1) / (mMax - 1)) * (H - pad.t - pad.b);
    // eixo dos multiplicadores
    ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.font = '600 11px Inter, sans-serif'; ctx.textAlign = 'left';
    const step = mMax > 20 ? 10 : mMax > 6 ? 2 : mMax > 3 ? 1 : 0.5;
    for (let v = 1 + step; v < mMax; v += step) ctx.fillText(fx(v), pad.l + 4, Y(v) - 3);
    const N = 90, pts = [];
    for (let i = 0; i <= N; i++) { const t = (tSec * i) / N; pts.push([X(t), Y(Math.exp(r.k * t))]); }
    const g = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
    g.addColorStop(0, crashed ? 'rgba(120,130,140,.22)' : 'rgba(25,194,107,.42)'); g.addColorStop(1, 'rgba(25,194,107,0)');
    ctx.beginPath(); ctx.moveTo(pts[0][0], H - pad.b);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(pts[N][0], H - pad.b); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = crashed ? 'rgba(160,170,180,.55)' : '#19c26b'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.stroke();
    const [px, py] = pts[N], [qx, qy] = pts[N - 3];
    const ang = Math.atan2(py - qy, px - qx);
    if (flying) {
      const bob = Math.sin(nowP / 260) * 2;
      drawPlane(px, py - 6 + bob, ang, sc);
      if (!SND.eng) engineStart();
      engineSet(m);
    } else {
      const k = Math.min(1, (nowP - G.crashShownAt) / 800); // sai voando para cima e para a direita
      if (k < 1) drawPlane(px + k * k * W * 0.7, py - 6 - k * k * H * 0.7, -0.6, sc);
    }
  } else {
    if (SND.eng) engineStop();
    // à espera: avião parado na pista
    ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(pad.l, H - pad.b + 2, W - pad.l - pad.r, 2);
    drawPlane(pad.l + 66 * sc, H - pad.b - 12 * sc, 0, sc);
  }
  // clarão vermelho na queda
  const fl = (nowP - G.flashAt) / 450;
  if (fl < 1) { ctx.fillStyle = `rgba(255,77,94,${0.22 * (1 - fl)})`; ctx.fillRect(0, 0, W, H); }

  renderCenter(m);
  if (flying) updateCashButtons(m);
  // contagem regressiva com "tic" nos últimos 3 segundos
  if (r && r.phase === 'BETTING') {
    const sec = Math.ceil((r.betUntil - sNow()) / 1000);
    if (sec !== G.lastSec && sec >= 1 && sec <= 3) sndTick();
    G.lastSec = sec;
  }
}

function renderCenter(m) {
  const el = $('#center'), r = G.st?.round;
  let html;
  if (!r) html = `<div class="dc-wait">Ligando...</div>`;
  else if (r.phase === 'BETTING') {
    const left = Math.max(0, r.betUntil - sNow());
    html = `<div class="dc-wait">Faça a sua aposta</div><div class="dc-mult" style="font-size:clamp(30px,6vw,56px)">${(left / 1000).toFixed(1).replace('.', ',')}s</div><div class="dc-bar"><i style="width:${Math.min(100, (left / 7000) * 100)}%"></i></div>`;
  } else if (r.phase === 'FLYING') html = `<div class="dc-mult">${fx(m)}</div>`;
  else html = `<div class="dc-label">Voou embora!</div><div class="dc-mult gone">${fx(r.crash ?? m)}</div>`;
  setHtml(el, html);
}

/* ---------------- painéis ---------------- */
function panelHtml(i) {
  const s = G.slots[i], st = G.st, b = st?.mine[i], phase = st?.round.phase;
  let btn;
  if (!G.user) btn = `<button class="dc-go bet" data-act="login">Entrar<small>para jogar</small></button>`;
  else if (b && b.status === 'open' && phase === 'BETTING') btn = s.ab ? `<button class="dc-go cancel" data-act="stopcancel" ${s.busy ? 'disabled' : ''}>Parar auto<small>e cancelar ${money(b.stake)}</small></button>`
    : `<button class="dc-go cancel" data-act="cancel" ${s.busy ? 'disabled' : ''}>Cancelar<small>${money(b.stake)}</small></button>`;
  else if (b && b.status === 'open' && phase === 'FLYING') btn = `<button class="dc-go cash" data-act="cash" data-cash="${i}" ${s.busy ? 'disabled' : ''}>Sacar<b>&nbsp;</b></button>`;
  else if (b && b.status === 'won') btn = `<button class="dc-go done" disabled>Sacou ${fx(b.cashout)}<b>${money(b.payout)}</b></button>`;
  else if (b && b.status === 'lost') btn = `<button class="dc-go lost" disabled>Perdeu<small>${money(b.stake)}</small></button>`;
  else if (s.ab) btn = `<button class="dc-go cancel" data-act="stopauto">Parar auto<small>restam ${s.ab.left} rodadas</small></button>`;
  else if (s.mode === 'auto') btn = `<button class="dc-go bet" data-act="startauto">Iniciar auto<b>${money(s.amount)}</b><small>${s.abRounds} rodadas</small></button>`;
  else if (s.queued) btn = `<button class="dc-go cancel" data-act="cancel">Cancelar<small>aguardando próxima rodada</small></button>`;
  else if (phase === 'BETTING') btn = `<button class="dc-go bet" data-act="bet" ${s.busy ? 'disabled' : ''}>Apostar<b>${money(s.amount)}</b></button>`;
  else btn = `<button class="dc-go bet" data-act="bet">Apostar<b>${money(s.amount)}</b><small>na próxima rodada</small></button>`;
  const locked = !!(b && ['open', 'won', 'lost'].includes(b.status)) || s.queued || s.busy || !!s.ab;
  const dis = locked ? 'disabled' : '';
  const cls = (b && b.status === 'open' ? (phase === 'FLYING' ? 'flying' : 'armed') : s.queued ? 'armed' : '') + (s.ab ? ' autoon' : '');
  let html = `<div class="dc-ptabs"><button data-mode="bet" class="${s.mode === 'bet' ? 'active' : ''}" ${s.ab ? 'disabled' : ''}>Aposta</button><button data-mode="auto" class="${s.mode === 'auto' ? 'active' : ''}" ${s.ab ? 'disabled' : ''}>Auto</button></div>
    <div class="dc-prow"><div class="dc-left">
      <div class="dc-amt"><button data-act="minus" ${dis}>−</button><input data-f="amount" inputmode="decimal" value="${num2(s.amount)}" ${dis}><button data-act="plus" ${dis}>+</button></div>
      <div class="dc-chips">${[5, 10, 50, 100].map((v) => `<button data-chip="${v}" ${dis}>${v}</button>`).join('')}</div>
      <label class="dc-auto"><input type="checkbox" data-f="autoOn" ${s.autoOn ? 'checked' : ''} ${dis}> Saque auto <input type="text" data-f="auto" inputmode="decimal" value="${num2(s.auto)}" ${!s.autoOn || locked ? 'disabled' : ''}></label>
    </div>${btn}</div>`;
  if (s.mode === 'auto') {
    html += s.ab
      ? `<div class="dc-abinfo">Auto ligado · restam <b>${s.ab.left}</b> · resultado <b style="color:${s.ab.pnl >= 0 ? 'var(--green)' : 'var(--red)'}">${s.ab.pnl >= 0 ? '+' : ''}${money(s.ab.pnl)}</b>${s.ab.win ? ` · para em +${money(s.ab.win)}` : ''}${s.ab.loss ? ` · para em −${money(s.ab.loss)}` : ''}</div>`
      : `<div class="dc-abcfg">
          <label>Rodadas<select data-f="abRounds">${[5, 10, 20, 50, 100].map((n) => `<option ${n === s.abRounds ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label>Parar se ganhar R$<input data-f="abWin" inputmode="decimal" placeholder="—" value="${esc(s.abWin)}"></label>
          <label>Parar se perder R$<input data-f="abLoss" inputmode="decimal" placeholder="—" value="${esc(s.abLoss)}"></label>
        </div>`;
  }
  return { cls, html };
}
function renderPanels() {
  document.querySelectorAll('.dc-panel').forEach((el) => {
    const a = document.activeElement;
    if (el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) return; // não estraga o que está a ser escrito
    const i = +el.dataset.slot, { cls, html } = panelHtml(i);
    el.className = 'dc-panel ' + cls;
    setHtml(el, html);
  });
}
function updateCashButtons(m) {
  document.querySelectorAll('[data-cash]').forEach((btn) => {
    const b = G.st.mine[+btn.dataset.cash];
    if (b && b.status === 'open') { const v = btn.querySelector('b'); const t = money(b.stake * m); if (v && v.textContent !== t) v.textContent = t; }
  });
}

/* ---------------- lateral: Todas / Minhas / Top / Chat ---------------- */
async function loadMy(force) {
  if (!G.user) { G.my = null; return renderSide(); }
  if (!force && G.my && Date.now() - G.myAt < 5000) return;
  try { G.my = (await api('GET', '/api/crash/my')).bets; G.myAt = Date.now(); } catch (e) { G.my = []; }
  renderSide();
}
function renderSide() {
  const st = G.st;
  document.querySelectorAll('#sideTabs button').forEach((b) => b.classList.toggle('active', b.dataset.side === G.side));
  $('#chatForm').hidden = G.side !== 'chat';
  const lastChat = st?.chat?.length ? st.chat[st.chat.length - 1].id : 0;
  if (G.side === 'chat' && lastChat > G.chatSeen) { G.chatSeen = lastChat; lsSet('dc_chatSeen', lastChat); }
  $('#chatDot').hidden = !(lastChat > G.chatSeen);
  if (!st) return;
  let head = '', body = '';
  if (G.side === 'all') {
    const total = st.players.reduce((a, p) => a + p.stake, 0);
    head = `<span><b>${st.count}</b> ${st.count === 1 ? 'aposta' : 'apostas'}</span><span>Total <b>${money(total)}</b></span>`;
    body = st.players.length ? st.players.map((p) => `<div class="dc-pl ${p.status}"><span class="nm">${esc(p.name)}</span><span>${money(p.stake)}</span><span class="m">${p.status === 'won' ? fx(p.cashout) : p.status === 'lost' ? '—' : ''}</span><span class="p">${p.status === 'won' ? money(p.payout) : ''}</span></div>`).join('')
      : `<div class="dc-empty">Ainda ninguém apostou nesta rodada.</div>`;
  } else if (G.side === 'my') {
    head = `<span>Suas últimas apostas</span><span>Aposta · Saque · Prêmio</span>`;
    if (!G.user) body = `<div class="dc-empty">Entre na sua conta para ver o seu histórico.</div>`;
    else if (!G.my) body = `<div class="dc-empty">Carregando...</div>`;
    else body = G.my.length ? G.my.map((b) => `<div class="dc-pl ${b.status}"><span class="t">${hhmm(b.at)}${b.crash ? ` · voou ${fx(b.crash)}` : ''}</span><span>${money(b.stake)}</span><span class="m">${b.status === 'won' ? fx(b.cashout) : b.status === 'lost' ? '—' : '...'}</span><span class="p">${b.status === 'won' ? money(b.payout) : ''}</span></div>`).join('')
      : `<div class="dc-empty">Ainda não apostou no Decola.</div>`;
  } else if (G.side === 'top') {
    head = `<span>Maiores prêmios (24h)</span><span>Aposta · Saque · Prêmio</span>`;
    body = st.top.length ? st.top.map((w, n) => `<div class="dc-pl won"><span class="nm">${n < 3 ? ['🥇', '🥈', '🥉'][n] : n + 1 + '.'} ${esc(w.name)}</span><span>${money(w.stake)}</span><span class="m">${fx(w.cashout)}</span><span class="p">${money(w.payout)}</span></div>`).join('')
      : `<div class="dc-empty">Ainda não houve prêmios hoje.</div>`;
  } else {
    head = `<span>Chat da sala</span><span>${G.user ? '' : 'Entre para escrever'}</span>`;
    const myName = G.user ? maskLike(G.user.name) : null;
    body = st.chat.length ? st.chat.map((c) => `<div class="dc-msg ${c.name === myName ? 'me' : ''}"><b>${esc(c.name)}</b>${esc(c.text)}<time>${hhmm(c.at)}</time></div>`).join('')
      : `<div class="dc-empty">Ninguém escreveu ainda. Diga olá!</div>`;
  }
  setHtml($('#sideHead'), head);
  const sb = $('#sideBody');
  const atBottom = sb.scrollHeight - sb.scrollTop - sb.clientHeight < 40;
  if (setHtml(sb, body) && G.side === 'chat' && atBottom) sb.scrollTop = sb.scrollHeight;
}
// mesmo formato de nome que o servidor usa no chat (para destacar as próprias mensagens)
const maskLike = (n) => { const p = String(n || 'Jogador').trim().split(/\s+/)[0]; return p.length <= 2 ? p + '***' : p.slice(0, 2) + '***' + p.slice(-1); };

function renderHistory() {
  const st = G.st; if (!st) return;
  const first = st.history[0]?.id;
  const html = st.history.map((h, n) => `<button class="dc-pill ${h.crash < 2 ? 'lo' : h.crash < 10 ? 'mid' : 'hi'}${n === 0 && G.lastHist && G.lastHist !== first ? ' new' : ''}" data-round="${esc(h.id)}">${fx(h.crash)}</button>`).join('');
  if (setHtml($('#history'), html)) G.lastHist = first;
}
function renderWallet() {
  const w = $('#wallet');
  setHtml(w, G.user
    ? `${G.testMode ? '<button class="btn dc-dev" data-act="credit" title="Só existe nos emuladores">+ R$ 1.000 teste</button>' : '<a class="btn btn-green" href="/">Depositar</a>'}<div class="balance"><small>Saldo</small><span>${money(G.user.balance)}</span></div>`
    : `<button class="btn btn-green" data-act="login">Entrar</button>`);
  renderPanels();
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
async function showRound(id) {
  try {
    const { round: h } = await api('GET', '/api/crash/round?id=' + encodeURIComponent(id));
    openModal(`<h3>Rodada ${fx(h.crash)}</h3><p class="sub">${new Date(h.at).toLocaleString('pt-BR')}</p>
      <div class="muted" style="font-size:12px">ID da rodada</div><div class="dc-mono">${esc(h.id)}</div>
      <div class="muted" style="font-size:12px">Hash mostrado ANTES da rodada — sha256(semente)</div><div class="dc-mono">${esc(h.hash)}</div>
      <div class="muted" style="font-size:12px">Semente revelada DEPOIS</div><div class="dc-mono">${esc(h.seed)}</div>
      <p>${h.hashOk && h.check === h.crash ? '<span class="dc-ok">✓ Conferido:</span> o hash bate com a semente e HMAC-SHA256(semente, ID) dá ' + fx(h.check) + '.' : '<b style="color:#ff6b6b">Falhou a verificação.</b>'}</p>`);
  } catch (e) { toast(e.message, 'err'); }
}
function showFair() {
  openModal(`<h3>Jogo verificável</h3><p class="sub">Ninguém (nem a casa) pode mudar o resultado depois de as apostas fecharem.</p>
    <ol style="padding-left:18px;line-height:1.6;margin:0 0 10px">
      <li>Antes de cada rodada o servidor sorteia uma semente secreta e mostra o <b>hash</b> dela (código da rodada atual abaixo).</li>
      <li>O ponto onde o avião voa embora vem de HMAC-SHA256(semente, ID da rodada), entre 1,00x e 1000x. Retorno médio ao jogador: 97%.</li>
      <li>No fim, a semente é revelada. Clique num resultado do histórico para conferir.</li>
    </ol>
    <div class="muted" style="font-size:12px">Hash da rodada atual</div><div class="dc-mono">${esc(G.st?.round.hash || '—')}</div>`);
}

/* ---------------- eventos ---------------- */
document.addEventListener('click', async (e) => {
  audio(); // o navegador só deixa tocar som depois de um clique
  const t = e.target.closest('button, [data-close]');
  if (!t) { if (e.target.id === 'overlay') closeModal(); return; }
  if (t.dataset.close !== undefined) return closeModal();
  if (t.id === 'fairBtn') return showFair();
  if (t.id === 'histMore') return $('.dc-histwrap').classList.toggle('open');
  if (t.id === 'soundBtn') { SND.on = !SND.on; lsSet('dc_sound', SND.on); if (!SND.on) engineStop(); else audio(); return renderSound(); }
  if (t.dataset.round) return showRound(t.dataset.round);
  if (t.dataset.side) { G.side = t.dataset.side; lsSet('dc_side', G.side); if (G.side === 'my') loadMy(true); renderSide(); if (G.side === 'chat') { const sb = $('#sideBody'); sb.scrollTop = sb.scrollHeight; } return; }
  const panel = t.closest('.dc-panel'), i = panel ? +panel.dataset.slot : -1, s = G.slots[i];
  if (t.dataset.mode && s) { s.mode = t.dataset.mode; saveSlot(i); return renderPanels(); }
  if (t.dataset.chip && s) { s.amount = +t.dataset.chip; saveSlot(i); return renderPanels(); }
  switch (t.dataset.act) {
    case 'login': return openLogin();
    case 'credit':
      try { const d = await api('POST', '/api/dev/credit', {}); G.user = d.user; renderWallet(); toast('+ R$ 1.000 de saldo de teste', 'ok'); } catch (err) { toast(err.message, 'err'); }
      return;
    case 'minus': s.amount = Math.max(1, Math.round((s.amount - (s.amount > 10 ? 5 : 1)) * 100) / 100); saveSlot(i); return renderPanels();
    case 'plus': s.amount = Math.round((s.amount + (s.amount >= 10 ? 5 : 1)) * 100) / 100; saveSlot(i); return renderPanels();
    case 'bet': return placeBet(i);
    case 'cancel': return cancelBet(i);
    case 'cash': return cashOut(i);
    case 'startauto': return startAuto(i);
    case 'stopauto': return stopAuto(i, 'parada por você');
    case 'stopcancel': stopAuto(i, 'parada por você'); return cancelBet(i);
  }
});
document.addEventListener('change', (e) => {
  const panel = e.target.closest('.dc-panel'); if (!panel) return;
  const i = +panel.dataset.slot, s = G.slots[i], f = e.target.dataset.f;
  if (f === 'amount') s.amount = Math.max(1, parseNum(e.target.value) || 1);
  if (f === 'auto') s.auto = Math.min(1000, Math.max(1.01, parseNum(e.target.value) || 2));
  if (f === 'autoOn') s.autoOn = e.target.checked;
  if (f === 'abRounds') s.abRounds = +e.target.value;
  if (f === 'abWin') s.abWin = parseNum(e.target.value) ? num2(parseNum(e.target.value)) : '';
  if (f === 'abLoss') s.abLoss = parseNum(e.target.value) ? num2(parseNum(e.target.value)) : '';
  saveSlot(i); e.target.blur(); renderPanels();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.closest('.dc-panel input')) e.target.blur();
  if (e.key === 'Escape') closeModal();
  // espaço = sacar no painel 1 (atalho)
  if (e.code === 'Space' && !e.target.closest('input, textarea, select, button') && G.st?.round.phase === 'FLYING' && G.st.mine[0]?.status === 'open') { e.preventDefault(); cashOut(0); }
});
document.addEventListener('focusout', () => setTimeout(renderPanels, 0));
document.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.id === 'loginForm') {
    const f = new FormData(e.target);
    try {
      await api('POST', '/api/login', { email: f.get('email'), password: f.get('password') });
      closeModal(); await loadMe(); poll(); if (G.side === 'my') loadMy(true);
    } catch (err) { $('#loginErr').textContent = err.message; }
  }
  if (e.target.id === 'chatForm') {
    if (!G.user) return openLogin();
    const inp = $('#chatInput'), text = inp.value.trim();
    if (!text) return;
    try { await api('POST', '/api/crash/chat', { text }); inp.value = ''; await poll(); const sb = $('#sideBody'); sb.scrollTop = sb.scrollHeight; }
    catch (err) { toast(err.message, 'err'); }
  }
});

/* ---------------- arranque ---------------- */
renderSound();
loadMe().then(() => { setInterval(loadMe, 15000); if (G.side === 'my') loadMy(true); });
poll().then(schedulePoll);
requestAnimationFrame(frame);
