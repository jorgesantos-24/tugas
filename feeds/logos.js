'use strict';
/* Emblemas das equipas e bandeiras dos tenistas.
   1) ESPN (só para TESTE local — imagens não oficiais; desligar com ESPN_LOGOS=0 antes de produção)
   2) Reserva: TheSportsDB (https://www.thesportsdb.com, plano grátis).
   O plano grátis aceita poucos pedidos por minuto, por isso cada equipa é procurada uma só vez, em segundo plano
   (uma a cada 3 s; primeiro as dos jogos ao vivo e dos mais próximos), e o resultado fica guardado em data/logos.json.
   Só se aceita o emblema se a modalidade e o nome baterem certo; sem emblema, o site mostra as iniciais. */

const fs = require('node:fs');
const path = require('node:path');

const KEY = process.env.THESPORTSDB_KEY || '123'; // chave pública do plano grátis
const OFF = process.env.LOGOS === '0'; // LOGOS=0 desliga (o site mostra as iniciais)
const FILE = path.join(__dirname, '..', 'data', 'logos.json');
const STEP_MS = 3000, BACKOFF_MS = 90000, RETRY_MISS_MS = 7 * 86400000; // sem emblema: tenta de novo daqui a 7 dias
const SPORT_NAME = { soccer: 'Soccer', basketball: 'Basketball', hockey: 'Ice Hockey' }; // ténis: jogadores, sem emblema

// siglas da bet365 nas ligas americanas ("LA Lakers", "PHI Flyers") → cidade
const CITY = {
  ANA: 'Anaheim', ATL: 'Atlanta', BKN: 'Brooklyn', BOS: 'Boston', BUF: 'Buffalo', CAR: 'Carolina', CGY: 'Calgary', CHA: 'Charlotte',
  CHI: 'Chicago', CLB: 'Columbus', CLE: 'Cleveland', COL: 'Colorado', DAL: 'Dallas', DEN: 'Denver', DET: 'Detroit', EDM: 'Edmonton',
  FLA: 'Florida', GS: 'Golden State', HOU: 'Houston', IND: 'Indiana', LA: 'Los Angeles', MEM: 'Memphis', MIA: 'Miami', MIL: 'Milwaukee',
  MIN: 'Minnesota', MTB: 'Manitoba', MTL: 'Montreal', NJ: 'New Jersey', NO: 'New Orleans', NSH: 'Nashville', NY: 'New York', NYI: 'New York',
  NYR: 'New York', OKC: 'Oklahoma City', ORL: 'Orlando', OTT: 'Ottawa', PHI: 'Philadelphia', PHX: 'Phoenix', PIT: 'Pittsburgh',
  POR: 'Portland', SA: 'San Antonio', SAC: 'Sacramento', SEA: 'Seattle', SJ: 'San Jose', STL: 'St. Louis', TB: 'Tampa Bay',
  TOR: 'Toronto', UTA: 'Utah', VAN: 'Vancouver', VGK: 'Vegas', WAS: 'Washington', WPG: 'Winnipeg',
};
const expand = (name) => { const m = /^([A-Z]{2,3}) (.+)$/.exec(name); return m && CITY[m[1]] ? `${CITY[m[1]]} ${m[2]}` : name; };
// "Esporte Clube Bahia" ~ "Bahia": sem acentos, sem siglas de clube
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\b(fc|cf|sc|ac|afc|cd|ca|ec|se|club|clube|de|futebol|football|esporte|sport|calcio|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
function sameTeam(query, t) {
  const q = norm(query);
  if (!q) return false;
  const names = [t.strTeam, t.strTeamShort, ...String(t.strTeamAlternate || '').split(',')].map(norm).filter(Boolean);
  return names.some((n) => n === q || (q.length >= 4 && (n.includes(q) || q.includes(n))));
}

/* ---------- ESPN (só para TESTE: imagens não oficiais; ver ESPN_LOGOS) ----------
   Ao arrancar descarrega as listas de equipas das ligas (um pedido por liga, com emblemas) e os jogadores dos
   torneios ATP/WTA da semana (com a bandeira do país). Procura primeiro dentro da liga do jogo, para não
   trocar equipas com nomes parecidos ("Inter" ≠ "Inter Miami"). */
const ESPN_ON = process.env.ESPN_LOGOS !== '0';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/';
// liga do site → liga na ESPN
const ESPN_LEAGUE = {
  'bra.1': 'soccer/bra.1', 'bra.2': 'soccer/bra.2', 'bra.copa': 'soccer/bra.copa_do_brazil', 'conmebol.lib': 'soccer/conmebol.libertadores',
  'conmebol.sud': 'soccer/conmebol.sudamericana', 'uefa.ucl': 'soccer/uefa.champions', 'uefa.uel': 'soccer/uefa.europa', 'uefa.uecl': 'soccer/uefa.europa.conf',
  'eng.1': 'soccer/eng.1', 'eng.2': 'soccer/eng.2', 'eng.efl': 'soccer/eng.league_cup', 'esp.1': 'soccer/esp.1', 'esp.copa': 'soccer/esp.copa_del_rey',
  'ita.1': 'soccer/ita.1', 'ger.1': 'soccer/ger.1', 'ger.copa': 'soccer/ger.dfb_pokal', 'fra.1': 'soccer/fra.1', 'por.1': 'soccer/por.1',
  'ned.1': 'soccer/ned.1', 'tur.1': 'soccer/tur.1', 'sau.1': 'soccer/ksa.1', 'arg.1': 'soccer/arg.1', 'mex.1': 'soccer/mex.1', 'usa.1': 'soccer/usa.1',
  nba: 'basketball/nba', ncaab: 'basketball/mens-college-basketball', nhl: 'hockey/nhl',
};
const espnLeague = new Map(); // liga do site → [{ names: [...], url }]
const espnPlayers = new Map(); // nome do tenista (normalizado) → { id, flag } (torneios ATP/WTA da semana)
const espnSurnames = new Map(); // apelido → bandeira (null se dois jogadores tiverem o mesmo apelido)
// nomes da bet365 que a ESPN escreve de outra forma (já normalizados)
const ALIAS = { 'atletico mineiro': 'atletico mg', 'sport recife': 'recife', 'sheff utd': 'sheffield united', 'sheff wed': 'sheffield wednesday', az: 'az alkmaar', 'man utd': 'manchester united', 'man city': 'manchester city', 'nottm forest': 'nottingham forest', 'wolves': 'wolverhampton wanderers' };
const teamNames = (t) => [t.displayName, t.shortDisplayName, t.name, t.location, t.nickname].map(norm).filter(Boolean);
async function espnGet(p) {
  const r = await fetch(ESPN + p, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function loadEspnTeams() {
  let n = 0;
  for (const [key, p] of Object.entries(ESPN_LEAGUE)) {
    try {
      const d = await espnGet(`${p}/teams${p.includes('college') ? '?limit=500' : ''}`);
      const list = (d.sports?.[0]?.leagues?.[0]?.teams || []).map((x) => x.team).filter((t) => t?.logos?.[0]?.href)
        .map((t) => ({ names: teamNames(t), url: t.logos[0].href }));
      if (list.length) { espnLeague.set(key, list); n += list.length; }
    } catch (e) { console.warn(`[Emblemas] ESPN ${p}: ${e.message}`); }
  }
  return n;
}
async function loadEspnTennis() {
  for (const tour of ['atp', 'wta']) {
    try {
      const d = await espnGet(`tennis/${tour}/scoreboard`);
      for (const e of d.events || []) for (const c of (e.groupings || []).flatMap((g) => g.competitions || []).concat(e.competitions || [])) {
        for (const p of c.competitors || []) {
          if (!p.athlete?.displayName || !p.athlete.flag?.href) continue;
          const n = norm(p.athlete.displayName), flag = p.athlete.flag.href;
          const id = (/\/id\/(\d+)/.exec(p.athlete.links?.[0]?.href || '') || [])[1] || null;
          espnPlayers.set(n, { id, flag });
          const sur = n.split(' ').pop();
          espnSurnames.set(sur, espnSurnames.has(sur) && espnSurnames.get(sur) !== flag ? null : flag);
        }
      }
    } catch (e) { console.warn(`[Emblemas] ESPN ténis ${tour}: ${e.message}`); }
  }
}
// emblema na ESPN: primeiro nome igual, depois "contém" (só dentro da mesma liga)
function espnLogo(sport, name, league) {
  if (sport === 'tennis') {
    // duplas ("Lorusso/Sinha"): vêm só os apelidos → bandeira do primeiro jogador, se o apelido não for ambíguo
    if (String(name).includes('/')) return espnSurnames.get(norm(String(name).split('/')[0]).split(' ').pop()) || '';
    return ''; // simples: bandeira em tennisLogo (procura em segundo plano)
  }
  const list = espnLeague.get(league);
  if (!list) return '';
  const qs = [norm(expand(name)), norm(name)].filter(Boolean);
  for (const q of [...qs]) if (ALIAS[q]) qs.push(ALIAS[q]);
  // "Sport Recife" perde a palavra "sport" ao normalizar: usa também o nome sem normalizar as siglas de clube
  qs.push(String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
  const exact = list.find((t) => qs.some((q) => t.names.includes(q)));
  if (exact) return exact.url;
  const near = list.filter((t) => qs.some((q) => q.length >= 4 && t.names.some((n) => n.length >= 4 && (n.includes(q) || q.includes(n)))));
  return near.length === 1 ? near[0].url : ''; // dois parecidos na mesma liga: não arrisca
}

const cache = new Map(); // "sport|nome" → { url, at }
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))) cache.set(k, v); } catch { /* ainda não existe */ }
let dirty = false;
function save() {
  if (!dirty) return;
  dirty = false;
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(cache))); }
  catch (e) { console.error('[Emblemas] Não foi possível guardar data/logos.json:', e.message); }
}

const queue = new Map(); // "sport|nome" → prioridade (menor = primeiro)
const keyOf = (sport, name) => `${sport}|${name}`;

// emblema já conhecido (ou '' — o site mostra as iniciais); se ainda não se sabe, entra na fila
/* Tenistas (só ESPN): bandeira do país, senão '' (iniciais).
   Os jogadores dos torneios ATP/WTA da semana já vêm com a bandeira; os outros (Challenger, ITF)
   são procurados pelo nome na pesquisa da ESPN, em segundo plano (1 jogador por segundo) e guardados. */
const tQueue = new Map(); // nome → prioridade
const tKey = (name) => keyOf('tennisflag', name); // chave própria: ignora as fotos guardadas antes
function tennisLogo(name, priority) {
  if (String(name).includes('/')) return espnLogo('tennis', name); // duplas: bandeira pelo apelido
  const c = cache.get(tKey(name));
  const known = espnPlayers.get(norm(name));
  if (c && (c.url || Date.now() - c.at < RETRY_MISS_MS)) return c.url || known?.flag || '';
  tQueue.set(name, Math.min(tQueue.get(name) ?? Infinity, priority));
  return known?.flag || ''; // jogador dos torneios ATP/WTA da semana: bandeira já conhecida
}
async function lookupTennis(name) {
  let { id, flag } = espnPlayers.get(norm(name)) || {};
  if (!id) {
    const r = await fetch(`https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(name)}&type=player&limit=5`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const hit = ((await r.json()).items || []).find((x) => x.sport === 'tennis' && norm(x.displayName) === norm(name));
    if (!hit) return '';
    id = hit.id;
  }
  if (!flag) {
    const r = await fetch(`https://sports.core.api.espn.com/v2/sports/tennis/athletes/${id}`, { signal: AbortSignal.timeout(15000) });
    if (r.ok) flag = (await r.json()).flag?.href || '';
  }
  return flag || ''; // só a bandeira (sem fotos dos jogadores)
}
let tBusy = false;
async function stepTennis() {
  if (tBusy || !tQueue.size) return;
  tBusy = true;
  const [name] = [...tQueue].sort((a, b) => a[1] - b[1])[0];
  tQueue.delete(name);
  try { cache.set(tKey(name), { url: await lookupTennis(name), at: Date.now() }); dirty = true; }
  catch { cache.set(tKey(name), { url: '', at: Date.now() - RETRY_MISS_MS + 3600000 }); dirty = true; } // erro: tenta daqui a 1h
  finally { tBusy = false; }
}

function logo(sport, name, priority, league) {
  if (!name || OFF) return '';
  if (sport === 'tennis') return ESPN_ON ? tennisLogo(name, priority) : '';
  if (ESPN_ON) { const u = espnLogo(sport, name, league); if (u) return u; }
  if (!SPORT_NAME[sport]) return ''; // ténis: só ESPN
  const k = keyOf(sport, name), c = cache.get(k);
  if (c && (c.url || Date.now() - c.at < RETRY_MISS_MS)) return c.url;
  if (!OFF) queue.set(k, Math.min(queue.get(k) ?? Infinity, priority));
  return c?.url || '';
}

async function lookup(sport, name) {
  const q = expand(name);
  const search = async (term) => {
    const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${KEY}/searchteams.php?t=${encodeURIComponent(term)}`, { signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    if (r.status === 429 || /error code: 1015/.test(text)) { const e = new Error('limite de pedidos'); e.limit = true; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const teams = JSON.parse(text).teams || [];
    return teams.find((x) => x.strSport === SPORT_NAME[sport] && x.strBadge && (sameTeam(q, x) || sameTeam(name, x))) || null;
  };
  // no basquete a bet365 usa muitas vezes só a cidade ("Paris"): tenta também "Paris Basketball"
  const t = (await search(q)) || (sport === 'basketball' && !/basket/i.test(q) ? await search(`${q} Basketball`) : null);
  return t ? `${t.strBadge}/small` : '';
}

let pausedUntil = 0, busy = false, found = 0, missed = 0;
async function step() {
  if (busy || !queue.size || Date.now() < pausedUntil) return;
  busy = true;
  const [k] = [...queue].sort((a, b) => a[1] - b[1])[0];
  queue.delete(k);
  const [sport, name] = k.split(/\|(.*)/s);
  try {
    const url = await lookup(sport, name);
    cache.set(k, { url, at: Date.now() }); dirty = true;
    url ? found++ : missed++;
  } catch (e) {
    if (e.limit) { pausedUntil = Date.now() + BACKOFF_MS; queue.set(k, -1); } // tenta esta de novo primeiro
    else { cache.set(k, { url: '', at: Date.now() - RETRY_MISS_MS + 3600000 }); dirty = true; } // erro: tenta daqui a 1h
  } finally { busy = false; }
}

let timers = null;
async function start() {
  if (OFF || timers) return;
  if (ESPN_ON) {
    const n = await loadEspnTeams(); await loadEspnTennis();
    console.log(`[Emblemas] ESPN (só para teste): ${n} emblemas de equipas em ${espnLeague.size} ligas, ${espnPlayers.size} tenistas com bandeira.`);
    // equipas: 1x/dia; tenistas: a cada hora (os torneios mudam todas as semanas)
    setInterval(loadEspnTeams, 86400000); setInterval(loadEspnTennis, 3600000);
    setInterval(stepTennis, 1000); // bandeiras dos tenistas (Challenger/ITF), um por segundo
  }
  timers = [setInterval(step, STEP_MS), setInterval(save, 30000)];
  const known = [...cache.values()].filter((v) => v.url).length;
  console.log(`[Emblemas] TheSportsDB (reserva): ${known} emblemas guardados; os que faltam são procurados em segundo plano.`);
}
const stats = () => ({ cached: cache.size, withLogo: [...cache.values()].filter((v) => v.url).length, queue: queue.size, found, missed });

module.exports = { logo, start, stats, save, expand, sameTeam, ESPN_LEAGUE };
