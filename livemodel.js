'use strict';
/* Motor de odds ao vivo dos eventos da equipa (eSports e outros jogos decididos por rounds).

   As regras do jogo ficam no campeonato (painel → Esportes e mercados → Modalidades e campeonatos):
   quantos rounds ganham um mapa, como é a prorrogação, melhor de quantos mapas e a margem da casa.

   Modelo: cada round é ganho pela casa com probabilidade p (rounds independentes), ajustada por mapa:
   - quem escolheu o mapa joga um pouco melhor nele; o adversário escolhe o lado e começa no lado bom
     (1º tempo puxa para ele, 2º tempo para quem escolheu);
   - dentro do round em curso, os jogadores vivos (5v3...) mudam a chance desse round.
   - p é calibrado para que a chance de vitória na partida bata com a força definida pela equipa
     (por defeito, tirada das odds do mercado "Vencedor da partida");
   - a cada round marcado, conta-se exatamente a probabilidade de todos os desfechos possíveis
     (placar final do mapa e da série) e cada mercado automático recebe odds novas com a margem da casa;
   - handicaps e totais têm "linhas móveis": a cada round o motor procura a linha equilibrada (perto de 50/50),
     oferece-a com as vizinhas e tira do site as linhas antigas (as apostas já feitas nelas continuam valendo);
   - linhas com odd abaixo da odd mínima (regras do campeonato, 1.15 por defeito) ficam bloqueadas, para não
     oferecer apostas fáceis; o Vencedor só bloqueia quando está praticamente decidido (≥ 98,5%). */

const crypto = require('node:crypto');
// margem da casa (método "power") e escala de odds arredondada para baixo, como nas casas
const round2 = (n) => Math.round(n * 100) / 100;
function ladder(o) {
  const step = o < 2 ? 0.01 : o < 3 ? 0.02 : o < 4 ? 0.05 : o < 6 ? 0.1 : o < 10 ? 0.2 : o < 20 ? 0.5 : o < 50 ? 1 : 5;
  return round2(Math.floor((o + 1e-9) / step) * step);
}
// aplica a margem a probabilidades justas (soma 1): Σ p^k = 1 + margem
function priceWithMargin(probs, margin) {
  let lo = 0.3, hi = 1;
  for (let it = 0; it < 50; it++) { const k = (lo + hi) / 2; const s = probs.reduce((a, p) => a + (p > 0 ? p ** k : 0), 0); if (s > 1 + margin) lo = k; else hi = k; }
  const k = (lo + hi) / 2;
  return probs.map((p) => (p > 0 ? ladder(1 / p ** k) : null));
}
const M = { priceWithMargin };

const PRESETS = {
  r6: { label: 'Rainbow Six Siege (pro)', unit: 'rounds', mapName: 'mapa', target: 7, ot: 'blocks', otBlock: 3, bestOf: 1, margin: 7, minOdd: 1.15, lines: 3, endgame: 2, half: 6, pickEdge: 3, sideEdge: 6, aliveEdge: 3 },
  cs2: { label: 'Counter-Strike 2 (MR12)', unit: 'rounds', mapName: 'mapa', target: 13, ot: 'blocks', otBlock: 6, bestOf: 3, margin: 7, minOdd: 1.15, lines: 3, endgame: 3, half: 12, pickEdge: 3, sideEdge: 4, aliveEdge: 3 },
  valorant: { label: 'Valorant', unit: 'rounds', mapName: 'mapa', target: 13, ot: 'by2', otBlock: 2, bestOf: 3, margin: 7, minOdd: 1.15, lines: 3, endgame: 3, half: 12, pickEdge: 3, sideEdge: 3, aliveEdge: 3 },
};

// tipos de mercado com odds automáticas
const TYPES = {
  match: { label: 'Vencedor da partida', group: 'winner' },
  map_winner: { label: 'Vencedor do mapa', group: 'winner', map: true },
  map_total: { label: 'Total de rounds do mapa', group: 'total', map: true },
  map_handicap: { label: 'Handicap de rounds do mapa', group: 'handicap', map: true },
  maps_total: { label: 'Total de mapas', group: 'total' },
  maps_handicap: { label: 'Handicap de mapas', group: 'handicap' },
  // abertos só pelo sistema (pacote padrão de cada evento); "pre": só antes do jogo, "live": só ao vivo
  team_total: { label: 'Total de rounds da equipa no mapa', group: 'total', map: true, gen: true, pre: true },
  map_race: { label: 'Corrida a X rounds', group: 'special', map: true, gen: true },
  map_half_cs: { label: 'Placar exato do 1º tempo', group: 'special', map: true, gen: true, margin: 1.8 },
  map_margin: { label: 'Margem de vitória no mapa', group: 'special', map: true, gen: true, pre: true, margin: 1.6 },
  map_cs: { label: 'Placar exato do mapa', group: 'special', map: true, gen: true, pre: true, margin: 2.5 },
  series_cs: { label: 'Placar exato da série', group: 'special', gen: true, margin: 1.4 },
  series_both: { label: 'Ambas ganham um mapa', group: 'special', gen: true },
};
// ordem dos mercados dentro de cada bloco (Partida, Mapa 1, Mapa 2...)
const ORDER = ['match', 'maps_total', 'maps_handicap', 'series_cs', 'series_both', 'map_winner', 'map_total', 'map_handicap', 'team_total', 'map_race', 'map_half_cs', 'map_margin', 'map_cs'];

/* ---------- um mapa ---------- */
// quem ganhou o mapa com este placar ('h' | 'a'), ou null se ainda está a decorrer
function mapWinner(a, b, R) {
  const N = R.target, base = N - 1;
  if (R.ot === 'none' || a < base || b < base) return a >= N ? 'h' : b >= N ? 'a' : null;
  const x = a - base, y = b - base; // rounds jogados na prorrogação
  if (R.ot === 'by2') return Math.abs(x - y) >= 2 ? (x > y ? 'h' : 'a') : null;
  // prorrogação em blocos de B rounds: ganha quem fizer mais de metade do bloco; bloco empatado → novo bloco
  const B = R.otBlock, k = Math.floor(B / 2) + 1;
  let u = x, v = y;
  if (B % 2 === 0) { const m = Math.floor(Math.min(x, y) / (B / 2)); u -= m * B / 2; v -= m * B / 2; }
  return u >= k ? 'h' : v >= k ? 'a' : null;
}

/* ---------- chance de cada round ----------
   mod = { p, picks: [, 'h' | 'a' | null, ...] (índice = nº do mapa), alive: { n, x, y, h, a } | null }
   (p sozinho também serve: mapa neutro, sem vivos). Os ajustes vêm das regras, em pontos % por round:
   R.pickEdge (quem escolheu o mapa), R.sideEdge (lado bom), R.aliveEdge (peso dos jogadores vivos). */
const logit = (x) => Math.log(x / (1 - x)), sig = (z) => 1 / (1 + Math.exp(-z));
const EDGES = { pickEdge: 3, sideEdge: 0, aliveEdge: 3 };
const edgeOf = (R, k) => R[k] ?? PRESETS[R.preset]?.[k] ?? EDGES[k];
const pts = (x) => logit(Math.min(0.95, 0.5 + x / 100)); // pontos % acima de 50% -> desvio no logit
const asMod = (p) => (typeof p === 'number' ? { p } : p);
function roundP(mod, R, n, x, y) {
  let z = logit(mod.p);
  const pick = mod.picks?.[n];
  if (pick) {
    const s = pick === 'h' ? 1 : -1, H = halfOf(R), r = x + y;
    z += s * pts(edgeOf(R, 'pickEdge'));
    // o adversário de quem escolheu o mapa escolhe o lado: 1º tempo no lado bom, depois troca; prorrogação neutra
    if (H > 0 && r < 2 * H) z += (r < H ? -s : s) * pts(edgeOf(R, 'sideEdge'));
  }
  return sig(z);
}
// round em curso com h vivos da casa contra a vivos de fora: a vantagem conta mais quando restam poucos (2v1 > 5v4)
function aliveP(q, h, a, R) {
  if (h <= 0 && a <= 0) return q;
  if (a <= 0) return 0.995;
  if (h <= 0) return 0.005;
  return Math.min(0.995, Math.max(0.005, sig(logit(q) + (edgeOf(R, 'aliveEdge') * (h - a)) / Math.sqrt(h + a))));
}
// chance de a casa ganhar o próximo round a partir de x-y no mapa n (no placar atual, com os vivos)
function nextP(mod, R, n, x, y) {
  const q = roundP(mod, R, n, x, y), al = mod.alive;
  return al && al.n === n && al.x === x && al.y === y ? aliveP(q, al.h, al.a, R) : q;
}
const modKey = (mod, R, n) => {
  const al = mod.alive && mod.alive.n === n ? mod.alive : null;
  return `${mod.p}|${mod.picks?.[n] || ''}|${al ? `${al.x},${al.y},${al.h},${al.a}` : ''}|${halfOf(R)}|${edgeOf(R, 'pickEdge')}|${edgeOf(R, 'sideEdge')}|${edgeOf(R, 'aliveEdge')}`;
};

// distribuição do placar final do mapa n a partir de a-b: Map("h-a" -> probabilidade)
const distCache = new Map();
function mapDist(p, a, b, R, n = 1) {
  const mod = asMod(p);
  const ck = `${modKey(mod, R, n)}|${a}|${b}|${R.target}|${R.ot}|${R.otBlock}`;
  if (distCache.has(ck)) return distCache.get(ck);
  const out = new Map();
  let front = new Map([[`${a}-${b}`, 1]]);
  for (let step = 0; step < 300 && front.size; step++) {
    const next = new Map();
    for (const [key, pr] of front) {
      const [x, y] = key.split('-').map(Number);
      if (mapWinner(x, y, R)) { out.set(key, (out.get(key) || 0) + pr); continue; }
      if (pr < 1e-13) continue; // prorrogações infinitas: corta o que já não pesa nada
      const q = nextP(mod, R, n, x, y);
      next.set(`${x + 1}-${y}`, (next.get(`${x + 1}-${y}`) || 0) + pr * q);
      next.set(`${x}-${y + 1}`, (next.get(`${x}-${y + 1}`) || 0) + pr * (1 - q));
    }
    front = next;
  }
  if (distCache.size > 5000) distCache.clear();
  distCache.set(ck, out);
  return out;
}
// soma as probabilidades dos placares finais em que f(h, a) é verdade
const sumDist = (dist, f) => { let s = 0; for (const [k, pr] of dist) { const [h, a] = k.split('-').map(Number); if (f(h, a)) s += pr; } return s; };
const mapWinProb = (dist, R) => sumDist(dist, (h, a) => mapWinner(h, a, R) === 'h');

/* ---------- a série (melhor de N mapas) ---------- */
const needed = (bestOf) => Math.ceil(bestOf / 2);
// distribuição do placar final em mapas: Map("mh-ma" -> probabilidade)
function seriesDist(p, st, R) {
  const mod = asMod(p), W = needed(st.bestOf);
  const out = new Map();
  if (st.mh >= W || st.ma >= W) { out.set(`${st.mh}-${st.ma}`, 1); return out; }
  // cada mapa tem a sua chance (quem o escolheu); o mapa em jogo parte do placar atual
  const qCur = mapWinProb(mapDist(mod, st.a, st.b, R, st.mh + st.ma + 1), R);
  const rec = (mh, ma, pr) => {
    if (mh >= W || ma >= W) { out.set(`${mh}-${ma}`, (out.get(`${mh}-${ma}`) || 0) + pr); return; }
    const q = mh === st.mh && ma === st.ma ? qCur : mapWinProb(mapDist(mod, 0, 0, R, mh + ma + 1), R);
    rec(mh + 1, ma, pr * q);
    rec(mh, ma + 1, pr * (1 - q));
  };
  rec(st.mh, st.ma, 1);
  return out;
}
const seriesWinProb = (p, st, R) => sumDist(seriesDist(p, st, R), (h) => h >= needed(st.bestOf));

// p (chance de a casa ganhar cada round) que dá chance q de ganhar a partida a partir do estado st
// (extra.picks: com as escolhas de mapa, a força média continua a bater com as odds do Vencedor)
function calibrate(q, st, R, extra = {}) {
  q = Math.min(0.97, Math.max(0.03, q));
  let lo = 0.02, hi = 0.98;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (seriesWinProb({ picks: extra.picks, p: mid }, st, R) < q) lo = mid; else hi = mid; }
  return Math.round(((lo + hi) / 2) * 10000) / 10000;
}

/* ---------- estado ao vivo ----------
   live = { auto, p, bestOf, base: { mh, ma, a, b, history }, rounds: ['h', 'a', ...] }
   O placar é o "base" (definido no formulário) mais os rounds marcados com os botões (+1 / desfazer). */
function deriveState(live, R) {
  const bestOf = live?.bestOf || R.bestOf || 1, W = needed(bestOf);
  const b = live?.base || {};
  const st = { bestOf, mh: b.mh || 0, ma: b.ma || 0, a: b.a || 0, b: b.b || 0, history: [...(b.history || [])], over: false };
  // sequência de rounds de cada mapa (índice = mapa - 1), a partir do placar em que começou a ser contado:
  // serve para saber quem chegou primeiro a X rounds e quem ganhou cada round
  st.seqs = []; st.starts = [];
  let cur = st.mh + st.ma;
  st.starts[cur] = { a: st.a, b: st.b }; st.seqs[cur] = [];
  const finishMap = () => {
    const w = mapWinner(st.a, st.b, R);
    if (!w) return;
    st.history.push({ h: st.a, a: st.b });
    if (w === 'h') st.mh++; else st.ma++;
    if (st.mh >= W || st.ma >= W) st.over = true;
    else { st.a = 0; st.b = 0; cur++; st.starts[cur] = { a: 0, b: 0 }; st.seqs[cur] = []; }
  };
  finishMap(); // o placar base pode já fechar um mapa
  for (const r of live?.rounds || []) {
    if (st.over) break;
    if (r === 'h') st.a++; else st.b++;
    st.seqs[cur].push(r);
    finishMap();
  }
  st.over = st.mh >= W || st.ma >= W;
  st.curMap = st.over ? st.mh + st.ma : st.mh + st.ma + 1; // número do mapa em jogo (1, 2, 3...)
  return st;
}

/* ---------- mercados ---------- */
const num = (s) => { const m = String(s).match(/[+-]?\d+(?:[.,]\d+)?(?!.*\d)/); return m ? Number(m[0].replace(',', '.')) : null; };
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
function teamOf(name, ev) {
  const n = norm(name), h = norm(ev.home), a = norm(ev.away);
  const isH = n.includes(h) || (n && h.includes(n)), isA = n.includes(a) || (n && a.includes(n));
  return isH && !isA ? 'home' : isA && !isH ? 'away' : null;
}
/* Lê de cada seleção o lado e a linha (ex.: "FaZe Clan -2.5" → casa, -2.5; "Mais de 10.5" → over, 10.5).
   Devolve [{ side, line }] ou lança um erro com a seleção que não percebeu. */
function inferSels(type, sels, ev) {
  const g = TYPES[type].group;
  return sels.map((s) => {
    if (g === 'winner') {
      const side = teamOf(s.name, ev);
      if (!side) throw new Error(`"${s.name}": não reconheço como ${ev.home} nem ${ev.away}. Use o nome da equipa.`);
      return { side, line: null };
    }
    if (g === 'total') {
      const n = norm(s.name);
      const side = /\b(mais|over|acima)\b/.test(n) || /^\+/.test(n) ? 'over' : /\b(menos|under|abaixo)\b/.test(n) || /^-/.test(n) ? 'under' : null;
      const line = num(s.name);
      if (!side || line == null) throw new Error(`"${s.name}": escreva "Mais de 10.5" ou "Menos de 10.5".`);
      return { side, line: Math.abs(line) };
    }
    const side = teamOf(s.name.replace(/[+-]?\d+(?:[.,]\d+)?\s*$/, ''), ev);
    const m = String(s.name).match(/([+-]\d+(?:[.,]\d+)?)\s*$/);
    if (!side || !m) throw new Error(`"${s.name}": escreva a equipa e a linha com sinal, ex.: "${ev.home} -1.5".`);
    return { side, line: Number(m[1].replace(',', '.')) };
  });
}

// modelo do evento: força, escolhas de mapa e jogadores vivos (vêm do contexto montado pelo catalog.js)
const modOf = (ctx) => ({ p: ctx.p, picks: ctx.picks || null, alive: ctx.alive || null });
// distribuição que decide o mercado (placar do mapa ou da série); null se o mapa não existe
function marketDist(mk, ctx) {
  const { st, R } = ctx, mod = modOf(ctx);
  if (!TYPES[mk.auto.type].map) return seriesDist(mod, st, R);
  const n = mk.auto.map || 1;
  if (n > st.bestOf) return null;
  if (n <= st.history.length) { const f = st.history[n - 1]; return new Map([[`${f.h}-${f.a}`, 1]]); }
  if (st.over) return null; // a série acabou antes deste mapa: anula
  return n === st.curMap ? mapDist(mod, st.a, st.b, R, n) : mapDist(mod, 0, 0, R, n);
}
// o que um total conta: rounds dos dois (total do mapa / de mapas) ou só de uma equipa (total da equipa)
const metric = (mk) => (mk.auto.type === 'team_total' ? (mk.auto.team === 'home' ? (h) => h : (h, a) => a) : (h, a) => h + a);
// probabilidade de ganhar / perder (o resto é devolução) de uma seleção
function selOutcome(mk, s, dist, ctx) {
  const t = mk.auto.type;
  const W = needed(ctx.st.bestOf);
  if (t === 'match') { const ph = sumDist(dist, (h) => h >= W); return s.side === 'home' ? { win: ph, lose: 1 - ph } : { win: 1 - ph, lose: ph }; }
  if (t === 'map_winner') { const ph = sumDist(dist, (h, a) => mapWinner(h, a, ctx.R) === 'h'); return s.side === 'home' ? { win: ph, lose: 1 - ph } : { win: 1 - ph, lose: ph }; }
  if (TYPES[t].group === 'total') {
    const v = metric(mk);
    const over = sumDist(dist, (h, a) => v(h, a) > s.line), under = sumDist(dist, (h, a) => v(h, a) < s.line);
    return s.side === 'over' ? { win: over, lose: under } : { win: under, lose: over };
  }
  const m = (h, a) => (s.side === 'home' ? h - a : a - h) + s.line;
  return { win: sumDist(dist, (h, a) => m(h, a) > 0), lose: sumDist(dist, (h, a) => m(h, a) < 0) };
}
const groupKey = (mk, s) => (TYPES[mk.auto.type].group === 'winner' ? 'w' : TYPES[mk.auto.type].group === 'total' ? 'L' + s.line : 'H' + Math.abs(s.line));

const fmtLine = (l) => (l > 0 ? '+' + l : String(l));
const pairPrice = (pr, ctx) => M.priceWithMargin([pr, 1 - pr], ctx.margin).map((o) => Math.min(100, Math.max(1.01, o || 1.01)));
const tooEasy = (odds, ctx) => Math.min(...odds) < (ctx.minOdd || 1.15);

/* Linhas móveis (totais e handicaps): escolhe a linha mais equilibrada e as vizinhas (ctx.lines no total),
   cria as seleções que faltarem, atualiza as odds e esconde do site as outras linhas. */
function moveLines(mk, dist, ctx) {
  const g = TYPES[mk.auto.type].group, ev = ctx.ev;
  // probabilidade de "mais" (totais) ou de a casa cobrir (handicap) para cada linha .5 possível
  const v = metric(mk);
  const vals = [...dist.keys()].map((k) => k.split('-').map(Number)).map(([h, a]) => (g === 'total' ? v(h, a) : h - a));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const cand = [];
  if (g === 'total') for (let t = Math.max(0, lo - 1); t <= hi; t++) cand.push({ line: t + 0.5, p: sumDist(dist, (h, a) => v(h, a) > t + 0.5) });
  else for (let m = -hi - 1; m <= -lo; m++) cand.push({ line: m + 0.5, p: sumDist(dist, (h, a) => h - a + m + 0.5 > 0) });
  // linhas equivalentes (ex.: no R6 um mapa não acaba 7-6, logo "12.5" e "13.5" são a mesma aposta): fica só a primeira
  for (let i = cand.length - 1; i > 0; i--) if (Math.abs(cand[i].p - cand[i - 1].p) < 1e-9) cand.splice(i, 1);
  if (!cand.length) return 0;
  let main = 0;
  cand.forEach((c, i) => { if (Math.abs(c.p - 0.5) < Math.abs(cand[main].p - 0.5)) main = i; });
  const half = Math.floor((ctx.lines || 3) / 2);
  const want = cand.slice(Math.max(0, main - half), main + half + 1)
    .map((c) => ({ ...c, odds: pairPrice(c.p, ctx) })).filter((c) => c.p > 0.015 && c.p < 0.985 && !tooEasy(c.odds, ctx));
  let changed = 0;
  const ids = new Set(mk.sels.map((x) => x.id));
  const sel = (side, line, name) => {
    let x = mk.sels.find((y) => y.side === side && y.line === line);
    if (!x) {
      let id; do id = crypto.randomBytes(3).toString('hex').toUpperCase(); while (ids.has(id));
      ids.add(id);
      x = { id, name, odds: 1.01, result: null, side, line };
      mk.sels.push(x); changed++;
    }
    return x;
  };
  const keep = new Set();
  for (const c of want) {
    const pair = g === 'total'
      ? [sel('over', c.line, `Mais de ${c.line}`), sel('under', c.line, `Menos de ${c.line}`)]
      : [sel('home', c.line, `${ev.home} ${fmtLine(c.line)}`), sel('away', -c.line, `${ev.away} ${fmtLine(-c.line)}`)];
    pair.forEach((x, i) => {
      keep.add(x);
      if (x.odds !== c.odds[i] || x.locked || x.hidden) { x.odds = c.odds[i]; x.locked = false; x.hidden = false; changed++; }
    });
  }
  for (const x of mk.sels) {
    if (keep.has(x)) continue;
    // sem nenhuma linha boa (mercado praticamente decidido): as que estavam no site ficam lá, bloqueadas
    const next = want.length ? { locked: true, hidden: true } : { locked: true, hidden: !!x.hidden };
    if (!x.locked || !!x.hidden !== next.hidden) { Object.assign(x, next); changed++; }
  }
  // ordena por linha (os pares ficam juntos)
  const key = (x) => (g === 'total' ? x.line : x.side === 'home' ? x.line : -x.line);
  mk.sels.sort((a, b) => key(a) - key(b) || (a.side === 'over' || a.side === 'home' ? -1 : 1));
  return changed;
}

/* Recalcula as odds dos mercados automáticos (altera "markets" no sítio).
   Devolve quantas seleções mudaram. Mercados manuais, suspensos à mão ou liquidados ficam como estão. */
/* Reta final do mapa em jogo (handicaps e totais desse mapa):
   - 'final': alguém está a R.endgame rounds de fechar o mapa (ex.: 5-4 no R6) → só a linha equilibrada;
   - 'close': match point ou prorrogação → o mercado sai do site (fica só o Vencedor). */
function endgame(mk, ctx) {
  const { st, R } = ctx, eg = R.endgame ?? 2;
  if (!eg || !TYPES[mk.auto.type].map || (mk.auto.map || 1) !== st.curMap || st.over) return null;
  const mx = Math.max(st.a, st.b);
  return mx >= R.target - 1 ? 'close' : mx >= R.target - eg ? 'final' : null;
}

// mercado de um mapa que já acabou, ou que já não vai ser jogado (série decidida / mapa acima do "melhor de")
const mapClosed = (mk, st) => TYPES[mk.auto.type].map && ((mk.auto.map || 1) <= st.history.length || (mk.auto.map || 1) > st.bestOf || st.over);

/* ---------- mercados especiais (corrida, margem, placar exato, série) ---------- */
// chance de a casa chegar a X rounds antes da fora, a partir de a-b no mapa n
function raceProb(mod, R, n, a, b, X) {
  const memo = new Map();
  const f = (x, y) => {
    if (x >= X) return 1;
    if (y >= X) return 0;
    const k = x * 1000 + y;
    if (!memo.has(k)) { const q = nextP(mod, R, n, x, y); memo.set(k, q * f(x + 1, y) + (1 - q) * f(x, y + 1)); }
    return memo.get(k);
  };
  return f(a, b);
}
const isOT = (h, a, R) => R.ot !== 'none' && Math.min(h, a) >= R.target - 1;
// rounds do 1º tempo (R6: 6); campeonatos antigos sem o campo usam o do modelo escolhido
const halfOf = (R) => R.half ?? PRESETS[R.preset]?.half ?? 0;
// a seleção (margem de vitória / placar exato) ganha com este placar final do mapa?
function specialWins(mk, s, h, a, R) {
  const w = mapWinner(h, a, R);
  if (!w) return false;
  if (mk.auto.type === 'map_margin') { const m = s.side === 'home' ? h - a : a - h; return m >= s.band[0] && m <= s.band[1]; }
  if (s.score) return s.score === `${h}-${a}`;
  return s.ot === w && isOT(h, a, R);
}
// probabilidade de cada seleção (pela ordem de mk.sels); null = mercado decidido / fechado
function specialProbs(mk, ctx) {
  const { st, R } = ctx, mod = modOf(ctx), t = mk.auto.type, n = mk.auto.map || 1, cur = n === st.curMap;
  const two = (ph) => mk.sels.map((s) => (s.side === 'home' ? ph : 1 - ph));
  if (t === 'map_race') {
    const X = mk.auto.race, a = cur ? st.a : 0, b = cur ? st.b : 0;
    return a >= X || b >= X ? null : two(raceProb(mod, R, n, a, b, X));
  }
  if (t === 'map_half_cs') {
    // placar no fim do 1º tempo: percorre os rounds que faltam até ao intervalo
    const H = halfOf(R), a = cur ? st.a : 0, b = cur ? st.b : 0, r = H - a - b;
    if (r <= 0) return null;
    let front = new Map([[`${a}-${b}`, 1]]);
    for (let i = 0; i < r; i++) {
      const next = new Map();
      for (const [key, pr] of front) {
        const [x, y] = key.split('-').map(Number), q = nextP(mod, R, n, x, y);
        next.set(`${x + 1}-${y}`, (next.get(`${x + 1}-${y}`) || 0) + pr * q);
        next.set(`${x}-${y + 1}`, (next.get(`${x}-${y + 1}`) || 0) + pr * (1 - q));
      }
      front = next;
    }
    return mk.sels.map((s) => front.get(s.score) || 0);
  }
  if (t === 'series_cs') { const d = seriesDist(mod, st, R); return mk.sels.map((s) => d.get(s.score) || 0); }
  if (t === 'series_both') {
    if (st.mh >= 1 && st.ma >= 1) return null;
    const y = sumDist(seriesDist(mod, st, R), (h, a) => h >= 1 && a >= 1);
    return mk.sels.map((s) => (s.side === 'yes' ? y : 1 - y));
  }
  const d = cur ? mapDist(mod, st.a, st.b, R, n) : mapDist(mod, 0, 0, R, n);
  return mk.sels.map((s) => sumDist(d, (h, a) => specialWins(mk, s, h, a, R)));
}
// devolve null (fechar o mercado) ou quantas seleções mudaram
function priceSpecial(mk, ctx) {
  const raw = specialProbs(mk, ctx);
  const tot = raw ? raw.reduce((x, y) => x + y, 0) : 0;
  if (!(tot > 0)) return null;
  const pr = raw.map((q) => q / tot);
  if (pr.some((q) => q > 0.985)) return null; // praticamente decidido
  const offer = pr.map((q) => q >= 0.01); // desfechos quase impossíveis saem do site
  const fair = pr.filter((_, i) => offer[i]);
  if (fair.length < 2) return null;
  const sum = fair.reduce((x, y) => x + y, 0);
  const odds = M.priceWithMargin(fair.map((q) => q / sum), ctx.margin * (TYPES[mk.auto.type].margin || 1)).map((o) => Math.min(100, Math.max(1.01, o || 1.01)));
  if (mk.sels.length === 2 && tooEasy(odds, ctx)) return null; // corrida quase ganha: não deixa odd fácil
  let changed = 0, j = 0;
  mk.sels.forEach((s, i) => {
    const next = offer[i] ? { odds: odds[j++], locked: false, hidden: false } : { odds: s.odds, locked: true, hidden: true };
    if (next.odds !== s.odds || !!s.locked !== next.locked || !!s.hidden !== next.hidden) { Object.assign(s, next); changed++; }
  });
  return changed;
}

function reprice(markets, ctx) {
  let changed = 0;
  const close = (mk) => { for (const s of mk.sels) if (!s.locked || !s.hidden) { s.locked = true; s.hidden = true; changed++; } };
  for (const mk of markets) {
    if (!mk.auto || mk.status === 'settled' || !TYPES[mk.auto.type] || mk.sels.some((s) => !s.side)) continue;
    const T = TYPES[mk.auto.type];
    // mercados só de pré-jogo fecham quando o jogo começa
    if (T.pre && ctx.state && ctx.state !== 'pre') { close(mk); continue; }
    if (mapClosed(mk, ctx.st)) { close(mk); continue; }
    if (T.group === 'special') { const c = priceSpecial(mk, ctx); if (c == null) close(mk); else changed += c; continue; }
    const dist = marketDist(mk, ctx);
    const lines = T.group !== 'winner';
    const stage = lines ? endgame(mk, ctx) : null;
    if (stage === 'close') { close(mk); continue; }
    if (lines && dist && mk.auto.lines !== 'fixed') { changed += moveLines(mk, dist, stage === 'final' ? { ...ctx, lines: 1 } : ctx); continue; }
    const groups = new Map();
    for (const s of mk.sels) { const k = groupKey(mk, s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    for (const list of groups.values()) {
      const probs = list.map((s) => { if (!dist) return null; const o = selOutcome(mk, s, dist, ctx); return o.win + o.lose > 1e-9 ? o.win / (o.win + o.lose) : null; });
      const decided = probs.some((x) => x == null || x < 0.015 || x > 0.985);
      let odds;
      if (!decided) {
        const fair = list.length === 1 ? [probs[0], 1 - probs[0]] : probs.map((x) => x / probs.reduce((a, b) => a + b, 0));
        odds = M.priceWithMargin(fair, ctx.margin).slice(0, list.length).map((o) => Math.min(100, Math.max(1.01, o || 1.01)));
      }
      // linhas fixas: bloqueia também as que ficaram fáceis demais (odd abaixo da mínima)
      const easy = !decided && lines && tooEasy(odds, ctx);
      list.forEach((s, i) => {
        const next = decided || easy ? { locked: true, odds: decided ? s.odds : odds[i] } : { locked: false, odds: odds[i] };
        if (next.odds !== s.odds || !!s.locked !== next.locked || s.hidden) { s.odds = next.odds; s.locked = next.locked; s.hidden = false; changed++; }
      });
    }
  }
  return changed;
}
// quando o mercado já está decidido pelo placar, sugere o resultado de cada seleção (para liquidar)
function suggestSpecial(mk, ctx) {
  const { st, R } = ctx, t = mk.auto.type, n = mk.auto.map || 1;
  const all = (f) => Object.fromEntries(mk.sels.map((s) => [s.id, f(s)]));
  const byWinner = (w) => all((s) => ((s.side === 'home') === (w === 'h') ? 'won' : 'lost'));
  if (TYPES[t].map && (n > st.bestOf || (st.over && n > st.history.length))) return all(() => 'void'); // mapa não jogado
  if (t === 'map_race') {
    const i = n - 1;
    if (!st.seqs[i]) return null;
    let { a, b } = st.starts[i];
    const X = mk.auto.race;
    if (a >= X || b >= X) return null;
    for (const r of st.seqs[i]) { if (r === 'h') a++; else b++; if (a >= X) return byWinner('h'); if (b >= X) return byWinner('a'); }
    return n <= st.history.length ? all(() => 'void') : null;
  }
  if (t === 'map_half_cs') {
    const i = n - 1, H = halfOf(R);
    if (!st.seqs[i]) return null;
    let { a, b } = st.starts[i];
    if (a + b > H) return null; // a contagem começou depois do intervalo: a equipa decide
    for (const r of st.seqs[i]) { if (a + b >= H) break; if (r === 'h') a++; else b++; }
    return a + b < H ? null : all((s) => (s.score === `${a}-${b}` ? 'won' : 'lost'));
  }
  if (t === 'series_cs') return st.over ? all((s) => (s.score === `${st.mh}-${st.ma}` ? 'won' : 'lost')) : null;
  if (t === 'series_both') {
    const both = st.mh >= 1 && st.ma >= 1;
    return both || st.over ? all((s) => ((s.side === 'yes') === both ? 'won' : 'lost')) : null;
  }
  if (n > st.history.length) return null;
  const f = st.history[n - 1];
  return all((s) => (specialWins(mk, s, f.h, f.a, R) ? 'won' : 'lost'));
}
function suggest(mk, ctx) {
  if (!mk.auto || !TYPES[mk.auto.type] || mk.sels.some((s) => !s.side)) return null;
  const t = mk.auto.type;
  if (TYPES[t].group === 'special') return suggestSpecial(mk, ctx);
  if (t === 'match' || !TYPES[t].map) { if (!ctx.st.over) return null; }
  else if ((mk.auto.map || 1) > ctx.st.history.length) return ctx.st.over ? Object.fromEntries(mk.sels.map((s) => [s.id, 'void'])) : null;
  const dist = marketDist(mk, ctx);
  if (!dist) return Object.fromEntries(mk.sels.map((s) => [s.id, 'void']));
  return Object.fromEntries(mk.sels.map((s) => { const o = selOutcome(mk, s, dist, ctx); return [s.id, o.win > 0.999 ? 'won' : o.lose > 0.999 ? 'lost' : 'void']; }));
}

/* ---------- pacote padrão de mercados ---------- */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sameMarket = (m, a) => m.auto?.type === a.type && (m.auto.map || null) === (a.map || null) && (m.auto.race || null) === (a.race || null)
  && (m.auto.team || null) === (a.team || null);
// ordem: Partida primeiro, depois Mapa 1, 2, 3...; dentro de cada bloco pela ordem de ORDER
function sortMarkets(markets) {
  const rank = (m) => {
    if (!m.auto || !TYPES[m.auto.type]) return (parseInt(String(m.group || '').replace(/\D+/g, ''), 10) || 0) * 100000 + 99999;
    const map = TYPES[m.auto.type].map ? m.auto.map || 1 : 0;
    return map * 100000 + ORDER.indexOf(m.auto.type) * 1000 + (m.auto.race || (m.auto.team === 'away' ? 1 : 0));
  };
  markets.sort((a, b) => rank(a) - rank(b));
}
function addMarkets(markets, plan) {
  const ids = new Set(markets.flatMap((m) => [m.id, ...m.sels.map((s) => s.id)]));
  const newId = () => { let id; do id = crypto.randomBytes(3).toString('hex').toUpperCase(); while (ids.has(id)); ids.add(id); return id; };
  let made = 0;
  for (const x of plan) {
    const have = markets.find((m) => sameMarket(m, x.auto));
    if (have) { if (!have.group && x.group) have.group = x.group; continue; }
    const sels = (x.sels || []).map((s) => ({ id: newId(), odds: 1.01, result: null, line: null, locked: true, ...s }));
    markets.push({ id: newId(), name: x.name, status: 'open', maxStake: null, auto: x.auto, group: x.group || null, generated: true, sels, createdAt: Date.now(), createdBy: 'automático', settledAt: null });
    made++;
  }
  if (made) sortMarkets(markets);
  return made;
}
/* Abre os mercados padrão do evento (só os que faltam; as odds vêm do modelo):
   - série (melhor de 3, 5...): total e handicap de mapas, placar exato da série, ambas ganham um mapa;
   - cada mapa: vencedor (série), total e handicap de rounds, rounds de cada equipa*, corridas a X rounds,
     margem de vitória* e placar exato* (* só antes do jogo). Devolve quantos criou. */
function ensureMapMarkets(markets, ctx) {
  const { R, st, ev } = ctx;
  const U = R.unit, multi = st.bestOf > 1, W = needed(st.bestOf);
  const pair = () => [{ side: 'home', name: ev.home }, { side: 'away', name: ev.away }];
  const plan = [];
  if (multi) {
    const cs = [];
    for (let l = 0; l < W; l++) cs.push({ side: 'cs', name: `${ev.home} ${W}-${l}`, score: `${W}-${l}` });
    for (let l = W - 1; l >= 0; l--) cs.push({ side: 'cs', name: `${ev.away} ${W}-${l}`, score: `${l}-${W}` });
    plan.push(
      { name: `Total de ${R.mapName}s`, auto: { type: 'maps_total', lines: 'move' } },
      { name: `Handicap de ${R.mapName}s`, auto: { type: 'maps_handicap', lines: 'move' } },
      { name: 'Placar exato da série', auto: { type: 'series_cs' }, sels: cs },
      { name: `Ambas ganham um ${R.mapName}`, auto: { type: 'series_both' }, sels: [{ side: 'yes', name: 'Sim' }, { side: 'no', name: 'Não' }] },
    );
  }
  const races = [...new Set([Math.max(2, Math.round(R.target * 0.4)), R.target - 2])].filter((x) => x >= 2 && x < R.target).sort((a, b) => a - b);
  const k = Math.max(1, Math.round(R.target / 3.5));
  const bands = [[1, k], [k + 1, 2 * k], [2 * k + 1, 99]];
  const bandName = ([lo, hi]) => (hi >= 99 ? `por ${lo}+` : lo === hi ? `por ${lo}` : `por ${lo}-${hi}`);
  const maxLoser = R.ot === 'none' ? R.target - 1 : R.target - 2;
  // 1º tempo: todos os placares possíveis (R6: 6-0, 5-1, 4-2, 3-3, 2-4, 1-5, 0-6)
  const H = halfOf(R), halfSels = [];
  for (let x = H; x >= 0; x--) {
    const y = H - x;
    halfSels.push({ side: 'cs', score: `${x}-${y}`, name: x > y ? `${ev.home} ${x}-${y}` : x < y ? `${ev.away} ${y}-${x}` : `Empate ${x}-${y}` });
  }
  for (let n = 1; n <= st.bestOf; n++) {
    // melhor de 1: sem bloco "Mapa 1" nem prefixo no nome
    const g = multi ? `${cap(R.mapName)} ${n}` : null, pre = multi ? `${g} — ` : '';
    const cs = [];
    for (let l = 0; l <= maxLoser; l++) cs.push({ side: 'cs', name: `${ev.home} ${R.target}-${l}`, score: `${R.target}-${l}` });
    if (R.ot !== 'none') cs.push({ side: 'cs', name: `${ev.home} na prorrogação`, ot: 'h' });
    for (let l = 0; l <= maxLoser; l++) cs.push({ side: 'cs', name: `${ev.away} ${R.target}-${l}`, score: `${l}-${R.target}` });
    if (R.ot !== 'none') cs.push({ side: 'cs', name: `${ev.away} na prorrogação`, ot: 'a' });
    if (multi) plan.push({ name: pre + 'Vencedor', auto: { type: 'map_winner', map: n }, group: g, sels: pair() });
    plan.push(
      { name: pre + `Total de ${U}`, auto: { type: 'map_total', map: n, lines: 'move' }, group: g },
      { name: pre + `Handicap de ${U}`, auto: { type: 'map_handicap', map: n, lines: 'move' }, group: g },
      { name: pre + `${cap(U)} de ${ev.home}`, auto: { type: 'team_total', map: n, team: 'home', lines: 'move' }, group: g },
      { name: pre + `${cap(U)} de ${ev.away}`, auto: { type: 'team_total', map: n, team: 'away', lines: 'move' }, group: g },
      ...races.map((X) => ({ name: pre + `Corrida a ${X} ${U}`, auto: { type: 'map_race', map: n, race: X }, group: g, sels: pair() })),
      ...(H > 0 && H < 2 * R.target - 1 ? [{ name: pre + 'Placar exato do 1º tempo', auto: { type: 'map_half_cs', map: n }, group: g, sels: halfSels }] : []),
      { name: pre + 'Margem de vitória', auto: { type: 'map_margin', map: n }, group: g, sels: [...bands.map((b) => ({ side: 'home', name: `${ev.home} ${bandName(b)}`, band: b })), ...bands.map((b) => ({ side: 'away', name: `${ev.away} ${bandName(b)}`, band: b }))] },
      { name: pre + 'Placar exato', auto: { type: 'map_cs', map: n }, group: g, sels: cs },
    );
  }
  return addMarkets(markets, plan);
}
module.exports = { PRESETS, TYPES, mapWinner, mapDist, seriesDist, seriesWinProb, calibrate, deriveState, inferSels, reprice, suggest, needed, mapWinProb, ensureMapMarkets, sortMarkets, modOf, edgeOf };
