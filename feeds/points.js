'use strict';
/* Ténis ponto a ponto: a MoviOdds não guarda a ordem dos pontos de cada game — só manda, ao vivo, o placar do game
   atual ("15"-"30", "A"-"40"; no tie-break "5"-"3") a cada mudança (mensagem "stats" do WebSocket). Este módulo
   grava cada placar visto e, quando o game acaba (linha nova no "summary"), reconstrói a sequência dos pontos.

   O que se pode garantir:
   - até 40-40 o placar só sobe: cada estado aparece uma vez e um ponto perdido nota-se (15-0 → 30-15 = dois pontos
     em ordem desconhecida → essas posições ficam "não sei"). No tie-break o placar também só sobe;
   - no deuce (40-40 ⇄ V-40) o placar repete-se: dois pontos perdidos não deixam rasto. Só se aceita a sequência
     do deuce se cada mudança foi vista a menos de TRUST_S segundos da anterior (não dá tempo para dois pontos
     escondidos); senão as posições a partir daí ficam "não sei" (→ a seleção fica para a equipa);
   - a bet365 às vezes corrige um ponto (15-0 → 0-0): vale o placar mais recente (os anteriores incompatíveis saem);
   - o fim do game tem de bater certo com o "summary" (vencedor e pontos do adversário: "holds to 30").

   Resultado por game (chave "set/game"): { seq, k, n, bp, tb }
     seq = vencedor de cada ponto ('home' | 'away' | null = não se sabe), k = nº de posições seguras (as de seq
     depois de k podem estar deslocadas), n = total de pontos do game (null = não se sabe), bp = houve break point
     (true/false/null), tb = tie-break. */

const TRUST_S = Number(process.env.TENNIS_DEUCE_TRUST_S || 20); // tempo máximo entre dois placares do deuce para confiar
const DUP_S = 8;          // o mesmo placar visto de novo até 8 s depois = a mesma mensagem repetida (outra estatística mudou)
const KEEP_MS = 36 * 3600000;

const NORMAL = { 0: 0, 15: 1, 30: 2, 40: 3, A: 4 };
const other = (w) => (w === 'home' ? 'away' : 'home');

const matches = new Map(); // id do jogo → { games: { gi: { s, g, obs: [{ h, a, t, t2, sv }] } }, end: { gi: t }, at, dirty, savedAt }
let store = null;          // { load(), save(id, data) } — Firestore (opcional)

/* ---------- gravação ---------- */
function observe(id, st, t = Date.now()) {
  if (!st || (st.sport && st.sport !== 'tennis')) return;
  const hp = st.home?.point, ap = st.away?.point;
  if (hp == null || ap == null || !Array.isArray(st.summary)) return;
  id = String(id);
  let m = matches.get(id);
  if (!m) { m = { games: {}, end: {}, at: t, dirty: false, savedAt: 0 }; matches.set(id, m); }
  const done = st.summary.length, gi = done + 1;
  // games terminados: quando se viu a linha do summary pela primeira vez (fim do game)
  for (let i = 1; i <= done; i++) if (!m.end[i]) { m.end[i] = t; m.dirty = true; }
  const hg = Number(st.home?.games), ag = Number(st.away?.games);
  let G = m.games[gi];
  if (!G) G = m.games[gi] = { s: null, g: null, obs: [] };
  // set e nº do game: os da mensagem mais recente (a primeira de um game novo às vezes ainda traz o placar do anterior)
  G.s = Number(st.current_set) || G.s;
  if (Number.isFinite(hg + ag)) G.g = hg + ag + 1;
  const h = String(hp), a = String(ap);
  const sv = st.home?.serving ? 'home' : st.away?.serving ? 'away' : null;
  const last = G.obs[G.obs.length - 1];
  if (last && last.h === h && last.a === a && t - last.t2 <= DUP_S * 1000) { last.t2 = t; return; }
  G.obs.push({ h, a, t, t2: t, sv });
  m.at = t; m.dirty = true;
  maybeSave(id, m, t);
}

/* ---------- reconstrução ---------- */
// estado de um game normal: [x, y] (0..3 = 0/15/30/40), 'D' (40-40), 'AH' / 'AA' (vantagem casa / fora)
function normState(o) {
  const x = NORMAL[o.h], y = NORMAL[o.a];
  if (x == null || y == null) return null;
  if (x === 4 && y === 3) return 'AH';
  if (y === 4 && x === 3) return 'AA';
  if (x === 4 || y === 4) return null;
  if (x === 3 && y === 3) return 'D';
  return [x, y];
}
const isPre = (s) => Array.isArray(s);
// de [x, y] para [x2, y2] (só sobe): quem ganhou cada ponto, ou null nas posições de ordem desconhecida
function fill(seq, x, y, x2, y2) {
  const dx = x2 - x, dy = y2 - y;
  if (dx < 0 || dy < 0) return false;
  if (dx === 0) for (let i = 0; i < dy; i++) seq.push('away');
  else if (dy === 0) for (let i = 0; i < dx; i++) seq.push('home');
  else for (let i = 0; i < dx + dy; i++) seq.push(null);
  return true;
}
// pode passar de a para b? (para descartar placares que a bet365 corrigiu depois)
function reachable(a, b) {
  if (isPre(a) && isPre(b)) return b[0] >= a[0] && b[1] >= a[1];
  if (isPre(a)) return true;     // de antes do deuce para o deuce
  return !isPre(b);              // do deuce não se volta para trás
}

// game normal: e = entrada do histórico (w, srv, lp); obs = placares vistos; tEnd = quando acabou
function resolveGame(e, obs, tEnd) {
  const states = [];
  for (const o of obs) {
    const s = normState(o);
    if (!s) return null; // placar estranho (ex.: números de tie-break num game normal): não se confia neste game
    // correção da bet365: tira os placares anteriores que não levam a este
    while (states.length && !reachable(states[states.length - 1].s, s)) states.pop();
    states.push({ s, t: o.t, t2: o.t2 });
  }
  const L = e.lp == null ? null : NORMAL[e.lp]; // pontos do adversário no fim (3 = foi ao deuce)
  const seq = [];
  let cur = [0, 0], curT = null, exact = true, k = 0;
  const lose = () => { if (exact) { exact = false; k = seq.length; } };
  const trusted = (t1, t2) => t1 != null && t2 != null && (t2 - t1) / 1000 <= TRUST_S;
  // caminho mínimo do deuce: de st1 para st2 (passos de um ponto); devolve os vencedores ou null
  const deucePath = (a, b) => {
    const step = { D: { AH: ['home'], AA: ['away'] }, AH: { D: ['away'] }, AA: { D: ['home'] } };
    if (step[a]?.[b]) return step[a][b];
    if (a === 'AH' && b === 'AA') return ['away', 'away'];
    if (a === 'AA' && b === 'AH') return ['home', 'home'];
    if (a === b) return [];
    return null;
  };
  for (const { s, t, t2 } of states) {
    if (isPre(cur) && isPre(s)) { if (!fill(seq, cur[0], cur[1], s[0], s[1])) return null; }
    else if (isPre(cur)) {
      // até ao primeiro 40-40 (6 pontos)
      if (!fill(seq, cur[0], cur[1], 3, 3)) return null;
      // a partir do 40-40 podia ter havido voltas escondidas, se não foi visto logo (os 6 primeiros pontos ficam certos)
      if (!trusted(curT, t)) lose();
      seq.push(...(s === 'AH' ? ['home'] : s === 'AA' ? ['away'] : []));
    } else {
      const p = deucePath(cur, s);
      if (!p) return null;
      if (p.length !== 1 || !trusted(curT, t)) lose(); // repetido, salto de dois ou visto tarde demais
      seq.push(...p);
    }
    cur = s; curT = t2;
  }
  // último ponto(s) até ao fim do game
  const w = e.w;
  if (L == null) { lose(); }
  else if (L < 3) {
    // acabou antes do deuce: vencedor com 4, adversário com L
    if (!isPre(cur)) return null;
    const fin = w === 'home' ? [4, L] : [L, 4];
    if (!fill(seq, cur[0], cur[1], fin[0], fin[1])) return null;
  } else {
    if (isPre(cur)) {
      if (!fill(seq, cur[0], cur[1], 3, 3)) return null;
      cur = 'D';
      lose(); // do 40-40 ao fim sem nada visto: número de voltas desconhecido
    }
    const p = deucePath(cur, w === 'home' ? 'AH' : 'AA');
    if (!p) return null;
    if (p.length > 1 || !trusted(curT, tEnd)) lose();
    seq.push(...p, w);
  }
  if (exact) k = seq.length;
  const n = L != null && L < 3 ? 4 + L : exact ? seq.length : null;
  // confirmação: no fim, vencedor e pontos do adversário batem certo com a sequência (quando é toda conhecida)
  if (exact && seq.every(Boolean)) {
    const lostPts = seq.filter((x) => x !== w).length, won = seq.length - lostPts;
    if (L < 3 && (won !== 4 || lostPts !== L)) return null;
    if (L === 3 && won - lostPts !== 2) return null;
  }
  return { seq, k, n, bp: breakPoint(e, seq, k, states) };
}

// houve break point (quem recebe a um ponto de ganhar o game)? true/false/null
function breakPoint(e, seq, k, states) {
  const srv = e.srv;
  if (!srv) return null;
  const r = other(srv);
  if (e.w === r) return true; // quebrou: houve pelo menos um
  // algum placar visto já o mostra (40 de quem recebe contra menos de 40, ou vantagem de quem recebe)
  const bpState = (s) => (isPre(s) ? (r === 'home' ? s[0] === 3 && s[1] < 3 : s[1] === 3 && s[0] < 3) : s === (r === 'home' ? 'AH' : 'AA'));
  if (states.some((x) => bpState(x.s))) return true;
  // para dizer "não" é preciso a sequência inteira
  if (k < seq.length || seq.some((x) => !x)) return null;
  let x = 0, y = 0;
  for (const p of seq) {
    if (p === 'home') x++; else y++;
    const rp = r === 'home' ? x : y, sp = r === 'home' ? y : x;
    if (rp >= 3 && rp > sp) return true;
  }
  return false;
}

// tie-break: o placar só sobe (números); fim = placar do tie-break no summary
function resolveTb(e, obs) {
  const [fh, fa] = e.tbScore;
  const seq = [];
  let x = 0, y = 0;
  const pts = [];
  for (const o of obs) {
    const h = Number(o.h), a = Number(o.a);
    if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) continue; // "0"/"15" antes de começar o tie-break
    while (pts.length && (pts[pts.length - 1][0] > h || pts[pts.length - 1][1] > a)) pts.pop(); // correção da bet365
    pts.push([h, a]);
  }
  for (const [h, a] of pts) {
    if (h > fh || a > fa) return null;
    fill(seq, x, y, h, a); x = h; y = a;
  }
  if (!fill(seq, x, y, fh, fa)) return null;
  return { seq, k: seq.length, n: fh + fa, bp: null, tb: true };
}

/* Pontos de todos os games terminados de um jogo, a partir do histórico game a game (TEN.gameLog) → { "s/g": {...} } */
function resolve(id, log) {
  const m = matches.get(String(id));
  if (!Array.isArray(log)) return null;
  const out = {};
  log.forEach((e, i) => {
    const gi = i + 1, G = m?.games[gi];
    let obs = G ? G.obs : [];
    // placares do fim do game anterior que chegaram já com o game novo: saem do início
    const prev = m?.games[gi - 1]?.obs.slice(-3) || [];
    let cut = 0;
    while (cut < obs.length && prev.some((p) => p.h === obs[cut].h && p.a === obs[cut].a) && !(obs[cut].h === '0' && obs[cut].a === '0')) cut++;
    if (cut) obs = obs.slice(cut);
    // o game gravado tem de ser o mesmo do histórico (set e nº do game no set)
    if (G && ((G.s && G.s !== e.s) || (G.g && !e.tb && G.g !== e.g))) return;
    const r = e.tb ? (e.tbScore ? resolveTb(e, obs) : null) : resolveGame(e, obs, m?.end[gi] ?? null);
    if (r) out[`${e.s}/${e.g}`] = { ...r, tb: !!e.tb };
  });
  return out;
}

/* ---------- guardar (sobrevive a um reinício do servidor) ---------- */
function compact(m) { return { games: m.games, end: m.end, at: m.at }; }
function maybeSave(id, m, t) {
  if (!store || !m.dirty) return;
  // no fim de cada game e, no máximo, a cada 60 s
  const gameEnded = Object.keys(m.end).length !== m.savedEnds;
  if (!gameEnded && t - m.savedAt < 60000) return;
  m.dirty = false; m.savedAt = t; m.savedEnds = Object.keys(m.end).length;
  store.save(id, compact(m)).catch((e) => { m.dirty = true; console.error(`[Pontos] não guardou ${id}: ${e.message}`); });
}
async function init(s) {
  store = s;
  try {
    const rows = await s.load(Date.now() - KEEP_MS);
    for (const [id, d] of rows) if (!matches.has(id)) matches.set(id, { games: d.games || {}, end: d.end || {}, at: d.at || 0, dirty: false, savedAt: Date.now(), savedEnds: Object.keys(d.end || {}).length });
    if (rows.length) console.log(`[Pontos] ${rows.length} jogos de ténis com pontos guardados`);
  } catch (e) { console.error('[Pontos] não leu os pontos guardados:', e.message); }
}
function flushAll() { const t = Date.now(); for (const [id, m] of matches) if (m.dirty) { m.savedAt = 0; maybeSave(id, m, t); } }
function cleanup(t = Date.now()) { for (const [id, m] of matches) if (t - m.at > KEEP_MS) matches.delete(id); }

module.exports = { observe, resolve, resolveGame, resolveTb, init, flushAll, cleanup, TRUST_S, _matches: matches };
