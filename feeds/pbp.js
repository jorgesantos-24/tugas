'use strict';
/* Ténis: "ponto a ponto" como no Flashscore — para cada game, o placar depois de cada ponto (15:0, 15:15, 30:15...),
   quem sacou, se houve quebra e as marcas BP (break point), SP (set point) e MP (match point).

   Fonte: os placares do game que o WebSocket mandou (gravados por points.js) + o histórico oficial game a game
   ("summary": vencedor, quem servia e com quantos pontos do adversário acabou). Os placares que a bet365 corrigiu
   saem; os saltos sem dúvida (15:0 → 40:0 = 30:0 pelo meio) são preenchidos; um salto em que os dois sobem
   (15:0 → 30:15) fica como chegou e o índice entra em "gapAt" (faltam placares que não vimos).

   Saída (vai para o site em ev.stats.pbp):
   { cur: { s, tb }, sets: [{ n, tb: [casa, fora] | null, games: [{ g, sc: [casa, fora] depois do game, srv, w, brk, tb, cur, gap,
     pts: [[placar, marca]] }] }] } */

const POINTS = require('./points.js');
const BT = require('./btennis.js');
const TEN = require('./tennis.js');

const P = ['0', '15', '30', '40'];
const NORMAL = { 0: 0, 15: 1, 30: 2, 40: 3, A: 4 };
const other = (w) => (w === 'home' ? 'away' : 'home');

// placar de um game normal: [x, y] (0..3), 'D' (40:40), 'AH' / 'AA' (vantagem casa / fora)
function norm(h, a) {
  const x = NORMAL[h], y = NORMAL[a];
  if (x == null || y == null) return null;
  if (x === 4 && y === 3) return 'AH';
  if (y === 4 && x === 3) return 'AA';
  if (x === 4 || y === 4) return null;
  return x === 3 && y === 3 ? 'D' : [x, y];
}
const pre = (s) => Array.isArray(s);
const same = (a, b) => (pre(a) && pre(b) ? a[0] === b[0] && a[1] === b[1] : a === b);
const text = (s) => (pre(s) ? `${P[s[0]]}:${P[s[1]]}` : s === 'D' ? '40:40' : s === 'AH' ? 'A:40' : '40:A');
// a bet365 corrigiu? (do deuce não se volta a antes dele; antes do deuce o placar só sobe)
const reach = (a, b) => (pre(a) && pre(b) ? b[0] >= a[0] && b[1] >= a[1] : pre(a) ? true : !pre(b));
// quem está a um ponto de ganhar o game
function gpHolder(s) {
  if (pre(s)) return s[0] === 3 && s[1] < 3 ? 'home' : s[1] === 3 && s[0] < 3 ? 'away' : null;
  return s === 'AH' ? 'home' : s === 'AA' ? 'away' : null;
}

/* de cur para s, com os placares do meio quando não há dúvida; devolve [lista, houve salto] */
function path(cur, s) {
  const out = [];
  let gap = false;
  const T = s === 'D' ? [3, 3] : s; // até ao 40:40 conta como [3, 3]
  if (pre(cur) && pre(T)) {
    const dx = T[0] - cur[0], dy = T[1] - cur[1];
    if (dx < 0 || dy < 0) return [[s], true];
    if (dx === 0 || dy === 0) {
      let [x, y] = cur;
      while (x < T[0] || y < T[1]) { if (x < T[0]) x++; else y++; out.push(x === 3 && y === 3 ? 'D' : [x, y]); }
      if (!out.length || !same(out[out.length - 1], s)) out.push(s);
      return [out, false];
    }
    // os dois subiram: só se sabe o fim (dois pontos em ordem desconhecida)
    if (dx + dy > 1) gap = true;
    return [[s], gap];
  }
  if (pre(cur)) { // de antes do deuce para uma vantagem
    const [l, g] = path(cur, 'D');
    return [[...l, s], g];
  }
  // dentro do deuce: um passo de cada vez
  const step = { D: ['AH', 'AA'], AH: ['D'], AA: ['D'] };
  if (step[cur].includes(s)) return [[s], false];
  if (cur === s) return [[], false];
  return [['D', s], true]; // AH → AA: passou pelo 40:40
}

/* placares de um game normal, limpos e completos onde se pode */
function gameStates(obs, end) {
  const seen = [];
  for (const o of obs) {
    const s = norm(o.h, o.a);
    if (!s || (pre(s) && s[0] === 0 && s[1] === 0)) continue;
    while (seen.length && !reach(seen[seen.length - 1], s)) seen.pop(); // correção da bet365
    if (seen.length && same(seen[seen.length - 1], s)) continue;
    seen.push(s);
  }
  // nada visto deste game (ex.: servidor reiniciado): não se inventa a sequência
  if (!seen.length) return { states: [], gaps: [], none: true };
  // fim do game (do histórico): o último placar antes do ponto que o fechou
  if (end && end.lp != null) {
    const L = NORMAL[end.lp] ?? null;
    const fin = L == null ? null : L < 3 ? (end.w === 'home' ? [3, L] : [L, 3]) : end.w === 'home' ? 'AH' : 'AA';
    const last = seen[seen.length - 1];
    if (fin && !(last && same(last, fin)) && (!last || reach(last, fin))) seen.push(fin);
    // um placar visto que não leva ao fim do game (ex.: 40:15 visto, acabou "breaks to 40") fica; o resto mostra-se como veio
  }
  const out = [], gaps = [];
  let cur = [0, 0];
  for (const s of seen) {
    const [l, g] = path(cur, s);
    if (g) gaps.push(out.length); // faltam pontos antes deste placar
    for (const x of l) out.push(x);
    cur = s;
  }
  return { states: out, gaps };
}

/* tie-break: o placar só sobe, um ponto de cada vez */
function tbStates(obs, end) {
  const seen = [];
  for (const o of obs) {
    const h = Number(o.h), a = Number(o.a);
    if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h + a === 0) continue;
    if (!/^\d+$/.test(String(o.h)) || !/^\d+$/.test(String(o.a))) continue;
    while (seen.length && (seen[seen.length - 1][0] > h || seen[seen.length - 1][1] > a)) seen.pop();
    if (seen.length && seen[seen.length - 1][0] === h && seen[seen.length - 1][1] === a) continue;
    seen.push([h, a]);
  }
  if (!seen.length) return { states: [], gaps: [], none: true };
  if (end?.tbScore) {
    const [fh, fa] = end.tbScore, fin = fh > fa ? [fh - 1, fa] : [fh, fa - 1];
    const last = seen[seen.length - 1];
    if (fin[0] + fin[1] > 0 && !(last && last[0] === fin[0] && last[1] === fin[1]) && (!last || (fin[0] >= last[0] && fin[1] >= last[1]))) seen.push(fin);
  }
  const out = [];
  const gaps = [];
  let x = 0, y = 0;
  for (const [h, a] of seen) {
    const dx = h - x, dy = a - y;
    if (dx < 0 || dy < 0) continue;
    if (dx && dy) { if (dx + dy > 1) gaps.push(out.length); out.push([h, a]); }
    else { while (x < h || y < a) { if (x < h) x++; else y++; out.push([x, y]); } }
    x = h; y = a;
  }
  return { states: out, gaps };
}

// ganhar este game fecha o set? (games antes do game: gh/ga)
const setWin = (mine, theirs) => mine + 1 >= 6 && mine + 1 - theirs >= 2;

/* o "ponto a ponto" de um jogo ao vivo; null quando o histórico não bate certo com o placar */
function build(id, st, home, away) {
  if (!st?.home || !st?.away) return null;
  const L = BT.liveFromStats(st, home, away);
  let log = L?.log;
  if (!log) {
    const sets = (st.home.sets || []).map((h, i) => [Number(h), Number(st.away.sets?.[i])]);
    log = TEN.gameLog({ home, away, stats: st }, sets);
  }
  if (!Array.isArray(log)) return null;
  const need = /best_of_5/.test(String(st.format ?? '')) ? 3 : 2;
  const m = POINTS._matches.get(String(id));
  const obsOf = (gi, e) => {
    const G = m?.games[gi];
    if (!G) return [];
    if (e && ((G.s && G.s !== e.s) || (G.g && !e.tb && G.g !== e.g))) return []; // gravado noutro game
    let obs = G.obs;
    // placares do fim do game anterior que chegaram já com este: saem do início
    const prev = m.games[gi - 1]?.obs.slice(-3) || [];
    let cut = 0;
    while (cut < obs.length && prev.some((p) => p.h === obs[cut].h && p.a === obs[cut].a) && !(obs[cut].h === '0' && obs[cut].a === '0')) cut++;
    return cut ? obs.slice(cut) : obs;
  };

  const sets = [];
  const won = [0, 0];
  let gh = 0, ga = 0, curSet = 0;
  const mark = (holder, srv, s, isTb, deciding) => {
    if (!holder) return '';
    const mine = holder === 'home' ? gh : ga, theirs = holder === 'home' ? ga : gh;
    const out = [];
    if (!isTb && srv && holder !== srv) out.push('BP');
    // set / match point: ganhar este ponto fecha o set
    let closes;
    if (isTb) {
      const [x, y] = holder === 'home' ? s : [s[1], s[0]];
      closes = deciding ? x >= 9 && x > y : x >= 6 && x > y; // set decisivo: pode ser tie-break de 10 (só marca quando é certo)
    } else closes = setWin(mine, theirs);
    if (closes) out.push(won[holder === 'home' ? 0 : 1] + 1 >= need ? 'MP' : 'SP');
    return out.join(' ');
  };
  const push = (e, gi, isCur) => {
    if (e.s !== curSet) { curSet = e.s; gh = 0; ga = 0; sets.push({ n: e.s, tb: null, games: [] }); }
    const set = sets[sets.length - 1];
    const isTb = !!e.tb;
    const deciding = won[0] === need - 1 && won[1] === need - 1;
    const obs = obsOf(gi, isCur ? null : e);
    // quem saca neste game: histórico (games acabados) ou a mensagem ao vivo (game a decorrer)
    const srv = isTb ? null : e.srv || (isCur ? (st.home.serving ? 'home' : st.away.serving ? 'away' : null) : null);
    const { states, gaps, none } = isTb ? tbStates(obs, isCur ? null : e) : gameStates(obs, isCur ? null : e);
    const pts = states.map((s) => {
      const holder = isTb ? (s[0] >= 6 && s[0] > s[1] ? 'home' : s[1] >= 6 && s[1] > s[0] ? 'away' : null) : gpHolder(s);
      return [isTb ? `${s[0]}:${s[1]}` : text(s), mark(holder, srv, s, isTb, deciding)];
    });
    const g = { g: e.g, srv, tb: isTb, pts };
    if (gaps.length) g.gapAt = gaps;
    if (none && !isCur) { g.none = true; if (e.lp != null) g.lp = e.lp; }
    if (isCur) { g.cur = true; g.sc = [gh, ga]; }
    else {
      if (e.w === 'home') gh++; else ga++;
      g.w = e.w; g.sc = [gh, ga];
      if (srv && e.w !== srv) g.brk = true;
      if (isTb && e.tbScore) set.tb = e.tbScore;
      // fim do set?
      if (isTb || setWin(e.w === 'home' ? gh - 1 : ga - 1, e.w === 'home' ? ga : gh)) won[e.w === 'home' ? 0 : 1]++;
    }
    set.games.push(g);
  };
  log.forEach((e, i) => push(e, i + 1, false));
  // game a decorrer (só se o placar de agora bate certo)
  if (L) {
    const lastSet = log.length ? log[log.length - 1].s : 1;
    const setDone = L.cur[0] === 0 && L.cur[1] === 0 && log.length > 0;
    const s = setDone ? lastSet + 1 : lastSet || 1;
    push({ s, g: L.cur[0] + L.cur[1] + 1, tb: L.tb || L.stb }, log.length + 1, true);
  }
  if (!sets.length) return null;
  return { cur: L ? { s: sets[sets.length - 1].n, tb: !!(L.tb || L.stb) } : null, need, sets };
}

module.exports = { build, gameStates, tbStates };
