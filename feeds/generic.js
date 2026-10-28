'use strict';
const AUTO = require('./auto.js'); // mercados por parte do jogo com liquidação automática
const PLAYERS = require('./players.js'); // futebol: mercados de jogadores
const ET = require('./extratime.js'); // futebol: prolongamento e penáltis
/* Mercados "liquidados pela equipa": tudo o que a fonte oferece e que o site ainda não sabe decidir sozinho pelo
   placar (escanteios, cartões, jogador a marcar, rondas de um mapa...). Entram no site com o nome traduzido e,
   depois do jogo, aparecem no painel em "Mercados por liquidar" — a equipa marca as seleções vencedoras.

   Cada cotação vira { k: 'x', per: <código do grupo>, pick: <código da seleção>, name, mname, cat }. */

// tradução dos nomes da bet365 (frases maiores primeiro; o resto fica como vem)
const PHRASES = [
  ['Both Teams To Score', 'Ambas Marcam'], ['Both Teams to Score', 'Ambas Marcam'], ['Both Teams to Receive Cards', 'Ambas recebem cartão'],
  ['Match Corners', 'Total de escanteios'], ['Asian Corners', 'Escanteios asiáticos'], ['2-Way Corners', 'Total de escanteios (2 opções)'],
  ['Number Of Cards In Match', 'Total de cartões'], ['Number of Cards', 'Total de cartões'], ['Asian Total Cards', 'Total de cartões asiático'],
  ['Asian Handicap Cards', 'Handicap asiático de cartões'], ['Team Cards', 'Cartões da equipa'],
  ['Double Chance', 'Dupla Chance'], ['Draw No Bet', 'Empate Anula'], ['Full Time Result', 'Vitória no tempo regulamentar'], ['Fulltime Result', 'Vitória no tempo regulamentar'],
  ['Half Time/Full Time', 'Intervalo/Final'], ['Half Time Result', 'Resultado do 1º tempo'], ['Half Time Correct Score', 'Placar exato do 1º tempo'],
  ['Half Time Double Chance', 'Dupla chance do 1º tempo'], ['Correct Score', 'Placar exato'], ['Correct Round Score', 'Placar exato de rondas'],
  ['Correct Map Score', 'Placar exato de mapas'], ['Asian Handicap', 'Handicap asiático'], ['Handicap Result', 'Resultado com handicap'],
  ['Goal Line', 'Linha de gols'], ['Goals Over/Under', 'Total de gols'], ['Total Goals', 'Total de gols'], ['Match Goals', 'Gols da partida'],
  ['Team Total Goals', 'Gols da equipa'], ['Exact Total Goals', 'Número exato de gols'], ['Goals Range', 'Faixa de gols'], ['Number Of Goals In Match', 'Gols na partida'],
  ['Time Of First Goal', 'Minuto do 1º gol'], ['First Team To Score', 'Primeira equipa a marcar'], ['Last Team To Score', 'Última equipa a marcar'],
  ['Teams To Score', 'Equipas que marcam'], ['To Score In Half', 'Marca no tempo'], ['To Score In Both Halves', 'Marca nos dois tempos'],
  ['Clean Sheet', 'Sem sofrer gols'], ['Winning Margin', 'Margem de vitória'], ['Method Of Victory', 'Forma de vitória'], ['Goal Method', 'Tipo de gol'],
  ['Goalscorers', 'Marcadores'], ['Team Goalscorer', 'Marcador da equipa'], ['Multi Scorers', 'Marca várias vezes'], ['Either to Score', 'Um dos dois marca'],
  ['Score or Assist', 'Marca ou assiste'], ['Shots On Target', 'Remates à baliza'], ['Shots on Target', 'Remates à baliza'], ['Headed Shots', 'Cabeceamentos'],
  ['Outside Box', 'de fora da área'], ['Goalkeeper Saves', 'Defesas do guarda-redes'], ['To Be Fouled', 'Sofre faltas'], ['Fouls Committed', 'Faltas cometidas'],
  ['Throw Ins', 'Lançamentos laterais'], ['Free Kicks', 'Livres'], ['Goal Kicks', 'Pontapés de baliza'], ['Offsides', 'Foras de jogo'],
  ['Both Teams Combined', 'As duas equipas'], ['Corners Race', 'Corrida de escanteios'], ['Team to Get Most', 'Equipa com mais'], ['Total Corners', 'Total de escanteios'],
  ['Asian Total Corners', 'Total asiático de escanteios'], ['Team Corners', 'Escanteios da equipa'], ['Corners', 'Escanteios'], ['Corner', 'Escanteio'],
  ['Cards', 'Cartões'], ['Card', 'Cartão'], ['Booking Points', 'Pontos de cartões'], ['Tackles', 'Desarmes'], ['Shots', 'Remates'], ['Specials', 'Especiais'],
  ['Alternative', 'Alternativo'], ['Additional', 'Adicional'], ['1st Half', '1º tempo'], ['2nd Half', '2º tempo'], ['First Half', '1º tempo'], ['Second Half', '2º tempo'],
  ['Half Time', 'Intervalo'], ['Full Time', 'Final'], ['First 10 Minutes', 'Primeiros 10 minutos'], ['10 Minute Result', 'Resultado aos 10 minutos'],
  ['1st Quarter', '1º quarto'], ['2nd Quarter', '2º quarto'], ['3rd Quarter', '3º quarto'], ['4th Quarter', '4º quarto'], ['Quarter', 'Quarto'],
  ['1st Period', '1º período'], ['2nd Period', '2º período'], ['3rd Period', '3º período'], ['Period', 'Período'],
  ['Race to', 'Corrida a'], ['Race To', 'Corrida a'], ['Team Totals', 'Totais da equipa'], ['Team Total', 'Total da equipa'], ['Game Total', 'Total do jogo'],
  ['Odd/Even', 'Par/Ímpar'], ['Odd Or Even', 'Par ou ímpar'], ['Double Result', 'Resultado duplo'], ['Match Result', 'Resultado'], ['Result', 'Resultado'],
  ['Points, Assists & Rebounds', 'Pontos, assistências e ressaltos'], ['Points & Rebounds', 'Pontos e ressaltos'], ['Points & Assists', 'Pontos e assistências'],
  ['Assists & Rebounds', 'Assistências e ressaltos'], ['Steals & Blocks', 'Roubos e desarmes de lançamento'], ['Threes Made', 'Triplos'], ['Rebounds', 'Ressaltos'],
  ['Assists', 'Assistências'], ['Steals', 'Roubos de bola'], ['Blocks', 'Desarmes de lançamento'], ['Points', 'Pontos'], ['Turnovers', 'Perdas de bola'],
  ['Goalscorer', 'Marcador'], ['Power Play', 'Power play'], ['Shootout', 'Pênaltis'], ['Overtime', 'Prorrogação'], ['Regular Time', 'Tempo regulamentar'],
  ['Map Duration', 'Duração do mapa'], ['Map Winner', 'Vencedor do mapa'], ['Total Rounds', 'Total de rondas'], ['Rounds Handicap', 'Handicap de rondas'],
  ['Kill Handicap', 'Handicap de abates'], ['Total Kills', 'Total de abates'], ['Player Total Kills', 'Abates do jogador'], ['Player Total Deaths', 'Mortes do jogador'],
  ['Pistol Rounds', 'rondas de pistola'], ['Bomb Planted', 'Bomba plantada'], ['Method of Victory', 'Forma de vitória'], ['First Blood', 'Primeiro abate'],
  ['Map', 'Mapa'], ['Round', 'Ronda'], ['Lines', 'Linhas'], ['Winner', 'Vencedor'], ['Handicap', 'Handicap'], ['Total', 'Total'], ['Match', 'Partida'],
  ['Player', 'Jogador'], ['Team', 'Equipa'], ['To Win', 'Vencer'], ['Both Teams', 'Ambas as equipas'], ['Either Team', 'Qualquer equipa'],
  ['Set', 'Set'], ['Game', 'Game'], ['Point Betting', 'Ponto a ponto'], ['Tie Break', 'Tie-break'], ['Score', 'Placar'],
];
const WORDS = [['Over or Exactly', 'Mais ou exatamente'], ['Over', 'Mais de'], ['Under', 'Menos de'], ['Exactly', 'Exatamente'], ['Yes', 'Sim'], ['No', 'Não'],
  ['Draw', 'Empate'], ['Tie', 'Empate'], ['Odd', 'Ímpar'], ['Even', 'Par'], ['First', 'Primeiro'], ['Last', 'Último'], ['Anytime', 'A qualquer momento'],
  ['No Goals', 'Sem gols'], ['Goals', 'gols'], ['Goal', 'gol'], ['or More', 'ou mais'], ['Any Other', 'Outro'], ['Only', 'só'], ['Booked', 'Recebe cartão']];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PH_RE = PHRASES.map(([en, pt]) => [new RegExp(`\\b${esc(en)}\\b`, 'g'), pt]);
const WD_RE = WORDS.map(([en, pt]) => [new RegExp(`\\b${esc(en)}\\b`, 'g'), pt]);
// os nomes repetem-se em milhares de cotações: cada tradução é feita uma vez e guardada (era o que mais gastava CPU)
const trCache = new Map();
function tr(s, words) {
  const key = (words ? 'w|' : 'p|') + String(s ?? '');
  let x = trCache.get(key);
  if (x !== undefined) return x;
  x = String(s ?? '');
  for (const [re, pt] of words ? WD_RE : PH_RE) x = x.replace(re, pt);
  x = x.replace(/\s+/g, ' ').trim();
  if (trCache.size > 200000) trCache.clear();
  trCache.set(key, x);
  return x;
}

// secção do site para cada mercado (pelo nome do grupo)
function catOf(sport, g) {
  if (sport === 'soccer') {
    if (/corner/i.test(g)) return 'corners';
    if (/card|booking/i.test(g)) return 'cards';
    if (/scorer|shots|tackle|fouled|fouls|assist|saves|goalkeeper|headed|either to score|goal method|player/i.test(g)) return 'players';
    if (/throw|free kick|goal kick|offside/i.test(g)) return 'stats';
    if (/half|1st|2nd|minute|10 min/i.test(g)) return 'halves';
    if (/handicap/i.test(g)) return 'hcp';
    if (/goal|score|clean sheet|margin/i.test(g)) return 'goals';
    return 'pop';
  }
  if (sport === 'basketball') {
    if (/^(1st (Quarter|Half) )?(Points|Rebounds|Assists|Threes|Steals|Blocks|Turnovers|Double|Triple)|& (Rebounds|Assists|Blocks)/i.test(g)) return 'players';
    if (/quarter/i.test(g)) return 'quarters';
    if (/half/i.test(g)) return 'halves';
    if (/line|handicap|total|margin|race/i.test(g)) return 'hcp';
    return 'pop';
  }
  if (sport === 'hockey') {
    if (/scorer|shots|points|assists|saves|power play/i.test(g)) return 'players';
    if (/period|10 minute/i.test(g)) return 'periods';
    if (/line|handicap|total|margin/i.test(g)) return 'hcp';
    return 'pop';
  }
  if (sport === 'tennis') {
    if (/point|tie break/i.test(g)) return 'points';
    if (/game/i.test(g)) return 'games';
    if (/break|serv/i.test(g)) return 'serve';
    if (/set/i.test(g)) return 'sets';
    return 'other';
  }
  if (sport === 'esports') {
    const m = /Map (\d+)/i.exec(g);
    if (m) return 'map' + m[1];
    if (/player/i.test(g)) return 'players';
    return 'pop';
  }
  return 'other';
}

// nome da seleção a partir dos campos da cotação (lado, rótulo, linha), sem repetir o que já está no nome do mercado
function selName(q, m) {
  const parts = [];
  const add = (v) => { const s = String(v ?? '').trim(); if (s && !parts.some((p) => p.toLowerCase() === s.toLowerCase())) parts.push(s); };
  add(q.side); add(q.label);
  if (q.line != null && !/^(To Win|Line|Total|Match)$/i.test(String(q.line))) add(q.line);
  if (q.n2 && !/^(1|X|2|1X|12|X2|2X)$/.test(q.n2) && q.n2 !== m.home && q.n2 !== m.away) add(`(${q.n2})`);
  if (q.handicap != null && !parts.some((p) => p.includes(String(q.handicap).replace(/^\+/, '')))) add(q.handicap);
  return tr(parts.join(' ').replace(/\s*\(Svr\)/g, ''), true) || '—';
}

function quote(q, m, sport) {
  if (!q.group_id || !(q.sel_id || q.market_id)) return null;
  const gen = {
    k: 'x', per: String(q.group_id), pick: String(q.sel_id || `${q.market_id}:${q.label}:${q.side}:${q.line}`),
    name: selName(q, m), mname: tr(q.group_name), cat: catOf(sport, String(q.group_name)),
  };
  // tempos, quartos, períodos, escanteios, rondas: com regra de liquidação (feeds/auto.js) deixam de ir para a equipa
  const s = AUTO.apply(gen, q, m, sport);
  if (sport !== 'soccer' || s.k !== 'x') return s;
  /* Futebol (decisão de 2026-10-27): os mercados da equipa saem, exceto
     - jogadores: liquidados sozinhos com as estatísticas por jogador (os que não dá para liquidar não abrem);
     - prolongamento / penáltis: só os que têm regra (liquidados com a ESPN); os outros (escanteios do prolongamento,
       handicaps/linhas do prolongamento, cada penálti, morte súbita...) não se oferecem (decisão de 2026-10-28). */
  const pp = PLAYERS.quote(q, m);
  if (pp) return { ...gen, ...pp };
  if (PLAYERS.isPlayerGroup(q.group_name) || soccerPlayer(q, m)) return null;
  const et = ET.quote(q, m);
  if (et) return { ...gen, ...et };
  return null;
}
// a seleção é um jogador ("line" = jogador e "n2" = a equipa dele)?
function soccerPlayer(q, m) {
  const teams = [m.home, m.away];
  return !!q.n2 && teams.includes(q.n2) && !!q.line && !teams.includes(q.line) && !/^(draw|tie|match|\d)/i.test(String(q.line));
}

module.exports = { quote, tr, catOf };
