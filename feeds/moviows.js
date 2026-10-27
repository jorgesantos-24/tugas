'use strict';
/* MoviOdds por WebSocket (wss://moviodds.com/ws): odds e estatísticas ao vivo empurradas no instante em que mudam.
   Protocolo (https://moviodds.com/bet365-odds-websocket/):
   - { op: 'subscribe', fixtures, stats: true } SUBSTITUI a subscrição e reenvia a fotografia completa de cada jogo
     (≈ 30 KB por jogo). Por isso juntar jogos novos faz-se em lotes espaçados; tirar jogos usa 'unsubscribe' (sem fotografias).
   - A fonte aplica as 3 primeiras (des)subscrições logo e depois uma a cada 2 s: nunca mandamos mais do que isso.
   - snapshot = todas as cotações de um jogo (substitui) · delta = cotações que mudaram (cada uma substitui a anterior)
     · remove = cotações (ou o jogo inteiro) que saíram · polled = jogos relidos agora (frescura) · status = jogo/mercado
     ficou (ou deixou de estar) atrasado · stats = estatísticas ao vivo (completas) · feed = saúde da fonte por modalidade
   - lagged / resync: as fotografias novas chegam sozinhas — NÃO se volta a subscrever.
   - Cotação identificada por grupo + mercado + seleção.
   Os pedidos normais (feeds/moviodds.js) continuam como reserva: se a ligação cair, o site funciona como antes. */

const URL_WS = 'wss://moviodds.com/ws';
const KEY = process.env.NO_EXTERNAL === '1' ? '' : process.env.MOVIODDS_KEY || '';
const OFF = process.env.MOVIODDS_WS === '0';

const ADD_GAP_MS = 10000;  // jogos novos: no máximo uma nova subscrição (com fotografias de tudo) a cada 10 s
const OP_GAP_MS = 2500;    // entre duas mensagens de (des)subscrição (a fonte aceita uma a cada 2 s)
const FLUSH_MS = 200;      // junta as mudanças de cada jogo e avisa no máximo 5x por segundo
const QUIET_PING_MS = 30000, QUIET_CLOSE_MS = 45000; // a fonte manda "feed" pelo menos a cada 15 s

const state = new Map(); // id do jogo → { quotes: Map(chave → cotação), status, polledAt, refreshS, stale, stats, at }
const qkey = (q) => `${q.group_id}|${q.market_id ?? ''}|${q.sel_id}`;
let ws = null, open = false, connecting = false;
let wanted = new Set();     // jogos que o site quer seguir
let subscribed = new Set(); // jogos que a fonte já tem na nossa subscrição
let lastSubAt = 0, lastOpAt = 0, opT = null, pingT = null, lastMsg = 0;
let retry = 0, restartRetry = 0;
let clockOffset = 0;        // relógio da fonte − o nosso (ms)
let health = null;          // última mensagem "feed": { sport → { live, pre_match } }
let onChange = () => {}, onDown = () => {};
const counters = { connects: 0, msgs: 0, bytes: 0, snapshots: 0, deltas: 0, removes: 0, stats: 0, lagged: 0, resync: 0, subs: 0, since: Date.now() };

const pending = new Set(), gone = new Set();
let flushT = null;
function changed(id, removed = false) {
  (removed ? gone : pending).add(id);
  if (removed) pending.delete(id);
  if (!flushT) flushT = setTimeout(flush, FLUSH_MS);
}
function flush() {
  flushT = null;
  const ids = [...pending], out = [...gone];
  pending.clear(); gone.clear();
  try { onChange(ids, out); } catch (e) { console.error('[MoviOdds WS] erro ao aplicar:', e.message); }
}

/* ---------------- subscrição ---------------- */
function send(obj) { try { ws.send(JSON.stringify(obj)); return true; } catch { return false; } }

// decide a próxima mensagem: jogos novos → subscribe com a lista toda (em lotes); só saídas → unsubscribe
function syncSub() {
  if (!open || opT) return;
  const adds = [...wanted].filter((id) => !subscribed.has(id));
  const dels = [...subscribed].filter((id) => !wanted.has(id));
  if (!adds.length && !dels.length) return;
  const t = Date.now();
  let at = lastOpAt + OP_GAP_MS;
  if (adds.length && subscribed.size) at = Math.max(at, lastSubAt + ADD_GAP_MS); // a primeira subscrição vai logo
  if (at > t) { opT = setTimeout(() => { opT = null; syncSub(); }, at - t); return; }
  lastOpAt = t;
  if (adds.length || !subscribed.size) {
    const list = [...wanted].sort();
    if (!list.length) { send({ op: 'unsubscribe' }); subscribed = new Set(); return; }
    send({ op: 'subscribe', fixtures: list, stats: true });
    subscribed = new Set(list); lastSubAt = t; counters.subs++;
  } else if (dels.length >= subscribed.size) {
    send({ op: 'unsubscribe' }); // sai tudo: "parar tudo" explícito (uma lista vazia na fonte pode querer dizer "todos os jogos")
  } else {
    send({ op: 'unsubscribe', fixtures: dels });
    for (const id of dels) subscribed.delete(id);
  }
  for (const id of dels) state.delete(id);
  if ([...wanted].some((id) => !subscribed.has(id)) || [...subscribed].some((id) => !wanted.has(id))) syncSub();
}

/* ---------------- mensagens ---------------- */
function handle(m) {
  if (m.server_time) { const st = Date.parse(m.server_time); if (st) clockOffset = st - Date.now(); }
  const id = m.fixture != null ? String(m.fixture) : null;
  switch (m.type) {
    case 'snapshot': {
      if (!wanted.has(id)) return;
      counters.snapshots++;
      const old = state.get(id);
      const s = { quotes: new Map(), status: { ...(m.group_status || {}) }, polledAt: m.polled_at || null, refreshS: m.refresh_s || null, stale: !!m.stale, stats: old?.stats || null, at: Date.now() };
      for (const q of m.quotes || []) s.quotes.set(qkey(q), q);
      state.set(id, s); changed(id); return;
    }
    case 'delta': {
      const s = state.get(id);
      if (!s) return;
      counters.deltas++;
      for (const q of m.quotes || []) s.quotes.set(qkey(q), q); // a cotação nova substitui a anterior por inteiro
      Object.assign(s.status, m.group_status || {});
      s.at = Date.now(); changed(id); return;
    }
    case 'remove': {
      counters.removes++;
      if (!m.quotes) { // o jogo saiu da oferta: deixa de se poder apostar já
        if (state.delete(id) || wanted.has(id)) changed(id, true);
        return;
      }
      const s = state.get(id);
      if (!s) return;
      for (const q of m.quotes) {
        if (!s.quotes.delete(qkey(q))) { // a remoção pode vir sem o código do mercado: procura pela seleção no mesmo grupo
          for (const [k, x] of s.quotes) if (x.sel_id === q.sel_id && x.group_id === q.group_id) { s.quotes.delete(k); break; }
        }
      }
      s.at = Date.now(); changed(id); return;
    }
    case 'status': {
      const s = state.get(id);
      if (!s) return;
      // com refresh_s/polled_at é sobre o jogo inteiro (vem sem "stale" quando volta ao normal); senão só sobre mercados
      if ('refresh_s' in m || 'polled_at' in m) { s.stale = !!m.stale; if (m.polled_at) s.polledAt = m.polled_at; if (m.refresh_s) s.refreshS = m.refresh_s; }
      Object.assign(s.status, m.group_status || {});
      changed(id); return;
    }
    case 'polled': {
      for (const [fid, at] of Object.entries(m.fixtures || {})) {
        const s = state.get(fid);
        if (!s) continue;
        const was = s.polledAt;
        s.polledAt = at;
        // um jogo parado há mais de 30 s volta a ser confirmado: o site tem de saber (destrava as odds)
        if (!was || Date.parse(at) - Date.parse(was) > 30000) changed(fid);
      }
      return;
    }
    case 'stats': {
      counters.stats++;
      const s = state.get(id);
      if (s) { s.stats = m.stats; s.at = Date.now(); changed(id); }
      else if (wanted.has(id)) state.set(id, { quotes: new Map(), status: {}, polledAt: null, stats: m.stats, at: Date.now(), partial: true });
      return;
    }
    case 'feed': {
      const prev = JSON.stringify(health);
      health = {};
      for (const [sp, v] of Object.entries(m.feed?.sports || {})) health[sp] = { live: v.live?.state || 'ok', pre: v.pre_match?.state || 'ok', reason: v.live?.reason || v.pre_match?.reason || null };
      if (prev !== JSON.stringify(health) && prev !== 'null') {
        const bad = Object.entries(health).filter(([, v]) => v.live !== 'ok' || v.pre !== 'ok').map(([k, v]) => `${k}: ao vivo ${v.live}, antes ${v.pre}${v.reason ? ` (${v.reason})` : ''}`);
        console.log(`[MoviOdds WS] saúde da fonte: ${bad.length ? bad.join(' · ') : 'tudo ok'}`);
        for (const fid of state.keys()) changed(fid); // as odds bloqueiam/desbloqueiam conforme a saúde
      }
      return;
    }
    case 'lagged': case 'resync':
      // ficámos para trás (ou a fonte perdeu mensagens): as fotografias novas dos jogos afetados chegam sozinhas
      counters[m.type]++;
      console.warn(`[MoviOdds WS] ${m.type} (${m.dropped ?? m.server_dropped ?? '?'} mensagens perdidas): à espera das fotografias novas`);
      return;
    case 'error': console.warn('[MoviOdds WS] erro da fonte:', m.error); return;
  }
}

/* ---------------- ligação ---------------- */
function scheduleReconnect(code) {
  // 1001 = a fonte reiniciou: 3 s, depois 3, 6, 12, 24 e 30 s (como pedem); outros casos: 1 s a dobrar até 30 s
  let wait;
  if (code === 1001) { wait = [3000, 3000, 6000, 12000, 24000][restartRetry] ?? 30000; restartRetry++; }
  else { wait = Math.min(1000 * 2 ** retry, 30000); retry++; }
  setTimeout(connect, wait);
}

function connect() {
  if (OFF || connecting || open) return;
  connecting = true;
  try {
    // chave no cabeçalho (fica fora dos registos de endereços)
    ws = new WebSocket(URL_WS, KEY ? { headers: { 'X-API-Key': KEY } } : undefined);
  } catch (e) {
    connecting = false; console.error('[MoviOdds WS] não foi possível ligar:', e.message); scheduleReconnect(0); return;
  }
  ws.onopen = () => {
    open = true; connecting = false; retry = 0; restartRetry = 0; lastMsg = Date.now(); counters.connects++;
    subscribed = new Set(); lastOpAt = 0; lastSubAt = 0; clearTimeout(opT); opT = null;
    console.log('[MoviOdds WS] ligado: odds ao vivo empurradas em tempo real');
    syncSub();
    clearInterval(pingT);
    pingT = setInterval(() => {
      const quiet = Date.now() - lastMsg;
      if (quiet > QUIET_CLOSE_MS) { console.warn('[MoviOdds WS] sem mensagens há 45 s: a religar'); try { ws.close(4000, 'quiet'); } catch { /* */ } return; }
      if (quiet > QUIET_PING_MS) send({ op: 'ping' });
    }, 5000);
  };
  ws.onmessage = (e) => {
    lastMsg = Date.now(); counters.msgs++;
    if (typeof e.data !== 'string') return;
    counters.bytes += e.data.length;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    for (const x of Array.isArray(m) ? m : [m]) handle(x);
  };
  ws.onclose = (e) => {
    const was = open;
    open = false; connecting = false; clearInterval(pingT); clearTimeout(opT); opT = null;
    const ids = [...state.keys()];
    state.clear(); health = null; subscribed = new Set();
    if (was) {
      console.warn(`[MoviOdds WS] ligação caiu (código ${e.code}): odds ao vivo pelos pedidos normais até voltar`);
      for (const id of ids) changed(id);
      try { onDown(); } catch { /* */ }
    }
    scheduleReconnect(e.code);
  };
  ws.onerror = () => { /* o onclose trata */ };
}

module.exports = {
  // começa a ligação; cb(ids, removidos) é chamado com os jogos que mudaram; down() quando a ligação cai
  start(cb, down) { onChange = cb; if (down) onDown = down; connect(); },
  // jogos a seguir (ao vivo e a começar): a subscrição acompanha a lista, sem rajadas
  want(ids) {
    wanted = new Set([...ids].map(String));
    for (const id of state.keys()) if (!wanted.has(id)) state.delete(id);
    syncSub();
  },
  // estado atual de um jogo (null se não houver fotografia pelo WebSocket)
  get(id) { const s = state.get(String(id)); return open && s && !s.partial ? s : null; },
  stats(id) { return open ? state.get(String(id))?.stats || null : null; },
  // saúde da fonte numa modalidade (nome da MoviOdds): { live, pre } com 'ok' | 'degraded' | 'down'; null = sem informação
  health(srcSport) { return open && health ? health[srcSport] || null : null; },
  now: () => Date.now() + clockOffset, // hora da fonte (para a frescura das odds, sem confiar no nosso relógio)
  isOpen: () => open,
  info: () => {
    const secs = Math.max(1, (Date.now() - counters.since) / 1000);
    return {
      open, wanted: wanted.size, subscribed: subscribed.size, withData: [...state.values()].filter((s) => !s.partial).length,
      clockOffsetMs: clockOffset, health, ...counters, kbPerSec: Math.round(counters.bytes / 1024 / secs), msgsPerSec: Math.round(counters.msgs / secs),
    };
  },
};
