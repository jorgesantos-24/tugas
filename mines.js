'use strict';
/* MINES — tabuleiro 5x5 com minas escondidas. O jogador escolhe quantas minas (1 a 24), aposta e vai abrindo casas:
   cada diamante sobe o multiplicador; uma mina perde a aposta. Pode sacar a qualquer momento depois da 1.ª casa.
   O server.js só carrega este módulo junto com o cassino (emuladores com CASINO_TEST=1, ou produção com
   MINES_LIVE=1 + MINES_CERT — chave própria). Mudanças à matemática ou ao código do jogo exigem nova certificação.

   Justo e verificável: no início de cada jogo mostramos sha256(semente); no fim revelamos a semente.
   As minas = as primeiras N casas de um baralhamento feito com HMAC-SHA256(semente, idDoJogo:i).
   Multiplicador depois de k diamantes com N minas = 0,97 × Π (25−i)/(25−N−i), i = 0..k−1  (RTP 97%).

   Firestore:
     minesGames/{id}   cada jogo (open → won | lost), com a semente (só o servidor lê a base) */

const crypto = require('node:crypto');

module.exports = function minesGame(routes, D) {
  const { db, runTx, addTx, col, inc, fail, now, brl, fromCents, toCents, requireUser, isExcluded, pausedMsg,
    lossStats, effLimit, dayKey, DAY, meUser, HttpError } = D;

  const CELLS = 25;
  const EDGE = 0.03;                                                 // margem da casa (RTP 97%)
  const MIN_BET = 100;                                               // R$ 1
  const MAX_BET = toCents(process.env.MINES_MAX_BET || 1000);        // R$ 1.000
  const MAX_WIN = toCents(process.env.MINES_MAX_WIN || 10000);       // R$ 10.000 por jogo
  const games = () => db.collection('minesGames');

  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;
  const maskName = (n) => { const p = String(n || 'Jogador').trim().split(/\s+/)[0]; return p.length <= 2 ? p + '***' : p.slice(0, 2) + '***' + p.slice(-1); };

  // multiplicador depois de k casas seguras com m minas
  function multFor(k, m) {
    if (k <= 0) return 1;
    let x = 1 - EDGE;
    for (let i = 0; i < k; i++) x *= (CELLS - i) / (CELLS - m - i);
    return floor2(x);
  }

  // posições das minas: baralhamento Fisher-Yates com números do HMAC
  function minePositions(seed, id, m) {
    const cells = Array.from({ length: CELLS }, (_, i) => i);
    for (let i = CELLS - 1; i > 0; i--) {
      const h = crypto.createHmac('sha256', seed).update(`${id}:${i}`).digest('hex');
      const r = parseInt(h.slice(0, 13), 16) / 2 ** 52; // 0 ≤ r < 1
      const j = Math.floor(r * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    return cells.slice(0, m).sort((a, b) => a - b);
  }

  const active = new Map();   // uid → jogo em curso
  const feed = [];            // últimos jogos terminados (todos os jogadores)
  const topWins = [];         // maiores prêmios das últimas 24h
  const locks = new Map();    // uid → fila de pedidos (um de cada vez por jogador)

  function withLock(uid, fn) {
    const prev = locks.get(uid) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(uid, tail);
    tail.then(() => { if (locks.get(uid) === tail) locks.delete(uid); });
    return run;
  }

  async function persist(label, fn) {
    for (let i = 1; i <= 4; i++) {
      try { return await fn(); } catch (e) {
        if (e instanceof HttpError) throw e;
        console.error(`[Mines] Erro ao gravar ${label} (tentativa ${i}/4):`, e.message);
        if (i === 4) fail(503, 'Falha ao gravar a jogada. Tente de novo.');
        await new Promise((r) => setTimeout(r, 300 * i));
      }
    }
  }

  function finish(g) {
    active.delete(g.uid);
    feed.unshift({ name: g.name, stake: g.stake, mines: g.mines, picks: g.revealed.length, mult: g.status === 'won' ? g.mult : null, payout: g.payout || 0, status: g.status, at: now() });
    feed.length = Math.min(feed.length, 40);
    if (g.status === 'won') {
      topWins.push({ name: g.name, stake: g.stake, mines: g.mines, mult: g.mult, payout: g.payout, at: now() });
      const cut = now() - DAY;
      const keep = topWins.filter((w) => w.at > cut).sort((a, b) => b.payout - a.payout).slice(0, 30);
      topWins.length = 0; topWins.push(...keep);
    }
  }

  const payoutOf = (g, k = g.revealed.length) => Math.min(MAX_WIN, Math.floor(g.stake * multFor(k, g.mines)));
  const pubGame = (g) => {
    if (!g) return null;
    const k = g.revealed.length, ended = g.status !== 'open';
    const safeLeft = CELLS - g.mines - k;
    return {
      id: g.id, hash: g.hash, stake: fromCents(g.stake), mines: g.mines, revealed: g.revealed, status: g.status,
      mult: multFor(k, g.mines), payout: fromCents(g.status === 'won' ? g.payout : payoutOf(g)),
      next: safeLeft > 0 ? multFor(k + 1, g.mines) : null, hit: g.hit ?? null,
      minesAt: ended ? g.mineList : null, seed: ended ? g.seed : null,
    };
  };

  // paga o prêmio e fecha o jogo
  async function cashOut(g) {
    const k = g.revealed.length;
    const mult = multFor(k, g.mines), payout = payoutOf(g, k);
    await persist(`prêmio ${g.id}`, () => runTx([g.uid], async (t) => {
      const ref = games().doc(g.id);
      const s = await t.get(ref);
      if (!s.exists || s.data().status !== 'open') fail(409, 'Este jogo já terminou.');
      t.update(ref, { status: 'won', mult, payout, revealed: g.revealed, settledAt: now() });
      t.update(col.user(g.uid), { balance: inc(payout), [`daily.${g.day}.returned`]: inc(payout) });
      addTx(t, g.uid, `Mines: prêmio ${mult.toFixed(2)}x`, payout, g.id);
    }));
    g.status = 'won'; g.mult = mult; g.payout = payout;
    finish(g);
  }

  Object.assign(routes, {
    'GET /api/mines/state': (ctx) => ({
      now: now(),
      game: ctx.user ? pubGame(active.get(ctx.user.id)) : null,
      feed: feed.slice(0, 30).map((f) => ({ ...f, stake: fromCents(f.stake), payout: fromCents(f.payout) })),
      top: topWins.slice(0, 20).map((w) => ({ ...w, stake: fromCents(w.stake), payout: fromCents(w.payout) })),
      limits: { min: fromCents(MIN_BET), max: fromCents(MAX_BET), maxWin: fromCents(MAX_WIN), edge: EDGE },
    }),

    // histórico do próprio jogador
    'GET /api/mines/my': async (ctx) => {
      const u = requireUser(ctx);
      const s = await games().where('userId', '==', u.id).orderBy('placedAt', 'desc').limit(40).get();
      return { games: s.docs.map((d) => d.data()).filter((g) => g.status !== 'open').map((g) => ({
        id: g.id, at: g.placedAt, stake: fromCents(g.stake), mines: g.mines, picks: (g.revealed || []).length,
        status: g.status, mult: g.mult ?? null, payout: fromCents(g.payout ?? 0),
      })) };
    },

    // dados para conferir um jogo terminado (só o próprio jogador)
    'GET /api/mines/game': async (ctx) => {
      const u = requireUser(ctx);
      const id = String(new URL(ctx.req.url, 'http://x').searchParams.get('id') || '');
      const s = await games().doc(id).get();
      if (!s.exists || s.data().userId !== u.id) fail(404, 'Jogo não encontrado.');
      const g = s.data();
      if (g.status === 'open') fail(409, 'O jogo ainda está a decorrer.');
      const check = minePositions(g.seed, g.id, g.mines);
      return { game: { id: g.id, at: g.placedAt, hash: g.hash, seed: g.seed, mines: g.mines, minesAt: check, hashOk: sha(g.seed) === g.hash, status: g.status, mult: g.mult ?? null } };
    },

    'POST /api/mines/start': (ctx) => {
      const u = requireUser(ctx);
      return withLock(u.id, async () => {
        if (isExcluded(u)) fail(403, pausedMsg(u));
        if (active.has(u.id)) fail(409, 'Termine o jogo atual antes de começar outro.');
        const stake = toCents(ctx.body.amount);
        if (!(stake >= MIN_BET && stake <= MAX_BET)) fail(400, `Aposta entre ${brl(MIN_BET)} e ${brl(MAX_BET)}.`);
        const mines = Math.floor(Number(ctx.body.mines));
        if (!(mines >= 1 && mines <= 24)) fail(400, 'Escolha entre 1 e 24 minas.');
        const id = 'MG' + crypto.randomBytes(6).toString('hex').toUpperCase();
        const seed = crypto.randomBytes(32).toString('hex');
        const day = dayKey();
        const g = { id, uid: u.id, name: maskName(u.name), stake, mines, seed, hash: sha(seed), mineList: minePositions(seed, id, mines), revealed: [], status: 'open', day };
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
            t.create(games().doc(id), { id, userId: u.id, name: g.name, stake, mines, seed, hash: g.hash, revealed: [], status: 'open', day, placedAt: now() });
            t.update(col.user(u.id), { balance: inc(-stake), daily });
            addTx(t, u.id, `Mines: aposta (${mines} ${mines === 1 ? 'mina' : 'minas'})`, -stake, id);
          });
        } catch (e) {
          if (!(e instanceof HttpError)) { console.error('[Mines] Erro ao gravar aposta:', e.message); fail(503, 'Falha ao gravar a aposta. Tente de novo.'); }
          throw e;
        }
        active.set(u.id, g);
        return { game: pubGame(g), user: await meUser(u.id) };
      });
    },

    'POST /api/mines/reveal': (ctx) => {
      const u = requireUser(ctx);
      return withLock(u.id, async () => {
        const g = active.get(u.id);
        if (!g) fail(404, 'Não tem nenhum jogo a decorrer.');
        const cell = Math.floor(Number(ctx.body.cell));
        if (!(cell >= 0 && cell < CELLS)) fail(400, 'Casa inválida.');
        if (g.revealed.includes(cell)) return { game: pubGame(g) };
        if (g.mineList.includes(cell)) {
          await persist(`jogo ${g.id}`, () => games().doc(g.id).update({ status: 'lost', hit: cell, revealed: g.revealed, settledAt: now() }));
          g.status = 'lost'; g.hit = cell;
          finish(g);
          return { game: pubGame(g) };
        }
        const revealed = [...g.revealed, cell];
        await persist(`jogo ${g.id}`, () => games().doc(g.id).update({ revealed }));
        g.revealed = revealed;
        // todas as casas seguras abertas, ou prêmio no máximo: saca sozinho
        const done = revealed.length >= CELLS - g.mines || Math.floor(g.stake * multFor(revealed.length, g.mines)) >= MAX_WIN;
        if (done) { await cashOut(g); return { game: pubGame(g), user: await meUser(u.id), auto: true }; }
        return { game: pubGame(g) };
      });
    },

    'POST /api/mines/cashout': (ctx) => {
      const u = requireUser(ctx);
      return withLock(u.id, async () => {
        const g = active.get(u.id);
        if (!g) fail(404, 'Não tem nenhum jogo a decorrer.');
        if (!g.revealed.length) fail(409, 'Abra pelo menos uma casa antes de sacar.');
        await cashOut(g);
        return { game: pubGame(g), user: await meUser(u.id) };
      });
    },
  });

  return {
    // retoma jogos que ficaram a meio (servidor reiniciado): o jogador continua de onde parou
    async start() {
      const s = await games().where('status', '==', 'open').get();
      for (const d of s.docs) {
        const x = d.data();
        active.set(x.userId, { id: x.id, uid: x.userId, name: x.name || 'Jogador', stake: x.stake, mines: x.mines, seed: x.seed, hash: x.hash,
          mineList: minePositions(x.seed, x.id, x.mines), revealed: x.revealed || [], status: 'open', day: x.day });
      }
      if (s.size) console.log(`[Mines] ${s.size} jogo(s) a meio retomado(s).`);
      console.log(`[Mines] Jogo ligado${D.EMULATOR ? ' (TESTE LOCAL)' : ` com saldo REAL (certificado ${D.CASINO_CERT})`}: /mines`);
    },
    multFor, minePositions,
  };
};
