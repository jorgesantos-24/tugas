'use strict';
/* Leitura do HUD da transmissão no servidor (sem browser e sem marcar caixas).

   - detect(): procura no topo da imagem pares de números simétricos ao centro (onde as transmissões de
     R6, CS2 e Valorant põem o placar): o par maior é o placar de rounds; um par pequeno logo abaixo com
     valores de 0 a 5 é o de jogadores vivos (ex.: "5 VS 3" no R6). Lê também o nome escrito ao lado de
     cada número do placar, para saber de que lado está cada equipa.
   - readBox(): lê um número numa caixa já encontrada (preto e branco, separa os dígitos e lê um a um).
   As imagens chegam do ffmpeg em RGB (frame = { w, h, rgb }). */

const os = require('node:os');

/* ---------- OCR (tesseract.js, um leitor para dígitos e outro para nomes) ---------- */
async function createOcr() {
  const T = require('tesseract.js');
  const opt = { cachePath: os.tmpdir() };
  const dig = await T.createWorker('eng', 1, opt);
  await dig.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '10' });
  const txt = await T.createWorker('eng', 1, opt);
  await txt.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ', tessedit_pageseg_mode: '7' }); // nomes em maiúsculas (R6) ou não (CS2)
  let blk = null; // blocos de texto (etiquetas de replay em 2 linhas), criado só quando é preciso
  return {
    async block(pgm) {
      if (!blk) { blk = await T.createWorker('eng', 1, opt); await blk.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ', tessedit_pageseg_mode: '6' }); }
      const { data } = await blk.recognize(pgm); return String(data.text || '').replace(/\s+/g, ' ').trim();
    },
    async digit(pgm) { const { data } = await dig.recognize(pgm); return { text: String(data.text || '').replace(/\s+/g, ''), conf: data.confidence }; },
    async text(pgm) { const { data } = await txt.recognize(pgm); return { text: String(data.text || '').replace(/\s+/g, ' ').trim(), conf: data.confidence }; },
    async close() { await dig.terminate(); await txt.terminate(); if (blk) await blk.terminate(); },
  };
}
const pgm = (w, h, px) => Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), Buffer.from(px.buffer, px.byteOffset, px.length)]);

/* ---------- imagem ---------- */
const lumAt = (f, x, y) => { const i = (y * f.w + x) * 3; return (f.rgb[i] * 299 + f.rgb[i + 1] * 587 + f.rgb[i + 2] * 114) / 1000; };
// recorta e redimensiona (bilinear) para cinzento W x H
function cropGray(f, bx, by, bw, bh, W, H) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(f.h - 1.001, Math.max(0, by + ((y + 0.5) * bh) / H - 0.5)), y0 = Math.floor(sy), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(f.w - 1.001, Math.max(0, bx + ((x + 0.5) * bw) / W - 0.5)), x0 = Math.floor(sx), fx = sx - x0;
      const a = lumAt(f, x0, y0), b = lumAt(f, x0 + 1, y0), c = lumAt(f, x0, y0 + 1), d = lumAt(f, x0 + 1, y0 + 1);
      out[y * W + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}
function otsu(gray, lo = 0, hi = 255) {
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
// manchas ligadas (8 vizinhos) de uma máscara; keepPx guarda os pixels de cada uma
function blobs(mask, W, H, keepPx) {
  const seen = new Uint8Array(W * H), out = [], stack = [];
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || seen[s]) continue;
    const c = { x0: W, x1: 0, y0: H, y1: 0, n: 0, edge: false, px: keepPx ? [] : null };
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i - x) / W;
      c.n++; if (keepPx) c.px.push(i);
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) c.edge = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if ((dx || dy) && X >= 0 && Y >= 0 && X < W && Y < H) { const j = Y * W + X; if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); } }
      }
    }
    out.push(c);
  }
  return out;
}

/* ---------- ler um número numa caixa ---------- */
async function readBox(f, box, ocr) {
  const bx = box.x * f.w, by = box.y * f.h, bw = box.w * f.w, bh = box.h * f.h;
  const H = 64, W = Math.max(16, Math.round((bw * H) / bh)), n = W * H;
  const gray = cropGray(f, bx, by, bw, bh, W, H);
  const t0 = otsu(gray), ths = [t0, otsu(gray, t0 + 1, 255), otsu(gray, 0, t0)];
  for (const th of ths) {
    let dark = 0, m = 0;
    for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { m++; if (gray[y * W + x] <= th) dark++; }
    for (let y = 0; y < H; y++) for (const x of [0, W - 1]) { m++; if (gray[y * W + x] <= th) dark++; }
    const light = dark > m / 2, ink = new Uint8Array(n);
    for (let i = 0; i < n; i++) ink[i] = light ? gray[i] > th : gray[i] <= th;
    let comps = blobs(ink, W, H, true).filter((c) => !c.edge && c.y1 - c.y0 + 1 >= H * 0.3 && c.n >= 12);
    comps.sort((a, b) => a.x0 - b.x0);
    const merged = [];
    for (const c of comps) { const p = merged[merged.length - 1]; if (p && c.x0 <= p.x1 - 2) { p.px.push(...c.px); p.x1 = Math.max(p.x1, c.x1); p.y0 = Math.min(p.y0, c.y0); p.y1 = Math.max(p.y1, c.y1); } else merged.push(c); }
    comps = merged;
    if (comps.length < 1 || comps.length > 2) continue;
    let txt = '';
    for (const d of comps) {
      const v = await readDigit(d, W, ocr);
      if (v == null) { txt = null; break; }
      txt += v;
    }
    if (txt != null) return Number(txt);
  }
  return null;
}
async function readDigit(d, W, ocr) {
  const bw = d.x1 - d.x0 + 1, bh = d.y1 - d.y0 + 1, DH = 48, DW = Math.max(6, Math.round((bw * DH) / bh)), P = 14;
  const OW = DW + 2 * P, OH = DH + 2 * P, src = new Uint8Array(bw * bh), out = new Uint8Array(OW * OH).fill(255);
  for (const i of d.px) { const x = (i % W) - d.x0, y = Math.floor(i / W) - d.y0; src[y * bw + x] = 1; }
  for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) if (src[Math.floor((y * bh) / DH) * bw + Math.floor((x * bw) / DW)]) out[(y + P) * OW + x + P] = 0;
  const r = await ocr.digit(pgm(OW, OH, out));
  return /^\d$/.test(r.text) && r.conf >= 50 ? r.text : null;
}

/* ---------- encontrar o placar ---------- */
// manchas com cara de dígito na faixa de cima, em claro (texto branco) e em escuro
function digitBlobs(f) {
  const X0 = Math.round(f.w * 0.2), X1 = Math.round(f.w * 0.8), Y1 = Math.round(f.h * 0.24), W = X1 - X0, H = Y1;
  // luminância (texto branco ou preto) e "brilho de cor" = canal mais forte (números a cor, ex.: placar laranja/azul do CS2)
  const lum = new Uint8Array(W * H), val = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * f.w + X0 + x) * 3;
    lum[y * W + x] = lumAt(f, X0 + x, y);
    val[y * W + x] = Math.max(f.rgb[i], f.rgb[i + 1], f.rgb[i + 2]);
  }
  const out = [];
  for (const [th, bright, src] of [[200, true, lum], [170, true, lum], [200, true, val], [60, false, lum]]) {
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) mask[i] = bright ? src[i] >= th : src[i] <= th;
    for (const c of blobs(mask, W, H, false)) {
      const bh = c.y1 - c.y0 + 1, bw = c.x1 - c.x0 + 1, dens = c.n / (bw * bh);
      if (bh < f.h * 0.016 || bh > f.h * 0.075 || bw / bh > 1 || bw / bh < 0.1 || dens < 0.12 || dens > 0.92) continue;
      out.push({ x0: c.x0 + X0, x1: c.x1 + X0, y0: c.y0, y1: c.y1, th, bright });
    }
  }
  return out;
}
// junta manchas lado a lado (números de 2 dígitos); cada mancha sozinha também conta
function numberCandidates(list) {
  const out = [], key = new Set();
  const add = (x0, x1, y0, y1, k) => { const id = `${x0},${x1},${y0},${y1}`; if (!key.has(id)) { key.add(id); out.push({ x0, x1, y0, y1, k }); } };
  for (const group of [true, false].map((b) => list.filter((c) => c.bright === b))) {
    const s = group.slice().sort((a, b) => a.x0 - b.x0);
    for (let i = 0; i < s.length; i++) {
      const a = s[i], ha = a.y1 - a.y0 + 1;
      add(a.x0, a.x1, a.y0, a.y1, 1);
      const b = s.find((c) => c !== a && c.x0 > a.x1 && c.x0 - a.x1 < ha * 0.45 && Math.abs(c.y0 - a.y0) < ha * 0.25 && Math.abs(c.y1 - a.y1) < ha * 0.25);
      if (b) add(a.x0, b.x1, Math.min(a.y0, b.y0), Math.max(a.y1, b.y1), 2);
    }
  }
  return out;
}
// pares simétricos ao centro, mesma linha e mesma altura
function symmetricPairs(cands, f) {
  const out = [];
  const cx = (c) => (c.x0 + c.x1) / 2, cy = (c) => (c.y0 + c.y1) / 2, hh = (c) => c.y1 - c.y0 + 1;
  for (const L of cands) for (const R of cands) {
    if (cx(L) >= cx(R) || cx(L) > f.w / 2 || cx(R) < f.w / 2) continue;
    const h = (hh(L) + hh(R)) / 2;
    if (Math.abs(cy(L) - cy(R)) > h * 0.3 || Math.abs(hh(L) - hh(R)) > h * 0.25) continue;
    const mid = (cx(L) + cx(R)) / 2, dx = cx(R) - cx(L);
    if (Math.abs(mid - f.w / 2) > f.w * 0.02 || dx < f.w * 0.025 || dx > f.w * 0.5) continue;
    out.push({ L, R, h, y: cy(L), err: Math.abs(mid - f.w / 2) / f.w });
  }
  return out;
}
const toBox = (c, f, m = 0.35) => {
  const h = c.y1 - c.y0 + 1, mx = h * m, my = h * m;
  return { x: (c.x0 - mx) / f.w, y: (c.y0 - my) / f.h, w: (c.x1 - c.x0 + 1 + 2 * mx) / f.w, h: (h + 2 * my) / f.h };
};

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// quão parecido é o texto lido com o nome da equipa (0 a 1); aceita abreviaturas ("FAZE" para "FaZe Clan")
function nameScore(read, team) {
  const r = norm(read), full = norm(team), first = norm(String(team).split(/\s+/)[0]);
  if (r.length < 2) return 0;
  let best = 0;
  for (const t of new Set([full, first].filter((x) => x.length >= 2))) {
    if (r.includes(t) || t.includes(r)) best = Math.max(best, Math.min(r.length, t.length) / Math.max(r.length, t.length) * 0.5 + 0.5);
    best = Math.max(best, 1 - lev(r, t) / Math.max(r.length, t.length));
  }
  return best;
}
// lê o nome escrito do lado de fora do número (à esquerda do placar da esquerda, à direita do da direita);
// devolve várias leituras (preto e branco de formas diferentes) e sides() fica com a que melhor bate
async function readName(f, c, side, ocr) {
  const h = c.y1 - c.y0 + 1, wR = f.w * 0.15, gap = h * 0.2;
  const x0 = side === 'L' ? Math.max(0, c.x0 - gap - wR) : Math.min(f.w - wR - 1, c.x1 + gap), y0 = Math.max(0, c.y0 - h * 0.15), bh = h * 1.3;
  const H = 48, W = Math.round((wR * H) / bh), gray = cropGray(f, x0, y0, wR, bh, W, H);
  const th = otsu(gray), minor = gray.filter((v) => v > th).length < (W * H) / 2; // texto = a cor minoritária
  const out = [];
  for (const ink of [(v) => v >= 170, (v) => v >= 200, (v) => (minor ? v > th : v <= th)]) {
    const px = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) px[i] = ink(gray[i]) ? 0 : 255;
    const t = (await ocr.text(pgm(W, H, px))).text;
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/* Procura o HUD numa imagem. known = placar do site { a, b } (ajuda a escolher o par certo).
   Devolve { score: { L, R, vals }, alive: { L, R, vals } | null, names: { L, R } } ou null. */
async function detect(f, ocr, known) {
  const cands = numberCandidates(digitBlobs(f));
  const pairs = symmetricPairs(cands, f).sort((a, b) => b.h - a.h || a.y - b.y || a.err - b.err);
  const cache = new Map();
  const val = async (c) => { const k = `${c.x0},${c.x1},${c.y0},${c.y1}`; if (!cache.has(k)) cache.set(k, await readBox(f, toBox(c, f), ocr)); return cache.get(k); };
  let score = null;
  for (const p of pairs.slice(0, 12)) {
    const l = await val(p.L), r = await val(p.R);
    if (l == null || r == null || l > 40 || r > 40) continue;
    const match = known && ((l === known.a && r === known.b) || (l === known.b && r === known.a)) ? 2 : 1;
    if (!score || match > score.match) score = { ...p, vals: [l, r], match };
    if (match === 2) break;
  }
  if (!score) return null;
  // um lado com um só dígito que faz parte de um número de 2 dígitos (o "0" do "10"): usa o número inteiro
  for (const [side, i] of [['L', 0], ['R', 1]]) {
    const c = score[side];
    if (c.k !== 1) continue;
    const big = cands.find((x) => x.k === 2 && x.x0 <= c.x0 + 1 && x.x1 >= c.x1 - 1 && x.y0 <= c.y1 && x.y1 >= c.y0);
    const v = big ? await val(big) : null;
    if (v != null && v <= 40) { score[side] = big; score.vals[i] = v; }
  }
  // jogadores vivos: par simétrico abaixo do placar, mais pequeno, com valores de 0 a 5
  let alive = null;
  for (const p of pairs) {
    if (p === score || p.y <= score.y + score.h * 0.6 || p.y > score.y + f.h * 0.16 || p.h > score.h * 1.05) continue;
    const l = await val(p.L), r = await val(p.R);
    if (l != null && r != null && l <= 5 && r <= 5) { alive = { L: toBox(p.L, f), R: toBox(p.R, f), vals: [l, r] }; break; }
  }
  const names = { L: await readName(f, score.L, 'L', ocr), R: await readName(f, score.R, 'R', ocr) };
  return { score: { L: toBox(score.L, f), R: toBox(score.R, f), vals: score.vals }, alive, names };
}

/* ---------- jogadores vivos pelos cartões (CS2 e HUDs sem "5 VS 3" escrito) ----------
   Nas laterais há um cartão por jogador; vivo = barra de vida colorida, morto = cartão cinzento.
   findBars() procura, de cada lado, 5 barras coloridas iguais e igualmente espaçadas (todos vivos, ex.: início
   do round) e devolve a posição de cada cartão; countBars() conta quantas ainda têm cor. */
const SAT = (r, g, b) => { const mx = Math.max(r, g, b); return mx > 110 && (mx - Math.min(r, g, b)) / mx > 0.45; };
// troço colorido mais comprido de cada linha numa faixa lateral
function sideRows(f, x0, x1) {
  const rows = [];
  for (let y = Math.round(f.h * 0.3); y < f.h; y++) {
    let best = 0, bs = 0, run = 0, rs = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * f.w + x) * 3;
      if (SAT(f.rgb[i], f.rgb[i + 1], f.rgb[i + 2])) { if (!run) rs = x; run++; if (run > best) { best = run; bs = rs; } } else run = 0;
    }
    if (best >= f.w * 0.025 && best <= f.w * 0.14) rows.push({ y, x0: bs, x1: bs + best - 1 });
  }
  return rows;
}
/* As barras de vida estão todas encostadas ao mesmo lado do cartão (com menos vida ficam mais curtas, mas a borda
   encostada não mexe): procura essa borda comum (as manchas de cor do cenário não a repetem), junta as linhas de
   cada barra (o número "100" corta-as ao meio) e exige 5 barras com o mesmo espaçamento. */
function fiveBars(rows, f, side) {
  const sets = [];
  const sigs = new Map();
  // a barra encolhe para dentro: a borda fixa é a de fora (esquerda na coluna da esquerda, direita na da direita)
  for (const r of rows) for (const [e, v] of side === 'L' ? [['a', r.x0]] : [['b', r.x1]]) { const k = `${e}|${Math.round(v / 4)}`; sigs.set(k, (sigs.get(k) || 0) + 1); }
  for (const [k] of [...sigs].sort((p, q) => q[1] - p[1]).slice(0, 8)) {
    const [e, v] = k.split('|'), edge = Number(v) * 4;
    const same = rows.filter((r) => Math.abs((e === 'a' ? r.x0 : r.x1) - edge) <= 4);
    if (same.length < 10) continue;
    // a caixa de cada cartão vai da borda encostada até ao comprimento máximo visto (barra cheia)
    const len = Math.max(...same.map((r) => r.x1 - r.x0 + 1)), a = e === 'a' ? edge : edge - len + 1, b = a + len - 1;
    const bars = [];
    for (const r of same) { const c = bars[bars.length - 1]; if (c && r.y - c.y1 <= f.h * 0.025) c.y1 = r.y; else bars.push({ y0: r.y, y1: r.y }); }
    const cy = (x) => (x.y0 + x.y1) / 2, ok = bars.filter((x) => x.y1 - x.y0 + 1 >= 2 && x.y1 - x.y0 + 1 <= f.h * 0.05);
    for (let i = 0; i + 4 < ok.length; i++) {
      const p = cy(ok[i + 1]) - cy(ok[i]);
      if (p < f.h * 0.05 || p > f.h * 0.16) continue;
      const set = ok.slice(i, i + 5);
      if (set.every((x, j) => Math.abs(cy(x) - (cy(ok[i]) + j * p)) < p * 0.08)) sets.push(set.map((x) => ({ x: a / f.w, y: x.y0 / f.h, w: (b - a + 1) / f.w, h: (x.y1 - x.y0 + 1) / f.h, edge: e })));
    }
  }
  return sets;
}
// os cartões das duas equipas ficam à mesma altura: escolhe o par de colunas (esquerda/direita) que bate
function findBars(f) {
  const Ls = fiveBars(sideRows(f, 0, Math.round(f.w * 0.2)), f, 'L'), Rs = fiveBars(sideRows(f, Math.round(f.w * 0.8), f.w), f, 'R');
  let best = null;
  for (const L of Ls) for (const R of Rs) {
    const d = L.reduce((s, x, i) => s + Math.abs(x.y - R[i].y), 0) / 5;
    if (d < 0.015 && (!best || d < best.d)) best = { L, R, d };
  }
  return best ? { L: best.L, R: best.R, colL: barColor(f, best.L), colR: barColor(f, best.R) } : null;
}
// início da barra (do lado encostado): onde há cor sempre que o jogador tem vida
function edgeStrip(f, s) {
  const len = Math.round(s.w * f.w), k = Math.max(3, Math.round(len * 0.06));
  const x0 = s.edge === 'b' ? Math.round((s.x + s.w) * f.w) - k : Math.round(s.x * f.w), y0 = Math.round(s.y * f.h), y1 = Math.max(y0 + 1, Math.round((s.y + s.h) * f.h));
  const px = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x0 + k; x++) { const i = (y * f.w + x) * 3; px.push([f.rgb[i], f.rgb[i + 1], f.rgb[i + 2]]); }
  return px;
}
const hsv = ([r, g, b]) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: mx ? d / mx : 0, v: mx };
};
// cor da barra de cada equipa, tirada quando os cartões são encontrados (todos vivos)
function barColor(f, slots) {
  const all = slots.flatMap((s) => edgeStrip(f, s)).map(hsv).filter((c) => c.s > 0.4);
  if (!all.length) return null;
  // média do tom em círculo (o vermelho fica dos dois lados do 0)
  const x = all.reduce((t, c) => t + Math.cos((c.h * Math.PI) / 180), 0), y = all.reduce((t, c) => t + Math.sin((c.h * Math.PI) / 180), 0);
  return { h: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360, v: all.reduce((t, c) => t + c.v, 0) / all.length };
}
/* quantos cartões de um lado ainda têm vida: o início da barra tem a cor da equipa com o brilho de quando estavam
   vivos. Um morto tem o cartão cinzento ou meio transparente (o cenário por trás aparece mais escuro e com outra cor). */
function countBars(f, slots, ref) {
  let n = 0;
  for (const s of slots) {
    const px = edgeStrip(f, s);
    const ok = px.filter((p) => {
      const c = hsv(p);
      if (c.s <= 0.4 || c.v <= 110) return false;
      if (!ref) return true;
      const dh = Math.min(Math.abs(c.h - ref.h), 360 - Math.abs(c.h - ref.h));
      return dh < 25 && c.v >= ref.v * 0.75;
    }).length;
    if (px.length && ok / px.length >= 0.5) n++;
  }
  return n;
}

/* ---------- replays ----------
   Repetições e "melhores momentos" mostram o HUD de rounds antigos (placar e vivos de outro momento).
   As transmissões marcam-nas com uma etiqueta (canto de cima à direita no CS2 da PGL, lado esquerdo no R6):
   lê o texto claro dessas zonas e procura as palavras. */
const REPLAY_WORDS = ['HIGHLIGHTS', 'HIGHLIGHT', 'REPLAY', 'MELHORES', 'MOMENTOS', 'REPETICAO', 'INSTANT'];
const REPLAY_ZONES = [[0.66, 0, 0.34, 0.13], [0, 0.12, 0.24, 0.16], [0, 0, 0.34, 0.1], [0.3, 0.12, 0.4, 0.12]];
const replayTag = (f, ocr) => findWords(f, ocr, REPLAY_ZONES, REPLAY_WORDS, false);
// procura palavras (com erros de leitura tolerados) em zonas da imagem: texto claro, de cor forte ou (dark) escuro
async function findWords(f, ocr, zones, dict, dark) {
  for (const [zx, zy, zw, zh] of zones) {
    const bx = zx * f.w, by = zy * f.h, bw = zw * f.w, bh = zh * f.h, H = 72, W = Math.round((bw * H) / bh);
    const gray = cropGray(f, bx, by, bw, bh, W, H);
    // cor forte (texto azul/laranja da etiqueta) na mesma grelha do recorte
    const sat = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (Math.min(f.h - 1, Math.floor(by + ((y + 0.5) * bh) / H)) * f.w + Math.min(f.w - 1, Math.floor(bx + ((x + 0.5) * bw) / W))) * 3;
      const mx = Math.max(f.rgb[i], f.rgb[i + 1], f.rgb[i + 2]), mn = Math.min(f.rgb[i], f.rgb[i + 1], f.rgb[i + 2]);
      const s = mx ? (mx - mn) / mx : 0;
      sat[y * W + x] = mx > 140 && s > 0.55 ? 1 : mx > 120 && s > 0.5 ? 2 : 0;
    }
    const inks = [(i) => gray[i] >= 200, (i) => sat[i] === 1, (i) => sat[i] >= 1]; // texto claro ou de cor -> preto
    if (dark) inks.push((i) => gray[i] <= 60); // texto escuro numa faixa clara (ex.: "PAUSA TÉCNICA" no R6)
    for (const ink of inks) {
      const px = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) px[i] = ink(i) ? 0 : 255;
      const words = (await ocr.block(pgm(W, H, px))).split(' ').map(norm).filter((w) => w.length >= 5);
      for (const w of words) for (const k of dict) if (1 - lev(w, k) / Math.max(w.length, k.length) >= 0.75) return k;
    }
  }
  return null;
}

/* ---------- pausas e intervalos ----------
   Sem placar no ecrã pode ser só uma pausa (técnica / tática) ou o anúncio da Twitch. As transmissões escrevem-no:
   procura as palavras no canto de cima, ao centro e nas faixas laterais. */
const PAUSE_WORDS = { PAUSA: 'pause', PAUSE: 'pause', PAUSED: 'pause', TECNICA: 'pause', TECHNICAL: 'pause', TIMEOUT: 'pause', TACTICAL: 'pause', TATICA: 'pause',
  INTERVALO: 'break', INTERVAL: 'break', INTERMISSION: 'break', VOLTAMOS: 'break', STARTING: 'break', COMECA: 'break',
  COMMERCIAL: 'ads', PATROCINADO: 'ads' };
const PAUSE_ZONES = [[0, 0.12, 0.3, 0.16], [0, 0, 0.4, 0.12], [0.3, 0, 0.4, 0.14], [0.6, 0, 0.4, 0.14], [0.15, 0.4, 0.7, 0.18], [0.2, 0.8, 0.6, 0.18]];
async function breakTag(f, ocr) {
  const w = await findWords(f, ocr, PAUSE_ZONES, Object.keys(PAUSE_WORDS), true);
  return w ? { kind: PAUSE_WORDS[w], word: w } : null;
}

// lados: { swap, conf } comparando os nomes lidos com as equipas do evento (swap = a casa está à direita)
function sides(names, home, away) {
  const sc = (reads, team) => Math.max(0, ...[].concat(reads || []).map((t) => nameScore(t, team)));
  const straight = sc(names.L, home) + sc(names.R, away), crossed = sc(names.L, away) + sc(names.R, home);
  return { swap: crossed > straight, conf: Math.abs(straight - crossed) / 2, straight, crossed };
}

module.exports = { createOcr, detect, readBox, sides, nameScore, findBars, countBars, replayTag, breakTag };
