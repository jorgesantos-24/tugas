'use strict';
/* Motor do Criar aposta do basquete sem parar o servidor.
   Num jogo da NBA (~1600 seleções) o ajuste às odds (fitGame + fitPlayers) leva 0,5–1,5 s e preparar as seleções para
   a aba Criar aposta (preview) ~4 s; feito aqui deixava o servidor parado para todos. Essas contas correm agora num
   worker (feeds/bbworker.js); aqui fica a montagem (fromParams, ~5 ms) e a memória dos motores, com as mesmas regras
   de feeds/bbasket.js engineFor (mesma assinatura das odds, mesmos prazos). As odds são as mesmas: o worker usa o
   mesmo feeds/bbasket.js com os mesmos parâmetros (como o navegador com /bbengine.js).
   - Uma conta de cada vez; os pedidos dos jogadores (aposta, odd, aba Criar aposta) passam à frente das Super Odds.
   - O mesmo jogo com as mesmas odds pedido duas vezes espera pelo mesmo ajuste.
   - Worker em baixo ou sem resposta em 15 s: a conta faz-se aqui mesmo, como antes (nunca fica sem odd). */
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const BK = require('./bbasket.js');

const JOB_MS = 15000;
const cache = new Map(); // id do jogo → { E, at, sig }
const pending = new Map(); // id|assinatura → Promise do motor
const queue = []; // { k, msg, low, ok } à espera do worker
let worker = null, busy = null, seq = 0;

function startWorker() {
  const w = new Worker(path.join(__dirname, 'bbworker.js'));
  w.unref();
  w.on('message', ({ n, out, error }) => {
    if (!busy || busy.n !== n) return;
    if (error) console.error('[Criar aposta basquete]', busy.msg.type, error);
    finish(error ? (busy.msg.type === 'fit' ? null : undefined) : out);
  });
  const down = (why) => {
    if (worker !== w) return;
    console.error('[Criar aposta basquete] worker parou:', why);
    worker = null;
    if (busy) finish(undefined);
  };
  w.on('error', (e) => down(e.message));
  w.on('exit', (c) => down('código ' + c));
  return w;
}
// resposta do worker · undefined = sem worker (a conta faz-se aqui)
function finish(out) {
  const job = busy;
  busy = null;
  clearTimeout(job.t);
  job.ok(out);
  next();
}
function next() {
  if (busy || !queue.length) return;
  const i = queue.findIndex((j) => !j.low);
  const job = queue.splice(i >= 0 ? i : 0, 1)[0];
  try { worker ||= startWorker(); } catch (e) { console.error('[Criar aposta basquete] sem worker:', e.message); job.ok(undefined); return next(); }
  busy = { ...job, n: ++seq };
  busy.t = setTimeout(() => { // sem resposta: um worker novo para os seguintes
    const w = worker; worker = null; w?.terminate().catch(() => {});
    if (busy) finish(undefined);
  }, JOB_MS);
  worker.postMessage({ ...job.msg, n: busy.n });
}
const inWorker = (k, msg, low = false) => new Promise((ok) => { queue.push({ k, msg, low, ok }); next(); });

async function build(k, id, m, sig, low) {
  const t = Date.now(); // o motor vale a partir das odds lidas agora
  const fit = await inWorker(k, { type: 'fit', m }, low);
  let E = null;
  try {
    if (fit === undefined) E = BK.build(m);
    else if (fit) { E = BK.fromParams({ home: m.home, away: m.away, ...fit }); E.m = m; }
  } catch (e) { console.error('[Criar aposta basquete]', id, e.message); }
  if (E) E.v = Date.now();
  cache.set(id, { E, at: t, sig });
  if (cache.size > 300) for (const [key, v] of cache) if (Date.now() - v.at > BK.TTL) cache.delete(key);
  return E;
}
// = BK.engineFor, mas devolve uma Promise. low: Super Odds (espera atrás dos pedidos dos jogadores)
function engineFor(id, m, maxAge, low = false) {
  const c = cache.get(id), sig = BK.sigOf(m);
  if (c && Date.now() - c.at < (maxAge ?? (m.live ? BK.LIVE_TTL : BK.TTL)) && c.sig === sig) return Promise.resolve(c.E);
  const k = id + '|' + sig;
  let p = pending.get(k);
  if (!p) {
    p = build(k, id, m, sig, low).finally(() => pending.delete(k));
    pending.set(k, p);
  } else if (!low) { const j = queue.find((x) => x.k === k); if (j) j.low = false; } // um jogador espera por ele: passa à frente
  return p;
}
// = BK.preview(E, items, cands) no worker (o motor E é o de engineFor para estas odds)
async function preview(id, m, E, items, cands) {
  const k = `${id}|${BK.sigOf(m)}|${E.v}`;
  const out = await inWorker(k, { type: 'preview', k, params: BK.modelOf(E), items, cands });
  return out === undefined ? BK.preview(E, items, cands) : out;
}

module.exports = { engineFor, preview };
