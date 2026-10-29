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
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    // ao vivo vem também "To Win (3-Way)" (com empate na parte)
    const win3 = String(q.line ?? '').trim() === 'To Win (3-Way)';
    if ((x = /^(1st|2nd) Half$/.exec(g))) return win3 ? { k: 'p1x2', scope: HALF[x[1]], pick: who(q.side) } : lines(HALF[x[1]]);
    if ((x = /^(1st|2nd|3rd|4th) Quarter$/.exec(g))) return win3 ? { k: 'p1x2', scope: QUARTER[x[1]], pick: who(q.side) } : lines(QUARTER[x[1]]);
    if ((x = /^Alternative (1st|2nd) Half (Line|Totals)$/.exec(g))) return x[2] === 'Line' ? { k: 'pspr', scope: HALF[x[1]], pick: who(q.side), line: lineOf(q) } : { k: 'ptot', scope: HALF[x[1]], pick: ou(q.side), line: lineOf(q) };
    if ((x = /^Alternative (1st|2nd|3rd|4th) Quarter (Line|Totals)$/.exec(g))) return x[2] === 'Line' ? { k: 'pspr', scope: QUARTER[x[1]], pick: who(q.side), line: lineOf(q) } : { k: 'ptot', scope: QUARTER[x[1]], pick: ou(q.side), line: lineOf(q) };
    // a equipa vem em "side" (Team Totals) ou em "n2" (Alternative Team Totals, com side = Over/Under)
    if (g === 'Team Totals' || g === 'Alternative Team Totals' || g === 'Alternative Team Totals 2') { const w = who(q.side) || who(q.n2), o = ou(q.label) || ou(q.side); return (w === 'home' || w === 'away') && o ? { k: 'pteam', scope: 'ft', pick: `${w}:${o}`, line: lineOf(q) } : null; }
    // intervalo / final (o final inclui prorrogação, como o vencedor do jogo)
    if (g === 'Double Result') { const [a, b] = String(q.label ?? '').split(' - ').map(who); return a && b && b !== 'draw' ? { k: 'phtft', scope: 'ft', pick: `${a}-${b}` } : null; }
    if (g === 'Odd/Even' && /^match$/i.test(String(q.line ?? ''))) { const p = /^odd$/i.test(String(q.side).trim()) ? 'odd' : /^even$/i.test(String(q.side).trim()) ? 'even' : null; return p ? { k: 'poe', scope: 'ft', pick: p } : null; }
    if ((x = /^(?:Alternative )?(1st|2nd) Half Team Totals$/.exec(g))) { const w = who(q.side) || who(q.n2), o = ou(q.label) || ou(q.side); return (w === 'home' || w === 'away') && o ? { k: 'pteam', scope: HALF[x[1]], pick: `${w}:${o}`, line: lineOf(q) } : null; }
    if ((x = /^(?:Alternative )?(1st|2nd|3rd|4th) Quarter Team Totals$/.exec(g))) { const w = who(q.side) || who(q.n2), o = ou(q.label) || ou(q.side); return (w === 'home' || w === 'away') && o ? { k: 'pteam', scope: QUARTER[x[1]], pick: `${w}:${o}`, line: lineOf(q) } : null; }
    /* ---- o resto que dá para decidir com o placar e os quartos da MoviOdds (decisão de 2026-10-28: sem a equipa).
       O jogo e o 2º tempo incluem a prorrogação; os quartos e o "tempo regulamentar" não (regras da bet365). ---- */
    const sc = (pre) => (!pre ? 'ft' : HALF[(/^(1st|2nd) Half$/.exec(pre) || [])[1]] || QUARTER[(/^(1st|2nd|3rd|4th) Quarter$/.exec(pre) || [])[1]] || null);
    const txt = (v) => String(v ?? '').trim();
    const fld = [q.side, q.label, q.line].map(txt);
    const teamOf = () => { for (const f of fld) { const w = who(f); if (w) return w; } return null; };
    const ouOf = () => { for (const f of fld) { const o = ou(f); if (o) return o; } return null; };
    // a linha: número sozinho num dos campos ("140.5", " 228.5", "Over 140.5") — nunca de um nome de equipa
    const totOf = () => { for (const f of [txt(q.handicap), ...fld]) { const mm = /^(?:(?:Over|Under)\s+)?([+-]?\d+(?:\.\d+)?)$/i.exec(f); if (mm) return Number(mm[1]); } return NaN; };
    const band = (s) => { const t = txt(s); let y; if ((y = /^(\d+)\s*-\s*(\d+)$/.exec(t))) return `${y[1]}-${y[2]}`; if ((y = /^(\d+)\s*(?:\+|or more)$/i.exec(t))) return `${y[1]}-999`; return null; };
    const oe = (s) => (/^odd$/i.test(txt(s)) ? 'odd' : /^even$/i.test(txt(s)) ? 'even' : null);
    // ao vivo a bet365 põe a equipa no nome do grupo: "Alternative <equipa> Totals", "3rd Quarter <equipa> To Score"
    const PRE = '(?:(1st Half|2nd Half|1st Quarter|2nd Quarter|3rd Quarter|4th Quarter) (?:- )?)?';
    const teamIn = (re) => { for (const [w, n] of [['home', m.home], ['away', m.away]]) { const mm = new RegExp(re.replace('@', esc(String(n)))).exec(g); if (n && mm) return { w, pre: mm[1] }; } return null; };
    let t;
    if (g === 'Alternative Point Spread') return { k: 'pspr', scope: 'ft', pick: who(q.side), line: lineOf(q) };
    if ((x = new RegExp(`^Alternative ${PRE}Totals$`).exec(g))) return sc(x[1]) ? { k: 'ptot', scope: sc(x[1]), pick: ou(q.side), line: lineOf(q) } : null;
    if ((t = teamIn(`^Alternative ${PRE}@ Totals$`))) { const o = ou(q.side) || ou(q.label); return sc(t.pre) && o ? { k: 'pteam', scope: sc(t.pre), pick: `${t.w}:${o}`, line: lineOf(q) } : null; }
    if ((x = /^(1st Half|2nd Half|1st Quarter|2nd Quarter|3rd Quarter|4th Quarter) - Team Totals$/.exec(g))) {
      const w = who(q.side), o = ou(q.label);
      return sc(x[1]) && (w === 'home' || w === 'away') && o ? { k: 'pteam', scope: sc(x[1]), pick: `${w}:${o}`, line: lineOf(q) } : null;
    }
    // "<equipa> To Score" N pontos (ao vivo; antes do jogo o grupo não diz a equipa e fica sem regra)
    if ((t = teamIn(`^${PRE}@ To Score$`))) { const y = yn(q.side), n = Number(q.line); return sc(t.pre) && y && Number.isInteger(n) ? cond(sc(t.pre), [`t${t.w[0]}=gt:${n - 1}`], y === 'no') : null; }
    if ((x = new RegExp(`^${PRE}Both Teams [Tt]o Score$`).exec(g)) && Number.isInteger(Number(q.line)) && txt(q.line) !== '') { const y = yn(q.side); return sc(x[1]) && y ? cond(sc(x[1]), [`bx=${y}:${Number(q.line)}`]) : null; }
    // margem por faixas: "1-2", "21+"; "Tie" = empate na parte
    if ((x = /^(?:(1st Half|1st Quarter|2nd Quarter|3rd Quarter|4th Quarter) )?(?:Winning Margin(?: 12-Way)?|Margin \(Bands\))$/.exec(g)) && !/3-Way/.test(g)) {
      const s = sc(x[1]);
      if (/^tie$/i.test(txt(q.line))) return s === 'ft' ? null : cond(s, ['res=draw']);
      const w = who(q.side), b = band(q.line);
      return s && (w === 'home' || w === 'away') && b ? cond(s, [`m${w[0]}=in:${b}`]) : null;
    }
    // "vence por N ou mais" / "qualquer outro resultado" (N lido das seleções do mesmo mercado)
    if ((x = /^(?:Winning Margin 3-Way|(1st|2nd|3rd|4th) Quarter Margin Of Victory)$/i.exec(g))) {
      const s = x[1] ? QUARTER[x[1]] : 'ft';
      const nOf = (qq) => { const t = [qq.side, qq.label, qq.line].map(txt).join(' '); const mm = /\b(\d+)\s*(?:\+|or more)/i.exec(t); return mm ? Number(mm[1]) : null; };
      const ns = new Set((m.quotes || []).filter((qq) => qq.group_id === q.group_id).map(nOf).filter((n) => n != null));
      if (ns.size !== 1) return null;
      const n = [...ns][0];
      if (fld.some((f) => /^any other result$/i.test(f))) return cond(s, [`ad=lt:${n}`]);
      const lb = /^(.+?) by \d+/i.exec(txt(q.label)), w = who(q.side) || (lb && who(lb[1]));
      return (w === 'home' || w === 'away') && nOf(q) === n ? cond(s, [`m${w[0]}=gt:${n - 1}`]) : null;
    }
    // vencedor + as duas equipas fazem X pontos: line "Equipa and Yes", side = X
    if (g === "Result and Both Teams to Score 'X' Points") {
      const mm = /^(.+) and (Yes|No)$/i.exec(txt(q.line)), n = Number(q.side), w = mm && who(mm[1]);
      return (w === 'home' || w === 'away') && Number.isInteger(n) ? cond('ft', [`res=${w}`, `bx=${mm[2].toLowerCase()}:${n}`]) : null;
    }
    if ((x = /^(?:(1st Half|2nd Half|1st Quarter|2nd Quarter|3rd Quarter|4th Quarter) )?Both Teams to Score X Points$/i.exec(g))) {
      const s = sc(x[1]), y = yn(q.side), n = Number(q.line);
      return s && y && Number.isInteger(n) ? cond(s, [`bx=${y}:${n}`]) : null;
    }
    // vencedor da parte + total: a equipa (ou "Tie") vem em side ou line; Over/Under em side ou label
    if ((x = /^(?:Match|(1st Half|2nd Half|1st Quarter|2nd Quarter|3rd Quarter|4th Quarter)) Result and Total$/.exec(g))) {
      const s = sc(x[1]), w = teamOf(), o = ouOf(), n = totOf();
      if (!s || !w || !o || !half(n) || (s === 'ft' && w === 'draw')) return null;
      return cond(s, [`res=${w}`, `tot=${o === 'over' ? 'gt' : 'lt'}:${n}`]);
    }
    // handicap + total: "Equipa +2.5 & Over 140.5"
    if ((x = /^(?:Match|(1st Half|1st Quarter)) Handicap and Total$/.exec(g))) {
      const s = sc(x[1]), mm = /^(.+?)\s+([+-]\d+(?:\.\d+)?)\s*&\s*(Over|Under)\s+(\d+(?:\.\d+)?)$/i.exec(txt(q.label));
      const w = mm && who(mm[1]);
      if (!s || !(w === 'home' || w === 'away') || !half(Number(mm[2])) || !half(Number(mm[4]))) return null;
      return cond(s, [`hc=${w}:${Number(mm[2])}`, `tot=${/^over$/i.test(mm[3]) ? 'gt' : 'lt'}:${Number(mm[4])}`]);
    }
    if (g === 'Team Total Odd Or Even') { const w = who(q.side), p = oe(q.label); return (w === 'home' || w === 'away') && p ? cond('ft', [`par=${w[0]}:${p}`]) : null; }
    if ((x = /^(?:Game Total - Odd or Even|(1st Half) Total Odd\/Even|(1st|2nd|3rd|4th) Quarter Total - Odd\/Even)$/.exec(g))) {
      const s = x[1] ? 'h1' : x[2] ? QUARTER[x[2]] : 'ft', p = oe(q.label) || oe(q.side);
      return p ? { k: 'poe', scope: s, pick: p } : null;
    }
    if (g === 'Odd/Even') { const s = { Match: 'ft', '1st Half': 'h1', '2nd Half': 'h2', '1st Quarter': 'q1', '2nd Quarter': 'q2', '3rd Quarter': 'q3', '4th Quarter': 'q4' }[txt(q.line)], p = oe(q.side); return s && p ? { k: 'poe', scope: s, pick: p } : null; }
    if ((x = /^(1st Half|1st Quarter) Result \(Incl\. Tie\)$/.exec(g))) return { k: 'p1x2', scope: sc(x[1]), pick: who(q.label ?? q.side) };
    if ((x = /^(1st Half|1st Quarter|2nd Quarter|3rd Quarter) Double Chance$/.exec(g))) return { k: 'pdc', scope: sc(x[1]), pick: { '1X': 'hd', 12: 'ha', X2: 'da', '2X': 'da' }[q.n2] || dcOf(q.label) };
    if ((x = /^(1st|2nd|3rd|4th) Quarter 3 Way Lines$/.exec(g))) return txt(q.line) === 'To Win' ? { k: 'p1x2', scope: QUARTER[x[1]], pick: who(q.side) } : null;
    if (g === 'Tied at End Of Regulation?') { const y = yn(q.label) || yn(q.side); return y ? cond('reg', ['res=draw'], y === 'no') : null; }
    // a parte com mais pontos (as duas equipas juntas): tempos (o 2º com prorrogação) ou quartos (sem prorrogação)
    if (g === 'Highest Scoring Half') { const t = txt(q.label); const p = /^(1st Half|Half 1)$/i.test(t) ? 'h1' : /^(2nd Half|Half 2)$/i.test(t) ? 'h2' : /^tie$/i.test(t) ? 'htie' : null; return p && { k: 'phs', scope: 'ft', pick: p }; }
    if (g === 'Highest Scoring Quarter') { const t = txt(q.label); const p = (/^(1st|2nd|3rd|4th) Quarter$/i.exec(t) || [])[1]; return p ? { k: 'phs', scope: 'ft', pick: QUARTER[p] } : /^tie$/i.test(t) ? { k: 'phs', scope: 'ft', pick: 'qtie' } : null; }
    // a equipa que faz mais pontos num só quarto
    if (g === 'Team with highest scoring quarter') return { k: 'pthq', scope: 'ft', pick: who(q.label ?? q.side) };
    // quartos ganhos por cada equipa: "Equipa 3-1", "2-2", "Any Other" (= 2 ou mais quartos empatados)
    if (g === 'Quarter Correct Score') {
      if (/^any other$/i.test(txt(q.line))) return { k: 'pqcs', scope: 'ft', pick: 'other' };
      const mm = /^(\d)-(\d)$/.exec(txt(q.line)), w = who(q.side);
      if (!mm) return null;
      if (!txt(q.side)) return mm[1] === mm[2] ? { k: 'pqcs', scope: 'ft', pick: `${mm[1]}-${mm[2]}` } : null;
      return w === 'home' ? { k: 'pqcs', scope: 'ft', pick: `${mm[1]}-${mm[2]}` } : w === 'away' ? { k: 'pqcs', scope: 'ft', pick: `${mm[2]}-${mm[1]}` } : null;
    }
    return null;
  }
  if (sport === 'hockey') {
    if ((x = /^(1st|2nd|3rd) Period 3-Way$/.exec(g))) return q.line && q.line !== 'To Win' ? null : { k: 'p1x2', scope: PERIOD[x[1]], pick: who(q.label ?? q.side) };
    // tempo regulamentar (3 períodos)
    if (g === 'Tied after Regulation') { const y = yn(q.label); return y ? cond('reg', ['res=draw'], y === 'no') : null; }
    if (g === 'Double Chance' && !q.n2) { const d = dcOf(q.label); return d ? cond('reg', [`dc=${d}`]) : null; }
    // "To Win" do período é a 2 (odds sem empate): período empatado → devolvida (o 1X2 do período é o "Period 3-Way")
    if ((x = /^(1st|2nd|3rd) Period$/.exec(g))) return lines(PERIOD[x[1]]);
    /* ---- o resto que se decide pelo placar (decisão de 2026-10-29). 'reg' = tempo regulamentar (mercados com empate);
       'ftr' = o jogo todo, só liquidado sozinho se acabou nos 60 minutos (com prorrogação/pênaltis → equipa). ---- */
    const txt = (v) => String(v ?? '').trim();
    if (g === 'Draw No Bet') { const w = who(q.label); return w === 'home' || w === 'away' ? { k: 'pml2', scope: 'reg', pick: w } : null; }
    if (g === 'Team Total 2-Way') { const w = who(q.side), o = ou(q.label); return (w === 'home' || w === 'away') && o ? { k: 'pteam', scope: 'ftr', pick: `${w}:${o}`, line: lineOf(q) } : null; }
    if ((x = /^(1st|2nd|3rd) Period Team Total 2-Way$/.exec(g))) { const w = who(q.side), o = ou(q.label); return (w === 'home' || w === 'away') && o ? { k: 'pteam', scope: PERIOD[x[1]], pick: `${w}:${o}`, line: lineOf(q) } : null; }
    if (g === 'Alternative Total 2-Way') return { k: 'ptot', scope: 'ftr', pick: ou(q.side), line: lineOf(q) };
    if (g === 'Alternative Puck Line') { const w = who(q.side); return w === 'home' || w === 'away' ? { k: 'pspr', scope: 'ftr', pick: w, line: lineOf(q) } : null; }
    const val = () => txt(q.line) || txt(q.label); // ao vivo e antes do jogo a fonte põe o valor em campos diferentes
    if (g === 'Game Total - Odd/Even' || g === 'Game Total Odd/Even') { const p = /^odd$/i.test(txt(q.label) || txt(q.side)) ? 'odd' : /^even$/i.test(txt(q.label) || txt(q.side)) ? 'even' : null; return p ? { k: 'poe', scope: 'ftr', pick: p } : null; }
    if (g === 'Correct Score') return { k: 'pcs', scope: 'ftr', pick: orient(q.side || 'Tie', val()) };
    if ((x = /^(1st|2nd|3rd) Period Correct Score$/.exec(g))) return /^any other/i.test(val()) ? null : { k: 'pcs', scope: PERIOD[x[1]], pick: orient(q.side || 'Tie', val()) };
    if (g === 'Winning Margin') { const w = who(q.side), b = /^(\d+)(\+?)$/.exec(val()); return (w === 'home' || w === 'away') && b ? cond('ftr', [`m${w[0]}=in:${b[1]}-${b[2] ? 99 : b[1]}`]) : null; }
    if (g === '3-Way' && q.line === 'Line') { // handicap a 3 (tempo regulamentar); o empate traz a linha da casa — confere-se com a seleção irmã
      const sib = (m.quotes || []).filter((y) => y.group_id === q.group_id && y.market_id === q.market_id && y.line === 'Line' && Number.isFinite(lineOf(y)));
      const hRow = sib.find((y) => who(y.side) === 'home'), aRow = sib.find((y) => who(y.side) === 'away');
      const hl = hRow ? lineOf(hRow) : aRow ? -lineOf(aRow) : NaN, w = who(q.side);
      if (!Number.isInteger(hl) || (hRow && aRow && lineOf(hRow) !== -lineOf(aRow)) || (w === 'draw' && lineOf(q) !== hl)) return null;
      const c = w ? cond('reg', [`mh=${{ home: 'gt', draw: 'eq', away: 'lt' }[w]}:${-hl}`]) : null;
      return c && { ...c, sub: `h${hl}`, mname: `Handicap a 3 opções ${hl > 0 ? '+' : ''}${hl} (tempo regulamentar)`, name: w === 'draw' ? `Empate (${hl > 0 ? '+' : ''}${hl})` : `${w === 'home' ? m.home : m.away} ${w === 'home' ? (hl > 0 ? '+' : '') + hl : (-hl > 0 ? '+' : '') + -hl}` };
    }
    if (g === 'Team Scoring 1st Wins Game') { const y = yn(q.label); return y ? { k: 'hng', scope: 'ft', pick: `firstwins:${y}` } : null; }
    if (g === '3-Way' && q.line === 'Total') { const op = { Over: 'gt', Under: 'lt', Exactly: 'eq' }[txt(q.side)], n = lineOf(q); const c = op && Number.isInteger(n) ? cond('reg', [`tot=${op}:${n}`]) : null; return c && { ...c, sub: `t${n}`, mname: `Total de gols a 3 opções ${n} (tempo regulamentar)`, name: `${{ gt: 'Mais de', lt: 'Menos de', eq: 'Exatamente' }[op]} ${n}` }; }
    if ((x = /^(1st|2nd|3rd) Period Double Chance$/.exec(g))) return { k: 'pdc', scope: PERIOD[x[1]], pick: { '1X': 'hd', 12: 'ha', X2: 'da', '2X': 'da' }[q.n2] };
    if ((x = /^(1st|2nd|3rd) Period Both Teams to Score at Least 1 Goal$/i.exec(g))) return { k: 'pbtts', scope: PERIOD[x[1]], pick: yn(q.label) };
    if (g === 'Exact Total Goals') {
      const t = val(); let y, r = null;
      if ((y = /^Exactly (\d+)$/i.exec(t))) r = `${y[1]}-${y[1]}`; else if ((y = /^(\d+) or Less$/i.exec(t))) r = `0-${y[1]}`; else if ((y = /^(\d+) or More$/i.exec(t))) r = `${y[1]}-99`;
      return r ? cond('ftr', [`tot=in:${r}`]) : null;
    }
    if (g === 'Both Teams To Score (Goals)') { const n = Number((/^(\d+) Or More$/i.exec(val()) || [])[1]), y = yn(q.side); return n >= 1 && y ? cond('ftr', [`th=gt:${n - 1}`, `ta=gt:${n - 1}`], y === 'no') : null; }
    if (g === 'When will Match End') { const e = { Regulation: 'reg', Overtime: 'ot', Shootout: 'so' }[txt(q.label)]; return e ? { k: 'hend', scope: 'ft', pick: e } : null; }
    if (g === 'Will Game go to Shootout?') { const y = yn(q.label); return y ? { k: 'hend', scope: 'ft', pick: y === 'yes' ? 'so' : '!so' } : null; }
    if (g === 'Highest Scoring Period') { const t = txt(q.label), p = /^Period ([123])$/.exec(t); return p ? { k: 'hphs', scope: 'ft', pick: `p${p[1]}` } : /^tie$/i.test(t) ? { k: 'hphs', scope: 'ft', pick: 'tie' } : null; }
    // ordem dos gols: "Team To Score (Goals)" 1st / Last (Neither = nenhum gol), "7th Goal" (quem marca o 7º)
    if (g === 'Team To Score (Goals)') { const n = { '1st': 'first', Last: 'last' }[txt(q.line)], w = /^neither$/i.test(txt(q.side)) ? 'none' : who(q.side); return n && (w === 'home' || w === 'away' || w === 'none') ? { k: 'hng', scope: 'ft', pick: `${n}:${w}` } : null; }
    if ((x = /^(\d+)(?:st|nd|rd|th) Goal$/.exec(g))) { const t = txt(q.label), w = /^no \d+/i.test(t) ? 'none' : who(t); return w === 'home' || w === 'away' || w === 'none' ? { k: 'hng', scope: 'ft', pick: `${x[1]}:${w}` } : null; }
    if (g === 'Team To Win Most Periods') { const w = who(q.label); return w ? { k: 'hmost', scope: 'ft', pick: w } : null; }
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
  // sub: o mesmo grupo da fonte dividido em mercados (ex.: "3-Way" do hóquei = vencedor + handicap + total)
  const s = { ...gen, k: r.k, per: `${r.scope}|${q.group_id}${r.sub ? ':' + r.sub : ''}`, pick: r.pick };
  if (r.mname) { s.mname = r.mname; s.name = r.name; }
  if (r.line != null) s.line = r.line;
  return s;
}

module.exports = { apply, rule, lineOf };
