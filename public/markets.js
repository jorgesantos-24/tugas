'use strict';
/* Lógica partilhada entre o servidor (Node) e o navegador:
   campeonatos, mercados, liquidação e cash out.
   Os jogos e as odds vêm do servidor, que os lê da fonte de dados (feeds/moviodds.js). */

const SPORTS = {
  soccer: { name: 'Futebol', icon: '⚽' },
  basketball: { name: 'Basquete', icon: '🏀' },
  tennis: { name: 'Tênis', icon: '🎾' },
  hockey: { name: 'Hóquei no Gelo', icon: '🏒' },
  mma: { name: 'MMA', icon: '🥊' },
  tabletennis: { name: 'Tênis de Mesa', icon: '🏓' },
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
  ['WNBA', 'wnba', 'WNBA', 'EUA'],
  ['China CBA', 'chn.cba', 'CBA', 'China'],
  ['Spain Liga ACB', 'esp.acb', 'Liga ACB', 'Espanha'],
  ['Germany Bundesliga', 'ger.bbl', 'Bundesliga', 'Alemanha'],
  ['France Ligue A', 'fra.lnb', 'Ligue A', 'França'],
  ['Italy Lega 1', 'ita.lba', 'Serie A', 'Itália'],
  ['Australia NBL', 'aus.nbl', 'NBL', 'Austrália'],
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
  ['Czechia Extraliga', 'cze.hockey', 'Extraliga', 'Tchéquia'],
  ['Germany Eishockey Liga', 'del', 'DEL', 'Alemanha'],
].map(([src, key, name, country]) => ({ src, key, name, country, sport: 'hockey' }))).concat([
  // MMA: só o UFC (é o que tem resultado oficial de cada luta); cada card é um campeonato próprio, como no ténis
  [/^UFC /, 'ufc', 'UFC', 'UFC'],
].map(([re, key, name, country]) => ({ re, key, name, country, sport: 'mma' }))).concat([
  // tênis de mesa: todas as ligas da fonte (decisão de 2026-10-28); cada liga é um campeonato próprio, como no ténis
  [/./, 'tt', 'Tênis de Mesa', 'Tênis de Mesa'],
].map(([re, key, name, country]) => ({ re, key, name, country, sport: 'tabletennis' }))).concat([
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

/* ---------- catálogo da equipa ----------
   Modalidades e campeonatos criados no painel /admin ("Esportes e mercados"). Entram nos mesmos objetos
   (SPORTS, LEAGUES, LEAGUE_BY_KEY), depois dos da fonte; os criados na hora (ténis) ficam onde estão. */
const BUILTIN_SPORTS = new Set(Object.keys(SPORTS));
function setCatalog(cat) {
  for (const k of Object.keys(SPORTS)) if (!BUILTIN_SPORTS.has(k)) delete SPORTS[k];
  for (const s of cat?.sports || []) if (!BUILTIN_SPORTS.has(s.key)) SPORTS[s.key] = { name: s.name, icon: s.icon, custom: true };
  for (let i = LEAGUES.length - 1; i >= 0; i--) if (LEAGUES[i].custom) { delete LEAGUE_BY_KEY[LEAGUES[i].key]; LEAGUES.splice(i, 1); }
  (cat?.leagues || []).forEach((l, i) => {
    if (!SPORTS[l.sport] || LEAGUE_BY_KEY[l.key]) return;
    const x = { key: l.key, name: l.name, country: l.country || '', sport: l.sport, order: 500 + i, custom: true };
    LEAGUES.push(x); LEAGUE_BY_KEY[x.key] = x;
  });
  LEAGUES.sort((a, b) => a.order - b.order || (a.dyn && b.dyn ? a.country.localeCompare(b.country) || a.name.localeCompare(b.name) : 0));
}

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
  ml: (s, ev) => ({ soccer: 'Vitória no tempo regulamentar', basketball: 'Vencedor (incl. prorrogação)', hockey: 'Vencedor (incl. prorrogação e pênaltis)', tennis: 'Vencedor da partida', esports: 'Vencedor da partida', mma: 'Vencedor da luta', tabletennis: 'Vencedor da partida' }[ev.sport]),
  // MMA
  fmov: () => 'Método de vitória',
  fround: () => 'Round da vitória',
  fdist: () => 'A luta vai até o fim?',
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
  total: (s, ev) => ({ soccer: 'Total de Gols', basketball: 'Total de Pontos', hockey: 'Total de Gols (incl. prorrogação e pênaltis)', mma: 'Total de rounds' }[ev.sport]),
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
const AUTO_KINDS = new Set(['p1x2', 'pdc', 'pcs', 'ptot', 'pspr', 'pbtts', 'phtft', 'pteam', 'pcln', 'pmost', 'poe', 'pml2', 'pot', 'pcond', 'phs', 'pthq', 'pqcs', 'hend', 'hphs', 'hmost', 'hng']);
// mercados com nome e seleções traduzidos da fonte, liquidados sozinhos (por parte do jogo, jogadores, prolongamento/penáltis)
/* ---------- tênis de mesa (feeds/tabletennis.js) ----------
   R = { h, a (sets ganhos), sets: [[11, 8], [3, 11], ...], tt: true, incomplete? } — incomplete = partida abandonada:
   o que já ficou decidido pelos sets acabados é pago ou perdido; o resto é devolvido (regra da bet365). */
const TT_KINDS = new Set(['ttsh', 'ttpt', 'ttph', 'ttcs', 'ttgw', 'ttgh', 'ttgt', 'ttgwt', 'ttgp', 'ttoe', 'ttgm', 'ttgx', 'ttmp', 'ttdr', 'ttrt']);
const TT_NEED = 3;
function ttOutcome(leg, R) {
  const sets = R.sets || [], pk = String(leg.pick), k = leg.market, W = (c) => (c ? 1 : -1);
  const ouv = (v, p = pk) => Math.sign(p === 'over' ? v - leg.line : leg.line - v);
  const [a, b] = String(leg.per ?? '').split(':');
  // um set
  if (k === 'ttgw' || k === 'ttgh' || k === 'ttgt' || k === 'ttgwt' || k === 'ttgp' || k === 'ttgm' || k === 'ttgx' || (k === 'ttoe' && a !== 'M')) {
    const g = sets[Number(a) - 1];
    if (!g) return R.incomplete || sets.length >= Number(a) || (R.h === TT_NEED || R.a === TT_NEED) ? 0 : null; // set não jogado: devolvida
    const w = g[0] > g[1] ? 'home' : 'away';
    if (k === 'ttgw') return W(w === pk);
    if (k === 'ttgh') return Math.sign((pk === 'home' ? g[0] - g[1] : g[1] - g[0]) + leg.line);
    if (k === 'ttgt') return ouv(g[0] + g[1]);
    if (k === 'ttgwt') { const [pw, po] = pk.split(':'); return W(pw === w && ouv(g[0] + g[1], po) === 1); }
    if (k === 'ttoe') return W(((g[0] + g[1]) % 2 ? 'odd' : 'even') === pk);
    if (k === 'ttgx') return W((Math.max(g[0], g[1]) > 11) === (pk === 'yes')); // passou dos 11 = houve 10-10
    if (k === 'ttgm') { const [pw, band] = pk.split(':'), d = Math.abs(g[0] - g[1]); return W(pw === w && (band === '2' ? d === 2 : band === '3-4' ? d >= 3 && d <= 4 : d >= 5)); }
    return ouv(g[b === 'home' ? 0 : 1]);
  }
  // placar depois de N sets
  if (k === 'ttcs' && a !== 'M') {
    const n = Number(a);
    if (sets.length < n) return R.incomplete ? 0 : null;
    const h = sets.slice(0, n).filter((x) => x[0] > x[1]).length;
    return W(pk === `${h}-${n - h}`);
  }
  const hp = sets.reduce((t, x) => t + x[0], 0), ap = sets.reduce((t, x) => t + x[1], 0);
  const g1 = sets[0] ? (sets[0][0] > sets[0][1] ? 'home' : 'away') : null;
  const match = (h, a2) => {
    const mw = h > a2 ? 'home' : 'away';
    if (k === 'ml') return W(mw === pk);
    if (k === 'ttsh') return Math.sign((pk === 'home' ? h - a2 : a2 - h) + leg.line);
    if (k === 'ttcs') return W(pk === `${h}-${a2}`);
    if (k === 'ttdr') { const [pw, r] = pk.split(':'); return W(g1 === pw && (r === 'w') === (mw === pw)); } // ganha o 1º set e ganha/perde
    return null;
  };
  if (k === 'ttdr' && !g1) return 0; // 1º set não acabou: devolvida
  if (R.incomplete) {
    // pontos: "mais de" já passado está decidido; o resto em aberto
    if (k === 'ttpt') return hp + ap > leg.line ? (pk === 'over' ? 1 : -1) : 0;
    if (k === 'ttph' || k === 'ttoe') return 0;
    if (k === 'ttmp') { const v = a === 'home' ? hp : ap; return v > leg.line ? (pk === 'over' ? 1 : -1) : 0; }
    if (k === 'ttrt') { const [, po] = pk.split(':'); return hp + ap > leg.line && po === 'under' ? -1 : 0; } // "menos de" já passado perde; o resto devolvido
    // vencedor / sets: só se qualquer final possível desse o mesmo
    const outs = new Set();
    const rec = (h, a2) => { if (outs.size > 1) return; if (h === TT_NEED || a2 === TT_NEED) { outs.add(match(h, a2)); return; } rec(h + 1, a2); rec(h, a2 + 1); };
    rec(R.h, R.a);
    return outs.size === 1 && [...outs][0] != null ? [...outs][0] : 0;
  }
  if (k === 'ttpt') return ouv(hp + ap);
  if (k === 'ttph') return Math.sign((pk === 'home' ? hp - ap : ap - hp) + leg.line);
  if (k === 'ttoe') return W(((hp + ap) % 2 ? 'odd' : 'even') === pk);
  if (k === 'ttmp') return ouv(a === 'home' ? hp : ap);
  if (k === 'ttrt') { const [pw, po] = pk.split(':'); return W((R.h > R.a ? 'home' : 'away') === pw && ouv(hp + ap, po) === 1); }
  return match(R.h, R.a);
}
const SOURCE_KINDS = new Set([...AUTO_KINDS, 'pp', 'bp', 'hgs', 'pet', 'prace', ...TT_KINDS]);
// uma condição de "pcond" (ver feeds/auto.js) com o placar [h, a]; null = condição desconhecida
function condOK(c, h, a) {
  const [key, val = ''] = c.split('=');
  const res = h > a ? 'home' : h < a ? 'away' : 'draw';
  if (key === 'res') return res === val;
  if (key === 'dc') return val === 'hd' ? h >= a : val === 'da' ? a >= h : val === 'ha' ? h !== a : null;
  if (key === 'btts') return (h > 0 && a > 0) === (val === 'yes');
  // basquete: as duas equipas fazem N pontos ou mais (bx=yes:N / bx=no:N)
  if (key === 'bx') { const [yn, n] = val.split(':'); return (h >= Number(n) && a >= Number(n)) === (yn === 'yes'); }
  // handicap (linhas .5): hc=home:+2.5
  if (key === 'hc') { const [side, l] = val.split(':'); const d = side === 'home' ? h + Number(l) - a : a + Number(l) - h; return d === 0 ? null : d > 0; }
  // par/ímpar: par=h:odd (casa) · a (fora) · t (os dois)
  if (key === 'par') { const [w, p] = val.split(':'); const n = w === 'h' ? h : w === 'a' ? a : h + a; return (n % 2 ? 'odd' : 'even') === p; }
  // mh / ma = vitória da casa / de fora por (diferença) · ad = diferença sem sinal
  if (key === 'tot' || key === 'th' || key === 'ta' || key === 'mh' || key === 'ma' || key === 'ad') {
    const n = { tot: h + a, th: h, ta: a, mh: h - a, ma: a - h, ad: Math.abs(h - a) }[key];
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
  // hóquei: o jogo todo, mas só se acabou no tempo regulamentar (mercados em que não se sabe se a bet365 conta a
  // prorrogação: com prorrogação ou pênaltis ficam para a equipa)
  if (scope === 'ftr') return Array.isArray(R.reg) && !R.so && !R.alts && R.reg[0] === R.h && R.reg[1] === R.a ? R.reg : null;
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
  if (p.played === null) return null; // a fonte não diz se jogou (sem titular/entrou e a zeros): não se adivinha
  if (!p.played) return 0; // não jogou: devolvida
  const v = get(p);
  if (!Number.isFinite(v)) return null;
  return v >= Number(String(leg.pick).split('#')[0]) ? 1 : -1;
}

/* ---------- jogadores do basquete (feeds/bplayers.js) ----------
   R.bp = box score verificado [{ key, side, played, pts, reb, ast, tpm, stl, blk }] · pick '<N>#lado#nome' (N ou mais)
   ou 'u<N>#lado#nome' (menos de N). Conta a prorrogação; não entrou em quadra → devolvida; sem box score → equipa. */
const BP_SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
// "Austin Reaves" e "A Reaves" → "a reaves" (a MoviOdds abrevia o nome próprio; a bet365 e a ESPN não)
// o nome próprio é a 1ª palavra antes de um espaço ("Karl-Anthony Towns" → "k towns", "De'Aaron Fox" → "d fox")
function bpKey(s) {
  const [first, ...rest] = String(s ?? '').trim().split(/\s+/);
  const w = ppNorm(rest.join(' ')).split(' ').filter((x) => x && !BP_SUFFIX.has(x));
  const f = ppNorm(first)[0] || '';
  return w.length ? [f, ...w].join(' ') : ppNorm(first);
}
const dd10 = (p) => ['pts', 'reb', 'ast', 'stl', 'blk'].filter((k) => p[k] >= 10).length;
const BP_FIELD = {
  pts: (p) => p.pts, reb: (p) => p.reb, ast: (p) => p.ast, tpm: (p) => p.tpm, stl: (p) => p.stl, blk: (p) => p.blk,
  pa: (p) => p.pts + p.ast, pr: (p) => p.pts + p.reb, ar: (p) => p.ast + p.reb, pra: (p) => p.pts + p.reb + p.ast, sb: (p) => p.stl + p.blk,
  dd: dd10, td: dd10,
};
// N e se é "menos de" de uma seleção
function bpNeed(leg) {
  const m = /^(u?)(\d+)#/.exec(String(leg.pick));
  return m ? { need: Number(m[2]), under: !!m[1] } : null;
}
function bpPlayer(leg, players) {
  const [, side, ...rest] = String(leg.pick).split('#');
  const k = bpKey(rest.join('#'));
  const found = (players || []).filter((p) => p.key === k && (!side || !p.side || p.side === side));
  return k && found.length === 1 ? found[0] : null;
}
function bpOutcome(leg, R) {
  const get = BP_FIELD[String(leg.per ?? '').split('|')[0]], n = bpNeed(leg);
  if (!get || !n || !R.bp) return null; // sem box score oficial: a equipa confere
  const p = bpPlayer(leg, R.bp);
  if (!p) {
    // fora do box score oficial (inativo) → não jogou: devolvida. Mesmo apelido com outra inicial ou dois iguais → equipa
    const k = bpKey(String(leg.pick).split('#').slice(2).join('#')), sur = k.split(' ').slice(1).join(' ');
    return sur && !R.bp.some((x) => x.key.split(' ').slice(1).join(' ') === sur) ? 0 : null;
  }
  if (!p.played) return 0; // não entrou em quadra: devolvida
  const v = get(p);
  if (!Number.isFinite(v)) return null;
  return (v >= n.need) !== n.under ? 1 : -1;
}

/* ---------- marcadores do hóquei (NHL, feeds/hgoals.js) ----------
   R.hg = { players: [{ key, side, goals }] (quem foi a jogo), order: [{ key, side }] } · per "<any|first|last|n2|n3>|grupo"
   · pick "<lado>#<nome>". Conta a prorrogação, não os pênaltis; não foi a jogo → devolvida; sem R.hg → equipa. */
function hgsOutcome(leg, R) {
  const H = R.hg;
  if (!H) return null;
  const type = String(leg.per ?? '').split('|')[0];
  const [side, ...rest] = String(leg.pick).split('#');
  const k = bpKey(rest.join('#'));
  const found = H.players.filter((p) => p.key === k && p.side === side);
  if (found.length > 1) return null;
  if (!found.length) return H.players.some((p) => p.side === side && p.key.split(' ').slice(1).join(' ') === k.split(' ').slice(1).join(' ')) ? null : 0; // não foi a jogo
  const p = found[0], W = (c) => (c ? 1 : -1);
  if (type === 'any') return W(p.goals >= 1);
  if (type === 'n2') return W(p.goals >= 2);
  if (type === 'n3') return W(p.goals >= 3);
  const g = type === 'first' ? H.order[0] : type === 'last' ? H.order[H.order.length - 1] : undefined;
  if (type !== 'first' && type !== 'last') return null;
  return W(!!g && g.key === k && g.side === side);
}

/* ---------- basquete: corrida a X pontos (feeds/auto.js) ----------
   per = "<parte>|<grupo>" · pick = "<home|away|none>:<X>[:n]" (n = o mercado tem "Nenhuma" — sem ela, ninguém chegar
   devolve). R.blog = placares de cada quarto vistos ao vivo, pela ordem ([{ hp, ap }], server.js): o primeiro a ter X
   numa leitura em que o outro ainda não tinha ganha. Sem essa leitura, servem os fins de quarto (quem tinha X num fim
   de quarto em que o outro ainda não tinha). Se nem assim se souber quem chegou primeiro: devolvida. */
const RACE_IDX = { ft: (i) => true, h1: (i) => i < 2, h2: (i) => i >= 2, q1: (i) => i === 0, q2: (i) => i === 1, q3: (i) => i === 2, q4: (i) => i === 3 };
function raceSum(hp, ap, scope) {
  const f = RACE_IDX[scope];
  if (!f || !Array.isArray(hp) || !Array.isArray(ap) || hp.length !== ap.length) return null;
  let h = 0, a = 0;
  for (let i = 0; i < hp.length; i++) if (f(i)) { h += Number(hp[i]); a += Number(ap[i]); }
  return Number.isFinite(h) && Number.isFinite(a) ? [h, a] : null;
}
// quem chegou primeiro a X pelas leituras ao vivo: 'home' | 'away' | null (as leituras não decidem)
function raceFromLog(log, scope, X) {
  const s = (Array.isArray(log) ? log : []).map((e) => raceSum(e.hp, e.ap, scope)).filter(Boolean);
  if (!s.length) return null;
  // início da última sequência com X (um cesto anulado na revisão faz voltar atrás)
  const run = (k) => { let i = s.length; while (i > 0 && s[i - 1][k] >= X) i--; return i < s.length ? i : Infinity; };
  const h = run(0), a = run(1);
  if (h === a) return null; // as duas chegaram na mesma leitura (ou nenhuma)
  const [w, i] = h < a ? ['home', h] : ['away', a];
  return s[i][w === 'home' ? 1 : 0] < X ? w : null;
}
// quem chegou primeiro a X pelos fins de quarto (dentro da parte)
function raceFromQuarters(R, scope, X) {
  const q = ['q1', 'q2', 'q3', 'q4'].map((k) => R.parts?.[k]);
  if (q.some((x) => !Array.isArray(x))) return null;
  const idx = { ft: [0, 1, 2], h1: [0], h2: [2] }[scope] || [];
  const start = scope === 'h2' ? 2 : 0;
  let h = 0, a = 0;
  for (let i = start; i <= (idx[idx.length - 1] ?? -1); i++) {
    h += q[i][0]; a += q[i][1];
    if (h >= X || a >= X) return h >= X && a >= X ? null : h >= X ? 'home' : 'away';
  }
  return null;
}
function raceOutcome(leg, R) {
  const [w, xs, nb] = String(leg.pick).split(':'), X = Number(xs), scope = scopeOf(leg);
  const fin = partScore(R, scope);
  if (!fin || !(X > 0) || !['home', 'away', 'none'].includes(w)) return null;
  const hR = fin[0] >= X, aR = fin[1] >= X;
  if (!hR && !aR) return w === 'none' ? 1 : nb === 'n' ? -1 : 0;
  if (w === 'none') return -1;
  const win = hR !== aR ? (hR ? 'home' : 'away') : raceFromLog(R.blog, scope, X) || raceFromQuarters(R, scope, X);
  return win ? (w === win ? 1 : -1) : 0;
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
    case 'mqual': { // como passa: só se se sabe quem passa
      if (!E.qualified) return null;
      const how = E.end === 'pens' ? 'pens' : E.end === 'aet' ? 'et' : '90';
      return W(pk === `${E.qualified}:${how}`);
    }
    // ---- só o prolongamento (30 minutos): sem prolongamento → devolvida; gols por período em falta → equipa
    case 'etres': case 'etgoals': case 'etbtts': case 'et1res': case 'et1goals': case 'etdr': case 'etcs': case 'et1cs': case 'etnth': {
      if (E.etPlayed === false) return 0;
      const G = E.etGoals;
      if (!G) return null;
      const full = [G.p3[0] + G.p4[0], G.p3[1] + G.p4[1]], half = G.p3;
      const r = (x) => (x[0] > x[1] ? 'home' : x[0] < x[1] ? 'away' : 'draw');
      const ouv = (v) => Math.sign(pk === 'over' ? v - leg.line : leg.line - v);
      if (type === 'etres') return W(r(full) === pk);
      if (type === 'et1res') return W(r(half) === pk);
      if (type === 'etgoals') return ouv(full[0] + full[1]);
      if (type === 'et1goals') return ouv(half[0] + half[1]);
      if (type === 'etbtts') return W((full[0] > 0 && full[1] > 0) === yes);
      if (type === 'etdr') return W(`${r(half)}-${r(full)}` === pk);
      if (type === 'etcs') return W(`${full[0]}-${full[1]}` === pk);
      if (type === 'et1cs') return W(`${half[0]}-${half[1]}` === pk);
      const n = Number(String(leg.per).split('|')[2]); // N.º gol do prolongamento: quem marca (ou "nenhum")
      return W((G.order[n - 1] || 'none') === pk);
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
  // cartões com vermelhos: o total certo está entre o mínimo (cards) e o máximo (cardsHi) — só vale se der igual
  if (scope === 'cards' && Array.isArray(R.parts?.cardsHi)) {
    const lo = R.parts.cards, hi = R.parts.cardsHi;
    if (!Array.isArray(lo)) return null;
    const vals = [[lo[0], lo[1]], [hi[0], lo[1]], [lo[0], hi[1]], [hi[0], hi[1]]]
      .map(([x, y]) => partOutcome(leg, { ...R, parts: { ...R.parts, cards: [x, y], cardsHi: null } }));
    return vals.every((v) => v != null && v === vals[0]) ? vals[0] : null;
  }
  const res = (x) => (x[0] > x[1] ? 'home' : x[0] < x[1] ? 'away' : 'draw');
  if (leg.market === 'phtft') { // intervalo / final: "home-draw"
    const ht = partScore(R, 'h1'), ft = partScore(R, 'ft');
    if (!ht || !ft) return null;
    return W(leg.pick === `${res(ht)}-${res(ft)}`);
  }
  // hóquei: como acaba o jogo (pick reg / ot / so; "!so" = não vai a pênaltis), período com mais gols, mais períodos ganhos
  if (leg.market === 'hend') {
    if (!Array.isArray(R.reg)) return null;
    const end = R.so || R.alts ? 'so' : R.reg[0] !== R.h || R.reg[1] !== R.a ? 'ot' : 'reg';
    return leg.pick === '!so' ? W(end !== 'so') : W(end === leg.pick);
  }
  // quem marca o gol N / o 1º / o último (pick "3:home", "first:none", "last:away"): gols do tempo regulamentar decidem
  // sempre; um gol da prorrogação só se a bet365 o contar sem dúvida — por isso esses casos ficam para a equipa
  if (leg.market === 'hng') {
    const o = R.gorder, reg = R.greg, ftr = partScore(R, 'ftr');
    if (!Array.isArray(o) || !Number.isFinite(reg)) return null;
    const [n, w] = String(leg.pick).split(':');
    // quem marca primeiro ganha o jogo (só com o jogo decidido nos 60 minutos)
    if (n === 'firstwins') return ftr && reg ? W((o[0] === (ftr[0] > ftr[1] ? 'home' : 'away')) === (w === 'yes')) : null;
    const idx = n === 'first' ? 1 : n === 'last' ? null : Number(n);
    if (idx == null) return ftr ? W(reg ? o[reg - 1] === w : w === 'none') : null;
    if (idx <= reg) return W(o[idx - 1] === w);
    return ftr ? W(w === 'none') : null;
  }
  if (leg.market === 'hphs' || leg.market === 'hmost') {
    const ps = ['p1', 'p2', 'p3'].map((k) => partScore(R, k));
    if (ps.some((x) => !x)) return null;
    if (leg.market === 'hphs') { const tot = ps.map((x) => x[0] + x[1]), max = Math.max(...tot), top = ['p1', 'p2', 'p3'].filter((k, i) => tot[i] === max); return W(top.length > 1 ? leg.pick === 'tie' : leg.pick === top[0]); }
    const won = ps.reduce((t, x) => [t[0] + (x[0] > x[1]), t[1] + (x[1] > x[0])], [0, 0]);
    return W(res(won) === leg.pick);
  }
  // basquete, com os 4 quartos (sem prorrogação): parte com mais pontos, equipa com o melhor quarto, quartos ganhos
  if (leg.market === 'phs' || leg.market === 'pthq' || leg.market === 'pqcs') {
    const qs = ['q1', 'q2', 'q3', 'q4'].map((k) => partScore(R, k));
    if (qs.some((x) => !x)) return null;
    if (leg.market === 'phs') { // pick h1 / h2 / htie (tempos) ou q1..q4 / qtie (quartos)
      const halves = String(leg.pick).startsWith('h');
      const keys = halves ? ['h1', 'h2'] : ['q1', 'q2', 'q3', 'q4'];
      const list = keys.map((k) => partScore(R, k));
      if (list.some((x) => !x)) return null;
      const tot = list.map((x) => x[0] + x[1]), max = Math.max(...tot), top = keys.filter((k, i) => tot[i] === max);
      return W(top.length > 1 ? /tie$/.test(leg.pick) : leg.pick === top[0]);
    }
    if (leg.market === 'pthq') {
      const bh = Math.max(...qs.map((x) => x[0])), ba = Math.max(...qs.map((x) => x[1]));
      return W(res([bh, ba]) === leg.pick);
    }
    const won = qs.reduce((s, x) => [s[0] + (x[0] > x[1]), s[1] + (x[1] > x[0])], [0, 0]);
    return W(leg.pick === 'other' ? won[0] + won[1] <= 2 : leg.pick === `${won[0]}-${won[1]}`);
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
const TENNIS_OU = new Set(['tsgt', 'ttb', 'tpgw', 'tpbrk', 'tbrk', 'ttbtp', 'tsbt']);
const TENNIS_KINDS = new Set(['tsw', 'tscs', 'tscg', 'tsca', 'tsgt', 'tsgh', 'tslead', 'tsafter', 'tsrace', 'tstbw', 'tsbrk', 'tgw', 'tgs', 'tgd', 'tgsw',
  'tgpw', 'tgpd', 'tfswin', 'tfsg', 'tfsw', 'tfsd', 'tfbrk', 'tpbrk',
  'tg1p', 'tgsa', 'tgpb', 'tgbp', 'tgtp', 'tfsa', 'tfstp', 'tfsbp', 'tsbt', 'ttbtp', 'ttblead', 'ttbsa', 'ttbpb', 'ttbs', 'tbrk', 'tstraight', 'tdist', 'tpto', 'tdr', 'tcast', 'tmrt', 'tpgw', 'toe', 'ttb', 'tace', 'tdf']);
function tennisText(k, s, per, H, A) {
  const P = (w) => (w === 'home' ? H : w === 'away' ? A : 'Empate');
  const YN = (y) => (y === 'yes' ? 'Sim' : 'Não');
  const [a, b] = String(per ?? '').split(/[:/]/);
  const pk = String(s.pick), [p1, p2 = ''] = pk.split(':');
  const sc = (x) => x.replace('-', ' x ');
  const pts = (x) => (x === '0' ? 'zero' : x);
  const ou = () => `${s.pick === 'over' ? 'Mais' : 'Menos'} de ${s.line}`;
  const set = `${a}º set`, game = `${a}º set · game ${String(b).split(':')[0]}`, srv = `1º game de serviço de ${P(a)}`;
  const tbName = a === 'M' ? 'Super tie-break' : `Tie-break do ${a}º set`;
  // pontos "casa-fora" em nº de pontos (0..4) → "30 x 15" / "Vence a zero"
  const ptsTxt = (x) => { const [h, w] = String(x).split('-').map(Number); if (h === 4 || w === 4) return `${P(h === 4 ? 'home' : 'away')} vence a zero`; const v = ['0', '15', '30', '40']; return `${v[h]} x ${v[w]}`; };
  const totTxt = (x) => (x === 'over' ? 'Mais de 6 pontos' : `${x} pontos`);
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
    case 'tg1p': return [`${game}: 1º ponto`, P(pk)];
    case 'tgsa': return [`${game}: placar após ${String(per).split(':')[1]} pontos`, ptsTxt(pk)];
    case 'tgpb': return [`${game}: ponto a ponto`, `Ponto ${s.line}: ${P(pk)}`];
    case 'tgbp': return [`${game}: há break point?`, YN(pk)];
    case 'tgtp': return [`${game}: total de pontos`, totTxt(pk)];
    case 'tfsa': return [`${srv}: placar após ${b} pontos`, ptsTxt(pk)];
    case 'tfstp': return [`${srv}: total de pontos`, totTxt(pk)];
    case 'ttbtp': return [`${tbName}: total de pontos`, ou()];
    case 'ttblead': return [`${tbName}: quem lidera após ${b} pontos`, P(pk)];
    case 'ttbsa': return [`${tbName}: placar após ${b} pontos`, sc(pk)];
    case 'ttbpb': return [`${tbName}: ponto a ponto`, `Ponto ${s.line}: ${P(pk)}`];
    case 'ttbs': return [`${tbName}: placar exato`, sc(pk)];
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
    case 'tace': return [a === 'all' ? 'Aces na partida (os dois)' : `Aces de ${P(a)}`, `${s.line} ou mais`];
    case 'tdf': return [a === 'all' ? 'Duplas faltas na partida (os dois)' : `Duplas faltas de ${P(a)}`, `${s.line} ou mais`];
    case 'tfsbp': return [`${srv}: há break point?`, YN(pk)];
    case 'tsbt': return [`Total de quebras de saque no ${a}º set`, ou()];
  }
  return null;
}

// quem ganhou o ponto i (1, 2, ...) de um game: 'home'/'away', 'none' (o game acabou antes) ou null (não se sabe)
function pointWinner(P, i) {
  if (!(i >= 1)) return null;
  if (i <= P.k && P.seq[i - 1]) return P.seq[i - 1];
  if (P.n != null && i > P.n) return 'none';
  return null;
}
// pontos de cada um após K pontos do game: [casa, fora], 'none' (acabou antes) ou null (ordem desconhecida)
function pointsAfter(P, K) {
  if (!(K >= 1)) return null;
  if (P.n != null && K > P.n) return 'none';
  if (K > P.k) return null;
  let h = 0, a = 0;
  for (let i = 0; i < K; i++) { const x = P.seq[i]; if (!x) return null; if (x === 'home') h++; else a++; }
  return [h, a];
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
  const unk = R.pts ? 0 : null; // mercados de pontos sem forma de decidir (ver abaixo)
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
    /* ---- pontos: R.pts["set/game"] = { seq, k, n, bp } (feeds/points.js).
       Com os pontos já calculados (R.pts) e mesmo assim sem forma de decidir (game sem gravação, ordem dos pontos
       desconhecida no deuce): devolvida — a equipa não teria dados melhores. Sem R.pts (ainda não calculados): espera. */
    case 'tg1p': case 'tgsa': case 'tgpb': case 'tgbp': case 'tgtp': case 'tfsa': case 'tfstp': case 'tfsbp': {
      let e;
      if (leg.market === 'tfsa' || leg.market === 'tfstp' || leg.market === 'tfsbp') { if (!log) return null; e = log.find((x) => x.srv === a && !x.tb); if (!e) return 0; }
      else { if (!set) return 0; const gs = inSet(sN); if (!gs) return null; e = gs[N - 1]; if (!e) return 0; }
      if (leg.market === 'tgtp' || leg.market === 'tfstp') { // total de pontos: basta o "holds/breaks to 30" do histórico
        if (e.lp == null) return null;
        return W((e.lp === 40 ? 'over' : String(4 + e.lp / 15)) === pk);
      }
      const P = R.pts?.[`${e.s}/${e.g}`];
      if (!P) return unk;
      if (leg.market === 'tgbp' || leg.market === 'tfsbp') return P.bp == null ? unk : W(P.bp === (pk === 'yes'));
      if (leg.market === 'tg1p' || leg.market === 'tgpb') {
        const x = pointWinner(P, leg.market === 'tg1p' ? 1 : Number(leg.line));
        return x == null ? unk : x === 'none' ? 0 : W(x === pk);
      }
      const K = Number(String(leg.per).split(':').pop());
      const c = pointsAfter(P, K);
      return c == null ? unk : c === 'none' ? 0 : W(`${Math.min(c[0], 4)}-${Math.min(c[1], 4)}` === pk);
    }
    case 'ttbtp': case 'ttbs': case 'ttblead': case 'ttbsa': case 'ttbpb': {
      // set do tie-break: "M" = super tie-break (set decisivo "1-0"); set sem tie-break → devolvida
      const si = a === 'M' ? sets.findIndex((x) => Math.max(...x) === 1 && Math.min(...x) === 0) : sN - 1;
      const st = sets[si];
      if (!st) return 0;
      if (a !== 'M' && !isTb(st)) return 0;
      if (!log) return null;
      const e = log.find((x) => x.s === si + 1 && x.tb);
      if (!e?.tbScore) return null;
      const [th, ta] = e.tbScore;
      if (leg.market === 'ttbtp') return ouRes(th + ta);
      if (leg.market === 'ttbs') return W(`${th}-${ta}` === pk);
      const P = R.pts?.[`${e.s}/${e.g}`];
      if (!P) return unk;
      if (leg.market === 'ttbpb') { const x = pointWinner(P, Number(leg.line)); return x == null ? unk : x === 'none' ? 0 : W(x === pk); }
      const c = pointsAfter(P, Number(b));
      if (c == null) return unk;
      if (c === 'none') return 0;
      if (leg.market === 'ttbsa') return W(`${c[0]}-${c[1]}` === pk);
      return W((c[0] > c[1] ? 'home' : c[0] < c[1] ? 'away' : 'draw') === pk);
    }
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
    case 'tace': case 'tdf': { const v = leg.market === 'tace' ? R.aces : R.dfs; return v ? W((a === 'all' ? v[0] + v[1] : v[a === 'home' ? 0 : 1]) >= leg.line) : null; }
    case 'tsbt': { if (!set) return 0; const gs = inSet(sN); return gs ? ouRes(gs.filter(brk).length) : null; }
  }
  return null;
}

/* ---------- e-Sports ----------
   R = { h, a } mapas ganhos · maps: placar (rondas) de cada mapa [[13, 7], [10, 13]] — só no CS2/Valorant; null nos outros */
/* ---------- MMA (UFC) ----------
   R.fight (feeds/fights.js): out = home|away|draw|nc · method = ko|dq|sub|dec|tdec|draw|nc · round · secs (no round) · rounds (marcados)
   Regras (as da bet365):
   - no contest, ou luta que não aconteceu: tudo devolvido
   - vencedor da luta (2 opções): empate → devolvida
   - método: "KO, TKO ou DQ" · "finalização" · "decisão ou decisão técnica" · "empate" (inclui o técnico)
   - round da vitória: vitória antes do fim → o round em que acabou; decisão (incl. técnica) → "por decisão"
   - total de rounds: 2.5 rounds = 2:30 do 3º round; acabar exatamente na linha conta como "mais"; decisão = todos os rounds
   - vai até o fim: só se os juízes decidem no fim do último round marcado (decisão técnica = não) */
const FIGHT_KINDS = new Set(['fmov', 'fround', 'fdist']);
const FIGHT_CAT = { ko: 'kodq', dq: 'kodq', sub: 'sub', dec: 'dec', tdec: 'dec' };
function fightText(k, pick, H, A) {
  if (pick === 'draw') return 'Empate';
  if (k === 'fdist') return pick === 'yes' ? 'Sim' : 'Não';
  const [side, what] = String(pick).split(':');
  const who = side === 'home' ? H : A;
  if (k === 'fmov') return `${who} por ${{ kodq: 'KO, TKO ou desqualificação', sub: 'finalização', dec: 'decisão' }[what] || what}`;
  if (k === 'fround') return what === 'dec' ? `${who} por decisão` : `${who} no ${what.slice(1)}º round`;
  return pick;
}
function fightOutcome(leg, R) {
  const f = R.fight, W = (c) => (c ? 1 : -1);
  if (f.out === 'nc') return 0;
  const k = leg.market, win = f.out !== 'draw';
  if (k === 'ml') return win ? W(leg.pick === f.out) : 0;
  if (k === 'fmov') return W(win ? leg.pick === `${f.out}:${FIGHT_CAT[f.method]}` : leg.pick === 'draw');
  if (k === 'fround') {
    if (!win) return W(leg.pick === 'draw');
    const stop = f.method === 'ko' || f.method === 'dq' || f.method === 'sub';
    return W(leg.pick === `${f.out}:${stop ? 'r' + f.round : 'dec'}`);
  }
  if (k === 'total') {
    if (!(f.round >= 1) || f.secs == null) return null;
    const played = (f.round - 1) * 300 + f.secs, mark = leg.line * 300;
    return W((played >= mark) === (leg.pick === 'over'));
  }
  if (k === 'fdist') {
    // até o fim = decisão dos juízes no fim do último round marcado (empate por decisão também)
    let full;
    if (f.method === 'dec') full = true;
    else if (f.method === 'draw') {
      // empate antes do fim de um round = técnico (não foi até o fim); no fim de um round só vale se for o último marcado
      // (a ESPN às vezes erra os rounds marcados: luta de 3 como de 5, ou "4") — se não bater, fica para a equipa
      if (f.secs < 300) full = false;
      else if (!f.rounds || f.round !== f.rounds) return null;
      else full = true;
    }
    else full = false; // KO, finalização, DQ, decisão técnica
    return W(full === (leg.pick === 'yes'));
  }
  return null; // mercado sem regra: equipa
}

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

/* Revisão final dos textos de mercados e seleções para português do Brasil (corre no servidor e no navegador).
   A fonte é a bet365 em inglês e a tradução automática (feeds/generic.js) deixava restos em inglês e termos de
   Portugal ("Remates", "Equipa", "guarda-redes"). Aqui:
   1) termos de Portugal → Brasil (nome do mercado e da seleção);
   2) inglês que sobrou → português (só no nome do mercado: o da seleção pode ter nomes de jogadores).
   Os nomes das duas equipas do jogo nunca mudam ("Team Liquid" continua "Team Liquid"). */
const ptBR = (function () {
  const R = (re, to) => [re, to];
  // 1) Portugal → Brasil (frases primeiro, depois palavras)
  const PT = [
    R(/Total da equipa de gols/g, 'Total de gols do time'), R(/Equipa Faixa de gols/g, 'Faixa de gols do time'),
    R(/Remates à baliza/g, 'Chutes no gol'), R(/remates à baliza/g, 'chutes no gol'), R(/Remates on Goal/g, 'Chutes no gol'),
    R(/\bRemates\b/g, 'Chutes'), R(/\bremates\b/g, 'chutes'), R(/\bRemate\b/g, 'Chute'), R(/\bremate\b/g, 'chute'),
    R(/Primeira equipa/g, 'Primeiro time'), R(/primeira equipa/g, 'primeiro time'), R(/Última equipa/g, 'Último time'), R(/última equipa/g, 'último time'),
    R(/Ambas as equipas/g, 'Ambos os times'), R(/ambas as equipas/g, 'ambos os times'), R(/As duas equipas/g, 'Os dois times'), R(/as duas equipas/g, 'os dois times'),
    R(/Qualquer equipa/g, 'Qualquer time'), R(/qualquer equipa/g, 'qualquer time'), R(/Equipas que marcam/g, 'Times que marcam'),
    R(/\bdas equipas\b/g, 'dos times'), R(/\bda equipa\b/g, 'do time'), R(/\ba equipa\b/g, 'o time'), R(/\bEquipas\b/g, 'Times'), R(/\bequipas\b/g, 'times'),
    R(/\bEquipa\b/g, 'Time'), R(/\bequipa\b/g, 'time'),
    R(/guarda-redes/g, 'goleiro'), R(/Guarda-redes/g, 'Goleiro'),
    R(/Roubos e desarmes de lançamento/g, 'Roubos de bola e tocos'), R(/Desarmes de lançamento/g, 'Tocos'), R(/desarmes de lançamento/g, 'tocos'),
    R(/\bRessaltos\b/g, 'Rebotes'), R(/\bressaltos\b/g, 'rebotes'), R(/\bTriplos\b/g, 'Cestas de 3'),
    R(/\bRondas\b/g, 'Rodadas'), R(/\brondas\b/g, 'rodadas'), R(/\bRonda\b/g, 'Rodada'), R(/\bronda\b/g, 'rodada'),
    R(/Pontapés de baliza/g, 'Tiros de meta'), R(/Foras de jogo/g, 'Impedimentos'), R(/Lançamentos laterais/g, 'Laterais'), R(/\bLivres\b/g, 'Cobranças de falta'),
    R(/Cabeceamentos/g, 'Cabeceios'), R(/\bgolos\b/g, 'gols'), R(/\bGolos\b/g, 'Gols'), R(/\bgolo\b/g, 'gol'), R(/\bGolo\b/g, 'Gol'),
    R(/\bpenáltis\b/g, 'pênaltis'), R(/\bPenáltis\b/g, 'Pênaltis'), R(/\bpenálti\b/g, 'pênalti'), R(/\bPenálti\b/g, 'Pênalti'),
    R(/\bprolongamento\b/g, 'prorrogação'), R(/\bProlongamento\b/g, 'Prorrogação'), R(/Super tie-break/g, 'Super tie-break'),
  ];
  // 2) inglês que sobrou (só no nome do mercado)
  const EN = [
    // frases inteiras primeiro (prorrogação, pênaltis, hóquei, basquete, e-Sports)
    R(/Gols da partida Range/g, 'Faixa de gols da partida'), R(/\bRange\b/g, 'Faixa'),
    R(/^Extra Time Final Placar$/, 'Prorrogação: placar final'), R(/^Extra Time Intervalo Placar$/, 'Prorrogação: placar do intervalo'),
    R(/^Extra Time (.+)$/, 'Prorrogação: $1'), R(/(.+) - Extra Time$/, '$1 da prorrogação'),
    R(/Game Won In Extra Time/i, 'Jogo decidido na prorrogação'), R(/Game Won After Penalties/i, 'Jogo decidido nos pênaltis'),
    R(/Resultado Decided on Penalties/i, 'Decidido nos pênaltis'), R(/Resultado Decided in Extra Time/i, 'Decidido na prorrogação'),
    R(/Will (Game|Partida) go to ([^?]+)\??/i, 'Vai para $2?'), R(/When will (Game|Partida) End/i, 'Quando termina a partida'),
    R(/Tied at End Of Regulation\?/i, 'Empatado no fim do tempo regulamentar?'), R(/Tied after Regulation/i, 'Empatado no tempo regulamentar'),
    R(/ in Regulation\b/i, ' no tempo regulamentar'), R(/ [Ii]n Período (\d+)/g, ' no período $1'), R(/ [Ii]n (\d+º tempo)/g, ' no $1'),
    R(/Time Scoring (\d+)(?:st|nd|rd|th|º) Wins Game/i, 'Time que marca o $1º gol vence'), R(/marca Último/g, 'marca por último'),
    R(/Vencer The (Most|Mais) Periods/gi, 'vence mais períodos'), R(/Win The Most Periods/gi, 'vence mais períodos'),
    R(/de mais pontos Half/g, 'Tempo com mais pontos'), R(/Highest Scoring Half/gi, 'Tempo com mais pontos'),
    R(/ of Victory\b/gi, ' de vitória'), R(/Odd or Even/gi, 'Par ou ímpar'), R(/marca point 'X'/g, "marca o ponto 'X'"), R(/\bpoint\b/g, 'ponto'),
    R(/(\d+) Minute\b/g, '$1 minutos'), R(/\bSaves\b/g, 'Defesas'), R(/Correct score/gi, 'Placar exato'),
    R(/Dragon to Spawn/gi, 'dragão a nascer'), R(/Aegis Steal/gi, 'Roubo da Aegis'), R(/Vence Both/g, 'Vence as duas'), R(/ e Vence Mapa/g, ' e o mapa'),
    R(/Best of (\d+)/gi, 'melhor de $1'), R(/\bRounds\b/g, 'Rodadas'), R(/ Scored\b/g, ''), R(/ to$/g, ''), R(/\bBoth\b/g, 'Ambos'),
    R(/\bResults\b/g, 'Resultado'), R(/\(Incl\. Tie\)/gi, '(com empate)'), R(/Multi Marcadores/g, 'Marca mais de uma vez'),
    R(/de mais pontos Período/g, 'Período com mais gols'), R(/Highest Scoring Period/gi, 'Período com mais gols'),
    R(/Puck Linhas?/g, 'Puck line'), R(/Vai para Pênaltis\?/g, 'Vai para os pênaltis?'), R(/Vai para Prorrogação\?/g, 'Vai para a prorrogação?'),
    R(/Vence (Both|Ambos) rodadas/g, 'Vence as duas rodadas'),
    R(/\bto be Booked\b/gi, 'recebe cartão'), R(/\bon Goal\b/g, 'no gol'), R(/(\d)-Way\b/g, '($1 opções)'),
    R(/\bTo Qualify\b/g, 'Classifica-se'), R(/\bMethod Of Qualification\b/gi, 'Forma de classificação'),
    R(/\bPoint Spread\b/g, 'Handicap de pontos'), R(/\bDouble Double\b/g, 'Duplo-duplo'), R(/\bTriple Double\b/g, 'Triplo-duplo'),
    R(/\bMargin \(Bands\)/g, 'Margem (faixas)'), R(/\bMargin\b/g, 'Margem'), R(/\(inc Tie\)/gi, '(com empate)'), R(/\bTo go to\b/gi, 'Vai para'),
    R(/\bwith highest scoring quarter\b/gi, 'com o quarto de mais pontos'), R(/\bhighest scoring\b/gi, 'de mais pontos'),
    R(/\bPartida-Ups\b/g, 'Duelos'), R(/\bMatch-Ups\b/gi, 'Duelos'), R(/\bMost Kills\b/g, 'Mais abates'), R(/\bMost Deaths\b/g, 'Mais mortes'),
    R(/\bMost Assistências\b/g, 'Mais assistências'), R(/\bMost\b/g, 'Mais'), R(/\bKills\b/g, 'abates'), R(/\bKill\b/g, 'abate'), R(/\bDeaths\b/g, 'mortes'),
    R(/\bBlocked\b/g, 'Bloqueados'), R(/\bEither\b/g, 'Qualquer'), R(/\bLast\b/g, 'Último'), R(/\bAlt\b/g, 'Alternativo'),
    R(/\b[Tt]o Placar\b/g, 'marca'), R(/\bPlacar point\b/g, 'marca o ponto'), R(/\bin Game\b/g, 'no jogo'), R(/\bin Match\b/g, 'na partida'),
    R(/\bGoals\b/g, 'Gols'), R(/\bGoal\b/g, 'Gol'), R(/\bTotals\b/g, 'Totais'), R(/\bLines\b/g, 'Linhas'), R(/\bLine\b/g, 'Linha'),
    R(/\bWinner\b/g, 'Vencedor'), R(/\bFirst\b/g, 'Primeiro'), R(/\bSecond\b/g, 'Segundo'), R(/\bThird\b/g, 'Terceiro'), R(/\bScorer\b/g, 'Marcador'),
    R(/\b(\d+)(st|nd|rd|th)\b/g, '$1º'), R(/ and /g, ' e '),
    R(/^Jogador (.+)$/, '$1 do jogador'), R(/^Alternativo (.+)$/, '$1 (alternativo)'), R(/^Adicional (.+)$/, '$1 (adicional)'), R(/\bResult\b/g, 'Resultado'), R(/\bWin\b/g, 'Vence'), R(/\bTo\b/g, 'para'),
  ];
  const SEL = [R(/^Any other result$/i, 'Outro resultado'), R(/^Any other Score$/i, 'Outro placar'), R(/^Any Other$/i, 'Outro'), R(/^Overtime$/, 'Prorrogação'), R(/^Penalties$/, 'Pênaltis'), R(/^Regular Time$/i, 'Tempo regulamentar'), R(/ or /g, ' ou '), R(/^Over (?=\d)/, 'Mais de '), R(/^Under (?=\d)/, 'Menos de '), R(/^Exactly (?=\d)/, 'Exatamente '),
    // restos em inglês nas seleções (revisão de 2026-10-28, com o que a fonte manda hoje)
    R(/ To Win \(\d-Way\)$/, ''), R(/^To Win$/, 'Vence'), R(/^Period (\d)$/, '$1º período'), R(/^Half (\d)$/, '$1º tempo'), R(/^(\d)(?:st|nd|rd|th) Half$/, '$1º tempo'),
    R(/ (\d)(?:st|nd|rd|th) Quarter$/, ' ($1º quarto)'), R(/ (\d)(?:st|nd|rd|th) Half$/, ' ($1º tempo)'), R(/^Basket (.+)$/, '$1'), R(/\b(\d) Points$/, '$1 pontos'),
    R(/ Or More\b/g, ' ou mais'), R(/ ou more\b/g, ' ou mais'), R(/\bby (\d+)\+ pts\b/, 'por $1+ pontos'), R(/\bby (\d+) ou mais\b/, 'por $1 ou mais'), R(/^Neither\b/, 'Nenhum'),
    R(/^Next Não Goalscorer$/, 'Sem mais gols'), R(/^Next (.+)$/, '$1'), R(/^Outro Score$/, 'Outro placar'), R(/ Line \(Incl\. Empate\)$/, ' (com empate)'),
    R(/ to Qualify after Penalties$/, ' classifica-se nos pênaltis'), R(/ to Qualify in Extra Time$/, ' classifica-se na prorrogação'),
    R(/ Extra Time$/, ' na prorrogação'), R(/ Penalties$/, ' nos pênaltis'), R(/ (\d+) Mins$/, ' nos $1 minutos'),
    R(/^(Sim|Não) a Card$/, '$1 (1 cartão ou mais)'), R(/^(Sim|Não) (\d)\+ Cards$/, '$1 ($2 cartões ou mais)'), R(/^Score (.+)$/, '$1'),
    // e-Sports
    R(/^(Sim|Não) Round (\d+)$/, '$1 (rodada $2)'), R(/^(Sim|Não) Score a (Penta|Quadra)$/, '$1 ($2 kill)'), R(/^(Penta|Quadra)$/, '$1 kill'),
    R(/^(Sim|Não) Slay a (Baron|Dragon|Roshan)$/, (s, y, o) => `${y} (${{ Baron: 'Barão', Dragon: 'Dragão', Roshan: 'Roshan' }[o]})`),
    R(/ Slay (Baron|Dragon|Roshan)$/, (s, o) => ` (${{ Baron: 'Barão', Dragon: 'Dragão', Roshan: 'Roshan' }[o]})`), R(/ Destroy Tower$/, ' (torre)'),
    R(/ (?:Primeiro|1st) (?:Blood|Kill)$/, ' (primeiro abate)'),
    R(/ Primeiro (.+) and Win Map$/, (s, list) => ` (${list.split(/,\s*/).map((x) => ({ Blood: 'primeiro abate', Tower: 'primeira torre', Roshan: 'primeiro Roshan', Dragon: 'primeiro dragão', Baron: 'primeiro Barão' }[x] || x)).join(', ')} e vence o mapa)`),
    R(/ ([+-]?\d+(?:\.\d+)?) (?:Kill Handicap|Rounds Line)$/, ' $1'), R(/^(Mais de|Menos de) (?:[OU] )?(\d+(?:\.\d+)?) Total (?:Kills|Rounds)$/, '$1 $2'),
  ];
  // nomes de mercado que a tradução por palavras deixava estranhos (depois do EN)
  const FIX = [
    R(/^Next Field Gol Exact Type$/, 'Próxima cesta: time e tipo'), R(/^Next Field Gol Type$/, 'Próxima cesta: tipo'), R(/^Time marca Next Field Gol$/, 'Time que faz a próxima cesta'),
    R(/^Qualquer Anytime Marcador$/, 'Marca a qualquer momento'), R(/^Último Marcador$/, 'Último a marcar'), R(/(\d+º) Marcador$/, '$1 a marcar'),
    R(/^Game Totais \(alternativo\)$/, 'Total do jogo (alternativo)'), R(/^Game$/, 'Linhas do jogo'),
    R(/^Time Vencer Mais Periods$/, 'Time que vence mais períodos'), R(/^Exact Total de gols$/, 'Número exato de gols'),
    R(/\bAlternativo Tower Handicap$/, 'Handicap de torres (alternativo)'), R(/\bAlternativo Total Towers$/, 'Total de torres (alternativo)'),
    R(/\bTower Handicap$/, 'Handicap de torres'), R(/\bTotal Towers$/, 'Total de torres'), R(/\bDragon Handicap$/, 'Handicap de dragões'), R(/\bRoshan Handicap$/, 'Handicap de Roshans'),
    R(/Jogador Total de abates/, 'Abates do jogador'), R(/Jogador Total Assistências/, 'Assistências do jogador'), R(/Jogador Duelos/, 'Duelos de jogadores'),
    R(/(^| - )Alternativo (.+)$/, '$1$2 (alternativo)'), R(/ - Primeiro Time para$/, ' - Primeiro time a conseguir'), R(/ - Qualquer Time$/, ' - Algum dos times'),
    R(/ - Largest Multi-abate$/, ' - Maior multi-abate'), R(/ O\/U$/, ' (mais/menos)'),
    R(/^recebe cartão do jogador$/, 'Jogador recebe cartão'), R(/^Primeiro do jogador$/, 'Primeira cesta (jogador)'),
    R(/^(\d+º (?:tempo|quarto)) Time marca X Pontos$/, '$1: time marca X pontos'), R(/^Time marca ponto 'X' no jogo$/, "Time que marca o ponto 'X' do jogo"),
    R(/^Time marca Último no tempo regulamentar$/, 'Time que marca por último (tempo regulamentar)'), R(/^10 minutos Time marca (.+)$/, 'Time que marca entre $1'),
    R(/^Total do time Par ou ímpar$/, 'Total do time: par ou ímpar'), R(/^Período (\d) /, '$1º período: '), R(/Total do time abates/, 'Total de abates do time'),
    R(/^(\d+º (?:tempo|quarto)) Resultado e Total$/, 'Resultado e total do $1'), R(/^(\d+º (?:tempo|quarto)) Handicap e Total$/, 'Handicap e total do $1'), R(/^Partida Handicap e Total$/, 'Handicap e total'),
    R(/^(\d+º (?:tempo|quarto)) Ambas Marcam X Pontos$/, '$1: os dois times fazem X pontos'), R(/^Ambas Marcam X Pontos$/, 'Os dois times fazem X pontos'),
    R(/^Resultado e Ambas Marcam 'X' Pontos$/, "Vencedor e os dois times fazem 'X' pontos"), R(/Corrida a \(Pontos\)/, 'Corrida a X pontos'), R(/^(\d+º (?:tempo|quarto)) Corrida a$/, '$1: corrida a X pontos'),
    R(/^(\d+º (?:tempo|quarto)) Margem de vitória$/, 'Margem de vitória do $1'), R(/^(\d+º tempo) Margem \(faixas\)$/, 'Margem de vitória do $1 (faixas)'),
    R(/^(\d+º (?:tempo|quarto)) Resultado \(com empate\)$/, 'Resultado do $1 (com empate)'), R(/^(\d+º (?:tempo|quarto)) Dupla Chance$/, 'Dupla chance do $1'),
    R(/^(\d+º (?:tempo|quarto)) 3 Way Linhas$/, 'Resultado do $1 (com empate)'), R(/^Multi goalscorers$/i, 'Marca mais de uma vez'),
  ];
  const run = (t, list) => { for (const [re, to] of list) t = t.replace(re, to); return t; };
  // protege os nomes das equipas (e devolve-os no fim)
  function ptBR(text, names = [], market = false) {
    let t = String(text ?? '');
    if (!t) return t;
    const keep = names.filter(Boolean).sort((a, b) => b.length - a.length);
    keep.forEach((n, i) => { t = t.split(n).join(`\u0000${i}\u0000`); });
    t = run(t, PT);
    t = market ? run(run(t, EN), FIX) : run(t, SEL);
    t = t.replace(/\s+/g, ' ').trim();
    keep.forEach((n, i) => { t = t.split(`\u0000${i}\u0000`).join(n); });
    return t;
  }
  const cache = new Map();
  return (text, names = [], market = false) => {
    const k = (market ? 'm|' : 's|') + names.join('|') + '|' + text;
    let v = cache.get(k);
    if (v === undefined) { v = ptBR(text, names, market); if (cache.size > 50000) cache.clear(); cache.set(k, v); }
    return v;
  };
})();

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
      else if (TOTALS.has(mk.k)) { o.lbl = `${s.pick === 'over' ? '+' : '-'}${s.line}`; o.name = `${s.pick === 'over' ? 'Mais' : 'Menos'} de ${s.line}${ev.sport === 'mma' ? ' rounds' : ''}`; o.cside = s.pick; o.cline = s.line; }
      // MMA: "home:kodq", "away:r2", "draw"...
      else if (FIGHT_KINDS.has(mk.k)) o.lbl = o.name = fightText(mk.k, s.pick, H, A);
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
      // português do Brasil (termos de Portugal e restos em inglês da fonte); os nomes das equipas não mudam
      const keepNames = [ev.home.name, ev.away.name, H, A];
      const nm0 = o.name;
      o.marketName = ptBR(o.marketName, keepNames, true);
      if (o.name != null) o.name = ptBR(o.name, keepNames);
      if (o.lbl === nm0) o.lbl = o.name;
      out.push(o);
    }
  }
  // mercados da equipa criados no painel ("Esportes e mercados"); suspensos aparecem com cadeado
  for (const cm of ev.cm || []) {
    for (const c of cm.sels) {
      out.push({
        market: 'custom', pick: `${cm.id}.${c.id}`, lbl: c.name, name: c.name, odds: c.odds, marketName: cm.name,
        // fechado à mão, linha bloqueada pelo motor, ou prazo de fechamento do mercado já passou
        locked: cm.status !== 'open' || !!c.locked || (cm.closesAt != null && Date.now() >= cm.closesAt), maxStake: cm.maxStake ?? null, key: `${ev.id}|custom|${cm.id}.${c.id}`,
        cside: c.side || null, cline: c.line ?? null, // lado/linha (mercados automáticos): o site arruma as linhas em tabela
        cgroup: cm.group || null, // "Mapa 1", "Mapa 2"... (melhor de 3, 5, 7)
        cclose: cm.closesAt ?? null,
      });
    }
  }
  return out.filter((s) => s.odds);
}

function isSuspended(ev, now = Date.now()) {
  // antes do jogo, depois do início já não se aposta (até o jogo aparecer ao vivo)
  return !ev || ev.state === 'post' || (!ev.markets && !ev.cm?.length) || (ev.suspendedUntil || 0) > now || (ev.closesAt != null && now >= ev.closesAt);
}
// nome do evento: "Casa x Fora", ou o título num evento de longo prazo ("Campeão do SIX Major")
const evLabel = (ev) => (ev.outright ? ev.home.name : `${ev.home.short} x ${ev.away.short}`);

/* ---------- liquidação ----------
   R = resultado do jogo, já validado pelo leitor da fonte de dados:
     { h, a }  placar final (futebol: tempo regulamentar; basquete e hóquei: com prorrogação; ténis: sets ganhos)
     reg       hóquei: placar no fim do 3º período · sets: ténis, games de cada set [[6, 4], [3, 6], ...]
     alts      hóquei decidido nos pênaltis: os dois placares possíveis (a fonte não diz quem ganhou) */
// -1 perdeu · -0.5 meia perda · 0 devolvida · 0.5 meio ganho · 1 ganhou
/* Ténis terminado por desistência (R.retired): o que ficou decidido pelo que se jogou é pago ou perdido; o que ficou em
   aberto é devolvido (0). R.sets = sets jogados (o último pode estar a meio), R.log = games jogados, R.need = sets para ganhar. */
const T_GAME = new Set(['tgw', 'tgs', 'tgd', 'tgsw', 'tg1p', 'tgsa', 'tgpb', 'tgbp', 'tgtp']);
const T_GAME2 = new Set(['tgpw', 'tgpd']);
const T_FSRV = new Set(['tfswin', 'tfsg', 'tfsw', 'tfsd', 'tfsa', 'tfstp', 'tfsbp']);
const T_MATCH = new Set(['ml', 'sets', 'tsets', 'tstraight', 'tpto', 'tdr', 'tcast', 'tdist']);
const T_SET = new Set(['tsw', 'tscs', 'tscg', 'tsca', 'tsgt', 'tsgh', 'tstbw', 'tsbrk', 'tsbt', 'tslead', 'tsafter', 'tsrace', 'ttbtp', 'ttbs', 'ttblead', 'ttbsa', 'ttbpb']);
// i = nº do set (0 = 1º), need = sets para ganhar: "1-0" só é placar final no set decisivo (super tie-break)
const tOkSet = ([x, y], i, need = 2) => { const hi = Math.max(x, y), lo = Math.min(x, y); return (hi === 1 && lo === 0 && i === 2 * need - 2) || (hi === 6 && lo <= 4) || (hi === 7 && (lo === 5 || lo === 6)) || (hi > 7 && hi - lo === 2); };
function tennisRetired(leg, R) {
  const k = leg.market, sets = R.sets || [], log = R.log || null;
  const played = { ...R, retired: false };
  const as = (v) => (v == null ? null : v); // null = faltam dados (equipa)
  const doneSets = sets.filter((x, i) => i < sets.length - 1 || tOkSet(x, i, R.need || 2));
  const [a, b] = String(leg.per ?? '').split(/[:/]/);
  const sN = Number(a);
  const brk = (e) => e.srv && e.w !== e.srv;
  const ou = (cur) => (cur > leg.line ? (leg.pick === 'over' ? 1 : leg.pick === 'under' ? -1 : 0) : 0); // passou a linha: decidido; senão em aberto
  if (T_GAME.has(k) || T_GAME2.has(k)) {
    if (!log) return null;
    const g = Number(b), need = T_GAME2.has(k) ? [g, g + 1] : [g];
    return need.every((n) => log.some((e) => e.s === sN && e.g === n)) ? as(legOutcome(leg, played)) : 0;
  }
  if (T_FSRV.has(k)) { if (!log) return null; return log.some((e) => e.srv === a && !e.tb) ? as(legOutcome(leg, played)) : 0; }
  if (k === 'tfbrk') { if (!log) return null; return log.some(brk) ? as(legOutcome(leg, played)) : 0; }
  if (T_SET.has(k)) {
    if (a === 'M') return 0; // super tie-break não jogado até ao fim
    if (sN >= 1 && sN <= doneSets.length) return as(legOutcome(leg, played)); // set acabado
    if (sN > sets.length || !log) return sN > sets.length ? 0 : null; // set nem começado
    const gs = log.filter((e) => e.s === sN); // set a meio: só o que já ficou decidido
    if (k === 'tslead' || k === 'tsafter') return gs.length >= Number(b) ? as(legOutcome(leg, played)) : 0;
    if (k === 'tsrace') { let h = 0, w = 0; for (const e of gs) { if (e.w === 'home') h++; else w++; if (h === Number(b) || w === Number(b)) return as(legOutcome(leg, played)); } return 0; }
    if (k === 'tsbrk') { const [p1, p2] = String(leg.pick).split(':'); return gs.some((e) => brk(e) && e.w === p1) ? (p2 === 'yes' ? 1 : -1) : 0; }
    if (k === 'tsgt') return ou(gs.length);
    if (k === 'tsbt') return ou(gs.filter(brk).length);
    return 0;
  }
  if (T_MATCH.has(k)) {
    // pago só se qualquer final possível da partida desse o mesmo resultado
    const need = R.need || 2;
    const hw = doneSets.filter(([x, y]) => x > y).length, aw = doneSets.length - hw;
    const outs = new Set();
    const rec = (h, w, extra) => {
      if (outs.size > 1) return;
      if (h === need || w === need) { outs.add(legOutcome(leg, { h, a: w, sets: doneSets.concat(extra.map((x) => (x === 'home' ? [6, 0] : [0, 6]))) })); return; }
      rec(h + 1, w, [...extra, 'home']); rec(h, w + 1, [...extra, 'away']);
    };
    rec(hw, aw, []);
    const v = outs.size === 1 ? [...outs][0] : 0;
    return v == null ? 0 : v;
  }
  // contagens que só sobem: "mais de" ganha / "menos de" perde se já passou a linha; senão em aberto
  if (k === 'gtotal') return ou(sets.reduce((q, x) => q + x[0] + x[1], 0));
  if (k === 'tpgw') return ou(sets.reduce((q, x) => q + x[a === 'home' ? 0 : 1], 0));
  if (k === 'ttb') return ou(doneSets.filter((x) => Math.max(...x) === 7 && Math.min(...x) === 6).length);
  if (k === 'tbrk') return log ? ou(log.filter(brk).length) : null;
  if (k === 'tpbrk') {
    if (!log) return null;
    const si = Number(b) || 0;
    if (si && si <= doneSets.length) return as(legOutcome(leg, played));
    return ou(log.filter((e) => brk(e) && e.w === a && (!si || e.s === si)).length);
  }
  if (k === 'tace' || k === 'tdf') {
    const v = k === 'tace' ? R.aces : R.dfs;
    if (!v) return 0;
    const cur = a === 'all' ? v[0] + v[1] : v[a === 'home' ? 0 : 1];
    return cur >= leg.line ? 1 : 0; // "N ou mais" já atingido: ganha; senão em aberto
  }
  return 0; // par/ímpar, handicaps, vencedor + total...: em aberto
}

function legOutcome(leg, R) {
  if (leg.market === 'x') return null; // mercado da equipa: liquidado no painel
  if (R.retired) return tennisRetired(leg, R); // ténis: partida terminada por desistência
  if (R.cancelled && R.tt) return 0; // tênis de mesa: partida que não se jogou → devolvida
  if (R.tt) return ttOutcome(leg, R); // tênis de mesa
  if (R.fight) return fightOutcome(leg, R); // MMA
  if (AUTO_KINDS.has(leg.market)) return partOutcome(leg, R);
  if (leg.market === 'pp') return ppOutcome(leg, R);
  if (leg.market === 'bp') return bpOutcome(leg, R);
  if (leg.market === 'hgs') return hgsOutcome(leg, R);
  if (leg.market === 'prace') return raceOutcome(leg, R);
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
  return null; // mercado sem regra conhecida: fica para a equipa (antes era devolvida sozinha)
}
const outcomeFactor = (v, o) => (v === 1 ? o : v === 0.5 ? (1 + o) / 2 : v === 0 ? 1 : v === -0.5 ? 0.5 : 0);
const outcomeLabel = (v) => (v === 1 ? 'won' : v === 0.5 ? 'halfwon' : v === 0 ? 'void' : v === -0.5 ? 'halflost' : 'lost');
const resultText = (R) => (R.fight ? fightResultText(R.fight) : R.sets ? R.sets.map((s) => s.join('-')).join(' ') + (R.retired ? ' (desistência)' : '') : `${R.h} x ${R.a}`);
const FIGHT_PT = { ko: 'KO/TKO', dq: 'desqualificação', sub: 'finalização', dec: 'decisão', tdec: 'decisão técnica' };
function fightResultText(f) {
  if (f.cancelled) return f.replaced ? 'Luta não aconteceu (mudança de adversário)' : 'Luta não aconteceu';
  if (f.out === 'nc') return 'Sem resultado (no contest)';
  const t = f.round ? ` · ${f.round}º round${f.secs != null ? ` ${Math.floor(f.secs / 60)}:${String(f.secs % 60).padStart(2, '0')}` : ''}` : '';
  return (f.out === 'draw' ? 'Empate' : `${f.winner || (f.out === 'home' ? 'Casa' : 'Fora')} por ${FIGHT_PT[f.method]}`) + t;
}

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
  SPORTS, GOAL_SPORTS, LEAGUES, LEAGUE_BY_KEY, addLeague, dynLeagues, setCatalog, round2, resultText, fmtLine, MARKET_NAMES, selections, isSuspended, evLabel,
  legOutcome, outcomeFactor, outcomeLabel, settleLeg, cashoutFactor, AUTO_KINDS, SOURCE_KINDS, FIGHT_KINDS, partOutcome, scopeOf, ppNorm, PP_FIELD, ppPlayer, bpKey, BP_FIELD, bpPlayer, bpNeed, raceFromLog, raceOutcome,
};
if (typeof module !== 'undefined' && module.exports) module.exports = Markets;
