'use strict';
/* Painel da equipa → "Esportes e mercados": modalidades e campeonatos novos, eventos criados à mão
   e mercados com odds definidas pela equipa (também como mercados extra em jogos reais da ESPN).
   Os mercados abrem, suspendem e são liquidados aqui; as apostas neles são pagas sozinhas
   assim que o mercado é liquidado. Tudo o que a equipa faz fica em adminLogs. */

const crypto = require('node:crypto');

module.exports = function catalogRoutes(routes, D) {
  const { col, runTx, fail, now, fromCents, toCents, M, requireAdmin, log } = D;
  const hex = (n) => crypto.randomBytes(n).toString('hex').toUpperCase();
  const qp = (ctx, k) => new URL(ctx.req.url, 'http://x').searchParams.get(k) || '';
  const text = (v, max, what, min = 2) => {
    const s = String(v ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
    if (s.length < min) fail(400, `Indique ${what}.`);
    return s;
  };
  const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'x';
  const unique = (base, taken) => { let k = base, n = 2; while (taken(k)) k = `${base}-${n++}`; return k; };
  const icon = (v) => String(v || '').replace(/[<>&"'`\s]/g, '').slice(0, 8) || '🏅';
  const oddsOf = (v) => {
    const n = Math.round(Number(String(v ?? '').replace(',', '.')) * 100) / 100;
    if (!(n >= 1.01 && n <= 1000)) fail(400, `Odd inválida: "${v}" (use entre 1.01 e 1000).`);
    return n;
  };
  const RESULTS = ['won', 'lost', 'void'];
  const STATES = ['pre', 'in', 'post'];
  const builtinSport = (k) => !!M.SPORTS[k] && !M.SPORTS[k].custom;
  const builtinLeague = (k) => !!M.LEAGUE_BY_KEY[k]?.path;
  const isManualId = (id) => /^M[0-9A-F]{10}$/.test(id);
  const leagueName = (k) => M.LEAGUE_BY_KEY[k]?.name || D.catLeagues.get(k)?.name || k;

  // depois de gravar: atualiza já a memória (a ligação em tempo real confirma a seguir)
  async function syncLocal(map, ref) {
    const s = await ref.get();
    if (s.exists) map.set(s.id, { id: s.id, ...s.data() }); else map.delete(s.id);
    D.applyCatalog();
  }

  // apostas em aberto por seleção de um evento: { "mercado.seleção" -> { bets, stake, potential } }
  function exposure(evId) {
    const out = new Map();
    for (const b of D.openBets.values()) {
      for (const l of b.legs) {
        if (l.evId !== evId || l.market !== 'custom' || l.result) continue;
        const e = out.get(l.pick) || { bets: 0, stake: 0, potential: 0, singles: 0 };
        e.bets++; e.stake += b.stake; e.potential += b.potential; if (b.legs.length === 1) e.singles += b.potential;
        out.set(l.pick, e);
      }
    }
    return out;
  }
  const openBetsOn = (evId) => [...D.openBets.values()].filter((b) => b.legs.some((l) => l.evId === evId && !l.result)).length;
  const marketHasBets = (exp, mId) => [...exp.keys()].some((k) => k.startsWith(mId + '.'));

  /* ---------- mercados ---------- */
  function marketsRef(evId) {
    if (isManualId(evId)) return col.manualEvents().doc(evId);
    if (/^\d{1,15}$/.test(evId)) return col.manualMarkets().doc(evId);
    return fail(404, 'Evento não encontrado.');
  }
  // lê, altera e grava a lista de mercados de um evento, tudo numa transação
  async function editMarkets(admin, evId, action, fn) {
    const ref = marketsRef(evId);
    let out;
    await runTx([], async (t) => {
      const s = await t.get(ref);
      let doc = s.exists ? s.data() : null;
      if (!doc) {
        const ev = D.events.get(evId);
        if (isManualId(evId) || !ev || ev.manual) fail(404, 'Evento não encontrado.');
        doc = { event: `${ev.home.name} x ${ev.away.name}`, league: ev.league, startsAt: +ev.date, markets: [], createdAt: now() };
      }
      const markets = structuredClone(doc.markets || []);
      out = fn(markets) || {};
      t.set(ref, { ...doc, markets, updatedAt: now() });
      log(t, admin, action, evId, { event: doc.event || `${doc.home} x ${doc.away}`, ...out.log });
    });
    await syncLocal(isManualId(evId) ? D.manualEvents : D.manualMarkets, ref);
    return out;
  }
  const findMarket = (markets, id) => {
    const m = markets.find((x) => x.id === id);
    if (!m) fail(404, 'Mercado não encontrado.');
    return m;
  };
  const newId = (taken) => unique(hex(3), (k) => taken.has(k));
  function parseSels(list, old = []) {
    if (!Array.isArray(list) || list.length < 2 || list.length > 60) fail(400, 'Um mercado precisa de 2 a 60 seleções.');
    const names = new Set(), ids = new Set(old.map((s) => s.id));
    return list.map((x) => {
      const name = text(x?.name, 60, 'o nome de cada seleção', 1);
      if (names.has(name.toLowerCase())) fail(400, `Seleção repetida: ${name}.`);
      names.add(name.toLowerCase());
      const prev = x.id && old.find((s) => s.id === x.id);
      const id = prev ? prev.id : newId(ids);
      ids.add(id);
      return { id, name, odds: oddsOf(x.odds), result: null };
    });
  }
  const maxStakeOf = (v) => {
    if (v == null || v === '' || Number(v) === 0) return null;
    const c = toCents(String(v).replace(',', '.'));
    if (!(c >= 100 && c <= 100000000)) fail(400, 'Aposta máxima inválida (entre R$ 1 e R$ 1.000.000, ou vazio para sem limite).');
    return c;
  };
  const pubMarket = (m, exp) => ({
    id: m.id, name: m.name, status: m.status, maxStake: fromCents(m.maxStake ?? null), createdAt: m.createdAt, createdBy: m.createdBy || null,
    settledAt: m.settledAt || null, settledBy: m.settledBy || null, note: m.note || null,
    sels: m.sels.map((s) => {
      const e = exp.get(`${m.id}.${s.id}`);
      return { id: s.id, name: s.name, odds: s.odds, result: s.result || null, bets: e?.bets || 0, stake: fromCents(e?.stake || 0), potential: fromCents(e?.potential || 0), singles: fromCents(e?.singles || 0) };
    }),
  });

  /* ---------- resumos ---------- */
  const pubEventRow = (d) => ({
    id: d.id, league: d.league, leagueName: leagueName(d.league), home: d.home, away: d.away, startsAt: d.startsAt, state: d.state,
    score: d.score || null, clock: d.clock || '', archived: !!d.archived, markets: (d.markets || []).length,
    open: (d.markets || []).filter((m) => m.status === 'open').length, toSettle: (d.markets || []).filter((m) => m.status !== 'settled').length, bets: openBetsOn(d.id),
  });

  Object.assign(routes, {
    'GET /api/admin/catalog': async (ctx) => {
      await requireAdmin(ctx);
      const custom = [...D.catSports.values()].sort((a, b) => a.createdAt - b.createdAt);
      const leagues = [...D.catLeagues.values()].sort((a, b) => a.createdAt - b.createdAt);
      const events = [...D.manualEvents.values()];
      const sportName = (k) => M.SPORTS[k]?.name || D.catSports.get(k)?.name || k;
      return {
        sports: [
          ...Object.entries(M.SPORTS).filter(([k]) => builtinSport(k)).map(([k, s]) => ({ key: k, name: s.name, icon: s.icon, builtin: true, leagues: M.LEAGUES.filter((l) => l.sport === k && l.path).length + leagues.filter((l) => l.sport === k).length })),
          ...custom.map((s) => ({ key: s.id, name: s.name, icon: s.icon, hidden: !!s.hidden, leagues: leagues.filter((l) => l.sport === s.id).length })),
        ],
        leagues: [
          ...leagues.map((l) => ({ key: l.id, name: l.name, country: l.country || '', sport: l.sport, sportName: sportName(l.sport), hidden: !!l.hidden, events: events.filter((e) => e.league === l.id && !e.archived).length })),
          ...M.LEAGUES.filter((l) => l.path).map((l) => ({ key: l.key, name: l.name, country: l.country, sport: l.sport, sportName: sportName(l.sport), builtin: true, events: events.filter((e) => e.league === l.key && !e.archived).length })),
        ],
        events: events.map(pubEventRow).sort((a, b) => a.startsAt - b.startsAt),
      };
    },

    // jogos reais (ESPN) para acrescentar mercados da equipa
    'GET /api/admin/catalog/real': async (ctx) => {
      await requireAdmin(ctx);
      const list = [...D.events.values()].filter((ev) => !ev.manual && (ev.state !== 'post' || D.manualMarkets.has(ev.id)));
      // jogos com mercados da equipa que já saíram do feed continuam na lista (para liquidar)
      const gone = [...D.manualMarkets.values()].filter((d) => !D.events.has(d.id));
      const row = (id, x) => {
        const mk = D.manualMarkets.get(id)?.markets || [];
        return { id, ...x, markets: mk.length, toSettle: mk.filter((m) => m.status !== 'settled').length, bets: openBetsOn(id) };
      };
      return {
        events: [
          ...list.map((ev) => row(ev.id, { league: ev.league, leagueName: ev.leagueName, sport: ev.sport, home: ev.home.name, away: ev.away.name, startsAt: +ev.date, state: ev.state, score: ev.home.score != null ? { h: ev.home.score, a: ev.away.score } : null, clock: ev.clock || '' })),
          ...gone.map((d) => row(d.id, { league: d.league, leagueName: leagueName(d.league), sport: M.LEAGUE_BY_KEY[d.league]?.sport, home: d.event.split(' x ')[0], away: d.event.split(' x ')[1] || '', startsAt: d.startsAt, state: 'post', score: null, clock: 'fora do feed' })),
        ].sort((a, b) => (b.markets > 0) - (a.markets > 0) || (b.state === 'in') - (a.state === 'in') || a.startsAt - b.startsAt),
      };
    },

    'GET /api/admin/catalog/event': async (ctx) => {
      await requireAdmin(ctx);
      const id = qp(ctx, 'id');
      const exp = exposure(id);
      let event, markets;
      if (isManualId(id)) {
        const d = D.manualEvents.get(id);
        if (!d) fail(404, 'Evento não encontrado.');
        event = { ...pubEventRow(d), manual: true, sport: M.LEAGUE_BY_KEY[d.league]?.sport || D.catLeagues.get(d.league)?.sport };
        markets = d.markets || [];
      } else {
        const ev = D.events.get(id), d = D.manualMarkets.get(id);
        if ((!ev || ev.manual) && !d) fail(404, 'Jogo não encontrado (pode já ter saído do feed).');
        event = ev
          ? { id, manual: false, league: ev.league, leagueName: ev.leagueName, sport: ev.sport, home: ev.home.name, away: ev.away.name, startsAt: +ev.date, state: ev.state, score: ev.home.score != null ? { h: ev.home.score, a: ev.away.score } : null, clock: ev.clock || '' }
          : { id, manual: false, league: d.league, leagueName: leagueName(d.league), home: d.event.split(' x ')[0], away: d.event.split(' x ')[1] || '', startsAt: d.startsAt, state: 'post', score: null, clock: 'fora do feed' };
        markets = d?.markets || [];
      }
      return { event, markets: markets.map((m) => pubMarket(m, exp)), bets: openBetsOn(id) };
    },

    /* ---------- modalidades ---------- */
    'POST /api/admin/catalog/sport': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const key = String(ctx.body.key || '');
      const name = text(ctx.body.name, 40, 'o nome da modalidade');
      const data = { name, icon: icon(ctx.body.icon), hidden: !!ctx.body.hidden, updatedAt: now() };
      let ref;
      if (key) {
        if (!D.catSports.has(key)) fail(404, builtinSport(key) ? 'As modalidades automáticas (ESPN) não podem ser alteradas.' : 'Modalidade não encontrada.');
        ref = col.catSports().doc(key);
        await ref.update(data);
      } else {
        const k = unique(slug(name), (x) => builtinSport(x) || D.catSports.has(x));
        ref = col.catSports().doc(k);
        await ref.create({ ...data, createdAt: now(), createdBy: admin.email });
      }
      await log(null, admin, key ? 'modalidade:editar' : 'modalidade:criar', ref.id, data);
      await syncLocal(D.catSports, ref);
      return { key: ref.id };
    },
    'POST /api/admin/catalog/sport/delete': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const key = String(ctx.body.key || '');
      const s = D.catSports.get(key);
      if (!s) fail(404, 'Modalidade não encontrada.');
      if ([...D.catLeagues.values()].some((l) => l.sport === key)) fail(409, 'Apague (ou mude de modalidade) os campeonatos desta modalidade primeiro. Para só a tirar do site, use "Ocultar".');
      const ref = col.catSports().doc(key);
      await ref.delete();
      await log(null, admin, 'modalidade:apagar', key, { name: s.name });
      await syncLocal(D.catSports, ref);
      return { ok: true };
    },

    /* ---------- campeonatos ---------- */
    'POST /api/admin/catalog/league': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const key = String(ctx.body.key || '');
      const sport = String(ctx.body.sport || '');
      if (!builtinSport(sport) && !D.catSports.has(sport)) fail(400, 'Escolha a modalidade.');
      const data = { name: text(ctx.body.name, 60, 'o nome do campeonato'), country: text(ctx.body.country, 40, 'o país/região', 0), sport, hidden: !!ctx.body.hidden, updatedAt: now() };
      let ref;
      if (key) {
        if (!D.catLeagues.has(key)) fail(404, builtinLeague(key) ? 'Os campeonatos automáticos (ESPN) não podem ser alterados.' : 'Campeonato não encontrado.');
        ref = col.catLeagues().doc(key);
        await ref.update(data);
      } else {
        const k = unique('m.' + slug(data.name), (x) => !!M.LEAGUE_BY_KEY[x] || D.catLeagues.has(x));
        ref = col.catLeagues().doc(k);
        await ref.create({ ...data, createdAt: now(), createdBy: admin.email });
      }
      await log(null, admin, key ? 'campeonato:editar' : 'campeonato:criar', ref.id, data);
      await syncLocal(D.catLeagues, ref);
      return { key: ref.id };
    },
    'POST /api/admin/catalog/league/delete': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const key = String(ctx.body.key || '');
      const l = D.catLeagues.get(key);
      if (!l) fail(404, 'Campeonato não encontrado.');
      if ([...D.manualEvents.values()].some((e) => e.league === key)) fail(409, 'Este campeonato tem eventos (mesmo arquivados) e não pode ser apagado. Para o tirar do site, use "Ocultar".');
      const ref = col.catLeagues().doc(key);
      await ref.delete();
      await log(null, admin, 'campeonato:apagar', key, { name: l.name });
      await syncLocal(D.catLeagues, ref);
      return { ok: true };
    },

    /* ---------- eventos da equipa ---------- */
    'POST /api/admin/catalog/event': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const b = ctx.body;
      const id = String(b.id || '');
      const league = String(b.league || '');
      if (!builtinLeague(league) && !D.catLeagues.has(league)) fail(400, 'Escolha o campeonato.');
      const startsAt = Number(b.startsAt);
      if (!(startsAt > now() - 60 * 86400000 && startsAt < now() + 400 * 86400000)) fail(400, 'Data/hora inválida.');
      const state = STATES.includes(b.state) ? b.state : 'pre';
      const sc = (v) => (v === '' || v == null ? 0 : Math.max(0, Math.min(999, parseInt(v, 10) || 0)));
      const data = {
        league, home: text(b.home, 60, 'a equipa/participante da casa', 1), away: text(b.away, 60, 'a equipa/participante de fora', 1), startsAt, state,
        score: state === 'pre' ? null : { h: sc(b.scoreH), a: sc(b.scoreA) }, clock: text(b.clock, 30, 'o tempo', 0), updatedAt: now(),
      };
      let ref;
      if (id) {
        if (!D.manualEvents.has(id)) fail(404, 'Evento não encontrado.');
        ref = col.manualEvents().doc(id);
        await ref.update(data);
      } else {
        const nid = unique('M' + hex(5), (x) => D.manualEvents.has(x));
        ref = col.manualEvents().doc(nid);
        await ref.create({ ...data, id: nid, markets: [], archived: false, createdAt: now(), createdBy: admin.email });
      }
      await log(null, admin, id ? 'evento:editar' : 'evento:criar', ref.id, { event: `${data.home} x ${data.away}`, league, state, score: data.score, startsAt });
      await syncLocal(D.manualEvents, ref);
      return { id: ref.id };
    },
    'POST /api/admin/catalog/event/archive': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const id = String(ctx.body.id || ''), archived = !!ctx.body.archived;
      const d = D.manualEvents.get(id);
      if (!d) fail(404, 'Evento não encontrado.');
      if (archived && openBetsOn(id)) fail(409, 'Há apostas em aberto neste evento. Liquide os mercados antes de arquivar.');
      const ref = col.manualEvents().doc(id);
      await ref.update({ archived, updatedAt: now() });
      await log(null, admin, archived ? 'evento:arquivar' : 'evento:reativar', id, { event: `${d.home} x ${d.away}` });
      await syncLocal(D.manualEvents, ref);
      return { ok: true };
    },

    /* ---------- mercados ---------- */
    // criar (sem id) ou editar (nome, aposta máxima, seleções e odds) um mercado
    'POST /api/admin/catalog/market': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const b = ctx.body;
      const evId = String(b.evId || ''), mId = String(b.id || '');
      const name = text(b.name, 80, 'o nome do mercado');
      const maxStake = maxStakeOf(b.maxStake);
      const exp = exposure(evId);
      const r = await editMarkets(admin, evId, mId ? 'mercado:editar' : 'mercado:criar', (markets) => {
        if (!mId) {
          if (markets.length >= 80) fail(400, 'Limite de 80 mercados por evento.');
          const m = { id: newId(new Set(markets.map((x) => x.id))), name, status: b.open === false ? 'suspended' : 'open', maxStake, sels: parseSels(b.sels), createdAt: now(), createdBy: admin.email, settledAt: null };
          markets.push(m);
          return { id: m.id, log: { market: name, sels: m.sels.map((s) => `${s.name} @${s.odds}`) } };
        }
        const m = findMarket(markets, mId);
        if (m.status === 'settled') fail(409, 'Este mercado já foi liquidado e não pode ser alterado.');
        const sels = parseSels(b.sels, m.sels);
        for (const s of m.sels) {
          if (!sels.some((n) => n.id === s.id) && exp.has(`${m.id}.${s.id}`)) fail(409, `"${s.name}" tem apostas em aberto e não pode ser removida. Suspenda o mercado ou liquide-o.`);
        }
        const moved = sels.map((n) => [n, m.sels.find((s) => s.id === n.id)]).filter(([n, o]) => o && o.odds !== n.odds).map(([n, o]) => `${n.name} ${o.odds}→${n.odds}`);
        Object.assign(m, { name, maxStake, sels, updatedAt: now() });
        return { id: m.id, log: { market: name, odds: moved, maxStake } };
      });
      return { id: r.id };
    },
    // abrir / suspender um mercado (id) ou todos os mercados ainda por liquidar do evento (id = "*")
    'POST /api/admin/catalog/market/status': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const evId = String(ctx.body.evId || ''), mId = String(ctx.body.id || ''), status = String(ctx.body.status || '');
      if (!['open', 'suspended'].includes(status)) fail(400, 'Estado inválido.');
      await editMarkets(admin, evId, status === 'open' ? 'mercado:abrir' : 'mercado:suspender', (markets) => {
        const list = mId === '*' ? markets.filter((m) => m.status !== 'settled') : [findMarket(markets, mId)];
        for (const m of list) {
          if (m.status === 'settled') fail(409, 'Este mercado já foi liquidado.');
          m.status = status;
        }
        return { log: { markets: list.map((m) => m.name) } };
      });
      return { ok: true };
    },
    // liquidar: a equipa marca o resultado de cada seleção; as apostas são pagas a seguir
    'POST /api/admin/catalog/market/settle': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const evId = String(ctx.body.evId || ''), mId = String(ctx.body.id || '');
      const results = ctx.body.results && typeof ctx.body.results === 'object' ? ctx.body.results : {};
      const note = String(ctx.body.note || '').trim().slice(0, 300) || null;
      await editMarkets(admin, evId, 'mercado:liquidar', (markets) => {
        const m = findMarket(markets, mId);
        if (m.status === 'settled') fail(409, 'Este mercado já foi liquidado. Para corrigir uma aposta, use "Corrigir" no perfil do jogador.');
        for (const s of m.sels) if (!RESULTS.includes(results[s.id])) fail(400, `Escolha o resultado de "${s.name}".`);
        for (const s of m.sels) s.result = results[s.id];
        Object.assign(m, { status: 'settled', settledAt: now(), settledBy: admin.email, note });
        return { log: { market: m.name, results: m.sels.map((s) => `${s.name}: ${s.result}`), note } };
      });
      await D.settle();
      return { ok: true };
    },
    'POST /api/admin/catalog/market/delete': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const evId = String(ctx.body.evId || ''), mId = String(ctx.body.id || '');
      const exp = exposure(evId);
      await editMarkets(admin, evId, 'mercado:apagar', (markets) => {
        const m = findMarket(markets, mId);
        if (marketHasBets(exp, mId)) fail(409, 'Há apostas em aberto neste mercado. Liquide-o (ou anule: tudo "devolvida") em vez de apagar.');
        markets.splice(markets.indexOf(m), 1);
        return { log: { market: m.name } };
      });
      return { ok: true };
    },
  });
};
