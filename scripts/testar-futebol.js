'use strict';
/* Testes da proteção das odds do futebol (feeds/guard-soccer.js). Uso: npm run testar:futebol
   1) casos reais de 28/10 (cotações paradas na fonte) e casos à mão: o que tem de sair e o que tem de ficar;
   3) prolongamento e penáltis com a ESPN gravada (Sestao x Espanyol 27/10 AET, Fleetwood x Arsenal penáltis);
   2) oferta atual da MoviOdds (internet): trocas de lados simuladas em cada par de mercados irmãos têm de ser apanhadas,
      e nada é tirado sem razão (o que sai é mostrado). */
const path = require('path');
process.env.MOVIODDS_WS = '0'; process.env.NO_EXTERNAL = '1';
const ROOT = path.join(__dirname, '..');
const G = require(path.join(ROOT, 'feeds', 'guard-soccer.js'));
const TEN = require(path.join(ROOT, 'feeds', 'tennis.js'));

let ok = 0, bad = 0;
const check = (c, msg) => { if (c) ok++; else { bad++; console.log('  ✘', msg); } };
const mkt = (k, sels) => ({ k, sels: sels.map(([pick, odds, line]) => ({ pick, odds, lock: false, ...(line != null ? { line } : {}) })) });
const locked = (mk) => mk.sels.every((x) => x.lock), open = (mk) => mk.sels.every((x) => !x.lock);
const run = (list) => { const b = new Map(list.map((m) => [m.k, m])); TEN.guardOverround(b); G.guardSoccer(b); return b; };

function cases() {
  console.log('1) casos reais e à mão');
  // Fidelis Andria x Virtus Francavilla 28/10: empate anula parado (10:08) com o 1X2 das 19:10
  let b = run([mkt('ml', [['home', 2.05], ['draw', 3.25], ['away', 3.2]]), mkt('dc', [['hd', 1.29], ['ha', 1.33], ['da', 1.6]]), mkt('dnb', [['home', 1.8], ['away', 1.91]])]);
  check(locked(b.get('dnb')) && open(b.get('ml')) && open(b.get('dc')), 'Fidelis: empate anula parado sai, 1X2 e dupla hipótese ficam');
  // Bitlis x Kayserispor 28/10: dupla hipótese parada (14:41) com o 1X2 das 18:43
  b = run([mkt('ml', [['home', 2.75], ['draw', 4.33], ['away', 1.9]]), mkt('dc', [['hd', 4.5], ['ha', 1.1], ['da', 1.05]]), mkt('dnb', [['home', 2.4], ['away', 1.55]])]);
  check(locked(b.get('dc')) && open(b.get('ml')) && open(b.get('dnb')), 'Bitlis: dupla hipótese parada sai, 1X2 e empate anula (coerentes) ficam');
  // 1X2 sem nenhum irmão a concordar: sai tudo o que não bate
  b = run([mkt('ml', [['home', 2.75], ['draw', 4.33], ['away', 1.9]]), mkt('dc', [['hd', 4.5], ['ha', 1.1], ['da', 1.05]])]);
  check(locked(b.get('dc')) && locked(b.get('ml')), '1X2 e único irmão discordam: saem os dois');
  // tudo coerente: nada sai
  b = run([mkt('ml', [['home', 1.8], ['draw', 3.6], ['away', 4.5]]), mkt('dc', [['hd', 1.18], ['ha', 1.3], ['da', 2.0]]), mkt('dnb', [['home', 1.33], ['away', 3.3]]), mkt('btts', [['yes', 1.85], ['no', 1.9]])]);
  check([...b.values()].every(open), 'mercados coerentes: nada sai');
  // lados trocados no empate anula
  b = run([mkt('ml', [['home', 1.8], ['draw', 3.6], ['away', 4.5]]), mkt('dc', [['hd', 1.18], ['ha', 1.3], ['da', 2.0]]), mkt('dnb', [['home', 3.3], ['away', 1.33]])]);
  check(locked(b.get('dnb')) && open(b.get('ml')), 'empate anula trocado sai');
  // handicap asiático: casa -0,25 e fora -0,25 são apostas diferentes (não é "lucro garantido")
  b = run([mkt('spread', [['home', 2.3, -0.25], ['away', 2.3, -0.25], ['home', 1.6, 0.25], ['away', 1.65, 0.25]])]);
  check(open(b.get('spread')), 'handicap: casa -0,25 com fora -0,25 não é tratado como par');
  b = run([mkt('spread', [['home', 2.1, -0.25], ['away', 2.1, 0.25]])]);
  check(locked(b.get('spread')), 'handicap: casa -0,25 @2.10 e fora +0,25 @2.10 = lucro garantido → sai');
  // handicap -0,5 trocado em relação ao 1X2
  b = run([mkt('ml', [['home', 1.8], ['draw', 3.6], ['away', 4.5]]), mkt('dnb', [['home', 1.33], ['away', 3.3]]), mkt('spread', [['home', 2.6, -0.5], ['away', 1.5, 0.5]])]);
  check(b.get('spread').sels.every((x) => x.lock) && open(b.get('ml')), 'handicap -0,5 trocado sai');
  // total de gols: mais de 2,5 mais provável que mais de 1,5 é impossível
  b = run([mkt('total', [['over', 1.3, 1.5], ['under', 3.4, 1.5], ['over', 1.2, 2.5], ['under', 4.2, 2.5], ['over', 2.6, 3.5], ['under', 1.48, 3.5]])]);
  const t = b.get('total').sels;
  check(t.filter((x) => x.line <= 2.5).every((x) => x.lock) && t.filter((x) => x.line === 3.5).every((x) => !x.lock), 'total: linhas 1,5/2,5 incoerentes saem, 3,5 fica');
  // odds impossíveis
  b = run([mkt('btts', [['yes', 2.1], ['no', 2.1]])]);
  check(locked(b.get('btts')), 'ambas marcam a 2.10/2.10 (lucro garantido) sai');
}

async function live() {
  console.log('2) oferta atual da MoviOdds (internet)');
  const F = require(path.join(ROOT, 'feeds', 'moviodds.js'));
  let lists;
  try { lists = await Promise.all(['https://moviodds.com/odds?sport=soccer&in_play=1', 'https://moviodds.com/odds?sport=soccer'].map(async (u) => (await fetch(u, { signal: AbortSignal.timeout(120000) })).json())); }
  catch (e) { console.log(`   fonte indisponível (${e.message}): parte 2 não corre`); return; }
  let swaps = 0, caught = 0, small = 0, events = 0;
  for (const j of lists) for (const m of j.matches || []) {
    const ev = F.toEvent(m, Date.parse(j.server_time) || Date.now(), 'soccer', true);
    if (!ev?.markets) continue;
    events++;
    const base = new Map(ev.markets.filter((x) => !x.per && x.sels.every((s) => !s.lock)).map((x) => [x.k, x]));
    if (!base.has('ml') || base.get('ml').sels.length !== 3) continue;
    for (const k of ['dnb', 'dc']) {
      if (!base.has(k)) continue;
      const copy = new Map([...base].map(([kk, v]) => [kk, { ...v, sels: v.sels.map((s) => ({ ...s, lock: false, guard: false })) }]));
      const mk = copy.get(k);
      // troca: no empate anula casa↔fora; na dupla hipótese 1X↔X2
      const sw = k === 'dnb' ? { home: 'away', away: 'home' } : { hd: 'da', da: 'hd' };
      const before = mk.sels.map((s) => s.odds);
      mk.sels.forEach((s) => { if (sw[s.pick]) s.pick = sw[s.pick]; });
      G.guardSoccer(copy);
      // efeito da troca na probabilidade: só conta se a troca muda a odd o suficiente para dar valor
      const t = before.reduce((q, o) => q + 1 / o, 0) / (k === 'dc' ? 2 : 1);
      const ps = before.map((o) => 1 / o / t);
      const pOf = (p) => ps[mk.sels.findIndex((s) => s.pick === sw[p])]; // odds de antes da troca, pela escolha original
      const eff = k === 'dnb' ? Math.abs(ps[0] - ps[1]) : Math.abs(pOf('hd') - pOf('da'));
      if (eff > 2 * G.GUARD + 0.03) { swaps++; if (mk.sels.some((s) => s.lock)) caught++; else console.log(`  ✘ troca não apanhada: ${m.home} x ${m.away} ${k}`); } else small++;
    }
  }
  const rem = F.guardRemoved.filter((x) => !x.includes('[duas odds na fonte]'));
  console.log(`   ${events} jogos · tirados pela proteção: ${rem.length}`);
  rem.slice(0, 10).forEach((x) => console.log('     tirado:', x.slice(25)));
  console.log(`   trocas de lados simuladas: ${caught}/${swaps} apanhadas (mais ${small} com efeito pequeno na odd)`);
  check(caught === swaps, 'todas as trocas de lados com efeito na odd são apanhadas');
  check(rem.length <= Math.max(10, events * 0.01), `a proteção não deve tirar muito (tirou ${rem.length} em ${events} jogos)`);
}

/* ================= prolongamento e penáltis (ESPN gravada, sem internet) ================= */
async function extraTime() {
  console.log('3) prolongamento e penáltis');
  const fs = require('fs');
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'dados', 'futebol-prolongamento-27-10.json'), 'utf8'));
  const M = require(path.join(ROOT, 'public', 'markets.js'));
  const ET = require(path.join(ROOT, 'feeds', 'extratime.js'));
  // a ESPN responde com os dados gravados (o módulo guarda em cache por liga e dia: um módulo novo por cenário)
  const realFetch = global.fetch;
  const withEspn = async (routes, fn) => {
    global.fetch = async (url) => { const k = Object.keys(routes).find((x) => String(url).includes(x)); return { ok: !!k, json: async () => (k ? routes[k] : {}) }; };
    delete require.cache[require.resolve(path.join(ROOT, 'feeds', 'espn.js'))];
    try { return await fn(require(path.join(ROOT, 'feeds', 'espn.js'))); } finally { global.fetch = realFetch; }
  };
  const ev = { league: 'esp.copa', home: { name: 'Sestao' }, away: { name: 'Espanyol' }, date: new Date(d.sestao.scoreboard.events[0].date) };
  const et = await withEspn({ 'esp.copa_del_rey/scoreboard': d.sestao.scoreboard, 'summary?event': d.sestao.summary }, (E) => E.extraTime(ev, [2, 2]));
  check(et && et.end === 'aet' && JSON.stringify(et.etGoals) === JSON.stringify({ p3: [1, 1], p4: [1, 0], order: ['away', 'home', 'home'] }), `Sestao x Espanyol: gols do prolongamento por período (${JSON.stringify(et?.etGoals)})`);
  const R = { h: 2, a: 2, et };
  const L = (type, pick, line, extra = '') => M.legOutcome({ market: 'pet', per: `${type}|1${extra}`, pick, line }, R);
  check(L('etres', 'home') === 1 && L('etres', 'draw') === -1, 'resultado só do prolongamento (2-1 Sestao)');
  check(L('etgoals', 'over', 2.5) === 1 && L('etgoals', 'under', 2.5) === -1, 'gols do prolongamento: 3');
  check(L('etbtts', 'yes') === 1, 'ambas marcam no prolongamento');
  check(L('et1res', 'draw') === 1 && L('et1goals', 'over', 1.5) === 1, '1º tempo do prolongamento 1-1');
  check(L('etdr', 'draw-home') === 1 && L('etdr', 'home-home') === -1, 'dupla do prolongamento (intervalo empate, fim casa)');
  check(L('etcs', '2-1') === 1 && L('et1cs', '1-1') === 1 && L('etcs', '1-2') === -1, 'placares do prolongamento (lados certos)');
  check(L('etnth', 'away', null, '|1') === 1 && L('etnth', 'home', null, '|3') === 1 && L('etnth', 'none', null, '|4') === 1, 'N.º gol do prolongamento');
  check(L('method', 'home:et') === 1 && L('mqual', 'home:et') === 1, 'forma de vitória / qualificação: casa no prolongamento');
  // um gol em falta no resumo: não bate com o placar → sem gols por período → equipa
  const falta = { keyEvents: d.sestao.summary.keyEvents.filter((k, i) => !(k.scoringPlay && i === d.sestao.summary.keyEvents.findIndex((x) => x.scoringPlay && x.period?.number === 3))) };
  const et2 = await withEspn({ 'esp.copa_del_rey/scoreboard': d.sestao.scoreboard, 'summary?event': falta }, (E) => E.extraTime(ev, [2, 2]));
  check(et2 && et2.etGoals === null && M.legOutcome({ market: 'pet', per: 'etres|1', pick: 'home' }, { h: 2, a: 2, et: et2 }) === null, 'resumo da ESPN com um gol em falta: mercados do prolongamento ficam para a equipa');
  // penáltis logo aos 90 (sem prolongamento): mercados do prolongamento devolvidos, os dos penáltis liquidados
  const evF = { league: 'eng.efl', home: { name: 'Fleetwood Town' }, away: { name: 'Arsenal' }, date: new Date(d.fleetwood.scoreboard.events[0].date) };
  const etF = await withEspn({ 'eng.league_cup/scoreboard': d.fleetwood.scoreboard }, (E) => E.extraTime(evF, [1, 1]));
  check(etF && etF.end === 'pens' && etF.etPlayed === false && JSON.stringify(etF.pens) === '[5,3]', `Fleetwood x Arsenal: penáltis 5-3 sem prolongamento (${JSON.stringify(etF && { end: etF.end, etPlayed: etF.etPlayed, pens: etF.pens })})`);
  const RF = { h: 1, a: 1, et: etF };
  check(M.legOutcome({ market: 'pet', per: 'etres|1', pick: 'draw' }, RF) === 0, 'sem prolongamento: resultado do prolongamento devolvido');
  check(M.legOutcome({ market: 'pet', per: 'shootwin|1', pick: 'home' }, RF) === 1 && M.legOutcome({ market: 'pet', per: 'method|1', pick: 'home:pens' }, RF) === 1, 'penáltis: Fleetwood ganha nos penáltis');
  // 2ª mão: quem ganha o jogo pode não passar → "apura-se"/"forma de vitória" não se adivinham
  const two = JSON.parse(JSON.stringify(d.sestao.scoreboard)); two.events[0].competitions[0].notes = [{ headline: '2nd Leg - Sestao advance 5-4 on aggregate' }];
  const etT = await withEspn({ 'esp.copa_del_rey/scoreboard': two, 'summary?event': d.sestao.summary }, (E) => E.extraTime(ev, [2, 2]));
  check(etT && etT.twoLegs === true, '2ª mão detetada (antes não detetava: expressão com caracteres invisíveis)');
  // leitura das cotações
  const m = { home: 'Sestao', away: 'Espanyol' };
  const Q = (group_name, label, side, line, extra = {}) => { const r = ET.quote({ group_name, label, side, line, group_id: 9, ...extra }, m); return r && { per: r.per, pick: r.pick, line: r.line }; };
  check(JSON.stringify(Q('Method Of Victory', undefined, 'Sestao', 'Win in Extra Time')) === JSON.stringify({ per: 'method|9', pick: 'home:et' }), '"Method Of Victory" (O maiúsculo) reconhecido');
  check(JSON.stringify(Q('Method Of Qualification', undefined, 'Espanyol', '90 Mins')) === JSON.stringify({ per: 'mqual|9', pick: 'away:90' }), '"Method Of Qualification" reconhecido');
  check(JSON.stringify(Q('Extra Time Final Score', '2-1', '2')) === JSON.stringify({ per: 'etcs|9', pick: '1-2' }), 'placar do prolongamento: "2-1" do lado 2 = fora ganha 2-1');
  check(JSON.stringify(Q('1st Goal - Extra Time', 'No 1st Goal')) === JSON.stringify({ per: 'etnth|9|1', pick: 'none' }), '1º gol do prolongamento: "nenhum"');
  check(Q('Extra Time Corners', 'Over', 'Over', '6', { handicap: '6' }) === null, 'escanteios do prolongamento: sem regra');
  const GEN = require(path.join(ROOT, 'feeds', 'generic.js'));
  check(GEN.quote({ group_name: 'Extra Time Corners', label: 'Over', side: 'Over', line: '6', handicap: '6', group_id: '1', sel_id: '2', odds_dec: 2 }, m, 'soccer') === null, 'escanteios do prolongamento não se oferecem');
  check(GEN.quote({ group_name: 'Penalty Shootout to Go to Sudden Death', label: 'Yes', group_id: '1', sel_id: '2', odds_dec: 2 }, m, 'soccer') === null, 'penálti a penálti / morte súbita não se oferecem');
}

(async () => {
  console.log('Testes da proteção do futebol');
  cases();
  await extraTime();
  await live();
  console.log(`\n  ${ok} verificações certas · ${bad} erradas`);
  process.exit(bad ? 1 : 0);
})();
