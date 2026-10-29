'use strict';
/* Gera feeds/escudos-futebol.json: as equipas de futebol de cada país, com o emblema, da API-Football (api-sports.io).
   Uso: node scripts/escudos-futebol.js          (países das ligas que o site mostra agora, os que ainda faltam no ficheiro)
        node scripts/escudos-futebol.js --todos  (volta a pedir todos)
   Precisa de APIFOOTBALL_KEY no .env (plano grátis: 100 pedidos por dia; 1 pedido por país). Se a cota acabar a meio,
   guarda o que já tem: basta correr de novo no dia seguinte. O servidor só lê o ficheiro (não faz pedidos à API). */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'feeds', 'escudos-futebol.json');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* sem .env */ }
const KEY = process.env.APIFOOTBALL_KEY;
if (!KEY) { console.error('Falta APIFOOTBALL_KEY no .env'); process.exit(1); }
const SITE = process.env.SITE_URL || 'https://tugasbet.com';
const { COUNTRY_PT } = require('../feeds/moviodds.js');
const M = require('../public/markets.js');

const API = 'https://v3.football.api-sports.io';
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
const SKIP = new Set(['Europa', 'Internacional', 'Outros', 'América do Sul', 'América do Norte', 'Ásia', 'África', 'Mundo']);
// nomes da fonte que a API-Football escreve de outra forma
const AF_NAME = { 'Bosnia & Herzegovina': 'Bosnia', 'North Macedonia': 'Macedonia', 'Republic of Ireland': 'Ireland', 'Cape Verde': 'Cape-Verde-Islands', 'United States': 'USA', Türkiye: 'Turkey', Czechia: 'Czech-Republic' };

async function api(p) {
  const r = await fetch(API + p, { headers: { 'x-apisports-key': KEY }, signal: AbortSignal.timeout(30000) });
  const d = await r.json();
  const err = d.errors && (Array.isArray(d.errors) ? d.errors.length : Object.keys(d.errors).length) ? JSON.stringify(d.errors) : '';
  return { d, err, left: Number(r.headers.get('x-ratelimit-requests-remaining')) };
}

(async () => {
  const all = process.argv.includes('--todos');
  const out = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } })();

  // países das ligas de futebol que o site mostra agora (as criadas na hora vêm no campo "leagues" do /api/events)
  const feed = await (await fetch(`${SITE}/api/events`, { signal: AbortSignal.timeout(60000) })).json();
  const leagues = [...(feed.leagues || []), ...M.LEAGUES].filter((l) => l.sport === 'soccer');
  const want = [...new Set(leagues.map((l) => l.country).filter((c) => c && !SKIP.has(c)))];

  const { d: cd, err: ce } = await api('/countries');
  if (ce) { console.error('API-Football:', ce); process.exit(1); }
  const afByNorm = new Map((cd.response || []).map((c) => [norm(c.name), c.name]));
  const toAf = (pt) => {
    for (const en of Object.keys(COUNTRY_PT).filter((k) => COUNTRY_PT[k] === pt).concat(pt === 'EUA' ? ['USA'] : [])) {
      const n = afByNorm.get(norm(AF_NAME[en] || en));
      if (n) return n;
    }
    return null;
  };

  const todo = want.filter((c) => all || !out[c]);
  console.log(`${want.length} países nas ligas do site; a pedir ${todo.length}.`);
  let left = Infinity;
  for (const pt of todo) {
    const af = toAf(pt);
    if (!af) { console.log(`  ${pt}: sem correspondência na API-Football`); continue; }
    if (left <= 1) { console.log('Cota do dia esgotada: corra de novo amanhã para os que faltam.'); break; }
    const r = await api(`/teams?country=${encodeURIComponent(af)}`);
    left = r.left;
    if (r.err) { console.log(`  ${pt} (${af}): ${r.err}`); if (/limit|requests/i.test(r.err)) break; continue; }
    out[pt] = (r.d.response || []).filter((x) => !x.team.national && x.team.name).map((x) => [x.team.name, x.team.id]);
    console.log(`  ${pt} (${af}): ${out[pt].length} equipas · restam ${left} pedidos hoje`);
    await new Promise((res) => setTimeout(res, 7000)); // plano grátis: 10 pedidos por minuto
  }
  const sorted = Object.fromEntries(Object.keys(out).sort((a, b) => a.localeCompare(b, 'pt-BR')).map((k) => [k, out[k]]));
  fs.writeFileSync(FILE, JSON.stringify(sorted));
  console.log(`Guardado ${path.relative(ROOT, FILE)}: ${Object.keys(sorted).length} países, ${Object.values(sorted).reduce((a, l) => a + l.length, 0)} equipas.`);
})();
