'use strict';
/* Worker: as contas pesadas do motor do basquete fora do servidor principal. Ver feeds/bbpool.js.
   fit: ajuste às odds (feeds/bbasket.js fitOf).
   preview: a odd de juntar cada seleção do jogo às escolhidas (preparar as ~1400 seleções de um jogo da NBA leva
   ~4 s da primeira vez); o motor fica guardado aqui, com as seleções já preparadas, para os pedidos seguintes. */
const { parentPort } = require('node:worker_threads');
const BK = require('./bbasket.js');

const engines = new Map(); // id do jogo|assinatura das odds → motor
const KEEP = 20;

parentPort.on('message', (msg) => {
  try {
    if (msg.type === 'fit') return parentPort.postMessage({ n: msg.n, out: BK.fitOf(msg.m) });
    if (msg.type === 'preview') {
      let E = engines.get(msg.k);
      if (!E) {
        E = BK.fromParams(msg.params);
        engines.set(msg.k, E);
        if (engines.size > KEEP) engines.delete(engines.keys().next().value); // o mais antigo
      }
      return parentPort.postMessage({ n: msg.n, out: BK.preview(E, msg.items, msg.cands) });
    }
    parentPort.postMessage({ n: msg.n, error: 'pedido desconhecido' });
  } catch (e) { parentPort.postMessage({ n: msg.n, error: e.message }); }
});
