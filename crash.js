'use strict';
/* DECOLA — jogo "crash": o avião sobe e o multiplicador cresce; o jogador saca antes de o avião voar embora.
   O server.js só carrega este módulo nos emuladores (teste) ou em produção com CASINO_LIVE=1 + CASINO_CERT
   (certificado do laboratório). Mudanças à matemática ou ao código do jogo exigem nova certificação.

   Rodada:  APOSTAS (7s) → VOO (até o avião voar embora) → FIM (3,5s) → nova rodada
   Justo e verificável: antes da rodada mostramos sha256(semente); depois do fim revelamos a semente.
   O ponto de queda = HMAC-SHA256(semente, idDaRodada) → número entre 1,00x e 1000x (RTP 97%).

   Firestore:
     crashBets/{id}     cada aposta (pending → open → won | lost | canceled)
     crashRounds/{id}   cada rodada (semente, hash, ponto de queda, totais) */

const crypto = require('node:crypto');

module.exports = function crashGame(routes, D) {
  const { db, runTx, addTx, col, inc, fail, now, brl, fromCents, toCents, requireUser, isExcluded, pausedMsg,
    lossStats, effLimit, dayKey, DAY, meUser, HttpError } = D;

  const EDGE = 0.03;               // margem da casa (RTP 97%)
  const K = 0.08;                  // velocidade da subida: multiplicador = e^(K·segundos)  (2x ≈ 8,7s; 10x ≈ 29s)
  const BET_MS = 7000, END_MS = 3500, TICK_MS = 50;
  const MAX_MULT = 1000;
  const MIN_BET = 100;                                              // R$ 1
  const MAX_BET = toCents(process.env.CRASH_MAX_BET || 1000);       // R$ 1.000
  const MAX_WIN = toCents(process.env.CRASH_MAX_WIN || 10000);      // R$ 10.000 por aposta
  const bets = () => db.collection('crashBets');
  const rounds = () => db.collection('crashRounds');

  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;
  const multAt = (ms) => floor2(Math.exp((K * ms) / 1000));
  const msFor = (m) => (Math.log(m) / K) * 1000;
  const maskName = (n) => { const p = String(n || 'Jogador').trim().split(/\s+/)[0]; return p.length <= 2 ? p + '***' : p.slice(0, 2) + '***' + p.slice(-1); };

  function crashPoint(seed, id) {
    const h = crypto.createHmac('sha256', seed).update(id).digest('hex');
    const r = parseInt(h.slice(0, 13), 16) / 2 ** 52; // 0 ≤ r < 1
    return Math.min(MAX_MULT, Math.max(1, floor2((1 - EDGE) / (1 - r))));
  }

  let R = null;            // rodada atual
  const history = [];      // rodadas terminadas (mais recente primeiro)
  const topWins = [];      // maiores prêmios das últimas 24h (em memória)
  const chat = []; let chatSeq = 0; const chatLast = new Map(); // chat da sala (últimas 60 mensagens)

  function addTopWin(b, m) {
    topWins.push({ name: b.name, stake: b.stake, cashout: m, payout: b.payout, at: now(), roundId: b.roundId });
    const cut = now() - DAY;
    const keep = topWins.filter((w) => w.at > cut).sort((a, c) => c.payout - a.payout).slice(0, 30);
    topWins.length = 0; topWins.push(...keep);
  }

  function newRound() {
    const seed = crypto.randomBytes(32).toString('hex');
    const id = 'R' + now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
    R = { id, seed, hash: sha(seed), crash: crashPoint(seed, id), phase: 'BETTING', betUntil: now() + BET_MS, startAt: null, crashAt: null, nextAt: null, bets: new Map() };
  }

  // alvo de saque automático de uma aposta (o menor entre o pedido e o prêmio máximo)
  const targetOf = (b) => Math.min(b.auto || Infinity, Math.max(1.01, floor2(MAX_WIN / b.stake)));

  /* ---- gravação no Firestore ---- */
  async function persist(label, fn) {
    for (let i = 1; i <= 5; i++) {
      try { return await fn(); } catch (e) {
        console.error(`[Decola] Erro ao gravar ${label} (tentativa ${i}/5):`, e.message);
        if (i === 5) throw e;
        await new Promise((r) => setTimeout(r, 400 * i));
      }
    }
  }

  function cashOut(b, m) {
    if (b.status !== 'open') return b.done;
    b.status = 'won'; b.cashout = m; b.payout = Math.min(MAX_WIN, Math.floor(b.stake * m));
    addTopWin(b, m);
    b.done = persist(`prêmio ${b.id}`, () => runTx([b.uid], async (t) => {
      const ref = bets().doc(b.id);
      const s = await t.get(ref);
      if (!s.exists || s.data().status !== 'open') return;
      t.update(ref, { status: 'won', cashout: m, payout: b.payout, settledAt: now() });
      t.update(col.user(b.uid), { balance: inc(b.payout), [`daily.${dayKey()}.returned`]: inc(b.payout) });
      addTx(t, b.uid, `Decola: prêmio ${m.toFixed(2)}x`, b.payout, b.id);
    })).catch(() => console.error(`[Decola] ATENÇÃO: prêmio ${b.id} (${brl(b.payout)}) não gravado. Confira crashBets.`));
    return b.done;
  }

  // devolve uma aposta (cancelada ou interrompida): desfaz o débito e o "apostado do dia"
  function refund(betDoc, why) {
    return persist(`devolução ${betDoc.id}`, () => runTx([betDoc.uid], async (t) => {
      const ref = bets().doc(betDoc.id);
      const s = await t.get(ref);
      if (!s.exists || !['pending', 'open'].includes(s.data().status)) return;
      const day = s.data().day;
      t.update(ref, { status: 'canceled', settledAt: now(), note: why });
      const patch = { balance: inc(betDoc.stake) };
      if (day) patch[`daily.${day}.staked`] = inc(-betDoc.stake);
      t.update(col.user(betDoc.uid), patch);
      addTx(t, betDoc.uid, 'Decola: aposta devolvida', betDoc.stake, betDoc.id);
    }));
  }

  function endRound() {
    const r = R;
    r.phase = 'CRASHED'; r.nextAt = now() + END_MS;
    const lost = [];
    for (const b of r.bets.values()) {
      if (b.status !== 'open') continue;
      const tg = targetOf(b);
      if (tg < r.crash) cashOut(b, tg); // saque automático que o relógio não chegou a apanhar
      else { b.status = 'lost'; lost.push(b); }
    }
    const list = [...r.bets.values()].filter((b) => ['won', 'lost'].includes(b.status));
    history.unshift({ id: r.id, crash: r.crash, hash: r.hash, seed: r.seed, at: r.crashAt });
    history.length = Math.min(history.length, 50);
    persist(`rodada ${r.id}`, async () => {
      const batch = db.batch();
      for (const b of lost) batch.update(bets().doc(b.id), { status: 'lost', settledAt: now() });
      for (const b of list) batch.update(bets().doc(b.id), { crash: r.crash });
      batch.set(rounds().doc(r.id), {
        id: r.id, hash: r.hash, seed: r.seed, crash: r.crash, startAt: r.startAt, crashAt: r.crashAt, players: list.length,
        staked: list.reduce((s, b) => s + b.stake, 0), paid: list.reduce((s, b) => s + (b.payout || 0), 0),
      });
      await batch.commit();
    }).catch(() => {});
  }

  function tick() {
    const t = now();
    if (R.phase === 'BETTING' && t >= R.betUntil) {
      R.phase = 'FLYING'; R.startAt = t; R.crashAt = t + msFor(R.crash);
    }
    if (R.phase === 'FLYING') {
      if (t >= R.crashAt) return endRound();
      const m = multAt(t - R.startAt);
      for (const b of R.bets.values()) if (b.status === 'open') { const tg = targetOf(b); if (m >= tg) cashOut(b, tg); }
    } else if (R.phase === 'CRASHED' && t >= R.nextAt) newRound();
  }

  const pubBet = (b) => b && ({ id: b.id, slot: b.slot, stake: fromCents(b.stake), auto: b.auto, status: b.status, cashout: b.cashout ?? null, payout: fromCents(b.payout ?? null), roundId: b.roundId });
  const myBets = (r, uid) => [0, 1].map((s) => pubBet(r.bets.get(uid + ':' + s)) || null);

  Object.assign(routes, {
    'GET /api/crash/state': (ctx) => {
      const r = R;
      const players = [...r.bets.values()].filter((b) => ['open', 'won', 'lost'].includes(b.status))
        .sort((a, b) => b.stake - a.stake).slice(0, 60)
        .map((b) => ({ name: b.name, stake: fromCents(b.stake), cashout: b.cashout ?? null, payout: fromCents(b.payout ?? null), status: b.status }));
      return {
        now: now(),
        round: { id: r.id, hash: r.hash, phase: r.phase, betUntil: r.betUntil, startAt: r.startAt, nextAt: r.nextAt, crash: r.phase === 'CRASHED' ? r.crash : null, k: K },
        players, count: players.length,
        history: history.slice(0, 30).map((h) => ({ id: h.id, crash: h.crash })),
        mine: ctx.user ? myBets(r, ctx.user.id) : [null, null],
        chat: chat.slice(-40),
        top: topWins.slice(0, 20).map((w) => ({ name: w.name, stake: fromCents(w.stake), cashout: w.cashout, payout: fromCents(w.payout), at: w.at })),
        limits: { min: fromCents(MIN_BET), max: fromCents(MAX_BET), maxWin: fromCents(MAX_WIN) },
      };
    },

    // dados para conferir uma rodada já terminada
    'GET /api/crash/round': (ctx) => {
      const id = String(new URL(ctx.req.url, 'http://x').searchParams.get('id') || '');
      const h = history.find((x) => x.id === id);
      if (!h) fail(404, 'Rodada não encontrada.');
      return { round: { ...h, check: crashPoint(h.seed, h.id), hashOk: sha(h.seed) === h.hash } };
    },

    // histórico do próprio jogador
    'GET /api/crash/my': async (ctx) => {
      const u = requireUser(ctx);
      const s = await bets().where('userId', '==', u.id).orderBy('placedAt', 'desc').limit(40).get();
      return { bets: s.docs.map((d) => d.data()).filter((b) => b.status !== 'canceled').map((b) => ({
        id: b.id, at: b.placedAt, stake: fromCents(b.stake), status: b.status, cashout: b.cashout ?? null, payout: fromCents(b.payout ?? null), crash: b.crash ?? null,
      })) };
    },

    'POST /api/crash/chat': (ctx) => {
      const u = requireUser(ctx);
      const text = String(ctx.body.text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!text) fail(400, 'Mensagem vazia.');
      if (now() - (chatLast.get(u.id) || 0) < 2500) fail(429, 'Espere um pouco antes de mandar outra mensagem.');
      chatLast.set(u.id, now());
      chat.push({ id: ++chatSeq, name: maskName(u.name), text, at: now() });
      if (chat.length > 60) chat.shift();
      return { ok: true };
    },

    'POST /api/crash/bet': async (ctx) => {
      const u = requireUser(ctx);
      if (isExcluded(u)) fail(403, pausedMsg(u));
      const slot = Number(ctx.body.slot) === 1 ? 1 : 0;
      const stake = toCents(ctx.body.amount);
      if (!(stake >= MIN_BET && stake <= MAX_BET)) fail(400, `Aposta entre ${brl(MIN_BET)} e ${brl(MAX_BET)}.`);
      let auto = ctx.body.auto == null || ctx.body.auto === '' ? null : floor2(Number(ctx.body.auto));
      if (auto != null && !(auto >= 1.01 && auto <= MAX_MULT)) fail(400, 'Saque automático entre 1,01x e 1000x.');
      const r = R;
      if (r.phase !== 'BETTING' || now() > r.betUntil - 250) fail(409, 'As apostas desta rodada fecharam. Aguarde a próxima.');
      const key = u.id + ':' + slot;
      if (r.bets.has(key)) fail(409, 'Já tem uma aposta neste painel.');
      const b = { id: 'CB' + crypto.randomBytes(6).toString('hex').toUpperCase(), uid: u.id, name: maskName(u.name), slot, stake, auto, status: 'pending', roundId: r.id, cashout: null, payout: null };
      r.bets.set(key, b); // reserva o painel enquanto grava
      const day = dayKey();
      try {
        await runTx([u.id], async (t) => {
          const fu = (await t.get(col.user(u.id))).data();
          if (fu.blocked) fail(403, 'Conta bloqueada.');
          if (isExcluded(fu)) fail(403, pausedMsg(fu));
          if (stake > fu.balance) fail(400, 'Saldo insuficiente.');
          const loss = lossStats(fu);
          const ld = effLimit(fu, 'lossLimitDay'), lm = effLimit(fu, 'lossLimitMonth');
          if (ld != null && loss.day + stake > ld) fail(400, `Limite de perda diário (restam ${brl(Math.max(0, ld - loss.day))}).`);
          if (lm != null && loss.month + stake > lm) fail(400, `Limite de perda mensal (restam ${brl(Math.max(0, lm - loss.month))}).`);
          const oldest = dayKey(now() - 40 * DAY);
          const daily = Object.fromEntries(Object.entries(fu.daily || {}).filter(([k]) => k >= oldest));
          daily[day] = { staked: (daily[day]?.staked || 0) + stake, returned: daily[day]?.returned || 0 };
          t.create(bets().doc(b.id), { id: b.id, userId: u.id, roundId: r.id, slot, stake, auto, status: 'open', day, placedAt: now() });
          t.update(col.user(u.id), { balance: inc(-stake), daily });
          addTx(t, u.id, 'Decola: aposta', -stake, b.id);
        });
      } catch (e) {
        r.bets.delete(key);
        if (!(e instanceof HttpError)) console.error('[Decola] Erro ao gravar aposta:', e.message);
        throw e;
      }
      if (b.status === 'canceled' || R !== r || r.phase !== 'BETTING') { // a rodada começou durante a gravação
        r.bets.delete(key);
        await refund(b, 'rodada começou antes da confirmação');
        fail(409, 'A rodada começou antes de a aposta ser confirmada. O valor voltou ao saldo.');
      }
      b.status = 'open';
      return { mine: myBets(r, u.id), user: await meUser(u.id) };
    },

    'POST /api/crash/cancel': async (ctx) => {
      const u = requireUser(ctx);
      const slot = Number(ctx.body.slot) === 1 ? 1 : 0;
      const r = R, key = u.id + ':' + slot, b = r.bets.get(key);
      if (!b) fail(404, 'Sem aposta neste painel.');
      if (r.phase !== 'BETTING' || b.status !== 'open') fail(409, 'Já não dá para cancelar: a rodada começou.');
      b.status = 'canceled'; r.bets.delete(key);
      await refund(b, 'cancelada pelo jogador');
      return { mine: myBets(r, u.id), user: await meUser(u.id) };
    },

    'POST /api/crash/cashout': async (ctx) => {
      const u = requireUser(ctx);
      const t = now();
      const slot = Number(ctx.body.slot) === 1 ? 1 : 0;
      const r = R, b = r.bets.get(u.id + ':' + slot);
      if (!b) fail(404, 'Sem aposta neste painel.');
      if (b.status === 'won') { await b.done; return { mine: myBets(r, u.id), user: await meUser(u.id) }; } // já saiu no automático
      if (r.phase !== 'FLYING' || b.status !== 'open' || t >= r.crashAt) fail(409, 'O avião já voou embora.');
      await cashOut(b, Math.min(multAt(t - r.startAt), targetOf(b)));
      return { mine: myBets(r, u.id), user: await meUser(u.id) };
    },
  });

  return {
    // devolve apostas que ficaram a meio (servidor reiniciado durante uma rodada) e arranca as rodadas
    async start() {
      const s = await bets().where('status', 'in', ['pending', 'open']).get();
      for (const d of s.docs) { const x = d.data(); await refund({ id: x.id, uid: x.userId, stake: x.stake }, 'servidor reiniciado durante a rodada'); }
      if (s.size) console.log(`[Decola] ${s.size} aposta(s) interrompida(s) devolvida(s).`);
      newRound();
      setInterval(tick, TICK_MS);
      console.log(`[Decola] Jogo ligado${D.EMULATOR ? ' (TESTE LOCAL)' : ` com saldo REAL (certificado ${D.CASINO_CERT})`}: /decola`);
    },
  };
};
