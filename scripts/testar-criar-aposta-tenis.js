'use strict';
/* Testes do Criar aposta do ténis (feeds/btennis.js), sem rede:
   1. contas exatas (game, tie-break, set, partida) contra contas próprias e contra a simulação
   2. placar ao vivo (liveFromStats): games, vantagem, tie-break, super tie-break das duplas, entre sets, dados que não batem
   3. jogos reais (scripts/dados/criar-aposta-tenis-2026-10.json): antes do jogo e ao vivo — modelo vs bet365, grupos da
      simulação = regra da liquidação, combinações, o que se grava no Firestore, navegador = servidor, anulação de seleções
   4. melhor de 5, tie-break e super tie-break ao vivo com odds inventadas a partir de um jogo conhecido (o ajuste recupera-o?)
   node scripts/testar-criar-aposta-tenis.js */
const path = require('path');
const M = require('../public/markets.js');
const TN = require('../feeds/btennis.js');
const { fair } = require('../feeds/betbuilder.js').common;
const D = require(path.join(__dirname, 'dados', 'criar-aposta-tenis-2026-10.json'));

let fails = 0, checks = 0;
const ok = (c, ...msg) => { checks++; if (!c) { fails++; console.log('  FALHA', ...msg); } return c; };
const near = (x, y, tol, ...msg) => ok(Math.abs(x - y) <= tol, ...msg, `${x} vs ${y} (tolerância ${tol})`);
const rnd = (() => { let s = 11; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); })();
const sig = (x) => 1 / (1 + Math.exp(-x));
const bitOf = (b, i) => (b[i >>> 5] >>> (i & 31)) & 1;
const share = (b) => { let n = 0; for (let i = 0; i < TN.N; i++) n += bitOf(b, i); return n / TN.N; };
// o Firestore não aceita listas dentro de listas nem funções
function firestoreOk(v, p = '') {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { if (Array.isArray(v[i])) return `${p}[${i}] lista dentro de lista`; const r = firestoreOk(v[i], `${p}[${i}]`); if (r) return r; } return null; }
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) { const r = firestoreOk(x, `${p}.${k}`); if (r) return r; } return null; }
  return typeof v === 'function' ? `${p} função` : null;
}

/* ---------------- 1. contas exatas ---------------- */
console.log('1. contas exatas');
// contas próprias, ponto a ponto, para comparar com as do motor
function gameRef(p, noAd) {
  const memo = new Map();
  const go = (x, y) => {
    if (x >= 4 && x - y >= 2) return 1;
    if (y >= 4 && y - x >= 2) return 0;
    if (x === 3 && y === 3 && noAd) return p;
    if (x >= 3 && y >= 3 && x === y) { const k = 'd'; if (memo.has(k)) return memo.get(k); const d = (p * p) / (p * p + (1 - p) * (1 - p)); memo.set(k, d); return d; }
    const k = `${x},${y}`;
    if (!memo.has(k)) memo.set(k, p * go(x + 1, y) + (1 - p) * go(x, y + 1));
    return memo.get(k);
  };
  return go(0, 0);
}
// tie-break a `to` pontos: quem serve o 1º ponto tem p, o outro q; serviço muda ao ponto 1, 3, 5...
function tbRef(p, q, to) {
  const memo = new Map();
  const go = (x, y) => {
    if (x >= to && x - y >= 2) return 1;
    if (y >= to && y - x >= 2) return 0;
    if (x + y > 2 * to + 400) { const d = (p * (1 - q)) / (p * (1 - q) + (1 - p) * q); return x === y ? d : x > y ? p + (1 - p) * d : p * d; }
    const k = `${x},${y}`;
    if (memo.has(k)) return memo.get(k);
    const n = x + y, first = ((n + 1) >> 1) % 2 === 0; // pontos 0 | 1,2 | 3,4 ...: quem começou serve nos blocos pares
    const w = first ? p : 1 - q;
    const v = w * go(x + 1, y) + (1 - w) * go(x, y + 1);
    memo.set(k, v);
    return v;
  };
  return go(0, 0);
}
function setRef(ph, pa, noAd) {
  const gh = gameRef(ph, noAd), ga = gameRef(pa, noAd), tb = tbRef(ph, pa, 7);
  const memo = new Map();
  const go = (x, y) => { // x, y = games de casa e fora; casa serve o 1º game
    if ((x >= 6 && x - y >= 2) || x === 7) return 1;
    if ((y >= 6 && y - x >= 2) || y === 7) return 0;
    if (x === 6 && y === 6) return tb;
    const k = `${x},${y}`;
    if (memo.has(k)) return memo.get(k);
    const w = (x + y) % 2 === 0 ? gh : 1 - ga;
    const v = w * go(x + 1, y) + (1 - w) * go(x, y + 1);
    memo.set(k, v);
    return v;
  };
  return go(0, 0);
}
for (const p of [0.5, 0.62, 0.71, 0.8]) for (const noAd of [false, true]) near(TN.gameP(p, 0, 0, noAd), gameRef(p, noAd), 1e-12, 'game do 0-0', p, noAd);
for (const [x, y] of [[2, 1], [3, 3], [4, 3], [3, 4], [1, 3]]) {
  const p = 0.64, memo = (a, b) => (a >= 4 && a - b >= 2 ? 1 : b >= 4 && b - a >= 2 ? 0 : a >= 3 && b >= 3 && a === b ? (p * p) / (p * p + (1 - p) ** 2) : p * memo(a + 1, b) + (1 - p) * memo(a, b + 1));
  near(TN.gameP(p, x, y, false), memo(x, y), 1e-12, 'game a meio', x, y);
}
for (const [p, q] of [[0.65, 0.6], [0.7, 0.72], [0.55, 0.8]]) {
  near(TN.tbP(p, q, 0, 0, 0, 7), tbRef(p, q, 7), 1e-9, 'tie-break a 7', p, q);
  near(TN.tbP(p, q, 0, 0, 0, 10), tbRef(p, q, 10), 1e-9, 'super tie-break a 10', p, q);
}
for (const [ph, pa] of [[0.66, 0.6], [0.72, 0.7], [0.58, 0.75]]) {
  const d = TN.setDist(ph, pa, 0, { noAd: false });
  let t = 0, w = 0;
  for (let i = 0; i < d.length; i++) { t += d[i]; if (i < 7) w += d[i]; } // os 7 primeiros: a casa ganha (6-0 … 7-6)
  near(t, 1, 1e-9, 'placares do set somam 1');
  near(w, setRef(ph, pa, false), 1e-9, 'set ganho pela casa', ph, pa);
}
// a simulação ponto a ponto bate com as contas (jogo sem diferença de forma entre simulações: s = t = 0)
for (const F of [{ need: 2, noAd: false, stb: false }, { need: 3, noAd: false, stb: false }, { need: 2, noAd: true, stb: true }]) {
  const P = { a: 0.55, b: 0.35, s: 0, t: 0 }, ph = sig(P.a), pa = sig(P.b);
  const E = { F, P, A: {}, live: null, S: TN.simulate(P, F, null) };
  let home = 0, first = 0, tb1 = 0;
  for (let i = 0; i < TN.N; i++) { const R = TN.fullR(E, i); if (R.h > R.a) home++; if (R.sets[0][0] > R.sets[0][1]) first++; if (R.sets[0][0] + R.sets[0][1] === 13) tb1++; }
  // 1º set: casa serve primeiro em metade das simulações (sorteio); a média das duas ordens
  const s1 = (setRef(ph, pa, F.noAd) + 1 - setRef(pa, ph, F.noAd)) / 2;
  const se = Math.sqrt(0.25 / TN.N) * 4;
  near(first / TN.N, s1, se, `simulação: 1º set (${JSON.stringify(F)})`);
  // a partida, sets independentes (aproximação: quem serve 1º em cada set depende do anterior — diferença pequena)
  const s = s1, n = F.need;
  let pm = 0;
  if (F.stb) pm = s * s + 2 * s * (1 - s) * tbRef((ph + 1 - pa) / 2, (pa + 1 - ph) / 2, 10);
  else { const C = (a, b) => { let r = 1; for (let i = 1; i <= b; i++) r = (r * (a - b + i)) / i; return r; }; for (let k = 0; k < n; k++) pm += C(n - 1 + k, k) * s ** n * (1 - s) ** k; }
  near(home / TN.N, pm, 0.02, `simulação: partida (${JSON.stringify(F)})`);
  ok(tb1 > 0, 'a simulação tem tie-breaks');
}

/* ---------------- 2. placar ao vivo ---------------- */
console.log('2. placar ao vivo (estatísticas da MoviOdds)');
const HN = 'Ana Casa', AN = 'Rita Fora';
// sets = ['HHAHA…'] (quem ganhou cada game; casa serve o 1º game da partida, serviço alterna); 'T'/'U' = tie-break ganho por casa/fora
function stats({ sets, point = ['0', '0'], serving, format = 'best_of_3', home = HN, away = AN, tbScore = [7, 4] }) {
  const summary = [], hs = [], as = [];
  let n = 0;
  sets.forEach((s, k) => {
    let h = 0, a = 0;
    for (const c of s) {
      const srvHome = n % 2 === 0;
      n++;
      if (c === 'T' || c === 'U') { summary.push(`Set ${k + 1} tie break score ${c === 'T' ? tbScore.join('-') : [...tbScore].reverse().join('-')}`); c === 'T' ? h++ : a++; continue; }
      const w = c === 'H' ? home : away, held = (c === 'H') === srvHome;
      summary.push(`Game ${summary.length + 1} - ${w} - ${held ? 'holds' : 'breaks'} to 30`);
      c === 'H' ? h++ : a++;
    }
    hs.push(h); as.push(a);
  });
  // o número do game no resumo conta também os tie-breaks (a MoviOdds numera todas as linhas)
  const srvHome = serving ?? n % 2 === 0;
  return { current_set: sets.length, format, home: { sets: hs, point: point[0], serving: srvHome, aces: 3, double_faults: 1 }, away: { sets: as, point: point[1], serving: !srvHome, aces: 1, double_faults: 2 }, summary };
}
const S6 = 'HAHAHAHAHAHA'; // 6-6
const L1 = TN.liveFromStats(stats({ sets: ['HHAHAH'], point: ['30', '15'] }), HN, AN);
ok(L1 && JSON.stringify(L1.cur) === '[4,2]' && JSON.stringify(L1.pt) === '[2,1]' && L1.gsrv === 0 && L1.f === 0 && !L1.tb && L1.log.length === 6, 'a meio do 1º set', JSON.stringify(L1));
ok(L1 && L1.log[1].srv === 'away' && L1.log[1].w === 'home' && L1.log[1].lp === 30, 'game 2 = quebra da casa', JSON.stringify(L1?.log[1]));
ok(JSON.stringify(TN.liveFromStats(stats({ sets: ['HHA'], point: ['A', '40'] }), HN, AN)?.pt) === '[4,3]', 'vantagem');
ok(TN.liveFromStats(stats({ sets: ['HHA'], point: ['A', '30'] }), HN, AN) === null, 'vantagem sem 40 do outro → nulo');
ok(TN.liveFromStats(stats({ sets: ['HHA'], point: ['50', '0'] }), HN, AN) === null, 'pontos estranhos → nulo');
// 6-6, casa serviu o 1º ponto do tie-break; ao 6º ponto (3-2 jogados) serve a de fora
const Ltb = TN.liveFromStats(stats({ sets: [S6], point: ['3', '2'], serving: false }), HN, AN);
ok(Ltb && Ltb.tb && JSON.stringify(Ltb.pt) === '[3,2]' && JSON.stringify(Ltb.cur) === '[6,6]', 'tie-break a decorrer', JSON.stringify(Ltb));
// no tie-break, ao ponto 6 (3-2 = 5 jogados) serve quem não começou: começou a casa (12 games → casa serve o 13º)
ok(Ltb && Ltb.gsrv === 0, 'tie-break: quem serviu o 1º ponto', Ltb?.gsrv);
const Lbetween = TN.liveFromStats(stats({ sets: ['HHHAHAHAH'] }), HN, AN);
ok(Lbetween && JSON.stringify(Lbetween.sets) === '[[6,3]]' && JSON.stringify(Lbetween.cur) === '[0,0]' && JSON.stringify(Lbetween.won) === '[1,0]', 'entre sets (6-3 acabado)', JSON.stringify(Lbetween));
const L2 = TN.liveFromStats(stats({ sets: ['HHHAHAHAH', S6 + 'U', 'AH'], point: ['15', '40'] }), HN, AN);
ok(L2 && JSON.stringify(L2.sets) === '[[6,3],[6,7]]' && L2.log.find((e) => e.tb)?.tbScore?.join('-') === '4-7', '3º set depois de tie-break', JSON.stringify(L2?.sets));
const H2 = 'Ana/Bia', A2 = 'Rita/Sara';
const Lstb = TN.liveFromStats(stats({ sets: ['HHHAHAHAH', 'AAAHAHAHA', ''], point: ['5', '3'], home: H2, away: A2 }), H2, A2);
ok(Lstb && Lstb.stb && JSON.stringify(Lstb.pt) === '[5,3]' && JSON.stringify(Lstb.won) === '[1,1]', 'duplas: super tie-break a decorrer', JSON.stringify(Lstb));
ok(TN.liveFromStats(stats({ sets: ['HHHAHAHAH', 'AAAHAHAHA', 'H'], home: H2, away: A2 }), H2, A2) === null, 'duplas: super tie-break acabado (partida acabada) → nulo');
ok(TN.liveFromStats(stats({ sets: ['HHHHHH', 'HHHHHH'] }), HN, AN) === null, 'partida acabada → nulo');
const st5 = stats({ sets: ['HHHAHAHAH', 'AAAHAHAHA', 'HHHHHH', 'A'], format: 'best_of_5', point: ['0', '15'] });
ok(TN.liveFromStats(st5, HN, AN)?.need === 3, 'melhor de 5');
{ const s = stats({ sets: ['HHAHAH'] }); s.summary.pop(); ok(TN.liveFromStats(s, HN, AN) === null, 'resumo atrasado (falta um game) → nulo'); }
{ const s = stats({ sets: ['HHAHAH'] }); s.summary[2] = s.summary[2].replace(AN, 'Outra Pessoa'); ok(TN.liveFromStats(s, HN, AN) === null, 'nome desconhecido no resumo → nulo'); }
{ const s = stats({ sets: ['HHAHAH'] }); s.summary[0] = s.summary[0].replace(HN, AN); ok(TN.liveFromStats(s, HN, AN) === null, 'vencedores do resumo ≠ placar → nulo'); }
{ const s = stats({ sets: ['HHAHAH'] }); s.home.serving = false; s.away.serving = false; ok(TN.liveFromStats(s, HN, AN) === null, 'sem quem serve → nulo'); }
{ const s = stats({ sets: ['HHAHAH'] }); s.away.sets = [2, 0]; ok(TN.liveFromStats(s, HN, AN) === null, 'listas de sets diferentes → nulo'); }

/* ---------------- 3. jogos reais ---------------- */
function itemsOf(list) { return list.map((x) => ({ key: x.s.key, q: x.q, odds: x.s.odds, name: x.s.name })); }
const diffs = { pre: {}, live: {} };
const LINE_K = new Set(['gtotal', 'tsgt', 'tpgw', 'ttb', 'tbrk', 'tpbrk', 'tsbt', 'tmrt']);
const times = { build: [], browser: [] };
function runGame(ev, L, label) {
  const sels = M.selections(ev);
  for (const s of sels) s.bb = TN.supports(s) ? 1 : 0;
  const m = { home: ev.home.name, away: ev.away.name, league: ev.league, sels: sels.map((s) => ({ market: s.market, per: s.per, pick: s.pick, line: s.line, odds: s.odds, locked: s.locked })) };
  if (L) m.live = L;
  const t0 = Date.now();
  const E = TN.build(m);
  times.build.push(Date.now() - t0);
  if (!E) return console.log(`  ${label}: motor desligado (${sels.filter((s) => s.bb && !s.locked).length} seleções abertas)`), null;
  E.v = 1;
  const byMk = {};
  for (const s of sels) (byMk[`${s.market}|${s.per ?? ''}|${LINE_K.has(s.market) ? s.line : ''}`] ||= []).push(s);
  const good = [];
  let off = 0;
  for (const s of sels) {
    if (!s.bb || s.locked) continue;
    const q = { market: s.market, per: s.per, pick: s.pick, line: s.line };
    const l = TN.legFor(E, q);
    if (!l) continue;
    const r = s.odds * l.p1;
    if (r < 0.4 || Math.log(r) > Math.log(1.25) + 0.15) off++; else good.push({ s, q });
    const g = byMk[`${s.market}|${s.per ?? ''}|${LINE_K.has(s.market) ? s.line : ''}`];
    if (g.length >= 2 && !g.some((x) => x.locked)) { const inv = g.reduce((t, x) => t + 1 / x.odds, 0); if (inv > 1 && inv < 1.4) (diffs[L ? 'live' : 'pre'][s.market] ||= []).push(l.p1 - fair(g.map((x) => x.odds))[g.indexOf(s)]); }
  }
  // grupos da simulação = regra da liquidação (public/markets.js) aplicada à simulação inteira
  let wrong = 0, n = 0;
  for (const { s, q } of good) {
    const b = TN.bitsOf(E, q);
    for (let t = 0; t < 120; t++) { const i = (t * 7919 + s.key.length * 131) % TN.N; n++; if ((M.legOutcome(q, TN.fullR(E, i)) === 1) !== !!bitOf(b, i)) wrong++; }
  }
  ok(!wrong, `${label}: ${wrong}/${n} simulações num grupo errado`);
  // ao vivo: o que já aconteceu está em todas as simulações
  if (L) {
    let past = 0;
    for (let i = 0; i < TN.N; i += 101) {
      const R = TN.fullR(E, i);
      if (L.sets.some((x, k) => JSON.stringify(R.sets[k]) !== JSON.stringify(x)) || JSON.stringify(R.log.slice(0, L.log.length)) !== JSON.stringify(L.log) || (R.aces && (R.aces[0] < L.aces[0] || R.aces[1] < L.aces[1]))) past++;
    }
    ok(!past, `${label}: ${past} simulações que mudam o passado`);
  }
  // combinações de 2 a 6
  const reasons = {};
  let quoted = 0, lo = 9, hi = 0;
  for (let t = 0; t < 250 && good.length >= 3; t++) {
    const k = Math.min(good.length, 2 + Math.floor(rnd() * 5)), pickd = [];
    while (pickd.length < k) { const x = good[Math.floor(rnd() * good.length)]; if (!pickd.includes(x)) pickd.push(x); }
    const items = itemsOf(pickd), r = TN.quote(E, items);
    if (r.reason) { const why = r.reason.replace(/"[^"]*"|\([^)]*\)/g, '…'); reasons[why] = (reasons[why] || 0) + 1; continue; }
    quoted++;
    const prod = items.reduce((a, i) => a * i.odds, 1);
    lo = Math.min(lo, r.odds / prod); hi = Math.max(hi, r.odds / prod);
    ok(Number.isFinite(r.odds) && r.odds >= 1.02, `${label}: odd inválida`, r.odds);
    ok(r.odds >= Math.max(...items.map((i) => i.odds)) - 1e-9, `${label}: odd abaixo da maior seleção`, r.odds, items.map((i) => i.odds));
    const why = firestoreOk({ odds: r.odds, params: r.params, src: items.map((i) => TN.srcOf(i.q)) });
    ok(!why, `${label}: o Firestore recusaria`, why);
    // gravado e lido do Firestore (JSON) → mesma odd; com uma seleção anulada → odd das que ficam
    // (refazer o motor dos parâmetros volta a simular o jogo, ~0,2 s: só nas primeiras combinações)
    if (quoted > 12) continue;
    const P2 = JSON.parse(JSON.stringify(r.params));
    ok(TN.quote(TN.fromParams(P2), items).odds === r.odds, `${label}: odd refeita dos parâmetros gravados ≠`);
    const kept = items.slice(1).map((i) => ({ src: JSON.parse(JSON.stringify(TN.srcOf(i.q))), odds: i.odds }));
    const rq = TN.requote(P2, kept);
    ok(rq >= 1 && Number.isFinite(rq), `${label}: anulação deu odd inválida`, rq);
    if (kept.length >= 2) { const r2 = TN.quote(TN.fromParams(P2), items.slice(1)); if (r2.odds) near(rq, r2.odds, 1e-9, `${label}: anulação ≠ odd das que ficam`); }
    else ok(rq === kept[0].odds, `${label}: anulação com uma só que fica ≠ odd dela`);
  }
  // navegador: modelo (JSON) → motor → as mesmas odds e as mesmas recusas
  const model = JSON.parse(JSON.stringify(TN.modelOf(E)));
  ok(!firestoreOk(model), `${label}: modelo para o navegador com listas dentro de listas`);
  const t1 = Date.now(), E2 = TN.fromParams(model);
  for (const x of good) TN.legFor(E2, x.q);
  times.browser.push(Date.now() - t1);
  let diff = 0;
  for (let t = 0; t < 40 && good.length >= 2; t++) {
    const items = itemsOf([0, 1, 2].map(() => good[Math.floor(rnd() * good.length)]).filter((x, i, a) => a.indexOf(x) === i));
    const a = TN.quote(E, items), b = TN.quote(E2, items);
    if (a.odds !== b.odds || a.reason !== b.reason) diff++;
  }
  ok(!diff, `${label}: navegador ≠ servidor em ${diff}/40`);
  // aba Criar aposta: odds de juntar com o vencedor escolhido
  const first = good.find((x) => x.s.market === 'ml') || good[0];
  if (first) { const pv = TN.preview(E, itemsOf([first]), itemsOf(good.filter((x) => x !== first))); ok(pv && typeof pv === 'object', `${label}: preview nulo`); }
  console.log(`  ${label}: ${good.length} seleções entram, ${off} fora pelo modelo · ${quoted} combinações com odd${quoted ? ` (${lo.toFixed(2)}–${hi.toFixed(2)}× as multiplicadas)` : ''} · recusadas ${JSON.stringify(reasons)}`);
  return E;
}
console.log(`3. jogos reais: ${D.pre.length} antes do jogo`);
for (const ev of D.pre) runGame(ev, null, `${ev.home.name} x ${ev.away.name}`);
console.log(`   ${D.live.length} ao vivo`);
for (const { ev, st, names } of D.live) {
  const L = st && names ? TN.liveFromStats(st, names.home, names.away) : null;
  if (!L) { console.log(`  ${ev.home.name} x ${ev.away.name}: placar das estatísticas não bate (motor desligado)`); continue; }
  runGame(ev, L, `AO VIVO ${ev.home.name} x ${ev.away.name} (${[...L.sets, L.cur].map((x) => x.join('-')).join(' ')} · ${L.pt.join('-')}${L.tb ? ' TB' : ''})`);
}
console.log('   modelo − bet365 (sem margem): média | desvio médio | maior');
for (const w of ['pre', 'live']) for (const [k, a] of Object.entries(diffs[w]).sort()) {
  const mean = a.reduce((x, y) => x + y, 0) / a.length, mad = a.reduce((x, y) => x + Math.abs(y), 0) / a.length;
  console.log(`   ${w === 'pre' ? 'antes ' : 'ao vivo'} ${k.padEnd(8)} n=${String(a.length).padStart(3)} ${(mean * 100).toFixed(1).padStart(5)}pp | ${(mad * 100).toFixed(1)}pp`);
  // antes do jogo a bet365 repete as odds do vencedor na corrida a 2, 3, 4 e 5 games (cotação preguiçosa): não serve de medida
  if (a.length >= 8 && !(w === 'pre' && k === 'tsrace')) ok(mad < (w === 'pre' ? 0.03 : 0.06), `modelo longe da bet365 em ${k} (${w})`, (mad * 100).toFixed(1) + 'pp');
}

/* ---------------- 4. jogos inventados: o ajuste recupera o jogo de onde vieram as odds ---------------- */
console.log('4. melhor de 5, tie-break e super tie-break ao vivo (odds inventadas)');
const SPECS = [
  { market: 'ml', picks: ['home', 'away'] },
  { market: 'gspread', line: 1.5, picks: ['home', 'away'], lines: [1.5, -1.5] },
  { market: 'gtotal', line: 22.5, picks: ['over', 'under'] },
  { market: 'tsw', per: 1, picks: ['home', 'away'] },
  { market: 'tsw', per: 2, picks: ['home', 'away'] },
];
function synthetic(P0, F, L, home, away, league, extra = []) {
  const E0 = { F, P: P0, A: {}, live: L, S: TN.simulate(P0, F, L) };
  const sels = [];
  const add = (q) => { const p = TN.N && (() => { let w = 0; for (let i = 0; i < TN.N; i += 3) w += M.legOutcome(q, TN.fullR(E0, i)) === 1; return w / Math.ceil(TN.N / 3); })(); return p; };
  for (const sp of [...SPECS, ...extra]) {
    const qs = sp.picks.map((pick, j) => ({ market: sp.market, per: sp.per, pick, line: sp.lines ? sp.lines[j] : sp.line }));
    if (!qs.every((q) => TN.supports(q))) continue;
    const ps = qs.map(add);
    if (ps.some((p) => p < 0.03)) continue;
    qs.forEach((q, j) => sels.push({ ...q, odds: Math.max(1.01, Math.round((1 / (ps[j] * 1.05)) * 100) / 100), locked: false }));
  }
  return { m: { home, away, league, sels, ...(L ? { live: L } : {}) }, E0 };
}
const CASES = [
  { label: 'melhor de 5 antes do jogo', P0: { a: 0.75, b: 0.45, s: 0.25, t: 0.1 }, F: { need: 3, noAd: false, stb: false }, extra: [{ market: 'sets', picks: ['3-0', '3-1', '3-2', '2-3', '1-3', '0-3'] }] },
  { label: 'melhor de 5 ao vivo (2-1 em sets)', P0: { a: 0.6, b: 0.55, s: 0.2, t: 0.1 }, F: { need: 3, noAd: false, stb: false }, st: st5 },
  { label: 'tie-break do 1º set ao vivo', P0: { a: 0.8, b: 0.7, s: 0.2, t: 0.1 }, F: { need: 2, noAd: false, stb: false }, st: stats({ sets: [S6], point: ['3', '2'], serving: false }) },
  { label: 'duplas: super tie-break ao vivo', P0: { a: 0.5, b: 0.4, s: 0.2, t: 0.1 }, F: { need: 2, noAd: true, stb: true }, st: stats({ sets: ['HHHAHAHAH', 'AAAHAHAHA', ''], point: ['5', '3'], home: H2, away: A2 }), dbl: true },
  { label: 'duplas antes do jogo', P0: { a: 0.45, b: 0.65, s: 0.2, t: 0.1 }, F: { need: 2, noAd: true, stb: true }, dbl: true },
];
for (const c of CASES) {
  const home = c.dbl ? H2 : HN, away = c.dbl ? A2 : AN;
  const L = c.st ? TN.liveFromStats(c.st, home, away) : null;
  if (c.st && !ok(L, `${c.label}: placar nulo`)) continue;
  const { m, E0 } = synthetic(c.P0, c.F, L, home, away, c.dbl ? 'ten.teste-duplas' : 'ten.teste', c.extra);
  const E = TN.build(m);
  if (!ok(E, `${c.label}: motor nulo`, m.sels.length, 'seleções')) continue;
  ok(JSON.stringify(E.F) === JSON.stringify(c.F), `${c.label}: formato errado`, JSON.stringify(E.F));
  const ml = TN.legFor(E, { market: 'ml', pick: 'home' }), ml0 = share(TN.bitsOf(E0, { market: 'ml', pick: 'home' }));
  near(ml.p1, ml0, 0.02, `${c.label}: vencedor longe do jogo verdadeiro`);
  // a primeira combinação de 3 (senão 2) seleções de mercados diferentes que o motor aceita
  const all = m.sels.map((s, i) => ({ key: 'k' + i, q: { market: s.market, per: s.per, pick: s.pick, line: s.line }, odds: s.odds, name: s.pick }));
  let items = [], r = { reason: 'nenhuma combinação aceite' };
  for (const n of [3, 2]) {
    for (let t = 0; t < 400 && !r.odds; t++) {
      const c = [];
      while (c.length < n) { const x = all[Math.floor(rnd() * all.length)]; if (!c.some((y) => y.q.market === x.q.market && y.q.per === x.q.per)) c.push(x); if (new Set(all.map((y) => y.q.market + y.q.per)).size < n) break; }
      if (c.length < n) break;
      const q = TN.quote(E, c);
      if (q.odds) { items = c; r = q; }
    }
    if (r.odds) break;
  }
  if (r.odds) {
    // a odd do motor contra a probabilidade verdadeira da combinação: margem positiva
    const pt = share(TN.jointBits(items.map((i) => TN.bitsOf(E0, i.q))) ? (() => { const b = items.map((i) => TN.bitsOf(E0, i.q)), o = new Uint32Array(b[0].length); for (let w = 0; w < o.length; w++) o[w] = b.reduce((x, y) => x & y[w], 0xffffffff); return o; })() : new Uint32Array(TN.N / 32));
    ok(pt === 0 || r.odds * pt < 1.03, `${c.label}: combinação com valor para o apostador`, r.odds, pt);
    console.log(`  ${c.label}: vencedor ${(ml.p1 * 100).toFixed(1)}% (verdadeiro ${(ml0 * 100).toFixed(1)}%) · ${items.map((i) => `${i.q.market}${i.q.per ? '/' + i.q.per : ''} ${i.q.pick}`).join(' + ')} = ${r.odds} (justa ${pt ? (1 / pt).toFixed(2) : '—'})`);
  } else console.log(`  ${c.label}: vencedor ${(ml.p1 * 100).toFixed(1)}% (verdadeiro ${(ml0 * 100).toFixed(1)}%) · combinação recusada: ${r.reason}`);
  const P2 = JSON.parse(JSON.stringify(TN.modelOf(E)));
  ok(!firestoreOk(P2), `${c.label}: listas dentro de listas no modelo`);
  if (r.odds) ok(TN.quote(TN.fromParams(P2), items).odds === r.odds, `${c.label}: navegador ≠ servidor`);
}
// ao vivo com ajuste mau (odds de outro momento do jogo) → motor desligado
{
  const L = TN.liveFromStats(stats({ sets: ['HHHHH'], point: ['40', '0'] }), HN, AN);
  const { m } = synthetic({ a: 0.6, b: 0.6, s: 0.2, t: 0.1 }, { need: 2, noAd: false, stb: false }, null, HN, AN, 'ten.teste');
  ok(TN.build({ ...m, live: L }) === null, 'ao vivo com odds do antes do jogo (5-0 no placar) → motor desligado');
}

const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
console.log(`\ntempos: montar o motor ${avg(times.build)} ms em média (máx. ${Math.max(...times.build)}) · navegador (modelo → todas as seleções) ${avg(times.browser)} ms (máx. ${Math.max(...times.browser)})`);
console.log(fails ? `\n${fails} FALHAS em ${checks} verificações` : `\ntudo certo (${checks} verificações)`);
process.exit(fails ? 1 : 0);
