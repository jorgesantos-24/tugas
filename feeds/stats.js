'use strict';
/* Estatísticas ao vivo da MoviOdds (mensagens "stats" do WebSocket) → formato único para a página do jogo:
   { rows: [[rótulo, casa, fora, pct?]], periods: { labels, home, away }, players: { home, away } (basquete), point: ['30','15'], serve: 'home'|'away',
     details: [lances], form: { home, away }, clock: texto extra para o relógio, score: [casa, fora] }
   Só entra o que a fonte trouxer; um valor que falta não aparece. */

const BP = require('./bplayers.js');
const PBP = require('./pbp.js'); // ténis: ponto a ponto (como no Flashscore)
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function rowsOf(h, a, spec) {
  const out = [];
  for (const [key, label, pct] of spec) {
    const x = fin(h?.[key]), y = fin(a?.[key]);
    if (x == null || y == null) continue;
    out.push(pct ? [label, x, y, 1] : [label, x, y]);
  }
  return out;
}
const ord = (n) => `${n}º`;

const SOCCER = [
  ['possession', 'Posse de bola', 1], ['xg', 'Gols esperados (xG)'], ['attacks', 'Ataques'], ['dangerous_attacks', 'Ataques perigosos'],
  ['shots', 'Chutes'], ['shots_on_target', 'Chutes no gol'], ['shots_off_target', 'Chutes para fora'], ['corners', 'Escanteios'],
  ['yellow_cards', 'Cartões amarelos'], ['red_cards', 'Cartões vermelhos'], ['offsides', 'Impedimentos'], ['substitutions', 'Substituições'],
];
const BASKET = [
  ['three_pointers', 'Cestas de 3'], ['two_pointers', 'Cestas de 2'], ['free_throws', 'Lances livres'], ['free_throw_pct', 'Lances livres (%)', 1],
  ['fouls', 'Faltas'], ['timeouts_remaining', 'Tempos técnicos restantes'],
];
const TENNIS = [
  ['aces', 'Aces'], ['double_faults', 'Duplas faltas'], ['first_serve_win_pct', 'Pontos ganhos no 1º saque (%)', 1],
  ['second_serve_win_pct', 'Pontos ganhos no 2º saque (%)', 1], ['break_point_conversion_pct', 'Break points convertidos (%)', 1],
];
const HOCKEY = [['shots', 'Chutes'], ['penalties', 'Penalidades'], ['power_play_chances', 'Power plays']];
const ESPORTS = [['maps_won', 'Mapas ganhos'], ['rounds', 'Rodadas no mapa atual']];

// "Score After First Half" e afins ficam de fora; cartões e gols entram como lances (formato do app.js: ev.details)
const TL = { goal: 'goal', yellow_card: 'yellow', red_card: 'red', penalty: 'pen' };
function soccerDetails(st, m) {
  const out = [];
  for (const t of st.timeline || []) {
    const kind = TL[t.type];
    if (!kind || (t.team !== 'home' && t.team !== 'away')) continue;
    const pen = /penalt/i.test(t.text || '');
    out.push({ min: t.minute != null ? `${t.minute}'` : '', teamId: t.team === 'home' ? 'h' : 'a', player: t.team === 'home' ? m.home : m.away, goal: kind === 'goal', yellow: kind === 'yellow', red: kind === 'red', pen: pen && kind === 'goal' });
  }
  return out;
}
// forma recente: "W", "D", "L" (a mais antiga primeiro, como o app.js espera)
const formOf = (list) => (Array.isArray(list) ? list.map((x) => (/^[WDL]$/.test(x?.result) ? x.result : '')).join('').split('').reverse().join('') : '');

function build(sport, st, m) {
  if (!st || !st.home || !st.away) return null;
  const h = st.home, a = st.away;
  const out = { rows: [] };
  if (sport === 'soccer') {
    out.rows = rowsOf(h, a, SOCCER);
    out.details = soccerDetails(st, m);
    const fh = formOf(h.form), fa = formOf(a.form);
    if (fh || fa) out.form = { home: fh, away: fa };
    if (fin(h.goals) != null && fin(a.goals) != null) out.score = [h.goals, a.goals];
  } else if (sport === 'basketball') {
    out.rows = rowsOf(h, a, BASKET);
    if (Array.isArray(h.periods) && Array.isArray(a.periods) && h.periods.length) {
      const n = Math.min(h.periods.length, a.periods.length);
      const labels = Array.from({ length: n }, (_, i) => `${i + 1}Q`);
      const home = h.periods.slice(0, n), away = a.periods.slice(0, n);
      if (fin(h.overtime) || fin(a.overtime)) { labels.push('Prorr.'); home.push(h.overtime || 0); away.push(a.overtime || 0); }
      out.periods = { labels, home, away };
    }
    const p = fin(st.period);
    if (p) out.clock = p <= 4 ? `${ord(p)} quarto` : 'Prorrogação';
    if (fin(h.points) != null && fin(a.points) != null) out.score = [h.points, a.points];
    // jogadores (box score ao vivo): quem já entrou em quadra, por pontos
    const pl = (side) => (st.players || []).filter((x) => x?.team === side && x.box_score && (BP.mins(x.box_score.minutes) > 0 || x.box_score.on_court || x.box_score.points > 0))
      .map((x) => ({ n: String(x.name || ''), on: !!x.box_score.on_court, p: x.box_score.points || 0, r: x.box_score.rebounds || 0, a: x.box_score.assists || 0, t: x.box_score.three_pointers_made || 0 }))
      .sort((x, y) => y.p - x.p || y.r + y.a - x.r - x.a);
    if ((st.players || []).length) { const ph = pl('home'), pa = pl('away'); if (ph.length || pa.length) out.players = { home: ph, away: pa }; }
  } else if (sport === 'tennis') {
    out.rows = rowsOf(h, a, TENNIS);
    if (Array.isArray(h.sets) && Array.isArray(a.sets) && h.sets.length) out.periods = { labels: h.sets.map((_, i) => `${i + 1}º set`), home: h.sets, away: a.sets.slice(0, h.sets.length) };
    if (h.point != null && a.point != null) out.point = [String(h.point), String(a.point)];
    out.serve = h.serving ? 'home' : a.serving ? 'away' : null;
    try { const p = m?.id != null ? PBP.build(m.id, st, m.home, m.away) : null; if (p) out.pbp = p; } catch (e) { console.error('[Ponto a ponto]', m?.id, e.message); }
  } else if (sport === 'hockey') {
    out.rows = rowsOf(h, a, HOCKEY);
    if (Array.isArray(h.periods) && Array.isArray(a.periods) && h.periods.length) out.periods = { labels: h.periods.map((_, i) => `${i + 1}º P`), home: h.periods, away: a.periods.slice(0, h.periods.length) };
    const p = fin(st.period);
    if (p) out.clock = p <= 3 ? `${ord(p)} período` : 'Prorrogação';
    if (fin(h.goals) != null && fin(a.goals) != null) out.score = [h.goals, a.goals];
  } else if (sport === 'esports') {
    out.rows = rowsOf(h, a, ESPORTS);
    if (Array.isArray(st.maps) && st.maps.length) out.periods = { labels: st.maps.map((x) => x.name || `Mapa ${x.number}`), home: st.maps.map((x) => x.home ?? 0), away: st.maps.map((x) => x.away ?? 0) };
    const cur = (st.maps || []).find((x) => x.number === st.current_map);
    if (st.current_map) out.clock = `Mapa ${st.current_map}${cur ? ` · ${cur.name || ''} ${cur.home ?? 0}-${cur.away ?? 0}`.replace(/\s+/g, ' ') : ''}`;
    if (fin(h.maps_won) != null && fin(a.maps_won) != null) out.score = [h.maps_won, a.maps_won];
  } else return null;
  return out;
}

module.exports = { build };
