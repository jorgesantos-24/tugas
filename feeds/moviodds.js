'use strict';
/* Fonte de jogos, odds e resultados: MoviOdds (https://moviodds.com/doc) — odds da bet365.
   Tudo o que é específico da MoviOdds fica neste ficheiro: para trocar de fornecedor, troca-se só este módulo.
   Devolve os jogos já no formato do site (o mesmo que o markets.js e o app.js usam).

   Limites deles: 300 pedidos/min em /odds e 120/min em /results (por IP; com chave, por chave).
   A cada 5 s: 1 pedido ao vivo por modalidade; a cada minuto: 1 pedido completo por modalidade. */

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const BASE = 'https://moviodds.com';
const KEY = process.env.NO_EXTERNAL === '1' ? '' : process.env.MOVIODDS_KEY || ''; // opcional

const M = require('../public/markets.js');
const TEN = require('./tennis.js'); // mercados e histórico de games do ténis
const GUARD_SOCCER = require('./guard-soccer.js'); // proteção das odds do futebol (mercados irmãos)
const GEN = require('./generic.js'); // todos os outros mercados (liquidados pela equipa)
const WS = require('./moviows.js'); // odds e placar ao vivo empurrados (WebSocket)
const STATS = require('./stats.js'); // estatísticas ao vivo (página do jogo)
const PARTS = require('./parts.js'); // placar de cada parte (tempos, quartos, períodos, mapas) a partir das estatísticas
const PLAYERS = require('./players.js'); // futebol: mercados de jogadores (cobertura por liga, estatísticas por jogador)
const BP = require('./bplayers.js'); // basquete: mercados de jogadores (box score)
const ESPN = require('./espn.js'); // box score do basquete (NBA/WNBA) e marcadores da NHL
const BB = require('./betbuilder.js'); // Criar aposta: que seleções o motor sabe calcular
const BK = require('./bbasket.js'); // Criar aposta do basquete
const HG = require('./hgoals.js'); // hóquei: marcadores (NHL) e ordem dos gols
const FIGHTS = require('./fights.js'); // MMA: resultado das lutas (MoviOdds + ESPN)
const TT = require('./tabletennis.js'); // tênis de mesa: mercados e resultado (placar de cada set)
// competições a eliminar: um empate aos 90' pode ter prolongamento (as apostas de jogadores esperam pela ESPN)
const KNOCKOUT = new Set(['bra.copa', 'conmebol.lib', 'conmebol.sud', 'uefa.ucl', 'uefa.uel', 'uefa.uecl', 'eng.efl', 'esp.copa', 'ger.copa']);
// último estado de cada jogo vindo dos pedidos normais (equipas, liga, hora, relógio): o WebSocket só traz odds e estatísticas
const lastMeta = new Map(); // id → { m (sem cotações), sport }
const fullQuotes = new Map(); // futebol: id → cotações do último pedido com todos os grupos (para o Criar aposta)

// placar ao vivo a partir das estatísticas do WebSocket (chega antes do pedido seguinte)
function scoreFromStats(sport, st) {
  const h = st?.home, a = st?.away;
  if (!h || !a) return null;
  if (sport === 'tennis' && Array.isArray(h.sets) && Array.isArray(a.sets) && h.sets.length === a.sets.length) return h.sets.map((x, i) => `${x}-${a.sets[i]}`).join(',');
  if (sport === 'esports') return Number.isFinite(h.maps_won) && Number.isFinite(a.maps_won) ? `${h.maps_won}-${a.maps_won}` : null;
  const key = sport === 'basketball' ? 'points' : sport === 'soccer' || sport === 'hockey' ? 'goals' : null;
  return key && Number.isFinite(h[key]) && Number.isFinite(a[key]) ? `${h[key]}-${a[key]}` : null;
}
// modalidade no site → nome na MoviOdds
const SRC_SPORT = { soccer: 'soccer', basketball: 'basketball', tennis: 'tennis', hockey: 'ice_hockey', mma: 'mma', tabletennis: 'table_tennis', esports: 'esports' };
const SPORTS = Object.keys(SRC_SPORT);
// modalidades organizadas por torneio (cada torneio é um campeonato do site)
const BY_TOURNAMENT = { tennis: 'ten.', esports: 'es.', mma: 'mma.', tabletennis: 'tt.' };

// campeonato do site a partir do nome na MoviOdds ("src" exato, ou "re" para vários torneios do ténis)
/* Ténis: cada torneio é um campeonato próprio ("ATP Basel"), a seguir ao seu circuito.
   As duplas vêm com sufixo (MD masculinas, WD femininas, XD mistas) e ficam num campeonato à parte. */
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const DOUBLES = { MD: 'Duplas', WD: 'Duplas', XD: 'Duplas Mistas' };
function tournament(circuit, srcName, sport) {
  let name = String(srcName).trim();
  if (sport === 'esports') name = name.replace(/^[A-Z0-9]+ - /, ''); // "CS2 - PGL Bucharest" → "PGL Bucharest" (o jogo vai no circuito)
  else if (sport === 'mma') name = name.replace(/ - /, ': ').replace(/ vs\.? /g, ' x '); // "UFC 334 - Gane vs Hokit" → "UFC 334: Gane x Hokit"
  else { const m = /^(.*\S)\s+(MD|WD|XD)$/.exec(name); if (m) name = `${m[1]} (${DOUBLES[m[2]]})`; }
  const id = sport === 'esports' ? `${circuit.key} ${name}` : name; // e-Sports: o mesmo torneio pode existir em dois jogos
  return M.addLeague({ key: BY_TOURNAMENT[sport] + slug(id), name, country: circuit.name, sport, order: circuit.order + 0.5 });
}

function leagueOf(sport, name) {
  return M.LEAGUES.find((l) => l.sport === sport && (l.src === name || (l.re && l.re.test(name)))) || null;
}

/* Futebol: todas as competições que a fonte oferece (decisão de 2026-10-27). As 24 principais têm nome e ordem
   próprios (markets.js); as outras criam-se na hora ("fut.<nome>"), agrupadas por país no menu.
   Ficam de fora: competições de menores (sub-15 a sub-20, UEFA Youth League) e futebol virtual (e-soccer). */
const SOCCER_SKIP = /\bU-?(1[0-9]|20)\b|Youth League|e-?soccer|virtual|\d+ mins play/i;
const MULTI_COUNTRY = ['Bosnia & Herzegovina', 'Northern Ireland', 'South Korea', 'North Korea', 'Saudi Arabia', 'New Zealand', 'Hong Kong', 'Costa Rica',
  'El Salvador', 'United Arab Emirates', 'Faroe Islands', 'North Macedonia', 'Republic of Ireland', 'South Africa', 'Ivory Coast', 'Czech Republic',
  'San Marino', 'Dominican Republic', 'Trinidad & Tobago', 'Burkina Faso', 'Sierra Leone', 'Sri Lanka', 'Puerto Rico', 'United States', 'Cape Verde'];
const INTERNATIONAL = /^(UEFA|AFC|CAF|CONMEBOL|CONCACAF|OFC|FIFA|Copa |Club |International|World|Africa|Asia|Euro|Gulf|Arab|Leagues Cup|Campeones|Champions)/i;
const GENERIC_REGION = new Set(['Europe', 'The Americas', 'United Kingdom', 'Rest Of World', 'Top Leagues', 'UEFA Competitions', 'undefined', '']);
const COUNTRY_PT = {
  Spain: 'Espanha', England: 'Inglaterra', Italy: 'Itália', Germany: 'Alemanha', France: 'França', Netherlands: 'Holanda', Brazil: 'Brasil',
  Scotland: 'Escócia', Wales: 'País de Gales', 'Northern Ireland': 'Irlanda do Norte', 'Republic of Ireland': 'Irlanda', Ireland: 'Irlanda',
  Türkiye: 'Turquia', Turkey: 'Turquia', Belgium: 'Bélgica', Japan: 'Japão', 'South Korea': 'Coreia do Sul', China: 'China', Australia: 'Austrália',
  Sweden: 'Suécia', Norway: 'Noruega', Denmark: 'Dinamarca', Finland: 'Finlândia', Iceland: 'Islândia', Poland: 'Polônia', Czechia: 'Tchéquia',
  'Czech Republic': 'Tchéquia', Slovakia: 'Eslováquia', Hungary: 'Hungria', Austria: 'Áustria', Switzerland: 'Suíça', Greece: 'Grécia',
  Romania: 'Romênia', Bulgaria: 'Bulgária', Serbia: 'Sérvia', Croatia: 'Croácia', Slovenia: 'Eslovênia', 'Bosnia & Herzegovina': 'Bósnia',
  'North Macedonia': 'Macedônia do Norte', Albania: 'Albânia', Montenegro: 'Montenegro', Cyprus: 'Chipre', Israel: 'Israel', Ukraine: 'Ucrânia',
  Russia: 'Rússia', Belarus: 'Bielorrússia', Estonia: 'Estônia', Latvia: 'Letônia', Lithuania: 'Lituânia', Georgia: 'Geórgia', Armenia: 'Armênia',
  Azerbaijan: 'Azerbaijão', Kazakhstan: 'Cazaquistão', Portugal: 'Portugal', Argentina: 'Argentina', Uruguay: 'Uruguai', Paraguay: 'Paraguai',
  Chile: 'Chile', Peru: 'Peru', Ecuador: 'Equador', Colombia: 'Colômbia', Venezuela: 'Venezuela', Bolivia: 'Bolívia', Mexico: 'México',
  USA: 'Estados Unidos', 'United States': 'Estados Unidos', Canada: 'Canadá', 'Costa Rica': 'Costa Rica', Honduras: 'Honduras', Guatemala: 'Guatemala',
  'El Salvador': 'El Salvador', Egypt: 'Egito', Morocco: 'Marrocos', Algeria: 'Argélia', Tunisia: 'Tunísia', 'South Africa': 'África do Sul',
  Nigeria: 'Nigéria', 'Saudi Arabia': 'Arábia Saudita', 'United Arab Emirates': 'Emirados Árabes', Qatar: 'Catar', Iran: 'Irã', Iraq: 'Iraque',
  Jordan: 'Jordânia', India: 'Índia', Indonesia: 'Indonésia', Thailand: 'Tailândia', Vietnam: 'Vietnã', Malaysia: 'Malásia', Singapore: 'Singapura',
  'Hong Kong': 'Hong Kong', Myanmar: 'Myanmar', 'New Zealand': 'Nova Zelândia', Malta: 'Malta', Luxembourg: 'Luxemburgo', Moldova: 'Moldávia', 'Ivory Coast': 'Costa do Marfim', 'Faroe Islands': 'Ilhas Faroé', 'Dominican Republic': 'República Dominicana', 'Trinidad & Tobago': 'Trinidad e Tobago', 'Sierra Leone': 'Serra Leoa', 'Puerto Rico': 'Porto Rico', 'Cape Verde': 'Cabo Verde', 'North Korea': 'Coreia do Norte', Kenya: 'Quênia', Ghana: 'Gana', Cameroon: 'Camarões', Senegal: 'Senegal', Zambia: 'Zâmbia', Tanzania: 'Tanzânia', Uganda: 'Uganda', Ethiopia: 'Etiópia', Rwanda: 'Ruanda', Mongolia: 'Mongólia', Kuwait: 'Kuwait', Oman: 'Omã', Bahrain: 'Bahrein', Lebanon: 'Líbano', Syria: 'Síria', Uzbekistan: 'Uzbequistão', Philippines: 'Filipinas', Seychelles: 'Seychelles', Panama: 'Panamá', Nicaragua: 'Nicarágua', Jamaica: 'Jamaica', Haiti: 'Haiti', Cuba: 'Cuba', Kosovo: 'Kosovo', Andorra: 'Andorra', Gibraltar: 'Gibraltar', Liechtenstein: 'Liechtenstein',
};
// liga do site para um nome da fonte (sem a criar): { key, name, country } ou null (fora: menores, virtual)
function soccerDyn(name, region) {
  const src = String(name || '').trim();
  if (!src || SOCCER_SKIP.test(src)) return null;
  let country = null, rest = src;
  const multi = MULTI_COUNTRY.find((c) => src.startsWith(c + ' '));
  if (multi) { country = multi; rest = src.slice(multi.length + 1); }
  else if (INTERNATIONAL.test(src)) country = 'Internacional';
  else {
    const [first, ...r] = src.split(' ');
    if (COUNTRY_PT[first] && r.length) { country = first; rest = r.join(' '); }
    else if (!GENERIC_REGION.has(String(region))) country = String(region); // ex.: "A-League" (Austrália)
    else country = 'Outros';
  }
  return { key: `fut.${slug(src)}`, name: rest || src, country: COUNTRY_PT[country] || country };
}
// competição a eliminar (pode ter prolongamento)
const isCup = (name) => /\b(cup|copa|pokal|coupe|coppa|ta[cç]a|beker|trophy|shield|play-?offs?|knockout|qualif)/i.test(String(name || ''));
function soccerLeague(name, region) {
  const fixed = leagueOf('soccer', name);
  if (fixed) return fixed;
  const d = soccerDyn(name, region);
  return d ? M.addLeague({ ...d, sport: 'soccer', order: 100 }) : null; // depois das 24 principais, por país
}

/* Futebol: mercados por código do grupo (estáveis; permitem pedir só estes, o que deixa a resposta pequena).
   main = linha principal (aparece na lista de jogos). */
const SOCCER_GROUPS = {
  // antes do jogo
  40: { k: 'ml' }, 10114: { k: 'dc' }, 10544: { k: 'dnb' }, 10150: { k: 'btts' }, 43: { k: 'cs' },
  // a mesma linha em dois grupos de totais (ex.: 1.5 em "Alternative Total Goals" a 1.29 e em "Alternative Goal Line"
  // a 1.26, margens diferentes): fica a do grupo com prio maior, sem a tratar como conflito
  981: { k: 'total', main: true }, 10202: { k: 'total', prio: 2 }, 10143: { k: 'total', prio: 1 }, 50139: { k: 'total' },
  938: { k: 'spread', main: true }, 50138: { k: 'spread' },
  // ao vivo
  1777: { k: 'ml' }, 10115: { k: 'dc' }, 10563: { k: 'dnb' }, 10565: { k: 'btts' },
  421: { k: 'total', main: true }, 15: { k: 'total' },
  12: { k: 'spread', main: true, fromScore: true }, // handicap asiático ao vivo: conta só os gols depois da aposta
};
const SOCCER_PRE = '40,10114,10544,10150,43,981,10202,10143,50139,938,50138';
const SOCCER_LIVE = '1777,10115,10563,10565,421,15,12';

/* Outras modalidades: mercados pelo nome do grupo (iguais antes do jogo e ao vivo).
   "game" = grupo da bet365 com vencedor, handicap e total juntos (campo "line": To Win / Line / Total). */
const NAMED = {
  basketball: [[/^Game$/, 'game'], [/^Alternative (Line|Point Spread)( 2)?$/, 'spread'], [/^Alternative (Game Total|Totals)( 2)?$/, 'total']], // ao vivo e em algumas ligas: "Alternative Totals" / "Point Spread"
  hockey: [[/^Game$/, 'game'], [/^3-Way$/, 'mlr'], [/^Double Chance$/, 'dcr']],
  // ténis: ver feeds/tennis.js
};
// quantas seleções um mercado precisa para valer (com uma a menos, sai do site)
const NEED = { soccer: { ml: 3, dc: 3, dnb: 2, btts: 2 }, basketball: { ml: 2 }, hockey: { ml: 2, mlr: 3, dcr: 3 }, tennis: { ml: 2 }, mma: { ml: 2, fdist: 2 }, tabletennis: { ml: 2 } };
const MARKET_ORDER = ['ml', 'mlr', 'dc', 'dcr', 'dnb', 'btts', 'set1', 'fmov', 'fround', 'fdist', 'total', 'spread', 'sets', 'tsets', 'sspread', 'gspread', 'gtotal', 'cs'];

const STALE_LIVE_MS = 60000; // ao vivo: odds lidas há mais de 1 min ficam bloqueadas

// tempo máximo de cada pedido (o completo do futebol tem ~118 MB: numa ligação lenta, ex. testes locais, pode precisar de mais)
const TIMEOUT_MS = Number(process.env.MOVIODDS_TIMEOUT_MS) || 25000;
const urlOf = (pathQs) => `${BASE}${pathQs}${KEY ? (pathQs.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY) : ''}`;
async function get(pathQs) {
  const r = await fetch(urlOf(pathQs), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`MoviOdds ${pathQs.split('&')[0]}: HTTP ${r.status}`);
  return r.json();
}

/* Listas de jogos (/odds): lidas no worker feeds/bigjson.js. O JSON.parse do futebol completo (~118 MB) aqui
   deixava o servidor parado 10-20 s; lá corre noutra thread e os jogos chegam aos bocados, entre outros pedidos. */
let bigWorker = null, bigSeq = 0;
const bigJobs = new Map(); // id → { resolve, reject, label, d, matches, timer }
function bigFail(err) {
  for (const [id, j] of bigJobs) { clearTimeout(j.timer); bigJobs.delete(id); j.reject(new Error(`MoviOdds ${j.label}: ${err}`)); }
  bigWorker = null;
}
function bigW() {
  if (bigWorker) return bigWorker;
  const w = bigWorker = new Worker(path.join(__dirname, 'bigjson.js'));
  w.unref();
  w.on('message', (msg) => {
    const j = bigJobs.get(msg.id);
    if (!j) return;
    const end = (err) => { clearTimeout(j.timer); bigJobs.delete(msg.id); if (err) j.reject(new Error(`MoviOdds ${j.label}: ${err}`)); else { j.d.matches = j.matches; j.resolve(j.d); } };
    if (msg.error) return end(msg.error);
    if (msg.head) { j.d = msg.head; return msg.total ? w.postMessage({ id: msg.id, next: true }) : end(); }
    for (const m of msg.part) j.matches.push(m);
    if (msg.done) return end();
    setImmediate(() => w.postMessage({ id: msg.id, next: true })); // dá a vez aos outros pedidos entre bocados
  });
  w.on('error', (e) => { console.error('[MoviOdds] worker:', e.message); if (bigWorker === w) bigFail(e.message); });
  w.on('exit', (code) => { if (bigWorker === w) bigFail(`worker saiu (${code})`); });
  return w;
}
function getOdds(pathQs) {
  const id = ++bigSeq;
  return new Promise((resolve, reject) => {
    const w = bigW();
    // segurança: se o worker não acabar, o ciclo de atualização não fica preso para sempre
    const timer = setTimeout(() => {
      if (!bigJobs.delete(id)) return;
      w.postMessage({ id, cancel: true });
      reject(new Error(`MoviOdds ${pathQs.split('&')[0]}: sem resposta do worker`));
    }, TIMEOUT_MS + 60000);
    bigJobs.set(id, { resolve, reject, label: pathQs.split('&')[0], d: null, matches: [], timer });
    w.postMessage({ id, url: urlOf(pathQs), timeout: TIMEOUT_MS });
  });
}

// ténis: últimas odds tiradas do site pela proteção (feeds/tennis.js guardTennis) — para o painel e os testes
const guardRemoved = [];
const round2 = (n) => Math.round(n * 100) / 100;
const parseScore = (s) => { const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(s || '').trim()); return m ? [Number(m[1]), Number(m[2])] : null; };
// número de uma linha: "2.5", "+1.5", "Over 2.5"; linha asiática "3.0, 3.5" = 3.25 (metade da aposta em cada uma)
const num = (v) => {
  const t = String(v ?? '');
  const n = t.match(/[+-]?\d+(\.\d+)?/g);
  if (!n) return NaN;
  return /,/.test(t) && n.length === 2 ? (Number(n[0]) + Number(n[1])) / 2 : Number(n[0]);
};
const pad2 = (n) => String(Math.max(0, n)).padStart(2, '0');

/* Relógio da bet365: { min, sec, ticking, ref } — "ref" é quando o relógio marcava min:sec.
   Futebol conta para a frente (1º tempo até 45', 2º até 90'); basquete conta para trás (tempo que falta no período). */
function clockLabel(c, serverNow, sport = 'soccer') {
  if (!c || c.min == null) return 'Ao vivo';
  const run = c.ticking && c.ref ? (serverNow - Date.parse(c.ref)) / 1000 : 0;
  let secs = Number(c.min) * 60 + (Number(c.sec) || 0);
  if (sport === 'basketball') { secs = Math.max(0, Math.round(secs - run)); return `${pad2(Math.floor(secs / 60))}:${pad2(secs % 60)}`; }
  if (sport !== 'soccer') return `${pad2(Number(c.min))}:${pad2(Number(c.sec) || 0)}`;
  if (!c.ticking && Number(c.min) === 45 && !Number(c.sec)) return 'Intervalo';
  const min = Math.floor((secs + run) / 60);
  const cap = Number(c.min) < 45 ? 45 : 90;
  return min >= cap ? `${cap}'+` : `${Math.max(1, min)}'`;
}
/* Futebol: relógio ao segundo para o site (os minutos e os descontos, ex.: 47:12, 93:05).
   A correr: t0 = hora (deste servidor) em que o relógio marcaria 0:00 — o navegador conta os segundos sozinho.
   Parado: secs = segundos no relógio. No intervalo (ou sem relógio) não há. */
function soccerClock(c, serverNow) {
  if (!c || c.min == null || (!c.ticking && Number(c.min) === 45 && !Number(c.sec))) return null;
  const secs = Number(c.min) * 60 + (Number(c.sec) || 0) + (c.ticking && c.ref ? (serverNow - Date.parse(c.ref)) / 1000 : 0);
  if (!Number.isFinite(secs) || secs < 0) return null;
  return c.ticking && c.ref ? { clockT0: Math.round((Date.now() - secs * 1000) / 1000) * 1000 } : { clockSecs: Math.floor(secs) };
}

// ténis ao vivo: "7-5,1-6,4-3" → sets terminados + set a decorrer
function tennisLive(score) {
  const parts = String(score || '').split(',').map(parseScore).filter(Boolean);
  const cur = parts.pop() || [0, 0];
  const h = parts.filter(([x, y]) => x > y).length;
  return { h, a: parts.length - h, clock: `${parts.length + 1}º set · ${cur[0]}-${cur[1]}` + (parts.length ? ` (${parts.map((p) => p.join('-')).join(' ')})` : '') };
}

// uma cotação → seleção do site ({ k, pick, line?, base?, main? }) ou null
function soccerQuote(q, m) {
  const g = SOCCER_GROUPS[q.group_id];
  if (!g) return null;
  const s = { k: g.k, main: !!g.main, prio: g.prio || 0 };
  if (g.k === 'ml' || g.k === 'dc') s.pick = { 1: 'home', X: 'draw', 2: 'away', '1X': 'hd', 12: 'ha', X2: 'da' }[q.n2];
  else if (g.k === 'dnb') s.pick = q.label === m.home ? 'home' : q.label === m.away ? 'away' : null;
  else if (g.k === 'btts') s.pick = /^yes$/i.test(q.label) ? 'yes' : /^no$/i.test(q.label) ? 'no' : null;
  else if (g.k === 'total') { s.pick = /^over$/i.test(q.side) ? 'over' : /^under$/i.test(q.side) ? 'under' : null; s.line = num(q.handicap ?? q.line); }
  else if (g.k === 'spread') {
    s.pick = q.side === m.home ? 'home' : q.side === m.away ? 'away' : null;
    s.line = num(q.handicap ?? q.line);
    if (g.fromScore) {
      // placar de referência: vem em "period" (ex.: "2-0") ou no nome do grupo ("Asian Handicap (2-0)")
      s.base = parseScore(q.period) || parseScore((/\((\d+-\d+)\)\s*$/.exec(q.group_name) || [])[1]);
      if (!s.base) return null;
    }
  } else if (g.k === 'cs') {
    // "2-1" com o lado = vencedor (ou "Draw"); no site o placar é sempre casa-fora
    const p = parseScore(q.label);
    if (!p) return null;
    s.pick = q.side === m.away ? `${p[1]}-${p[0]}` : `${p[0]}-${p[1]}`;
  }
  return s;
}

function namedQuote(q, m, sport) {
  const rule = NAMED[sport].find(([re]) => re.test(q.group_name));
  if (!rule) return null;
  let k = rule[1];
  const who = (name) => (name === m.home ? 'home' : name === m.away ? 'away' : null);
  const ou = (x) => (/^over/i.test(x) ? 'over' : /^under/i.test(x) ? 'under' : null);
  const s = { main: k === 'game' };
  if (k === 'game') { // bet365 junta vencedor, handicap e total no mesmo grupo
    k = q.line === 'To Win' ? 'ml' : q.line === 'Line' ? 'spread' : q.line === 'Total' ? 'total' : null;
    if (!k) return null;
  }
  s.k = k;
  if (k === 'ml') s.pick = who(q.side && q.line === 'Match' ? q.side : q.label || q.side) || who(q.side);
  else if (k === 'mlr') { if (q.line !== 'To Win') return null; s.pick = q.side === 'Tie' ? 'draw' : who(q.side); }
  else if (k === 'dcr') s.pick = { '1X': 'hd', 12: 'ha', X2: 'da', '2X': 'da' }[q.n2];
  else if (k === 'set1') s.pick = who(q.label);
  else if (k === 'total' || k === 'gtotal') { s.pick = ou(q.side); s.line = num(q.handicap ?? q.line); }
  else if (k === 'spread' || k === 'gspread') { s.pick = who(q.side); s.line = num(q.handicap ?? q.line ?? q.label); }
  else if (k === 'sspread') { // "Mia Pohankova -1.5" (sem campo "side")
    const name = String(q.label || '').replace(/\s*[+-]?\d+(\.\d+)?\s*$/, '').trim();
    s.pick = who(name); s.line = num(q.handicap ?? q.line);
  } else if (k === 'sets') { // "2-1" com o lado = vencedor
    const p = parseScore(q.line);
    if (!p) return null;
    s.pick = q.side === m.away ? `${p[1]}-${p[0]}` : q.side === m.home ? `${p[0]}-${p[1]}` : null;
  } else if (k === 'tsets') s.pick = (/^(\d) Sets?$/i.exec(String(q.label || '').trim()) || [])[1] || null;
  return s;
}

/* e-Sports: mercados que se decidem pelo placar em mapas (e, no CS2/Valorant, pelo vencedor de cada mapa).
   O resto (rondas, abates, jogadores...) entra como mercado da equipa. */
function esportsQuote(q, m) {
  const who = (name) => (name === m.home ? 'home' : name === m.away ? 'away' : null);
  const g = String(q.group_name ?? '').trim();
  let x;
  if (g === 'Match Lines' && q.line === 'To Win') return { k: 'ml', pick: who(q.side) };
  if (/^Correct Map Score( \(\d\))?$/.test(g)) { const p = parseScore(q.line); const w = who(q.side); return p && w ? { k: 'ecs', pick: w === 'home' ? `${p[0]}-${p[1]}` : `${p[1]}-${p[0]}` } : null; }
  if (g === 'Alternative Match Handicap') return { k: 'emh', pick: who(q.side), line: num(q.handicap ?? q.line ?? q.label) };
  if (g === 'To Win at Least 1 Map') { const w = who(q.line), y = /^yes$/i.test(q.side) ? 'yes' : /^no$/i.test(q.side) ? 'no' : null; return w && y ? { k: 'e1m', per: w, pick: y } : null; }
  if ((x = /^Map (\d+) Winner$/.exec(g))) return { k: 'emw', per: x[1], pick: who(q.label) };
  if ((x = /^Map (\d+) - Lines$/.exec(g)) && q.line === 'To Win') return { k: 'emw', per: x[1], pick: who(q.side) };
  return null;
}

/* MMA (UFC): só mercados que se liquidam sozinhos com o resultado da luta (vencedor, método, round e tempo).
   Fica de fora o "Spread" das Fight Lines (não se sabe ao certo o que conta) e tudo o que a regra não conheça. */
function fightQuote(q, m) {
  const who = (name) => (name === m.home ? 'home' : name === m.away ? 'away' : null);
  const g = String(q.group_name ?? '').trim(), line = String(q.line ?? '').trim();
  let x;
  if ((g === 'Game' || g === 'Fight Lines') && line === 'To Win') return { k: 'ml', pick: who(q.side) };
  if ((g === 'Fight Lines' && line === 'Total') || g === 'Total Rounds') {
    const n = num(q.handicap ?? (g === 'Total Rounds' ? q.line : q.label));
    // linhas de meio round (1.5, 2.5): uma linha inteira podia acabar "exatamente" nela
    return Math.abs(n % 1) === 0.5 ? { k: 'total', pick: /^over$/i.test(q.side) ? 'over' : /^under$/i.test(q.side) ? 'under' : null, line: n } : null;
  }
  if (g === 'Method of Victory') {
    if (!q.side && /^draw/i.test(line)) return { k: 'fmov', pick: 'draw' };
    const w = who(q.side);
    const how = /^by decision or technical decision$/i.test(line) ? 'dec' : /^by ko, tko or dq$/i.test(line) ? 'kodq' : /^by submission$/i.test(line) ? 'sub' : null;
    return w && how ? { k: 'fmov', pick: `${w}:${how}` } : null;
  }
  if (g === 'Round Betting') {
    if (!q.side && /^draw/i.test(line)) return { k: 'fround', pick: 'draw' };
    const w = who(q.side);
    if (!w) return null;
    if (/^decision( or technical decision)?$/i.test(line)) return { k: 'fround', pick: `${w}:dec` };
    return (x = /^Rd (\d)$/.exec(line)) ? { k: 'fround', pick: `${w}:r${x[1]}` } : null;
  }
  if (g === 'Fight to Go the Distance') { const y = String(q.label ?? '').trim(); return /^yes$/i.test(y) ? { k: 'fdist', pick: 'yes' } : /^no$/i.test(y) ? { k: 'fdist', pick: 'no' } : null; }
  return null;
}

/* MMA: odds que dariam lucro garantido cruzando mercados. Todas as formas de um lutador ganhar (método de vitória, ou
   round da vitória) equivalem a "ele ganha": com o vencedor do outro lado, as probabilidades têm de somar mais de 100%
   (o empate fica de fora dos dois). Se não, esse mercado sai do site até a fonte corrigir. */
function guardFight(byK) {
  const ml = byK.get('ml');
  if (!ml || ml.sels.length !== 2) return;
  for (const k of ['fmov', 'fround']) {
    const mk = byK.get(k);
    if (!mk) continue;
    for (const side of ['home', 'away']) {
      const ways = mk.sels.filter((x) => x.pick.startsWith(side + ':'));
      const other = ml.sels.find((x) => x.pick !== side);
      // só se o mercado tiver todas as formas desse lutador (método: 3; round: os rounds + decisão)
      const full = k === 'fmov' ? ways.length === 3 : ways.some((x) => x.pick.endsWith(':dec')) && ways.length >= 4;
      if (other && full && ways.reduce((p, x) => p + 1 / x.odds, 0) + 1 / other.odds < 1) for (const x of mk.sels) x.guard = true;
    }
  }
}

// futebol: os mercados da equipa (todos os grupos) vêm num pedido completo mais espaçado; guardam-se entre pedidos
const soccerExtras = new Map(); // id do jogo → { markets, at }
const EXTRA_PRE_MS = 15 * 60000, EXTRA_LIVE_MS = 60000; // depois disto: antes do jogo saem, ao vivo ficam bloqueados

// um jogo da MoviOdds → evento do site (full = a resposta trazia todos os grupos de mercados)
function toEvent(m0, serverNow, sport, full = true) {
  let lg = sport === 'soccer' ? soccerLeague(m0.league, m0.region) : leagueOf(sport, m0.league);
  if (!lg || !m0.home || !m0.away) return null;
  const { quotes, ...meta } = m0;
  const prev = lastMeta.get(String(m0.id));
  // cotações do pedido normal ficam guardadas (um pedido leve, sem cotações, não as apaga)
  lastMeta.set(String(m0.id), { m: meta, sport, quotes: quotes?.length || !prev ? quotes || [] : prev.quotes });
  // com fotografia pelo WebSocket (ao vivo e jogos a começar): odds (todos os grupos) e frescura vêm daí
  const w = WS.get(m0.id);
  const st = m0.in_play ? WS.stats(m0.id) || m0.stats || null : null; // estatísticas ao vivo (WebSocket, ou o pedido com stats=1)
  if (m0.in_play && m0.stats && !WS.stats(m0.id)) WS.restStats(m0.id, m0.stats); // ténis ponto a ponto (com o WebSocket em baixo)
  const sc = st ? scoreFromStats(sport, st) : null;
  let m = sc ? { ...m0, score: sc } : m0;
  if (w) {
    m = { ...m, quotes: [...w.quotes.values()], group_status: w.status, polled_at: w.polledAt || m0.polled_at, stale: w.stale || false };
    full = true;
  }
  if (BY_TOURNAMENT[sport]) lg = tournament(lg, m.league, sport);
  const live = !!m.in_play;
  if (sport === 'soccer') {
    if (full && !live && m.quotes?.length) {
      fullQuotes.set(String(m0.id), { quotes: m.quotes, at: Date.now() });
      if (fullQuotes.size > 3000) for (const [k, v] of fullQuotes) if (Date.now() - v.at > EXTRA_PRE_MS) fullQuotes.delete(k);
    } else if (live) fullQuotes.delete(String(m0.id));
  }
  const kick = Date.parse(m.kickoff_utc);
  const xs = live ? STATS.build(sport, st, m) : null; // estatísticas no formato da página do jogo
  let score = null, clock;
  if (live && sport === 'mma') clock = 'Luta a decorrer'; // sem placar: a fonte não dá nada durante a luta
  else if (live && sport === 'tabletennis') { // "11-7,13-11,7-11": sets acabados no placar, o set a meio no relógio
    const gs = String(m.score || '').split(',').map((x) => parseScore(x)).filter(Boolean);
    const fin = gs.filter(TT.okGame), cur = gs.length && !TT.okGame(gs[gs.length - 1]) ? gs[gs.length - 1] : null;
    score = [fin.filter(([x, y]) => x > y).length, fin.filter(([x, y]) => y > x).length];
    clock = cur ? `${gs.length}º set · ${cur[0]}-${cur[1]}` : 'Ao vivo';
  }
  else if (live) {
    if (sport === 'tennis') { const t = tennisLive(m.score); score = [t.h, t.a]; clock = t.clock; }
    else {
      score = parseScore(m.score) || parseScore(String(m.score || '').split(',').pop()) || [0, 0];
      clock = sport === 'esports' ? xs?.clock || 'Ao vivo' : clockLabel(m.clock, serverNow, sport);
      if (xs?.clock && (sport === 'basketball' || sport === 'hockey')) clock = /^\d/.test(clock) ? `${xs.clock} · ${clock}` : xs.clock;
    }
  }
  // saúde da fonte (mensagem "feed" do WebSocket): ao vivo degradado/parado → odds por confirmar (bloqueadas)
  const hl = WS.health(SRC_SPORT[sport]);
  const feedBad = !!hl && (live ? hl.live !== 'ok' : hl.pre === 'down');
  const staleAll = !!m.stale || feedBad || (live && m.polled_at && serverNow - Date.parse(m.polled_at) > STALE_LIVE_MS);
  const gs = m.group_status || {};
  const byK = new Map();
  const mainSel = new WeakSet(), conflict = new Set(); // seleções do mercado principal · com duas odds diferentes na fonte
  const prioOf = new WeakMap(); // prioridade do grupo de onde veio a seleção (totais do futebol)
  const specific = (q) => (sport === 'soccer' ? soccerQuote(q, m) : sport === 'tennis' ? TEN.quote(q, m) : sport === 'esports' ? esportsQuote(q, m) : sport === 'mma' ? fightQuote(q, m) : sport === 'tabletennis' ? TT.quote(q, m) : namedQuote(q, m, sport));
  const ctx = `${sport}|${m.home}|${m.away}|${m.league}|${live ? 1 : 0}`;
  // MMA: apostas só antes do início (a fonte não dá nada durante a luta); tênis de mesa ao vivo: feeds/tabletennis.js
  for (const q of live && sport === 'mma' ? [] : m.quotes || []) {
    // a leitura de cada cotação só depende dela e das equipas/liga: fica guardada enquanto a cotação não mudar
    // (pelo WebSocket, uma cotação que não mudou é o mesmo objeto de uma reconstrução para a outra)
    let c = quoteCache.get(q);
    if (!c || c.ctx !== ctx) {
      let s = specific(q);
      // sem regra automática (ou cotação que a regra não aceitou): mercado da equipa
      // ténis: só mercados com liquidação automática — o resto (próxima quebra, handicaps ao vivo, dados incompletos) não se oferece
      // MMA: também só mercados automáticos (o resultado de uma luta não tem mais nada para a equipa decidir)
      if (!s || !s.pick || ('line' in s && !isFinite(s.line))) s = (sport === 'soccer' && SOCCER_GROUPS[q.group_id]) || sport === 'tennis' || sport === 'mma' || sport === 'tabletennis' ? null : GEN.quote(q, m, sport);
      if (!s || !s.pick || ('line' in s && !isFinite(s.line))) s = null;
      c = { ctx, s };
      quoteCache.set(q, c);
    }
    const s = c.s;
    if (!s) continue;
    // jogadores: só abre se a fonte traz essa estatística nesta liga (ou, sem histórico, se o jogo ao vivo já traz jogadores)
    // ao vivo numa liga sem cobertura: só se os jogadores ao vivo trazem titular/entrou (senão não se sabe quem jogou)
    if (s.k === 'bp' && !BP.LEAGUES.has(lg.key)) continue; // basquete: só ligas com box score garantido
    if (s.k === 'hgs' && !HG.LEAGUES.has(lg.key)) continue; // hóquei: marcadores só na NHL (a ESPN diz quem jogou)
    if (s.k === 'pp' && !PLAYERS.covered(lg.key, s.per.split('|')[0]) && !(live && PLAYERS.hasLineup(WS.stats(m.id)?.players || []))) continue;
    // escanteios, cartões e 1º/2º tempo: só abre se a fonte costuma trazer esse dado nesta liga (ou o jogo ao vivo já o traz)
    if (sport === 'soccer' && s.k !== 'pp') {
      const need = statNeed(s);
      if (need && !PLAYERS.coveredTeam(lg.key, need) && !(live && liveHas(WS.stats(m.id) || m.stats, need))) continue;
    }
    const odds = round2(Number(q.odds_dec));
    if (!(odds >= 1.01)) continue;
    // mercado sem confirmação recente: antes do jogo sai do site; ao vivo fica bloqueado (quem o tem no boletim vê o cadeado)
    const stale = staleAll || !!gs[q.group_id]?.stale;
    if (stale && !live) continue;
    const sel = { pick: s.pick, odds, lock: !!(q.suspended || stale) };
    Object.defineProperty(sel, 'q', { value: q }); // cotação de origem (Criar aposta); fora do JSON
    // futebol antes do jogo: seleção que entra no Criar aposta (aba própria na página do jogo)
    if (sport === 'soccer' && !live) { try { const l = BB.legOf(m, q); if (l && l.fam !== 'combo') sel.bb = 1; } catch { /* cotação fora do formato */ } }
    // ao vivo: os mercados que o motor ao vivo sabe traduzir (o motor ainda decide, com o estado do jogo, se entra)
    else if (sport === 'soccer' && live && BB.liveQ({ home: m.home, away: m.away, live: {} }, q)) sel.bb = 1;
    // basquete (antes e ao vivo; a NCAA joga em 2 tempos: só antes do jogo): pela forma da seleção
    else if (sport === 'basketball' && !(live && lg.key === 'ncaab') && BK.supports({ market: s.k, per: s.per, pick: s.pick, line: s.line })) sel.bb = 1;
    if (s.line != null) sel.line = s.line;
    if (s.base) sel.base = s.base;
    // um mercado por tipo e por parte do jogo (ex.: "vencedor do game" do 1º set game 9 ≠ game 10)
    const mkKey = s.per != null ? `${s.k}|${s.per}` : s.k;
    if (!byK.has(mkKey)) byK.set(mkKey, s.per != null ? { k: s.k, per: String(s.per), sels: [] } : { k: s.k, sels: [] });
    const mk = byK.get(mkKey);
    if (s.mname != null) { mk.name = s.mname; mk.cat = s.cat; sel.name = s.name; } // mercados da equipa e por parte do jogo
    // a mesma seleção pode vir em dois grupos (principal e alternativas): fica a principal. Duas cotações com odds
    // diferentes para a mesma seleção sem nenhuma ser a principal (ex.: 'Draw - X' a 21 e 'Tie - X' a 34): não se sabe
    // qual está certa → a seleção sai do site
    const dup = mk.sels.findIndex((x) => x.pick === sel.pick && x.line === sel.line && String(x.base) === String(sel.base));
    if (dup >= 0) {
      const old = mk.sels[dup];
      if (s.main && !mainSel.has(old)) { mk.sels[dup] = sel; mainSel.add(sel); }
      else if (!mainSel.has(old) && !s.main && (s.prio || 0) !== (prioOf.get(old) || 0)) { if ((s.prio || 0) > (prioOf.get(old) || 0)) { conflict.delete(old); mk.sels[dup] = sel; prioOf.set(sel, s.prio || 0); } }
      else if (!(mainSel.has(old) && !s.main) && Math.abs(old.odds - sel.odds) > 0.001) conflict.add(old);
      continue;
    }
    prioOf.set(sel, s.prio || 0);
    if (s.main) mainSel.add(sel);
    if (s.main && sel.line != null && mk.main == null) mk.main = s.k === 'spread' ? Math.abs(sel.line) : sel.line;
    mk.sels.push(sel);
  }
  if (conflict.size) for (const [key, mk] of byK) {
    const out = mk.sels.filter((x) => conflict.has(x));
    if (!out.length) continue;
    guardRemoved.push(`${new Date(serverNow).toISOString()} [duas odds na fonte] ${m.home} x ${m.away} ${mk.k}${mk.per ? ' ' + mk.per : ''}: ${out.map((x) => `${x.pick}${x.line != null ? '(' + x.line + ')' : ''}`).join(' ')}`);
    mk.sels = mk.sels.filter((x) => !conflict.has(x));
    if (!mk.sels.length) byK.delete(key);
  }
  // jogadores: a bet365 repete grupos (ao vivo, "Goalscorers" e "Player Assists" vêm duas vezes com as mesmas cotações):
  // cada jogador/estatística/N aparece uma vez só, na lista maior (os "Marca" de "Marca ou assiste" já estão nos Marcadores)
  { const seen = new Set();
    for (const [key, mk] of [...byK].filter(([, x]) => x.k === 'pp').sort((a, b) => b[1].sels.length - a[1].sels.length)) {
      const stat = mk.per.split('|')[0];
      mk.sels = mk.sels.filter((x) => { const id = `${stat}|${x.pick}`; if (seen.has(id)) return false; seen.add(id); return true; });
      if (!mk.sels.length) byK.delete(key);
    } }
  for (const [k, n] of Object.entries(NEED[sport] || {})) if (byK.get(k) && byK.get(k).sels.length !== n) byK.delete(k);
  // mercados com uma seleção só (a outra caiu por odd 1.00) não fazem sentido: saem, exceto os de "N ou mais" (aces...)
  if (sport === 'tennis') for (const [key, mk] of byK) if (mk.sels.length < 2 && !['tace', 'tdf'].includes(mk.k)) byK.delete(key);
  // proteção das odds: impossíveis (lucro garantido) em todas as modalidades; ténis e futebol também cruzam mercados
  // irmãos (feeds/tennis.js guardTennis, feeds/guard-soccer.js). As marcadas saem do site e voltam quando a fonte corrigir.
  {
    if (sport === 'tennis') TEN.guardTennis(byK, !!live);
    else { TEN.guardOverround(byK); if (sport === 'soccer') GUARD_SOCCER.guardSoccer(byK); if (sport === 'mma') guardFight(byK); }
    for (const [key, mk] of byK) {
      const out = mk.sels.filter((x) => x.guard);
      if (!out.length) continue;
      guardRemoved.push(`${new Date(serverNow).toISOString()} [${live ? 'ao vivo' : 'pré'}] ${m.home} x ${m.away} ${mk.k}${mk.per ? ' ' + mk.per : ''}: ${out.map((x) => `${x.pick}${x.line != null ? '(' + x.line + ')' : ''}@${x.odds}`).join(' ')}`);
      if (guardRemoved.length > 300) guardRemoved.splice(0, guardRemoved.length - 300);
      mk.sels = mk.sels.filter((x) => !x.guard);
      if ((mk.sels.length < 2 && !['tace', 'tdf', 'pp', 'bp', 'hgs', 'x'].includes(mk.k)) || (mk.k === 'ml' && sport === 'soccer' && mk.sels.length !== 3)) byK.delete(key);
    }
  }
  const markets = sport === 'tennis' ? [...byK.values()].filter((mk) => mk.k !== 'x' && !M.SOURCE_KINDS.has(mk.k)).sort(TEN.marketSort)
    : [...MARKET_ORDER, 'ecs', 'emh', 'e1m', 'emw'].flatMap((k) => [...byK.values()].filter((mk) => mk.k === k));
  // mercados da equipa, por secção (no futebol vêm do último pedido completo)
  let extras = [...byK.values()].filter((mk) => mk.k === 'x' || M.SOURCE_KINDS.has(mk.k));
  if (sport === 'soccer') {
    if (full) soccerExtras.set(String(m.id), { markets: extras, at: serverNow });
    else {
      const c = soccerExtras.get(String(m.id));
      const age = c ? serverNow - c.at : Infinity;
      extras = !c || (!live && age > EXTRA_PRE_MS) ? [] : age > EXTRA_LIVE_MS && live ? c.markets.map((mk) => ({ ...mk, sels: mk.sels.map((s) => ({ ...s, lock: true })) })) : c.markets;
    }
  }
  markets.push(...extras);
  const team = (name, id, sc, form) => ({ id, name, short: name, logo: '', score: sc, form: form || '' });
  const ev = {
    id: String(m.id), league: lg.key, leagueName: lg.name, country: lg.country, sport,
    date: new Date(kick), state: live ? 'in' : 'pre', completed: false, statusName: '', clock,
    ...(live && sport === 'soccer' ? soccerClock(m.clock, serverNow) : null),
    home: team(m.home, 'h', score ? score[0] : null, xs?.form?.home), away: team(m.away, 'a', score ? score[1] : null, xs?.form?.away), details: xs?.details || [],
    venue: '',
    markets: markets.length ? markets : null,
    // antes do jogo: as apostas fecham no início (reabrem quando o jogo aparecer ao vivo)
    ...(live ? {} : { closesAt: kick }),
  };
  if (xs) {
    // ténis: pontos do game e quem serve (aparecem na lista); o resto só na página do jogo
    if (xs.point) ev.point = xs.point;
    if (xs.serve) ev.serve = xs.serve;
    if (xs.rows.length || xs.periods || xs.players) ev.stats = { rows: xs.rows, ...(xs.periods ? { periods: xs.periods } : {}), ...(xs.players ? { players: xs.players } : {}) };
  }
  return ev;
}
const quoteCache = new WeakMap(); // cotação → leitura (k, pick, linha...)

/* Converte os jogos aos bocados: a lista completa do futebol tem ~1200 jogos e ~275 mil cotações e, de uma vez,
   deixava o servidor parado 2-4 s (ninguém era atendido). A cada ~15 ms dá a vez aos outros pedidos. */
const YIELD_MS = 15;
async function parseList(d, sport, full) {
  const serverNow = Date.parse(d.server_time || d.generated_at) || Date.now();
  const out = [];
  let t = Date.now();
  for (const m of d.matches || []) {
    const ev = toEvent(m, serverNow, sport, full);
    if (ev) out.push(ev);
    if (Date.now() - t > YIELD_MS) { await new Promise((r) => setImmediate(r)); t = Date.now(); }
  }
  return out;
}
/* Futebol: o pedido com todos os grupos de mercados tem ~118 MB (todas as ligas do mundo), por isso só se faz
   a cada 5 min (antes do jogo) e a cada 20 s (ao vivo); entre esses, vão só os mercados principais. */
const SOCCER_FULL = { pre: 5 * 60000, live: 20000 };
const lastSoccerFull = { pre: 0, live: 0 };
function qs(sport, live) {
  let q = `/odds?sport=${SRC_SPORT[sport]}${live ? '&in_play=1' : ''}`;
  let full = true;
  if (sport === 'soccer') {
    const k = live ? 'live' : 'pre';
    // ao vivo com o WebSocket ligado: os mercados todos já chegam por lá (não é preciso o pedido pesado)
    full = !(live && WS.isOpen()) && Date.now() - lastSoccerFull[k] >= SOCCER_FULL[k];
    if (full) lastSoccerFull[k] = Date.now();
    else q += `&groups=${live ? SOCCER_LIVE : `${SOCCER_PRE},${SOCCER_LIVE}`}`;
  }
  return { q, full };
}

/* Todas as modalidades (cada uma num pedido). Devolve os jogos e as modalidades que responderam:
   uma modalidade que falhou não conta para "o jogo saiu da lista". */
const livePolls = { light: 0, heavy: 0 }; // pedidos ao vivo leves (só placar) e completos, para o painel de estado
async function fetchSport(s, live) {
  /* Ao vivo com o WebSocket ligado: as odds chegam por lá. O pedido traz só placar, relógio e a lista de jogos
     (groups=0 → nenhuma cotação; ~50x mais leve). Se algum jogo com mercados ainda não tiver fotografia pelo
     WebSocket (acabou de começar), faz-se o pedido normal desta modalidade. */
  if (live && WS.isOpen()) {
    const d = await getOdds(`/odds?sport=${SRC_SPORT[s]}&in_play=1&groups=0`);
    const missing = (d.matches || []).some((m) => m.market_count > 0 && !WS.get(m.id) && m.home && m.away && leagueOf(s, m.league));
    if (!missing) { livePolls.light++; return parseList(d, s, false); }
  }
  if (live) livePolls.heavy++;
  const { q, full } = qs(s, live);
  try { return await parseList(await getOdds(q), s, full); } catch (e) {
    if (!(s === 'soccer' && full)) throw e;
    // o pedido completo do futebol (~118 MB) falhou: tenta de novo no ciclo seguinte e, já agora, vai buscar os
    // mercados principais (pedido pequeno) para o futebol não desaparecer do site entretanto
    lastSoccerFull[live ? 'live' : 'pre'] = 0;
    console.warn(`[MoviOdds] futebol completo falhou (${e.message}): a usar só os mercados principais`);
    return parseList(await getOdds(`${q}&groups=${live ? SOCCER_LIVE : `${SOCCER_PRE},${SOCCER_LIVE}`}`), s, false);
  }
}
async function fetchSports(live, only = null) {
  const list = only ? SPORTS.filter((s) => only.includes(s)) : SPORTS;
  const res = await Promise.allSettled(list.map((s) => fetchSport(s, live)));
  const events = [], ok = new Set(), errors = [];
  res.forEach((r, i) => { if (r.status === 'fulfilled') { events.push(...r.value); ok.add(list[i]); } else errors.push(`${list[i]}: ${r.reason.message}`); });
  return { events, ok, errors };
}
const fetchAll = () => fetchSports(false);
const fetchLive = (only) => fetchSports(true, only); // only = só estas modalidades (ex.: confirmar uma aposta)

/* Resultado de um jogo terminado. Devolve null (ainda sem resultado), { done: false, note } (parou antes do fim,
   desistência, placar por confirmar: fica para a equipa) ou { done: true, h, a, ... } (ver "R" no markets.js). */
const NOPE = (note) => ({ done: false, note });
function tennisResult(r) {
  const sets = String(r.final_score || '').split(',').map(parseScore);
  if (!sets.length || sets.some((s) => !s)) return NOPE('placar ilegível');
  const h = sets.filter(([x, y]) => x > y).length, a = sets.filter(([x, y]) => y > x).length;
  // cada set tem de estar terminado (6-4, 7-5, 7-6, 6-x com 2 de vantagem; "1-0" = super tie-break) e alguém ganhou a maioria
  const okSet = ([x, y]) => { const hi = Math.max(x, y), lo = Math.min(x, y); return (hi === 1 && lo === 0) || (hi === 6 && lo <= 4) || (hi === 7 && (lo === 5 || lo === 6)) || (hi > 7 && hi - lo === 2); };
  // sets para ganhar: melhor de 5 (Grand Slam masculino) = 3; senão 2. Uma desistência entre sets (2-1 num melhor de 5)
  // tem todos os sets completos — só o formato a distingue de uma partida acabada
  const need = r.stats?.format === 'best_of_5' ? 3 : 2;
  if (!sets.every(okSet) || h === a || Math.max(h, a) !== need) return NOPE('partida não terminou normalmente (desistência?)');
  // histórico game a game, aces e duplas faltas (para os mercados de games e de saque); null se não bater certo
  return { done: true, h, a, sets, ...TEN.extras(r, sets) };
}
/* Partida parada antes do fim (desistência): a fonte dá status "unknown", o placar no momento e o histórico dos games
   jogados. Vale só se: não há aviso de falha da fonte (aí o jogo pode ter acabado normalmente — fica para a equipa),
   os sets acabados têm placar final, ninguém tinha ganho a partida e o histórico game a game bate certo com o placar.
   Liquidação: o que ficou decidido pelo que se jogou é pago ou perdido; o resto é devolvido (markets.js tennisRetired). */
function tennisRetired(r) {
  if (/not seen live|service was down|not a confirmed final/i.test(String(r.note || ''))) return null;
  const sets = String(r.final_score || '').split(',').map(parseScore);
  if (!sets.length || sets.some((s) => !s)) return null;
  const need = r.stats?.format === 'best_of_5' ? 3 : 2;
  // "1-0" só é placar final no set decisivo (super tie-break); no 1º set é um game jogado
  const okSet = ([x, y], i) => { const hi = Math.max(x, y), lo = Math.min(x, y); return (hi === 1 && lo === 0 && i === 2 * need - 2) || (hi === 6 && lo <= 4) || (hi === 7 && (lo === 5 || lo === 6)) || (hi > 7 && hi - lo === 2); };
  const done = sets.filter((x, i) => i < sets.length - 1 || okSet(x, i));
  if (done.length < sets.length - 1) return null;
  const h = done.filter(([x, y]) => x > y).length, a = done.length - h;
  if (Math.max(h, a) >= need) return null; // alguém já tinha ganho: não é desistência, fica para a equipa
  const ex = TEN.extras(r, sets);
  if (!ex.log) return null; // sem histórico coerente não se sabe o que se jogou
  return { done: true, retired: true, need, h, a, sets, ...ex };
}
async function fetchResult(id, sport = 'soccer', ev = null) {
  // stats=1: estatísticas do fim do jogo (ténis: histórico de games; outros: parciais certos, escanteios)
  const d = await get(`/results?sport=${SRC_SPORT[sport] || sport}&fi=${encodeURIComponent(id)}${sport === 'mma' ? '' : '&stats=1'}`);
  const r = (d.results || []).find((x) => String(x.fixture_id) === String(id));
  // MMA: a MoviOdds primeiro, a ESPN de reserva (feeds/fights.js); sem a luta do site (nomes e data) não se procura
  // tênis de mesa: o placar de cada set; sem registo nenhum 12 h depois do início → não se jogou (devolvida)
  if (sport === 'tabletennis') {
    const at = ev ? +new Date(ev.date) : NaN;
    if (!r) return Number.isFinite(at) && Date.now() - at > 12 * 3600000 ? { done: true, h: 0, a: 0, sets: [], tt: true, cancelled: true, finishedAt: null, note: 'sem registo na MoviOdds 12 h depois: não se jogou' } : null;
    const t = TT.result(r, Number.isFinite(at) ? at : Date.parse(r.finished_at) || Date.now());
    return t.done ? { ...t, finishedAt: Date.parse(r.finished_at) || null, note: r.note || (t.incomplete ? 'partida não terminada: vale o que se jogou' : null) } : t;
  }
  if (sport === 'mma') { if (!ev) return null; const f = await FIGHTS.result(r, ev); return f && f.done ? { ...f, finishedAt: Date.parse(r?.finished_at) || null, note: r?.note || null } : f; }
  const out = r ? parseResult(r, sport) : null;
  if (sport === 'basketball' && out?.done && !out.bp) return basketBox(out, id, ev);
  if (sport === 'hockey' && out?.done && ev && HG.LEAGUES.has(ev.league)) return hockeyGoals(out, ev);
  return out;
}
/* Basquete: o box score oficial (ESPN, NBA/WNBA) para os mercados de jogadores. O da MoviOdds só serve para o
   acompanhamento ao vivo: mesmo quando os pontos somam o placar, falha rebotes/assistências (27/10: Antetokounmpo 15
   rebotes na MoviOdds, 14 no oficial). Sem a ESPN, espera até 30 min depois do fim; a seguir paga o resto e os
   jogadores ficam para a equipa. */
async function basketBox(out, id, ev) {
  if (!ev || !BP.LEAGUES.has(ev.league)) return out;
  const fin = [out.h, out.a];
  let espn = null;
  try { espn = await ESPN.basketBox(ev, fin, M.bpKey); } catch (e) { console.error(`[Box score] ${ev.home?.name} x ${ev.away?.name}: ${e.message}`); }
  if (espn) return { ...out, bp: slimBox(espn) };
  return Date.now() - (out.finishedAt || +new Date(ev.date) + 3 * 3600000) < 30 * 60000 ? null : out;
}
/* Hóquei (NHL): marcadores da ESPN. Sem eles, espera até 30 min depois do fim; a seguir paga o resto e os
   marcadores ficam para a equipa. */
async function hockeyGoals(out, ev) {
  const goals = [out.h, out.a];
  if (out.so && out.h !== out.a) goals[out.h > out.a ? 0 : 1]--; // o gol decisivo dos pênaltis não é de ninguém
  let hg = null;
  try { hg = await ESPN.hockeyGoals(ev, goals, M.bpKey); } catch (e) { console.error(`[Marcadores] ${ev.home?.name} x ${ev.away?.name}: ${e.message}`); }
  if (hg) return { ...out, hg };
  return Date.now() - (out.finishedAt || +new Date(ev.date) + 3 * 3600000) < 30 * 60000 ? null : out;
}
const slimBox = (list) => list.map(({ key, side, played, pts, reb, ast, tpm, stl, blk }) => ({ key, side, played, pts, reb, ast, tpm, stl, blk }));
// lê um resultado já descarregado (também usado pelos testes: scripts/testar-mercados.js)
function parseResult(r, sport) {
  const extra = { finishedAt: Date.parse(r.finished_at) || null, note: r.note || null };
  if (sport === 'tennis' && r.status === 'unknown') { const t = tennisRetired(r); if (t) return { ...t, ...extra }; } // desistência
  if (r.status !== 'finished') return NOPE(r.note || r.status || 'sem resultado final');
  if (sport === 'tennis') { const t = tennisResult(r); return t.done ? { ...t, ...extra } : t; }
  const per = (re) => (r.periods || []).filter((p) => re.test(p.name)).map((p) => parseScore(p.score));
  const sum = (list) => (list.length && list.every(Boolean) ? list.reduce((s, x) => [s[0] + x[0], s[1] + x[1]], [0, 0]) : null);
  const fin = parseScore(r.final_score);
  if (sport === 'soccer') {
    // vale o tempo regulamentar (1º + 2º tempo, sem prorrogação nem pênaltis)
    /* Placar dos 90 minutos: a linha "Score After Full Time - X-Y" da cronologia manda. Os "periods" põem os gols do
       prolongamento no 2º tempo (Recreativo Huelva x Rayo 27/10: 1-1 aos 90', periods davam 2-3). */
    const ftLine = (r.stats?.timeline || []).find((t) => /Score After Full Time/i.test(t.text || ''));
    const ft = ftLine ? parseScore(String(ftLine.text).split(' - ').pop()) : null;
    const sc = ft || (per(/^(1st|2nd) Half$/).length === 2 ? sum(per(/^(1st|2nd) Half$/)) : fin);
    if (!sc) return NOPE('placar ilegível');
    const lg = leagueOf('soccer', r.league) || soccerDyn(r.league, r.region);
    // estatísticas por jogador (mercados de jogadores) e sinais de prolongamento na cronologia
    const players = (PLAYERS.roster(r.stats) || []).map(({ key, side, played, goals, shots, shots_on_target, assists, fouls, fouls_drawn, tackles, saves, passes, yellow_cards, red_cards }) =>
      ({ key, side, played, goals, shots, shots_on_target, assists, fouls, fouls_drawn, tackles, saves, passes, yellow_cards, red_cards }));
    const tl = r.stats?.timeline || [];
    /* Houve prolongamento? Só por sinais fiáveis: a fonte diz (overtime / "extra time" / desempate por penáltis), há
       partes além dos dois tempos, ou o placar final não é a soma dos dois tempos. Um lance "95'" sem marca de
       descontos só conta nas taças: nos campeonatos a fonte às vezes escreve assim os descontos (Ceará x Goiás 28/10). */
    const cupLike = !!(lg && (KNOCKOUT.has(lg.key) || (lg.key.startsWith('fut.') && isCup(r.league))));
    const extraTime = !!r.overtime || tl.some((t) => /_et$/.test(t.type || '') || /extra time|penalty shoot-?out|penalties/i.test(t.text || ''))
      || (r.periods || []).some((p) => !/^(1st|2nd) Half$/.test(p.name))
      || (fin && (fin[0] !== sc[0] || fin[1] !== sc[1]))
      || (cupLike && tl.some((t) => t.minute > 90 && !t.stoppage));
    return {
      // escanteios e cartões: com prolongamento (ou eliminatória empatada aos 90') as estatísticas podem incluí-lo → equipa
      done: true, h: sc[0], a: sc[1], parts: PARTS.finishedParts('soccer', r.stats, sc, { overtime: extraTime || !!(lg && (KNOCKOUT.has(lg.key) || (lg.key.startsWith('fut.') && isCup(r.league))) && sc[0] === sc[1]) }),
      ...(players.length ? { players } : {}), ...(extraTime ? { extraTime } : {}),
      // empate aos 90' numa eliminatória: pode ter havido prolongamento → resultado da ESPN antes de liquidar jogadores
      ...(lg && (KNOCKOUT.has(lg.key) || (lg.key.startsWith('fut.') && isCup(r.league))) && sc[0] === sc[1] ? { needEt: true } : {}),
      ...extra,
    };
  }
  if (!fin) return NOPE('placar ilegível');
  if (sport === 'esports') {
    // placar em mapas ("2-1"); no CS2/Valorant vem também o placar de rondas de cada mapa (diz quem ganhou cada mapa)
    let maps = per(/^Map \d+$/).filter(Boolean);
    const won = maps.reduce((s, x) => [s[0] + (x[0] > x[1]), s[1] + (x[1] > x[0])], [0, 0]);
    if (!maps.length || maps.length !== fin[0] + fin[1] || won[0] !== fin[0] || won[1] !== fin[1]) maps = null;
    const parts = {};
    (maps || []).forEach((x, i) => { parts[`map${i + 1}`] = x; });
    return { done: true, h: fin[0], a: fin[1], maps, parts, ...extra };
  }
  if (sport === 'basketball') {
    // com prorrogação; o placar final tem de bater com a soma dos períodos
    const all = sum(per(/./));
    if (all && (all[0] !== fin[0] || all[1] !== fin[1])) return NOPE(`placar final ${fin.join('-')} não bate com os períodos ${all.join('-')}`);
    // quartos e tempos: das estatísticas (os "periods" do resultado dividem mal os quartos)
    return { done: true, h: fin[0], a: fin[1], parts: PARTS.finishedParts('basketball', r.stats, fin), ...extra };
  }
  if (sport === 'hockey') {
    const reg = sum(per(/^Period [123]$/));
    if (!reg) return NOPE('faltam os períodos');
    const so = (r.periods || []).some((p) => p.name === 'SO');
    // períodos: só se as estatísticas e o resultado disserem o mesmo
    const parts = PARTS.finishedParts('hockey', r.stats, fin);
    const rp = per(/^Period [123]$/);
    if (![1, 2, 3].every((i) => parts[`p${i}`] && rp[i - 1] && parts[`p${i}`].join() === rp[i - 1].join())) for (const k of ['p1', 'p2', 'p3']) delete parts[k];
    // nos pênaltis o gol decisivo não vem na fonte: o vencedor conta +1 gol, mas não se sabe qual
    // ordem dos gols (quem marca o 1º, o último, o N-ésimo): da cronologia, se estiver completa
    const gorder = HG.goalOrder(r, r.home, r.away, fin, so);
    const go = gorder ? { gorder, greg: reg[0] + reg[1] } : {};
    if (so && fin[0] === fin[1]) return { done: true, h: fin[0], a: fin[1], reg, parts, so: true, alts: [[fin[0] + 1, fin[1]], [fin[0], fin[1] + 1]], ...go, ...extra };
    return { done: true, h: fin[0], a: fin[1], reg, parts, ...(so ? { so: true } : {}), ...go, ...extra };
  }
  return NOPE('modalidade sem regras de liquidação');
}

// que dado da fonte o mercado precisa para ser liquidado sozinho (null = só o placar)
function statNeed(s) {
  const scope = String(s.per ?? '').split('|')[0];
  if (scope === 'corners') return 'corners';
  if (scope === 'cards') return 'cards';
  if (scope === 'h1' || scope === 'h2' || s.k === 'phtft') return 'ht';
  return null;
}
const liveHas = (st, need) => !!st && (need === 'corners' ? Number.isFinite(st.home?.corners) && Number.isFinite(st.away?.corners)
  : need === 'cards' ? !!PARTS.soccerCards(st) : Array.isArray(st.timeline));

/* Cobertura das estatísticas por jogador nas ligas do site (últimos dias de resultados): decide que mercados de
   jogadores abrem. Corre no arranque e a cada 12 h; até terminar, os mercados de jogadores ficam fechados. */
async function loadPlayerCoverage(days = 7) {
  let n = 0;
  const fresh = new Map();
  for (let i = 1; i <= days; i++) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    try {
      const d = await get(`/results?sport=soccer&date=${day}&stats=1`);
      for (const r of d.results || []) {
        const lg = r.status === 'finished' ? leagueOf('soccer', r.league) || soccerDyn(r.league, r.region) : null;
        if (lg) { PLAYERS.addCoverage(lg.key, r.stats, fresh); n++; }
      }
    } catch (e) { console.warn(`[Jogadores] resultados de ${day}: ${e.message}`); }
  }
  const withStats = [...fresh.values()].filter((c) => (c.team.corners?.ok || 0) > 0).length;
  if (!withStats) { // a fonte respondeu sem estatísticas (falha deles): fica a cobertura anterior e tenta daqui a 15 min
    console.warn(`[Cobertura] resultados sem estatísticas (${n} jogos): mantém a cobertura anterior e tenta de novo em 15 min`);
    setTimeout(() => loadPlayerCoverage(days).catch(() => {}), 15 * 60000).unref?.();
    return;
  }
  PLAYERS.coverage.clear();
  for (const [k, v] of fresh) PLAYERS.coverage.set(k, v);
  // a lista completa do futebol pode ter sido lida antes de haver cobertura (arranque): lê-a de novo no próximo ciclo
  lastSoccerFull.pre = 0; lastSoccerFull.live = 0;
  const keys = [...PLAYERS.coverage.keys()];
  const cnt = (f) => keys.filter(f).length;
  console.log(`[Cobertura] ${n} jogos recentes · jogadores em ${cnt((k) => PLAYERS.covered(k, 'shots'))} ligas · escanteios em ${cnt((k) => PLAYERS.coveredTeam(k, 'corners'))} · cartões em ${cnt((k) => PLAYERS.coveredTeam(k, 'cards'))} · 1º/2º tempo em ${cnt((k) => PLAYERS.coveredTeam(k, 'ht'))}`);
}

// evento atualizado a partir do WebSocket (com os dados do último pedido normal para equipas, liga e relógio)
function fromWs(id) {
  const meta = lastMeta.get(String(id));
  if (!meta || (!WS.get(id) && !WS.stats(id))) return null;
  // só estatísticas (sem odds pelo WebSocket): ficam as cotações do último pedido normal
  return toEvent({ ...meta.m, quotes: meta.quotes }, WS.now(), meta.sport, !!WS.get(id));
}

module.exports = {
  name: 'MoviOdds (bet365)', SPORTS, COUNTRY_PT, fetchAll, fetchLive, fetchResult, parseResult, clockLabel, toEvent, tennisResult, loadPlayerCoverage,
  // WebSocket: start(cb) liga e avisa os jogos que mudaram; want(ids) diz quais seguir; fromWs(id) dá o evento atualizado
  guardRemoved, liveStats: (id) => WS.stats(id),
  // Criar aposta: jogo de futebol antes do início com todos os grupos de mercados ({ home, away, quotes }) ou null
  // Criar aposta ao vivo: cotações da bet365 de agora (WebSocket, sem os grupos desatualizados) e estatísticas do jogo
  bbLive: (id) => {
    const meta = lastMeta.get(String(id)), w = WS.get(id), st = WS.stats(id) || meta?.m?.stats || null;
    if (!meta?.m?.in_play || !w || !st) return null;
    const quotes = [...w.quotes.values()].filter((q) => !w.status?.[q.group_id]?.stale);
    // minuto de agora: o relógio da fonte diz o minuto quando foi lido (ref) e se está a contar
    const c = meta.m.clock || {}, ref = Date.parse(c.ref);
    const run = c.ticking && ref ? Math.max(0, (WS.now() - ref) / 60000) : 0;
    const minute = Number(c.min) + run;
    // basquete: o relógio conta para trás (minutos que faltam no quarto)
    const left = Math.max(0, Number(c.min) + (Number(c.sec) || 0) / 60 - run);
    return { home: meta.m.home, away: meta.m.away, quotes, st, minute: Math.floor(minute), left: c.min == null ? null : left, ticking: !!c.ticking };
  },
  bbMatch: (id) => { const meta = lastMeta.get(String(id)), f = fullQuotes.get(String(id)); return meta && f && Date.now() - f.at < EXTRA_PRE_MS ? { home: meta.m.home, away: meta.m.away, quotes: f.quotes } : null; },
  // última leitura da bet365 pela MoviOdds para este jogo (ms, relógio da fonte), pelo WebSocket; null sem WebSocket
  // e a idade dessa leitura em ms, no relógio da fonte (o nosso pode estar adiantado ou atrasado)
  polledAt: (id) => { const p = WS.get(id)?.polledAt; return p ? Date.parse(p) || null : null; }, srcNow: () => WS.now(), // estatísticas ao vivo em bruto (histórico de games do ténis, mapas) — liquidação antecipada
  ws: { start: (cb, down) => WS.start(cb, down), want: (ids) => WS.want(ids), onStats: (fn) => WS.onStats(fn), info: () => ({ ...WS.info(), livePolls: { ...livePolls } }), isOpen: WS.isOpen }, fromWs,
};
