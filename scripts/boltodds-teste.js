'use strict';
/* Teste da BoltOdds: confirma o que o plano entrega antes de ligar ao TUGAS.
   Uso: node scripts/boltodds-teste.js            (precisa de BOLTODDS_API_KEY no .env)
   Só LÊ dados da BoltOdds; não toca na base de dados nem no site.
   Limites deles: 12 pedidos GET/min e 12 ligações WebSocket/min por IP — este teste faz 3 GET e 1 ligação. */

const fs = require('node:fs');
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* sem .env */ }
const KEY = process.env.BOLTODDS_API_KEY;
if (!KEY) { console.error('\nFalta BOLTODDS_API_KEY no .env\n'); process.exit(1); }

const BASE = 'https://spro.agency/api';
const WS_SECONDS = Number(process.env.WS_SECONDS || 60);
const OUT = path.join(__dirname, '..', 'data', 'boltodds-teste.json'); // data/ não vai para o GitHub

// casas e desportos que queremos ver
const WANT_BOOKS = /bet365|stake/i;
const SPORT_GROUPS = {
  'Futebol': /soccer|football(?!.*american)|premier|liga|serie|bundesliga|ligue|champions|europa|copa|brasil|brazil|mls|efl|eredivisie|primeira|libertadores|sudamericana/i,
  'Ténis': /tennis|atp|wta|open \(|wimbledon|itf|challenger/i,
  'NBA / basquete': /nba|basket|ncaab|euroleague|wnba|nbb/i,
  'E-sports': /esport|e-sport|cs2|csgo|counter|valorant|league of legends|\blol\b|dota|overwatch|rainbow|call of duty|fifa|efootball|ebasket/i,
};

const mask = (s) => String(s).replaceAll(KEY, '***');
async function get(endpoint, params = {}) {
  const q = new URLSearchParams({ ...params, key: KEY });
  const r = await fetch(`${BASE}/${endpoint}?${q}`, { signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${endpoint}: HTTP ${r.status} ${mask(text).slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${endpoint}: resposta não é JSON: ${mask(text).slice(0, 300)}`); }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.keys(x) : []);

(async () => {
  const report = { when: new Date().toISOString() };
  console.log('\n=== BoltOdds — teste do plano ===\n');

  // 1) casas e desportos
  const info = await get('get_info');
  report.info = info;
  const books = list(info.sportsbooks ?? info.books ?? info.sportsbook);
  const sports = list(info.sports ?? info.leagues ?? info.sport);
  console.log(`Casas disponíveis no teu plano: ${books.length}`);
  console.log('  ' + (books.join(', ') || '(formato inesperado — ver data/boltodds-teste.json)'));
  const wantedBooks = books.filter((b) => WANT_BOOKS.test(b));
  console.log(`\n>> bet365 / Stake: ${wantedBooks.length ? wantedBooks.join(', ') : 'NÃO ENCONTRADAS'}`);

  console.log(`\nDesportos/ligas: ${sports.length}`);
  report.groups = {};
  for (const [g, re] of Object.entries(SPORT_GROUPS)) {
    const hit = sports.filter((s) => re.test(s));
    report.groups[g] = hit;
    console.log(`  ${g}: ${hit.length ? `${hit.length} — ${hit.slice(0, 15).join(', ')}${hit.length > 15 ? ', …' : ''}` : 'nenhum'}`);
  }
  const other = sports.filter((s) => !Object.values(SPORT_GROUPS).some((re) => re.test(s)));
  console.log(`  Outros: ${other.length ? other.slice(0, 25).join(', ') + (other.length > 25 ? ', …' : '') : 'nenhum'}`);

  // 2) jogos
  await pause(6000);
  const games = await get('get_games');
  report.gamesSample = Object.fromEntries(Object.entries(games).slice(0, 20));
  const gameNames = list(games);
  console.log(`\nJogos listados: ${gameNames.length}`);
  const perSport = {};
  for (const [name, g] of Object.entries(games)) { const s = g?.sport || g?.league || '?'; perSport[s] = (perSport[s] || 0) + 1; }
  const top = Object.entries(perSport).sort((a, b) => b[1] - a[1]);
  if (top.length > 1 || top[0]?.[0] !== '?') console.log('  por desporto: ' + top.slice(0, 25).map(([s, n]) => `${s} ${n}`).join(' · '));
  else console.log('  exemplos: ' + gameNames.slice(0, 5).join(' | '));

  // 3) mercados das casas que interessam
  if (wantedBooks.length) {
    await pause(6000);
    try {
      const markets = await get('get_markets', { sportsbooks: wantedBooks.join(',') });
      report.markets = markets;
      console.log('\nMercados (bet365/Stake):');
      for (const [book, bySport] of Object.entries(markets)) {
        const entries = bySport && typeof bySport === 'object' ? Object.entries(bySport) : [];
        const total = entries.reduce((n, [, m]) => n + list(m).length, 0);
        console.log(`  ${book}: ${entries.length} desportos/ligas, ${total} mercados no total`);
        for (const [sport, m] of entries.slice(0, 12)) console.log(`     ${sport}: ${list(m).slice(0, 8).join(', ')}${list(m).length > 8 ? ', …' : ''}`);
      }
    } catch (e) { console.log('\nMercados: ' + e.message); }
  }

  // 4) WebSocket: o que chega de facto em N segundos
  if (typeof WebSocket !== 'function') { console.log('\n(Este Node não tem WebSocket nativo — atualize para Node 22+)'); }
  else {
    console.log(`\nA ouvir o WebSocket durante ${WS_SECONDS}s${wantedBooks.length ? ` (só ${wantedBooks.join(', ')})` : ' (todas as casas)'}...`);
    const stats = { messages: 0, actions: {}, byBook: {}, bySport: {}, games: new Set(), suspended: 0, errors: [] };
    const sample = [];
    await new Promise((resolve) => {
      const ws = new WebSocket(`wss://spro.agency/api?key=${encodeURIComponent(KEY)}`);
      ws.binaryType = 'arraybuffer'; // a BoltOdds envia as mensagens em binário (texto JSON em UTF-8)
      const stop = setTimeout(() => { try { ws.close(); } catch { /* ignora */ } resolve(); }, WS_SECONDS * 1000 + 5000);
      ws.onmessage = (ev) => {
        let msgs; try { msgs = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); } catch { return; }
        for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
          stats.messages++;
          stats.actions[m.action] = (stats.actions[m.action] || 0) + 1;
          if (m.action === 'socket_connected') {
            console.log('  ligado e autenticado');
            ws.send(JSON.stringify({ action: 'subscribe', filters: wantedBooks.length ? { sportsbooks: wantedBooks } : {} }));
          } else if (m.action === 'error') stats.errors.push(m.message);
          const d = m.data;
          if (d && d.sportsbook) {
            stats.byBook[d.sportsbook] = (stats.byBook[d.sportsbook] || 0) + 1;
            stats.bySport[d.sport] = (stats.bySport[d.sport] || 0) + 1;
            if (d.game) stats.games.add(`${d.sportsbook}|${d.game}`);
            for (const o of Object.values(d.outcomes || {})) if (o && (o.odds === null || o.odds === '' || o.odds === 'None')) stats.suspended++;
            if (sample.length < 5 && m.action !== 'ping') sample.push(m);
          }
        }
      };
      ws.onerror = (e) => { stats.errors.push('erro na ligação: ' + (e.message || e.type)); };
      ws.onclose = () => { clearTimeout(stop); resolve(); };
    });
    report.ws = { ...stats, games: stats.games.size, sample };
    console.log(`  mensagens: ${stats.messages}  ·  tipos: ${Object.entries(stats.actions).map(([a, n]) => `${a} ${n}`).join(', ') || '—'}`);
    console.log(`  por casa: ${Object.entries(stats.byBook).map(([b, n]) => `${b} ${n}`).join(', ') || 'nenhuma odd recebida'}`);
    console.log(`  por desporto: ${Object.entries(stats.bySport).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([s, n]) => `${s} ${n}`).join(', ') || '—'}`);
    console.log(`  jogos diferentes com odds: ${stats.games.size}  ·  linhas suspensas vistas: ${stats.suspended}`);
    if (stats.errors.length) console.log('  erros: ' + stats.errors.map(mask).join(' | '));
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, mask(JSON.stringify(report, (k, v) => (v instanceof Set ? [...v] : v), 2)));
  console.log(`\nRelatório completo: ${OUT}\n`);
})().catch((e) => { console.error('\nFalhou: ' + mask(e.message) + '\n'); process.exit(1); });
