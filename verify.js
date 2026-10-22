'use strict';
/* Segunda fonte de resultados (futebol): API-Football (api-sports.io).
   Antes de pagar uma aposta de futebol, o placar da ESPN é comparado com o da API-Football.
   - iguais          → "ok": a aposta é liquidada normalmente;
   - diferentes      → "mismatch": a aposta fica em aberto e aparece no painel para a equipa decidir;
   - ainda sem dados → "pending": tenta de novo mais tarde;
   - jogo não achado → "notfound" (6h depois do início): fica para a equipa decidir.
   Gasta pouco: um pedido traz TODOS os jogos de um dia, e só se pergunta quando há apostas à espera.
   Sem APIFOOTBALL_KEY, nada muda (só a ESPN). */

const M = require('./public/markets.js');

const KEY = process.env.NO_EXTERNAL === '1' ? '' : process.env.APIFOOTBALL_KEY || ''; // NO_EXTERNAL=1: testes locais
const BASE = (process.env.APIFOOTBALL_URL || 'https://v3.football.api-sports.io').replace(/\/+$/, '');
const H = 3600000;

const dayCache = new Map();  // 'YYYY-MM-DD' -> { at, list, error }
const verdicts = new Map();  // evId -> { state, h, a, status, fixtureId, at, other }
const quota = { remaining: null, limit: null, at: 0, error: null };

async function fetchDay(date) {
  const r = await fetch(`${BASE}/fixtures?date=${date}&timezone=UTC`, { headers: { 'x-apisports-key': KEY }, signal: AbortSignal.timeout(20000) });
  const rem = r.headers.get('x-ratelimit-requests-remaining'), lim = r.headers.get('x-ratelimit-requests-limit');
  if (rem != null) { quota.remaining = Number(rem); quota.limit = Number(lim); quota.at = Date.now(); }
  const d = await r.json().catch(() => ({}));
  const errs = d.errors && (Array.isArray(d.errors) ? d.errors : Object.values(d.errors));
  if (!r.ok || (errs && errs.length)) {
    const msg = errs && errs.length ? errs.join('; ') : `HTTP ${r.status}`;
    quota.error = msg;
    throw new Error(msg);
  }
  quota.error = null;
  return d.response || [];
}

// lista de jogos do dia, com cache: 15 min (ou 60 min se a quota estiver a acabar)
async function fixturesForDate(date) {
  const c = dayCache.get(date);
  const ttl = quota.remaining != null && quota.remaining < 15 ? 60 * 60000 : 15 * 60000;
  if (c && Date.now() - c.at < ttl) { if (c.error) throw new Error(c.error); return c.list; }
  try {
    const list = await fetchDay(date);
    dayCache.set(date, { at: Date.now(), list });
    if (dayCache.size > 10) dayCache.delete(dayCache.keys().next().value);
    return list;
  } catch (e) {
    dayCache.set(date, { at: Date.now(), list: [], error: e.message });
    throw e;
  }
}

/* nomes de times: "Atlético-MG" ≈ "Atletico Mineiro", "Club América" ≈ "America" */
const STOP = new Set(['fc', 'cf', 'sc', 'ec', 'ac', 'cd', 'ca', 'se', 'cr', 'afc', 'club', 'clube', 'de', 'da', 'do', 'del', 'la', 'el', 'futebol', 'football', 'futbol', 'sport', 'esporte', 'sociedade', 'esportiva', 'the', 'and']);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
  .split(/\s+/).filter((w) => w && !STOP.has(w));
function similar(a, b) {
  const A = norm(a), B = norm(b);
  if (!A.length || !B.length) return 0;
  if (A.join('') === B.join('')) return 1;
  let hit = 0;
  for (const w of A) if (B.some((x) => x === w || (w.length >= 4 && (x.startsWith(w) || w.startsWith(x))))) hit++;
  return hit / Math.max(1, Math.min(A.length, B.length));
}
const teamSim = (espnTeam, apiName) => Math.max(similar(espnTeam.name, apiName), similar(espnTeam.short, apiName));

// encontra o jogo da ESPN na lista da API-Football (hora ± 2h + nomes parecidos). Deteta mando trocado.
function matchFixture(list, ev) {
  const t = +new Date(ev.date);
  let best = null;
  for (const f of list) {
    const ft = (f.fixture?.timestamp || 0) * 1000;
    if (Math.abs(ft - t) > 2 * H) continue;
    const hn = f.teams?.home?.name, an = f.teams?.away?.name;
    const straight = teamSim(ev.home, hn) + teamSim(ev.away, an);
    const swapped = teamSim(ev.home, an) + teamSim(ev.away, hn);
    const score = Math.max(straight, swapped) - Math.abs(ft - t) / (10 * H);
    if (Math.max(straight, swapped) >= 1.0 && (!best || score > best.score)) best = { f, swapped: swapped > straight, score };
  }
  return best;
}

const VOID_ST = new Set(['PST', 'CANC', 'ABD', 'AWD', 'WO', 'SUSP', 'INT', 'TBD']);
const FINAL_ST = new Set(['FT', 'AET', 'PEN']);
const isVoidLike = (ev) => /POSTPONED|CANCELED|ABANDONED/.test(ev.statusName);

/* Confere um jogo terminado na ESPN. Devolve { state, ... } (ver topo do ficheiro). */
async function check(ev) {
  if (!KEY || ev.sport !== 'soccer') return { state: 'off' };
  const prev = verdicts.get(ev.id);
  if (prev && prev.state === 'ok') return prev;
  if (prev && Date.now() - prev.at < 5 * 60000) return prev; // não perguntar de novo antes de 5 min
  const voidLike = isVoidLike(ev);
  if (!voidLike && !ev.completed) return { state: 'pending' };
  const [eh, ea] = voidLike ? [null, null] : M.regulationScore(ev);
  const date = new Date(ev.date).toISOString().slice(0, 10);
  let v;
  try {
    const best = matchFixture(await fixturesForDate(date), ev);
    if (!best) v = { state: Date.now() - +new Date(ev.date) > 6 * H ? 'notfound' : 'pending' };
    else {
      const f = best.f, st = f.fixture.status.short;
      let h = f.score?.fulltime?.home, a = f.score?.fulltime?.away;
      if (best.swapped) [h, a] = [a, h];
      const other = { h, a, status: st, fixtureId: f.fixture.id, home: f.teams.home.name, away: f.teams.away.name };
      if (voidLike) v = VOID_ST.has(st) ? { state: 'ok', ...other } : FINAL_ST.has(st) ? { state: 'mismatch', ...other, espn: 'adiado/cancelado' } : { state: 'pending', ...other };
      else if (FINAL_ST.has(st) && h != null && a != null) v = h === eh && a === ea ? { state: 'ok', ...other } : { state: 'mismatch', ...other, espn: `${eh}-${ea}` };
      else if (VOID_ST.has(st)) v = { state: 'mismatch', ...other, espn: `${eh}-${ea}` };
      else v = { state: Date.now() - +new Date(ev.date) > 6 * H ? 'notfound' : 'pending', ...other };
    }
  } catch (e) {
    v = { state: 'pending', error: e.message };
  }
  v.at = Date.now();
  if (v.state === 'mismatch' && (!prev || prev.state !== 'mismatch')) {
    console.warn(`[Verificação] PLACAR DIVERGENTE em ${ev.home.short} x ${ev.away.short}: ESPN ${v.espn} · API-Football ${v.h}-${v.a} (${v.status}). Apostas ficam em aberto: ver painel > Apostas.`);
  }
  if (v.state === 'notfound' && (!prev || prev.state !== 'notfound')) {
    console.warn(`[Verificação] ${ev.home.short} x ${ev.away.short} não encontrado na API-Football. Apostas ficam em aberto: ver painel > Apostas.`);
  }
  verdicts.set(ev.id, v);
  return v;
}

module.exports = { enabled: !!KEY, check, verdict: (evId) => verdicts.get(evId) || null, quota, matchFixture, similar };
