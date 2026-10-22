'use strict';
/* Painel da equipa (/admin): pedidos de saque, depósitos, jogadores e registo de ações.
   Só entra quem está em ADMIN_EMAILS (no .env) e tem o e-mail confirmado.
   Tudo o que a equipa faz fica gravado em adminLogs. */

const { AggregateField } = require('firebase-admin/firestore');

module.exports = function adminRoutes(routes, D) {
  const { db, col, auth, FieldValue, runTx, addTx, getUser, dirty, fail, now, brl, fromCents, toCents, dayStart } = D;
  const inc = (n) => FieldValue.increment(n);
  const WD_LABEL = { PENDING: 'pendente', PROCESSING: 'em processamento', PAID: 'pago', REJECTED: 'recusado', CANCELED: 'cancelado pelo jogador' };
  const fmtCpf = (c) => (c && c.length === 11 ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : c || '');

  async function requireAdmin(ctx) {
    const u = D.requireUser(ctx);
    if (!D.ADMIN_EMAILS.has(u.email)) fail(403, 'Acesso reservado à equipa.');
    const a = await D.authInfo(u.id);
    if (!a.emailVerified) fail(403, 'Confirme o seu e-mail antes de usar o painel.');
    return u;
  }
  // registo de auditoria (dentro de uma transação/batch, ou sozinho)
  function log(w, admin, action, target, details) {
    const entry = { at: now(), admin: admin.email, adminId: admin.id, action, target: target || null, details: details || null };
    if (w) w.set(col.adminLogs().doc(), entry); else return col.adminLogs().add(entry);
  }
  const reasonOf = (v, min = 3) => {
    const r = String(v || '').trim().slice(0, 300);
    if (r.length < min) fail(400, 'Escreva o motivo.');
    return r;
  };
  const qp = (ctx, k) => new URL(ctx.req.url, 'http://x').searchParams.get(k) || '';

  const pubWd = (w) => ({
    id: w.id, userId: w.userId, userName: w.userName, userEmail: w.userEmail, amount: fromCents(w.amount), status: w.status,
    statusLabel: WD_LABEL[w.status] || w.status, pixKey: fmtCpf(w.pixKey), pixKeyRaw: w.pixKey, pixKeyType: w.pixKeyType,
    createdAt: w.createdAt, updatedAt: w.updatedAt, handledBy: w.handledBy || null, note: w.note || null, paidAt: w.paidAt || null, proof: w.proof || null,
  });
  const pubDep = (d) => ({
    id: d.id, userId: d.userId, userName: d.userName || null, userEmail: d.userEmail || null, amount: fromCents(d.amount), status: d.status,
    bpId: d.bpId || null, createdAt: d.createdAt, paidAt: d.paidAt || null, fee: fromCents(d.fee ?? null), reviewReason: d.reviewReason || null,
    paidAmount: fromCents(d.paidAmount ?? null), note: d.note || null,
  });
  const pubPlayer = (u) => ({
    id: u.id, name: u.name, email: u.email, cpf: fmtCpf(u.cpf), birthdate: u.birthdate, balance: fromCents(u.balance),
    blocked: !!u.blocked, blockedReason: u.blockedReason || null, emailVerified: !!u.emailVerified, createdAt: u.createdAt, lastLogin: u.lastLogin,
    excludedUntil: u.excludedUntil && u.excludedUntil > now() ? u.excludedUntil : null,
    depositLimit: fromCents(u.depositLimit ?? null), lossLimitDay: fromCents(u.lossLimitDay ?? null), lossLimitMonth: fromCents(u.lossLimitMonth ?? null),
  });

  // apostas
  const LEG_VALUE = { won: 1, lost: -1, void: 0 };
  const BET_LABEL = { open: 'em aberto', won: 'ganha', lost: 'perdida', void: 'devolvida', cashout: 'cash out' };
  const LATE_MS = 3 * 3600000;
  // precisa de atenção: atrasada (jogo começou há +3h) ou a segunda fonte não confirmou o placar
  const legIssue = (l) => { if (l.result) return null; const v = D.VF.verdict(l.evId); return v && (v.state === 'mismatch' || v.state === 'notfound') ? v.state : null; };
  const isLate = (b, t = now()) => b.legs.some((l) => (!l.result && l.startsAt < t - LATE_MS) || legIssue(l));
  const flashscoreUrl = (event) => 'https://www.google.com/search?q=' + encodeURIComponent(`flashscore ${event.replace(' x ', ' ')}`);
  const legInfo = (l) => {
    const ev = D.eventInfo(l.evId);
    const v = l.result ? null : D.VF.verdict(l.evId);
    return {
      event: l.event, leagueName: l.leagueName, marketName: l.marketName, name: l.name, odds: l.odds, startsAt: l.startsAt,
      result: l.result || null, final: l.final || null, manual: !!l.manual, flashscore: flashscoreUrl(l.event),
      now: ev ? { state: ev.state, score: ev.home.score != null ? `${ev.home.score}-${ev.away.score}` : null, clock: ev.clock, status: ev.statusName } : null,
      verify: v ? { state: v.state, espn: v.espn || null, other: v.h != null ? `${v.h}-${v.a}` : null, status: v.status || null, error: v.error || null } : null,
    };
  };
  const pubBet = (b) => ({
    id: b.id, userId: b.userId, type: b.type, stake: fromCents(b.stake), odds: b.odds, potential: fromCents(b.potential), status: b.status,
    statusLabel: BET_LABEL[b.status] || b.status, payout: fromCents(b.payout), placedAt: b.placedAt, settledAt: b.settledAt || null,
    settledBy: b.settledBy || null, settleNote: b.settleNote || null, legs: b.legs.map(legInfo),
  });
  const betSummary = () => {
    const list = [...D.openBets.values()];
    return { verifyOn: D.VF.enabled, quota: D.VF.quota, open: list.length, late: list.filter((b) => isLate(b)).length, exposure: fromCents(list.reduce((s, b) => s + b.potential, 0)), staked: fromCents(list.reduce((s, b) => s + b.stake, 0)) };
  };

  // muda o estado de um pedido de saque (com regras de quem pode ir para onde)
  async function moveWithdrawal(admin, id, to, fields = {}) {
    if (!/^W[0-9A-F]{12}$/.test(id)) fail(404, 'Saque não encontrado.');
    const from = { PROCESSING: ['PENDING'], PENDING: ['PROCESSING'], PAID: ['PENDING', 'PROCESSING'], REJECTED: ['PENDING', 'PROCESSING'] }[to];
    let w;
    await runTx([], async (t) => {
      const ref = col.withdrawals().doc(id);
      const s = await t.get(ref);
      if (!s.exists) fail(404, 'Saque não encontrado.');
      w = s.data();
      if (!from.includes(w.status)) fail(409, `Este saque está "${WD_LABEL[w.status] || w.status}" e não pode passar a "${WD_LABEL[to]}".`);
      if (to === 'PENDING' && w.handledBy && w.handledBy !== admin.email) fail(409, `Só ${w.handledBy} pode devolver este saque à fila.`);
      const patch = { status: to, updatedAt: now(), ...fields };
      if (to === 'PROCESSING') patch.handledBy = admin.email;
      if (to === 'PENDING') patch.handledBy = null;
      if (to === 'PAID') { patch.paidAt = now(); patch.handledBy = admin.email; }
      if (to === 'REJECTED') patch.handledBy = admin.email;
      t.update(ref, patch);
      const txPatch = { status: to };
      if (to === 'REJECTED') txPatch.note = fields.note;
      t.set(col.txs(w.userId).doc(id), txPatch, { merge: true });
      if (to === 'REJECTED') { // devolve o valor ao jogador
        t.update(col.user(w.userId), { balance: inc(w.amount) });
        addTx(t, w.userId, 'Saque recusado (valor devolvido)', w.amount, id, { note: fields.note });
      }
      log(t, admin, `saque:${to.toLowerCase()}`, id, { amount: w.amount, user: w.userEmail, ...fields });
    });
    dirty(w.userId);
    if (to === 'PAID' || to === 'REJECTED') D.openWithdrawals.delete(id);
    console.log(`[Admin] ${admin.email}: saque ${id} (${brl(w.amount)}, ${w.userEmail}) → ${to}`);
    const s = await col.withdrawals().doc(id).get();
    return { withdrawal: pubWd(s.data()) };
  }

  Object.assign(routes, {
    'GET /api/admin/summary': async (ctx) => {
      await requireAdmin(ctx);
      const open = [...D.openWithdrawals.values()];
      const start = dayStart();
      const [depToday, wdToday, review, agg] = await Promise.all([
        col.deposits().where('createdAt', '>=', start).get(),
        col.withdrawals().where('paidAt', '>=', start).get(),
        col.deposits().where('status', '==', 'REVIEW').get(),
        col.users().aggregate({ n: AggregateField.count(), total: AggregateField.sum('balance') }).get().catch(() => null),
      ]);
      const paidDeps = depToday.docs.map((d) => d.data()).filter((d) => d.status === 'PAID' || d.status === 'REFUNDED' || d.status === 'CHARGEBACK');
      return {
        withdrawals: {
          pending: open.filter((w) => w.status === 'PENDING').length, processing: open.filter((w) => w.status === 'PROCESSING').length,
          openTotal: fromCents(open.reduce((s, w) => s + w.amount, 0)),
          paidToday: wdToday.size, paidTodayTotal: fromCents(wdToday.docs.reduce((s, d) => s + d.data().amount, 0)),
        },
        deposits: {
          today: paidDeps.length, todayTotal: fromCents(paidDeps.reduce((s, d) => s + d.amount, 0)),
          pendingPix: D.pendingDeposits.size, review: review.size,
        },
        users: agg ? { count: agg.data().n, balances: fromCents(agg.data().total || 0) } : null,
        bets: betSummary(),
        gateway: D.BP.enabled ? 'BravoPay' : 'desligado',
      };
    },

    'GET /api/admin/withdrawals': async (ctx) => {
      await requireAdmin(ctx);
      const status = qp(ctx, 'status') || 'OPEN';
      let list;
      if (status === 'OPEN') list = [...D.openWithdrawals.values()].sort((a, b) => a.createdAt - b.createdAt); // mais antigos primeiro
      else {
        const qs = await col.withdrawals().orderBy('createdAt', 'desc').limit(300).get();
        list = qs.docs.map((d) => d.data()).filter((w) => status === 'ALL' || w.status === status);
      }
      return { withdrawals: list.map(pubWd) };
    },

    // "assumir": marca que alguém da equipa está a tratar (evita que duas pessoas paguem o mesmo saque)
    'POST /api/admin/withdrawals/claim': async (ctx) => moveWithdrawal(await requireAdmin(ctx), String(ctx.body.id || ''), 'PROCESSING'),
    'POST /api/admin/withdrawals/release': async (ctx) => moveWithdrawal(await requireAdmin(ctx), String(ctx.body.id || ''), 'PENDING'),
    'POST /api/admin/withdrawals/pay': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const proof = String(ctx.body.proof || '').trim().slice(0, 120); // ID da transação PIX (E2E) ou referência do comprovante
      if (proof.length < 4) fail(400, 'Indique o ID da transação PIX (E2E) ou a referência do comprovante.');
      return moveWithdrawal(admin, String(ctx.body.id || ''), 'PAID', { proof, note: String(ctx.body.note || '').trim().slice(0, 300) || null });
    },
    'POST /api/admin/withdrawals/reject': async (ctx) => {
      const admin = await requireAdmin(ctx);
      return moveWithdrawal(admin, String(ctx.body.id || ''), 'REJECTED', { note: reasonOf(ctx.body.reason) });
    },

    'GET /api/admin/deposits': async (ctx) => {
      await requireAdmin(ctx);
      const status = qp(ctx, 'status') || 'ALL';
      let docs;
      if (status === 'REVIEW' || status === 'PENDING') docs = (await col.deposits().where('status', '==', status).get()).docs.map((d) => d.data()).sort((a, b) => b.createdAt - a.createdAt);
      else docs = (await col.deposits().orderBy('createdAt', 'desc').limit(300).get()).docs.map((d) => d.data()).filter((d) => status === 'ALL' || d.status === status);
      return { deposits: docs.map(pubDep) };
    },

    // depósito "em revisão" (valor pago diferente do pedido): a equipa decide
    'POST /api/admin/deposits/resolve': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const id = String(ctx.body.id || '');
      const action = String(ctx.body.action || '');
      if (!/^D[0-9A-F]{12}$/.test(id) || !['credit', 'dismiss'].includes(action)) fail(400, 'Pedido inválido.');
      const note = reasonOf(ctx.body.reason);
      let credit = 0;
      if (action === 'credit') { credit = toCents(ctx.body.amount); if (!(credit > 0 && credit <= 5000000)) fail(400, 'Valor a creditar inválido.'); }
      let dep;
      await runTx([], async (t) => {
        const ref = col.deposits().doc(id);
        const s = await t.get(ref);
        if (!s.exists) fail(404, 'Depósito não encontrado.');
        dep = s.data();
        if (dep.status !== 'REVIEW') fail(409, 'Este depósito não está em revisão.');
        const uref = col.user(dep.userId);
        const us = await t.get(uref);
        if (action === 'credit') {
          const logArr = D.depositWindow(us.data().depositLog).map((e) => (e.id === id ? { ...e, st: 'OK', amount: credit } : e));
          t.update(ref, { status: 'PAID', paidAt: now(), creditedAmount: credit, note, resolvedBy: admin.email });
          t.update(uref, { balance: inc(credit), depositLog: logArr });
          addTx(t, dep.userId, 'Depósito PIX', credit, id, { note: 'conferido pela equipa' });
        } else {
          t.update(ref, { status: 'DISMISSED', note, resolvedBy: admin.email });
          t.update(uref, { depositLog: D.depositWindow(us.data().depositLog).filter((e) => e.id !== id) });
        }
        log(t, admin, `deposito:${action}`, id, { user: dep.userEmail || dep.userId, credit, note });
      });
      dirty(dep.userId);
      return { ok: true };
    },

    'GET /api/admin/users': async (ctx) => {
      await requireAdmin(ctx);
      const q = qp(ctx, 'q').trim();
      let users = [];
      if (!q) users = (await col.users().orderBy('createdAt', 'desc').limit(50).get()).docs;
      else if (q.includes('@')) users = (await col.users().where('email', '==', q.toLowerCase()).limit(10).get()).docs;
      else if (/^[\d.\-\s]{11,14}$/.test(q)) {
        const c = await col.cpfs().doc(q.replace(/\D/g, '')).get();
        if (c.exists) { const u = await col.user(c.data().uid).get(); if (u.exists) users = [u]; }
      } else {
        const byId = /^[A-Za-z0-9]{20,40}$/.test(q) ? await col.user(q).get() : null;
        if (byId && byId.exists) users = [byId];
        else {
          const cap = q.charAt(0).toUpperCase() + q.slice(1);
          users = (await col.users().where('name', '>=', cap).where('name', '<=', cap + '').limit(30).get()).docs;
        }
      }
      return { users: users.map((d) => pubPlayer({ id: d.id, ...d.data() })) };
    },

    'GET /api/admin/user': async (ctx) => {
      await requireAdmin(ctx);
      const id = qp(ctx, 'id');
      if (!/^[A-Za-z0-9]{10,40}$/.test(id)) fail(404, 'Jogador não encontrado.');
      const u = await getUser(id, true);
      if (!u) fail(404, 'Jogador não encontrado.');
      const [a, txs, bets, deps, wds] = await Promise.all([
        D.authInfo(id, true).catch(() => null),
        col.txs(id).orderBy('at', 'desc').limit(100).get(),
        col.bets(id).orderBy('placedAt', 'desc').limit(50).get(),
        col.deposits().where('userId', '==', id).limit(300).get(),
        col.withdrawals().where('userId', '==', id).limit(300).get(),
      ]);
      const desc = (k) => (x, y) => y[k] - x[k];
      return {
        user: pubPlayer(u),
        auth: a ? { emailVerified: !!a.emailVerified, disabled: !!a.disabled, lastSignIn: a.lastSignIn } : null,
        transactions: txs.docs.map((d) => { const t = d.data(); return { type: t.type, amount: fromCents(t.amount), ref: t.ref, at: t.at, status: t.status || null, note: t.note || null }; }),
        bets: bets.docs.map((d) => { const b = d.data(); return { id: b.id, type: b.type, stake: fromCents(b.stake), odds: b.odds, potential: fromCents(b.potential), status: b.status, payout: fromCents(b.payout), placedAt: b.placedAt, legs: b.legs.map((l) => `${l.event}: ${l.marketName} — ${l.name} @${l.odds}${l.result ? ' (' + l.result + ')' : ''}`) }; }),
        deposits: deps.docs.map((d) => d.data()).sort(desc('createdAt')).slice(0, 50).map(pubDep),
        withdrawals: wds.docs.map((d) => d.data()).sort(desc('createdAt')).slice(0, 50).map(pubWd),
        totals: {
          deposited: fromCents(deps.docs.map((d) => d.data()).filter((d) => d.status === 'PAID').reduce((s, d) => s + (d.creditedAmount || d.amount), 0)),
          withdrawn: fromCents(wds.docs.map((d) => d.data()).filter((w) => w.status === 'PAID').reduce((s, w) => s + w.amount, 0)),
        },
      };
    },

    // bloquear / desbloquear conta (desativa também no Firebase Authentication e termina as sessões)
    'POST /api/admin/user/block': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const id = String(ctx.body.id || ''), blocked = !!ctx.body.blocked;
      const reason = reasonOf(ctx.body.reason);
      const u = await getUser(id, true);
      if (!u) fail(404, 'Jogador não encontrado.');
      if (u.id === admin.id) fail(400, 'Não pode bloquear a sua própria conta.');
      await auth.updateUser(id, { disabled: blocked });
      if (blocked) { await auth.revokeRefreshTokens(id); await D.endSessions(id, null); }
      await col.user(id).update({ blocked, blockedReason: blocked ? reason : null, blockedAt: blocked ? now() : null });
      await log(null, admin, blocked ? 'jogador:bloquear' : 'jogador:desbloquear', id, { user: u.email, reason });
      dirty(id); D.authState.delete(id);
      console.log(`[Admin] ${admin.email}: ${blocked ? 'bloqueou' : 'desbloqueou'} ${u.email} (${reason})`);
      return { user: pubPlayer(await getUser(id, true)) };
    },

    // ajuste manual de saldo (correções, bónus de compensação...). Fica no extrato do jogador e no registo.
    'POST /api/admin/user/adjust': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const id = String(ctx.body.id || '');
      const amt = toCents(ctx.body.amount);
      if (!amt || Math.abs(amt) > 5000000) fail(400, 'Valor inválido (até R$ 50.000, positivo ou negativo).');
      const reason = reasonOf(ctx.body.reason, 5);
      let email;
      await runTx([id], async (t) => {
        const ref = col.user(id);
        const s = await t.get(ref);
        if (!s.exists) fail(404, 'Jogador não encontrado.');
        email = s.data().email;
        t.update(ref, { balance: inc(amt) });
        addTx(t, id, amt > 0 ? 'Crédito manual' : 'Débito manual', amt, null, { note: reason });
        log(t, admin, 'jogador:ajuste', id, { user: email, amount: amt, reason });
      });
      console.log(`[Admin] ${admin.email}: ajuste de ${brl(amt)} em ${email} (${reason})`);
      return { user: pubPlayer(await getUser(id, true)) };
    },

    /* ---------- apostas ---------- */
    // em aberto (todas) ou atrasadas: o jogo começou há mais de 3h e a aposta ainda não foi liquidada
    'GET /api/admin/bets': async (ctx) => {
      await requireAdmin(ctx);
      const filter = qp(ctx, 'filter') || 'open';
      const t = now();
      let list = [...D.openBets.values()];
      if (filter === 'late') list = list.filter((b) => isLate(b, t));
      list.sort((a, b) => a.placedAt - b.placedAt);
      list = list.slice(0, 300);
      const users = new Map();
      for (const uid of new Set(list.map((b) => b.userId))) users.set(uid, await getUser(uid).catch(() => null));
      return {
        bets: list.map((b) => ({ ...pubBet(b), userName: users.get(b.userId)?.name || '?', userEmail: users.get(b.userId)?.email || '', late: isLate(b, t) })),
        summary: betSummary(),
      };
    },

    'GET /api/admin/bet': async (ctx) => {
      await requireAdmin(ctx);
      const uid = qp(ctx, 'userId'), id = qp(ctx, 'id');
      if (!/^[A-Za-z0-9]{10,40}$/.test(uid) || !/^[0-9A-Z]{8,16}$/.test(id)) fail(404, 'Aposta não encontrada.');
      const [s, u] = await Promise.all([col.bets(uid).doc(id).get(), getUser(uid)]);
      if (!s.exists) fail(404, 'Aposta não encontrada.');
      return { bet: { ...pubBet(s.data()), userName: u?.name, userEmail: u?.email } };
    },

    /* Liquidar à mão (aposta em aberto) ou corrigir o resultado (aposta já liquidada).
       A equipa escolhe o resultado de cada seleção; o prêmio é recalculado e o saldo ajustado pela diferença. */
    'POST /api/admin/bets/settle': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const uid = String(ctx.body.userId || ''), id = String(ctx.body.id || '');
      const results = Array.isArray(ctx.body.results) ? ctx.body.results.map(String) : [];
      const reason = reasonOf(ctx.body.reason, 5);
      if (!/^[A-Za-z0-9]{10,40}$/.test(uid) || !/^[0-9A-Z]{8,16}$/.test(id)) fail(404, 'Aposta não encontrada.');
      if (!results.length || results.some((r) => !(r in LEG_VALUE))) fail(400, 'Escolha o resultado de cada seleção.');
      let out;
      await runTx([uid], async (t) => {
        const betRef = col.bets(uid).doc(id), openRef = col.openBets().doc(id);
        const [bs, os] = await Promise.all([t.get(betRef), t.get(openRef)]);
        if (!bs.exists) fail(404, 'Aposta não encontrada.');
        const bet = bs.data();
        if (ctx.body.expect && bet.status !== ctx.body.expect) fail(409, `A aposta mudou entretanto (agora: ${BET_LABEL[bet.status] || bet.status}). Atualize a página.`);
        if (bet.status === 'cashout') fail(409, 'Esta aposta foi encerrada com Cash Out e não pode ser alterada.');
        if (results.length !== bet.legs.length) fail(400, 'Número de seleções não confere.');
        const legs = bet.legs.map((l, i) => ({ ...l, result: results[i], value: LEG_VALUE[results[i]], final: l.final || 'equipa', manual: true }));
        const payout = legs.some((l) => l.value === -1) ? 0 : Math.round(bet.stake * legs.reduce((p, l) => p * D.M.outcomeFactor(l.value, l.odds), 1));
        const status = payout === 0 ? 'lost' : payout > bet.stake ? 'won' : 'void';
        const wasOpen = bet.status === 'open';
        const diff = wasOpen ? payout : payout - (bet.payout || 0);
        const patch = { status, payout, legs, settledAt: now(), settledBy: admin.email, settleNote: reason };
        if (!wasOpen) patch.correctedFrom = { status: bet.status, payout: bet.payout ?? null, at: now() };
        t.update(betRef, patch);
        if (os.exists) t.delete(openRef);
        if (diff !== 0) {
          t.update(col.user(uid), { balance: inc(diff), [`daily.${D.dayKey()}.returned`]: inc(diff) });
          const type = wasOpen ? (status === 'won' ? 'Prêmio' : 'Aposta devolvida') : 'Correção de aposta';
          addTx(t, uid, type, diff, id, { note: wasOpen ? 'liquidada pela equipa' : reason });
        }
        log(t, admin, wasOpen ? 'aposta:liquidar' : 'aposta:corrigir', id, { user: uid, from: bet.status, to: status, oldPayout: bet.payout ?? null, payout, results, reason });
        out = { status, payout, diff, wasOpen };
      });
      D.openBets.delete(id);
      console.log(`[Admin] ${admin.email}: aposta ${id} ${out.wasOpen ? 'liquidada' : 'corrigida'} → ${out.status} (${brl(out.payout)}, saldo ${out.diff >= 0 ? '+' : ''}${brl(out.diff)})`);
      return { status: out.status, payout: fromCents(out.payout), diff: fromCents(out.diff) };
    },

    'GET /api/admin/logs': async (ctx) => {
      await requireAdmin(ctx);
      const qs = await col.adminLogs().orderBy('at', 'desc').limit(200).get();
      return { logs: qs.docs.map((d) => d.data()) };
    },
  });
  return { requireAdmin, log };
};
