'use strict';
/* Placar de cada parte do jogo a partir das ESTATÍSTICAS da MoviOdds (ao vivo e no fim).

   Porquê as estatísticas e não os "periods" do resultado: comparado com a ESPN (24-26/10/2026), os "periods" do
   resultado põem os gols do acréscimo do 1º tempo no 2º tempo e os pontos do fim de cada quarto no quarto
   seguinte (errados em 6/6 jogos de futebol e 14/14 da NBA em que as duas leituras divergiam); as estatísticas
   estavam certas em todos. O total do jogo não muda (só a divisão entre partes).

   Cada leitura é verificada por duas vias quando a fonte o permite:
   - futebol: linha "Score After First Half - X-Y" (não pode ser maior que o placar atual)
   - basquete / hóquei: pontos/gols por período (stats.periods) têm de bater com as linhas "Score After 2nd Quarter"
     ou "Score After 1st Period" (acumuladas); uma parte só conta como TERMINADA quando a sua linha existe
   - e-Sports: rondas de cada mapa têm de dar os mapas ganhos */

const pair = (s) => { const m = /(\d+)\s*-\s*(\d+)\s*$/.exec(String(s ?? '')); return m ? [Number(m[1]), Number(m[2])] : null; };
const fin = (v) => Number.isFinite(v);

// futebol: placar ao intervalo (null enquanto não houver intervalo)
function soccerHT(st) {
  const t = (st?.timeline || []).find((x) => /Score After First Half/i.test(x.text || ''));
  return t ? pair(t.text) : null;
}

/* basquete (quartos) e hóquei (períodos): { list: [[c, f]...] por período, done: quantos estão terminados }
   ou null se as duas leituras não baterem certo. */
function periodsOf(st, word) {
  const hp = st?.home?.periods, ap = st?.away?.periods;
  if (!Array.isArray(hp) || !Array.isArray(ap) || !hp.length) return null;
  const n = Math.min(hp.length, ap.length);
  const list = Array.from({ length: n }, (_, i) => [Number(hp[i]), Number(ap[i])]);
  if (list.some(([x, y]) => !fin(x) || !fin(y))) return null;
  const re = new RegExp(`^Score After (\\d)(?:st|nd|rd|th) ${word}\\s*-\\s*(\\d+)\\s*-\\s*(\\d+)`, 'i');
  let done = 0;
  for (const line of st.summary || []) {
    const m = re.exec(String(line).trim());
    if (!m) continue;
    const k = Number(m[1]), x = Number(m[2]), y = Number(m[3]);
    if (k > list.length) return null;
    const cum = list.slice(0, k).reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
    // algumas ligas escrevem fora-casa nesta linha: aceita as duas ordens, mas tem de bater com a soma
    if (!((cum[0] === x && cum[1] === y) || (cum[0] === y && cum[1] === x))) return null;
    if (k === done + 1) done = k;
  }
  return { list, done };
}
const basketQuarters = (st) => periodsOf(st, 'Quarter');
const hockeyPeriods = (st) => periodsOf(st, 'Period');

// e-Sports: rondas dos mapas terminados (null se não baterem com os mapas ganhos)
function esportsMaps(st) {
  const maps = st?.maps, wh = st?.home?.maps_won, wa = st?.away?.maps_won;
  if (!Array.isArray(maps) || !fin(wh) || !fin(wa)) return null;
  const all = maps.map((x) => [Number(x.home), Number(x.away)]);
  const doneList = all.slice(0, wh + wa);
  const won = doneList.reduce((s, [x, y]) => [s[0] + (x > y), s[1] + (y > x)], [0, 0]);
  if (doneList.length !== wh + wa || won[0] !== wh || won[1] !== wa) return null;
  return { list: all, done: wh + wa };
}

/* Partes TERMINADAS de um jogo (para o resultado final, ou a meio do jogo):
   { h1, h2?, corners?, q1.., p1.., map1.. } — só entra o que está terminado e verificado.
   live = a meio do jogo (só partes terminadas); score = placar atual/final [c, f]. */
function finishedParts(sport, st, score, { live = false, overtime = false } = {}) {
  const out = {};
  if (!st) return out;
  if (sport === 'soccer') {
    const ht = soccerHT(st);
    if (ht && score && ht[0] <= score[0] && ht[1] <= score[1]) {
      out.h1 = ht;
      if (!live) out.h2 = [score[0] - ht[0], score[1] - ht[1]];
    }
    // escanteios do jogo: só no fim (e sem prolongamento, que não conta)
    if (!live && !overtime && fin(st.home?.corners) && fin(st.away?.corners)) out.corners = [st.home.corners, st.away.corners];
  } else if (sport === 'basketball') {
    const q = basketQuarters(st);
    if (q) {
      const reg = q.list.slice(0, 4);
      const n = live ? Math.min(q.done, 4) : reg.length === 4 && (q.done >= 4 || !(st.summary || []).length) ? 4 : Math.min(q.done, 4);
      for (let i = 0; i < n; i++) out[`q${i + 1}`] = reg[i];
      if (n >= 2) out.h1 = [reg[0][0] + reg[1][0], reg[0][1] + reg[1][1]];
      // 2º tempo inclui a prorrogação (regra da bet365 no basquete); o 4º quarto não
      if (!live && n === 4 && score) {
        const s4 = reg.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
        if (s4[0] <= score[0] && s4[1] <= score[1]) out.h2 = [score[0] - out.h1[0], score[1] - out.h1[1]];
        else for (const k of ['q1', 'q2', 'q3', 'q4', 'h1']) delete out[k]; // não bate com o final: nada por partes
      }
    }
  } else if (sport === 'hockey') {
    const p = hockeyPeriods(st);
    if (p) {
      const n = live ? Math.min(p.done, 3) : Math.min(p.list.length, 3);
      for (let i = 0; i < n; i++) out[`p${i + 1}`] = p.list[i];
      if (n === 3) out.reg = p.list.slice(0, 3).reduce((s, x) => [s[0] + x[0], s[1] + x[1]], [0, 0]); // tempo regulamentar
    }
  } else if (sport === 'esports') {
    const m = esportsMaps(st);
    if (m) for (let i = 0; i < m.done; i++) out[`map${i + 1}`] = m.list[i];
  }
  return out;
}

/* Parte a decorrer (a meio do jogo): { scope, score } com o placar parcial atual dessa parte, ou null. */
function currentPart(sport, st, score, clock) {
  if (sport === 'soccer') {
    const ht = soccerHT(st);
    if (!score) return null;
    return ht ? { scope: 'h2', score: [score[0] - ht[0], score[1] - ht[1]] } : { scope: 'h1', score };
  }
  if (sport === 'basketball' || sport === 'hockey') {
    const p = sport === 'basketball' ? basketQuarters(st) : hockeyPeriods(st);
    const max = sport === 'basketball' ? 4 : 3;
    if (!p || p.done >= max || p.list.length !== p.done + 1) return null;
    return { scope: `${sport === 'basketball' ? 'q' : 'p'}${p.done + 1}`, score: p.list[p.done] };
  }
  if (sport === 'esports') {
    const m = esportsMaps(st);
    if (!m || m.list.length !== m.done + 1) return null;
    return { scope: `map${m.done + 1}`, score: m.list[m.done] };
  }
  return null;
}

module.exports = { soccerHT, basketQuarters, hockeyPeriods, esportsMaps, finishedParts, currentPart };
