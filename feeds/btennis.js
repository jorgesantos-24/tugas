'use strict';
/* Motor do "Criar aposta" do ténis — várias seleções do mesmo jogo numa só odd.
   O jogo simula-se N vezes, ponto a ponto, sempre com os mesmos números aleatórios (no servidor e no navegador dá o mesmo):
     cada jogador ganha o ponto em que serve com uma probabilidade própria, que muda de jogo para jogo
     (forma do dia: a favor de um e contra o outro; dia de saques fortes ou fracos para os dois);
     games com vantagem (duplas: ponto decisivo no 40-40), tie-break a 6-6, super tie-break (a 10) no lugar do set
     decisivo nas duplas; aces e duplas faltas de cada jogador pelos pontos que serviu (jogo longo = mais aces).
   Cada seleção vira a lista das simulações em que ganha, decidida pela MESMA regra de liquidação do site
   (markets.js: legOutcome, com o placar dos sets, o histórico game a game e os aces/duplas faltas de cada simulação);
   uma combinação ganha nas simulações em que ganham todas.
   Os números do jogo ajustam-se às odds da bet365 (vencedor, placar em sets, total e handicap de games, sets, 1º game
   de serviço de cada um e, ao vivo, o game a decorrer) com contas exatas: game → set → partida. Aces e duplas faltas
   ajustam-se às escadas "N ou mais".

   Ao vivo: o motor parte do placar de agora (sets, games, pontos do game, quem serve, histórico dos games, aces) e
   simula só o que falta; as seleções da bet365 contam a partida toda, como a liquidação. */

const M = require('../public/markets.js');
const BB = require('./betbuilder.js'); // escada de odds, margem, regras comuns com o futebol e o basquete
const { fair, minimize, nb, ladderDown, EXTRA, MAX_LEGS, CHECK } = BB.common;

const N = 40000, WN = N >>> 5; // simulações (múltiplo de 32: cada seleção é um mapa de bits)

/* ---------------- números aleatórios fixos ---------------- */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const gauss = (r) => { let u = r(); while (u < 1e-12) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
// gama(r, 1/r) (média 1) — Marsaglia-Tsang
function gamma1(r, rnd) {
  if (r > 400) return 1;
  const a = r < 1 ? r + 1 : r, d = a - 1 / 3, c = 1 / Math.sqrt(9 * d);
  let v;
  for (;;) { let x; do { x = gauss(rnd); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = rnd(); if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) break; }
  let g = d * v;
  if (r < 1) g *= rnd() ** (1 / r);
  return g / r;
}
function poisson(l, rnd) {
  if (l <= 0) return 0;
  if (l > 60) return Math.max(0, Math.round(l + Math.sqrt(l) * gauss(rnd)));
  let k = 0, p = Math.exp(-l), s = p; const u = rnd();
  while (u > s && k < 200) { k++; p *= l / k; s += p; }
  return k;
}
const sig = (x) => 1 / (1 + Math.exp(-x));
const HALF = (v) => Number.isFinite(v) && Math.abs((v * 2) % 2) === 1; // linha .5

/* ---------------- formato da partida ----------------
   need: sets para ganhar (2 = melhor de 3, 3 = melhor de 5); noAd: ponto decisivo no 40-40 e stb: super tie-break
   no lugar do set decisivo (duplas da ATP/WTA, Challenger e ITF) */
function formatOf(m) {
  const five = (m.sels || []).some((s) => (s.market === 'sets' && /3/.test(String(s.pick))) || (s.market === 'tsets' && Number(s.pick) >= 4)) || m.live?.need === 3;
  const dbl = /-duplas$/.test(String(m.league ?? '')) || (/\//.test(String(m.home)) && /\//.test(String(m.away)));
  return { need: five ? 3 : 2, noAd: dbl, stb: dbl && !five };
}

/* ---------------- contas exatas: game, tie-break, set ---------------- */
// quem serve ganha o game, a partir de x-y pontos (x = de quem serve; 0, 1, 2, 3 = 0/15/30/40; 4 = vantagem)
function gameP(p, x, y, noAd) {
  const q = 1 - p, D = noAd ? p : (p * p) / (p * p + q * q);
  if (!x && !y) return p ** 4 * (1 + 4 * q + 10 * q * q) + 20 * p ** 3 * q ** 3 * D; // do 0-0: a zero, a 15, a 30, ou pelo 40-40
  const go = (x, y) => {
    if (x >= 4 && (x - y >= 2 || noAd)) return 1;
    if (y >= 4 && (y - x >= 2 || noAd)) return 0;
    if (x >= 3 && y >= 3) { if (x === y) return D; return x > y ? p + q * D : p * D; }
    return p * go(x + 1, y) + q * go(x, y + 1);
  };
  return go(x, y);
}
// quem serve o ponto n (0, 1, 2...) de um tie-break começado por f: 1 ponto, depois 2 a 2
const tbSrv = (f, n) => ((((n + 1) >> 1) & 1) ? 1 - f : f);
// a casa ganha o tie-break (a T pontos, por 2) começado por f, a partir de i-j; ph/pa = ganhar o ponto ao servir
function tbP(ph, pa, f, i0, j0, T) {
  const w = ph * (1 - pa), l = (1 - ph) * pa, D = w / (w + l); // empatado a partir de T-1: cada par de pontos tem um saque de cada
  const pwAt = (n) => (tbSrv(f, n) === 0 ? ph : 1 - pa);
  if (i0 >= T && i0 - j0 >= 2) return 1;
  if (j0 >= T && j0 - i0 >= 2) return 0;
  if (i0 >= T - 1 && j0 >= T - 1) { if (i0 === j0) return D; const pw = pwAt(i0 + j0); return i0 > j0 ? pw + (1 - pw) * D : pw * D; }
  // até T-1 cada: probabilidade de passar por cada placar; chegar a T ganha, (T-1)-(T-1) é o empate de cima
  const G = new Float64Array(T * T);
  G[i0 * T + j0] = 1;
  let win = 0;
  for (let n = i0 + j0; n <= 2 * T - 3; n++) {
    const pw = pwAt(n);
    for (let i = Math.max(0, n - T + 1); i <= Math.min(n, T - 1); i++) {
      const j = n - i, pr = G[i * T + j];
      if (!pr) continue;
      if (i + 1 === T) win += pr * pw; else G[(i + 1) * T + j] += pr * pw;
      if (j + 1 < T) G[i * T + j + 1] += pr * (1 - pw);
    }
  }
  return win + G[(T - 1) * T + T - 1] * D;
}
// placares finais de um set (casa ganha, depois fora ganha) e do super tie-break ("1-0")
const OUT = [[6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [7, 5], [7, 6]];
for (const [h, a] of OUT.slice()) OUT.push([a, h]);
const OUT_I = new Map(OUT.map(([h, a], i) => [h * 8 + a, i]));
const STB = [[1, 0], [0, 1]];
const setOver = (h, a) => (h >= 6 && h - a >= 2) || (a >= 6 && a - h >= 2) || h === 7 || a === 7;
/* set a partir de gh-ga: probabilidade de cada placar final (ordem de OUT). f = quem serviu o 1º game do set;
   pt = pontos do game a decorrer [casa, fora] (no 6-6: pontos do tie-break) */
function setDist(ph, pa, f, F, gh = 0, ga = 0, pt = null) {
  const out = new Float64Array(OUT.length), G = new Float64Array(64);
  const hH = gameP(ph, 0, 0, F.noAd), hA = gameP(pa, 0, 0, F.noAd);
  G[gh * 8 + ga] = 1;
  for (let k = gh + ga; k <= 12; k++) {
    const s = k % 2 === 0 ? f : 1 - f, x = k === gh + ga && pt ? pt : null;
    for (let h = Math.max(0, k - 6); h <= Math.min(k, 6); h++) {
      const a = k - h, pr = G[h * 8 + a];
      if (!pr) continue;
      const pw = h === 6 && a === 6 ? tbP(ph, pa, s, x ? x[0] : 0, x ? x[1] : 0, 7)
        : s === 0 ? (x ? gameP(ph, x[0], x[1], F.noAd) : hH) : 1 - (x ? gameP(pa, x[1], x[0], F.noAd) : hA);
      if (setOver(h + 1, a)) out[OUT_I.get((h + 1) * 8 + a)] += pr * pw; else G[(h + 1) * 8 + a] += pr * pw;
      if (setOver(h, a + 1)) out[OUT_I.get(h * 8 + a + 1)] += pr * (1 - pw); else G[h * 8 + a + 1] += pr * (1 - pw);
    }
  }
  return out;
}

/* ---------------- partida: todas as sequências de placares dos sets ----------------
   Cada sequência guarda, por set, a posição da probabilidade desse placar numa tabela (TAB_*: set em curso ao vivo,
   set novo com cada um a começar a servir, super tie-break), W posições por sequência (as que sobram: TAB_ONE = 1).
   Antes do jogo não se sabe quem serve primeiro: duas árvores (cada um começa), metade cada. */
const TAB_CUR = 0, TAB_SET = 14, TAB_STB = 42, TAB_ONE = 46;
function buildTree(F, L) {
  const seqs = [], lists = L ? [[]] : [[], []], W = 2 * F.need - 1;
  const won = (sets) => sets.reduce((t, [h, a]) => [t[0] + (h > a), t[1] + (a > h)], [0, 0]);
  const base = L ? L.sets.map(([h, a]) => [h, a]) : [];
  const [h0, a0] = won(base);
  lists.forEach((tree, t) => {
    const rec = (sets, sH, sA, f, steps, first) => {
      if (sH === F.need || sA === F.need) { if (!t) seqs.push(sets); tree.push(steps); return; }
      const stb = F.stb && sH === F.need - 1 && sA === F.need - 1;
      const outs = stb ? STB : OUT;
      for (let j = 0; j < outs.length; j++) {
        const [h, a] = outs[j];
        if (first && !stb && (h < L.cur[0] || a < L.cur[1])) continue;
        const games = stb ? 1 : h + a;
        rec([...sets, [h, a]], sH + (h > a), sA + (a > h), games % 2 ? 1 - f : f, [...steps, first ? TAB_CUR + j : stb ? TAB_STB + 2 * f + j : TAB_SET + 14 * f + j], false);
      }
    };
    rec(base, h0, a0, L ? L.f : t, [], !!L);
  });
  const trees = lists.map((tree) => { const a = new Int16Array(tree.length * W).fill(TAB_ONE); tree.forEach((st, s) => st.forEach((x, k) => { a[s * W + k] = x; })); return a; });
  return { seqs, trees, W };
}
// soma a out[s] a probabilidade de cada sequência com estes (ph, pa), vezes w
const TAB = new Float64Array(TAB_ONE + 1);
function seqProbs(T, ph, pa, F, L, out, w) {
  TAB.fill(0); TAB[TAB_ONE] = 1;
  TAB.set(setDist(ph, pa, 0, F), TAB_SET); TAB.set(setDist(ph, pa, 1, F), TAB_SET + 14);
  if (F.stb) for (let f = 0; f < 2; f++) { const p = tbP(ph, pa, f, 0, 0, 10); TAB[TAB_STB + 2 * f] = p; TAB[TAB_STB + 2 * f + 1] = 1 - p; }
  if (L) {
    if (L.stb) { const p = tbP(ph, pa, L.f, L.pt[0], L.pt[1], 10); TAB[TAB_CUR] = p; TAB[TAB_CUR + 1] = 1 - p; }
    else TAB.set(setDist(ph, pa, L.f, F, L.cur[0], L.cur[1], L.pt), TAB_CUR);
  }
  const wt = w / T.trees.length, W = T.W;
  for (const tree of T.trees) {
    const n = tree.length / W;
    if (W === 3) for (let s = 0, o = 0; s < n; s++, o += 3) out[s] += wt * TAB[tree[o]] * TAB[tree[o + 1]] * TAB[tree[o + 2]];
    else for (let s = 0, o = 0; s < n; s++, o += W) { let p = wt; for (let k = 0; k < W; k++) p *= TAB[tree[o + k]]; out[s] += p; }
  }
}
// a casa ganha o game a decorrer (ao vivo)
function curGameP(ph, pa, F, L) {
  if (L.stb) return tbP(ph, pa, L.f, L.pt[0], L.pt[1], 10);
  if (L.tb) return tbP(ph, pa, L.f, L.pt[0], L.pt[1], 7);
  return L.gsrv === 0 ? gameP(ph, L.pt[0], L.pt[1], F.noAd) : 1 - gameP(pa, L.pt[1], L.pt[0], F.noAd);
}

/* ---------------- que seleções o motor sabe (pela forma) — a bandeira "bb" das seleções do ténis ----------------
   De fora: as de pontos (1º ponto, placar após N pontos, ponto a ponto, break point: liquidadas com os placares
   gravados ao vivo, que às vezes faltam), o vencedor do tie-break e as de tie-break (devolvidas sem tie-break). */
const MATCH = new Set(['ml', 'sets', 'tsets', 'tstraight', 'tdist', 'tpto', 'tdr', 'tcast', 'gtotal', 'gspread', 'tmrt', 'tpgw', 'toe', 'ttb']);
const SETK = new Set(['tsw', 'tscs', 'tscg', 'tsca', 'tsgt', 'tsgh']);
const ORDERK = new Set(['tslead', 'tsafter', 'tsrace']);
const GAMEK = new Set(['tgw', 'tgs', 'tgd', 'tgsw', 'tgtp']);
const FSRV = new Set(['tfswin', 'tfsg', 'tfsw', 'tfsd', 'tfstp']);
const LINES = new Set(['gtotal', 'gspread', 'tmrt', 'tpgw', 'ttb', 'tbrk', 'tpbrk', 'tsgt', 'tsgh', 'tsbt']);
const KNOWN = new Set([...MATCH, ...SETK, ...ORDERK, ...GAMEK, ...FSRV, 'tsbrk', 'tsbt', 'tgpw', 'tgpd', 'tfbrk', 'tpbrk', 'tbrk', 'tace', 'tdf']);
function supports(l) {
  const k = l.market;
  if (!KNOWN.has(k) || l.pick == null) return false;
  if (LINES.has(k)) return HALF(l.line);
  if (k === 'tace' || k === 'tdf') return l.line > 0;
  return true;
}

/* ---------------- ajuste do jogo ----------------
   P = { a, b (logit de ganhar o ponto a servir: casa, fora), s (forma do dia: desvio, a favor de um e contra o outro),
         t (dia de saques: desvio, para os dois) }. Contas com 5 × 3 nós de Gauss-Hermite. */
const GH5 = [[-2.856970, 0.011257], [-1.355626, 0.222076], [0, 0.533333], [1.355626, 0.222076], [2.856970, 0.011257]];
const GH3 = [[-1.732051, 1 / 6], [0, 2 / 3], [1.732051, 1 / 6]];
const PRIOR = 0.002;
// mercado completo para tirar a margem (as seleções que somam 100%): chave e nº de seleções (0 = várias: as que há,
// se somam perto de 100% — ao vivo o placar em sets só traz os placares ainda possíveis)
function setKey(s, F, L) {
  const k = s.market, per = s.per ?? '';
  switch (k) {
    case 'ml': return ['ml', 2];
    case 'sets': return ['sets', 0];
    case 'tsets': return ['tsets', 0];
    case 'tstraight': return ['tstraight', 2];
    case 'gtotal': case 'ttb': case 'tpgw': case 'tsgt': return HALF(s.line) ? [`${k}|${per}|${s.line}`, 2] : null;
    case 'gspread': case 'tsgh': return HALF(s.line) ? [`${k}|${per}|${s.pick === 'home' ? s.line : -s.line}`, 2] : null;
    case 'tsw': return [`tsw|${per}`, 2];
    case 'tscs': return [`tscs|${per}`, 0];
    case 'tmrt': return HALF(s.line) ? [`tmrt|${s.line}`, 4] : null;
    case 'tfswin': return L ? null : [`tfswin|${per}`, 2];
    case 'tgw': return L && per === `${L.sets.length + 1}/${L.cur[0] + L.cur[1] + 1}` ? [`tgw|${per}`, 2] : null; // o game a decorrer
  }
  return null;
}
const FIT_W = { ml: 4, sets: 3, gtotal: 3, gspread: 3, tsw: 2, tfswin: 2, tgw: 3 };
function fitGame(m, F, L, T) {
  const groups = {};
  for (const s of m.sels) {
    if (s.locked || !(s.odds > 1)) continue;
    const key = setKey(s, F, L); if (!key) continue;
    (groups[key[0]] ||= { n: key[1], list: [] }).list.push(s);
  }
  const TG = [];
  for (const { n, list } of Object.values(groups)) {
    const inv = list.reduce((t, s) => t + 1 / s.odds, 0);
    if (n ? list.length !== n : list.length < 2 || !(inv > 1 && inv < 1.45)) continue; // placares em falta: a soma não chega a 100%
    const P = fair(list.map((s) => s.odds));
    const k = list[0].market, w = (FIT_W[k] || 1) / list.length;
    list.forEach((s, i) => {
      const leg = { market: s.market, per: s.per, pick: s.pick, line: s.line };
      if (k === 'tfswin' || k === 'tgw') { TG.push({ w, pt: P[i], kind: k, side: String(s.per), pick: s.pick }); return; }
      const idx = [];
      for (let j = 0; j < T.seqs.length; j++) {
        const sets = T.seqs[j], h = sets.filter(([x, y]) => x > y).length, r = M.legOutcome(leg, { h, a: sets.length - h, sets });
        if (r !== 1 && r !== -1) return; // pode ser devolvida (set que pode não se jogar): não serve para o ajuste
        if (r === 1) idx.push(j);
      }
      TG.push({ w, pt: P[i], idx: Int32Array.from(idx) });
    });
  }
  if (!TG.some((t) => t.w >= 1)) return null; // sem vencedor nem placar em sets: não há jogo para ajustar
  const needHold = TG.some((t) => t.kind === 'tfswin'), needCur = TG.some((t) => t.kind === 'tgw');
  const sp = new Float64Array(T.seqs.length);
  const err = (p) => {
    const [a, b, s, t] = p;
    let e = PRIOR * (((s - 0.3) / 0.3) ** 2 + ((t - 0.15) / 0.3) ** 2);
    sp.fill(0);
    let hH = 0, hA = 0, cg = 0;
    for (const [x1, w1] of GH5) for (const [x2, w2] of GH3) {
      const ph = sig(a + s * x1 + t * x2), pa = sig(b - s * x1 + t * x2), w = w1 * w2;
      seqProbs(T, ph, pa, F, L, sp, w);
      if (needHold) { hH += w * gameP(ph, 0, 0, F.noAd); hA += w * gameP(pa, 0, 0, F.noAd); }
      if (needCur) cg += w * curGameP(ph, pa, F, L);
    }
    for (const g of TG) {
      let v = 0;
      if (g.idx) for (let i = 0; i < g.idx.length; i++) v += sp[g.idx[i]];
      else if (g.kind === 'tfswin') v = g.side === 'home' ? (g.pick === 'home' ? hH : 1 - hH) : (g.pick === 'away' ? hA : 1 - hA);
      else v = g.pick === 'home' ? cg : 1 - cg;
      e += g.w * (v - g.pt) ** 2;
    }
    return e;
  };
  const r = minimize(err, [0.45, 0.45, 0.3, 0.15], [0.3, 0.3, 0.15, 0.1], [-1.5, -1.5, 0, 0], [3.5, 3.5, 1.2, 0.8], 60);
  return { a: r.p[0], b: r.p[1], s: r.p[2], t: r.p[3], fitErr: r.e };
}

/* ---------------- simulação ponto a ponto ----------------
   Por simulação: cada game (vencedor, quem servia — 2 = tie-break —, pontos de quem perdeu: 0/15/30/40), placar de
   cada set, placar dos tie-breaks e pontos servidos por cada um (para os aces). Ao vivo começa com o que já se jogou. */
const LPV = [0, 15, 30, 40];
function simulate(P, F, L) {
  const MG = F.need === 3 ? 66 : 40, NS = 2 * F.need - 1;
  const S = { MG, gw: new Uint8Array(N * MG), gsv: new Uint8Array(N * MG), glp: new Uint8Array(N * MG), ng: new Uint8Array(N),
    ss: new Uint8Array(N * 2 * NS), ns: new Uint8Array(N), sst: new Uint8Array(N * (NS + 1)), tbs: new Uint8Array(N * 2 * NS), svc: new Uint16Array(N * 2), NS };
  const { gw, gsv, glp, ss, tbs, svc, sst } = S;
  // o que já se jogou (ao vivo): sets acabados e games do set em curso
  const pre = [];
  if (L) for (const e of L.log) pre.push([e.w === 'home' ? 0 : 1, e.tb ? 2 : e.srv === 'home' ? 0 : 1, e.tb ? 0 : LPV.indexOf(e.lp), e.s, e.tbScore]);
  for (let i = 0; i < N; i++) {
    const r = rng(Math.imul(i + 1, 2654435761) ^ 0x7e1115);
    const z1 = gauss(r), z2 = gauss(r);
    const ph = sig(P.a + P.s * z1 + P.t * z2), pa = sig(P.b - P.s * z1 + P.t * z2);
    const B = i * MG, B2 = i * 2 * NS, BS = i * (NS + 1);
    let k = 0, gh = 0, ga = 0, sH = 0, sA = 0, g = 0, srv, cur = null, sv0 = 0, sv1 = 0;
    if (L) {
      for (const [h, a] of L.sets) { ss[B2 + 2 * k] = h; ss[B2 + 2 * k + 1] = a; if (h > a) sH++; else sA++; k++; }
      let s0 = 0;
      for (const [w, sv, lp, s, tb] of pre) {
        while (s0 < s) sst[BS + s0++] = g; // início de cada set
        gw[B + g] = w; gsv[B + g] = sv; glp[B + g] = lp;
        if (tb) { tbs[B2 + 2 * (s - 1)] = tb[0]; tbs[B2 + 2 * (s - 1) + 1] = tb[1]; }
        g++;
      }
      while (s0 <= k) sst[BS + s0++] = g;
      gh = L.cur[0]; ga = L.cur[1]; srv = L.gsrv; cur = L.pt;
    } else { srv = r() < 0.5 ? 0 : 1; sst[BS] = 0; }
    for (;;) {
      const stb = F.stb && sH === F.need - 1 && sA === F.need - 1;
      if (stb || (gh === 6 && ga === 6)) { // tie-break: srv = quem serve o 1º ponto
        const T = stb ? 10 : 7;
        let x = cur ? cur[0] : 0, y = cur ? cur[1] : 0; cur = null;
        for (let n = x + y; ; n++) {
          if (tbSrv(srv, n) === 0) { sv0++; if (r() < ph) x++; else y++; } else { sv1++; if (r() < pa) y++; else x++; }
          if ((x >= T || y >= T) && Math.abs(x - y) >= 2) break;
        }
        const w = x > y ? 0 : 1;
        gw[B + g] = w; gsv[B + g] = 2; glp[B + g] = 0; tbs[B2 + 2 * k] = x; tbs[B2 + 2 * k + 1] = y; g++;
        if (stb) { gh = 1 - w; ga = w; } else if (w) ga++; else gh++;
        srv = 1 - srv; // o tie-break conta como um game: no set seguinte serve primeiro quem recebeu primeiro
      } else {
        const p = srv === 0 ? ph : pa;
        let x = 0, y = 0; // x = pontos de quem serve
        if (cur) { x = srv === 0 ? cur[0] : cur[1]; y = srv === 0 ? cur[1] : cur[0]; cur = null; }
        const noAd = F.noAd;
        let n = 0;
        for (;;) {
          n++;
          if (r() < p) x++; else y++;
          if ((x >= 4 && (x - y >= 2 || noAd)) || (y >= 4 && (y - x >= 2 || noAd))) break;
        }
        if (srv) sv1 += n; else sv0 += n;
        const w = x > y ? srv : 1 - srv;
        gw[B + g] = w; gsv[B + g] = srv; glp[B + g] = Math.min(3, x > y ? y : x); g++;
        if (w) ga++; else gh++;
        srv = 1 - srv;
        if (!setOver(gh, ga)) continue;
      }
      ss[B2 + 2 * k] = gh; ss[B2 + 2 * k + 1] = ga;
      if (gh > ga) sH++; else sA++;
      k++; gh = ga = 0;
      sst[BS + k] = g;
      if (sH === F.need || sA === F.need) break;
    }
    S.ns[i] = k; S.ng[i] = g; svc[2 * i] = sv0; svc[2 * i + 1] = sv1;
  }
  return S;
}

/* ---------------- aces e duplas faltas ----------------
   Por jogador: total na partida ~ Poisson(média × pontos servidos / média dos pontos servidos × fator do dia), fator
   do dia gama (média 1). Ajuste à escada "N ou mais" (sem margem: 1/odd/PLM); só a partida toda ("Match" = os dois somados).
   Ao vivo: a escada conta a partida toda → ajusta-se ao que falta (N − o que já fez) com os pontos que faltam servir. */
const PLM = 1.07;
const tailNB = (n, mu, r) => { if (n <= 0) return 1; let s = 0; for (let i = 0; i < n; i++) s += nb(i, mu, r); return Math.max(0, 1 - s); };
const SIDES = ['home', 'away'];
function fitServe(m, S, L) {
  const mean = [0, 1].map((j) => { let t = 0; for (let i = 0; i < N; i++) t += S.svc[2 * i + j]; return t / N || 1; });
  const cv2 = [0, 1].map((j) => { let t = 0; for (let i = 0; i < N; i++) t += (S.svc[2 * i + j] - mean[j]) ** 2; return t / N / mean[j] ** 2; });
  const out = {};
  for (const [k, st] of [['tace', 'ace'], ['tdf', 'df']]) {
    const base = L ? (st === 'ace' ? L.aces : L.dfs) || [0, 0] : [0, 0];
    const rungs = { home: {}, away: {}, all: {} };
    for (const s of m.sels) {
      if (s.market !== k || s.locked || !(s.odds > 1) || !rungs[s.per]) continue;
      const need = s.line - (s.per === 'all' ? base[0] + base[1] : base[s.per === 'home' ? 0 : 1]);
      if (need <= 0) continue; // já aconteceu
      rungs[s.per][need] = Math.min(0.985, 1 / s.odds / PLM);
    }
    const fit = {};
    for (const [who, o] of Object.entries(rungs)) {
      const R = Object.entries(o).map(([n, p]) => [+n, p]).sort((x, y) => x[0] - y[0]);
      if (!R.length) continue;
      const top = Math.max(3, R[R.length - 1][0] * 2);
      const err = ([mu, lr]) => R.reduce((e, [n, pt]) => e + (tailNB(n, mu, Math.exp(lr)) - pt) ** 2, 0);
      const f = R.length === 1
        ? minimize(([mu]) => err([mu, Math.log(8)]), [R[0][0]], [top / 6], [0.02], [top * 2], 150).p.concat(Math.log(8))
        : minimize(err, [R[0][0] + 0.5, Math.log(8)], [top / 6, 0.5], [0.02, Math.log(0.8)], [top * 2, Math.log(400)], 200).p;
      fit[who] = { mu: f[0], r: Math.exp(f[1]) };
    }
    if (!fit.home && !fit.away && !fit.all) continue;
    // um jogador sem escada: o resto do total; só o total: dividido pelos pontos servidos
    if (fit.all) for (const [j, who] of SIDES.entries()) {
      const o = SIDES[1 - j];
      if (!fit[who]) fit[who] = fit[o] ? { mu: Math.max(0.05, fit.all.mu - fit[o].mu), r: fit.all.r } : { mu: fit.all.mu * mean[j] / (mean[0] + mean[1]), r: fit.all.r };
    }
    if (!fit.home || !fit.away) continue;
    // a variação dos pontos servidos já espalha o total: o fator do dia leva só o resto
    const rg = (r, c) => 1 / Math.max(0.0025, (1 / r - c) / (1 + c));
    out[st] = { base, mean, sides: [0, 1].map((j) => ({ mu: fit[SIDES[j]].mu, rg: rg(fit[SIDES[j]].r, cv2[j]) })) };
  }
  return out;
}
function genServe(S, A) {
  for (const st of ['ace', 'df']) {
    const X = A?.[st];
    if (!X) { S[st] = null; continue; }
    const v = new Uint16Array(N * 2);
    for (let i = 0; i < N; i++) {
      const rnd = rng(Math.imul(i + 1, 2246822519) ^ hash(st));
      for (let j = 0; j < 2; j++) {
        const d = X.sides[j];
        v[2 * i + j] = X.base[j] + poisson(d.mu * (S.svc[2 * i + j] / X.mean[j]) * gamma1(d.rg, rnd), rnd);
      }
    }
    S[st] = v;
  }
}

/* ---------------- uma simulação no formato da liquidação (markets.js) ---------------- */
function fullR(E, i, light) {
  const S = E.S, B2 = i * 2 * S.NS, BS = i * (S.NS + 1), B = i * S.MG, sets = [];
  let h = 0;
  for (let k = 0; k < S.ns[i]; k++) { const x = [S.ss[B2 + 2 * k], S.ss[B2 + 2 * k + 1]]; sets.push(x); if (x[0] > x[1]) h++; }
  const R = { h, a: sets.length - h, sets };
  if (light) return R;
  const log = [];
  for (let k = 0; k < S.ns[i]; k++) {
    for (let g = S.sst[BS + k]; g < S.sst[BS + k + 1]; g++) {
      const e = { s: k + 1, g: g - S.sst[BS + k] + 1, w: S.gw[B + g] ? 'away' : 'home' };
      if (S.gsv[B + g] === 2) { e.tb = true; e.tbScore = [S.tbs[B2 + 2 * k], S.tbs[B2 + 2 * k + 1]]; }
      else { e.srv = S.gsv[B + g] ? 'away' : 'home'; e.lp = LPV[S.glp[B + g]]; }
      log.push(e);
    }
  }
  R.log = log;
  if (S.ace) R.aces = [S.ace[2 * i], S.ace[2 * i + 1]];
  if (S.df) R.dfs = [S.df[2 * i], S.df[2 * i + 1]];
  return R;
}

/* ---------------- seleção → mapa de bits das simulações em que ganha ----------------
   Cada mercado depende só de uma parte da simulação (o placar do set 2, o game 5 do 1º set, as quebras de um jogador...):
   as simulações agrupam-se por essa parte e a regra da liquidação decide-se uma vez por grupo, numa simulação do grupo. */
function projOf(spec) {
  const k = spec.market, [a, b] = String(spec.per ?? '').split(/[:/]/), sN = Number(a), gN = Number(b);
  const setAt = (S, i, s) => (s >= 1 && s <= S.ns[i] ? i * 2 * S.NS + 2 * (s - 1) : -1);
  const range = (S, i, s) => [S.sst[i * (S.NS + 1) + s - 1], S.sst[i * (S.NS + 1) + s]];
  const brk = (S, x) => S.gsv[x] !== 2 && S.gw[x] !== S.gsv[x];
  // um game: -2 sem o set, -1 sem o game; senão vencedor, quem servia e pontos de quem perdeu
  const game = (S, i, s, n) => { if (setAt(S, i, s) < 0) return -2; const [g0, g1] = range(S, i, s); if (n < 1 || n > g1 - g0) return -1; const x = i * S.MG + g0 + n - 1; return S.gw[x] | (S.gsv[x] << 1) | (S.glp[x] << 3); };
  if (MATCH.has(k)) return ['m', true, (S, i) => { let v = 0; for (let s = S.ns[i]; s >= 1; s--) { const x = setAt(S, i, s); v = v * 65 + S.ss[x] * 8 + S.ss[x + 1] + 1; } return v; }];
  if (SETK.has(k)) return [`s${a}`, true, (S, i) => { const x = setAt(S, i, sN); return x < 0 ? 0 : 1 + S.ss[x] * 8 + S.ss[x + 1]; }];
  if (ORDERK.has(k)) { // vencedores dos primeiros games do set (a corrida a N decide-se em 2N−1 games) e quantos games teve
    const n = k === 'tsrace' ? 2 * gN - 1 : gN;
    return [`${k === 'tsrace' ? 'r' : 'q'}${spec.per}`, false, (S, i) => { if (setAt(S, i, sN) < 0) return -1; const [g0, g1] = range(S, i, sN); let v = Math.min(g1 - g0, n); for (let g = g0; g < Math.min(g1, g0 + n); g++) v = v * 2 + S.gw[i * S.MG + g]; return v * 16 + Math.min(g1 - g0, 15); }];
  }
  if (k === 'tsbrk' || k === 'tsbt') return [`b${a}`, false, (S, i) => { if (setAt(S, i, sN) < 0) return -1; const [g0, g1] = range(S, i, sN); let bh = 0, ba = 0; for (let g = g0; g < g1; g++) { const x = i * S.MG + g; if (brk(S, x)) { if (S.gw[x]) ba++; else bh++; } } return bh * 64 + ba; }];
  if (GAMEK.has(k)) return [`g${a}/${b}`, false, (S, i) => game(S, i, sN, gN)];
  if (k === 'tgpw' || k === 'tgpd') return [`G${a}/${b}`, false, (S, i) => (game(S, i, sN, gN) + 2) * 1024 + game(S, i, sN, gN + 1) + 2];
  if (FSRV.has(k)) { const sv = a === 'home' ? 0 : 1; return [`f${a}`, false, (S, i) => { for (let g = 0; g < S.ng[i]; g++) { const x = i * S.MG + g; if (S.gsv[x] === sv) return S.gw[x] | (S.glp[x] << 1); } return -1; }]; }
  if (k === 'tfbrk') return ['fb', false, (S, i) => { for (let g = 0; g < S.ng[i]; g++) { const x = i * S.MG + g; if (brk(S, x)) return S.gw[x]; } return -1; }];
  if (k === 'tpbrk' || k === 'tbrk') {
    const side = k === 'tbrk' ? -1 : a === 'home' ? 0 : 1, si = k === 'tbrk' ? 0 : Number(b) || 0;
    return [`p${k}${spec.per ?? ''}`, false, (S, i) => {
      if (si && setAt(S, i, si) < 0) return -1;
      const [g0, g1] = si ? range(S, i, si) : [0, S.ng[i]];
      let c = 0; for (let g = g0; g < g1; g++) { const x = i * S.MG + g; if (brk(S, x) && (side < 0 || S.gw[x] === side)) c++; }
      return c;
    }];
  }
  if (k === 'tace' || k === 'tdf') {
    const st = k === 'tace' ? 'ace' : 'df', j = a === 'away' ? 1 : 0;
    return [`${st}${a}`, false, (S, i) => (a === 'all' ? S[st][2 * i] + S[st][2 * i + 1] : S[st][2 * i + j])];
  }
  return null;
}
// grupos de uma parte da simulação: idx[i] = grupo da simulação i; reps = uma simulação de cada grupo
function uniq(E, pj) {
  const c = (E.U ||= {});
  if (c[pj[0]]) return c[pj[0]];
  const idx = new Int32Array(N), map = new Map(), reps = [];
  for (let i = 0; i < N; i++) {
    const v = pj[2](E.S, i);
    let j = map.get(v); if (j === undefined) { j = reps.length; map.set(v, j); reps.push(i); }
    idx[i] = j;
  }
  return (c[pj[0]] = { idx, reps, R: new Array(reps.length) });
}
const popcnt = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
function count(b) { let t = 0; for (let i = 0; i < WN; i++) t += popcnt(b[i]); return t; }
function andCount(a, b) { let t = 0; for (let i = 0; i < WN; i++) t += popcnt(a[i] & b[i]); return t; }
function andInto(a, b) { const o = new Uint32Array(WN); for (let i = 0; i < WN; i++) o[i] = a[i] & b[i]; return o; }
const specKey = (l) => `${l.market}|${l.per ?? ''}|${l.pick}|${l.line ?? ''}`;
const legOfSpec = (l) => ({ market: l.market, per: l.per, pick: l.pick, line: l.line });
// null = o motor não a sabe (ou pode ser devolvida: set que pode não se jogar, partida sem quebras...)
function bitsOf(E, spec) {
  const c = (E.B ||= new Map()), key = specKey(spec);
  if (c.has(key)) return c.get(key);
  let b = null;
  try { b = bitsRaw(E, spec); } catch { b = null; }
  c.set(key, b);
  return b;
}
function bitsRaw(E, spec) {
  if (!supports(spec)) return null;
  if ((spec.market === 'tace' && !E.S.ace) || (spec.market === 'tdf' && !E.S.df)) return null;
  const pj = projOf(spec);
  if (!pj) return null;
  const U = uniq(E, pj), leg = legOfSpec(spec), out = new Int8Array(U.reps.length);
  for (let j = 0; j < U.reps.length; j++) {
    const R = U.R[j] || (U.R[j] = fullR(E, U.reps[j], pj[1]));
    const r = M.legOutcome(leg, R);
    if (r !== 1 && r !== -1) return null; // devolvida ou desconhecida numa simulação possível: fora do Criar aposta
    out[j] = r;
  }
  const b = new Uint32Array(WN);
  for (let i = 0; i < N; i++) if (out[U.idx[i]] === 1) b[i >>> 5] |= 1 << (i & 31);
  return b;
}
// probabilidade de um grupo de seleções (mapas de bits)
function jointBits(list) {
  if (!list.length) return 1;
  if (list.length === 1) return count(list[0]) / N;
  let acc = list[0];
  for (let k = 1; k < list.length - 1; k++) acc = andInto(acc, list[k]);
  return andCount(acc, list[list.length - 1]) / N;
}

/* ---------------- preço no site (como no basquete) ----------------
   odd = R / p / EXTRA: p = probabilidade da combinação no modelo, R = a margem que a bet365 já põe em cada seleção
   (odd mostrada × probabilidade do modelo, no máximo 0.97), multiplicadas, e a nossa margem extra (+3%); arredonda-se
   para baixo na escada de odds. */
const R_MAX = 0.97;
const rOf = (p1, odds) => Math.min(R_MAX, odds * p1);
const priceOf = (p, R) => ladderDown(R / p / EXTRA);
const prodR = (rs, mask) => rs.reduce((t, r, i) => ((mask >> i) & 1 ? t * r : t), 1);
// a mesma seleção em linhas diferentes (total de games 21.5 e 22.5...) conta como o mesmo mercado
const mkOf = (l) => `${l.market}|${l.per ?? ''}`;
// juntar uma seleção nunca baixa a odd: a combinação paga pelo menos o que paga qualquer parte dela
function floorOdds(bits, singles, rs) {
  const n = bits.length, full = (1 << n) - 1;
  let best = Math.max(...singles);
  for (let mask = 1; mask < full; mask++) {
    if ((mask & (mask - 1)) === 0) continue;
    const p = jointBits(bits.filter((_, i) => (mask >> i) & 1));
    if (p >= 1e-4) best = Math.max(best, priceOf(p, prodR(rs, mask)));
  }
  return best;
}
// seleção (spec) → { b, p1, mk } se entra; null se não
function legFor(E, spec) {
  const c = (E.lf ||= new Map()), key = specKey(spec);
  if (c.has(key)) return c.get(key);
  const b = bitsOf(E, spec);
  let r = null;
  if (b) {
    const p1 = count(b) / N;
    if (p1 > 0.002 && p1 < 0.995) r = { b, p1, mk: mkOf(spec) };
  }
  c.set(key, r);
  return r;
}
// o modelo e a odd mostrada não concordam: a seleção fica de fora (por baixo aceita-se mais: margem das zebras)
const offCheck = (p1, odds) => { const r = odds * p1; return r < 0.4 || Math.log(r) > Math.log(1 + CHECK) + 0.15; };

/* preço de uma combinação: items [{ q (spec da seleção), odds (mostrada), name, key }] → { odds, p, params } ou { reason } */
function quote(E, items) {
  if (items.length < 2) return { reason: 'escolha pelo menos 2 seleções' };
  if (items.length > MAX_LEGS) return { reason: `máximo de ${MAX_LEGS} seleções por jogo` };
  const legs = [];
  for (const it of items) {
    const l = it.q && legFor(E, it.q);
    if (!l || offCheck(l.p1, it.odds)) return { reason: `"${it.name}" não entra no Criar aposta`, bad: it.key };
    const twin = legs.findIndex((x) => x.mk === l.mk);
    if (twin >= 0) return { reason: `"${items[twin].name}" e "${it.name}" são do mesmo mercado`, bad: it.key };
    legs.push(l);
  }
  const bits = legs.map((l) => l.b), p = jointBits(bits);
  if (p < 1e-4) return { reason: 'estas seleções não podem acontecer juntas' };
  for (let i = 0; i < legs.length; i++) {
    const rest = jointBits(bits.filter((_, j) => j !== i));
    if (p >= rest * 0.999) return { reason: `"${items[i].name}" já está incluída nas outras seleções`, bad: items[i].key };
  }
  const rs = legs.map((l, i) => rOf(l.p1, items[i].odds));
  const odds = Math.max(priceOf(p, prodR(rs, (1 << legs.length) - 1)), floorOdds(bits, items.map((it) => it.odds), rs));
  if (odds < 1.02) return { reason: 'odd demasiado baixa para esta combinação' };
  return { odds, p, params: paramsOf(E) };
}
/* aba Criar aposta: com as escolhidas (items), a odd de juntar cada candidata → { key: odd } (0 = não junta) */
function preview(E, items, cands) {
  const legs = [];
  for (const it of items) { const l = it.q && legFor(E, it.q); if (!l) return null; legs.push(l); }
  const n = legs.length, full = (1 << n) - 1;
  const AND = new Array(full + 1);
  AND[0] = null;
  for (let mask = 1; mask <= full; mask++) { const i = 31 - Math.clz32(mask), rest = mask ^ (1 << i); AND[mask] = rest ? andInto(AND[rest], legs[i].b) : legs[i].b; }
  const pOf = (mask) => (mask ? count(AND[mask]) / N : 1);
  const rs = legs.map((l, i) => rOf(l.p1, items[i].odds));
  const base = n ? pOf(full) : 1;
  let floorBase = 0;
  if (n === 1) floorBase = items[0].odds;
  else if (n > 1) { floorBase = Math.max(priceOf(base, prodR(rs, full)), ...items.map((it) => it.odds)); for (let mask = 1; mask < full; mask++) if (mask & (mask - 1)) { const pt = pOf(mask); if (pt >= 1e-4) floorBase = Math.max(floorBase, priceOf(pt, prodR(rs, mask))); } }
  const out = {};
  for (const c of cands) {
    out[c.key] = 0;
    if (n >= MAX_LEGS) continue;
    const l = c.q && legFor(E, c.q);
    if (!l || legs.some((x) => x.mk === l.mk) || offCheck(l.p1, c.odds)) continue;
    const pm = new Array(full + 1);
    for (let mask = 0; mask <= full; mask++) pm[mask] = mask ? andCount(AND[mask], l.b) / N : l.p1;
    const p = pm[full];
    if (p < 1e-4 || (n && p >= base * 0.999)) continue; // impossível, ou já garantida pelas escolhidas
    if (legs.some((_, i) => { const r = pm[full ^ (1 << i)]; return p >= r * 0.999; })) continue; // ou torna uma escolhida redundante
    const rc = rOf(l.p1, c.odds);
    let odds = Math.max(priceOf(p, prodR(rs, full) * rc), floorBase, c.odds);
    for (let mask = 1; mask < full; mask++) if (pm[mask] >= 1e-4) odds = Math.max(odds, priceOf(pm[mask], prodR(rs, mask) * rc));
    if (odds >= 1.02) out[c.key] = odds;
  }
  return out;
}

/* ---------------- montar, guardar, refazer ----------------
   Na aposta (e no navegador) ficam os números do jogo, dos aces e, ao vivo, o placar de partida. Sets como { h, a }:
   o Firestore não guarda listas dentro de listas. */
function paramsOf(E) {
  const L = E.live && { ...E.live, sets: E.live.sets.map(([h, a]) => ({ h, a })) };
  return { sport: 'tennis', home: E.home, away: E.away, F: E.F, P: E.P, A: E.A, ...(L ? { live: L } : {}) };
}
function fromParams(X) {
  const L = X.live ? { ...X.live, sets: (X.live.sets || []).map((x) => (Array.isArray(x) ? x : [x.h, x.a])) } : null;
  const S = simulate(X.P, X.F, L);
  genServe(S, X.A);
  return { home: X.home, away: X.away, F: X.F, P: X.P, A: X.A || {}, live: L, S };
}
const LIVE_FIT_MAX = 0.02;
function build(m) {
  const F = formatOf(m), L = m.live || null;
  if (L && L.stb && !F.stb) return null;
  const T = buildTree(F, L);
  const P = fitGame(m, F, L, T);
  // ao vivo, um ajuste mau quer dizer odds e placar de momentos diferentes (ex.: o game acabou e as odds ainda não mudaram)
  if (!P || (L && P.fitErr > LIVE_FIT_MAX)) return null;
  const S = simulate(P, F, L);
  const A = fitServe(m, S, L);
  genServe(S, A);
  const E = { home: m.home, away: m.away, F, P, A, live: L, S };
  E.m = m;
  return E;
}
const modelOf = (E) => ({ v: E.v, ...paramsOf(E) });
const srcOf = (l) => legOfSpec(l);
/* aposta com seleções anuladas: nova odd com as que ficaram (mesmos números do momento da aposta) */
function requote(params, kept) {
  if (!kept.length) return 1;
  if (kept.length === 1) return kept[0].odds;
  const E = fromParams(params);
  const bits = kept.map((k) => bitsOf(E, k.src));
  if (bits.some((b) => !b)) return kept.reduce((t, k) => t * k.odds, 1);
  const p = jointBits(bits);
  if (!p) return 1;
  const rs = bits.map((b, i) => rOf(count(b) / N, kept[i].odds));
  return Math.max(1, priceOf(p, prodR(rs, (1 << bits.length) - 1)), floorOdds(bits, kept.map((k) => k.odds), rs));
}

/* ---------------- ao vivo: o placar de agora (estatísticas da MoviOdds) ----------------
   st = { current_set, home: { sets: [games por set, incl. o atual], point, serving, aces, double_faults }, away, summary }.
   summary: uma linha por game acabado ("Game 7 - Nome - holds to 30" / "Set 1 tie break score 7-4").
   → { sets: [[c, f] acabados], cur: [games do set atual], pt: [pontos do game: 0..4, no tie-break 0, 1, 2...], tb, stb,
       gsrv (quem serve o game atual; no tie-break: quem serviu o 1º ponto), f (quem serviu o 1º game do set atual),
       log (games acabados, no formato da liquidação), aces, dfs, need, won: [sets ganhos] }
   null quando os dados não batem certo (histórico atrasado, sem quem serve...). */
const PT = { 0: 0, 15: 1, 30: 2, 40: 3, A: 4 };
function liveFromStats(st, home, away) {
  const H = st?.home, A = st?.away;
  if (!H || !A || !Array.isArray(H.sets) || !Array.isArray(A.sets) || H.sets.length !== A.sets.length || !H.sets.length) return null;
  const need = /best_of_5/.test(String(st.format ?? '')) ? 3 : 2;
  const dbl = /\//.test(String(home)) && /\//.test(String(away));
  const all = H.sets.map((h, i) => [Number(h), Number(A.sets[i])]);
  if (all.some(([h, a]) => !Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0)) return null;
  const gsrvNow = H.serving ? 0 : A.serving ? 1 : null;
  if (gsrvNow == null) return null;
  // sets acabados: todos menos o último; o último também, se já tem placar final (o set seguinte ainda não começou)
  const won = (sets) => sets.reduce((t, [h, a]) => [t[0] + (h > a), t[1] + (a > h)], [0, 0]);
  let sets = all.slice(0, -1), cur = all[all.length - 1];
  const stbNow = (s) => dbl && need === 2 && won(s)[0] === 1 && won(s)[1] === 1;
  const lastDone = stbNow(sets) ? Math.max(...cur) === 1 && Math.min(...cur) === 0 : setOver(cur[0], cur[1]);
  if (lastDone) { sets = all; cur = [0, 0]; }
  const [wh, wa] = won(sets);
  if (wh >= need || wa >= need) return null; // partida acabada
  if (sets.some(([h, a], i) => !(stbNow(sets.slice(0, i)) ? Math.max(h, a) === 1 && Math.min(h, a) === 0 : setOver(h, a)))) return null;
  const stb = stbNow(sets), tb = !stb && cur[0] === 6 && cur[1] === 6;
  if (stb && (cur[0] || cur[1])) return null;
  // pontos do game a decorrer
  const hp = String(H.point ?? ''), ap = String(A.point ?? '');
  let pt;
  if (stb || tb) { pt = [Number(hp), Number(ap)]; if (!pt.every((x) => Number.isInteger(x) && x >= 0)) return null; }
  else { pt = [PT[hp], PT[ap]]; if (pt.some((x) => x == null) || (pt[0] === 4 && pt[1] !== 3) || (pt[1] === 4 && pt[0] !== 3)) return null; }
  // histórico: os games acabados têm de bater certo com o placar (número e vencedores de cada set)
  const sum = Array.isArray(st.summary) ? st.summary : null;
  const per = [...sets, cur];
  if (!sum || sum.length !== per.reduce((t, [h, a]) => t + h + a, 0)) return null;
  const who = (n) => (n === home ? 'home' : n === away ? 'away' : null);
  const log = [];
  let i = 0;
  for (let s = 0; s < per.length; s++) {
    const n = per[s][0] + per[s][1], wins = [0, 0];
    for (let g = 1; g <= n; g++, i++) {
      const line = String(sum[i]).trim();
      const t = /^Set (\d+) tie break score (\d+)-(\d+)$/i.exec(line);
      let e;
      if (t) {
        const x = Number(t[2]), y = Number(t[3]);
        if (Number(t[1]) !== s + 1 || g !== n || x === y) return null;
        e = { s: s + 1, g, w: x > y ? 'home' : 'away', tb: true, tbScore: [x, y] };
      } else {
        const mm = /^Game (\d+) - (.+?) - (holds|breaks) to (love|15|30|40)$/i.exec(line);
        if (!mm || Number(mm[1]) !== i + 1) return null;
        const w = who(mm[2]);
        if (!w) return null;
        e = { s: s + 1, g, w, srv: /^holds$/i.test(mm[3]) ? w : w === 'home' ? 'away' : 'home', lp: mm[4].toLowerCase() === 'love' ? 0 : Number(mm[4]) };
      }
      wins[e.w === 'home' ? 0 : 1]++;
      log.push(e);
    }
    if (wins[0] !== per[s][0] || wins[1] !== per[s][1]) return null;
  }
  // quem serve: no tie-break muda de 2 em 2 pontos (o primeiro dele começou)
  const k = cur[0] + cur[1];
  const gsrv = stb || tb ? (((pt[0] + pt[1] + 1) >> 1) & 1 ? 1 - gsrvNow : gsrvNow) : gsrvNow;
  const f = stb ? gsrv : k % 2 ? 1 - gsrv : gsrv;
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  return { sets, cur, pt, tb, stb, gsrv, f, log, aces: [num(H.aces), num(A.aces)], dfs: [num(H.double_faults), num(A.double_faults)], need, won: [wh, wa] };
}

/* motor de cada jogo, guardado alguns minutos (montar leva ~0,1–0,5 s) */
const cache = new Map();
const TTL = 3 * 60000, LIVE_TTL = 8000;
function engineFor(id, m, maxAge) {
  const c = cache.get(id), sig = m.live ? JSON.stringify([m.live.sets, m.live.cur, m.live.pt, m.live.gsrv, m.live.aces, m.live.dfs]) : m.sels.map((s) => s.odds).join(',');
  if (c && Date.now() - c.at < (maxAge ?? (m.live ? LIVE_TTL : TTL)) && c.sig === sig) return c.E;
  let E = null;
  try { E = build(m); } catch (e) { console.error('[Criar aposta ténis]', id, e.message); }
  if (E) E.v = Date.now();
  cache.set(id, { E, at: Date.now(), sig });
  if (cache.size > 300) for (const [k, v] of cache) if (Date.now() - v.at > TTL) cache.delete(k);
  return E;
}

module.exports = { supports, engineFor, build, fromParams, modelOf, quote, preview, requote, srcOf, MAX_LEGS, bitsOf, legFor, jointBits, fullR, liveFromStats, formatOf, buildTree, seqProbs, setDist, gameP, tbP, simulate, N, R_MAX };
