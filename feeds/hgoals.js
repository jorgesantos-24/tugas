'use strict';
/* Hóquei: marcadores (NHL) e ordem dos gols.

   Marcadores ("Goalscorers" Anytime / First, "Last Goalscorer", "Multi goalscorers" 2 / 3 Or More) liquidados com o
   resumo oficial da ESPN: quem foi a jogo e os gols de cada um, pela ordem. Regras (como na bet365): conta a
   prorrogação, os pênaltis (shootout) não; jogador que não foi a jogo → devolvida. Só na NHL (outras ligas não dizem
   quem jogou). "Either Anytime Goalscorer" e o resto não se abrem.
   Cotação → { k: 'hgs', per: '<any|first|last|n2|n3>|<grupo>', pick: '<home|away>#<nome>' }

   Ordem dos gols (da cronologia da MoviOdds, "12' - Goal 3 - <equipa> - <marcador>"): R.gorder = ['home', 'away', ...]
   quando a numeração dos gols está completa e bate com o placar. */

const M = require('../public/markets.js');
const LEAGUES = new Set(['nhl']);
const TYPE = { Anytime: 'any', First: 'first' };
const LABEL = { any: 'Marca a qualquer momento', first: 'Primeiro a marcar', last: 'Último a marcar', n2: 'Marca 2 ou mais', n3: 'Marca 3 ou mais' };

function quote(q, m) {
  const g = String(q.group_name ?? '').trim(), side = String(q.side ?? '').trim();
  const type = g === 'Goalscorers' ? TYPE[side] : g === 'Last Goalscorer' ? 'last' : g === 'Multi goalscorers' ? { '2 Or More': 'n2', '3 Or More': 'n3' }[side] : null;
  if (!type) return null;
  const name = String(q.line ?? '').trim(), team = String(q.n2 ?? '').trim();
  const w = team === m.home ? 'home' : team === m.away ? 'away' : null;
  if (!name || !w) return null;
  // dois jogadores da mesma equipa com o mesmo nome curto (inicial + apelido) no grupo: não se distinguem
  const same = (m.quotes || []).filter((x) => x.group_id === q.group_id && String(x.n2 ?? '').trim() === team && String(x.side ?? '').trim() === side && M.bpKey(x.line) === M.bpKey(name));
  if (same.length > 1) return null;
  return { k: 'hgs', per: `${type}|${q.group_id}`, pick: `${w}#${name}`, mname: `Marcadores — ${LABEL[type]}`, cat: 'players', name };
}
const isScorerGroup = (g) => /goalscorer/i.test(String(g ?? ''));

// cronologia da MoviOdds → lados dos gols pela ordem (sem pênaltis), ou null se faltar algum
function goalOrder(r, home, away, fin, so) {
  const goals = new Map();
  for (const s of r?.stats?.summary || []) {
    const x = /^\d+' - Goal (\d+) - (.+?)(?: - .+)?$/.exec(String(s));
    if (!x) continue;
    const side = x[2] === home ? 'home' : x[2] === away ? 'away' : null;
    if (!side || goals.has(+x[1])) return null;
    goals.set(+x[1], side);
  }
  const n = fin[0] + fin[1] - (so && fin[0] !== fin[1] ? 1 : 0); // no shootout o gol decisivo às vezes entra no placar
  const order = Array.from({ length: n }, (_, i) => goals.get(i + 1));
  if (order.some((x) => !x) || goals.size !== n) return null;
  const h = order.filter((x) => x === 'home').length;
  return h === fin[0] - (so && fin[0] > fin[1] ? 1 : 0) && n - h === fin[1] - (so && fin[1] > fin[0] ? 1 : 0) ? order : null;
}

module.exports = { LEAGUES, quote, isScorerGroup, goalOrder };
