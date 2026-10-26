'use strict';
/* Painel da equipa → "Esportes e mercados": modalidades e campeonatos novos, eventos criados à mão
   e mercados com odds definidas pela equipa (também como mercados extra em jogos reais da ESPN).
   Os mercados abrem, suspendem e são liquidados aqui; as apostas neles são pagas sozinhas
   assim que o mercado é liquidado. Tudo o que a equipa faz fica em adminLogs.
   Eventos de campeonatos com "regras do jogo" podem ter odds automáticas ao vivo (livemodel.js):
   a equipa marca os rounds e as odds dos mercados automáticos acompanham o placar. */

const crypto = require('node:crypto');
const L = require('./livemodel.js');

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

  /* ---------- regras do jogo e odds ao vivo ---------- */
  function parseRules(r) {
    if (!r || !r.enabled) return null;
    const n = (v, lo, hi, what) => { const x = Number(String(v ?? '').replace(',', '.')); if (!(x >= lo && x <= hi)) fail(400, `${what}: entre ${lo} e ${hi}.`); return x; };
    const ot = ['none', 'by2', 'blocks'].includes(r.ot) ? r.ot : 'none';
    const bestOf = Math.round(n(r.bestOf, 1, 9, 'Melhor de'));
    if (bestOf % 2 === 0) fail(400, '"Melhor de" tem de ser ímpar (1, 3, 5...).');
    return {
      preset: L.PRESETS[r.preset] ? r.preset : 'custom', unit: text(r.unit || 'rounds', 20, 'a unidade', 1), mapName: text(r.mapName || 'mapa', 20, 'o nome do mapa', 1),
      target: Math.round(n(r.target, 1, 50, 'Rounds para ganhar o mapa')), ot, otBlock: ot === 'blocks' ? Math.round(n(r.otBlock, 1, 20, 'Rounds por bloco da prorrogação')) : 2,
      bestOf, margin: n(r.margin, 0, 30, 'Margem da casa (%)'), notes: String(r.notes || '').replace(/[<>]/g, '').trim().slice(0, 1000),
      minOdd: n(r.minOdd ?? 1.15, 1.01, 2, 'Odd mínima das linhas'), lines: Math.round(n(r.lines ?? 3, 1, 9, 'Linhas por mercado')),
      endgame: Math.round(n(r.endgame ?? 2, 0, 10, 'Reta final')),
      half: Math.round(n(r.half ?? 0, 0, 40, 'Rounds do 1º tempo')),
    };
  }
  const rulesFor = (d) => D.catLeagues.get(d.league)?.rules || null;
  const liveOf = (d, R) => ({ auto: false, p: null, bestOf: R.bestOf, base: { mh: 0, ma: 0, a: 0, b: 0, history: [] }, rounds: [], ...(d.live || {}) });
  function liveCtx(d) {
    const R = rulesFor(d);
    if (!R) return null;
    const live = liveOf(d, R);
    return { R, live, st: L.deriveState(live, R), p: live.p, margin: R.margin / 100, minOdd: R.minOdd ?? 1.15, lines: R.lines ?? 3, ev: { home: d.home, away: d.away }, state: d.state };
  }
  // chance de a casa ganhar tirada das odds do mercado "Vencedor da partida" (sem a margem)
  function strengthFromOdds(d) {
    const mk = (d.markets || []).find((m) => m.auto?.type === 'match' && m.status !== 'settled') || (d.markets || []).find((m) => m.auto?.type === 'map_winner' && (m.auto.map || 1) === 1);
    const h = mk?.sels.find((s) => s.side === 'home'), a = mk?.sels.find((s) => s.side === 'away');
    return h && a ? (1 / h.odds) / (1 / h.odds + 1 / a.odds) : null;
  }
  function calibrateFromOdds(d, ctx) {
    const q = strengthFromOdds(d);
    return q == null ? null : L.calibrate(q, ctx.st, ctx.R);
  }
  /* Depois de qualquer mudança num evento da equipa: placar vindo dos rounds, estado e odds automáticas. */
  function applyLive(d) {
    const ctx = liveCtx(d);
    if (!ctx || !d.live) return;
    const { st, R } = ctx;
    const last = st.history[st.history.length - 1];
    d.score = st.over && last ? { h: last.h, a: last.a } : { h: st.a, a: st.b };
    if (st.over) d.state = 'post';
    if (ctx.live.auto && st.bestOf > 1) d.clock = st.over ? `${st.mh}-${st.ma} em ${R.mapName}s` : `${R.mapName} ${st.curMap} · ${st.mh}-${st.ma}`;
    ctx.state = d.state;
    if (ctx.live.auto && d.state === 'in') {
      if (ctx.p == null) { d.live.p = calibrateFromOdds(d, ctx); ctx.p = d.live.p; }
      if (ctx.p != null) L.reprice(d.markets, ctx);
    } else if (ctx.live.auto && ctx.p != null) {
      // antes do jogo (e depois de acabar), só os mercados abertos pelo sistema recebem odds do modelo
      L.reprice(d.markets.filter((m) => m.generated), ctx);
    }
  }
  // liquida um mercado com o resultado que o placar dá; false se o placar ainda não decide todas as seleções
  function settleBySuggestion(mk, ctx, by) {
    const r = L.suggest(mk, ctx);
    if (!r || mk.sels.some((s) => !r[s.id])) return false;
    for (const s of mk.sels) s.result = r[s.id];
    Object.assign(mk, { status: 'settled', settledAt: Date.now(), settledBy: by, note: 'liquidado pelo placar' });
    return true;
  }
  function liveInfo(d) {
    const ctx = liveCtx(d);
    if (!ctx) return null;
    const { st, live, R } = ctx;
    const fresh = { bestOf: st.bestOf, mh: 0, ma: 0, a: 0, b: 0 };
    return {
      auto: !!live.auto, p: live.p, bestOf: st.bestOf, rounds: live.rounds.length,
      state: { mh: st.mh, ma: st.ma, a: st.a, b: st.b, curMap: st.curMap, over: st.over, history: st.history },
      chance: live.p != null ? Math.round(L.seriesWinProb(live.p, st, R) * 1000) / 10 : null,
      prematch: live.p != null ? Math.round(L.seriesWinProb(live.p, fresh, R) * 1000) / 10 : null,
      fromOdds: strengthFromOdds(d) != null ? Math.round(strengthFromOdds(d) * 1000) / 10 : null,
    };
  }

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
      doc = structuredClone(doc);
      const markets = doc.markets || [];
      out = fn(markets, doc) || {};
      doc.markets = markets;
      if (isManualId(evId)) applyLive(doc);
      t.set(ref, { ...doc, updatedAt: now() });
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
    if (!Array.isArray(list) || list.length < 2 || list.length > 120) fail(400, 'Um mercado precisa de 2 a 120 seleções.');
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
  const pubMarket = (m, exp, ctx) => {
    const sug = m.status !== 'settled' && ctx ? L.suggest(m, { ...ctx, p: ctx.p ?? 0.5 }) : null;
    return {
      id: m.id, name: m.name, status: m.status, maxStake: fromCents(m.maxStake ?? null), createdAt: m.createdAt, createdBy: m.createdBy || null,
      settledAt: m.settledAt || null, settledBy: m.settledBy || null, note: m.note || null, auto: m.auto || null, group: m.group || null, generated: !!m.generated,
      sels: m.sels.map((s) => {
        const e = exp.get(`${m.id}.${s.id}`);
        return {
          id: s.id, name: s.name, odds: s.odds, result: s.result || null, side: s.side || null, line: s.line ?? null, locked: !!s.locked, hidden: !!s.hidden, suggest: sug?.[s.id] || null,
          bets: e?.bets || 0, stake: fromCents(e?.stake || 0), potential: fromCents(e?.potential || 0), singles: fromCents(e?.singles || 0),
        };
      }),
    };
  };
  // tipo de mercado automático: { type, map } ou null (odds só à mão)
  function autoOf(v, d) {
    if (!v || !v.type) return null;
    if (!L.TYPES[v.type]) fail(400, 'Tipo de mercado inválido.');
    if (!d || !isManualId(d.id)) fail(400, 'Odds automáticas só existem em eventos da equipa.');
    const R = rulesFor(d);
    if (!R) fail(400, 'Defina primeiro as regras do jogo no campeonato deste evento (Modalidades e campeonatos → Editar).');
    const map = L.TYPES[v.type].map ? Math.round(Number(v.map) || 1) : null;
    if (map != null && !(map >= 1 && map <= 9)) fail(400, 'Número do mapa inválido.');
    // totais e handicaps: linhas móveis (o motor muda a linha com o placar) ou fixas
    return { type: v.type, map, lines: v.lines === 'fixed' ? 'fixed' : 'move' };
  }
  const groupOf = (auto, d) => {
    const R = auto && L.TYPES[auto.type].map ? rulesFor(d) : null;
    return R ? `${R.mapName.charAt(0).toUpperCase() + R.mapName.slice(1)} ${auto.map}` : null;
  }
  function inferInto(auto, sels, d) {
    if (!auto) { for (const s of sels) { delete s.side; delete s.line; delete s.locked; } return; }
    let sides;
    try { sides = L.inferSels(auto.type, sels, d); } catch (e) { fail(400, e.message); }
    sels.forEach((s, i) => Object.assign(s, sides[i], { locked: false }));
  }

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
          ...leagues.map((l) => ({ key: l.id, name: l.name, country: l.country || '', sport: l.sport, sportName: sportName(l.sport), hidden: !!l.hidden, rules: l.rules || null, events: events.filter((e) => e.league === l.id && !e.archived).length })),
          ...M.LEAGUES.filter((l) => l.path).map((l) => ({ key: l.key, name: l.name, country: l.country, sport: l.sport, sportName: sportName(l.sport), builtin: true, events: events.filter((e) => e.league === l.key && !e.archived).length })),
        ],
        events: events.map(pubEventRow).sort((a, b) => a.startsAt - b.startsAt),
        presets: L.PRESETS, types: Object.fromEntries(Object.entries(L.TYPES).map(([k, t]) => [k, { label: t.label, map: !!t.map, gen: !!t.gen, pre: !!t.pre }])),
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
      let event, markets, lctx = null, rules = null, live = null;
      if (isManualId(id)) {
        const d = D.manualEvents.get(id);
        if (!d) fail(404, 'Evento não encontrado.');
        event = { ...pubEventRow(d), manual: true, sport: M.LEAGUE_BY_KEY[d.league]?.sport || D.catLeagues.get(d.league)?.sport };
        markets = d.markets || [];
        lctx = liveCtx(d); rules = rulesFor(d); live = liveInfo(d);
      } else {
        const ev = D.events.get(id), d = D.manualMarkets.get(id);
        if ((!ev || ev.manual) && !d) fail(404, 'Jogo não encontrado (pode já ter saído do feed).');
        event = ev
          ? { id, manual: false, league: ev.league, leagueName: ev.leagueName, sport: ev.sport, home: ev.home.name, away: ev.away.name, startsAt: +ev.date, state: ev.state, score: ev.home.score != null ? { h: ev.home.score, a: ev.away.score } : null, clock: ev.clock || '' }
          : { id, manual: false, league: d.league, leagueName: leagueName(d.league), home: d.event.split(' x ')[0], away: d.event.split(' x ')[1] || '', startsAt: d.startsAt, state: 'post', score: null, clock: 'fora do feed' };
        markets = d?.markets || [];
      }
      return { event, rules, live, markets: markets.map((m) => pubMarket(m, exp, lctx)), bets: openBetsOn(id) };
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
      if ('rules' in ctx.body) data.rules = parseRules(ctx.body.rules); // sem "rules" no pedido (ex.: ocultar), as regras ficam como estão
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
        await editMarkets(admin, id, 'evento:editar', (markets, doc) => {
          const was = doc.state;
          Object.assign(doc, data);
          const lc = liveCtx(doc);
          if (lc) {
            // placar mudado à mão: passa a ser o novo ponto de partida dos rounds
            const mh = sc(b.mapsH), ma = sc(b.mapsA), st = lc.st;
            const a = data.score ? data.score.h : 0, bb = data.score ? data.score.a : 0;
            const changed = mh !== st.mh || ma !== st.ma || a !== st.a || bb !== st.b;
            doc.live = { ...lc.live };
            if (changed && !(st.over && data.state === 'post')) doc.live = { ...doc.live, base: { mh, ma, a, b: bb, history: st.history.slice(0, mh + ma) }, rounds: [] };
            if (was !== 'in' && data.state === 'in' && doc.live.auto && doc.live.p == null) doc.live.p = calibrateFromOdds(doc, liveCtx({ ...doc, state: 'pre' }));
          }
          return { log: { state: data.state, score: data.score } };
        });
        return { id };
      } else {
        const nid = unique('M' + hex(5), (x) => D.manualEvents.has(x));
        ref = col.manualEvents().doc(nid);
        await ref.create({ ...data, id: nid, markets: [], archived: false, createdAt: now(), createdBy: admin.email });
      }
      await log(null, admin, id ? 'evento:editar' : 'evento:criar', ref.id, { event: `${data.home} x ${data.away}`, league, state, score: data.score, startsAt });
      await syncLocal(D.manualEvents, ref);
      // campeonato com regras do jogo: já cria o Vencedor, liga as odds automáticas e abre o pacote padrão
      let made = 0;
      if (!id && b.auto && rulesFor(data)) {
        const oh = oddsOf(b.oddsHome || 1.85), oa = oddsOf(b.oddsAway || 1.85);
        const out = await editMarkets(admin, ref.id, 'evento:mercados-padrao', (markets, doc) => {
          const R = rulesFor(doc);
          const bestOf = [1, 3, 5, 7, 9].includes(Number(b.bestOf)) ? Number(b.bestOf) : R.bestOf;
          const sels = parseSels([{ name: doc.home, odds: oh }, { name: doc.away, odds: oa }]);
          sels[0].side = 'home'; sels[1].side = 'away'; sels[0].line = sels[1].line = null;
          markets.push({ id: newId(new Set()), name: 'Vencedor', status: 'open', maxStake: null, auto: { type: 'match', map: null, lines: 'move' }, group: null, sels, createdAt: now(), createdBy: admin.email, settledAt: null });
          const q = (1 / oh) / (1 / oh + 1 / oa);
          doc.live = { auto: true, bestOf, base: { mh: 0, ma: 0, a: 0, b: 0, history: [] }, rounds: [], p: L.calibrate(q, { bestOf, mh: 0, ma: 0, a: 0, b: 0 }, R) };
          const n = L.ensureMapMarkets(markets, { ...liveCtx(doc), p: doc.live.p });
          return { n, log: { bestOf, odds: [oh, oa], mercados: n + 1 } };
        });
        made = out.n + 1;
      }
      return { id: ref.id, made };
    },
    // +1 round para a casa ('h') ou para fora ('a'), ou desfazer o último ('undo')
    'POST /api/admin/catalog/event/round': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const id = String(ctx.body.id || ''), side = String(ctx.body.side || '');
      if (!['h', 'a', 'undo'].includes(side)) fail(400, 'Pedido inválido.');
      if (!D.manualEvents.has(id)) fail(404, 'Evento não encontrado.');
      await editMarkets(admin, id, side === 'undo' ? 'evento:round-desfeito' : 'evento:round', (markets, doc) => {
        const lc = liveCtx(doc);
        if (!lc) fail(400, 'Defina primeiro as regras do jogo no campeonato deste evento.');
        doc.live = { ...lc.live, rounds: [...lc.live.rounds] };
        if (side === 'undo') {
          if (!doc.live.rounds.length) fail(409, 'Nada para desfazer (o placar foi definido à mão).');
          doc.live.rounds.pop();
          if (doc.state === 'post') doc.state = 'in';
        } else {
          if (lc.st.over) fail(409, 'A partida já terminou. Use "desfazer" se o último round estava errado.');
          // primeira vez ao vivo: calibra a força com as odds do pré-jogo, antes de contar o round
          if (doc.live.auto && doc.live.p == null) doc.live.p = calibrateFromOdds(doc, lc);
          doc.live.rounds.push(side);
          doc.state = 'in';
        }
        return { log: { side, rounds: doc.live.rounds.length } };
      });
      return { live: liveInfo(D.manualEvents.get(id)) };
    },
    // odds automáticas: ligar/desligar, melhor de N, força das equipas
    'POST /api/admin/catalog/event/live': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const b = ctx.body, id = String(b.id || '');
      if (!D.manualEvents.has(id)) fail(404, 'Evento não encontrado.');
      const out = await editMarkets(admin, id, 'evento:odds-automaticas', (markets, doc) => {
        const lc = liveCtx(doc);
        if (!lc) fail(400, 'Defina primeiro as regras do jogo no campeonato deste evento.');
        const live = { ...lc.live, auto: !!b.auto };
        if (b.bestOf != null) {
          const n = Math.round(Number(b.bestOf));
          if (![1, 3, 5, 7, 9].includes(n)) fail(400, '"Melhor de" tem de ser 1, 3, 5, 7 ou 9.');
          live.bestOf = n;
        }
        doc.live = live;
        const st = liveCtx(doc).st;
        const fresh = { ...st, mh: 0, ma: 0, a: 0, b: 0 };
        if (b.strength != null && b.strength !== '') {
          // chance (%) de a casa ganhar a partida ANTES de começar
          const q = Number(String(b.strength).replace(',', '.')) / 100;
          if (!(q >= 0.03 && q <= 0.97)) fail(400, 'Chance da casa: entre 3% e 97%.');
          live.p = L.calibrate(q, fresh, lc.R);
        } else if (b.fromOdds || (live.auto && live.p == null)) {
          // pelas odds atuais do "Vencedor": se o jogo já está a decorrer, elas valem para o placar atual
          live.p = calibrateFromOdds(doc, { ...lc, st: doc.state === 'in' ? st : fresh });
          if (b.fromOdds && live.p == null) fail(400, 'Crie primeiro um mercado "Vencedor da partida" (tipo automático) com as odds das duas equipas.');
        }
        // pacote padrão de mercados (série e cada mapa); em melhor de 3, 5, 7... um bloco por mapa
        let made = 0;
        if (live.auto) {
          if (live.p == null) fail(400, 'Para abrir os mercados, defina primeiro a força das equipas (odds do Vencedor ou a chance em %).');
          made = L.ensureMapMarkets(markets, { ...liveCtx(doc), p: live.p });
        }
        return { made, log: { auto: live.auto, bestOf: live.bestOf, p: live.p, mercadosAbertos: made } };
      });
      return { live: liveInfo(D.manualEvents.get(id)), made: out.made };
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
      const r = await editMarkets(admin, evId, mId ? 'mercado:editar' : 'mercado:criar', (markets, doc) => {
        const auto = autoOf(b.auto, { ...doc, id: evId });
        if (!mId) {
          if (markets.length >= 80) fail(400, 'Limite de 80 mercados por evento.');
          const m = { id: newId(new Set(markets.map((x) => x.id))), name, status: b.open === false ? 'suspended' : 'open', maxStake, auto, group: groupOf(auto, doc), sels: parseSels(b.sels), createdAt: now(), createdBy: admin.email, settledAt: null };
          inferInto(auto, m.sels, doc);
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
        inferInto(auto, sels, doc);
        Object.assign(m, { name, maxStake, auto, group: m.generated ? m.group : groupOf(auto, doc), sels, updatedAt: now() });
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
    // liquida de uma vez todos os mercados automáticos que o placar já decide (fim de mapa / partida)
    'POST /api/admin/catalog/event/settle-all': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const id = String(ctx.body.id || '');
      if (!D.manualEvents.has(id)) fail(404, 'Evento não encontrado.');
      const out = await editMarkets(admin, id, 'mercado:liquidar-pelo-placar', (markets, doc) => {
        const lc = liveCtx(doc);
        if (!lc) fail(400, 'Este evento não tem regras do jogo.');
        const lctx = { ...lc, p: lc.p ?? 0.5 };
        const done = markets.filter((m) => m.auto && m.status !== 'settled' && settleBySuggestion(m, lctx, admin.email));
        return { n: done.length, log: { mercados: done.map((m) => m.name) } };
      });
      await D.settle();
      return { settled: out.n };
    },
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
