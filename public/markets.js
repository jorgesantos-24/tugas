'use strict';
/* Lógica partilhada entre o servidor (Node) e o navegador:
   campeonatos, mercados, liquidação e cash out.
   Os jogos e as odds vêm do servidor, que os lê da fonte de dados (feeds/moviodds.js). */

const SPORTS = {
  soccer: { name: 'Futebol', icon: '⚽' },
  basketball: { name: 'Basquete', icon: '🏀' },
  tennis: { name: 'Tênis', icon: '🎾' },
  hockey: { name: 'Hóquei no Gelo', icon: '🏒' },
  esports: { name: 'e-Sports', icon: '🎮' },
};
// modalidades em que um ponto muda o jogo (gol): mercados suspensos uns segundos e aposta ao vivo recusada se houver gol na aprovação
const GOAL_SPORTS = new Set(['soccer', 'hockey']);

/* Campeonatos no site, pela ordem em que aparecem.
   src = nome exato do campeonato na fonte de dados (campo "league" da MoviOdds); re = vários torneios (ténis). */
const LEAGUES = [
  ['Brazil Serie A', 'bra.1', 'Brasileirão Série A', 'Brasil'],
  ['Brazil Serie B', 'bra.2', 'Brasileirão Série B', 'Brasil'],
  ['Copa do Brasil', 'bra.copa', 'Copa do Brasil', 'Brasil'],
  ['Copa Libertadores', 'conmebol.lib', 'Copa Libertadores', 'América do Sul'],
  ['Copa Sudamericana', 'conmebol.sud', 'Copa Sul-Americana', 'América do Sul'],
  ['UEFA Champions League', 'uefa.ucl', 'Liga dos Campeões', 'Europa'],
  ['UEFA Europa League', 'uefa.uel', 'Liga Europa', 'Europa'],
  ['UEFA Conference League', 'uefa.uecl', 'Liga Conferência', 'Europa'],
  ['England Premier League', 'eng.1', 'Premier League', 'Inglaterra'],
  ['England Championship', 'eng.2', 'Championship', 'Inglaterra'],
  ['England EFL Cup', 'eng.efl', 'Copa da Liga Inglesa', 'Inglaterra'],
  ['Spain La Liga', 'esp.1', 'LaLiga', 'Espanha'],
  ['Spain Copa del Rey', 'esp.copa', 'Copa do Rei', 'Espanha'],
  ['Italy Serie A', 'ita.1', 'Serie A', 'Itália'],
  ['Germany Bundesliga I', 'ger.1', 'Bundesliga', 'Alemanha'],
  ['Germany DFB Pokal', 'ger.copa', 'Copa da Alemanha', 'Alemanha'],
  ['France Ligue 1', 'fra.1', 'Ligue 1', 'França'],
  ['Portugal Primeira Liga', 'por.1', 'Liga Portugal', 'Portugal'],
  ['Netherlands Eredivisie', 'ned.1', 'Eredivisie', 'Holanda'],
  ['Türkiye Super Lig', 'tur.1', 'Süper Lig', 'Turquia'],
  ['Saudi Arabia Pro League', 'sau.1', 'Saudi Pro League', 'Arábia Saudita'],
  ['Argentina Liga Profesional', 'arg.1', 'Liga Profesional', 'Argentina'],
  ['Mexico Liga MX', 'mex.1', 'Liga MX', 'México'],
  ['USA MLS', 'usa.1', 'MLS', 'EUA'],
].map(([src, key, name, country]) => ({ src, key, name, country, sport: 'soccer' })).concat([
  ['NBA', 'nba', 'NBA', 'EUA'],
  ['NCAAB', 'ncaab', 'NCAA', 'EUA'],
  ['Euroleague', 'euroleague', 'Euroliga', 'Europa'],
  ['Euro Cup', 'eurocup', 'EuroCup', 'Europa'],
  ['Basketball Champions League', 'bcl', 'Basketball Champions League', 'Europa'],
  ['Brazil NBB', 'nbb', 'NBB', 'Brasil'],
  ['Argentina Liga Nacional', 'arg.lnb', 'Liga Nacional', 'Argentina'],
].map(([src, key, name, country]) => ({ src, key, name, country, sport: 'basketball' }))).concat([
  [/^ATP /, 'atp', 'ATP', 'Masculino'],
  [/^WTA /, 'wta', 'WTA', 'Feminino'],
  [/^Challenger /, 'challenger', 'Challenger', 'Masculino'],
  [/^M\d+ /, 'itf.m', 'ITF Masculino', 'Mundo'],
  [/^W\d+ /, 'itf.w', 'ITF Feminino', 'Mundo'],
].map(([re, key, name, country]) => ({ re, key, name, country, sport: 'tennis' }))).concat([
  ['NHL', 'nhl', 'NHL', 'EUA'],
  ['AHL', 'ahl', 'AHL', 'EUA'],
  ['Champions Hockey League', 'chl', 'Champions Hockey League', 'Europa'],
  ['Swedish Hockey League', 'shl', 'SHL', 'Suécia'],
  ['Finland SM Liiga', 'liiga', 'Liiga', 'Finlândia'],
  ['Switzerland NLA', 'nla', 'National League', 'Suíça'],
  ['Czechia Extraliga', 'cze.hockey', 'Extraliga', 'Chéquia'],
  ['Germany Eishockey Liga', 'del', 'DEL', 'Alemanha'],
].map(([src, key, name, country]) => ({ src, key, name, country, sport: 'hockey' }))).concat([
  // e-Sports: um campeonato por jogo; cada torneio fica a seguir ao seu jogo (como no ténis)
  [/^CS2 - /, 'cs2', 'Counter-Strike 2'],
  [/^VALORANT - /, 'valorant', 'Valorant'],
  [/^LOL - /, 'lol', 'League of Legends'],
  [/^DOTA2 - /, 'dota2', 'Dota 2'],
].map(([re, key, name]) => ({ re, key, name, country: name, sport: 'esports' })));
LEAGUES.forEach((l, i) => { l.order = i; });
const LEAGUE_BY_KEY = Object.fromEntries(LEAGUES.map((l) => [l.key, l]));

/* Campeonatos criados na hora: cada torneio de ténis é um campeonato próprio ("ATP Basel"), arrumado
   a seguir ao seu circuito (ATP, WTA, Challenger, ITF) e por ordem alfabética.
   O servidor cria-os ao ler a fonte e envia-os ao navegador no feed (campo "leagues"). */
function addLeague(l) {
  if (LEAGUE_BY_KEY[l.key]) return LEAGUE_BY_KEY[l.key];
  const x = { key: l.key, name: l.name, country: l.country || '', sport: l.sport, order: l.order ?? 999, dyn: true };
  LEAGUES.push(x); LEAGUE_BY_KEY[x.key] = x;
  // ligas criadas na hora: por ordem, depois por país (ou circuito, no ténis) e por nome
  LEAGUES.sort((a, b) => a.order - b.order || (a.dyn && b.dyn ? a.country.localeCompare(b.country) || a.name.localeCompare(b.name) : 0));
  return x;
}
const dynLeagues = () => LEAGUES.filter((l) => l.dyn).map(({ key, name, country, sport, order }) => ({ key, name, country, sport, order }));

const round2 = (n) => Math.round(n * 100) / 100;

/* ---------- mercados ----------
   ev.markets = [{ k, main?, sels: [{ pick, line?, base?, odds, lock? }] }]
     Futebol:  ml (1X2) · dc (dupla chance) · dnb (empate anula) · btts (ambas marcam) · total (gols) · spread (handicap asiático) · cs (placar exato)
     Basquete: ml (vencedor incl. prorrogação) · spread (handicap de pontos) · total (pontos)
     Hóquei:   mlr / dcr (1X2 e dupla chance no tempo regulamentar) · ml · spread (puck line) · total — estes três com prorrogação e pênaltis
     Tênis:    ml (vencedor) · set1 (vencedor do 1º set) · sets (resultado em sets) · tsets (total de sets) · sspread (handicap de sets)
               gspread (handicap de games) · gtotal (total de games)
     line: linha do total/handicap · base: placar de referência do handicap ao vivo do futebol ([casa, fora]; só contam os gols depois) */
const fmtLine = (l) => (l > 0 ? '+' + l : String(l));
const MARKET_NAMES = {
  ml: (s, ev) => ({ soccer: 'Resultado Final', basketball: 'Vencedor (incl. prorrogação)', hockey: 'Vencedor (incl. prorrogação e pênaltis)', tennis: 'Vencedor da partida', esports: 'Vencedor da partida' }[ev.sport]),
  // e-Sports
  ecs: () => 'Placar exato (mapas)',
  emh: () => 'Handicap de mapas',
  e1m: (s, ev) => `${s.per === 'home' ? ev.home.short : ev.away.short}: ganha pelo menos um mapa?`,
  emw: (s) => `Vencedor do mapa ${s.per}`,
  mlr: () => 'Resultado no tempo regulamentar',
  dc: () => 'Dupla Chance',
  dcr: () => 'Dupla Chance (tempo regulamentar)',
  dnb: () => 'Empate Anula Aposta',
  btts: () => 'Ambas Marcam',
  total: (s, ev) => ({ soccer: 'Total de Gols', basketball: 'Total de Pontos', hockey: 'Total de Gols (incl. prorrogação e pênaltis)' }[ev.sport]),
  spread: (s, ev) => (ev.sport === 'basketball' ? 'Handicap de Pontos' : ev.sport === 'hockey' ? 'Handicap (incl. prorrogação e pênaltis)'
    : s.base ? `Handicap Asiático (a partir de ${s.base[0]}-${s.base[1]})` : 'Handicap Asiático'),
  cs: () => 'Placar Exato',
  set1: () => 'Vencedor do 1º Set',
  sets: () => 'Resultado em Sets',
  tsets: () => 'Total de Sets',
  sspread: () => 'Handicap de Sets',
  gspread: () => 'Handicap de Games',
  gtotal: () => 'Total de Games',
};
const TOTALS = new Set(['total', 'gtotal']), SPREADS = new Set(['spread', 'sspread', 'gspread']);

/* ---------- mercados por parte do jogo (feeds/auto.js) ----------
   O nome e as seleções vêm traduzidos da fonte (como os mercados da equipa), mas liquidam-se sozinhos.
   per = "<parte>|<grupo>" · parte: ft (jogo) · h1/h2 (tempos) · q1..q4 (quartos) · p1..p3 (períodos) · corners · map1..
   R.parts[parte] = [casa, fora] (placar dessa parte); sem ela → null (fica para a equipa). */
const AUTO_KINDS = new Set(['p1x2', 'pdc', 'pcs', 'ptot', 'pspr', 'pbtts', 'phtft', 'pteam', 'pcln', 'pmost', 'poe', 'pml2', 'pot', 'pcond']);
// mercados com nome e seleções traduzidos da fonte, liquidados sozinhos (por parte do jogo, jogadores, prolongamento/penáltis)
const SOURCE_KINDS = new Set([...AUTO_KINDS, 'pp', 'pet']);
// uma condição de "pcond" (ver feeds/auto.js) com o placar [h, a]; null = condição desconhecida
function condOK(c, h, a) {
  const [key, val = ''] = c.split('=');
  const res = h > a ? 'home' : h < a ? 'away' : 'draw';
  if (key === 'res') return res === val;
  if (key === 'dc') return val === 'hd' ? h >= a : val === 'da' ? a >= h : val === 'ha' ? h !== a : null;
  if (key === 'btts') return (h > 0 && a > 0) === (val === 'yes');
  if (key === 'tot' || key === 'th' || key === 'ta') {
    const n = key === 'tot' ? h + a : key === 'th' ? h : a;
    const [op, arg = ''] = val.split(':');
    if (op === 'gt') return n > Number(arg);
    if (op === 'lt') return n < Number(arg);
    if (op === 'eq') return n === Number(arg);
    if (op === 'in') { const [lo, hi] = arg.split('-').map(Number); return n >= lo && n <= hi; }
  }
  return null;
}
const scopeOf = (leg) => String(leg.per ?? '').split('|')[0];
function partScore(R, scope) {
  if (scope === 'ft') return Number.isFinite(R.h) && Number.isFinite(R.a) ? [R.h, R.a] : null;
  if (scope === 'reg') return Array.isArray(R.reg) ? R.reg : R.parts?.reg || null; // hóquei: tempo regulamentar
  const s = R.parts?.[scope];
  return Array.isArray(s) && s.length === 2 && s.every(Number.isFinite) ? s : null;
}
/* ---------- jogadores (futebol) ----------
   pp: per = "<estatística>|<grupo>", pick = "<N>#<home|away|>#<nome>" → o jogador faz N ou mais.
   R.players = estatísticas por jogador do fim do jogo ({ key: nome normalizado, side, played, goals, shots... }) */
const ppNorm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const PP_FIELD = {
  goals: (p) => p.goals, shots: (p) => p.shots, sot: (p) => p.shots_on_target, assists: (p) => p.assists,
  ga: (p) => (Number.isFinite(p.goals) && Number.isFinite(p.assists) ? p.goals + p.assists : undefined),
  fouls: (p) => p.fouls, fouled: (p) => p.fouls_drawn, tackles: (p) => p.tackles, saves: (p) => p.saves, passes: (p) => p.passes,
  booked: (p) => (Number.isFinite(p.yellow_cards) && Number.isFinite(p.red_cards) ? p.yellow_cards + p.red_cards : undefined),
  sent: (p) => p.red_cards,
};
// o registo do jogador de uma seleção (null se não for possível identificá-lo sem dúvidas)
function ppPlayer(leg, players) {
  const [, side, ...rest] = String(leg.pick).split('#');
  const name = ppNorm(rest.join('#'));
  const found = (players || []).filter((p) => p.key === name && (!side || !p.side || p.side === side));
  return name && found.length === 1 ? found[0] : null;
}
function ppOutcome(leg, R) {
  if (R.extraTime || R.et?.end === 'aet') return null; // houve prolongamento: as estatísticas podem incluí-lo → a equipa confere
  if (R.needEt && !R.et) return null; // eliminatória empatada aos 90': à espera da ESPN (prolongamento?)
  const get = PP_FIELD[String(leg.per ?? '').split('|')[0]];
  const p = get && R.players ? ppPlayer(leg, R.players) : null;
  if (!p) return null; // jogador não encontrado: a equipa confere
  if (!p.played) return 0; // não jogou: devolvida
  const v = get(p);
  if (!Number.isFinite(v)) return null;
  return v >= Number(String(leg.pick).split('#')[0]) ? 1 : -1;
}

/* ---------- prolongamento e penáltis (futebol, resultado da ESPN) ----------
   pet: per = "<tipo>|<grupo>" · R.et = { end: 'ft'|'aet'|'pens', winner: 'home'|'away'|null, pens: [c, f] | null,
   qualified: 'home'|'away'|null (quem passa; null = não se sabe, ex.: 1ª mão) } — sem R.et → equipa */
function petOutcome(leg, R) {
  const E = R.et;
  if (!E) return null;
  const type = String(leg.per ?? '').split('|')[0], pk = String(leg.pick), W = (c) => (c ? 1 : -1);
  const yes = pk === 'yes';
  switch (type) {
    case 'qualify': return E.qualified ? W(E.qualified === pk) : null;
    case 'method': { // "home:90" / "away:et" / "home:pens" — quem ganha o jogo e como
      if (!E.winner || E.twoLegs) return null; // eliminatória a duas mãos: o vencedor do jogo ≠ quem passa → equipa
      const how = E.end === 'pens' ? 'pens' : E.end === 'aet' ? 'et' : '90';
      return W(pk === `${E.winner}:${how}`);
    }
    case 'wonet': return W((E.end === 'aet') === yes);
    case 'wonpens': return W((E.end === 'pens') === yes);
    case 'shootwin': return E.pens ? W((E.pens[0] > E.pens[1] ? 'home' : 'away') === pk) : 0; // sem penáltis: devolvida
    case 'shootcs': { // "home:4-3" = a casa ganha 4-3
      if (!E.pens) return 0;
      const [side, sc] = pk.split(':');
      const w = E.pens[0] > E.pens[1] ? 'home' : 'away';
      const s = w === 'home' ? `${E.pens[0]}-${E.pens[1]}` : `${E.pens[1]}-${E.pens[0]}`;
      return W(side === w && sc === s);
    }
    case 'shoottot': case 'shoothome': case 'shootaway': {
      if (!E.pens) return 0;
      const v = type === 'shoottot' ? E.pens[0] + E.pens[1] : type === 'shoothome' ? E.pens[0] : E.pens[1];
      return Math.sign(pk === 'over' ? v - leg.line : leg.line - v);
    }
  }
  return null;
}

function partOutcome(leg, R) {
  const scope = scopeOf(leg), W = (c) => (c ? 1 : -1);
  const res = (x) => (x[0] > x[1] ? 'home' : x[0] < x[1] ? 'away' : 'draw');
  if (leg.market === 'phtft') { // intervalo / final: "home-draw"
    const ht = partScore(R, 'h1'), ft = partScore(R, 'ft');
    if (!ht || !ft) return null;
    return W(leg.pick === `${res(ht)}-${res(ft)}`);
  }
  const s = partScore(R, scope);
  if (!s) return null;
  const [h, a] = s, pk = String(leg.pick);
  const as = (market, pick, line, x = h, y = a) => legOutcome({ market, pick, line }, { h: x, a: y });
  switch (leg.market) {
    case 'p1x2': return as('ml', pk);
    case 'pdc': return as('dc', pk);
    case 'pcs': return W(pk === `${h}-${a}`);
    case 'ptot': return as('total', pk, leg.line);
    case 'pspr': return as('spread', pk, leg.line);
    case 'pbtts': return as('btts', pk);
    case 'pml2': return h === a ? 0 : W(res(s) === pk); // empate na parte: devolvida
    case 'pmost': return W(res(s) === pk);
    case 'poe': return W(((h + a) % 2 ? 'odd' : 'even') === pk);
    case 'pot': return W((h + a > 24) === (pk === 'yes')); // CS2 / Valorant: 12-12 → prolongamento (mais de 24 rondas)
    case 'pteam': { const [side, ou] = pk.split(':'); return as('total', ou, leg.line, side === 'home' ? h : a, 0); }
    case 'pcln': { const [side, yn] = pk.split(':'); return W(((side === 'home' ? a : h) === 0) === (yn === 'yes')); }
    case 'pcond': {
      const neg = pk.startsWith('!');
      const oks = (neg ? pk.slice(1) : pk).split(';').map((c) => condOK(c, h, a));
      if (oks.some((x) => x == null)) return null;
      return W(oks.every(Boolean) !== neg);
    }
  }
  return null;
}

/* Ordem fixa das seleções, igual à do cabeçalho do jogo: casa à esquerda, fora à direita
   (a fonte manda-as por qualquer ordem, e um "1" do lado do jogador de fora induz em erro). */
const PICK_ORDER = { home: 0, hd: 0, yes: 0, over: 0, odd: 0, draw: 1, ha: 1, no: 1, under: 1, even: 1, away: 2, da: 2 };
function pickRank(s) {
  if (s.pick in PICK_ORDER) return PICK_ORDER[s.pick];
  // "home:30", "away:yes", "behind:no"...: primeiro o lado, depois o resto
  const c = /^([a-z]+):(.+)$/.exec(s.pick);
  if (c) return (PICK_ORDER[c[1]] ?? 0) * 10000 + (c[2] in PICK_ORDER ? PICK_ORDER[c[2]] : parseFloat(c[2].replace(/\D+/g, '.')) || 0);
  const m = /^(\d+)-(\d+)$/.exec(s.pick); // placar / resultado em sets: vitórias da casa, empates, vitórias de fora
  if (m) { const h = +m[1], a = +m[2]; return (a - h) * 100 + (h + a); }
  return Number(s.pick) || 0; // total de sets: 2, 3...
}
const byPick = (a, b) => pickRank(a) - pickRank(b) || (a.line ?? 0) - (b.line ?? 0);

/* ---------- ténis: mercados de sets, games e saque ----------
   (leitura em feeds/tennis.js; "per" diz a parte do jogo: "2" = 2º set, "1/9" = 1º set game 9,
   "1:4" = 1º set após 4 games, "home" = jogador da casa, "home:2" = jogador da casa no 2º set, "home:0" = partida) */
const TENNIS_OU = new Set(['tsgt', 'ttb', 'tpgw', 'tpbrk', 'tbrk']);
const TENNIS_KINDS = new Set(['tsw', 'tscs', 'tscg', 'tsca', 'tsgt', 'tsgh', 'tslead', 'tsafter', 'tsrace', 'tstbw', 'tsbrk', 'tgw', 'tgs', 'tgd', 'tgsw',
  'tgpw', 'tgpd', 'tfswin', 'tfsg', 'tfsw', 'tfsd', 'tfbrk', 'tpbrk', 'tbrk', 'tstraight', 'tdist', 'tpto', 'tdr', 'tcast', 'tmrt', 'tpgw', 'toe', 'ttb', 'tace', 'tdf']);
function tennisText(k, s, per, H, A) {
  const P = (w) => (w === 'home' ? H : w === 'away' ? A : 'Empate');
  const YN = (y) => (y === 'yes' ? 'Sim' : 'Não');
  const [a, b] = String(per ?? '').split(/[:/]/);
  const pk = String(s.pick), [p1, p2 = ''] = pk.split(':');
  const sc = (x) => x.replace('-', ' x ');
  const pts = (x) => (x === '0' ? 'zero' : x);
  const ou = () => `${s.pick === 'over' ? 'Mais' : 'Menos'} de ${s.line}`;
  const set = `${a}º set`, game = `${a}º set · game ${b}`, srv = `1º game de serviço de ${P(a)}`;
  switch (k) {
    case 'tsw': return [`Vencedor do ${set}`, P(pk)];
    case 'tscs': return [`Placar exato do ${set}`, sc(pk)];
    case 'tscg': return [`${set}: grupo de placares`, `${P(p1)} ${p2.split(',').join(' / ')}`];
    case 'tsca': return [`${set}: placar (qualquer jogador)`, pk];
    case 'tsgt': return [`Total de games do ${set}`, ou()];
    case 'tsgh': return [`Handicap de games do ${set}`, `${P(pk)} ${fmtLine(s.line)}`];
    case 'tslead': return [`${set}: quem lidera após ${b} games`, P(pk)];
    case 'tsafter': return [`${set}: placar após ${b} games`, sc(pk)];
    case 'tsrace': return [`${set}: primeiro a chegar a ${b} games`, P(pk)];
    case 'tstbw': return [`Vencedor do tie-break do ${set}`, P(pk)];
    case 'tsbrk': return [`${set}: quebra o saque?`, `${P(p1)}: ${YN(p2)}`];
    case 'tgw': return [`${game}: vencedor`, P(pk)];
    case 'tgs': return [`${game}: placar do game`, `${P(p1)} (adversário a ${pts(p2)})`];
    case 'tgd': return [`${game}: vai a deuce?`, YN(pk)];
    case 'tgsw': return [`${game}: quem serve ganha com o adversário a ${s.line} ou menos?`, YN(pk)];
    case 'tgpw': return [`${set} · games ${b} e ${Number(b) + 1}: quem ganha mais`, P(pk)];
    case 'tgpd': return [`${set} · games ${b} e ${Number(b) + 1}: algum vai a deuce?`, YN(pk)];
    case 'tfswin': return [`${srv}: vencedor`, P(pk)];
    case 'tfsg': return [`${srv}: placar do game`, `${P(p1)} (adversário a ${pts(p2)})`];
    case 'tfsw': return [`${srv}: ganha com o adversário a ${s.line} ou menos?`, YN(pk)];
    case 'tfsd': return [`${srv}: vai a deuce?`, YN(pk)];
    case 'tfbrk': return ['Primeira quebra de saque da partida', P(pk)];
    case 'tpbrk': return [`Quebras de saque de ${P(a)}${b && b !== '0' ? ` no ${b}º set` : ''}`, ou()];
    case 'tbrk': return ['Total de quebras de saque na partida', ou()];
    case 'tstraight': return ['Vencedor sem perder set?', YN(pk)];
    case 'tdist': return ['Vai ao set decisivo?', YN(pk)];
    case 'tpto': return [`${P(a)}: especiais`, `${{ behind: 'Ganha de virada', straight: 'Ganha sem perder set', aset: 'Ganha pelo menos um set' }[p1] || p1}: ${YN(p2)}`];
    case 'tdr': return ['1º set + resultado final', `${P(p1)} ganha o 1º set e ${p2 === 'W' ? 'ganha' : 'perde'} a partida`];
    case 'tcast': return ['Sequência dos sets', `${P(p1)} ${p2.replace(/W/g, 'V').replace(/L/g, 'D')}`];
    case 'tmrt': return ['Vencedor + total de games', `${P(p1)} e ${p2 === 'over' ? 'mais' : 'menos'} de ${s.line}`];
    case 'tpgw': return [`Games ganhos por ${P(a)}`, ou()];
    case 'toe': return ['Total de games: par ou ímpar', pk === 'odd' ? 'Ímpar' : 'Par'];
    case 'ttb': return ['Total de tie-breaks na partida', ou()];
    case 'tace': return [`Aces de ${P(a)}`, `${s.line} ou mais`];
    case 'tdf': return [`Duplas faltas de ${P(a)}`, `${s.line} ou mais`];
  }
  return null;
}

// resultado de um mercado de ténis (null = não dá para decidir com os dados que há → fica para a equipa)
function tennisOutcome(leg, R) {
  const sets = R.sets || [], log = R.log || null;
  const pk = String(leg.pick), [p1, p2 = ''] = pk.split(':');
  const [a, b] = String(leg.per ?? '').split(/[:/]/);
  const sN = Number(a), N = Number(b), set = sets[sN - 1];
  const W = (c) => (c ? 1 : -1);
  const ouRes = (v) => (leg.pick === 'over' ? Math.sign(v - leg.line) : Math.sign(leg.line - v));
  const winOf = (x) => (x[0] > x[1] ? 'home' : 'away');
  const isTb = (x) => Math.max(...x) === 7 && Math.min(...x) === 6;
  const won = R.h > R.a ? 'home' : 'away';
  const brk = (e) => e.srv && e.w !== e.srv; // game ganho por quem recebia
  const inSet = (si) => (log ? log.filter((e) => e.s === si) : null);
  switch (leg.market) {
    case 'tsw': return set ? W(winOf(set) === pk) : 0; // set não jogado: devolvida
    case 'tscs': return set ? W(`${set[0]}-${set[1]}` === pk) : 0;
    case 'tscg': { if (!set) return 0; const w = winOf(set); const s = w === 'home' ? `${set[0]}-${set[1]}` : `${set[1]}-${set[0]}`; return W(w === p1 && p2.split(',').includes(s)); }
    case 'tsca': return set ? W(`${Math.max(...set)}-${Math.min(...set)}` === pk) : 0;
    case 'tsgt': return set ? ouRes(set[0] + set[1]) : 0;
    case 'tsgh': return set ? Math.sign((pk === 'home' ? set[0] - set[1] : set[1] - set[0]) + leg.line) : 0;
    case 'tstbw': return set && isTb(set) ? W(winOf(set) === pk) : 0; // sem tie-break: devolvida
    case 'tslead': case 'tsafter': case 'tsrace': {
      if (!set) return 0;
      const gs = inSet(sN);
      if (!gs) return null;
      let h = 0, w = 0;
      if (leg.market === 'tsrace') {
        for (const e of gs) { if (e.w === 'home') h++; else w++; if (h === N) return W(pk === 'home'); if (w === N) return W(pk === 'away'); }
        return 0;
      }
      if (gs.length < N) return 0; // o set acabou antes de N games
      for (const e of gs.slice(0, N)) { if (e.w === 'home') h++; else w++; }
      return leg.market === 'tslead' ? W((h > w ? 'home' : h < w ? 'away' : 'draw') === pk) : W(`${h}-${w}` === pk);
    }
    case 'tsbrk': { if (!set) return 0; const gs = inSet(sN); if (!gs) return null; return W(gs.some((e) => brk(e) && e.w === p1) === (p2 === 'yes')); }
    case 'tgw': case 'tgs': case 'tgd': case 'tgsw': {
      if (!set) return 0;
      const gs = inSet(sN);
      if (!gs) return null;
      const e = gs[N - 1];
      if (!e) return 0; // game não jogado
      if (leg.market === 'tgw') return W(e.w === pk);
      if (e.lp == null) return null;
      if (leg.market === 'tgs') return W(e.w === p1 && String(e.lp) === p2);
      if (leg.market === 'tgd') return W((e.lp === 40) === (pk === 'yes')); // adversário chegou a 40 = houve 40-40
      return W((e.w === e.srv && e.lp <= leg.line) === (pk === 'yes'));
    }
    case 'tgpw': case 'tgpd': {
      if (!set) return 0;
      const gs = inSet(sN);
      if (!gs) return null;
      const x = gs[N - 1], y = gs[N];
      if (!x || !y) return 0;
      if (leg.market === 'tgpw') { const h = (x.w === 'home') + (y.w === 'home'); return W((h === 2 ? 'home' : h === 0 ? 'away' : 'draw') === pk); }
      if (x.lp == null || y.lp == null) return null;
      return W((x.lp === 40 || y.lp === 40) === (pk === 'yes'));
    }
    case 'tfswin': case 'tfsg': case 'tfsw': case 'tfsd': {
      if (!log) return null;
      const e = log.find((x) => x.srv === a);
      if (!e) return 0;
      if (leg.market === 'tfswin') return W(e.w === pk);
      if (leg.market === 'tfsg') return W(e.w === p1 && String(e.lp) === p2);
      if (leg.market === 'tfsd') return W((e.lp === 40) === (pk === 'yes'));
      return W((e.w === e.srv && e.lp <= leg.line) === (pk === 'yes'));
    }
    case 'tfbrk': { if (!log) return null; const e = log.find(brk); return e ? W(e.w === pk) : 0; }
    case 'tpbrk': { if (!log) return null; const si = Number(b) || 0; if (si && !sets[si - 1]) return 0; return ouRes((si ? inSet(si) : log).filter((e) => brk(e) && e.w === a).length); }
    case 'tbrk': return log ? ouRes(log.filter(brk).length) : null;
    case 'tstraight': return W(sets.every((x) => winOf(x) === won) === (pk === 'yes'));
    case 'tdist': return W((sets.length === Math.max(R.h, R.a) * 2 - 1) === (pk === 'yes'));
    case 'tpto': {
      const mine = sets.filter((x) => winOf(x) === a).length;
      const v = p1 === 'aset' ? mine > 0 : p1 === 'straight' ? won === a && mine === sets.length : won === a && !!sets[0] && winOf(sets[0]) !== a;
      return W(v === (p2 === 'yes'));
    }
    case 'tdr': return W(!!sets[0] && winOf(sets[0]) === p1 && (won === p1) === (p2 === 'W'));
    case 'tcast': return W(sets.map((x) => (winOf(x) === p1 ? 'W' : 'L')).join('') === p2);
    case 'tmrt': { if (won !== p1) return -1; const t = sets.reduce((q, x) => q + x[0] + x[1], 0); return p2 === 'over' ? Math.sign(t - leg.line) : Math.sign(leg.line - t); }
    case 'tpgw': return ouRes(sets.reduce((q, x) => q + x[a === 'home' ? 0 : 1], 0));
    case 'toe': return W((sets.reduce((q, x) => q + x[0] + x[1], 0) % 2 ? 'odd' : 'even') === pk);
    case 'ttb': return ouRes(sets.filter(isTb).length);
    case 'tace': case 'tdf': { const v = leg.market === 'tace' ? R.aces : R.dfs; return v ? W(v[a === 'home' ? 0 : 1] >= leg.line) : null; }
  }
  return null;
}

/* ---------- e-Sports ----------
   R = { h, a } mapas ganhos · maps: placar (rondas) de cada mapa [[13, 7], [10, 13]] — só no CS2/Valorant; null nos outros */
const ESPORTS_KINDS = new Set(['ecs', 'emh', 'e1m', 'emw']);
function esportsOutcome(leg, R) {
  const W = (c) => (c ? 1 : -1);
  switch (leg.market) {
    case 'ecs': return W(leg.pick === `${R.h}-${R.a}`);
    case 'emh': return Math.sign((leg.pick === 'home' ? R.h - R.a : R.a - R.h) + leg.line);
    case 'e1m': return W(((leg.per === 'home' ? R.h : R.a) > 0) === (leg.pick === 'yes'));
    case 'emw': {
      const n = Number(leg.per);
      if (n > R.h + R.a) return 0; // mapa não jogado: devolvida
      const m = R.maps?.[n - 1];
      if (!m) return null; // a fonte não diz quem ganhou cada mapa (LoL, Dota): fica para a equipa
      return W((m[0] > m[1] ? 'home' : 'away') === leg.pick);
    }
  }
  return null;
}

function selections(ev) {
  const out = [];
  const H = ev.home.short, A = ev.away.short, three = ev.sport === 'soccer';
  for (const mk of ev.markets || []) {
    let sels = [...mk.sels].sort(byPick);
    // linha principal primeiro (é a que aparece na lista de jogos)
    if (TOTALS.has(mk.k) && mk.main != null) sels = sels.sort((a, b) => (b.line === mk.main) - (a.line === mk.main) || byPick(a, b));
    for (const s of sels) {
      const o = { market: mk.k, pick: s.pick, odds: s.odds, locked: !!s.lock };
      if (s.line != null) o.line = s.line;
      if (s.base) o.base = s.base;
      const side = (p) => (p === 'home' ? H : A);
      const tt = TENNIS_KINDS.has(mk.k) ? tennisText(mk.k, s, mk.per, H, A) : null;
      if (mk.per != null) o.per = mk.per;
      if (tt) {
        o.lbl = o.name = tt[1]; o.marketName = tt[0];
        if (TENNIS_OU.has(mk.k)) { o.lbl = `${s.pick === 'over' ? '+' : '-'}${s.line}`; o.cside = s.pick; o.cline = s.line; }
        if (mk.k === 'tsgh') { o.lbl = fmtLine(s.line); o.cside = s.pick; o.cline = s.line; }
      } else if (mk.k === 'ml' || mk.k === 'mlr') Object.assign(o, { home: { lbl: '1', name: H }, draw: { lbl: 'X', name: 'Empate' }, away: { lbl: '2', name: A } }[s.pick]);
      else if (mk.k === 'dc' || mk.k === 'dcr') Object.assign(o, { hd: { lbl: '1X', name: `${H} ou Empate` }, ha: { lbl: '12', name: `${H} ou ${A}` }, da: { lbl: 'X2', name: `Empate ou ${A}` } }[s.pick]);
      else if (mk.k === 'dnb' || mk.k === 'set1') o.lbl = o.name = side(s.pick);
      else if (mk.k === 'btts') o.lbl = o.name = s.pick === 'yes' ? 'Sim' : 'Não';
      else if (TOTALS.has(mk.k)) { o.lbl = `${s.pick === 'over' ? '+' : '-'}${s.line}`; o.name = `${s.pick === 'over' ? 'Mais' : 'Menos'} de ${s.line}`; o.cside = s.pick; o.cline = s.line; }
      else if (SPREADS.has(mk.k)) { o.lbl = fmtLine(s.line); o.name = `${side(s.pick)} ${fmtLine(s.line)}`; o.cside = s.pick; o.cline = s.line; }
      else if (mk.k === 'cs' || mk.k === 'sets') o.lbl = o.name = s.pick.replace('-', ' x ');
      else if (mk.k === 'tsets') o.lbl = o.name = `${s.pick} sets`;
      // e-Sports
      else if (mk.k === 'ecs') o.lbl = o.name = s.pick.replace('-', ' x ');
      else if (mk.k === 'emh') { o.lbl = fmtLine(s.line); o.name = `${side(s.pick)} ${fmtLine(s.line)}`; o.cside = s.pick; o.cline = s.line; }
      else if (mk.k === 'e1m') o.lbl = o.name = s.pick === 'yes' ? 'Sim' : 'Não';
      else if (mk.k === 'emw') o.lbl = o.name = side(s.pick);
      // mercado da equipa (nome já traduzido pelo leitor da fonte); a equipa liquida no painel
      else if (mk.k === 'x' || SOURCE_KINDS.has(mk.k)) {
        // mercados da equipa ("x") e por parte do jogo: nome já traduzido pelo leitor da fonte; só os "x" são liquidados à mão
        o.lbl = o.name = s.name || '—'; o.marketName = mk.name || 'Outros'; o.cat = mk.cat || 'other';
        if (mk.k === 'x') o.manual = true;
        if (mk.k === 'ptot' || mk.k === 'pspr') { o.cside = s.pick; o.cline = s.line; }
      }
      else continue;
      if (!three && mk.k === 'ml') o.lbl = s.pick === 'home' ? '1' : '2';
      // a linha (e o placar de referência) fazem parte da chave: se mudarem, a seleção antiga deixa de existir
      o.key = `${ev.id}|${o.market}|${o.pick}` + (o.line != null ? `|${o.line}` : '') + (o.base ? `|${o.base.join('-')}` : '') + (o.per != null ? `|p${o.per}` : '');
      if (!o.marketName) o.marketName = MARKET_NAMES[mk.k](o, ev);
      out.push(o);
    }
  }
  return out.filter((s) => s.odds);
}

function isSuspended(ev, now = Date.now()) {
  // antes do jogo, depois do início já não se aposta (até o jogo aparecer ao vivo)
  return !ev || ev.state === 'post' || !ev.markets || (ev.suspendedUntil || 0) > now || (ev.closesAt != null && now >= ev.closesAt);
}
const evLabel = (ev) => `${ev.home.short} x ${ev.away.short}`;

/* ---------- liquidação ----------
   R = resultado do jogo, já validado pelo leitor da fonte de dados:
     { h, a }  placar final (futebol: tempo regulamentar; basquete e hóquei: com prorrogação; ténis: sets ganhos)
     reg       hóquei: placar no fim do 3º período · sets: ténis, games de cada set [[6, 4], [3, 6], ...]
     alts      hóquei decidido nos pênaltis: os dois placares possíveis (a fonte não diz quem ganhou) */
// -1 perdeu · -0.5 meia perda · 0 devolvida · 0.5 meio ganho · 1 ganhou
function legOutcome(leg, R) {
  if (leg.market === 'x') return null; // mercado da equipa: liquidado no painel
  if (AUTO_KINDS.has(leg.market)) return partOutcome(leg, R);
  if (leg.market === 'pp') return ppOutcome(leg, R);
  if (leg.market === 'pet') return petOutcome(leg, R);
  if (TENNIS_KINDS.has(leg.market)) return tennisOutcome(leg, R);
  if (ESPORTS_KINDS.has(leg.market)) return esportsOutcome(leg, R);
  let { h, a } = R;
  if (leg.market === 'mlr' || leg.market === 'dcr') [h, a] = R.reg;
  if (leg.market === 'spread' && Array.isArray(leg.base)) { h -= leg.base[0]; a -= leg.base[1]; }
  const sets = R.sets || [];
  if (leg.market === 'sspread') { h = sets.filter(([x, y]) => x > y).length; a = sets.length - h; }
  if (leg.market === 'gspread' || leg.market === 'gtotal') { h = sets.reduce((s, x) => s + x[0], 0); a = sets.reduce((s, x) => s + x[1], 0); }
  const base = (line) => {
    if (TOTALS.has(leg.market)) { const t = h + a; return Math.sign(leg.pick === 'over' ? t - line : line - t); }
    return Math.sign(leg.pick === 'home' ? h + line - a : a + line - h);
  };
  switch (leg.market) {
    case 'ml': case 'mlr': return (leg.pick === 'home' ? h > a : leg.pick === 'away' ? a > h : h === a) ? 1 : -1;
    case 'dc': case 'dcr': return (leg.pick === 'hd' ? h >= a : leg.pick === 'da' ? a >= h : h !== a) ? 1 : -1;
    case 'dnb': return h === a ? 0 : (leg.pick === 'home' ? h > a : a > h) ? 1 : -1;
    case 'btts': return ((h > 0 && a > 0) === (leg.pick === 'yes')) ? 1 : -1;
    case 'cs': case 'sets': return leg.pick === `${h}-${a}` ? 1 : -1;
    case 'tsets': return Number(leg.pick) === sets.length ? 1 : -1;
    case 'set1': return sets[0] ? ((sets[0][0] > sets[0][1]) === (leg.pick === 'home') ? 1 : -1) : 0;
    case 'total': case 'gtotal': case 'spread': case 'sspread': case 'gspread': {
      const L = leg.line;
      // linha de quarto (2.25, -0.75): metade da aposta em cada linha vizinha
      if (Math.abs(Math.round(L * 4)) % 2 === 1) return (base(L - 0.25) + base(L + 0.25)) / 2;
      return base(L);
    }
  }
  return 0;
}
const outcomeFactor = (v, o) => (v === 1 ? o : v === 0.5 ? (1 + o) / 2 : v === 0 ? 1 : v === -0.5 ? 0.5 : 0);
const outcomeLabel = (v) => (v === 1 ? 'won' : v === 0.5 ? 'halfwon' : v === 0 ? 'void' : v === -0.5 ? 'halflost' : 'lost');
const resultText = (R) => (R.sets ? R.sets.map((s) => s.join('-')).join(' ') : `${R.h} x ${R.a}`);

// tenta liquidar uma seleção com o evento; devolve true se mudou
function settleLeg(leg, ev) {
  if (leg.result || !ev || ev.state !== 'post') return false;
  if (/POSTPONED|CANCELED|ABANDONED/.test(ev.statusName)) { leg.result = 'void'; leg.value = 0; leg.final = ev.clock; return true; }
  const R = ev.result;
  if (!ev.completed || !R) return false;
  // hóquei nos pênaltis: só se liquida o que dá o mesmo resultado ganhe quem ganhar (o resto fica para a equipa)
  const vals = (R.alts || [[R.h, R.a]]).map(([h, a]) => legOutcome(leg, { ...R, h, a }));
  // null = faltam dados (ex.: histórico de games que não bateu certo): fica para a equipa
  if (vals.some((v) => v == null || v !== vals[0])) return false;
  leg.value = vals[0];
  leg.result = outcomeLabel(leg.value);
  leg.final = resultText(R) + (R.alts ? ' (pênaltis)' : '');
  return true;
}

/* ---------- cash out ---------- */
const CASHOUT_MARGIN = 0.93;
// multiplicador sobre o valor apostado (null = indisponível)
function cashoutFactor(bet, findSel, now = Date.now()) {
  let f = 1;
  for (const leg of bet.legs) {
    if (leg.result) { f *= outcomeFactor(leg.value, leg.odds); continue; }
    const { ev, sel } = findSel(leg.key);
    if (!sel || sel.locked || isSuspended(ev, now)) return null;
    f *= leg.odds / sel.odds;
  }
  if (f <= 0) return null;
  return Math.min(f * CASHOUT_MARGIN, bet.odds * 0.98);
}

const Markets = {
  SPORTS, GOAL_SPORTS, LEAGUES, LEAGUE_BY_KEY, addLeague, dynLeagues, round2, resultText, fmtLine, MARKET_NAMES, selections, isSuspended, evLabel,
  legOutcome, outcomeFactor, outcomeLabel, settleLeg, cashoutFactor, AUTO_KINDS, SOURCE_KINDS, partOutcome, scopeOf, ppNorm, PP_FIELD, ppPlayer,
};
if (typeof module !== 'undefined' && module.exports) module.exports = Markets;
