'use strict';
/* Bet Builder da bet365 pela MoviOdds (POST /betbuilder/price, chave MOVIODDS_BB_KEY).
   Só antes do jogo: a MoviOdds responde "fixture has kicked off" a jogos a decorrer (confirmado em 30/10/2026).
   Cada pedido leva 0,3–2 s e a MoviOdds aceita ~120 por minuto para o site inteiro: preço guardado alguns segundos
   por combinação, pedidos iguais em curso partilhados e, acima do limite, sem preço (o Criar aposta usa o nosso motor).
   price(fixture, legs) → { odds, legs: [{ sel_id, odds }] } ou { reason } (sem preço da bet365: fica o nosso). */
const KEY = process.env.MOVIODDS_BB_KEY || '';
const URL_PRICE = 'https://moviodds.com/betbuilder/price';
const TTL = 45000, TTL_NO = 120000; // preço guardado; combinação que a bet365 não dá (não volta a perguntar logo)
const PER_MIN = 100; // abaixo dos 120/min da MoviOdds
const TIMEOUT = 8000;

const cache = new Map(); // fixture|sel_ids → { at, r }
const inflight = new Map();
let sent = []; // instantes dos pedidos do último minuto
let blockedUntil = 0; // a MoviOdds disse que passámos o limite (503/429)

const keyOf = (fixture, legs) => `${fixture}|${[...legs].map(String).sort().join(',')}`;
function cached(fixture, legs, maxAge = TTL) {
  const c = cache.get(keyOf(fixture, legs));
  return c && Date.now() - c.at < (c.r.odds ? maxAge : TTL_NO) ? c.r : null;
}
async function ask(fixture, legs) {
  const t = Date.now();
  sent = sent.filter((x) => t - x < 60000);
  if (t < blockedUntil || sent.length >= PER_MIN) return { reason: 'limite de pedidos', retry: true };
  sent.push(t);
  let res;
  try {
    res = await fetch(URL_PRICE, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
      body: JSON.stringify({ slips: [{ fixture: String(fixture), legs: legs.map(String) }] }), signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) { return { reason: `sem resposta (${e.name === 'TimeoutError' ? 'tempo esgotado' : e.message})`, retry: true }; }
  if (res.status === 503 || res.status === 429) { blockedUntil = Date.now() + 20000; return { reason: 'limite de pedidos', retry: true }; }
  if (res.status === 401) { console.error('[Bet Builder bet365] chave MOVIODDS_BB_KEY recusada (401)'); blockedUntil = Date.now() + 600000; return { reason: 'chave recusada', retry: true }; }
  let j;
  try { j = await res.json(); } catch { return { reason: `resposta inválida (${res.status})`, retry: true }; }
  const x = j?.results?.[0];
  if (!x) return { reason: `resposta inválida (${res.status})`, retry: true };
  if (x.status === 'priced' && Number(x.odds_dec) > 1) return { odds: Number(x.odds_dec), legs: (x.legs || []).map((l) => ({ sel_id: String(l.sel_id), odds: Number(l.odds_dec) })) };
  return { reason: x.status === 'unavailable' ? 'a bet365 não junta estas seleções' : String(x.error || x.status), retry: !!x.retryable };
}
// maxAge: idade máxima de um preço guardado (na aceitação da aposta, mais curta)
async function price(fixture, legs, maxAge) {
  if (!KEY) return { reason: 'sem chave' };
  if (!fixture || legs.length < 2 || legs.length > 12 || legs.some((l) => !l)) return { reason: 'seleções sem cotação da bet365' };
  const hit = cached(fixture, legs, maxAge);
  if (hit) return hit;
  const k = keyOf(fixture, legs);
  if (!inflight.has(k)) {
    inflight.set(k, ask(fixture, legs).then((r) => {
      if (!r.retry) cache.set(k, { at: Date.now(), r }); // falhas de rede/limite não ficam guardadas
      if (cache.size > 5000) for (const [kk, v] of cache) if (Date.now() - v.at > TTL_NO) cache.delete(kk);
      return r;
    }).finally(() => inflight.delete(k)));
  }
  return inflight.get(k);
}

module.exports = { price, cached, enabled: () => !!KEY, info: () => ({ on: !!KEY, lastMinute: sent.filter((x) => Date.now() - x < 60000).length, cached: cache.size }) };
