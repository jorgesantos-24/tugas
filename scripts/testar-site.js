'use strict';
/* Teste de ponta a ponta das apostas, da liquidação e do cash out no site de TESTE (npm run dev a correr).
   Uso: node scripts/testar-site.js [http://localhost:3100]
   Só funciona com os emuladores (usa /api/dev/credit, /api/dev/finish e /api/dev/suspend). Nada aqui é dinheiro real.

   Para cada modalidade (futebol, basquete, hóquei, ténis), numa conta nova:
     1) aposta R$ 1 em cada seleção aberta de um jogo real (antes do jogo) e numa múltipla;
     2) cash out em 3 apostas (valor = o que o site calcula), cash out repetido (tem de ser recusado),
        e cash out / aposta com o jogo suspenso (têm de ser recusados);
     3) termina o jogo com um resultado escolhido e confere cada aposta: estado e prémio, ao cêntimo;
     4) confere o saldo final e que terminar o jogo outra vez não paga nada a mais. */

const path = require('node:path');
const M = require(path.join(__dirname, '..', 'public', 'markets.js'));
const B = process.argv[2] || 'http://localhost:3100';

let pass = 0, failN = 0;
const fails = [];
const check = (c, what) => { if (c) pass++; else { failN++; fails.push(what); } };
const cpf = () => { const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)); for (const k of [9, 10]) { let s = 0; for (let i = 0; i < k; i++) s += n[i] * (k + 1 - i); n.push(((s * 10) % 11) % 10); } return n.join(''); };
const cents = (v) => Math.round(v * 100);

function client() {
  let cookie = '';
  return async function api(method, p, body, okCodes = [200]) {
    const r = await fetch(B + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let d = {}; try { d = await r.json(); } catch { /* vazio */ }
    if (!okCodes.includes(r.status)) throw new Error(`${method} ${p}: ${r.status} ${d.error || ''}`);
    return { status: r.status, ...d };
  };
}

// partida de ténis consistente (sets + histórico game a game) para o resultado simulado
function tennisResult() {
  const seqs = [{ wins: 'HAHAHAHAHH' }, { wins: 'HAHAHAHAHAHA', tb: [5, 7] }, { wins: 'HAHAHAHAHAHH' }];
  const sets = [], log = []; let srv = 'home', k = 0; const lps = [0, 15, 30, 40, 15, 30];
  seqs.forEach((q, si) => {
    const sc = [0, 0];
    [...q.wins].forEach((c, g) => { const w = c === 'H' ? 'home' : 'away'; sc[w === 'home' ? 0 : 1]++; log.push({ s: si + 1, g: g + 1, w, srv, lp: lps[k++ % 6] }); srv = srv === 'home' ? 'away' : 'home'; });
    if (q.tb) { const w = q.tb[0] > q.tb[1] ? 'home' : 'away'; sc[w === 'home' ? 0 : 1]++; log.push({ s: si + 1, g: q.wins.length + 1, w, tb: true, tbScore: q.tb }); srv = srv === 'home' ? 'away' : 'home'; }
    sets.push(sc);
  });
  // pontos de cada game (como os gravados ao vivo): sequência completa coerente com o placar, para os mercados de pontos
  const P = require(path.join(__dirname, '..', 'feeds', 'points.js'));
  const V = ['0', '15', '30', '40'], pts = {};
  log.forEach((e) => {
    const w = e.w, l = w === 'home' ? 'away' : 'home';
    const seq = e.tb ? [...Array(Math.min(...e.tbScore))].flatMap(() => [w, l]).concat([...Array(Math.max(...e.tbScore) - Math.min(...e.tbScore))].map(() => w))
      : e.lp === 40 ? [l, w, l, w, l, w, w, w] /* 40-40, vantagem, game */ : [...Array(e.lp / 15)].map(() => l).concat([w, w, w, w]);
    let h = 0, a = 0; const o = [{ h: '0', a: '0', t: 0, t2: 0 }];
    seq.slice(0, -1).forEach((x, j) => { if (x === 'home') h++; else a++; const t = (j + 1) * 5000;
      if (e.tb) o.push({ h: String(h), a: String(a), t, t2: t });
      else { const d = h >= 3 && a >= 3; o.push({ h: d ? (h > a ? 'A' : '40') : V[h], a: d ? (a > h ? 'A' : '40') : V[a], t, t2: t }); } });
    const r = e.tb ? P.resolveTb(e, o) : P.resolveGame(e, o, seq.length * 5000);
    if (r) pts[`${e.s}/${e.g}`] = { ...r, tb: !!e.tb };
  });
  return { h: 2, a: 1, sets, log, aces: [6, 2], dfs: [1, 3], pts };
}
const RESULTS = {
  // parts = placar de cada parte (tempos, quartos, períodos, escanteios, mapas): os mercados por parte liquidam-se sozinhos
  soccer: { h: 2, a: 1, parts: { h1: [1, 0], h2: [1, 1], corners: [6, 4] } },
  basketball: { h: 101, a: 99, parts: { q1: [25, 20], q2: [20, 30], q3: [28, 24], q4: [24, 21], h1: [45, 50], h2: [56, 49] } },
  hockey: { h: 2, a: 2, reg: [2, 2], alts: [[3, 2], [2, 3]], parts: { p1: [1, 0], p2: [0, 2], p3: [1, 0] } }, // decidido nos pênaltis: parte das apostas fica para a equipa
  tennis: tennisResult(),
  esports: { h: 2, a: 1, maps: [[13, 7], [10, 13], [16, 14]], parts: { map1: [13, 7], map2: [10, 13], map3: [16, 14] } },
};

const USED = new Set(); // jogos já terminados por um teste (não se reutilizam)
async function testSport(sport, list) {
  const api = client();
  const tag = (s) => `[${sport}] ${s}`;
  // jogo antes do início com mais seleções
  const cand = list.filter((e) => e.sport === sport && e.state === 'pre' && !USED.has(e.id) && !M.isSuspended({ ...e, date: new Date(e.date) })).sort((a, b) => (b.nsel || 0) - (a.nsel || 0));
  if (!cand.length) { check(false, tag('sem jogo disponível')); return; }
  USED.add(cand[0].id);
  const { events: [full] } = await api('GET', `/api/events/full?ids=${cand[0].id}`);
  const ev = { ...full, date: new Date(full.date) };
  const sels = M.selections(ev).filter((s) => !s.locked);
  console.log(`\n${sport}: ${M.evLabel(ev)} (${ev.leagueName}) · ${sels.length} seleções abertas`);
  await api('POST', '/api/register', { name: 'Teste Automatico', email: `e2e${Date.now()}${Math.random().toString(36).slice(2, 6)}@ex.com`, password: 'senha1234', birthdate: '1990-01-01', terms: true, cpf: cpf() });
  for (let i = 0; i < 3; i++) await api('POST', '/api/dev/credit', {}); // R$ 3.000
  const start = (await api('GET', '/api/me')).user.balance;

  // 1) R$ 1 em cada seleção automática (até 120) e numa seleção de cada mercado da equipa (até 60)
  //    — o histórico da conta mostra as últimas 200 apostas
  const seenMk = new Set();
  const manualPick = sels.filter((s) => s.manual).filter((s) => !seenMk.has(s.marketName) && seenMk.add(s.marketName)).slice(0, 60);
  const pick = sels.filter((s) => !s.manual).slice(0, 120).concat(manualPick);
  console.log(`  a apostar em ${pick.length - manualPick.length} seleções automáticas e ${manualPick.length} de mercados da equipa`);
  const placed = [];
  for (let i = 0; i < pick.length; i += 20) {
    const chunk = pick.slice(i, i + 20);
    const r = await api('POST', '/api/bets', { acceptAny: true, tickets: chunk.map((s) => ({ keys: [s.key], odds: [s.odds], stake: 1 })) });
    for (const p of r.placed) placed.push(p.bet);
    for (const x of r.rejected) check(false, tag(`aposta recusada: ${chunk[x.index].marketName} ${chunk[x.index].name} → ${x.reason}`));
  }
  check(placed.length === pick.length, tag(`apostas aceites ${placed.length}/${pick.length}`));
  const stakes = placed.reduce((s, b) => s + cents(b.stake), 0);
  let bal = (await api('GET', '/api/me')).user.balance;
  check(cents(bal) === cents(start) - stakes, tag(`saldo depois das apostas: ${bal} (esperado ${(cents(start) - stakes) / 100})`));

  // 2) cash out
  const coBets = placed.slice(0, 3);
  let coTotal = 0;
  for (const b of coBets) {
    const { events: [f2] } = await api('GET', `/api/events/full?ids=${ev.id}`);
    const e2 = { ...f2, date: new Date(f2.date) };
    const findSel = (key) => ({ ev: e2, sel: M.selections(e2).find((s) => s.key === key) || null });
    const f = M.cashoutFactor(b, findSel);
    const r = await api('POST', '/api/cashout', { id: b.id }, [200, 409]);
    if (f == null) { check(r.status === 409, tag(`cash out indisponível devia ser recusado (${b.legs[0].marketName})`)); continue; }
    const expect = Math.floor(cents(b.stake) * f) / 100;
    check(r.status === 200, tag(`cash out recusado: ${r.error}`));
    if (r.status === 200) { coTotal += cents(r.value); check(Math.abs(cents(r.value) - cents(expect)) <= 1, tag(`valor do cash out ${r.value} (esperado ${expect})`)); }
    const again = await api('POST', '/api/cashout', { id: b.id }, [200, 409]);
    check(again.status === 409, tag('cash out repetido tinha de ser recusado'));
  }
  // jogo suspenso: cash out e aposta nova recusados
  await api('POST', '/api/dev/suspend', { id: ev.id, seconds: 20 });
  const susp = await api('POST', '/api/cashout', { id: placed[5].id }, [200, 409]);
  check(susp.status === 409, tag('cash out com o jogo suspenso tinha de ser recusado'));
  const sb = await api('POST', '/api/bets', { acceptAny: true, tickets: [{ keys: [pick[0].key], stake: 1 }] }, [200, 409]);
  check(sb.status === 409, tag('aposta com o jogo suspenso tinha de ser recusada'));
  bal = (await api('GET', '/api/me')).user.balance;
  check(cents(bal) === cents(start) - stakes + coTotal, tag(`saldo depois do cash out: ${bal}`));

  // 3) fim do jogo e liquidação
  const R = RESULTS[sport];
  await api('POST', '/api/dev/finish', { id: ev.id, result: R });
  const { bets } = await api('GET', '/api/bets');
  const byId = new Map(bets.map((b) => [b.id, b]));
  const fev = { state: 'post', completed: true, statusName: '', result: R };
  let paid = 0, open = 0, wrong = 0;
  const tally = {};
  const pendingBets = [];
  for (const b0 of placed) {
    const b = byId.get(b0.id);
    if (!b) { check(false, tag(`aposta ${b0.id} não aparece no histórico`)); continue; }
    if (coBets.some((c) => c.id === b.id)) { check(b.status === 'cashout', tag(`aposta com cash out mudou para ${b.status}`)); continue; }
    const leg = { ...b0.legs[0], result: null };
    const decided = M.settleLeg(leg, fev);
    if (!decided) { open++; pendingBets.push(b0); check(b.status === 'open', tag(`${leg.marketName} ${leg.name}: devia ficar em aberto para a equipa, está ${b.status}`)); continue; }
    const payout = Math.round(cents(b0.stake) * M.outcomeFactor(leg.value, leg.odds));
    const status = payout === 0 ? 'lost' : payout > cents(b0.stake) ? 'won' : 'void';
    tally[leg.result] = (tally[leg.result] || 0) + 1;
    paid += payout;
    if (b.status !== status || cents(b.payout || 0) !== payout) { wrong++; check(false, tag(`${leg.marketName} · ${leg.name} @${leg.odds}: ${b.status} R$${b.payout} (esperado ${status} R$${payout / 100})`)); } else pass++;
  }
  console.log(`  liquidadas sozinhas: ${JSON.stringify(tally)} · para a equipa: ${open} · com cash out: ${coBets.length} · erradas: ${wrong}`);

  // 3b) mercados da equipa: liquidar como no painel (1ª seleção ganha, 2ª devolvida, resto perde) e conferir
  const gk = (l) => `${l.evId}|${l.market}|${l.per ?? ''}|${l.line ?? ''}|${Array.isArray(l.base) ? l.base.join('-') : ''}`;
  const { groups } = await api('GET', '/api/dev/pending');
  const mine = groups.filter((g) => g.evId === ev.id);
  const decidedBy = new Map();
  for (const g of mine) {
    const results = {};
    g.picks.forEach((p, i) => { results[p.pick] = i === 0 ? 'won' : i === 1 ? 'void' : 'lost'; });
    await api('POST', '/api/dev/settle-market', { key: g.key, results });
    for (const [p, r] of Object.entries(results)) decidedBy.set(`${g.key}#${p}`, r);
  }
  check(mine.length > 0 || !pendingBets.length, tag(`apostas por liquidar sem mercado no painel (${pendingBets.length})`));
  const after = new Map((await api('GET', '/api/bets')).bets.map((b) => [b.id, b]));
  let manualPaid = 0, manualOk = 0;
  for (const b0 of pendingBets) {
    const l = b0.legs[0], r = decidedBy.get(`${gk(l)}#${l.pick}`), b = after.get(b0.id);
    if (!r) { check(false, tag(`${l.marketName} ${l.name}: não apareceu em "Mercados por liquidar"`)); continue; }
    const payout = r === 'won' ? Math.round(cents(b0.stake) * l.odds) : r === 'void' ? cents(b0.stake) : 0;
    const status = r === 'won' ? 'won' : r === 'void' ? 'void' : 'lost';
    if (b.status === status && cents(b.payout || 0) === payout) { manualOk++; pass++; } else check(false, tag(`painel ${l.marketName} · ${l.name}: ${b.status} R$${b.payout} (esperado ${status} R$${payout / 100})`));
    manualPaid += payout;
  }
  console.log(`  mercados da equipa: ${mine.length} liquidados no "painel", ${manualOk}/${pendingBets.length} apostas pagas certo`);
  paid += manualPaid;
  bal = (await api('GET', '/api/me')).user.balance;
  const expectBal = cents(start) - stakes + coTotal + paid;
  check(cents(bal) === expectBal, tag(`saldo final ${bal} (esperado ${expectBal / 100})`));
  // 4) terminar outra vez não paga nada a mais
  await api('POST', '/api/dev/finish', { id: ev.id, result: R });
  const bal2 = (await api('GET', '/api/me')).user.balance;
  check(cents(bal2) === cents(bal), tag(`segundo fim de jogo mudou o saldo: ${bal} → ${bal2}`));
  console.log(`  saldo: início ${start} · apostado ${stakes / 100} · cash out ${coTotal / 100} · prémios ${paid / 100} · final ${bal2}`);
}

async function testMultiple(list) {
  // múltipla futebol + basquete + ténis numa conta nova; um jogo termina de cada vez
  const api = client();
  await api('POST', '/api/register', { name: 'Teste Multipla', email: `mult${Date.now()}@ex.com`, password: 'senha1234', birthdate: '1990-01-01', terms: true, cpf: cpf() });
  await api('POST', '/api/dev/credit', {});
  const pickEv = (sport) => list.find((e) => e.sport === sport && e.state === 'pre' && !M.isSuspended({ ...e, date: new Date(e.date) }) && e.markets?.length);
  const evs = ['soccer', 'basketball', 'tennis'].map(pickEv).filter(Boolean);
  const { events: fulls } = await api('GET', `/api/events/full?ids=${evs.map((e) => e.id).join(',')}`);
  const legs = fulls.map((f) => M.selections({ ...f, date: new Date(f.date) }).find((s) => s.market === 'ml' && s.pick === 'home' && !s.locked)).filter(Boolean);
  const r = await api('POST', '/api/bets', { acceptAny: true, tickets: [{ keys: legs.map((s) => s.key), stake: 10 }] });
  check(r.placed.length === 1, `[múltipla] não foi aceite: ${JSON.stringify(r.rejected)}`);
  if (!r.placed.length) return;
  const bet = r.placed[0].bet;
  console.log(`\nmúltipla de ${legs.length} seleções @${bet.odds}: ${bet.legs.map((l) => l.event).join(' + ')}`);
  // 1º jogo: ganha → continua em aberto; 2º: devolvido (basquete não tem empate: usamos um placar em que a casa ganha); 3º: ganha → paga
  const order = legs.map((s) => s.key.split('|')[0]); // só os jogos que entraram na múltipla
  const res = { [order[0]]: { h: 2, a: 0 }, [order[1]]: { h: 100, a: 90 }, [order[2]]: RESULTS.tennis };
  for (let i = 0; i < order.length; i++) {
    await api('POST', '/api/dev/finish', { id: order[i], result: res[order[i]] });
    const b = (await api('GET', '/api/bets')).bets.find((x) => x.id === bet.id);
    const last = i === order.length - 1;
    check(last ? b.status === 'won' : b.status === 'open', `[múltipla] depois do jogo ${i + 1}: ${b.status}`);
    if (last) check(cents(b.payout) === Math.round(1000 * bet.odds), `[múltipla] prémio ${b.payout} (esperado ${(1000 * bet.odds / 100).toFixed(2)})`);
  }
  // múltipla que perde no 1º jogo fecha logo
  const api2 = client();
  await api2('POST', '/api/register', { name: 'Teste Multipla Dois', email: `mult2${Date.now()}@ex.com`, password: 'senha1234', birthdate: '1990-01-01', terms: true, cpf: cpf() });
  await api2('POST', '/api/dev/credit', {});
  const pool = list.filter((e) => e.sport === 'soccer' && e.state === 'pre' && !M.isSuspended({ ...e, date: new Date(e.date) }) && e.markets?.length).slice(0, 4);
  const { events: f2 } = await api2('GET', `/api/events/full?ids=${pool.map((e) => e.id).join(',')}`);
  const k2 = f2.map((f) => M.selections({ ...f, date: new Date(f.date) }).find((s) => s.market === 'ml' && s.pick === 'away' && !s.locked)).filter(Boolean).slice(0, 2);
  const r2 = await api2('POST', '/api/bets', { acceptAny: true, tickets: [{ keys: k2.map((s) => s.key), stake: 5 }] });
  if (r2.placed.length) {
    await api2('POST', '/api/dev/finish', { id: k2[0].key.split('|')[0], result: { h: 3, a: 0 } });
    const b = (await api2('GET', '/api/bets')).bets.find((x) => x.id === r2.placed[0].bet.id);
    check(b.status === 'lost' && cents(b.payout || 0) === 0, `[múltipla] perdida no 1º jogo devia fechar logo: ${b.status}`);
    console.log(`múltipla perdida no 1º jogo: ${b.status} (prémio ${b.payout})`);
    // a 2ª seleção continua a ser marcada quando o jogo dela acaba (só para mostrar; saldo e estado não mudam)
    const bal1 = (await api2('GET', '/api/me')).user.balance;
    await api2('POST', '/api/dev/finish', { id: k2[1].key.split('|')[0], result: { h: 0, a: 2 } });
    let b2 = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      b2 = (await api2('GET', '/api/bets')).bets.find((x) => x.id === r2.placed[0].bet.id);
      if (b2?.legs?.[1]?.result) break;
    }
    check(b2?.legs?.[1]?.result === 'won', `[múltipla] 2ª seleção da múltipla já perdida devia ficar marcada "ganha": ${b2?.legs?.[1]?.result}`);
    check(b2?.status === 'lost' && cents(b2.payout || 0) === 0, `[múltipla] estado e prémio não podem mudar: ${b2?.status} ${b2?.payout}`);
    check(cents((await api2('GET', '/api/me')).user.balance) === cents(bal1), '[múltipla] marcar a seleção não pode mexer no saldo');
    console.log(`  2ª seleção marcada depois: ${b2?.legs?.[1]?.result} · aposta continua ${b2?.status}`);
  }
}

async function testPartial(list) {
  // boletim de apostas simples com uma seleção suspensa: as outras são aceites, só essa é recusada (e o saldo bate certo)
  const api = client();
  await api('POST', '/api/register', { name: 'Teste Parcial', email: `parc${Date.now()}@ex.com`, password: 'senha1234', birthdate: '1990-01-01', terms: true, cpf: cpf() });
  await api('POST', '/api/dev/credit', {});
  const start = (await api('GET', '/api/me')).user.balance;
  const evs = list.filter((e) => e.state === 'pre' && !USED.has(e.id) && !M.isSuspended({ ...e, date: new Date(e.date) }) && new Date(e.date) - Date.now() > 3600000).slice(0, 12);
  const { events: all } = await api('GET', `/api/events/full?ids=${evs.map((e) => e.id).join(',')}`);
  const fulls = all.filter((f) => M.selections({ ...f, date: new Date(f.date) }).some((s) => !s.locked)).slice(0, 3); // 3 jogos com seleções abertas
  const sels = fulls.map((f) => M.selections({ ...f, date: new Date(f.date) }).find((s) => !s.locked));
  if (sels.length < 3) { check(false, '[parcial] sem 3 jogos disponíveis'); return; }
  await api('POST', '/api/dev/suspend', { id: fulls[0].id, seconds: 20 });
  const r = await api('POST', '/api/bets', { acceptAny: true, tickets: sels.map((s) => ({ keys: [s.key], stake: 2 })) });
  check(r.placed.length === 2, `[parcial] deviam entrar 2 apostas, entraram ${r.placed.length}`);
  check(r.rejected.length === 1 && r.rejected[0].index === 0 && /suspenso/.test(r.rejected[0].reason), `[parcial] só a do jogo suspenso devia ser recusada: ${JSON.stringify(r.rejected)}`);
  const bal = (await api('GET', '/api/me')).user.balance;
  check(cents(bal) === cents(start) - 400, `[parcial] saldo devia descontar só as 2 aceites (R$ 4): ${start} → ${bal}`);
  // todas suspensas: recusado inteiro, sem descontar nada
  const r2 = await api('POST', '/api/bets', { acceptAny: true, tickets: [{ keys: [sels[0].key], stake: 2 }] }, [200, 409]);
  check(r2.status === 409, '[parcial] boletim só com a suspensa devia ser recusado');
  check(cents((await api('GET', '/api/me')).user.balance) === cents(bal), '[parcial] recusa total não pode mexer no saldo');
  console.log(`\nboletim com 1 seleção suspensa em 3: ${r.placed.length} aceites, ${r.rejected.length} recusada (${r.rejected[0]?.reason})`);
}

async function testLiveCashout(list) {
  // ao vivo (ténis): aposta e cash out com a espera de aprovação
  const api = client();
  await api('POST', '/api/register', { name: 'Teste Ao Vivo', email: `live${Date.now()}@ex.com`, password: 'senha1234', birthdate: '1990-01-01', terms: true, cpf: cpf() });
  await api('POST', '/api/dev/credit', {});
  const live = list.filter((e) => e.sport === 'tennis' && e.state === 'in' && e.markets?.length);
  const wait = ((await api('GET', '/api/me')).liveDelays || {}).tennis || 6; // espera ao vivo do ténis (segundos)
  for (const e of live.slice(0, 5)) {
    const { events: [f] } = await api('GET', `/api/events/full?ids=${e.id}`);
    const ev = { ...f, date: new Date(f.date) };
    if (M.isSuspended(ev)) continue;
    const s = M.selections(ev).find((x) => x.market === 'ml' && !x.locked);
    if (!s) continue;
    const t0 = Date.now();
    const r = await api('POST', '/api/bets', { acceptAny: true, tickets: [{ keys: [s.key], stake: 5 }] });
    check(Date.now() - t0 >= wait * 1000, `[ao vivo] a aposta ao vivo devia esperar a aprovação (${wait} s)`);
    if (!r.placed.length) { console.log(`ao vivo: aposta recusada (${r.rejected[0]?.reason}) — tenta outro jogo`); continue; }
    console.log(`\nao vivo: ${M.evLabel(ev)} ${ev.clock} · ${s.name} @${r.placed[0].bet.odds} aceite em ${Math.round((Date.now() - t0) / 1000)} s`);
    const t1 = Date.now();
    const c = await api('POST', '/api/cashout', { id: r.placed[0].bet.id }, [200, 409]);
    console.log(`ao vivo: cash out ${c.status === 200 ? `pago R$ ${c.value}` : `recusado: ${c.error}`} em ${Math.round((Date.now() - t1) / 1000)} s`);
    check(c.status === 200 || /mudou|suspenso|indisponível|ponto|estado/i.test(c.error || ''), `[ao vivo] cash out com resposta inesperada: ${c.error}`);
    check(Date.now() - t1 >= wait * 1000, `[ao vivo] o cash out ao vivo devia esperar a aprovação (${wait} s)`);
    return;
  }
  console.log('\nao vivo: nenhum jogo de ténis ao vivo com mercados abertos agora (teste ao vivo não corrido)');
}

(async () => {
  console.log(`Teste de ponta a ponta em ${B}`);
  const me = await client()('GET', '/api/me');
  if (!me.testMode) { console.error('Este teste só corre no site de teste (npm run dev).'); process.exit(1); }
  const { events: list } = await client()('GET', '/api/events');
  for (const sport of ['soccer', 'basketball', 'hockey', 'tennis', 'esports']) {
    try { await testSport(sport, list); } catch (e) { check(false, `[${sport}] ${e.message}`); }
  }
  try { await testMultiple(list); } catch (e) { check(false, `[múltipla] ${e.message}`); }
  try { await testPartial(list); } catch (e) { check(false, `[parcial] ${e.message}`); }
  try { await testLiveCashout(list); } catch (e) { check(false, `[ao vivo] ${e.message}`); }
  console.log(`\n${pass} verificações certas · ${failN} erradas`);
  for (const f of fails.slice(0, 80)) console.log('  ✘ ' + f);
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
