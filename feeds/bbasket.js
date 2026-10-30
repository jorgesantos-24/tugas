'use strict';
/* Motor do "Criar aposta" do basquete — várias seleções do mesmo jogo numa só odd.
   O jogo simula-se N vezes, sempre com os mesmos números aleatórios (no servidor e no navegador dá o mesmo):
     pontos de cada equipa em cada quarto = média da equipa × peso do quarto
                                          + ritmo do jogo (sobe ou desce as duas equipas)
                                          + força (a favor de uma, contra a outra)
                                          + o acaso do quarto (com alguma ligação entre as duas equipas);
     empate no fim do 4º quarto → prorrogação(ões) de 5 minutos;
     jogadores escolhidos: cestas de 3, resto dos pontos (ligado aos pontos da equipa), rebotes, assistências, roubos,
     tocos — todos ligados pelos minutos que o jogador fica em quadra (menos num jogo desequilibrado).
   Cada seleção vira a lista das simulações em que ganha, decidida pela MESMA regra de liquidação do site
   (markets.js: legOutcome, BP_FIELD, bpNeed); uma combinação ganha nas simulações em que ganham todas.
   Os parâmetros do jogo ajustam-se às odds da bet365 (vencedor, handicaps, totais, totais por equipa, tempos,
   quartos e margens) com contas exatas da normal; os dos jogadores às escadas "N ou mais" e às linhas mais/menos.

   Ao vivo: o motor simula só o que falta (resto do quarto atual e os quartos seguintes), ajustado às odds ao vivo,
   e soma o que já aconteceu (placar por quarto e números dos jogadores agora). */

const M = require('../public/markets.js');
const BB = require('./betbuilder.js'); // escada de odds, margem, regras comuns com o futebol
const { fair, minimize, nb, LADDER, ladderDown, EXTRA, MAX_LEGS, CHECK } = BB.common;

const N = 40000, WN = N >>> 5; // simulações (múltiplo de 32: cada seleção é um mapa de bits)

/* ---------------- números aleatórios fixos ---------------- */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const gauss = (r) => { let u = r(); while (u < 1e-12) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
// normais do jogo por simulação: ritmo, força, 4 quartos × 2 equipas, até 4 prorrogações × 2 equipas, regime do jogo
const NZ = 19;
let ZG = null;
function zGame() {
  if (ZG) return ZG;
  const r = rng(20261030), z = new Float32Array(N * NZ);
  // Box-Muller: cada par de números dá duas normais
  for (let i = 0; i < z.length; i += 2) {
    let u = r(); while (u < 1e-12) u = r();
    const R = Math.sqrt(-2 * Math.log(u)), t = 2 * Math.PI * r();
    z[i] = R * Math.cos(t);
    if (i + 1 < z.length) z[i + 1] = R * Math.sin(t);
  }
  return (ZG = z);
}
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

/* ---------------- normal ---------------- */
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989422804014327 * Math.exp(-x * x / 2); const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; };
const pGt = (x, mu, sd) => 1 - Phi((x - mu) / sd); // P(N(mu, sd) > x)
const pIn = (lo, hi, mu, sd) => Phi((hi - mu) / sd) - Phi((lo - mu) / sd);
const qnorm = (p) => { let lo = -8, hi = 8; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };

/* ---------------- partes do jogo ---------------- */
const SCOPE_Q = { ft: [0, 1, 2, 3], reg: [0, 1, 2, 3], h1: [0, 1], h2: [2, 3], q1: [0], q2: [1], q3: [2], q4: [3] };
const WITH_OT = new Set(['ft', 'h2']); // o jogo e o 2º tempo incluem a prorrogação (regra da bet365); quartos e "reg" não
const scopeOfLeg = (l) => (l.market === 'ml' || l.market === 'spread' || l.market === 'total' ? 'ft' : M.scopeOf(l));
const QUARTERS_ALL = new Set(['phs', 'pthq', 'pqcs']); // precisam dos 4 quartos de uma vez
const HALF = (v) => Number.isFinite(v) && Math.abs((v * 2) % 2) === 1; // linha .5

/* que seleções o motor sabe (sem o jogo: só pela forma) — a bandeira "bb" das seleções do basquete */
function supports(l) {
  const k = l.market;
  if (k === 'ml') return true;
  if (k === 'spread' || k === 'total') return HALF(l.line);
  if (k === 'bp') { const st = String(l.per ?? '').split('|')[0]; return !!M.BP_FIELD[st] && st !== 'fb' && st !== 'fa' && !!M.bpNeed(l); }
  if (QUARTERS_ALL.has(k)) return true;
  if (!SCOPE_Q[M.scopeOf(l)]) return false;
  if (k === 'ptot' || k === 'pspr' || k === 'pteam') return HALF(l.line);
  if (k === 'p1x2' || k === 'pdc' || k === 'poe' || k === 'phtft') return true;
  // condição única (as combinações prontas da bet365 ficam de fora, como no futebol)
  if (k === 'pcond') return !String(l.pick).includes(';');
  return false; // pml2 (empate devolvido), prace (ordem dos pontos), primeiro cesto...
}

/* ---------------- ajuste do jogo (contas da normal) ----------------
   P = { mh, ma (pontos esperados no tempo regulamentar), w[4] (peso de cada quarto), sp (ritmo), ss (força),
         se (acaso, desvio por equipa no jogo todo), rho (ligação das duas equipas no acaso), k (prorrogação: 5 min / tempo regulamentar) } */
function moments(P, scope, s = 1) {
  const qs = SCOPE_Q[scope], wS = qs.reduce((t, q) => t + P.w[q], 0), eq = s * s * P.se * P.se * wS;
  const mh = P.mh * wS, ma = P.ma * wS;
  const g = s * s * wS * wS;
  const vh = g * (P.sp * P.sp + P.ss * P.ss) + eq, cov = g * (P.sp * P.sp - P.ss * P.ss) + P.rho * eq;
  return { mh, ma, vh, va: vh, cov, sT: Math.sqrt(Math.max(1, 2 * vh + 2 * cov)), sD: Math.sqrt(Math.max(1, 2 * vh - 2 * cov)) };
}
// prorrogação: uma de 5 minutos
function otMoments(P) {
  const e = P.se * P.se * P.k * 1.1, mh = P.mh * P.k, ma = P.ma * P.k;
  return { mh, ma, sT: Math.sqrt(2 * e * (1 + P.rho)), sD: Math.sqrt(2 * e * (1 - P.rho)), sH: Math.sqrt(e) };
}
/* probabilidade de uma seleção pelas contas da normal (só as que servem para o ajuste); null = não serve.
   Caudas: com probabilidade pi o jogo é "fora do normal" (todo o acaso × kap) — os jogos reais têm mais surpresas
   do que uma normal (jogos parados, jogos a disparar, uma equipa numa noite má), e as linhas longe do centro da bet365 mostram-no. */
function analytic(P, l) {
  const a = analytic1(P, l, 1);
  if (a == null || !P.pi) return a;
  return (1 - P.pi) * a + P.pi * analytic1(P, l, P.kap);
}
function analytic1(P, l, sc) {
  const scope = scopeOfLeg(l), k = l.market, pk = String(l.pick);
  if (!SCOPE_Q[scope] || QUARTERS_ALL.has(k)) return null;
  const m = moments(P, scope === 'ft' ? 'reg' : scope, sc);
  const ot = WITH_OT.has(scope) ? otMoments(P) : null;
  const reg = ot ? moments(P, 'reg', sc) : null;
  const pt = ot ? pIn(-0.5, 0.5, reg.mh - reg.ma, reg.sD) : 0; // empate no fim do 4º quarto
  // valor contínuo X ~ N(mu, sd) (+ prorrogação com prob. pt)
  const mix = (f, mu, sd, muO, sdO) => (1 - pt) * f(mu, sd) + (pt ? pt * f(mu + muO, Math.sqrt(sd * sd + sdO * sdO)) : 0);
  const mD = m.mh - m.ma, mT = m.mh + m.ma;
  switch (k) {
    case 'ml': { if (scope !== 'ft') return null; const pw = pGt(0.5, mD, m.sD), pd = pIn(-0.5, 0.5, mD, m.sD), o = otMoments(P), po = pGt(0, o.mh - o.ma, o.sD); return pk === 'home' ? pw + pd * po : 1 - pw - pd * po; }
    case 'p1x2': { if (ot) return null; const pw = pGt(0.5, mD, m.sD), pd = pIn(-0.5, 0.5, mD, m.sD); return pk === 'home' ? pw : pk === 'draw' ? pd : 1 - pw - pd; }
    case 'total': case 'ptot': { if (!HALF(l.line)) return null; const o = otMoments(P); const p = mix((mu, sd) => pGt(l.line, mu, sd), mT, m.sT, o.mh + o.ma, o.sT); return pk === 'over' ? p : 1 - p; }
    case 'spread': case 'pspr': { if (!HALF(l.line)) return null; const o = otMoments(P); const sg = pk === 'home' ? 1 : -1; const p = mix((mu, sd) => pGt(-l.line, mu, sd), sg * mD, m.sD, sg * (o.mh - o.ma), o.sD); return p; }
    case 'pteam': { if (!HALF(l.line)) return null; const [side, ou] = pk.split(':'); const o = otMoments(P); const mu = side === 'home' ? m.mh : m.ma; const p = mix((x, sd) => pGt(l.line, x, sd), mu, Math.sqrt(m.vh), side === 'home' ? o.mh : o.ma, o.sH); return ou === 'over' ? p : 1 - p; }
    case 'pcond': {
      if (pk.includes(';') || pk.startsWith('!')) return null;
      let x;
      if (pk === 'res=draw' && !ot) return pIn(-0.5, 0.5, mD, m.sD);
      if ((x = /^m([ha])=in:(\d+)-(\d+)$/.exec(pk))) { const sg = x[1] === 'h' ? 1 : -1, lo = +x[2] - 0.5, hi = +x[3] + 0.5, o = otMoments(P); return mix((mu, sd) => pIn(lo, hi, mu, sd), sg * mD, m.sD, sg * (o.mh - o.ma), o.sD); }
      if ((x = /^m([ha])=gt:(\d+)$/.exec(pk))) { const sg = x[1] === 'h' ? 1 : -1, o = otMoments(P); return mix((mu, sd) => pGt(+x[2] + 0.5, mu, sd), sg * mD, m.sD, sg * (o.mh - o.ma), o.sD); }
      return null;
    }
  }
  return null;
}
// mercado completo para tirar a margem: as seleções que somam 100%
function setKey(l) {
  const k = l.market, scope = scopeOfLeg(l);
  if (k === 'ml' || k === 'p1x2') return `${k}|${scope}`;
  if (k === 'total' || k === 'ptot') return `tot|${scope}|${l.line}`;
  if (k === 'spread' || k === 'pspr') return `spr|${scope}|${l.pick === 'home' ? l.line : -l.line}`;
  if (k === 'pteam') return `team|${scope}|${String(l.pick).split(':')[0]}|${l.line}`;
  if (k === 'pcond' && /^m[ha]=(in|gt):|^res=draw$/.test(String(l.pick))) return `cond|${l.per}`;
  return null;
}
const FIT_W = { ml: 4, spread: 4, total: 4, pteam: 2 };
// valores típicos por cada 160 pontos de total (NBA medida: ritmo 3.4, força 2.5, acaso 9.6 em 234 pontos)
const GAME_DEF = { w: [0.25, 0.25, 0.25, 0.25], sp: 2.4, ss: 2, se: 6.6, rho: 0.1, pi: 0.15, kap: 1.8 };
// odd de um lado só → probabilidade sem a margem típica da bet365 (cresce com a odd: ~1% a 1.4, ~18% a 8, ~26% a 20)
const unmargin = (o) => Math.min(0.99, (1 / (o * Math.exp(-0.03))) ** (1 / 0.9));
// puxão suave para os valores típicos (só pesa quando o jogo tem poucos mercados para os decidir)
const PRIOR = 0.0015;
function fitGame(m) {
  const sets = {};
  for (const s of m.sels) {
    if (s.locked || !(s.odds > 1) || s.market === 'bp') continue;
    const key = setKey(s); if (!key) continue;
    (sets[key] ||= []).push(s);
  }
  const T = [];
  for (const [key, list] of Object.entries(sets)) {
    // um mercado inteiro: 2 seleções (mais/menos, casa/fora) ou 3 (com empate); as margens por faixas: todas
    const full = key.startsWith('cond|') ? list.length >= 4 : key.startsWith('ml|') ? list.length === 2 : key.startsWith('p1x2|') ? list.length === 3 : list.length === 2;
    if (!full) {
      // linha alternativa com um lado só (só "Mais de", faixa solta): sem a margem típica da bet365 para essa odd
      if (list.length === 1 && !key.startsWith('ml|') && !key.startsWith('p1x2|')) T.push({ l: list[0], pt: unmargin(list[0].odds), w: 0.5 * (FIT_W[list[0].market] || 1) / 2 });
      continue;
    }
    const P = fair(list.map((s) => s.odds));
    const w = (FIT_W[list[0].market] || 1) / list.length;
    list.forEach((s, i) => T.push({ l: s, pt: P[i], w }));
  }
  if (!T.some((t) => t.l.market === 'ml' || t.l.market === 'spread') || !T.some((t) => t.l.market === 'total' || (t.l.market === 'ptot' && scopeOfLeg(t.l) === 'ft'))) return null;
  // ponto de partida: o handicap e o total principais
  const main = (mk) => T.find((t) => t.l.market === mk && Math.abs(t.pt - 0.5) < 0.12);
  const tot = main('total')?.l.line ?? 160, spr = main('spread') ? (main('spread').l.pick === 'home' ? -main('spread').l.line : main('spread').l.line) : 0;
  const k = m.k || 5 / 40;
  const unpack = (p) => ({ mh: p[0], ma: p[1], w: [p[2], p[3], p[4], 1 - p[2] - p[3] - p[4]], sp: p[5], ss: p[6], se: p[7], rho: p[8], pi: p[9], kap: p[10], k });
  const sc = tot / 160; // escala: jogos de 40 minutos ~160 pontos, NBA ~225
  const prior = [null, null, 0.25, 0.25, 0.25, GAME_DEF.sp * sc, GAME_DEF.ss * sc, GAME_DEF.se * sc, GAME_DEF.rho, GAME_DEF.pi, GAME_DEF.kap], pscale = [1, 1, 0.02, 0.02, 0.02, 1.5 * sc, 1.5 * sc, 2 * sc, 0.2, 0.1, 0.4];
  const reg = (p) => p.reduce((t, x, i) => (prior[i] == null ? t : t + ((x - prior[i]) / pscale[i]) ** 2), 0) * PRIOR;
  const err = (p) => { if (p[2] + p[3] + p[4] > 0.82) return 1e9; const P = unpack(p); let e = reg(p); for (const t of T) { const v = analytic(P, t.l); if (v != null) e += t.w * (v - t.pt) ** 2; } return e; };
  const p0 = [tot / 2 + spr / 2, tot / 2 - spr / 2, ...GAME_DEF.w.slice(0, 3), GAME_DEF.sp * sc, GAME_DEF.ss * sc, GAME_DEF.se * sc, GAME_DEF.rho, GAME_DEF.pi, GAME_DEF.kap];
  const r = minimize(err, p0, [3, 3, 0.01, 0.01, 0.01, 1, 1, 1, 0.1, 0.05, 0.2], [10, 10, 0.18, 0.18, 0.18, 0, 0, 2, -0.3, 0, 1], [200, 200, 0.32, 0.32, 0.32, 25, 25, 30, 0.7, 0.5, 3], 300);
  return { ...unpack(r.p), fitErr: r.e };
}

/* ---------------- jogadores ----------------
   Por jogador: tpm = cestas de 3 (binomial negativa), o = resto dos pontos (normal), reb/ast/stl/blk (binomial negativa).
   Ajuste às escadas "N ou mais" (sem margem: 1/odd/PLM) e às linhas mais/menos (sem margem: as duas seleções). */
const PLM = 1.07;
const STATS1 = ['tpm', 'reb', 'ast', 'stl', 'blk'];
const R_DEF = { tpm: 8, reb: 14, ast: 10, stl: 25, blk: 6 };
const tailNB = (n, mu, r) => { if (n <= 0) return 1; let s = 0; for (let i = 0; i < n; i++) s += nb(i, mu, r); return Math.max(0, 1 - s); };
const playerOf = (l) => { const [, side, ...rest] = String(l.pick).split('#'); return { side, name: rest.join('#'), key: M.bpKey(rest.join('#')) }; };
function fitPlayers(m) {
  // escada de cada jogador e estatística: n → [probabilidades]
  const Q = {};
  const byPer = {};
  for (const s of m.sels) if (s.market === 'bp' && s.odds > 1 && !s.locked) (byPer[s.per] ||= []).push(s);
  for (const list of Object.values(byPer)) {
    const stat = String(list[0].per).split('|')[0];
    if (!['pts', ...STATS1].includes(stat)) continue;
    for (const s of list) {
      const n = M.bpNeed(s); if (!n) continue;
      const pl = playerOf(s);
      const twin = list.find((x) => x !== s && playerOf(x).key === pl.key && M.bpNeed(x)?.need === n.need && M.bpNeed(x)?.under !== n.under);
      let p;
      if (twin) { if (n.under) continue; p = fair([s.odds, twin.odds])[0]; } // linha mais/menos: sem margem
      else if (n.under) continue;
      else p = Math.min(0.985, 1 / s.odds / PLM);
      const x = (Q[pl.key] ||= { name: pl.name, side: pl.side, st: {} });
      if (pl.side && !x.side) x.side = pl.side;
      ((x.st[stat] ||= {})[n.need] ||= []).push({ p, w: twin ? 3 : 1 });
    }
  }
  const out = {};
  for (const [key, { name, side, st }] of Object.entries(Q)) {
    const P = { name, side };
    const rungs = (o) => Object.entries(o || {}).map(([n, ps]) => [+n, ps.reduce((a, b) => a + b.p * b.w, 0) / ps.reduce((a, b) => a + b.w, 0), ps.reduce((a, b) => a + b.w, 0)]).sort((a, b) => a[0] - b[0]);
    for (const stat of STATS1) {
      const R = rungs(st[stat]); if (!R.length) continue;
      const top = Math.max(3, R[R.length - 1][0] * 2);
      const err = ([mu, lr]) => R.reduce((e, [n, pt, w]) => e + w * (tailNB(n, mu, Math.exp(lr)) - pt) ** 2, 0);
      const f = R.length === 1
        ? minimize(([mu]) => err([mu, Math.log(R_DEF[stat])]), [R[0][0]], [top / 6], [0.02], [top * 2], 150).p.concat(Math.log(R_DEF[stat]))
        : minimize(err, [R[0][0] + 0.5, Math.log(R_DEF[stat])], [top / 6, 0.5], [0.02, Math.log(0.8)], [top * 2, Math.log(400)], 200).p;
      P[stat] = { mu: f[0], r: Math.exp(f[1]) };
    }
    // pontos: 3 × cestas de 3 + resto (normal)
    const R = rungs(st.pts);
    if (R.length) {
      const T3 = P.tpm ? Array.from({ length: 16 }, (_, k) => nb(k, P.tpm.mu, P.tpm.r)) : [1];
      const tail = (n, mu, sd) => T3.reduce((t, p3, k) => t + p3 * pGt(n - 0.5 - 3 * k, mu, sd), 0);
      const top = R[R.length - 1][0];
      const f = R.length === 1
        ? [minimize(([mu]) => (tail(R[0][0], mu, Math.max(2.5, 0.38 * R[0][0])) - R[0][1]) ** 2, [R[0][0]], [top / 5], [0], [top * 2], 150).p[0], Math.max(2.5, 0.38 * R[0][0])]
        : minimize(([mu, sd]) => R.reduce((e, [n, pt, w]) => e + w * (tail(n, mu, sd) - pt) ** 2, 0), [R[0][0], Math.max(3, top / 4)], [top / 5, 1.5], [0, 1.5], [top * 2, top], 200).p;
      P.o = { mu: f[0], sd: f[1] };
    }
    out[key] = P;
  }
  return out;
}

/* ---------------- simulação ---------------- */
function simulate(P) {
  const Z = zGame(), q = new Int16Array(N * 8), ot = new Int16Array(N * 2);
  const r2 = Math.sqrt(Math.max(0, 1 - P.rho * P.rho)), o = otMoments(P);
  const sq = P.w.map((w) => P.se * Math.sqrt(w));
  const zpi = P.pi ? qnorm(P.pi) : -Infinity; // regime "fora do normal": a normal do regime abaixo deste valor
  for (let i = 0; i < N; i++) {
    const z = i * NZ, x = Z[z + 18] < zpi ? P.kap : 1, pace = x * P.sp * Z[z], str = x * P.ss * Z[z + 1];
    let H = 0, A = 0;
    for (let k = 0; k < 4; k++) {
      const w = P.w[k], e1 = x * Z[z + 2 + 2 * k], e2 = x * Z[z + 3 + 2 * k];
      const h = Math.max(0, Math.round(P.mh * w + w * (pace + str) + sq[k] * e1));
      const a = Math.max(0, Math.round(P.ma * w + w * (pace - str) + sq[k] * (P.rho * e1 + r2 * e2)));
      q[i * 8 + 2 * k] = h; q[i * 8 + 2 * k + 1] = a; H += h; A += a;
    }
    if (H === A) {
      let oh = 0, oa = 0;
      for (let j = 0; j < 4; j++) {
        const e1 = Z[z + 10 + 2 * j], e2 = Z[z + 11 + 2 * j];
        oh += Math.max(0, Math.round(o.mh + o.sH * e1)); oa += Math.max(0, Math.round(o.ma + o.sH * (P.rho * e1 + r2 * e2)));
        if (oh !== oa) break;
      }
      if (oh === oa) oh++; // 4 prorrogações empatadas: quase nunca
      ot[2 * i] = oh; ot[2 * i + 1] = oa;
    }
  }
  return { q, ot };
}
// placar de uma parte na simulação i: [casa, fora]
function scoreAt(E, i, scope) {
  const { q, ot } = E.S, b = i * 8;
  switch (scope) {
    case 'q1': return [q[b], q[b + 1]];
    case 'q2': return [q[b + 2], q[b + 3]];
    case 'q3': return [q[b + 4], q[b + 5]];
    case 'q4': return [q[b + 6], q[b + 7]];
    case 'h1': return [q[b] + q[b + 2], q[b + 1] + q[b + 3]];
    case 'h2': return [q[b + 4] + q[b + 6] + ot[2 * i], q[b + 5] + q[b + 7] + ot[2 * i + 1]];
    case 'reg': return [q[b] + q[b + 2] + q[b + 4] + q[b + 6], q[b + 1] + q[b + 3] + q[b + 5] + q[b + 7]];
    case 'ft': return [q[b] + q[b + 2] + q[b + 4] + q[b + 6] + ot[2 * i], q[b + 1] + q[b + 3] + q[b + 5] + q[b + 7] + ot[2 * i + 1]];
  }
  return null;
}
// placares diferentes de uma parte (para decidir cada seleção uma vez por placar, não por simulação)
function uniq(E, scope) {
  const c = (E.U ||= {});
  if (c[scope]) return c[scope];
  const idx = new Int32Array(N), map = new Map(), pairs = [];
  for (let i = 0; i < N; i++) {
    const [h, a] = scoreAt(E, i, scope), k = h * 1024 + a;
    let j = map.get(k); if (j === undefined) { j = pairs.length; map.set(k, j); pairs.push([h, a]); }
    idx[i] = j;
  }
  return (c[scope] = { idx, pairs });
}
// resultado no formato da liquidação (markets.js) com o placar [h, a] da parte
function resOf(scope, h, a) {
  const R = { h, a, parts: {} };
  R.parts[scope] = [h, a];
  if (scope === 'reg') R.reg = [h, a];
  return R;
}
function fullRes(E, i) {
  const R = { parts: {} };
  for (const s of ['q1', 'q2', 'q3', 'q4', 'h1', 'h2', 'reg']) R.parts[s] = scoreAt(E, i, s);
  [R.h, R.a] = scoreAt(E, i, 'ft');
  R.reg = R.parts.reg;
  return R;
}

/* jogadores: os números de cada simulação (feitos na primeira seleção desse jogador) */
const SF = 0.16; // minutos em quadra: desvio do fator (lognormal)
function playerSims(E, key) {
  const c = (E.PS ||= {});
  if (c[key] !== undefined) return c[key];
  const P = E.pl[key];
  if (!P || !(P.o || P.reb || P.ast || P.tpm)) return (c[key] = null); // sem nenhuma linha do jogador não se simula
  // estatística sem linha na bet365: simula-se em branco e as seleções que precisam dela ficam de fora (STAT_NEEDS)
  const o0 = P.o || { mu: 0, sd: 1 }, none = { mu: 0, r: 10 };
  const rnd = rng(hash(key) ^ 0x9e3779b9);
  // ao vivo a bet365 não diz a equipa do jogador: vem do box score
  const side0 = P.side || (E.live?.roster || []).find((x) => x.key === key)?.side;
  const side = side0 === 'away' ? 'away' : side0 === 'home' ? 'home' : null;
  if (!side) return (c[key] = null);
  const team = side === 'home' ? 0 : 1;
  // ao vivo: simula-se só o que falta (os pontos da equipa que faltam) e soma-se o que o jogador já fez
  const L = E.live, now = L ? (L.roster || []).find((x) => x.key === key && (!x.side || x.side === side)) : null;
  if (L && !now) return (c[key] = null); // ao vivo sem o jogador no box score: não se sabe o que já fez
  const base = L ? (team === 0 ? L.base.h : L.base.a) : 0;
  const mT = ((team === 0 ? E.P.mh : E.P.ma) * (L ? E.S.wL : 1)) || 100;
  const out = { pts: new Int16Array(N), reb: new Int16Array(N), ast: new Int16Array(N), tpm: new Int16Array(N), stl: new Int16Array(N), blk: new Int16Array(N) };
  const star = (o0.mu + 3 * (P.tpm?.mu || 0)) >= 12;
  // variância extra que o fator dos minutos e o da equipa juntam: tira-se do desvio próprio, para as linhas baterem
  const sdO = Math.sqrt(Math.max(1, o0.sd * o0.sd - o0.mu * o0.mu * (SF * SF + 0.01)));
  const rAdj = (r) => { const inv = Math.max(0.005, (1 / r - SF * SF) / (1 + SF * SF)); return 1 / inv; };
  const def = { stl: { mu: 0.8, r: 30 }, blk: { mu: 0.5, r: 6 } };
  for (let i = 0; i < N; i++) {
    const [H, A] = scoreAt(E, i, 'ft'), [rh, ra] = scoreAt(E, i, 'reg');
    let F = Math.exp(SF * gauss(rnd) - SF * SF / 2);
    if (star) F *= Math.max(0.7, 1 - 0.012 * Math.max(0, Math.abs(rh - ra) - 15)); // jogo decidido: titulares descansam
    const tf = Math.max(0, (team === 0 ? H : A) - base) / mT;
    const nbs = (d) => poisson(d.mu * F * gamma1(rAdj(d.r), rnd), rnd);
    const t3 = P.tpm ? nbs(P.tpm) : 0;
    const o = Math.max(0, Math.round(o0.mu * F * tf + sdO * gauss(rnd)));
    out.tpm[i] = t3; out.pts[i] = 3 * t3 + o;
    out.reb[i] = nbs(P.reb || none); out.ast[i] = nbs(P.ast || none);
    out.stl[i] = nbs(P.stl || def.stl); out.blk[i] = nbs(P.blk || def.blk);
    if (now) for (const st of ['pts', 'reb', 'ast', 'tpm', 'stl', 'blk']) out[st][i] += Number(now[st]) || 0;
  }
  return (c[key] = out);
}

/* ---------------- seleção → mapa de bits das simulações em que ganha ---------------- */
// o que cada estatística de jogador precisa de ter ajustado (roubos e tocos têm valores típicos)
const STAT_NEEDS = { pts: ['o'], reb: ['reb'], ast: ['ast'], tpm: ['tpm'], stl: [], blk: [], sb: [], pa: ['o', 'ast'], pr: ['o', 'reb'], ar: ['ast', 'reb'], pra: ['o', 'reb', 'ast'], dd: ['o', 'reb', 'ast'], td: ['o', 'reb', 'ast'] };
const popcnt = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
function count(b) { let t = 0; for (let i = 0; i < WN; i++) t += popcnt(b[i]); return t; }
function andCount(a, b) { let t = 0; for (let i = 0; i < WN; i++) t += popcnt(a[i] & b[i]); return t; }
function andInto(a, b) { const o = new Uint32Array(WN); for (let i = 0; i < WN; i++) o[i] = a[i] & b[i]; return o; }
const specKey = (l) => `${l.market}|${l.per ?? ''}|${l.pick}|${l.line ?? ''}`;
const legOfSpec = (l) => ({ market: l.market, per: l.per, pick: l.pick, line: l.line });
// null = o motor não a sabe (ou pode ser devolvida: empate na linha)
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
  const leg = legOfSpec(spec), b = new Uint32Array(WN);
  const set = (i) => { b[i >>> 5] |= 1 << (i & 31); };
  if (spec.market === 'bp') {
    const pl = playerOf(spec), S = playerSims(E, pl.key), stat = String(spec.per).split('|')[0], n = M.bpNeed(spec);
    if (!S || !n || !(STAT_NEEDS[stat] || []).every((x) => E.pl[pl.key]?.[x])) return null;
    const get = M.BP_FIELD[stat], p = {};
    for (let i = 0; i < N; i++) {
      p.pts = S.pts[i]; p.reb = S.reb[i]; p.ast = S.ast[i]; p.tpm = S.tpm[i]; p.stl = S.stl[i]; p.blk = S.blk[i];
      if ((get(p) >= n.need) !== n.under) set(i);
    }
    return b;
  }
  if (QUARTERS_ALL.has(spec.market)) {
    for (let i = 0; i < N; i++) { const r = M.legOutcome(leg, fullRes(E, i)); if (r !== 1 && r !== -1) return null; if (r === 1) set(i); }
    return b;
  }
  const scope = scopeOfLeg(spec);
  if (!SCOPE_Q[scope]) return null;
  const U = uniq(E, scope), out = new Int8Array(U.pairs.length);
  for (let j = 0; j < U.pairs.length; j++) {
    const [h, a] = U.pairs[j], r = M.legOutcome(leg, resOf(scope, h, a));
    if (r !== 1 && r !== -1) return null; // devolvida ou desconhecida num placar possível: fora do Criar aposta
    out[j] = r;
  }
  for (let i = 0; i < N; i++) if (out[U.idx[i]] === 1) set(i);
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

/* ---------------- preço no site ----------------
   odd = 1 / (e^a · p^b) — a margem da bet365, medida nas 427 combinações prontas dela no basquete (resultado/handicap
   + total) — com pelo menos 6% de margem (nas combinações curtas a curva dava quase a odd justa), e a nossa margem
   extra (+3%); arredonda-se para baixo na escada de odds. */
const CAL = { a: -0.12064, b: 0.81626, min: 1.06 };
const oddOf = (p) => 1 / Math.max(Math.exp(CAL.a) * p ** CAL.b, p * CAL.min) / EXTRA;
const priceOf = (p) => ladderDown(oddOf(p));
// a mesma seleção em mercados diferentes da fonte (handicap principal e alternativo...) conta como o mesmo mercado
function mkOf(l) {
  const scope = scopeOfLeg(l), k = l.market;
  if (k === 'bp') return `bp|${String(l.per).split('|')[0]}|${playerOf(l).key}`;
  if (k === 'ml' || k === 'p1x2' || k === 'pdc') return `res|${scope}`;
  if (k === 'spread' || k === 'pspr') return `spr|${scope}`;
  if (k === 'total' || k === 'ptot') return `tot|${scope}`;
  if (k === 'pteam') return `team|${scope}|${String(l.pick).split(':')[0]}`;
  return `${k}|${l.per ?? ''}`;
}
// juntar uma seleção nunca baixa a odd: a combinação paga pelo menos o que paga qualquer parte dela
function floorOdds(bits, singles) {
  const n = bits.length, full = (1 << n) - 1;
  let best = Math.max(...singles);
  for (let mask = 1; mask < full; mask++) {
    if ((mask & (mask - 1)) === 0) continue;
    const p = jointBits(bits.filter((_, i) => (mask >> i) & 1));
    if (p >= 1e-4) best = Math.max(best, priceOf(p));
  }
  return best;
}
// seleção (spec) → { bits, p1 } se entra; null se não
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
const offCheck = (p1, odds) => Math.abs(Math.log(oddOf(p1) * EXTRA / odds)) > Math.log(1 + CHECK) + 0.15;

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
  const odds = Math.max(priceOf(p), floorOdds(bits, items.map((it) => it.odds)));
  if (odds < 1.02) return { reason: 'odd demasiado baixa para esta combinação' };
  return { odds, p, params: paramsOf(E, items.map((it) => it.q)) };
}
/* aba Criar aposta: com as escolhidas (items), a odd de juntar cada candidata → { key: odd } (0 = não junta) */
function preview(E, items, cands) {
  const legs = [];
  for (const it of items) { const l = it.q && legFor(E, it.q); if (!l) return null; legs.push(l); }
  const n = legs.length, full = (1 << n) - 1;
  // E de cada grupo das escolhidas (mask), feito uma vez
  const AND = new Array(full + 1);
  AND[0] = null;
  for (let mask = 1; mask <= full; mask++) { const i = 31 - Math.clz32(mask), rest = mask ^ (1 << i); AND[mask] = rest ? andInto(AND[rest], legs[i].b) : legs[i].b; }
  const pOf = (mask) => (mask ? count(AND[mask]) / N : 1);
  const base = n ? pOf(full) : 1;
  let floorBase = 0;
  if (n === 1) floorBase = items[0].odds;
  else if (n > 1) { floorBase = Math.max(priceOf(base), ...items.map((it) => it.odds)); for (let mask = 1; mask < full; mask++) if (mask & (mask - 1)) { const pt = pOf(mask); if (pt >= 1e-4) floorBase = Math.max(floorBase, priceOf(pt)); } }
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
    // ou torna uma das escolhidas redundante
    if (legs.some((_, i) => { const r = pm[full ^ (1 << i)]; return p >= r * 0.999; })) continue;
    let odds = Math.max(priceOf(p), floorBase, c.odds);
    for (let mask = 1; mask < full; mask++) if (pm[mask] >= 1e-4) odds = Math.max(odds, priceOf(pm[mask]));
    if (odds >= 1.02) out[c.key] = odds;
  }
  return out;
}

/* ---------------- montar, guardar, refazer ---------------- */
// o que fica guardado na aposta (e vai para o navegador): parâmetros do jogo e dos jogadores escolhidos
function paramsOf(E, specs) {
  const pl = {};
  for (const s of specs || Object.keys(E.pl).map((k) => ({ market: 'bp', pick: `1##${E.pl[k].name}` }))) if (s?.market === 'bp') { const k = playerOf(s).key; if (E.pl[k]) pl[k] = E.pl[k]; }
  // ao vivo: do box score só os jogadores que contam (todos no modelo para o navegador; na aposta, os escolhidos)
  const live = E.live && { ...E.live, roster: (E.live.roster || []).filter((x) => pl[x.key]).map(({ key, side, pts, reb, ast, tpm, stl, blk }) => ({ key, side, pts, reb, ast, tpm, stl, blk })) };
  return { sport: 'basketball', home: E.home, away: E.away, P: E.P, pl, ...(live ? { live } : {}) };
}
function fromParams(X) {
  const E = { home: X.home, away: X.away, P: X.P, pl: X.pl || {}, live: X.live || null };
  E.S = X.live ? simulateLive(X.P, X.live) : simulate(X.P);
  return E;
}
// duração do jogo: NBA 48 minutos, o resto 40 (a prorrogação é sempre de 5)
const regMinutes = (league) => (/^(bk\.)?nba$/i.test(String(league ?? '')) ? 48 : 40);
function build(m) {
  if (m.live) return buildLive(m);
  const P = fitGame({ ...m, k: 5 / regMinutes(m.league) });
  if (!P) return null;
  const E = fromParams({ home: m.home, away: m.away, P, pl: fitPlayers(m) });
  E.m = m;
  return E;
}
const modelOf = (E) => ({ v: E.v, ...paramsOf(E, null) });
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
  return Math.max(1, priceOf(p), floorOdds(bits, kept.map((k) => k.odds)));
}

/* ---------------- ao vivo ----------------
   m.live = { q: [[c, f] × quartos acabados], cur: [c, f] (placar do quarto a decorrer), period (1-4; 5+ = prorrogação),
              left (minutos que faltam no quarto), roster: [{ key, side, played, pts, reb, ast, tpm, stl, blk }] }
   O ajuste usa as odds ao vivo traduzidas para "o que falta": as linhas da bet365 contam o jogo todo, por isso cada
   seleção vê o que já aconteceu + o que falta (o mesmo bitsOf, com a simulação já somada). */
function buildLive(m) {
  const L = m.live, len = regMinutes(m.league) / 4;
  if (!(L.period >= 1 && L.period <= 4) || !(L.left >= 0)) return null; // prorrogação: fora
  // parte do quarto atual que falta e quartos seguintes: pesos do que falta
  const fCur = Math.min(1, Math.max(0, L.left / len));
  const k = 5 / regMinutes(m.league);
  const done = L.q.slice(0, L.period - 1), cur = L.cur || [0, 0];
  const base = { h: done.reduce((t, x) => t + x[0], 0) + cur[0], a: done.reduce((t, x) => t + x[1], 0) + cur[1] };
  // ajuste: o mesmo fitGame, com as seleções vistas como "o que falta" (cada parte com o que já aconteceu)
  const P = fitLive(m, L, fCur, k, base);
  if (!P) return null;
  const live = { q: done, cur, period: L.period, fCur, base, roster: L.roster || [] };
  const E = fromParams({ home: m.home, away: m.away, P, pl: fitPlayers({ ...m, sels: liveBpSels(m.sels, live) }), live });
  E.m = m;
  return E;
}
// pesos do que falta: o resto do quarto atual (fCur) e os quartos seguintes inteiros
function liveWeights(P, L) {
  return [0, 1, 2, 3].map((q) => (q < L.period - 1 ? 0 : q === L.period - 1 ? P.w[q] * L.fCur : P.w[q]));
}
function fitLive(m, L, fCur, k, base) {
  const live = { q: L.q.slice(0, L.period - 1), cur: L.cur || [0, 0], period: L.period, fCur };
  const sels = m.sels.filter((s) => !s.locked && s.odds > 1 && s.market !== 'bp');
  // ponto de partida: o total e o handicap ao vivo, menos o que já aconteceu
  const tot = sels.find((s) => s.market === 'total'), spr = sels.find((s) => s.market === 'spread' && s.pick === 'home');
  if (!tot) return null;
  const remT = Math.max(5, tot.line - base.h - base.a), remD = spr ? -spr.line - (base.h - base.a) : 0;
  const wLeft = [0, 1, 2, 3].reduce((t, q) => t + (q < L.period - 1 ? 0 : q === L.period - 1 ? 0.25 * fCur : 0.25), 0) || 0.01;
  // médias do jogo inteiro equivalentes (o que falta / parte que falta)
  const sets = {};
  for (const s of sels) { const key = setKey(s); if (key) (sets[key] ||= []).push(s); }
  const T = [];
  for (const [key, list] of Object.entries(sets)) {
    const sc = scopeOfLeg(list[0]);
    if (SCOPE_Q[sc].every((q) => q < L.period - 1)) continue; // parte já acabada
    const full = key.startsWith('cond|') ? list.length >= 4 : key.startsWith('ml|') ? list.length === 2 : key.startsWith('p1x2|') ? list.length === 3 : list.length === 2;
    if (!full) continue;
    const Pf = fair(list.map((s) => s.odds));
    list.forEach((s, i) => T.push({ l: s, pt: Pf[i], w: (FIT_W[s.market] || 1) / list.length }));
  }
  if (!T.length) return null;
  const unpack = (p) => ({ mh: p[0], ma: p[1], w: [0.25, 0.25, 0.25, 0.25], sp: p[2], ss: p[3], se: p[4], rho: GAME_DEF.rho, k });
  // seleção ao vivo pelas contas da normal: a parte = o que já aconteceu nela + o que falta (pesos de liveWeights)
  const sc = (remT / wLeft) / 160;
  const prior = [null, null, GAME_DEF.sp * sc, GAME_DEF.ss * sc, GAME_DEF.se * sc], pscale = [1, 1, 1.5 * sc, 1.5 * sc, 2 * sc];
  const err = (p) => {
    const P = unpack(p); let e = p.reduce((t, x, i) => (prior[i] == null ? t : t + ((x - prior[i]) / pscale[i]) ** 2), 0) * PRIOR;
    for (const t of T) { const v = analyticLive(P, live, t.l); if (v != null) e += t.w * (v - t.pt) ** 2; }
    return e;
  };
  const p0 = [remT / wLeft / 2 + remD / wLeft / 2, remT / wLeft / 2 - remD / wLeft / 2, GAME_DEF.sp * sc, GAME_DEF.ss * sc, GAME_DEF.se * sc];
  const r = minimize(err, p0, [3, 3, 1, 1, 1], [10, 10, 0, 0, 2], [260, 260, 25, 25, 30], 250);
  return { ...unpack(r.p), fitErr: r.e };
}
// parte já jogada (placar) e o que falta nela (momentos da normal) para uma seleção ao vivo
function liveScope(P, L, scope) {
  const qs = SCOPE_Q[scope];
  const W = liveWeights(P, L);
  let h0 = 0, a0 = 0;
  for (const q of qs) { if (q < L.period - 1) { h0 += L.q[q][0]; a0 += L.q[q][1]; } else if (q === L.period - 1) { h0 += L.cur[0]; a0 += L.cur[1]; } }
  const wS = qs.reduce((t, q) => t + W[q], 0), eq = P.se * P.se * wS, g = wS * wS;
  const vh = g * (P.sp * P.sp + P.ss * P.ss) + eq, cov = g * (P.sp * P.sp - P.ss * P.ss) + P.rho * eq;
  return { h0, a0, mh: P.mh * wS, ma: P.ma * wS, vh, sT: Math.sqrt(Math.max(0.5, 2 * vh + 2 * cov)), sD: Math.sqrt(Math.max(0.5, 2 * vh - 2 * cov)) };
}
function analyticLive(P, L, l) {
  const scope = scopeOfLeg(l), k = l.market, pk = String(l.pick);
  if (!SCOPE_Q[scope]) return null;
  const s = liveScope(P, L, scope === 'ft' ? 'reg' : scope);
  const ot = WITH_OT.has(scope) ? otMoments(P) : null;
  const reg = ot ? liveScope(P, L, 'reg') : null;
  const pt = ot ? pIn(-0.5, 0.5, reg.h0 - reg.a0 + reg.mh - reg.ma, reg.sD) : 0;
  const mix = (f, mu, sd, muO, sdO) => (1 - pt) * f(mu, sd) + (pt ? pt * f(mu + muO, Math.sqrt(sd * sd + sdO * sdO)) : 0);
  const mD = s.h0 - s.a0 + s.mh - s.ma, mT = s.h0 + s.a0 + s.mh + s.ma;
  const o = otMoments(P);
  switch (k) {
    case 'ml': { if (scope !== 'ft') return null; const pw = pGt(0.5, mD, s.sD), pd = pIn(-0.5, 0.5, mD, s.sD), po = pGt(0, o.mh - o.ma, o.sD); return pk === 'home' ? pw + pd * po : 1 - pw - pd * po; }
    case 'p1x2': { if (ot) return null; const pw = pGt(0.5, mD, s.sD), pd = pIn(-0.5, 0.5, mD, s.sD); return pk === 'home' ? pw : pk === 'draw' ? pd : 1 - pw - pd; }
    case 'total': case 'ptot': { if (!HALF(l.line)) return null; const p = mix((mu, sd) => pGt(l.line, mu, sd), mT, s.sT, o.mh + o.ma, o.sT); return pk === 'over' ? p : 1 - p; }
    case 'spread': case 'pspr': { if (!HALF(l.line)) return null; const sg = pk === 'home' ? 1 : -1; return mix((mu, sd) => pGt(-l.line, mu, sd), sg * mD, s.sD, sg * (o.mh - o.ma), o.sD); }
    case 'pteam': { if (!HALF(l.line)) return null; const [side, ou] = pk.split(':'); const mu = side === 'home' ? s.h0 + s.mh : s.a0 + s.ma; const p = mix((x, sd) => pGt(l.line, x, sd), mu, Math.sqrt(s.vh), side === 'home' ? o.mh : o.ma, o.sH); return ou === 'over' ? p : 1 - p; }
  }
  return null;
}
// simula só o que falta e soma o que já aconteceu
function simulateLive(P, L) {
  const W = liveWeights(P, L), Z = zGame(), q = new Int16Array(N * 8), ot = new Int16Array(N * 2);
  const r2 = Math.sqrt(Math.max(0, 1 - P.rho * P.rho)), o = otMoments(P), wL = W.reduce((a, b) => a + b, 0);
  for (let i = 0; i < N; i++) {
    const z = i * NZ, pace = P.sp * Z[z], str = P.ss * Z[z + 1];
    let H = 0, A = 0;
    for (let k = 0; k < 4; k++) {
      let h, a;
      if (k < L.period - 1) [h, a] = L.q[k];
      else {
        const w = W[k], sq = P.se * Math.sqrt(w), e1 = Z[z + 2 + 2 * k], e2 = Z[z + 3 + 2 * k];
        h = Math.max(0, Math.round(P.mh * w + w * (pace + str) + sq * e1));
        a = Math.max(0, Math.round(P.ma * w + w * (pace - str) + sq * (P.rho * e1 + r2 * e2)));
        if (k === L.period - 1) { h += L.cur[0]; a += L.cur[1]; }
      }
      q[i * 8 + 2 * k] = h; q[i * 8 + 2 * k + 1] = a; H += h; A += a;
    }
    if (H === A) {
      let oh = 0, oa = 0;
      for (let j = 0; j < 4; j++) {
        const e1 = Z[z + 10 + 2 * j], e2 = Z[z + 11 + 2 * j];
        oh += Math.max(0, Math.round(o.mh + o.sH * e1)); oa += Math.max(0, Math.round(o.ma + o.sH * (P.rho * e1 + r2 * e2)));
        if (oh !== oa) break;
      }
      if (oh === oa) oh++;
      ot[2 * i] = oh; ot[2 * i + 1] = oa;
    }
  }
  return { q, ot, wL };
}
// jogadores ao vivo: as escadas da bet365 contam o jogo todo → ajusta-se ao que falta (N − o que já fez)
function liveBpSels(sels, live) {
  const out = [];
  for (const s of sels) {
    if (s.market !== 'bp') { out.push(s); continue; }
    const stat = String(s.per).split('|')[0], n = M.bpNeed(s), pl = playerOf(s);
    const p = (live.roster || []).find((x) => x.key === pl.key && (!pl.side || !x.side || x.side === pl.side));
    if (!n || !p || !['pts', ...STATS1].includes(stat)) continue;
    const v = Number(p[stat]) || 0, need = n.need - v;
    if (need <= 0) continue;
    out.push({ ...s, pick: `${n.under ? 'u' : ''}${need}#${p.side || pl.side}#${pl.name}` });
  }
  return out;
}

/* motor de cada jogo, guardado alguns minutos (montar leva ~100 ms) */
const cache = new Map();
const TTL = 3 * 60000, LIVE_TTL = 8000;
function engineFor(id, m, maxAge) {
  const c = cache.get(id), sig = m.live ? JSON.stringify([m.live.q, m.live.cur, m.live.period, Math.round(m.live.left * 2)]) : m.sels.map((s) => s.odds).join(',');
  if (c && Date.now() - c.at < (maxAge ?? (m.live ? LIVE_TTL : TTL)) && c.sig === sig) return c.E;
  let E = null;
  try { E = build(m); } catch (e) { console.error('[Criar aposta basquete]', id, e.message); }
  if (E) E.v = Date.now();
  cache.set(id, { E, at: Date.now(), sig });
  if (cache.size > 300) for (const [k, v] of cache) if (Date.now() - v.at > TTL) cache.delete(k);
  return E;
}

module.exports = { supports, engineFor, build, fromParams, modelOf, quote, preview, requote, srcOf, MAX_LEGS, bitsOf, legFor, jointBits, analytic, fitGame, fitPlayers, N, CAL };
