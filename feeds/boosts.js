'use strict';
/* Super Odds: combinações do Criar aposta escolhidas pelo sistema, com a odd aumentada, no topo do site.
   Só ligas top: futebol (Brasileirão Série A primeiro), NBA e ATP/WTA (simples). Por jogo, as combinações são tentadas por
   ordem e fica a primeira com odd entre MIN e MAX; um jogo por Super Odd enquanto houver jogos. As de 3 e 4 seleções vêm
   primeiro (SIZES: a 2ª Super Odd de cada desporto procura 4); as de 2 só quando o jogo não tem outra.
   Este ficheiro só escolhe as seleções; a odd (bet365 ou o nosso motor) e o aumento são do server.js. */
const SOCCER_TOP = ['bra.1', 'bra.copa', 'conmebol.lib', 'conmebol.sud', 'uefa.ucl', 'eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'uefa.uel'];
const PER_SPORT = 3;
const MIN = 2.5, MAX = 15;
const SIZES = [3, 4, 3]; // seleções preferidas na 1ª, 2ª e 3ª Super Odd de cada desporto
const FACTOR = 1.22; // 5.50 → 6.70

function leagueRank(ev) {
  if (ev.sport === 'soccer') { const i = SOCCER_TOP.indexOf(ev.league); return i < 0 ? -1 : i; }
  if (ev.sport === 'basketball') return ev.league === 'nba' ? 0 : -1;
  if (ev.sport === 'tennis') return /^ten\.(atp|wta)-/.test(ev.league) && !/-duplas$/.test(ev.league) && !/\//.test(ev.home?.name) ? 0 : -1;
  return -1;
}

// a seleção de um mercado com a odd mais perto de `target` (linha principal), opcionalmente filtrada
function nearest(list, target, ok = () => true) {
  let best = null;
  for (const s of list) if (ok(s) && (!best || Math.abs(s.odds - target) < Math.abs(best.odds - target))) best = s;
  return best;
}
const perIs = (s, re) => re.test(String(s.per ?? ''));

/* combinações de um jogo, por ordem de preferência: cada uma é uma lista de seleções do site (com bb) */
function combosOf(ev, sels) {
  const S = sels.filter((s) => s.bb && !s.locked && s.odds > 1.01);
  const by = (market, pick, line) => S.find((s) => s.market === market && s.per == null && s.pick === pick && (line === undefined || s.line === line));
  const ml = ['home', 'away'].map((p) => by('ml', p)).filter(Boolean);
  if (ml.length < 2) return [];
  const fav = ml[0].odds <= ml[1].odds ? ml[0] : ml[1], side = fav.pick;
  const out = [];
  const add = (...legs) => { if (legs.every(Boolean)) out.push(legs); };
  if (ev.sport === 'soccer') {
    const over = (line) => by('total', 'over', line);
    const btts = by('btts', 'yes');
    const corners = nearest(S.filter((s) => s.market === 'pteam' && perIs(s, /^corners/) && s.pick === `${side}:over`), 1.8, (s) => s.odds >= 1.5 && s.odds <= 2.3);
    const totCorners = nearest(S.filter((s) => s.market === 'ptot' && perIs(s, /^corners/) && s.pick === 'over'), 1.85);
    const cards = nearest(S.filter((s) => s.market === 'ptot' && perIs(s, /^cards/) && s.pick === 'over'), 1.85);
    // quem mais provavelmente marca no time favorito
    const scorer = nearest(S.filter((s) => s.market === 'pp' && perIs(s, /^goals/) && String(s.pick).split('#')[1] === side), 1, (s) => s.odds <= 4);
    if (fav.odds <= 2.4) {
      add(fav, over(1.5), corners);
      add(fav, btts, over(2.5));
      add(fav, scorer, over(2.5));
      add(fav, over(2.5), totCorners);
      add(fav, btts, over(2.5), corners);
      add(fav, scorer, over(1.5), corners);
      add(fav, over(1.5), corners, cards);
    }
    add(btts, over(2.5), cards);
    add(btts, over(2.5), totCorners);
    add(btts, over(2.5), totCorners, cards);
    if (fav.odds <= 2.4) { add(fav, btts); add(fav, scorer); add(fav, over(2.5)); }
    add(btts, over(2.5));
  } else if (ev.sport === 'basketball') {
    const total = nearest(S.filter((s) => s.market === 'total' && s.per == null && s.pick === 'over'), 1.9);
    // a estrela de cada time: a maior linha de pontos com odd entre 1,5 e 2,5
    const star = (sd, min = 0) => {
      let best = null;
      for (const s of S) {
        if (s.market !== 'bp' || !perIs(s, /^pts\b/)) continue;
        const [n, ps] = String(s.pick).split('#');
        if (ps !== sd || +n < min || s.odds < 1.5 || s.odds > 2.5) continue;
        if (!best || +n > +String(best.pick).split('#')[0]) best = s;
      }
      return best;
    };
    const other = side === 'home' ? 'away' : 'home';
    add(fav, star(side, 20), total);
    add(fav, star(side, 20), star(other, 20));
    add(star(side, 20), star(other, 20), total);
    add(fav, star(side, 15), total);
    add(fav, star(side, 20), star(other, 20), total);
    add(fav, star(side, 15), star(other, 15), total);
    add(fav, star(side, 20));
    add(fav, total);
    add(star(side, 20), star(other, 20));
  } else if (ev.sport === 'tennis') {
    const games = nearest(S.filter((s) => s.market === 'gtotal' && s.pick === 'over'), 1.85);
    const aces = nearest(S.filter((s) => s.market === 'tace' && s.per === side), 1.9, (s) => s.odds >= 1.5 && s.odds <= 2.6);
    const tb = S.find((s) => s.market === 'ttb' && s.pick === 'over' && s.line === 0.5);
    const set1 = S.find((s) => s.market === 'tsw' && String(s.per) === '1' && s.pick === side);
    const set1Games = nearest(S.filter((s) => s.market === 'tsgt' && String(s.per) === '1' && s.pick === 'over'), 1.9);
    add(fav, aces, tb);
    add(set1, fav, set1Games);
    add(fav, aces, games);
    add(fav, games, tb);
    add(fav, aces, tb, games);
    add(set1, fav, aces, tb);
    add(set1, fav, set1Games, aces);
    add(fav, games);
    add(fav, tb);
  }
  // sem repetir mercados e sem combinações iguais
  const seen = new Set();
  return out.filter((legs) => {
    const k = legs.map((s) => s.key).sort().join('~');
    if (seen.has(k) || new Set(legs.map((s) => `${s.market}|${s.per ?? ''}`)).size !== legs.length) return false;
    seen.add(k);
    return true;
  });
}

// as combinações com `want` seleções primeiro, depois as outras de 3 ou mais, as de 2 no fim (a ordem de cada grupo fica)
const prefer = (combos, want) => [...combos].sort((a, b) => (a.length === want ? 0 : a.length >= 3 ? 1 : 2) - (b.length === want ? 0 : b.length >= 3 ? 1 : 2));

// odd aumentada: base × FACTOR, a 0,05, pelo menos +0,10
const boosted = (base) => Math.max(Math.round((base + 0.1) * 100) / 100, Math.round(base * FACTOR * 20) / 20);

module.exports = { SOCCER_TOP, PER_SPORT, MIN, MAX, SIZES, FACTOR, leagueRank, combosOf, prefer, boosted };
