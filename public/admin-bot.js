/* Bot da transmissão: lê o placar de rounds no vídeo (OCR) e conta os rounds sozinho.
   Corre no browser da equipa: abre a transmissão pelo link guardado na partida (o servidor serve o vídeo,
   ver streamsrc.js) ou, em alternativa, partilha-se um separador;
   marca-se onde ficam os dois números do placar e o bot chama o mesmo "+1 round" do painel.
   Na dúvida (leitura estranha, placar fora do ecrã, lados por confirmar) suspende os mercados.
   Opcional: lê também os jogadores vivos (cartões de cada equipa no HUD) e manda-os ao servidor,
   para a odd mexer dentro do round (5v3...). */

const BOT_STEP = 700;      // ms entre leituras
const BOT_CONFIRM = 3;     // leituras iguais seguidas para aceitar um placar
const BOT_LOST = 8000;     // ms sem leitura -> suspende
const BOT_MIN_CONF = 55;   // confiança mínima do OCR (0-100)
const BOT_SETTLE = 60000;  // liquida as apostas 60 s depois de o placar decidir (tempo para corrigir com "desfazer")
const BOT_SLOTS = 5;       // jogadores por equipa (cartões no HUD)
const BOT_DEAD = 0.6;      // cartão com menos de 60% da cor/brilho de referência = jogador morto
const BOT_OCR_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const BOT_HLS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';

// leitura confirmada (r = {h, a}, já com os lados certos) contra o placar do servidor
function botDecide(srv, r) {
  if (srv.over) return { do: 'over' };
  if (r.h === srv.a && r.a === srv.b) return { do: 'ok' };
  // mapa acabou de terminar: o servidor já está no 0-0 do seguinte e o vídeo ainda mostra o resultado final
  if (srv.a === 0 && srv.b === 0 && srv.last && r.h === srv.last.h && r.a === srv.last.a) return { do: 'ok' };
  if (r.h === srv.a + 1 && r.a === srv.b) return { do: 'round', side: 'h' };
  if (r.a === srv.b + 1 && r.h === srv.a) return { do: 'round', side: 'a' };
  // placar de um momento anterior do mapa: replay / melhores momentos (HUD antigo) -> ignora
  if (r.h <= srv.a && r.a <= srv.b) return { do: 'behind' };
  return { do: 'anomaly' };
}

const BOT = { ev: null, panel: null, video: null, stream: null, worker: null, ocr: null, timer: null, running: false,
  calib: { L: null, R: null }, marking: null, swap: false, sidesOk: false, mapN: 0, seq: [], lastGood: 0,
  aliveOn: false, aliveRead: null, aliveSeq: [], aliveSent: null, aliveArmed: false, scoreOk: false,
  autoSettle: true, settleT: null, stats: { rounds: 0, settled: 0 },
  srv: null, markets: [], susp: null, why: '', read: { L: null, R: null }, log: [], drag: null };

const botEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const botCalibKey = () => `tugas_bot_calib_${BOT.ev.league}`;
const botNames = () => (BOT.swap ? [BOT.ev.away, BOT.ev.home] : [BOT.ev.home, BOT.ev.away]); // [esquerda, direita]

function botNote(msg, kind = '') {
  BOT.log.unshift({ t: new Date().toLocaleTimeString('pt-BR'), msg, kind });
  BOT.log.length = Math.min(BOT.log.length, 12);
  botPaint();
}
function botBeep() {
  try {
    const ac = new AudioContext(), o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.35);
  } catch { /* sem som */ }
}

/* ---------- servidor ---------- */
async function botSync() {
  const d = await api('GET', '/api/admin/catalog/event?id=' + encodeURIComponent(BOT.ev.id));
  if (!d.live) throw new Error('Este evento já não tem regras do jogo.');
  botSetState(d.live.state);
  BOT.markets = d.markets || [];
}
function botSetState(st) {
  const last = st.history[st.history.length - 1] || null;
  BOT.srv = { a: st.a, b: st.b, over: !!st.over, last, map: st.curMap };
  // mapa novo: os lados do placar no vídeo podem ter trocado
  if (st.history.length !== BOT.mapN) {
    if (BOT.running && !st.over) { BOT.sidesOk = false; botNote(`Começou o mapa ${st.curMap}: confirme os lados do placar.`, 'warn'); botBeep(); }
    BOT.mapN = st.history.length;
  }
}
const botRefreshAdmin = () => { if (A.view === 'esporte-ev' && A.catEv === BOT.ev.id && !$('#modal').classList.contains('show')) render(); };

async function botSuspend(why) {
  BOT.why = why;
  if (BOT.susp) return botPaint();
  await botSync();
  const ids = BOT.markets.filter((m) => m.status === 'open').map((m) => m.id);
  if (ids.length) await api('POST', '/api/admin/catalog/market/status', { evId: BOT.ev.id, ids, status: 'suspended', bot: true });
  BOT.susp = ids;
  botNote(`Mercados suspensos: ${why}`, 'bad'); botBeep(); botRefreshAdmin();
}
async function botReopen() {
  const ids = BOT.susp;
  BOT.susp = null; BOT.why = '';
  if (ids.length) await api('POST', '/api/admin/catalog/market/status', { evId: BOT.ev.id, ids, status: 'open', bot: true });
  botNote('Leitura de volta ao normal: mercados reabertos.', 'ok'); botRefreshAdmin();
}

async function botApply(r) {
  let act = botDecide(BOT.srv, r);
  if (act.do !== 'ok') { await botSync(); act = botDecide(BOT.srv, r); } // o placar pode ter mudado no painel
  if (act.do === 'over') { botNote('Partida terminada. Bot parado (a liquidação final corre a seguir).', 'ok'); botScheduleSettle(); return botStop(); }
  BOT.scoreOk = act.do === 'ok';
  if (act.do === 'ok') { if (BOT.susp && BOT.sidesOk) await botReopen(); return; }
  if (act.do === 'round') {
    if (!BOT.sidesOk) return botSuspend('round no vídeo mas os lados deste mapa ainda não foram confirmados');
    const name = act.side === 'h' ? BOT.ev.home : BOT.ev.away;
    const res = await api('POST', '/api/admin/catalog/event/round', { id: BOT.ev.id, side: act.side, bot: true });
    botNote(`+1 round ${name} (${r.h}-${r.a})`, 'ok');
    // round novo: os vivos do anterior já não contam; espera ver todos vivos outra vez
    BOT.aliveArmed = false; BOT.aliveSent = null; BOT.aliveSeq = [];
    BOT.stats.rounds++;
    botScheduleSettle();
    if (res.live.state.over) botNote('Último round: partida terminada no site.', 'ok');
    botSetState(res.live.state);
    if (BOT.susp && BOT.sidesOk) await botReopen();
    botRefreshAdmin();
    return;
  }
  if (act.do === 'behind') return;
  await botSuspend(`o vídeo mostra ${r.h}-${r.a} mas o placar no site é ${BOT.srv.a}-${BOT.srv.b} (corrija com +1 / desfazer no painel)`);
}

/* ---------- OCR ---------- */
function botLoadOcr() {
  BOT.ocr ||= new Promise((ok, no) => {
    if (window.Tesseract) return ok();
    const s = document.createElement('script');
    s.src = BOT_OCR_URL; s.onload = ok; s.onerror = () => no(new Error('Não foi possível carregar o leitor de texto (OCR).'));
    document.head.appendChild(s);
  }).then(async () => {
    const w = await Tesseract.createWorker('eng');
    await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '10' });
    return w;
  });
  BOT.ocr.catch(() => { BOT.ocr = null; });
  return BOT.ocr;
}

// limiar de Otsu só sobre os tons entre lo e hi (permite separar, p.ex., números brancos de uma caixa laranja)
function botOtsu(gray, lo = 0, hi = 255) {
  const hist = new Array(256).fill(0);
  let n = 0, sum = 0;
  for (const v of gray) if (v >= lo && v <= hi) { hist[v]++; n++; sum += v; }
  let sB = 0, wB = 0, best = -1, th = (lo + hi) >> 1;
  for (let i = lo; i <= hi; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sB += i * hist[i];
    const d = sB / wB - (sum - sB) / wF, b = wB * wF * d * d;
    if (b > best) { best = b; th = i; }
  }
  return th;
}

// manchas de "tinta" que podem ser dígitos: não tocam na moldura da caixa e têm altura de número
function botDigits(ink, W, H) {
  const seen = new Uint8Array(W * H), comps = [];
  for (let s = 0; s < W * H; s++) {
    if (!ink[s] || seen[s]) continue;
    const c = { x0: W, x1: 0, y0: H, y1: 0, px: [], edge: false };
    const stack = [s]; seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i - x) / W;
      c.px.push(i);
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) c.edge = true;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j >= 0 && ink[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (!c.edge && c.y1 - c.y0 + 1 >= H * 0.3 && c.px.length >= 12) comps.push(c);
  }
  comps.sort((a, b) => a.x0 - b.x0);
  // pedaços do mesmo dígito (sobrepostos na horizontal) juntam-se
  const out = [];
  for (const c of comps) {
    const p = out[out.length - 1];
    if (p && c.x0 <= p.x1 - 2) { p.px.push(...c.px); p.x1 = Math.max(p.x1, c.x1); p.y0 = Math.min(p.y0, c.y0); p.y1 = Math.max(p.y1, c.y1); }
    else out.push(c);
  }
  return out.length >= 1 && out.length <= 2 ? out : null;
}

// recorta a caixa, aumenta, separa os dígitos (preto em fundo branco) e lê um a um
const botTmp = typeof document !== 'undefined' ? [document.createElement('canvas'), document.createElement('canvas')] : [];
async function botReadCanvas(src, sx, sy, sw, sh, cv) {
  const H = 64, W = Math.max(16, Math.round((sw * H) / sh));
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
  const img = g.getImageData(0, 0, W, H), px = img.data, n = W * H, gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) gray[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000 | 0;
  // vários cortes de preto e branco: geral, só os tons claros, só os escuros
  const t0 = botOtsu(gray), ths = [t0, botOtsu(gray, t0 + 1, 255), botOtsu(gray, 0, t0)];
  for (const th of ths) {
    // o fundo é o tom que domina a moldura da caixa; a tinta é o outro
    let dark = 0, m = 0;
    for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { m++; if (gray[y * W + x] <= th) dark++; }
    for (let y = 0; y < H; y++) for (const x of [0, W - 1]) { m++; if (gray[y * W + x] <= th) dark++; }
    const lightInk = dark > m / 2, ink = new Uint8Array(n);
    for (let i = 0; i < n; i++) ink[i] = lightInk ? gray[i] > th : gray[i] <= th;
    const digits = botDigits(ink, W, H);
    if (!digits) continue;
    // mostra no painel o que o bot está a ler
    for (let i = 0; i < n; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 255; px[i * 4 + 3] = 255; }
    for (const d of digits) for (const i of d.px) px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 0;
    g.putImageData(img, 0, 0);
    let txt = '';
    for (const d of digits) {
      const v = await botOcrDigit(d, W);
      if (v == null) { txt = null; break; }
      txt += v;
    }
    if (txt != null) return Number(txt);
  }
  return null;
}
async function botOcrDigit(d, W) {
  const [t, o] = botTmp, bw = d.x1 - d.x0 + 1, bh = d.y1 - d.y0 + 1;
  t.width = bw; t.height = bh;
  const tg = t.getContext('2d'), im = tg.createImageData(bw, bh);
  im.data.fill(255);
  for (const i of d.px) { const x = (i % W) - d.x0, y = ((i - (i % W)) / W) - d.y0, k = (y * bw + x) * 4; im.data[k] = im.data[k + 1] = im.data[k + 2] = 0; }
  tg.putImageData(im, 0, 0);
  const DH = 48, DW = Math.max(6, Math.round((bw * DH) / bh)), P = 14;
  o.width = DW + 2 * P; o.height = DH + 2 * P;
  const og = o.getContext('2d');
  og.fillStyle = '#fff'; og.fillRect(0, 0, o.width, o.height);
  og.drawImage(t, P, P, DW, DH);
  const { data } = await BOT.worker.recognize(o);
  const s = String(data.text || '').replace(/\s+/g, '');
  return /^\d$/.test(s) && data.confidence >= BOT_MIN_CONF ? s : null;
}
async function botReadBox(k) {
  const v = BOT.video, c = BOT.calib[k];
  if (!c || !v.videoWidth) return null;
  return botReadCanvas(v, c.x * v.videoWidth, c.y * v.videoHeight, c.w * v.videoWidth, c.h * v.videoHeight, BOT.panel.querySelector(`#botCv${k}`));
}

/* ---------- liquidação automática ----------
   Depois de cada round (e no fim da partida) liquida os mercados que o placar já decidiu (corridas, 1º tempo,
   mapa, série...) e as apostas são pagas. Espera BOT_SETTLE sem rounds novos: se a leitura estava errada,
   há tempo para "desfazer" no painel antes de pagar. Com mercados suspensos por dúvida, adia. */
function botScheduleSettle(ms = BOT_SETTLE) {
  clearTimeout(BOT.settleT);
  if (!BOT.autoSettle) return;
  BOT.settleAt = Date.now() + ms;
  BOT.settleT = setTimeout(botSettle, ms);
  botPaint();
}
async function botSettle() {
  BOT.settleAt = null;
  if (!BOT.autoSettle) return;
  if (BOT.susp) { botNote('Liquidação adiada: há mercados suspensos por leitura duvidosa.', 'warn'); return botScheduleSettle(); }
  try {
    const r = await api('POST', '/api/admin/catalog/event/settle-all', { id: BOT.ev.id, bot: true });
    if (r.settled) {
      BOT.stats.settled += r.settled;
      botNote(`Liquidados pelo placar (apostas pagas): ${r.markets?.join(', ') || r.settled + ' mercado(s)'}`, 'ok');
      botRefreshAdmin();
    }
  } catch (e) { botNote('Liquidação: ' + e.message, 'bad'); botScheduleSettle(); }
  botPaint();
}

/* ---------- jogadores vivos ---------- */
// cada faixa (uma por equipa) é dividida em BOT_SLOTS cartões; mede-se a cor + brilho de cada um
const botCellCv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
function botCells(k) {
  const v = BOT.video, c = BOT.calib[k], N = BOT_SLOTS, S = 12;
  if (!c || !v.videoWidth) return null;
  const horiz = c.w * v.videoWidth >= c.h * v.videoHeight, W = horiz ? N * S : S, H = horiz ? S : N * S;
  botCellCv.width = W; botCellCv.height = H;
  const g = botCellCv.getContext('2d', { willReadFrequently: true });
  g.drawImage(v, c.x * v.videoWidth, c.y * v.videoHeight, c.w * v.videoWidth, c.h * v.videoHeight, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data, out = [];
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const j = ((horiz ? y : i * S + y) * W + (horiz ? i * S + x : x)) * 4, r = px[j], gg = px[j + 1], b = px[j + 2];
      s += Math.max(r, gg, b) - Math.min(r, gg, b) + 0.35 * ((r * 299 + gg * 587 + b * 114) / 1000);
    }
    out.push(s / (S * S));
  }
  return out;
}
const botAliveCount = (k) => {
  const cells = botCells(k), ref = BOT.calib.ref?.[k];
  return cells && ref ? cells.filter((s, i) => s >= ref[i] * BOT_DEAD).length : null;
};
function botAliveRef() {
  const L = botCells('PL'), R = botCells('PR');
  if (!L || !R) throw new Error('Marque primeiro as faixas de jogadores das duas equipas.');
  BOT.calib.ref = { PL: L, PR: R };
  botSaveCalib();
  botNote('Referência guardada: todos vivos.', 'ok');
}
async function botAliveTick() {
  if (!BOT.aliveOn || !BOT.calib.ref) return;
  const L = botAliveCount('PL'), R = botAliveCount('PR');
  const r = L == null || R == null ? null : BOT.swap ? { h: R, a: L } : { h: L, a: R };
  BOT.aliveRead = r;
  if (!r) { BOT.aliveSeq = []; return; }
  BOT.aliveSeq.push(r);
  if (BOT.aliveSeq.length > 2) BOT.aliveSeq.shift();
  if (BOT.aliveSeq.length < 2 || BOT.aliveSeq.some((x) => x.h !== r.h || x.a !== r.a)) return;
  const full = r.h === BOT_SLOTS && r.a === BOT_SLOTS;
  if (full) BOT.aliveArmed = true; // começou um round (todos vivos): a partir daqui as mortes contam
  if (!BOT.aliveArmed || !BOT.scoreOk || BOT.susp || !BOT.sidesOk) return;
  const key = full ? null : `${r.h}v${r.a}`;
  if (key === BOT.aliveSent) return;
  await api('POST', '/api/admin/catalog/event/alive', full ? { id: BOT.ev.id, h: null } : { id: BOT.ev.id, h: r.h, a: r.a });
  BOT.aliveSent = key;
  if (!full) botNote(`Dentro do round: ${r.h} v ${r.a}`);
  botRefreshAdmin();
}
function botSaveCalib() { try { localStorage.setItem(botCalibKey(), JSON.stringify(BOT.calib)); } catch { /* sem storage */ } }

/* ---------- ciclo ---------- */
async function botTick() {
  if (!BOT.running) return;
  try {
    const L = await botReadBox('L'), R = await botReadBox('R');
    BOT.read = { L, R };
    if (L == null || R == null) {
      BOT.seq = [];
      if (Date.now() - BOT.lastGood > BOT_LOST) await botSuspend('o placar não aparece no vídeo (replay, intervalo ou sinal perdido)');
    } else {
      BOT.lastGood = Date.now();
      const r = BOT.swap ? { h: R, a: L } : { h: L, a: R };
      BOT.seq.push(r);
      if (BOT.seq.length > BOT_CONFIRM) BOT.seq.shift();
      if (BOT.seq.length === BOT_CONFIRM && BOT.seq.every((x) => x.h === r.h && x.a === r.a)) await botApply(r);
    }
    await botAliveTick();
  } catch (e) {
    botNote('Erro: ' + e.message, 'bad');
  }
  botPaint();
  if (BOT.running) BOT.timer = setTimeout(botTick, BOT_STEP);
}

async function botStart() {
  if (!BOT.video?.videoWidth) return toast('Escolha primeiro o separador com a transmissão.', 'err');
  if (!BOT.calib.L || !BOT.calib.R) return toast('Marque no vídeo onde ficam os dois números do placar.', 'err');
  botNote('A carregar o leitor de texto...');
  try { BOT.worker = await botLoadOcr(); } catch (e) { return botNote(e.message, 'bad'); }
  await botSync(); // ainda parado: um mapa novo entretanto não pede confirmação (ligar = confirmar os lados)
  if (BOT.srv.over) return botNote('A partida já terminou.', 'warn');
  BOT.running = true; BOT.sidesOk = true; BOT.seq = []; BOT.lastGood = Date.now();
  const [l, r] = botNames();
  botNote(`Bot ligado. Esquerda: ${l} · direita: ${r}.`, 'ok');
  botTick();
}
function botStop() {
  BOT.running = false; clearTimeout(BOT.timer);
  if (BOT.susp) botNote('Bot parado. Os mercados que ele suspendeu continuam suspensos: reabra-os no painel quando quiser.', 'warn');
  else botNote('Bot parado.');
}

// larga a fonte de vídeo atual (link da partida ou separador partilhado)
function botDropSource() {
  clearTimeout(BOT.retry);
  BOT.src = null;
  if (BOT.hls) { BOT.hls.destroy(); BOT.hls = null; }
  BOT.stream?.getTracks().forEach((t) => t.stop()); BOT.stream = null;
  if (BOT.video) { BOT.video.srcObject = null; BOT.video.removeAttribute('src'); BOT.video.load(); }
}
function botLoadHls() {
  BOT.hlsLib ||= new Promise((ok, no) => {
    if (window.Hls) return ok();
    const s = document.createElement('script');
    s.src = BOT_HLS_URL; s.onload = ok; s.onerror = () => no(new Error('Não foi possível carregar o leitor de vídeo.'));
    document.head.appendChild(s);
  });
  BOT.hlsLib.catch(() => { BOT.hlsLib = null; });
  return BOT.hlsLib;
}
// transmissão pelo link da partida: o servidor serve o vídeo pelo próprio site, por isso o bot consegue lê-lo
async function botLink(again = false) {
  if (!BOT.ev.stream) return botNote('Este jogo não tem link de transmissão: preencha o campo "Transmissão" no evento (ou use "Partilhar um separador").', 'warn');
  if (!again) botNote('A abrir a transmissão da partida...');
  let r;
  try {
    r = await api('GET', '/api/admin/stream/play?id=' + encodeURIComponent(BOT.ev.id));
    await botLoadHls();
  } catch (e) {
    botNote('Transmissão: ' + e.message, 'bad');
    if (again || BOT.running) botRetry();
    return;
  }
  botDropSource();
  BOT.src = 'link';
  const v = BOT.video;
  if (window.Hls?.isSupported()) {
    const h = new Hls({ liveSyncDurationCount: 2, maxBufferLength: 12, backBufferLength: 10 });
    BOT.hls = h;
    h.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal || BOT.hls !== h) return;
      botNote('A transmissão caiu (' + (data.details || data.type) + '). A tentar de novo...', 'warn');
      botRetry();
    });
    h.loadSource(r.src);
    h.attachMedia(v);
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) v.src = r.src;
  else return botNote('Este browser não consegue tocar a transmissão. Use o Chrome ou o Edge.', 'bad');
  v.play().catch(() => {});
  botNote(`Transmissão da partida ligada (${r.quality}). ${BOT.calib.L && BOT.calib.R ? 'Pode ligar o bot.' : 'Marque as caixas do placar.'}`, 'ok');
}
// tenta reabrir o link (o token da transmissão expira, o canal pode cair e voltar)
function botRetry() {
  clearTimeout(BOT.retry);
  BOT.retry = setTimeout(() => { if (BOT.panel?.style.display !== 'none') botLink(true); }, 6000);
}

async function botPick() {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    botDropSource();
    BOT.src = 'screen';
    BOT.stream = s; BOT.video.srcObject = s; await BOT.video.play();
    s.getVideoTracks()[0].addEventListener('ended', () => {
      if (BOT.stream !== s) return;
      BOT.stream = null;
      if (BOT.running) { botStop(); botSuspend('a partilha do separador terminou').catch(() => {}); }
      botPaint();
    });
    botNote('Transmissão ligada. Marque as caixas do placar se ainda não estiverem marcadas.');
  } catch (e) {
    if (e.name !== 'NotAllowedError') botNote('Não foi possível captar o ecrã: ' + e.message, 'bad');
  }
}

/* ---------- painel ---------- */
function botPaint() {
  const p = BOT.panel;
  if (!p) return;
  const [l, r] = botNames();
  const sv = BOT.srv;
  p.querySelector('#botNames').innerHTML = `Esquerda: <b>${botEsc(l)}</b> · direita: <b>${botEsc(r)}</b>`;
  p.querySelector('#botReadL').textContent = BOT.read.L ?? '–';
  p.querySelector('#botReadR').textContent = BOT.read.R ?? '–';
  p.querySelector('#botAlive').textContent = !BOT.aliveOn ? 'desligado' : !BOT.calib.ref ? 'falta a referência' : BOT.aliveRead ? `${BOT.aliveRead.h} v ${BOT.aliveRead.a}` : '–';
  p.querySelector('#botAliveOn').checked = BOT.aliveOn;
  p.querySelector('#botAutoSettle').checked = BOT.autoSettle;
  p.querySelector('#botStats').textContent = `Bot nesta partida: ${BOT.stats.rounds} round(s) contado(s) · ${BOT.stats.settled} mercado(s) liquidado(s)`
    + (BOT.settleAt ? ` · próxima liquidação em ${Math.max(0, Math.round((BOT.settleAt - Date.now()) / 1000))} s` : '');
  p.querySelector('#botSrv').textContent = sv ? `${sv.a} : ${sv.b}${sv.map ? ` (mapa ${sv.map})` : ''}` : '–';
  const st = p.querySelector('#botStatus');
  st.className = 'bot-status ' + (BOT.susp ? 'bad' : BOT.running ? (BOT.sidesOk ? 'ok' : 'warn') : '');
  st.textContent = BOT.susp ? '⚠️ Mercados suspensos pelo bot: ' + BOT.why
    : !BOT.running ? 'Parado' : !BOT.sidesOk ? 'Mapa novo: confirme os lados do placar' : '✅ A seguir o placar';
  p.querySelector('#botSides').style.display = BOT.running && !BOT.sidesOk ? '' : 'none';
  p.querySelector('#botSideA').textContent = `Esquerda é ${BOT.ev.home}`;
  p.querySelector('#botSideB').textContent = `Esquerda é ${BOT.ev.away}`;
  p.querySelector('#botRun').textContent = BOT.running ? '⏸ Parar bot' : '▶ Ligar bot';
  p.querySelector('#botLog').innerHTML = BOT.log.map((x) => `<div class="${x.kind}"><span>${x.t}</span> ${botEsc(x.msg)}</div>`).join('');
  botDraw();
}
function botDraw() {
  const cv = BOT.panel?.querySelector('#botOverlay'), v = BOT.video;
  if (!cv) return;
  cv.width = v.clientWidth; cv.height = v.clientHeight;
  const g = cv.getContext('2d'), [l, r] = botNames();
  g.clearRect(0, 0, cv.width, cv.height);
  const box = (c, color, label) => {
    if (!c) return;
    g.strokeStyle = color; g.lineWidth = 2; g.strokeRect(c.x * cv.width, c.y * cv.height, c.w * cv.width, c.h * cv.height);
    g.fillStyle = color; g.font = 'bold 11px Inter, sans-serif'; g.fillText(label, c.x * cv.width, Math.max(10, c.y * cv.height - 3));
  };
  box(BOT.calib.L, '#22c55e', l);
  box(BOT.calib.R, '#f59e0b', r);
  // faixas de jogadores, com a divisão dos cartões
  for (const [k, color, label] of [['PL', '#22c55e', `jogadores ${l}`], ['PR', '#f59e0b', `jogadores ${r}`]]) {
    const c = BOT.calib[k];
    if (!c) continue;
    box(c, color, label);
    g.globalAlpha = 0.5;
    const horiz = c.w * (v.videoWidth || 16) >= c.h * (v.videoHeight || 9);
    for (let i = 1; i < BOT_SLOTS; i++) {
      g.beginPath();
      if (horiz) { const x = (c.x + (c.w * i) / BOT_SLOTS) * cv.width; g.moveTo(x, c.y * cv.height); g.lineTo(x, (c.y + c.h) * cv.height); }
      else { const y = (c.y + (c.h * i) / BOT_SLOTS) * cv.height; g.moveTo(c.x * cv.width, y); g.lineTo((c.x + c.w) * cv.width, y); }
      g.stroke();
    }
    g.globalAlpha = 1;
  }
  if (BOT.drag) box(BOT.drag, '#fff', 'a marcar...');
}

function botBuild() {
  const style = document.createElement('style');
  style.textContent = `
  #botPanel{position:fixed;right:16px;bottom:16px;width:min(460px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;z-index:60;background:var(--panel);border:1px solid #2b5a3d;border-radius:12px;box-shadow:0 10px 40px #000a;padding:12px;font-size:13px}
  #botPanel.min .bot-body{display:none}
  #botPanel .bot-top{display:flex;align-items:center;gap:8px}
  #botPanel .bot-top b{flex:1}
  #botPanel .bot-x{background:none;border:0;color:var(--muted);font-size:16px;cursor:pointer;padding:2px 6px}
  #botPanel .bot-vid{position:relative;margin:10px 0;background:#000;border-radius:8px;overflow:hidden;min-height:60px}
  #botPanel video{display:block;width:100%;height:auto}
  #botOverlay{position:absolute;inset:0;cursor:crosshair}
  #botPanel .bot-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0}
  #botPanel .bot-row .btn{padding:6px 10px;font-size:12px}
  #botPanel .bot-reads{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:8px 0;text-align:center}
  #botPanel .bot-reads div{background:var(--panel2);border-radius:8px;padding:6px}
  #botPanel .bot-reads canvas{max-width:100%;height:28px;background:#fff;border-radius:4px}
  #botPanel .bot-reads b{display:block;font-size:20px}
  #botPanel .bot-reads small{color:var(--muted)}
  #botPanel .bot-status{padding:8px 10px;border-radius:8px;background:var(--panel2);font-weight:600;margin:6px 0}
  #botPanel .bot-status.ok{color:#22c55e}
  #botPanel .bot-status.warn{color:var(--yellow)}
  #botPanel .bot-status.bad{color:#fff;background:#7f1d1d}
  #botLog{max-height:140px;overflow:auto;font-size:12px;color:var(--muted)}
  #botLog div{padding:2px 0;border-bottom:1px solid var(--line)}
  #botLog span{opacity:.7}
  #botLog .ok{color:#86efac} #botLog .warn{color:var(--yellow)} #botLog .bad{color:#fca5a5}`;
  document.head.appendChild(style);
  const p = document.createElement('div');
  p.id = 'botPanel';
  p.innerHTML = `<div class="bot-top"><b id="botTitle"></b><button class="bot-x" data-botact="min" title="Minimizar">—</button><button class="bot-x" data-botact="close" title="Fechar">✕</button></div>
  <div class="bot-body">
    <div class="bot-row"><button class="btn btn-green" data-botact="link">📺 Abrir a transmissão da partida</button><button class="btn btn-ghost" data-botact="pick" title="Alternativa: partilhar um separador ou janela deste computador">🖥️ Partilhar um separador</button></div>
    <div class="sub" id="botSrcInfo"></div>
    <div class="bot-vid"><video muted playsinline></video><canvas id="botOverlay"></canvas></div>
    <div class="bot-row"><button class="btn btn-ghost" data-botact="markL">▭ Marcar número da esquerda</button><button class="btn btn-ghost" data-botact="markR">▭ Marcar número da direita</button><button class="btn btn-ghost" data-botact="swap">⇄ Trocar lados</button></div>
    <div class="bot-row"><label class="check" style="margin:0"><input type="checkbox" id="botAliveOn"> Ler jogadores vivos (odd dentro do round)</label></div>
    <div class="bot-row"><button class="btn btn-ghost" data-botact="markPL">▭ Jogadores da esquerda</button><button class="btn btn-ghost" data-botact="markPR">▭ Jogadores da direita</button><button class="btn btn-ghost" data-botact="aliveRef">📸 Todos vivos agora</button><span class="sub">Vivos: <b id="botAlive">–</b></span></div>
    <div class="sub" id="botNames"></div>
    <div class="bot-reads"><div><small>Lido esquerda</small><canvas id="botCvL"></canvas><b id="botReadL">–</b></div><div><small>Placar no site</small><b id="botSrv" style="font-size:16px;margin-top:8px">–</b></div><div><small>Lido direita</small><canvas id="botCvR"></canvas><b id="botReadR">–</b></div></div>
    <div id="botStatus" class="bot-status">Parado</div>
    <div class="bot-row" id="botSides" style="display:none"><button class="btn btn-green" data-botact="sideA" id="botSideA"></button><button class="btn btn-green" data-botact="sideB" id="botSideB"></button></div>
    <div class="bot-row"><button class="btn btn-green" data-botact="run" id="botRun">▶ Ligar bot</button><label class="check" style="margin:0"><input type="checkbox" id="botAutoSettle" checked> Liquidar as apostas sozinho (60 s depois de o placar decidir)</label></div>
    <div class="sub" id="botStats"></div>
    <p class="sub" style="margin:6px 0">Marque cada caixa à volta do número de rounds (arraste no vídeo), com uma pequena margem: o número não pode tocar na borda e a caixa tem de caber 2 dígitos (10, 11...). O bot só conta um round depois de ler o mesmo placar ${BOT_CONFIRM} vezes seguidas; se a leitura não bater com o site ou o placar sair do ecrã, suspende os mercados e avisa. Os botões +1 / desfazer do painel continuam a funcionar.</p>
    <div id="botLog"></div>
  </div>`;
  document.body.appendChild(p);
  BOT.panel = p;
  BOT.video = p.querySelector('video');
  BOT.video.addEventListener('loadedmetadata', botDraw);
  window.addEventListener('resize', botDraw);

  p.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-botact]');
    if (!b) return;
    const act = b.dataset.botact;
    try {
      if (act === 'min') p.classList.toggle('min');
      else if (act === 'close') {
        if (BOT.running && !confirm('Parar o bot e fechar?')) return;
        if (BOT.running) botStop();
        botDropSource();
        p.style.display = 'none';
      } else if (act === 'link') await botLink();
      else if (act === 'pick') await botPick();
      else if (act === 'markL' || act === 'markR') { BOT.marking = act.slice(-1); botNote(`Arraste no vídeo à volta do número da ${BOT.marking === 'L' ? 'esquerda' : 'direita'}.`); }
      else if (act === 'markPL' || act === 'markPR') { BOT.marking = act.slice(-2); botNote(`Arraste à volta dos ${BOT_SLOTS} cartões de jogadores da ${act === 'markPL' ? 'esquerda' : 'direita'} (só os cartões, de ponta a ponta).`); }
      else if (act === 'aliveRef') botAliveRef();
      else if (act === 'swap') { BOT.swap = !BOT.swap; BOT.seq = []; botPaint(); }
      else if (act === 'sideA' || act === 'sideB') {
        BOT.swap = act === 'sideB'; BOT.sidesOk = true; BOT.seq = [];
        botNote(`Lados confirmados: esquerda é ${act === 'sideA' ? BOT.ev.home : BOT.ev.away}.`, 'ok');
      } else if (act === 'run') { if (BOT.running) botStop(); else await botStart(); }
    } catch (err) { botNote('Erro: ' + err.message, 'bad'); }
  });

  p.querySelector('#botAliveOn').addEventListener('change', (e) => { BOT.aliveOn = e.target.checked; BOT.aliveSeq = []; botPaint(); });
  p.querySelector('#botAutoSettle').addEventListener('change', (e) => {
    BOT.autoSettle = e.target.checked;
    if (!BOT.autoSettle) { clearTimeout(BOT.settleT); BOT.settleAt = null; } else if (BOT.stats.rounds) botScheduleSettle(5000);
    botPaint();
  });
  // marcar uma caixa: arrastar no vídeo (guarda-se em frações, vale para qualquer tamanho)
  const ov = p.querySelector('#botOverlay');
  const at = (e) => { const r = ov.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  ov.addEventListener('pointerdown', (e) => { if (!BOT.marking) return; const s = at(e); BOT.drag = { x: s.x, y: s.y, w: 0, h: 0, s }; ov.setPointerCapture(e.pointerId); });
  ov.addEventListener('pointermove', (e) => {
    if (!BOT.drag) return;
    const c = at(e), s = BOT.drag.s;
    Object.assign(BOT.drag, { x: Math.min(s.x, c.x), y: Math.min(s.y, c.y), w: Math.abs(c.x - s.x), h: Math.abs(c.y - s.y) });
    botDraw();
  });
  ov.addEventListener('pointerup', () => {
    const d = BOT.drag; BOT.drag = null;
    if (!d || !BOT.marking) return;
    if (d.w < 0.005 || d.h < 0.005) { botDraw(); return; }
    BOT.calib[BOT.marking] = { x: d.x, y: d.y, w: d.w, h: d.h };
    if (BOT.marking === 'PL' || BOT.marking === 'PR') delete BOT.calib.ref; // faixa nova: tirar outra referência
    BOT.marking = null; BOT.seq = [];
    botSaveCalib();
    botNote(BOT.calib.ref || !(BOT.calib.PL || BOT.calib.PR) ? 'Caixa marcada (fica guardada para este campeonato).' : 'Faixa marcada. Quando estiverem todos vivos, clique em "📸 Todos vivos agora".');
  });
}

// abre o painel do bot para um evento (chamado do cartão "Placar ao vivo")
window.StreamBot = {
  open(d) {
    const ev = d.event;
    if (!d.live) return toast('Defina primeiro as regras do jogo no campeonato.', 'err');
    if (BOT.running && BOT.ev.id !== ev.id) return toast(`O bot já está a seguir ${BOT.ev.home} x ${BOT.ev.away}. Pare-o primeiro.`, 'err');
    if (!BOT.panel) botBuild();
    const fresh = BOT.ev?.id !== ev.id;
    if (fresh) {
      botDropSource();
      BOT.ev = { id: ev.id, home: ev.home, away: ev.away, league: ev.league };
      BOT.swap = false; BOT.susp = null; BOT.log = []; BOT.srv = null; BOT.read = { L: null, R: null };
      clearTimeout(BOT.settleT); BOT.settleAt = null; BOT.stats = { rounds: 0, settled: 0 };
      try { BOT.calib = JSON.parse(localStorage.getItem(botCalibKey())) || { L: null, R: null }; } catch { BOT.calib = { L: null, R: null }; }
      botSetState(d.live.state); BOT.mapN = d.live.state.history.length;
    }
    BOT.ev.stream = ev.stream || '';
    BOT.panel.querySelector('#botTitle').textContent = `🤖 Bot · ${ev.home} x ${ev.away}`;
    BOT.panel.querySelector('#botSrcInfo').textContent = BOT.ev.stream ? `Link da partida: ${BOT.ev.stream}` : 'Este jogo ainda não tem link de transmissão (campo "Transmissão" no evento).';
    BOT.panel.style.display = ''; BOT.panel.classList.remove('min');
    botPaint();
    // já abre a transmissão pelo link da partida
    if (BOT.ev.stream && !BOT.src) botLink();
  },
};
