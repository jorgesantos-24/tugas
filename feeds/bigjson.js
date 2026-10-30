'use strict';
/* Worker: lê as respostas grandes da MoviOdds fora do servidor principal.
   O JSON.parse da oferta completa do futebol (~118 MB) deixava o servidor parado vários segundos (site e /admin
   sem resposta). Aqui o pedido e a leitura correm noutra thread; os jogos voltam aos bocados, um bocado de cada
   vez que o servidor pede o seguinte (assim nunca copia muitos dados de uma vez e atende os outros pedidos pelo meio). */
const { parentPort } = require('node:worker_threads');

const CHUNK = 40; // jogos por mensagem
const jobs = new Map(); // id → { matches, i }

parentPort.on('message', async (msg) => {
  if (msg.cancel) { jobs.delete(msg.id); return; }
  if (msg.next) { const j = jobs.get(msg.id); if (j) sendPart(msg.id, j); return; }
  const { id, url, timeout } = msg;
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const matches = Array.isArray(d.matches) ? d.matches : [];
    delete d.matches;
    if (matches.length) jobs.set(id, { matches, i: 0 });
    parentPort.postMessage({ id, head: d, total: matches.length });
  } catch (e) { parentPort.postMessage({ id, error: e.message }); }
});

function sendPart(id, j) {
  const part = j.matches.slice(j.i, j.i + CHUNK);
  for (let k = j.i; k < j.i + part.length; k++) j.matches[k] = null; // já enviado: a memória pode ser libertada
  j.i += part.length;
  const done = j.i >= j.matches.length;
  if (done) jobs.delete(id);
  parentPort.postMessage({ id, part, done });
}
