'use strict';
/* Mercados "por parte do jogo" liquidados sozinhos: o resultado de um tempo, quarto, período ou mapa, e os
   escanteios. Aparecem com o mesmo nome dos mercados da equipa (generic.js), mas com uma regra de liquidação.

   Cada cotação vira { k, per: '<parte>|<grupo>', pick, line? } — "parte" diz que placar usar (ver markets.js):
     ft (jogo todo) · h1 / h2 (1º / 2º tempo) · q1..q4 (quartos) · p1..p3 (períodos) · corners (escanteios) · cards (cartões)
     · map1.. (rondas do mapa)
   Tipos: p1x2 (1X2) · pdc (dupla chance) · pcs (placar exato) · ptot (total) · pspr (handicap) · pbtts (ambas marcam)
          phtft (intervalo/final) · pteam (total de uma equipa) · pcln (sem sofrer) · pmost (quem tem mais)
          poe (par/ímpar) · pml2 (vencedor a 2: empate = devolvida) · pot (mapa vai a prolongamento) */

const parseScore = (s) => { const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(s ?? '').trim()); return m ? [Number(m[1]), Number(m[2])] : null; };
const num = (v) => parseFloat(String(v ?? '').replace(/[^\d.+-]/g, ''));
// linha: "2.5", ou "0.5, 1.0" (linha dupla = média → 0.75)
function lineOf(q) {
  const h = num(q.handicap);
  if (isFinite(h)) return h;
  const parts = String(q.line ?? q.label ?? '').match(/[+-]?\d+(\.\d+)?/g);
  if (!parts) return NaN;
  const v = parts.slice(0, 2).map(Number);
  return v.length === 2 && /,/.test(q.line ?? '') ? (v[0] + v[1]) / 2 : v[0];
}
const ou = (s) => (/^\s*over/i.test(String(s ?? '')) ? 'over' : /^\s*under/i.test(String(s ?? '')) ? 'under' : null);
const yn = (s) => (/^\s*yes/i.test(String(s ?? '')) ? 'yes' : /^\s*no\b/i.test(String(s ?? '')) ? 'no' : null);
const HALF = { '1st': 'h1', '2nd': 'h2' }, QUARTER = { '1st': 'q1', '2nd': 'q2', '3rd': 'q3', '4th': 'q4' }, PERIOD = { '1st': 'p1', '2nd': 'p2', '3rd': 'p3' };

/* Combinações (resultado + ambas marcam, faixas de gols, escanteios "exatamente"...): k 'pcond', pick = condições
   separadas por ";" que têm de ser TODAS verdadeiras; "!" à frente = a seleção "Não" (ganha se alguma falhar).
   res=home|draw|away · dc=hd|ha|da · btts=yes|no · tot / th / ta (total / casa / fora) = gt:N | lt:N | eq:N | in:A-B */
function range(s) {
  const t = String(s ?? '').trim();
  let x;
  if ((x = /^(\d+)\s*-\s*(\d+)/.exec(t))) return `${x[1]}-${x[2]}`;
  if ((x = /^(\d+)\s*(\+|or more|Goals? or more)/i.exec(t))) return `${x[1]}-99`;
  if ((x = /^Under (\d+)$/i.exec(t))) return `0-${Number(x[1]) - 1}`;
  if ((x = /^Over (\d+)$/i.exec(t))) return `${Number(x[1]) + 1}-99`;
  if ((x = /^(\d+) Goals?$/i.exec(t))) return `${x[1]}-${x[1]}`;
  return null;
}
const half = (v) => Number.isFinite(v) && Math.abs(v * 2 % 2) === 1; // linha .5 (sem devoluções nas combinações)
function cond(scope, conds, neg = false) {
  if (!conds.every(Boolean)) return null;
  return { k: 'pcond', scope, pick: (neg ? '!' : '') + conds.join(';') };
}

function rule(q, m, sport) {
  const g = String(q.group_name ?? '').trim();
  const who = (n) => { const s = String(n ?? '').trim(); return s === m.home ? 'home' : s === m.away ? 'away' : /^(draw|tie)$/i.test(s) ? 'draw' : null; };
  const res3 = () => (q.n2 ? { 1: 'home', X: 'draw', 2: 'away' }[q.n2] : who(q.label ?? q.side));
  const orient = (side, score) => { const p = parseScore(score); if (!p) return null; const w = who(side); return w === 'away' ? `${p[1]}-${p[0]}` : w === 'home' || (w === 'draw' && p[0] === p[1]) ? `${p[0]}-${p[1]}` : null; };
  // grupo com vencedor / handicap / total juntos (campo "line": To Win / Line / Total)
  const lines = (scope, twoWay = true) => (q.line === 'To Win' ? { k: twoWay ? 'pml2' : 'p1x2', scope, pick: who(q.side) }
    : q.line === 'Line' ? { k: 'pspr', scope, pick: who(q.side), line: lineOf(q) }
      : q.line === 'Total' ? { k: 'ptot', scope, pick: ou(q.side), line: lineOf(q) } : null);
  let x;
  // dupla chance escrita por extenso: "Draw or NK Maribor", "AIK or Elfsborg"
  const dcOf = (s) => {
    const parts = String(s ?? '').split(/\s+or\s+/i).map((x) => who(x));
    if (parts.length !== 2 || parts.some((x) => !x)) return null;
    const set = new Set(parts);
    return set.has('home') && set.has('draw') ? 'hd' : set.has('away') && set.has('draw') ? 'da' : set.has('home') && set.has('away') ? 'ha' : null;
  };
  if (sport === 'soccer') {
    // ---- combinações ----
    if (g === 'Match Result/Both Teams To Score' || g === 'Result/Both Teams To Score') return cond('ft', [who(q.line) && `res=${who(q.line)}`, yn(q.side) && `btts=${yn(q.side)}`]);
    if (g === 'Half Time Result / Both Teams To Score') return cond('h1', [who(q.line) && `res=${who(q.line)}`, yn(q.side) && `btts=${yn(q.side)}`]);
    if (g === 'Total Goals/Both Teams To Score') {
      const mm = /^(Over|Under)\s+([\d.]+)\s*&\s*(Yes|No)$/i.exec(String(q.label ?? '').trim());
      if (!mm || !half(Number(mm[2]))) return null;
      return cond('ft', [`tot=${/^over$/i.test(mm[1]) ? 'gt' : 'lt'}:${Number(mm[2])}`, `btts=${mm[3].toLowerCase()}`]);
    }
    if ((x = /^(Match|1st Half|2nd Half) Goals Range$/.exec(g))) { const r = range(q.line), y = yn(q.side); return y ? cond({ Match: 'ft', '1st Half': 'h1', '2nd Half': 'h2' }[x[1]], [r && `tot=in:${r}`], y === 'no') : null; }
    if (g === 'Team Goals Range') { const w = who(q.line), r = range(q.handicap), y = yn(q.side); return y && (w === 'home' || w === 'away') ? cond('ft', [r && `t${w[0]}=in:${r}`], y === 'no') : null; }
    if (g === 'Results/Goals Range') { const w = who(q.line), r = range(q.handicap), y = yn(q.side); return y ? cond('ft', [w && `res=${w}`, r && `tot=in:${r}`], y === 'no') : null; }
    if (g === 'Double Chance/Goals Range') { const d = dcOf(q.line), r = range(q.handicap), y = yn(q.side); return y ? cond('ft', [d && `dc=${d}`, r && `tot=in:${r}`], y === 'no') : null; }
    // ao vivo a bet365 usa outros nomes: "Match Corners" (= Alternative Corners), "Asian Corners" e "2-Way Corners" (= totais)
    if (g === 'Asian Corners' || g === '2-Way Corners') return { k: 'ptot', scope: 'corners', pick: ou(q.side), line: lineOf(q) };
    if (g === 'Alternative Corners' || g === 'Match Corners') { const n = Number(q.handicap ?? q.line), s = String(q.side ?? '').toLowerCase(); const op = { over: 'gt', under: 'lt', exactly: 'eq' }[s]; return op && Number.isInteger(n) ? cond('corners', [`tot=${op}:${n}`]) : null; }
    if (g === 'Total Corners') { const r = range(q.label); return r ? cond('corners', [`tot=in:${r}`]) : null; }
    if (g === 'Half Time Result') return { k: 'p1x2', scope: 'h1', pick: res3() };
    if (g === 'Half Time Double Chance') return { k: 'pdc', scope: 'h1', pick: { '1X': 'hd', 12: 'ha', X2: 'da', '2X': 'da' }[q.n2] };
    if (g === 'Half Time Correct Score') return { k: 'pcs', scope: 'h1', pick: orient(q.side, q.label) };
    if ((x = /^(1st|2nd) Half Goals$/.exec(g)) || (x = /^(?:Additional )?(1st|2nd) Half Goal Line$/.exec(g))) return { k: 'ptot', scope: HALF[x[1]], pick: ou(q.side), line: lineOf(q) };
    if ((x = /^(?:Alternative )?(1st|2nd) Half Asian Handicap$/.exec(g)) || (x = /^(1st|2nd) Half Handicap 2-Way$/.exec(g))) return { k: 'pspr', scope: HALF[x[1]], pick: who(q.side), line: lineOf(q) };
    if ((x = /^Both Teams To Score In (1st|2nd) Half$/i.exec(g))) return { k: 'pbtts', scope: HALF[x[1]], pick: yn(q.label) };
    if (g === 'Half Time/Full Time') { const [a, b] = String(q.label ?? '').split(' - ').map(who); return a && b ? { k: 'phtft', scope: 'ft', pick: `${a}-${b}` } : null; }
    if (g === 'Team Total Goals') { const w = who(q.side), o = ou(q.label); return w && o ? { k: 'pteam', scope: 'ft', pick: `${w}:${o}`, line: lineOf(q) } : null; }
    if (g === 'Clean Sheet') { const w = who(q.side), y = yn(q.label); return w && y ? { k: 'pcln', scope: 'ft', pick: `${w}:${y}` } : null; }
    if (g === 'Corners 2-Way' || g === 'Asian Total Corners') return { k: 'ptot', scope: 'corners', pick: ou(q.side), line: lineOf(q) };
    if (g === 'Team Corners') { const w = who(q.side), o = ou(q.label); return w && o ? { k: 'pteam', scope: 'corners', pick: `${w}:${o}`, line: lineOf(q) } : null; }
    if (g === 'Team to Get Most' && /^corners$/i.test(q.line)) return { k: 'pmost', scope: 'corners', pick: who(q.side) };
    // ---- cartões (amarelos e vermelhos dos jogadores; ver parts.js soccerCards e markets.js) ----
    if (g === 'Number of Cards' || g === 'Number Of Cards In Match' || g === 'Asian Total Cards') return { k: 'ptot', scope: 'cards', pick: ou(q.side), line: lineOf(q) };
    if (g === 'Team Cards') { const w = who(q.side), o = ou(q.label); return (w === 'home' || w === 'away') && o ? { k: 'pteam', scope: 'cards', pick: `${w}:${o}`, line: lineOf(q) } : null; }
    if (g === 'Asian Handicap Cards') { const w = who(q.side); return w === 'home' || w === 'away' ? { k: 'pspr', scope: 'cards', pick: w, line: lineOf(q) } : null; }
    if (g === 'Both Teams to Receive Cards') {
      const n = /^a card$/i.test(String(q.line ?? '').trim()) ? 1 : Number((/^(\d)\+ cards$/i.exec(String(q.line ?? '').trim()) || [])[1]);
      const y = yn(q.side);
      return y && n >= 1 ? cond('cards', [`th=gt:${n - 1}`, `ta=gt:${n - 1}`], y === 'no') : null;
    }
    return null;
  }
  if (sport === 'basketball') {
    if ((x = /^(1st|2nd) Half$/.exec(g))) return lines(HALF[x[1]]);
    if ((x = /^(1st|2nd|3rd|4th) Quarter$/.exec(g))) return lines(QUARTER[x[1]]);
    if ((x = /^Alternative (1st|2nd) Half (Line|Totals)$/.exec(g))) return x[2] === 'Line' ? { k: 'pspr', scope: HALF[x[1]], pick: who(q.side), line: lineOf(q) } : { k: 'ptot', scope: HALF[x[1]], pick: ou(q.side), line: lineOf(q) };
    if ((x = /^Alternative (1st|2nd|3rd|4th) Quarter (Line|Totals)$/.exec(g))) return x[2] === 'Line' ? { k: 'pspr', scope: QUARTER[x[1]], pick: who(q.side), line: lineOf(q) } : { k: 'ptot', scope: QUARTER[x[1]], pick: ou(q.side), line: lineOf(q) };
    // a equipa vem em "side" (Team Totals) ou em "n2" (Alternative Team Totals, com side = Over/Under)
    if (g === 'Team Totals' || g === 'Alternative Team Totals' || g === 'Alternative Team Totals 2') { const w = who(q.side) || who(q.n2), o = ou(q.label) || ou(q.side); return (w === 'home' || w === 'away') && o ? { k: 'pteam', scope: 'ft', pick: `${w}:${o}`, line: lineOf(q) } : null; }
    // intervalo / final (o final inclui prorrogação, como o vencedor do jogo)
    if (g === 'Double Result') { const [a, b] = String(q.label ?? '').split(' - ').map(who); return a && b && b !== 'draw' ? { k: 'phtft', scope: 'ft', pick: `${a}-${b}` } : null; }
    if (g === 'Odd/Even' && /^match$/i.test(String(q.line ?? ''))) { const p = /^odd$/i.test(String(q.side).trim()) ? 'odd' : /^even$/i.test(String(q.side).trim()) ? 'even' : null; return p ? { k: 'poe', scope: 'ft', pick: p } : null; }
    if (g === '1st Half Result and Total') { const w = who(q.line), o = ou(q.side), n = Number(q.handicap); return (w === 'home' || w === 'away') && o && half(n) ? cond('h1', [`res=${w}`, `tot=${o === 'over' ? 'gt' : 'lt'}:${n}`]) : null; }
    if ((x = /^(1st|2nd) Half Team Totals$/.exec(g))) { const w = who(q.side), o = ou(q.label); return w && o ? { k: 'pteam', scope: HALF[x[1]], pick: `${w}:${o}`, line: lineOf(q) } : null; }
    if ((x = /^(1st|2nd|3rd|4th) Quarter Team Totals$/.exec(g))) { const w = who(q.side), o = ou(q.label); return w && o ? { k: 'pteam', scope: QUARTER[x[1]], pick: `${w}:${o}`, line: lineOf(q) } : null; }
    return null;
  }
  if (sport === 'hockey') {
    if ((x = /^(1st|2nd|3rd) Period 3-Way$/.exec(g))) return q.line && q.line !== 'To Win' ? null : { k: 'p1x2', scope: PERIOD[x[1]], pick: who(q.label ?? q.side) };
    // tempo regulamentar (3 períodos)
    if (g === 'Tied after Regulation') { const y = yn(q.label); return y ? cond('reg', ['res=draw'], y === 'no') : null; }
    if (g === 'Double Chance' && !q.n2) { const d = dcOf(q.label); return d ? cond('reg', [`dc=${d}`]) : null; }
    if ((x = /^(1st|2nd|3rd) Period$/.exec(g))) return lines(PERIOD[x[1]], false);
    return null;
  }
  if (sport === 'esports' && /^(CS2|VALORANT) - /.test(m.league)) {
    // CS2 e Valorant: o resultado traz as rondas de cada mapa
    if ((x = /^Map (\d+) - Lines$/.exec(g)) && q.line === 'Total Rounds') return { k: 'ptot', scope: `map${x[1]}`, pick: ou(q.side), line: lineOf(q) };
    if ((x = /^Map (\d+) Lines$/.exec(g)) && q.line === 'Rounds Line') return { k: 'pspr', scope: `map${x[1]}`, pick: who(q.side), line: lineOf(q) };
    if ((x = /^Map (\d+) - (?:Alternative|Alt) Rounds Handicap$/.exec(g))) return { k: 'pspr', scope: `map${x[1]}`, pick: who(q.side), line: lineOf(q) };
    if ((x = /^Map (\d+) - (?:Alternative|Alt) Total Rounds$/.exec(g))) return { k: 'ptot', scope: `map${x[1]}`, pick: ou(q.side), line: lineOf(q) };
    if ((x = /^Map (\d+) - Correct Round Score$/.exec(g))) return { k: 'pcs', scope: `map${x[1]}`, pick: orient(q.side, q.line) };
    if ((x = /^Map (\d+) - Total Rounds Odd\/Even$/.exec(g))) return { k: 'poe', scope: `map${x[1]}`, pick: /^odd/i.test(String(q.label).trim()) ? 'odd' : /^even/i.test(String(q.label).trim()) ? 'even' : null };
    if ((x = /^Map (\d+) - To go to Overtime$/.exec(g))) return { k: 'pot', scope: `map${x[1]}`, pick: yn(q.label) };
  }
  return null;
}

// a cotação genérica (nome traduzido, secção) ganha a regra de liquidação, se houver
function apply(gen, q, m, sport) {
  const r = rule(q, m, sport);
  if (!r || !r.pick || ('line' in r && !isFinite(r.line))) return gen;
  const s = { ...gen, k: r.k, per: `${r.scope}|${q.group_id}`, pick: r.pick };
  if (r.line != null) s.line = r.line;
  return s;
}

module.exports = { apply, rule, lineOf };
