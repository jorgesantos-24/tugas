'use strict';
/* Mercados de jogadores do futebol (remates, remates à baliza, marcadores, assistências, faltas, desarmes,
   defesas, passes, cartões) — liquidados sozinhos com as estatísticas por jogador da MoviOdds.

   Cada cotação vira { k: 'pp', per: '<estatística>|<grupo>', pick: '<N>#<home|away|>#<nome>' } = "o jogador faz N ou mais".
   Só se abrem mercados cuja estatística a fonte costuma trazer para essa liga (ver coverage) ou, nas taças sem
   histórico, quando o jogo ao vivo já traz estatísticas de jogadores. Mercados que não se conseguem decidir
   (1º/último marcador, "um dos dois", cabeceamentos, remates de fora da área, "/suplente"...) não se abrem.

   Regras (como na bet365): conta só o tempo regulamentar; jogador que não jogou → devolvida;
   autogolos não contam como gol do jogador; "cartão" = amarelo ou vermelho. */

const M = require('../public/markets.js');
const { ppNorm: norm, PP_FIELD: FIELD } = M;
const plus = (s) => { const m = /^\s*(\d+)\s*\+\s*$/.exec(String(s ?? '')); return m ? Number(m[1]) : null; };
const STAT_PT = { goals: 'gols', shots: 'remates', sot: 'remates à baliza', assists: 'assistências', ga: 'gols + assistências', fouls: 'faltas cometidas', fouled: 'faltas sofridas', tackles: 'desarmes', saves: 'defesas', passes: 'passes', booked: 'cartões', sent: 'expulsões' };

// uma cotação → seleção de jogador, ou null (não é de jogador / não se consegue liquidar)
function quote(q, m) {
  const g = String(q.group_name ?? '').trim();
  const side = (team) => (team === m.home ? 'home' : team === m.away ? 'away' : '');
  const mk = (stat, n, name, team) => (n >= 1 && name ? { k: 'pp', per: `${stat}|${q.group_id}`, pick: `${n}#${side(team)}#${String(name).trim()}` } : null);
  switch (g) {
    case 'Goalscorers': return /^anytime$/i.test(String(q.side ?? '').trim()) ? mk('goals', 1, q.line, q.n2) : null;
    case 'Multi Scorers': { const n = Number((/^(\d) or More$/i.exec(String(q.side ?? '').trim()) || [])[1]); return n ? mk('goals', n, q.line, q.n2) : null; }
    case 'Score or Assist': { const s = String(q.side ?? '').trim(); const stat = /^score or assist$/i.test(s) ? 'ga' : /^score$/i.test(s) ? 'goals' : /^assist$/i.test(s) ? 'assists' : null; return stat ? mk(stat, 1, q.line, q.n2) : null; }
    case 'Shots': return mk('shots', plus(q.side), q.line, q.n2);
    case 'Shots On Target': return mk('sot', plus(q.side), q.line, q.n2);
    case 'Tackles': return mk('tackles', plus(q.side), q.line, q.n2);
    case 'Fouls Committed': return mk('fouls', plus(q.side), q.line, q.n2);
    case 'To Be Fouled': return mk('fouled', plus(q.side), q.line, q.n2);
    case 'Goalkeeper Saves': return mk('saves', plus(q.side), q.line, q.n2);
    case 'Passes': return mk('passes', plus(q.label), q.line, q.n2);
    case 'Player Shots': return mk('shots', plus(q.label), q.side, q.n2);
    case 'Player Shots on Target': return mk('sot', plus(q.label), q.side, q.n2);
    case 'Player Fouls Committed': return mk('fouls', plus(q.label), q.side, q.n2);
    case 'Player To Be Fouled': return mk('fouled', plus(q.label), q.side, q.n2);
    case 'Player Assists': return mk('assists', plus(q.label), q.side, q.n2);
    case 'Player to be Booked': return mk('booked', 1, q.label, q.n2);
    // "expulso" não abre: a fonte falha vermelhos (ex.: Santa Clara x Benfica 26/10, vermelho na ESPN que a MoviOdds não tem)
    case 'Cards': return /^booked$/i.test(String(q.side ?? '').trim()) ? mk('booked', 1, q.line, q.n2) : null;
  }
  return null;
}
// grupos de jogadores que não se abrem (não há como liquidar sozinho)
const UNSETTLED = /player|scorer|either to|assist|goalkeeper|saves|headed|booked|sent off|tackles|^shots|fouls committed|to be fouled|^cards$|^passes$|goal method|goal type/i;
const isPlayerGroup = (g) => UNSETTLED.test(String(g ?? ''));

/* Jogadores do fim do jogo (estatísticas): [{ key, side, played, ...campos }] ou null.
   played = titular, entrou, ou tem algum número acima de zero (quem marcou jogou de certeza — 28/10, London City x
   Crystal Palace: a fonte trouxe só nome e gols, sem titular/entrou, e Isobel Goodwin com 3 gols contava como "não jogou").
   Se a fonte não traz titular/entrou para ninguém nesse jogo e a pessoa está a zeros: played = null (não se sabe). */
const hasLineup = (list) => list.some((p) => p && (p.starter != null || p.subbed_on != null));
function roster(st) {
  const list = st?.players;
  if (!Array.isArray(list) || !list.length) return null;
  const lineup = hasLineup(list);
  return list.filter((p) => p && p.name).map((p) => {
    const any = Object.entries(p).some(([k, v]) => typeof v === 'number' && v > 0 && k !== 'id' && k !== 'subbed_on' && k !== 'shirt' && k !== 'number');
    const played = !!p.starter || p.subbed_on != null || any ? true : lineup ? false : null;
    return { ...p, key: norm(p.name), side: p.team === 'home' || p.team === 'away' ? p.team : '', played };
  });
}

/* Cobertura por liga: de cada estatística, que parte dos jogos terminados a trazia para quem jogou.
   coverage[liga][estatística] = { n, ok } — usada para decidir se o mercado abre. */
const coverage = new Map();
const PARTS = require('./parts.js');
function addCoverage(leagueKey, st, map = coverage) {
  const ps = roster(st);
  const c = map.get(leagueKey) || { games: 0, stats: {}, team: {} };
  c.games++;
  // estatísticas da equipa: escanteios, cartões e placar ao intervalo (mercados de escanteios, cartões e 1º/2º tempo)
  const team = (k, ok) => { const s = c.team[k] || { n: 0, ok: 0 }; s.n++; if (ok) s.ok++; c.team[k] = s; };
  team('corners', Number.isFinite(st?.home?.corners) && Number.isFinite(st?.away?.corners));
  team('cards', !!PARTS.soccerCards(st));
  team('ht', !!PARTS.soccerHT(st));
  const played = (ps || []).filter((p) => p.played);
  for (const stat of Object.keys(FIELD)) {
    const s = c.stats[stat] || { n: 0, ok: 0 };
    s.n++;
    // estatística presente para (quase) todos os que jogaram; defesas: pelo menos um guarda-redes
    const have = played.filter((p) => Number.isFinite(FIELD[stat](p))).length;
    if (played.length >= 18 && (stat === 'saves' ? have >= 1 : have >= played.length * 0.9)) s.ok++;
    c.stats[stat] = s;
  }
  map.set(leagueKey, c);
}
// abre o mercado? (liga com ≥3 jogos recentes e a estatística em ≥80% deles; se faltar num jogo, a seleção vai para a equipa)
function covered(leagueKey, stat) {
  const s = coverage.get(leagueKey)?.stats?.[stat];
  return !!s && s.n >= 3 && s.ok / s.n >= 0.8;
}

/* Mercados de escanteios / cartões / 1º-2º tempo: abrem se a fonte trouxe esse dado em ≥80% dos jogos recentes da
   liga (≥3 jogos). Na liquidação, se o dado faltar num jogo, a seleção vai para a equipa. */
function coveredTeam(leagueKey, kind) {
  const s = coverage.get(leagueKey)?.team?.[kind];
  return !!s && s.n >= 3 && s.ok / s.n >= 0.8;
}

module.exports = { hasLineup, quote, isPlayerGroup, roster, addCoverage, covered, coveredTeam, coverage, STAT_PT };
