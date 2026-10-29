'use strict';
/* Mercados de jogadores do basquete (pontos, rebotes, assistências, cestas de 3, roubos, tocos, combinações,
   duplo-duplo, triplo-duplo) — liquidados sozinhos com o box score do jogo.

   Cada cotação vira { k: 'bp', per: '<estatística>|<grupo>', pick: '<N>#<home|away|>#<nome>' } = "o jogador faz N
   ou mais", ou pick 'u<N>#...' = "faz menos de N" (o "Menos de 23.5" = u24). Duplo-duplo: a estatística conta as
   categorias com 10 ou mais (pontos, rebotes, assistências, roubos, tocos) e o "Sim" é 2# (triplo: 3#).

   Formatos da MoviOdds (bet365):
   - antes do jogo, "Points": side = N, line = jogador, n2 = equipa
   - ao vivo, "Points": side = jogador, label = N, line = N - 0.5
   - "Points O/U": side = Over/Under, label = linha, line = jogador (n2 = equipa antes do jogo)
   - "Double Double": side = Yes/No, line = jogador

   Regras (como na bet365): conta o jogo todo, com prorrogação; jogador que não entra em quadra → devolvida.
   Só abre nas ligas com box score oficial na ESPN (a liquidação); o box score da MoviOdds serve o acompanhamento ao vivo.
   1º quarto, "Player First" (1ª cesta) e o resto não se abrem: não há dados para os liquidar. */

const M = require('../public/markets.js');
const { bpKey: key, BP_FIELD } = M;

const LEAGUES = new Set(['nba', 'wnba']); // box score oficial na ESPN
const STAT = {
  Points: 'pts', Rebounds: 'reb', Assists: 'ast', 'Threes Made': 'tpm', Steals: 'stl', Blocks: 'blk',
  'Points & Assists': 'pa', 'Points & Rebounds': 'pr', 'Assists & Rebounds': 'ar', 'Points, Assists & Rebounds': 'pra',
  'Steals & Blocks': 'sb', 'Double Double': 'dd', 'Triple Double': 'td',
};
const STAT_PT = {
  pts: 'Pontos', reb: 'Rebotes', ast: 'Assistências', tpm: 'Cestas de 3', stl: 'Roubos de bola', blk: 'Tocos',
  pa: 'Pontos + assistências', pr: 'Pontos + rebotes', ar: 'Assistências + rebotes', pra: 'Pontos + rebotes + assistências',
  sb: 'Roubos + tocos', dd: 'Duplo-duplo', td: 'Triplo-duplo', fb: 'Primeiro cesto', fa: 'Primeira assistência',
};
// minutos em quadra: número ou "22:32" (ao vivo)
const mins = (v) => { const m = /^(\d+):(\d+)$/.exec(String(v ?? '').trim()); return m ? Number(m[1]) + Number(m[2]) / 60 : Number(v) || 0; };
const num = (v) => { const s = String(v ?? '').trim(); return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null; };
const name = (v) => { const s = String(v ?? '').trim(); return s && num(s) == null && !/^(over|under|yes|no)$/i.test(s) ? s : null; };

// uma cotação → seleção de jogador, ou null
function quote(q, m) {
  const g = String(q.group_name ?? '').trim();
  const ou = / O\/U$/.test(g);
  // "Player First": primeiro cesto (side Basket, lance livre conta) e primeira assistência (Assist), pelo lance a lance
  // da ESPN; o primeiro rebote (Rebound) e os jogadores por quarto não se oferecem (decisão de 2026-10-29)
  const stat = g === 'Player First' ? { basket: 'fb', assist: 'fa' }[String(q.side ?? '').trim().toLowerCase()] : STAT[g.replace(/ O\/U$/, '')];
  if (!stat) return null;
  const side = (team) => (team === m.home ? 'home' : team === m.away ? 'away' : '');
  const sel = (pick, player, label) => ({
    k: 'bp', per: `${stat}|${q.group_id}`, pick, mname: `${STAT_PT[stat]} do jogador${ou ? ' (mais/menos)' : ''}`, cat: 'players', name: `${player} — ${label}`,
  });
  // primeiro cesto / assistência do jogo: jogador em line
  if (stat === 'fb' || stat === 'fa') { const p = name(q.line); return p ? sel(`1#${side(q.n2)}#${p}`, p, STAT_PT[stat].toLowerCase()) : null; }
  if (stat === 'dd' || stat === 'td') {
    const p = name(q.line), yes = /^yes$/i.test(String(q.side ?? '').trim()), no = /^no$/i.test(String(q.side ?? '').trim());
    const need = stat === 'dd' ? 2 : 3;
    return p && (yes || no) ? sel(`${yes ? '' : 'u'}${need}#${side(q.n2)}#${p}`, p, yes ? 'Sim' : 'Não') : null;
  }
  if (ou) {
    const s = String(q.side ?? '').trim().toLowerCase(), l = num(q.label), p = name(q.line);
    if (!p || l == null || l % 1 !== 0.5 || (s !== 'over' && s !== 'under')) return null; // linha inteira (empate devolvido) não se abre
    return sel(`${s === 'over' ? '' : 'u'}${Math.floor(l) + 1}#${side(q.n2)}#${p}`, p, `${s === 'over' ? 'Mais' : 'Menos'} de ${l}`);
  }
  // "N ou mais": antes do jogo N no side; ao vivo o jogador no side e N no label
  let n = num(q.side), p = name(q.line);
  if (n == null) { n = num(q.label); p = name(q.side); }
  if (!p || !Number.isInteger(n) || n < 1) return null;
  return sel(`${n}#${side(q.n2)}#${p}`, p, `${n} ou mais`);
}
// grupos de jogadores do basquete que não se abrem (sem regra ou sem dados para liquidar)
const isPlayerGroup = (g) => {
  const s = String(g ?? '').trim();
  return !!STAT[s.replace(/ O\/U$/, '')] || /^1st (Quarter|Half) (Points|Rebounds|Assists|Threes|Steals|Blocks)|^Player /i.test(s);
};

/* Box score da MoviOdds (estatísticas ao vivo ou do fim do jogo) → [{ key, side, played, pts, reb, ... }] ou null.
   played: esteve em quadra (minutos, em quadra agora, ou algum número acima de zero). */
function roster(st) {
  const list = st?.players;
  if (!Array.isArray(list) || !list.length || !list.some((p) => p?.box_score)) return null;
  return list.filter((p) => p && p.name && p.box_score).map((p) => {
    const b = p.box_score;
    const o = {
      key: key(p.name), name: String(p.name), side: p.team === 'home' || p.team === 'away' ? p.team : '',
      pts: b.points, reb: b.rebounds, ast: b.assists, tpm: b.three_pointers_made, stl: b.steals, blk: b.blocks, min: mins(b.minutes), on: !!b.on_court,
    };
    o.played = o.min > 0 || !!b.on_court || ['pts', 'reb', 'ast', 'stl', 'blk'].some((k) => o[k] > 0) || (Number(b.field_goals_attempted) || 0) > 0 || (Number(b.personal_fouls) || 0) > 0;
    return o;
  });
}

module.exports = { LEAGUES, STAT_PT, quote, isPlayerGroup, roster, mins, BP_FIELD };
