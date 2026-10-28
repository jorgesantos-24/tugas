'use strict';
/* Emblemas das equipas e bandeiras dos tenistas.
   1) ESPN (só para TESTE local — imagens não oficiais; desligar com ESPN_LOGOS=0 antes de produção)
   2) Reserva: TheSportsDB (https://www.thesportsdb.com, plano grátis).
   O plano grátis aceita poucos pedidos por minuto, por isso cada equipa é procurada uma só vez, em segundo plano
   (uma a cada 3 s; primeiro as dos jogos ao vivo e dos mais próximos), e o resultado fica guardado em data/logos.json.
   Só se aceita o emblema se a modalidade e o nome baterem certo; sem emblema, o site mostra as iniciais.
   3) e-Sports: Liquipedia (ver lookupEsports), pela wiki do jogo (CS2, Valorant, R6, LoL, Dota). */

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
  nba: 'basketball/nba', wnba: 'basketball/wnba', ncaab: 'basketball/mens-college-basketball', nhl: 'hockey/nhl',
};
const espnLeague = new Map(); // liga do site → [{ names: [...], url }]
const espnPlayers = new Map(); // nome do tenista (normalizado) → { id, flag } (torneios ATP/WTA da semana)
const espnSurnames = new Map(); // apelido → bandeira (null se dois jogadores tiverem o mesmo apelido)
// nomes da bet365 que a ESPN escreve de outra forma (já normalizados)
const ALIAS = { 'miami florida': 'miami hurricanes', olympiakos: 'olympiacos piraeus', 'atletico mineiro': 'atletico mg', 'sport recife': 'recife', 'sheff utd': 'sheffield united', 'sheff wed': 'sheffield wednesday', az: 'az alkmaar', 'man utd': 'manchester united', 'man city': 'manchester city', 'nottm forest': 'nottingham forest', 'wolves': 'wolverhampton wanderers' };
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
  return list ? listLogo(list, name) : '';
}
function listLogo(list, name) {
  const qs = [norm(expand(name)), norm(name)].filter(Boolean);
  for (const q of [...qs]) if (ALIAS[q]) qs.push(ALIAS[q]);
  // "Sport Recife" perde a palavra "sport" ao normalizar: usa também o nome sem normalizar as siglas de clube
  qs.push(String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
  const exact = list.find((t) => qs.some((q) => t.names.includes(q)));
  if (exact) return exact.url;
  const near = list.filter((t) => qs.some((q) => q.length >= 4 && t.names.some((n) => n.length >= 4 && (n.includes(q) || q.includes(n)))));
  if (near.length === 1) return near[0].url;
  if (near.length) return ''; // dois parecidos na mesma liga: não arrisca
  // patrocinador no meio do nome ("Maccabi Tel Aviv" ~ "Maccabi Rapyd Tel Aviv"): todas as palavras da bet365 no nome
  const words = list.filter((t) => qs.some((q) => q.includes(' ') && t.names.some((n) => q.split(' ').every((w) => n.split(' ').includes(w)))));
  return words.length === 1 ? words[0].url : '';
}

/* ---------- Emblemas das próprias ligas (a ESPN tem estas equipas sem emblema) ----------
   Euroliga e EuroCup: API oficial (api-live.euroleague.net). NBB (lnb.com.br) e Liga Nacional da Argentina
   (laliganacional.com.ar): a lista de equipas das páginas oficiais. Um pedido por liga ao arrancar e 1x/dia. */
const EL_COMP = { euroleague: 'E', eurocup: 'U' };
const offLeague = new Map(); // liga do site → [{ names, url }]
const unent = (s) => String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const SITE_CRESTS = {
  // <a href=".../equipes/basket-osasco/"><img src="..."> Basket Osasco</a>
  nbb: { url: 'https://lnb.com.br/nbb/equipes/', re: /<a href="https:\/\/lnb\.com\.br\/equipes\/([^"/]+)\/?">\s*<img src="([^"]+)"[^>]*>\s*([^<]+?)\s*<\/a>/g, pick: (m) => ({ img: /[^\x21-\x7e]/.test(m[2]) ? encodeURI(m[2]) : m[2], names: [m[3], m[1].replace(/-/g, ' ')] }) }, // "Sâo-José-….png"
  // <a href="/laliga/equipo/19/114735/boca/inicio"><img src="/escudos/19/114735" title="=BOCA" />; "(C)", "(CR)" = cidade
  'arg.lnb': { url: 'https://www.laliganacional.com.ar/', re: /<a href="\/laliga\/equipo\/\d+\/\d+\/([^/"]+)\/[^"]*">\s*<img src="(\/escudos\/[^"]+)"[^>]*title="=([^"]+)"/g, pick: (m) => ({ img: 'https://www.laliganacional.com.ar' + m[2], names: [unent(m[3]).replace(/\s*\([^)]*\)\s*$/, ''), m[1].replace(/-/g, ' ')] }) },
};
async function loadSiteCrests() {
  let n = 0;
  for (const [key, s] of Object.entries(SITE_CRESTS)) {
    try {
      const r = await fetch(s.url, { headers: { 'user-agent': 'Mozilla/5.0 (TUGAS emblemas)' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const seen = new Map();
      for (const m of (await r.text()).matchAll(s.re)) { const t = s.pick(m); if (!seen.has(t.img)) seen.set(t.img, { names: [...new Set(t.names.map(norm).filter(Boolean))], url: t.img }); }
      if (seen.size) { offLeague.set(key, [...seen.values()]); n += seen.size; }
      else console.warn(`[Emblemas] ${s.url}: nenhuma equipa encontrada (a página mudou?)`);
    } catch (e) { console.warn(`[Emblemas] ${s.url}: ${e.message}`); }
  }
  return n;
}
async function loadEuroleague() {
  const now = new Date(), season = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1; // a época começa em setembro
  let n = 0;
  for (const [key, c] of Object.entries(EL_COMP)) {
    try {
      const r = await fetch(`https://api-live.euroleague.net/v2/competitions/${c}/seasons/${c}${season}/clubs`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = ((await r.json()).data || []).filter((t) => t.images?.crest).map((t) => ({
        names: [...new Set([t.name, t.clubPermanentName, t.clubPermanentAlias, t.abbreviatedName, t.editorialName].map(norm).filter(Boolean))],
        url: t.images.crest,
      }));
      if (list.length) { offLeague.set(key, list); n += list.length; }
    } catch (e) { console.warn(`[Emblemas] Euroliga ${c}${season}: ${e.message}`); }
  }
  return n;
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

/* ---------- e-Sports: Liquipedia (https://liquipedia.net) ----------
   Emblema pelo nome da equipa na wiki do jogo. Regras da Liquipedia: User-Agent identificado, um pedido de cada vez
   e no máximo 1 a cada 2 s; cada equipa é procurada uma só vez e só o link fica guardado (data/logos.json).
   Dos ficheiros da página da equipa escolhe o que tem o nome dela, sem "full" (nome por extenso) nem "Academy",
   o mais recente e para fundo escuro, em miniatura de 64 px. ESPORTS_LOGOS=0 desliga. */
const LP_ON = process.env.ESPORTS_LOGOS !== '0';
const LP_UA = 'TUGAS-esports-logos/1.0 (suporte@tugasbet.com)';
const LP_GAP = 2200;
// campeonato (do site ou o jogo escolhido num evento da equipa: r6, cs2, valorant) → wiki da Liquipedia
const lpWiki = (league) => {
  const l = String(league || '').replace(/^es\./, ''); // campeonatos da fonte: "es.cs2-pgl-bucharest"
  return /^(cs2|counterstrike)/.test(l) ? 'counterstrike' : /^valorant/.test(l) ? 'valorant' : /^(r6|rainbow)/.test(l) ? 'rainbowsix'
    : /^lol/.test(l) ? 'leagueoflegends' : /^dota/.test(l) ? 'dota2' : null;
};
const lpNorm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const lpSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function lpGet(wiki, params) {
  const r = await fetch(`https://liquipedia.net/${wiki}/api.php?` + new URLSearchParams({ format: 'json', ...params }), { headers: { 'user-agent': LP_UA, 'accept-encoding': 'gzip' }, signal: AbortSignal.timeout(15000) });
  if (r.status === 429) { const e = new Error('limite de pedidos'); e.limit = true; throw e; }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function lookupEsports(wiki, name) {
  const d = await lpGet(wiki, { action: 'query', titles: name, prop: 'images', imlimit: '500', redirects: '1' });
  const pg = Object.values(d.query?.pages || {})[0];
  if (!pg || pg.missing !== undefined) return '';
  const title = lpNorm(pg.title), short = title.replace(/(esports|gaming|clan|team)$/, '');
  const cands = (pg.images || []).map((i) => i.title.replace(/^File:/, '')).filter((t) => /(allmode|darkmode|lightmode)/i.test(t)).map((t) => ({
    t, base: lpNorm(t.replace(/\s*(19|20)\d{2}.*|\s*(full\s*)?(allmode|darkmode|lightmode).*/i, '')),
    year: Number((t.match(/\b(19|20)\d{2}\b/) || [])[0]) || 3000, full: /\bfull\b/i.test(t), academy: /academy/i.test(t) && !/academy/.test(title),
    mode: /darkmode/i.test(t) ? 2 : /allmode/i.test(t) ? 1 : 0,
  })).filter((c) => short && c.base.startsWith(short) && !c.academy);
  if (!cands.length) return '';
  cands.sort((a, b) => (b.base === title) - (a.base === title) || a.full - b.full || b.year - a.year || b.mode - a.mode);
  await lpSleep(LP_GAP);
  const q = await lpGet(wiki, { action: 'query', titles: 'File:' + cands[0].t, prop: 'imageinfo', iiprop: 'url', iiurlwidth: '64' });
  const ii = Object.values(q.query?.pages || {})[0]?.imageinfo?.[0];
  return ii?.thumburl || ii?.url || '';
}
const lpQueue = new Map(); // "esports:wiki|nome" → prioridade
let lpBusy = false, lpPaused = 0;
async function stepEsports() {
  if (lpBusy || !lpQueue.size || Date.now() < lpPaused) return;
  lpBusy = true;
  const [k] = [...lpQueue].sort((a, b) => a[1] - b[1])[0];
  lpQueue.delete(k);
  const [sw, name] = k.split(/\|(.*)/s);
  try { const url = await lookupEsports(sw.slice(8), name); cache.set(k, { url, at: Date.now() }); dirty = true; url ? found++ : missed++; }
  catch (e) {
    if (e.limit) { lpPaused = Date.now() + BACKOFF_MS; lpQueue.set(k, -1); }
    else { cache.set(k, { url: '', at: Date.now() - RETRY_MISS_MS + 3600000 }); dirty = true; } // erro: tenta daqui a 1h
  } finally { lpBusy = false; }
}
function esportsLogo(name, priority, league) {
  const wiki = LP_ON && lpWiki(league);
  if (!wiki) return '';
  const k = keyOf('esports:' + wiki, name), c = cache.get(k);
  if (c && (c.url || Date.now() - c.at < RETRY_MISS_MS)) return c.url;
  lpQueue.set(k, Math.min(lpQueue.get(k) ?? Infinity, priority));
  return c?.url || '';
}

function logo(sport, name, priority, league) {
  if (!name || OFF) return '';
  if (sport === 'esports') return esportsLogo(name, priority, league);
  if (sport === 'tennis') return ESPN_ON ? tennisLogo(name, priority) : '';
  if (offLeague.has(league)) { const u = listLogo(offLeague.get(league), name); if (u) return u; }
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
  const el = await loadEuroleague(), sc = await loadSiteCrests();
  console.log(`[Emblemas] Das próprias ligas: Euroliga/EuroCup ${el}, NBB/Liga Nacional ${sc}.`);
  setInterval(loadEuroleague, 86400000); setInterval(loadSiteCrests, 86400000);
  if (ESPN_ON) {
    const n = await loadEspnTeams(); await loadEspnTennis();
    console.log(`[Emblemas] ESPN (só para teste): ${n} emblemas de equipas em ${espnLeague.size} ligas, ${espnPlayers.size} tenistas com bandeira.`);
    // equipas: 1x/dia; tenistas: a cada hora (os torneios mudam todas as semanas)
    setInterval(loadEspnTeams, 86400000); setInterval(loadEspnTennis, 3600000);
    setInterval(stepTennis, 1000); // bandeiras dos tenistas (Challenger/ITF), um por segundo
  }
  timers = [setInterval(step, STEP_MS), setInterval(save, 30000), setInterval(stepEsports, LP_GAP + 300)];
  const known = [...cache.values()].filter((v) => v.url).length;
  console.log(`[Emblemas] TheSportsDB (reserva): ${known} emblemas guardados; os que faltam são procurados em segundo plano.`);
}
const stats = () => ({ cached: cache.size, withLogo: [...cache.values()].filter((v) => v.url).length, queue: queue.size + lpQueue.size, found, missed });

module.exports = { logo, start, stats, save, expand, sameTeam, ESPN_LEAGUE, lookupEsports };
