'use strict';
/* Lógica partilhada entre o servidor (Node) e o navegador:
   ligas, leitura do feed ESPN, mercados, liquidação e cash out. */

const SPORTS = {
  soccer: { name: 'Futebol', icon: '⚽' },
  basketball: { name: 'Basquete', icon: '🏀' },
  football: { name: 'Futebol Americano', icon: '🏈' },
  baseball: { name: 'Beisebol', icon: '⚾' },
  hockey: { name: 'Hóquei no Gelo', icon: '🏒' },
};

const LEAGUES = [
  ['bra.1', 'Brasileirão Série A', 'Brasil'],
  ['bra.2', 'Brasileirão Série B', 'Brasil'],
  ['bra.copa_do_brazil', 'Copa do Brasil', 'Brasil'],
  ['conmebol.libertadores', 'Copa Libertadores', 'América do Sul'],
  ['conmebol.sudamericana', 'Copa Sul-Americana', 'América do Sul'],
  ['uefa.champions', 'Liga dos Campeões', 'Europa'],
  ['uefa.europa', 'Liga Europa', 'Europa'],
  ['uefa.europa.conf', 'Liga Conferência', 'Europa'],
  ['eng.1', 'Premier League', 'Inglaterra'],
  ['eng.2', 'Championship', 'Inglaterra'],
  ['eng.league_cup', 'Copa da Liga Inglesa', 'Inglaterra'],
  ['eng.fa', 'FA Cup', 'Inglaterra'],
  ['esp.1', 'LaLiga', 'Espanha'],
  ['esp.copa_del_rey', 'Copa do Rei', 'Espanha'],
  ['ita.1', 'Serie A', 'Itália'],
  ['ger.1', 'Bundesliga', 'Alemanha'],
  ['fra.1', 'Ligue 1', 'França'],
  ['por.1', 'Liga Portugal', 'Portugal'],
  ['ned.1', 'Eredivisie', 'Holanda'],
  ['tur.1', 'Süper Lig', 'Turquia'],
  ['sau.1', 'Saudi Pro League', 'Arábia Saudita'],
  ['arg.1', 'Liga Profesional', 'Argentina'],
  ['mex.1', 'Liga MX', 'México'],
  ['usa.1', 'MLS', 'EUA'],
  ['fifa.friendly', 'Amistosos Internacionais', 'Mundo'],
].map(([key, name, country]) => ({ key, name, country, sport: 'soccer', path: 'soccer/' + key }))
  .concat([
    { key: 'nba', name: 'NBA', country: 'EUA', sport: 'basketball', path: 'basketball/nba' },
    { key: 'nfl', name: 'NFL', country: 'EUA', sport: 'football', path: 'football/nfl' },
    { key: 'mlb', name: 'MLB', country: 'EUA', sport: 'baseball', path: 'baseball/mlb' },
    { key: 'nhl', name: 'NHL', country: 'EUA', sport: 'hockey', path: 'hockey/nhl' },
  ]);
const LEAGUE_BY_KEY = Object.fromEntries(LEAGUES.map((l, i) => [l.key, { ...l, order: i }]));

const round2 = (n) => Math.round(n * 100) / 100;

/* ---------- odds ---------- */
function am2dec(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^even$/i.test(s)) return 2;
  const n = parseFloat(s);
  if (!isFinite(n) || n === 0) return null;
  const d = n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
  return d > 1.001 ? round2(d) : null;
}

function parseOdds(arr, sport, state) {
  const o = (arr || []).find(Boolean);
  if (!o) return null;
  // ao vivo só vale a cotação "current"; antes do jogo usa current > close > open
  const order = state === 'in' ? ['current'] : ['current', 'close', 'open'];
  const g = (x) => { for (const k of order) { const v = x?.[k]; if (v && am2dec(v.odds)) return v; } return null; };
  const m = {};
  if (o.moneyline) {
    const h = g(o.moneyline.home), a = g(o.moneyline.away), d = g(o.moneyline.draw);
    if (h && a) m.ml = { home: am2dec(h.odds), away: am2dec(a.odds), draw: d ? am2dec(d.odds) : null };
  } else if (state !== 'in' && o.homeTeamOdds?.moneyLine != null && o.awayTeamOdds?.moneyLine != null) {
    m.ml = { home: am2dec(o.homeTeamOdds.moneyLine), away: am2dec(o.awayTeamOdds.moneyLine), draw: o.drawOdds ? am2dec(o.drawOdds.moneyLine) : null };
  }
  if (m.ml && (!m.ml.home || !m.ml.away || (sport === 'soccer' && !m.ml.draw))) delete m.ml;
  if (o.total) {
    const ov = g(o.total.over), un = g(o.total.under);
    if (ov && un) {
      const L = parseFloat(String(ov.line || '').replace(/[a-z]/gi, ''));
      if (isFinite(L)) m.total = { line: L, over: am2dec(ov.odds), under: am2dec(un.odds) };
    }
  }
  if (o.pointSpread) {
    const h = g(o.pointSpread.home), a = g(o.pointSpread.away);
    if (h && a) {
      const hl = parseFloat(h.line), al = parseFloat(a.line);
      if (isFinite(hl) && isFinite(al)) m.spread = { homeLine: hl, home: am2dec(h.odds), awayLine: al, away: am2dec(a.odds) };
    }
  }
  if (sport === 'soccer' && m.ml) {
    const { home, draw, away } = m.ml;
    const dc = (x, y) => Math.max(1.01, round2(1 / (1 / x + 1 / y)));
    m.dc = { hd: dc(home, draw), ha: dc(home, away), da: dc(draw, away) };
    // mercados calculados pelo modelo: só antes do jogo
    if (state === 'pre') { const x = deriveSoccer(m); if (x) m.x = x; }
  }
  return Object.keys(m).length ? m : null;
}

/* ---------- mercados calculados (futebol, antes do jogo) ----------
   O feed só traz Vencedor, Handicap e Total. Os restantes mercados são calculados:
   1) tira-se a margem das odds reais (1X2 e Total) → probabilidades "justas";
   2) ajusta-se um modelo Dixon-Coles (Poisson com correção de placares baixos) a essas probabilidades;
   3) o modelo dá a probabilidade de cada placar → probabilidade de cada mercado;
   4) aplica-se a margem da casa pelo método "power" (pesa mais nas zebras do que nos favoritos)
      e arredonda-se para baixo na escala de odds habitual das casas. */
const DERIVED_MARGIN = { dnb: 0.055, btts: 0.065, alt: 0.07, rt: 0.11, cs: 0.22 };
const DERIVED_MARKETS = new Set(['dnb', 'btts', 'alt', 'rt', 'cs']);
const MAXG = 10;

const devig = (odds) => { const inv = odds.map((o) => 1 / o); const s = inv.reduce((a, b) => a + b, 0); return inv.map((x) => x / s); };
function pmf(l) { const out = [Math.exp(-l)]; for (let k = 1; k <= MAXG; k++) out.push(out[k - 1] * l / k); return out; }
function scoreMatrix(lh, la, rho) {
  const ph = pmf(lh), pa = pmf(la); const P = []; let s = 0;
  for (let i = 0; i <= MAXG; i++) {
    P.push([]);
    for (let j = 0; j <= MAXG; j++) {
      let tau = 1;
      if (i === 0 && j === 0) tau = 1 - lh * la * rho; else if (i === 0 && j === 1) tau = 1 + lh * rho;
      else if (i === 1 && j === 0) tau = 1 + la * rho; else if (i === 1 && j === 1) tau = 1 - rho;
      const v = Math.max(0, ph[i] * pa[j] * tau); P[i].push(v); s += v;
    }
  }
  for (const row of P) for (let j = 0; j <= MAXG; j++) row[j] /= s;
  return P;
}
const sumP = (P, f) => { let s = 0; for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) if (f(i, j)) s += P[i][j]; return s; };
// probabilidade de "mais de L" sem contar devoluções (linhas inteiras e de quarto)
function overShare(P, L) {
  const half = (x) => { const over = sumP(P, (i, j) => i + j > x), under = sumP(P, (i, j) => i + j < x); return over / (over + under || 1); };
  if (Math.abs(L * 4 - Math.round(L * 4)) > 1e-9) return null;
  if (Math.round(L * 4) % 2 !== 0) return (half(L - 0.25) + half(L + 0.25)) / 2; // linha de quarto (2.25, 2.75)
  return half(L);
}
function fitModel(pH, pD, pA, L, pOver) {
  const err = (lh, la, rho) => {
    const P = scoreMatrix(lh, la, rho);
    let e = (sumP(P, (i, j) => i > j) - pH) ** 2 + (sumP(P, (i, j) => i === j) - pD) ** 2 + (sumP(P, (i, j) => i < j) - pA) ** 2;
    if (pOver != null) e += (overShare(P, L) - pOver) ** 2;
    return e;
  };
  let best = { lh: 1.4, la: 1.1, rho: -0.05, e: Infinity };
  for (let lh = 0.2; lh <= 4; lh += 0.2) for (let la = 0.2; la <= 4; la += 0.2) for (const rho of [-0.15, -0.08, 0]) {
    const e = err(lh, la, rho); if (e < best.e) best = { lh, la, rho, e };
  }
  for (let step = 0.1; step >= 0.005; step /= 2) { // refinamento local
    let improved = true;
    while (improved) {
      improved = false;
      for (const [dh, da, dr] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const lh = best.lh + dh * step, la = best.la + da * step, rho = Math.min(0.1, Math.max(-0.25, best.rho + dr * step / 2));
        if (lh < 0.05 || la < 0.05) continue;
        const e = err(lh, la, rho); if (e < best.e - 1e-12) { best = { lh, la, rho, e }; improved = true; }
      }
    }
  }
  return best;
}
// escala de odds das casas: arredonda SEMPRE para baixo (a favor da casa)
function ladder(o) {
  const step = o < 2 ? 0.01 : o < 3 ? 0.02 : o < 4 ? 0.05 : o < 6 ? 0.1 : o < 10 ? 0.2 : o < 20 ? 0.5 : o < 50 ? 1 : 5;
  return round2(Math.floor((o + 1e-9) / step) * step);
}
// aplica a margem M a probabilidades justas (soma 1) pelo método "power": Σ p^k = 1 + M
function priceWithMargin(probs, M) {
  // k < 1 aumenta a soma; procura o k que dá exatamente 1 + M
  let lo = 0.3, hi = 1;
  for (let it = 0; it < 50; it++) { const k = (lo + hi) / 2; const s = probs.reduce((a, p) => a + (p > 0 ? p ** k : 0), 0); if (s > 1 + M) lo = k; else hi = k; }
  const k = (lo + hi) / 2;
  return probs.map((p) => (p > 0 ? ladder(1 / p ** k) : null));
}
const derivedCache = new Map();
function deriveSoccer(m) {
  const tot = m.total;
  const cacheKey = [m.ml.home, m.ml.draw, m.ml.away, tot?.line, tot?.over, tot?.under].join('|');
  if (derivedCache.has(cacheKey)) return derivedCache.get(cacheKey);
  const [pH, pD, pA] = devig([m.ml.home, m.ml.draw, m.ml.away]);
  const pOver = tot && tot.over && tot.under ? devig([tot.over, tot.under])[0] : null;
  const fit = fitModel(pH, pD, pA, tot?.line, pOver != null && overShare(scoreMatrix(1, 1, 0), tot.line) != null ? pOver : null);
  const P = scoreMatrix(fit.lh, fit.la, fit.rho);
  const x = {};
  const two = (a, b, M) => { const [oa, ob] = priceWithMargin([a, b], M); return oa >= 1.05 && ob >= 1.05 ? [oa, ob] : null; };
  // Empate Anula Aposta (das probabilidades reais do 1X2)
  const dnb = two(pH / (pH + pA), pA / (pH + pA), DERIVED_MARGIN.dnb);
  if (dnb) x.dnb = { home: dnb[0], away: dnb[1] };
  // Ambas Marcam
  const by = sumP(P, (i, j) => i > 0 && j > 0);
  const btts = two(by, 1 - by, DERIVED_MARGIN.btts);
  if (btts) x.btts = { yes: btts[0], no: btts[1] };
  // Totais de gols alternativos
  x.alt = [];
  for (const L of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    if (tot && Math.abs(tot.line - L) < 1e-9) continue; // já existe a linha real
    const po = sumP(P, (i, j) => i + j > L);
    const r = two(po, 1 - po, DERIVED_MARGIN.alt);
    if (r) x.alt.push({ line: L, over: r[0], under: r[1] });
  }
  // Resultado + Total (2.5)
  const RT = [['home-over', (i, j) => i > j && i + j > 2.5], ['home-under', (i, j) => i > j && i + j < 2.5], ['draw-over', (i, j) => i === j && i + j > 2.5],
    ['draw-under', (i, j) => i === j && i + j < 2.5], ['away-over', (i, j) => i < j && i + j > 2.5], ['away-under', (i, j) => i < j && i + j < 2.5]];
  const rtP = RT.map(([, f]) => sumP(P, f));
  const rtO = priceWithMargin(rtP, DERIVED_MARGIN.rt);
  x.rt = RT.map(([pick], k) => ({ pick, odds: rtO[k] })).filter((s) => s.odds && s.odds >= 1.05 && s.odds <= 51);
  // Placar Exato (até 3 gols de cada lado + "outro placar")
  const cs = [];
  for (let i = 0; i <= 3; i++) for (let j = 0; j <= 3; j++) cs.push({ pick: `${i}-${j}`, p: P[i][j] });
  cs.push({ pick: 'other', p: Math.max(0, 1 - cs.reduce((a, c) => a + c.p, 0)) });
  const csO = priceWithMargin(cs.map((c) => c.p), DERIVED_MARGIN.cs);
  x.cs = cs.map((c, k) => ({ pick: c.pick, odds: csO[k] })).filter((s) => s.odds && s.odds >= 1.5 && s.odds <= 101);
  if (derivedCache.size > 2000) derivedCache.clear();
  derivedCache.set(cacheKey, x);
  return x;
}

/* ---------- feed ESPN ---------- */
const STATUS_PT = {
  STATUS_HALFTIME: 'Intervalo', STATUS_FULL_TIME: 'Encerrado', STATUS_FINAL: 'Encerrado', STATUS_FINAL_AET: 'Encerrado (prorr.)',
  STATUS_FINAL_PEN: 'Encerrado (pên.)', STATUS_POSTPONED: 'Adiado', STATUS_CANCELED: 'Cancelado', STATUS_ABANDONED: 'Abandonado',
  STATUS_SUSPENDED: 'Suspenso', STATUS_DELAYED: 'Atrasado', STATUS_END_OF_EXTRATIME: 'Fim da prorrogação', STATUS_SHOOTOUT: 'Pênaltis',
  STATUS_END_PERIOD: 'Fim do período', STATUS_OVERTIME: 'Prorrogação',
};
function translateDetail(s) {
  return String(s || '')
    .replace(/Halftime/i, 'Intervalo').replace(/End of /i, 'Fim do ').replace(/Top /i, 'Alto ').replace(/Bot(tom)? /i, 'Baixo ')
    .replace(/Mid /i, 'Meio ').replace(/(\d)(st|nd|rd|th)/g, '$1º').replace(/Quarter/i, 'Quarto').replace(/Period/i, 'Período')
    .replace(/\bOT\b/, 'Prorr.').replace(/Final/i, 'Encerrado');
}

function parseEvent(e, lg) {
  const c = e.competitions?.[0];
  if (!c || !lg) return null;
  const hc = c.competitors?.find((t) => t.homeAway === 'home'), ac = c.competitors?.find((t) => t.homeAway === 'away');
  if (!hc || !ac) return null;
  const st = e.status || c.status || {}; const t = st.type || {};
  const team = (x) => ({
    id: x.team?.id, name: x.team?.displayName || x.team?.name || '?',
    short: x.team?.shortDisplayName || x.team?.displayName || '?',
    logo: x.team?.logo || x.team?.logos?.[0]?.href || '', score: x.score != null && x.score !== '' ? parseInt(x.score, 10) : null, form: x.form || '',
  });
  const details = (c.details || []).map((d) => ({
    text: d.type?.text || '', min: d.clock?.displayValue || '', teamId: d.team?.id,
    player: d.athletesInvolved?.[0]?.displayName || '', goal: !!d.scoringPlay, yellow: !!d.yellowCard, red: !!d.redCard,
    own: !!d.ownGoal, pen: !!d.penaltyKick, shootout: !!d.shootout,
  }));
  let clock;
  if (t.state === 'in') clock = STATUS_PT[t.name] || (lg.sport === 'soccer' ? st.displayClock : translateDetail(t.shortDetail));
  else if (t.state === 'post') clock = STATUS_PT[t.name] || 'Encerrado';
  return {
    id: String(e.id), league: lg.key, leagueName: lg.name, country: lg.country, sport: lg.sport, path: lg.path,
    date: new Date(e.date || c.date), state: t.state, completed: !!t.completed, statusName: t.name || '', clock,
    home: team(hc), away: team(ac), details, venue: c.venue?.fullName || '',
    markets: t.state === 'post' ? null : parseOdds(c.odds, lg.sport, t.state),
  };
}

/* ---------- mercados ---------- */
const fmtLine = (l) => (l > 0 ? '+' + l : String(l));
const MARKET_NAMES = {
  ml: (ev) => (ev.sport === 'soccer' ? 'Resultado Final' : 'Vencedor (incl. prorrogação)'),
  dc: () => 'Dupla Chance',
  total: (ev, l) => (ev.sport === 'soccer' ? `Total de Gols — ${l}` : ev.sport === 'basketball' || ev.sport === 'football' ? `Total de Pontos — ${l}` : `Total — ${l}`),
  spread: (ev) => (ev.sport === 'soccer' ? 'Handicap Asiático' : 'Handicap'),
  dnb: () => 'Empate Anula Aposta',
  btts: () => 'Ambas Marcam',
  alt: (ev, l) => `Total de Gols — ${l}`,
  rt: () => 'Resultado + Total de Gols 2.5',
  cs: () => 'Placar Exato',
};

function selections(ev) {
  const m = ev.markets; const out = [];
  if (!m) return out;
  const H = ev.home.short, A = ev.away.short, soc = ev.sport === 'soccer';
  if (m.ml) {
    out.push({ market: 'ml', pick: 'home', lbl: soc ? '1' : H, name: H, odds: m.ml.home });
    if (m.ml.draw) out.push({ market: 'ml', pick: 'draw', lbl: 'X', name: 'Empate', odds: m.ml.draw });
    out.push({ market: 'ml', pick: 'away', lbl: soc ? '2' : A, name: A, odds: m.ml.away });
  }
  if (m.dc) {
    out.push({ market: 'dc', pick: 'hd', lbl: '1X', name: `${H} ou Empate`, odds: m.dc.hd });
    out.push({ market: 'dc', pick: 'ha', lbl: '12', name: `${H} ou ${A}`, odds: m.dc.ha });
    out.push({ market: 'dc', pick: 'da', lbl: 'X2', name: `Empate ou ${A}`, odds: m.dc.da });
  }
  if (m.total) {
    const L = m.total.line;
    out.push({ market: 'total', pick: 'over', line: L, lbl: `+${L}`, name: `Mais de ${L}`, odds: m.total.over });
    out.push({ market: 'total', pick: 'under', line: L, lbl: `-${L}`, name: `Menos de ${L}`, odds: m.total.under });
  }
  if (m.spread) {
    out.push({ market: 'spread', pick: 'home', line: m.spread.homeLine, lbl: fmtLine(m.spread.homeLine), name: `${H} ${fmtLine(m.spread.homeLine)}`, odds: m.spread.home });
    out.push({ market: 'spread', pick: 'away', line: m.spread.awayLine, lbl: fmtLine(m.spread.awayLine), name: `${A} ${fmtLine(m.spread.awayLine)}`, odds: m.spread.away });
  }
  const x = m.x;
  if (x) {
    if (x.dnb) {
      out.push({ market: 'dnb', pick: 'home', lbl: H, name: H, odds: x.dnb.home });
      out.push({ market: 'dnb', pick: 'away', lbl: A, name: A, odds: x.dnb.away });
    }
    if (x.btts) {
      out.push({ market: 'btts', pick: 'yes', lbl: 'Sim', name: 'Sim', odds: x.btts.yes });
      out.push({ market: 'btts', pick: 'no', lbl: 'Não', name: 'Não', odds: x.btts.no });
    }
    for (const a of x.alt || []) {
      out.push({ market: 'alt', pick: 'over', line: a.line, lbl: `+${a.line}`, name: `Mais de ${a.line}`, odds: a.over });
      out.push({ market: 'alt', pick: 'under', line: a.line, lbl: `-${a.line}`, name: `Menos de ${a.line}`, odds: a.under });
    }
    const RES = { home: H, draw: 'Empate', away: A };
    for (const r of x.rt || []) {
      const [res, ou] = r.pick.split('-');
      out.push({ market: 'rt', pick: r.pick, lbl: `${res === 'home' ? '1' : res === 'draw' ? 'X' : '2'} ${ou === 'over' ? '+' : '-'}2.5`, name: `${RES[res]} e ${ou === 'over' ? '+' : '-'}2.5`, odds: r.odds });
    }
    for (const c of x.cs || []) {
      const name = c.pick === 'other' ? 'Outro placar' : c.pick.replace('-', ' x ');
      out.push({ market: 'cs', pick: c.pick, lbl: name, name, odds: c.odds });
    }
  }
  for (const s of out) {
    // a linha faz parte da chave: se a linha mudar, a seleção antiga deixa de existir
    s.key = `${ev.id}|${s.market}|${s.pick}` + (s.line != null ? `|${s.line}` : '');
    s.marketName = MARKET_NAMES[s.market](ev, s.line);
  }
  return out.filter((s) => s.odds);
}

function isSuspended(ev, now = Date.now()) {
  return !ev || ev.state === 'post' || !ev.markets || (ev.suspendedUntil || 0) > now;
}

/* ---------- liquidação ---------- */
function regulationScore(ev) {
  // futebol vale para o tempo regulamentar (90 min + acréscimos)
  if (ev.sport !== 'soccer' || !/AET|PEN|EXTRA|SHOOTOUT/.test(ev.statusName)) return [ev.home.score, ev.away.score];
  let h = 0, a = 0;
  for (const d of ev.details) {
    if (!d.goal || d.shootout) continue;
    const min = parseInt(d.min, 10);
    if (!isFinite(min) || min > 90) continue;
    if (d.teamId === ev.home.id) h++; else if (d.teamId === ev.away.id) a++;
  }
  return [h, a];
}

// -1 perdeu · -0.5 meia perda · 0 devolvida · 0.5 meio ganho · 1 ganhou
function legOutcome(leg, h, a) {
  const base = (line) => {
    if (leg.market === 'total') { const t = h + a; return Math.sign(leg.pick === 'over' ? t - line : line - t); }
    return Math.sign(leg.pick === 'home' ? h + line - a : a + line - h);
  };
  switch (leg.market) {
    case 'ml': return (leg.pick === 'home' ? h > a : leg.pick === 'away' ? a > h : h === a) ? 1 : -1;
    case 'dc': return (leg.pick === 'hd' ? h >= a : leg.pick === 'da' ? a >= h : h !== a) ? 1 : -1;
    case 'dnb': return h === a ? 0 : (leg.pick === 'home' ? h > a : a > h) ? 1 : -1;
    case 'btts': return ((h > 0 && a > 0) === (leg.pick === 'yes')) ? 1 : -1;
    case 'alt': return (leg.pick === 'over' ? h + a > leg.line : h + a < leg.line) ? 1 : -1;
    case 'rt': {
      const [res, ou] = leg.pick.split('-');
      const okRes = res === 'home' ? h > a : res === 'away' ? a > h : h === a;
      const okTot = ou === 'over' ? h + a > 2.5 : h + a < 2.5;
      return okRes && okTot ? 1 : -1;
    }
    case 'cs': return (leg.pick === 'other' ? h > 3 || a > 3 : leg.pick === `${h}-${a}`) ? 1 : -1;
    case 'total': case 'spread': {
      const L = leg.line;
      if (Math.abs(Math.round(L * 4)) % 2 === 1) return (base(L - 0.25) + base(L + 0.25)) / 2;
      return base(L);
    }
  }
  return 0;
}
const outcomeFactor = (v, o) => (v === 1 ? o : v === 0.5 ? (1 + o) / 2 : v === 0 ? 1 : v === -0.5 ? 0.5 : 0);
const outcomeLabel = (v) => (v === 1 ? 'won' : v === 0.5 ? 'halfwon' : v === 0 ? 'void' : v === -0.5 ? 'halflost' : 'lost');

// tenta liquidar uma seleção com o evento; devolve true se mudou
function settleLeg(leg, ev) {
  if (leg.result || !ev || ev.state !== 'post') return false;
  if (/POSTPONED|CANCELED|ABANDONED/.test(ev.statusName)) { leg.result = 'void'; leg.value = 0; leg.final = ev.clock; return true; }
  if (!ev.completed || ev.home.score == null) return false;
  const [h, a] = regulationScore(ev);
  leg.value = legOutcome(leg, h, a);
  leg.result = outcomeLabel(leg.value);
  leg.final = `${h} x ${a}`;
  return true;
}

/* ---------- cash out ---------- */
const CASHOUT_MARGIN = 0.93;
// multiplicador sobre o valor apostado (null = indisponível)
function cashoutFactor(bet, findSel, now = Date.now()) {
  let f = 1;
  for (const leg of bet.legs) {
    if (leg.result) { f *= outcomeFactor(leg.value, leg.odds); continue; }
    const { ev, sel } = findSel(leg.key);
    if (!sel || isSuspended(ev, now)) return null;
    f *= leg.odds / sel.odds;
  }
  if (f <= 0) return null;
  return Math.min(f * CASHOUT_MARGIN, bet.odds * 0.98);
}

const Markets = {
  SPORTS, LEAGUES, LEAGUE_BY_KEY, round2, am2dec, parseOdds, parseEvent, STATUS_PT, translateDetail,
  fmtLine, MARKET_NAMES, selections, isSuspended, regulationScore, legOutcome, outcomeFactor, outcomeLabel, settleLeg, cashoutFactor, DERIVED_MARKETS, deriveSoccer, scoreMatrix, sumP, fitModel, priceWithMargin, ladder, devig,
};
if (typeof module !== 'undefined' && module.exports) module.exports = Markets;
