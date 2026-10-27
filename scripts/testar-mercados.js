'use strict';
/* Testes das regras de liquidação e do cash out (não mexe em nada: só lê a MoviOdds para os testes com partidas reais).
   Uso: npm run testar            (todos)
        npm run testar -- --offline  (sem os testes com partidas reais de ténis)

   1) Casos conhecidos: para cada mercado de cada modalidade, um resultado e o que cada seleção tem de dar.
   2) Verificações cruzadas: em todos os placares possíveis (futebol, basquete, hóquei) e em partidas reais de ténis
      já terminadas, as seleções de cada mercado têm de bater certo entre si (ex.: no "vencedor do game" ganha
      exatamente um jogador; "Mais de 2.5" e "Menos de 2.5" nunca ganham os dois).
   3) Cash out: as contas do valor oferecido. */

const path = require('node:path');
const M = require(path.join(__dirname, '..', 'public', 'markets.js'));
const OFFLINE = process.argv.includes('--offline');

let pass = 0, failN = 0;
const fails = [];
function check(cond, what) { if (cond) pass++; else { failN++; if (fails.length < 60) fails.push(what); } }
const out = (leg, R) => M.legOutcome(leg, R);
const L = (market, pick, line = null, per = null, base = null) => ({ market, pick, line, per, base });
const eq = (leg, R, exp, tag = '') => { const v = out(leg, R); check(v === exp, `${tag} ${JSON.stringify(leg)} com ${JSON.stringify({ h: R.h, a: R.a, reg: R.reg, sets: R.sets })} deu ${v}, esperado ${exp}`); };

/* ================= 1) casos conhecidos ================= */
// futebol 2-1
{
  const R = { h: 2, a: 1 };
  eq(L('ml', 'home'), R, 1, 'fut'); eq(L('ml', 'draw'), R, -1, 'fut'); eq(L('ml', 'away'), R, -1, 'fut');
  eq(L('dc', 'hd'), R, 1, 'fut'); eq(L('dc', 'ha'), R, 1, 'fut'); eq(L('dc', 'da'), R, -1, 'fut');
  eq(L('dnb', 'home'), R, 1, 'fut'); eq(L('dnb', 'away'), R, -1, 'fut'); eq(L('dnb', 'home'), { h: 1, a: 1 }, 0, 'fut empate');
  eq(L('btts', 'yes'), R, 1, 'fut'); eq(L('btts', 'no'), R, -1, 'fut'); eq(L('btts', 'yes'), { h: 3, a: 0 }, -1, 'fut');
  eq(L('total', 'over', 2.5), R, 1, 'fut'); eq(L('total', 'under', 2.5), R, -1, 'fut'); eq(L('total', 'over', 3), R, 0, 'fut linha inteira');
  eq(L('total', 'over', 2.75), R, 0.5, 'fut quarto'); eq(L('total', 'under', 2.75), R, -0.5, 'fut quarto'); eq(L('total', 'over', 3.25), R, -0.5, 'fut quarto');
  eq(L('spread', 'home', -0.5), R, 1, 'fut'); eq(L('spread', 'home', -1), R, 0, 'fut'); eq(L('spread', 'home', -1.25), R, -0.5, 'fut');
  eq(L('spread', 'away', 0.75), R, -0.5, 'fut'); eq(L('spread', 'away', 1.5), R, 1, 'fut');
  // handicap ao vivo a partir de 1-0: só contam os gols depois (1-1)
  eq(L('spread', 'home', -0.5, null, [1, 0]), R, -1, 'fut ao vivo'); eq(L('spread', 'away', 0.5, null, [1, 0]), R, 1, 'fut ao vivo');
  eq(L('cs', '2-1'), R, 1, 'fut'); eq(L('cs', '1-2'), R, -1, 'fut');
}
// basquete 101-99 (com prorrogação)
{
  const R = { h: 101, a: 99 };
  eq(L('ml', 'home'), R, 1, 'basq'); eq(L('ml', 'away'), R, -1, 'basq');
  eq(L('spread', 'home', -1.5), R, 1, 'basq'); eq(L('spread', 'home', -2.5), R, -1, 'basq'); eq(L('spread', 'away', 2.5), R, 1, 'basq'); eq(L('spread', 'home', -2), R, 0, 'basq push');
  eq(L('total', 'over', 199.5), R, 1, 'basq'); eq(L('total', 'under', 200.5), R, 1, 'basq'); eq(L('total', 'over', 200), R, 0, 'basq push');
}
// hóquei: 3-2 no prolongamento (2-2 no tempo regulamentar)
{
  const R = { h: 3, a: 2, reg: [2, 2] };
  eq(L('mlr', 'draw'), R, 1, 'hoq'); eq(L('mlr', 'home'), R, -1, 'hoq'); eq(L('dcr', 'hd'), R, 1, 'hoq'); eq(L('dcr', 'ha'), R, -1, 'hoq');
  eq(L('ml', 'home'), R, 1, 'hoq'); eq(L('total', 'over', 4.5), R, 1, 'hoq'); eq(L('spread', 'home', -1.5), R, -1, 'hoq'); eq(L('spread', 'away', 1.5), R, 1, 'hoq');
}
// hóquei nos pênaltis (2-2, a fonte não diz quem ganhou): só se paga o que dá igual nos dois casos
{
  const ev = { state: 'post', completed: true, statusName: '', result: { h: 2, a: 2, reg: [2, 2], alts: [[3, 2], [2, 3]] } };
  const st = (leg) => { const l = { ...leg }; return M.settleLeg(l, ev) ? l.result : 'equipa'; };
  check(st(L('ml', 'home')) === 'equipa', 'hóquei pênaltis: vencedor tem de ficar para a equipa');
  check(st(L('ml', 'away')) === 'equipa', 'hóquei pênaltis: vencedor (fora) tem de ficar para a equipa');
  check(st(L('total', 'over', 4.5)) === 'won', 'hóquei pênaltis: Mais de 4.5 ganha (2-2 + gol dos pênaltis)');
  check(st(L('total', 'under', 4.5)) === 'lost', 'hóquei pênaltis: Menos de 4.5 perde');
  check(st(L('spread', 'home', -1.5)) === 'lost', 'hóquei pênaltis: -1.5 perde');
  check(st(L('spread', 'away', 1.5)) === 'won', 'hóquei pênaltis: +1.5 ganha');
  check(st(L('mlr', 'draw')) === 'won', 'hóquei pênaltis: empate no regulamentar ganha');
}
// ténis: partida com histórico game a game montado à mão
function buildMatch(setSeq, opts = {}) {
  // setSeq: por set, a sequência de vencedores dos games ("HAHA..."), e "T" + placar no fim para o tie-break
  const sets = [], log = [];
  let srv = opts.firstServer || 'home';
  const lps = [0, 15, 30, 40, 15, 30];
  let k = 0;
  setSeq.forEach((seq, si) => {
    const sc = [0, 0];
    for (let g = 0; g < seq.wins.length; g++) {
      const w = seq.wins[g] === 'H' ? 'home' : 'away';
      sc[w === 'home' ? 0 : 1]++;
      log.push({ s: si + 1, g: g + 1, w, srv, lp: lps[k++ % lps.length] });
      srv = srv === 'home' ? 'away' : 'home';
    }
    if (seq.tb) { const w = seq.tb[0] > seq.tb[1] ? 'home' : 'away'; sc[w === 'home' ? 0 : 1]++; log.push({ s: si + 1, g: seq.wins.length + 1, w, tb: true, tbScore: seq.tb }); srv = srv === 'home' ? 'away' : 'home'; }
    sets.push(sc);
  });
  const h = sets.filter(([x, y]) => x > y).length, a = sets.length - h;
  return { h, a, sets, log, aces: opts.aces || [6, 2], dfs: opts.dfs || [1, 3] };
}
{
  // 6-4, 6-7 (tie-break 5-7), 7-5 → casa ganha 2-1
  const R = buildMatch([{ wins: 'HAHAHAHAHH' }, { wins: 'HAHAHAHAHAHA', tb: [5, 7] }, { wins: 'HAHAHAHAHAHH' }]);
  check(JSON.stringify(R.sets) === '[[6,4],[6,7],[7,5]]', 'montagem da partida de teste: ' + JSON.stringify(R.sets));
  const T = (leg, exp) => eq(leg, R, exp, 'ténis');
  T(L('ml', 'home'), 1); T(L('sets', '2-1'), 1); T(L('sets', '2-0'), -1); T(L('tsets', '3'), 1); T(L('tsets', '2'), -1);
  // games: casa 6+6+7 = 19, fora 4+7+5 = 16 (total 35)
  T(L('gtotal', 'over', 34.5), 1); T(L('gtotal', 'under', 35.5), 1); T(L('gspread', 'home', -2.5), 1); T(L('gspread', 'home', -3.5), -1); T(L('gspread', 'home', -3), 0);
  T(L('tsw', 'home', null, '1'), 1); T(L('tsw', 'away', null, '2'), 1); T(L('tsw', 'home', null, '4'), 0); // 4º set não jogado: devolvida
  T(L('tscs', '6-4', null, '1'), 1); T(L('tscs', '6-7', null, '2'), 1); T(L('tscs', '7-5', null, '3'), 1); T(L('tscs', '4-6', null, '1'), -1);
  T(L('tscg', 'home:6-3,6-4', null, '1'), 1); T(L('tscg', 'away:7-5,7-6', null, '2'), 1); T(L('tscg', 'home:7-5,7-6', null, '2'), -1);
  T(L('tsca', '6-4', null, '1'), 1); T(L('tsca', '7-6', null, '2'), 1);
  T(L('tsgt', 'over', 9.5, '1'), 1); T(L('tsgt', 'under', 12.5, '3'), 1); T(L('tsgt', 'over', 12.5, '2'), 1);
  T(L('tsgh', 'home', -1.5, '1'), 1); T(L('tsgh', 'home', -2.5, '1'), -1); T(L('tsgh', 'away', 1.5, '1'), -1);
  T(L('tslead', 'draw', null, '1:4'), 1); T(L('tslead', 'home', null, '1:3'), 1); T(L('tslead', 'home', null, '1:10'), 1);
  T(L('tsafter', '2-2', null, '1:4'), 1); T(L('tsafter', '3-1', null, '1:4'), -1); T(L('tsafter', '6-6', null, '2:12'), 1);
  T(L('tsrace', 'home', null, '1:2'), 1); T(L('tsrace', 'home', null, '1:6'), 1); T(L('tsrace', 'home', null, '2:6'), 1); T(L('tsrace', 'away', null, '2:7'), 1);
  T(L('tstbw', 'away', null, '2'), 1); T(L('tstbw', 'home', null, '1'), 0); // set 1 sem tie-break: devolvida
  T(L('tgw', 'home', null, '1/1'), 1); T(L('tgw', 'away', null, '1/2'), 1); T(L('tgw', 'away', null, '2/13'), 1); T(L('tgw', 'home', null, '1/11'), 0); // game 11 não existe no 1º set
  // game 1 (casa a servir, adversário a 0), game 2 (fora a servir, 15), game 3 (casa, 30), game 4 (fora, 40)...
  T(L('tgs', 'home:0', null, '1/1'), 1); T(L('tgs', 'away:15', null, '1/2'), 1); T(L('tgs', 'home:15', null, '1/1'), -1);
  T(L('tgd', 'yes', null, '1/4'), 1); T(L('tgd', 'no', null, '1/1'), 1); T(L('tgd', 'yes', null, '1/1'), -1);
  T(L('tgsw', 'yes', 15, '1/1'), 1); T(L('tgsw', 'yes', 15, '1/3'), -1); T(L('tgsw', 'yes', 30, '1/3'), 1);
  T(L('tgpw', 'draw', null, '1/1'), 1); T(L('tgpw', 'home', null, '1/9'), 1); T(L('tgpd', 'yes', null, '1/3'), 1); T(L('tgpd', 'no', null, '1/1'), 1);
  // 1º set: sem quebras (todos a servir ganham... exceto o game 10, servido por fora e ganho pela casa)
  T(L('tsbrk', 'home:yes', null, '1'), 1); T(L('tsbrk', 'away:yes', null, '1'), -1); T(L('tsbrk', 'away:no', null, '1'), 1);
  T(L('tfbrk', 'home'), 1); T(L('tfswin', 'home', null, 'home'), 1); T(L('tfswin', 'away', null, 'away'), 1);
  T(L('tfsg', 'home:0', null, 'home'), 1); T(L('tfsg', 'away:15', null, 'away'), 1); T(L('tfsd', 'no', null, 'home'), 1); T(L('tfsw', 'yes', 15, 'away'), 1);
  T(L('tpbrk', 'over', 0.5, 'home:1'), 1); T(L('tpbrk', 'under', 0.5, 'away:1'), 1);
  T(L('tstraight', 'no'), 1); T(L('tdist', 'yes'), 1); T(L('tpto', 'aset:yes', null, 'away'), 1); T(L('tpto', 'straight:no', null, 'home'), 1); T(L('tpto', 'behind:no', null, 'home'), 1);
  T(L('tdr', 'home:W'), 1); T(L('tdr', 'away:W'), -1); T(L('tcast', 'home:WLW'), 1); T(L('tcast', 'away:LWL'), 1); T(L('tcast', 'home:WW'), -1);
  T(L('tmrt', 'home:over', 34.5), 1); T(L('tmrt', 'away:over', 30.5), -1); T(L('tmrt', 'home:under', 34.5), -1);
  T(L('tpgw', 'over', 18.5, 'home'), 1); T(L('tpgw', 'under', 16.5, 'away'), 1);
  T(L('toe', 'odd'), 1); T(L('ttb', 'over', 0.5), 1); T(L('ttb', 'under', 1.5), 1);
  T(L('tace', '6', 6, 'home'), 1); T(L('tace', '7', 7, 'home'), -1); T(L('tdf', '3', 3, 'away'), 1);
  // sem histórico (não bateu certo): os mercados de game/saque ficam para a equipa; os de set continuam
  const R2 = { ...R, log: null };
  check(out(L('tgw', 'home', null, '1/1'), R2) === null, 'ténis sem histórico: vencedor do game tem de ficar para a equipa');
  check(out(L('tfbrk', 'home'), R2) === null, 'ténis sem histórico: primeira quebra tem de ficar para a equipa');
  check(out(L('tsw', 'home', null, '1'), R2) === 1, 'ténis sem histórico: vencedor do set continua automático');
  const st = (leg, ev) => { const l = { ...leg }; return M.settleLeg(l, ev) ? l.result : 'equipa'; };
  check(st(L('tgw', 'home', null, '1/1'), { state: 'post', completed: true, statusName: '', result: R2 }) === 'equipa', 'settleLeg com histórico nulo não paga');
}

// e-Sports: CS2 2-1 com placar de rondas de cada mapa; LoL 2-0 sem rondas
{
  const R = { h: 2, a: 1, maps: [[13, 7], [10, 13], [16, 14]] };
  eq(L('ml', 'home'), R, 1, 'esp'); eq(L('ml', 'away'), R, -1, 'esp');
  eq(L('ecs', '2-1'), R, 1, 'esp'); eq(L('ecs', '2-0'), R, -1, 'esp');
  eq(L('emh', 'home', -1.5), R, -1, 'esp'); eq(L('emh', 'away', 1.5), R, 1, 'esp'); eq(L('emh', 'home', 1.5), R, 1, 'esp');
  eq(L('e1m', 'yes', null, 'away'), R, 1, 'esp'); eq(L('e1m', 'no', null, 'away'), R, -1, 'esp');
  eq(L('emw', 'home', null, '1'), R, 1, 'esp'); eq(L('emw', 'away', null, '2'), R, 1, 'esp'); eq(L('emw', 'home', null, '3'), R, 1, 'esp');
  const R2 = { h: 2, a: 0, maps: null };
  eq(L('emw', 'home', null, '3'), R2, 0, 'esp mapa 3 não jogado'); // devolvida
  check(out(L('emw', 'home', null, '1'), R2) === null, 'e-Sports sem rondas: vencedor do mapa fica para a equipa');
  eq(L('ecs', '2-0'), R2, 1, 'esp');
}
// mercado da equipa: nunca é decidido sozinho
{
  const ev = { state: 'post', completed: true, statusName: '', result: { h: 2, a: 1 } };
  const l = { market: 'x', pick: '123', per: '10565' };
  check(!M.settleLeg(l, ev) && !l.result, 'mercado da equipa não pode ser liquidado automaticamente');
}

/* ================= 2) verificações cruzadas ================= */
// soma das seleções complementares: em linhas .5 exatamente uma ganha; em linhas inteiras/quarto os valores são simétricos
function complement(a, b, R, tag) { const x = out(a, R), y = out(b, R); check(x !== null && y !== null && x === -y, `${tag}: ${JSON.stringify(a)}=${x} e ${JSON.stringify(b)}=${y} não são opostos (${JSON.stringify({ h: R.h, a: R.a })})`); }
function exactlyOne(legs, R, tag, allowVoid = false) {
  const v = legs.map((l) => out(l, R));
  if (v.some((x) => x === null)) { check(false, `${tag}: resultado indecidível ${JSON.stringify(legs[v.indexOf(null)])}`); return; }
  const won = v.filter((x) => x === 1).length;
  if (allowVoid && v.every((x) => x === 0)) { pass++; return; }
  check(won === 1 && v.every((x) => x === 1 || x === -1), `${tag}: ${won} seleções ganharam (esperado 1) · ${legs.map((l, i) => `${l.pick}${l.per ? '@' + l.per : ''}=${v[i]}`).join(' ')}`);
}
// futebol, basquete e hóquei: todos os placares de 0-0 a 7-7
const LINES = [0.5, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4.5, 5.5];
for (let h = 0; h <= 7; h++) for (let a = 0; a <= 7; a++) {
  const R = { h, a, reg: [Math.min(h, a), Math.min(h, a)] };
  exactlyOne([L('ml', 'home'), L('ml', 'draw'), L('ml', 'away')], R, 'futebol 1X2');
  const dc = [L('dc', 'hd'), L('dc', 'ha'), L('dc', 'da')].map((l) => out(l, R)).filter((x) => x === 1).length;
  check(dc === 2, `futebol dupla chance ${h}-${a}: ${dc} ganharam (esperado 2)`);
  complement(L('btts', 'yes'), L('btts', 'no'), R, 'ambas marcam');
  if (h !== a) complement(L('dnb', 'home'), L('dnb', 'away'), R, 'empate anula');
  for (const ln of LINES) {
    complement(L('total', 'over', ln), L('total', 'under', ln), R, `total ${ln}`);
    complement(L('spread', 'home', -ln), L('spread', 'away', ln), R, `handicap -${ln}`);
    complement(L('spread', 'home', ln), L('spread', 'away', -ln), R, `handicap +${ln}`);
  }
  const cs = []; for (let x = 0; x <= 7; x++) for (let y = 0; y <= 7; y++) cs.push(L('cs', `${x}-${y}`));
  exactlyOne(cs, R, 'placar exato');
  exactlyOne([L('mlr', 'home'), L('mlr', 'draw'), L('mlr', 'away')], { ...R, reg: [h, a] }, 'hóquei 1X2 regulamentar');
}

// ténis: todas as seleções possíveis de cada mercado, numa partida (R)
const SC_SET = []; for (let x = 0; x <= 7; x++) for (let y = 0; y <= 7; y++) SC_SET.push(`${x}-${y}`);
function tennisCross(R, tag) {
  const sets = R.sets, log = R.log;
  const maxSets = Math.max(R.h, R.a) * 2 - 1;
  exactlyOne([L('ml', 'home'), L('ml', 'away')], R, `${tag} vencedor`);
  const setsPicks = []; for (let x = 0; x <= Math.max(R.h, R.a); x++) for (let y = 0; y <= Math.max(R.h, R.a); y++) if (x !== y && Math.max(x, y) === Math.max(R.h, R.a)) setsPicks.push(L('sets', `${x}-${y}`));
  exactlyOne(setsPicks, R, `${tag} resultado em sets`);
  exactlyOne([2, 3, 4, 5].filter((n) => n <= maxSets).map((n) => L('tsets', String(n))), R, `${tag} total de sets`);
  complement(L('tstraight', 'yes'), L('tstraight', 'no'), R, `${tag} sets diretos`);
  complement(L('tdist', 'yes'), L('tdist', 'no'), R, `${tag} set decisivo`);
  exactlyOne(['home:W', 'home:L', 'away:W', 'away:L'].map((p) => L('tdr', p)), R, `${tag} 1º set + partida`);
  const seqs = []; const gen = (s) => { if (s.length >= 2) { const w = s.split('').filter((c) => c === 'W').length, l = s.length - w; if (w === Math.max(R.h, R.a) || l === Math.max(R.h, R.a)) { seqs.push(s); return; } } if (s.length < maxSets) { gen(s + 'W'); gen(s + 'L'); } }; gen('');
  exactlyOne(seqs.map((q) => L('tcast', `home:${q}`)), R, `${tag} sequência dos sets`);
  for (const w of ['home', 'away']) for (const t of ['aset', 'straight', 'behind']) complement(L('tpto', `${t}:yes`, null, w), L('tpto', `${t}:no`, null, w), R, `${tag} especiais ${t}`);
  for (const ln of [16.5, 20.5, 22.5, 24.5, 30.5]) {
    complement(L('gtotal', 'over', ln), L('gtotal', 'under', ln), R, `${tag} total de games`);
    complement(L('gspread', 'home', -ln / 5), L('gspread', 'away', ln / 5), R, `${tag} handicap de games`);
    exactlyOne(['home:over', 'home:under', 'away:over', 'away:under'].map((p) => L('tmrt', p, ln)), R, `${tag} vencedor + total`);
    for (const w of ['home', 'away']) complement(L('tpgw', 'over', ln / 2, w), L('tpgw', 'under', ln / 2, w), R, `${tag} games ganhos`);
  }
  complement(L('toe', 'odd'), L('toe', 'even'), R, `${tag} par/ímpar`);
  for (const ln of [0.5, 1.5]) complement(L('ttb', 'over', ln), L('ttb', 'under', ln), R, `${tag} tie-breaks`);
  for (let si = 1; si <= 5; si++) {
    const set = sets[si - 1], p = String(si);
    if (!set) { check([L('tsw', 'home', null, p), L('tsw', 'away', null, p)].every((l) => out(l, R) === 0), `${tag} set ${si} não jogado tem de ser devolvido`); continue; }
    exactlyOne([L('tsw', 'home', null, p), L('tsw', 'away', null, p)], R, `${tag} vencedor do set ${si}`);
    const superTb = Math.max(...set) === 1;
    if (!superTb) {
      exactlyOne(SC_SET.map((s) => L('tscs', s, null, p)), R, `${tag} placar do set ${si}`);
      exactlyOne([...new Set(SC_SET.map((s) => { const [x, y] = s.split('-').map(Number); return `${Math.max(x, y)}-${Math.min(x, y)}`; }))].map((s) => L('tsca', s, null, p)), R, `${tag} placar qualquer jogador set ${si}`);
      const groups = ['6-0,6-1,6-2', '6-3,6-4', '7-5,7-6'];
      exactlyOne(['home', 'away'].flatMap((w) => groups.map((g) => L('tscg', `${w}:${g}`, null, p))), R, `${tag} grupo de placares set ${si}`);
    }
    for (const ln of [7.5, 9.5, 10.5, 12.5]) complement(L('tsgt', 'over', ln, p), L('tsgt', 'under', ln, p), R, `${tag} games do set ${si}`);
    for (const ln of [1.5, 2.5, 3.5]) complement(L('tsgh', 'home', -ln, p), L('tsgh', 'away', ln, p), R, `${tag} handicap set ${si}`);
    const tb = Math.max(...set) === 7 && Math.min(...set) === 6;
    if (tb) exactlyOne([L('tstbw', 'home', null, p), L('tstbw', 'away', null, p)], R, `${tag} tie-break set ${si}`);
    else check(out(L('tstbw', 'home', null, p), R) === 0, `${tag} set ${si} sem tie-break: tie-break devolvido`);
    if (!log) continue;
    const games = log.filter((e) => e.s === si);
    for (const w of ['home', 'away']) complement(L('tsbrk', `${w}:yes`, null, p), L('tsbrk', `${w}:no`, null, p), R, `${tag} quebra set ${si}`);
    for (let n = 1; n <= games.length; n++) {
      exactlyOne([L('tslead', 'home', null, `${si}:${n}`), L('tslead', 'draw', null, `${si}:${n}`), L('tslead', 'away', null, `${si}:${n}`)], R, `${tag} lidera set ${si} após ${n}`);
      const ap = []; for (let x = 0; x <= n; x++) ap.push(L('tsafter', `${x}-${n - x}`, null, `${si}:${n}`));
      exactlyOne(ap, R, `${tag} placar set ${si} após ${n}`);
    }
    for (let n = 1; n <= 7; n++) exactlyOne([L('tsrace', 'home', null, `${si}:${n}`), L('tsrace', 'away', null, `${si}:${n}`)], R, `${tag} primeiro a ${n} set ${si}`, true);
    games.forEach((e, i) => {
      const per = `${si}/${i + 1}`;
      exactlyOne([L('tgw', 'home', null, per), L('tgw', 'away', null, per)], R, `${tag} vencedor game ${per}`);
      if (e.lp == null) return;
      exactlyOne(['home', 'away'].flatMap((w) => [0, 15, 30, 40].map((pt) => L('tgs', `${w}:${pt}`, null, per))), R, `${tag} placar do game ${per}`);
      complement(L('tgd', 'yes', null, per), L('tgd', 'no', null, per), R, `${tag} deuce ${per}`);
      for (const ln of [0, 15, 30]) complement(L('tgsw', 'yes', ln, per), L('tgsw', 'no', ln, per), R, `${tag} quem serve ganha ${per}`);
      if (games[i + 1]) {
        exactlyOne([L('tgpw', 'home', null, per), L('tgpw', 'draw', null, per), L('tgpw', 'away', null, per)], R, `${tag} games ${per} e seguinte`);
        if (games[i + 1].lp != null) complement(L('tgpd', 'yes', null, per), L('tgpd', 'no', null, per), R, `${tag} deuce em 2 games ${per}`);
      }
    });
  }
  if (log) {
    exactlyOne([L('tfbrk', 'home'), L('tfbrk', 'away')], R, `${tag} primeira quebra`, true);
    for (const srv of ['home', 'away']) {
      exactlyOne([L('tfswin', 'home', null, srv), L('tfswin', 'away', null, srv)], R, `${tag} 1º game de serviço de ${srv}`);
      exactlyOne(['home', 'away'].flatMap((w) => [0, 15, 30, 40].map((pt) => L('tfsg', `${w}:${pt}`, null, srv))), R, `${tag} placar 1º game de serviço ${srv}`);
      complement(L('tfsd', 'yes', null, srv), L('tfsd', 'no', null, srv), R, `${tag} deuce 1º serviço ${srv}`);
      for (const ln of [15, 30]) complement(L('tfsw', 'yes', ln, srv), L('tfsw', 'no', ln, srv), R, `${tag} 1º serviço ganha até ${ln}`);
      for (const ln of [0.5, 1.5, 2.5, 4.5]) complement(L('tpbrk', 'over', ln, `${srv}:0`), L('tpbrk', 'under', ln, `${srv}:0`), R, `${tag} quebras de ${srv}`);
    }
    for (const ln of [2.5, 4.5, 6.5]) complement(L('tbrk', 'over', ln), L('tbrk', 'under', ln), R, `${tag} total de quebras`);
    // quebras: soma por jogador = total
    const tot = log.filter((e) => e.srv && e.w !== e.srv).length;
    check(out(L('tbrk', 'over', tot - 0.5), R) === 1 && out(L('tbrk', 'under', tot + 0.5), R) === 1, `${tag} total de quebras ${tot}`);
  }
  if (R.aces) for (const w of ['home', 'away']) for (let n = 2; n <= 30; n++) {
    const a = out(L('tace', String(n), n, w), R), b = out(L('tace', String(n - 1), n - 1, w), R);
    check(!(a === 1 && b === -1), `${tag} aces: ${n}+ ganhou mas ${n - 1}+ perdeu`);
  }
}
// partida montada (com tie-break) e variações
tennisCross(buildMatch([{ wins: 'HAHAHAHAHH' }, { wins: 'HAHAHAHAHAHA', tb: [5, 7] }, { wins: 'HAHAHAHAHAHH' }]), 'ténis montado A');
tennisCross(buildMatch([{ wins: 'AAAAHAA' }, { wins: 'HHHHHH' }, { wins: 'HAHAHAHAHAHA', tb: [10, 8] }], { firstServer: 'away' }), 'ténis montado B');
tennisCross(buildMatch([{ wins: 'HHHHHH' }, { wins: 'HHHHHAH' }]), 'ténis montado C (6-0 6-1)');

/* ================= 3) cash out ================= */
{
  const legs = (odds, cur, extra = {}) => ({ odds, legs: [{ key: 'e1|ml|home', odds, result: null, ...extra }] });
  const sel = (o, locked = false) => () => ({ ev: { state: 'pre', markets: [{}], closesAt: Date.now() + 3600e3 }, sel: { odds: o, locked } });
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  check(near(M.cashoutFactor(legs(2), sel(2)), 0.93), 'cash out: odd igual → 93% do valor apostado');
  check(near(M.cashoutFactor(legs(2), sel(1.5)), (2 / 1.5) * 0.93), 'cash out: odd desceu → vale mais');
  check(near(M.cashoutFactor(legs(2), sel(4)), 0.5 * 0.93), 'cash out: odd subiu → vale menos');
  check(near(M.cashoutFactor(legs(2), sel(1.01)), (2 / 1.01) * 0.93), 'cash out: odd quase certa (1.01)');
  // o cash out nunca passa de 98% do prémio potencial, em nenhuma combinação de odds
  let capOk = true;
  for (const o of [1.05, 1.5, 2, 5, 20]) for (const now of [1.01, 1.1, 1.5, 3, 10]) for (const won of [1, 1.5, 3]) {
    const b = { odds: o * won, legs: [{ key: 'a', odds: won, result: won > 1 ? 'won' : null, value: 1 }, { key: 'b', odds: o, result: null }] };
    const f = M.cashoutFactor(won > 1 ? b : { odds: o, legs: [b.legs[1]] }, () => ({ ev: { state: 'in', markets: [{}] }, sel: { odds: now } }));
    if (f != null && f > (won > 1 ? o * won : o) * 0.98 + 1e-9) capOk = false;
  }
  check(capOk, 'cash out: nunca passa de 98% do prémio');
  check(M.cashoutFactor(legs(2), sel(2, true)) === null, 'cash out: seleção bloqueada → indisponível');
  check(M.cashoutFactor(legs(2), () => ({ ev: null, sel: null })) === null, 'cash out: mercado já não existe → indisponível');
  check(M.cashoutFactor(legs(2), () => ({ ev: { state: 'pre', markets: [{}], suspendedUntil: Date.now() + 9e3 }, sel: { odds: 2 } })) === null, 'cash out: jogo suspenso → indisponível');
  check(M.cashoutFactor(legs(2), () => ({ ev: { state: 'pre', markets: [{}], closesAt: Date.now() - 1 }, sel: { odds: 2 } })) === null, 'cash out: jogo já começou (antes do ao vivo) → indisponível');
  // múltipla: uma ganha (2.0) e outra em aberto (1.5 → agora 1.2)
  const multi = { odds: 3, legs: [{ key: 'a', odds: 2, result: 'won', value: 1 }, { key: 'b', odds: 1.5, result: null }] };
  check(near(M.cashoutFactor(multi, () => ({ ev: { state: 'in', markets: [{}] }, sel: { odds: 1.2 } })), Math.min(2 * (1.5 / 1.2) * 0.93, 3 * 0.98)), 'cash out: múltipla com seleção já ganha');
  check(M.cashoutFactor({ odds: 3, legs: [{ key: 'a', odds: 2, result: 'lost', value: -1 }, { key: 'b', odds: 1.5, result: null }] }, sel(1.5)) === null, 'cash out: múltipla com seleção perdida → indisponível');
  check(near(M.cashoutFactor({ odds: 3, legs: [{ key: 'a', odds: 2, result: 'void', value: 0 }, { key: 'b', odds: 1.5, result: null }] }, () => ({ ev: { state: 'in', markets: [{}] }, sel: { odds: 1.5 } })), 0.93), 'cash out: múltipla com seleção devolvida conta como 1');
  check(near(M.outcomeFactor(0.5, 1.9), 1.45) && M.outcomeFactor(-0.5, 1.9) === 0.5 && M.outcomeFactor(0, 1.9) === 1, 'meio ganho / meia perda / devolvida');
}

/* ================= 4) partidas reais de ténis (MoviOdds) ================= */
async function realTennis() {
  const F = require(path.join(__dirname, '..', 'feeds', 'moviodds.js'));
  const day = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  let n = 0, withLog = 0, retired = 0;
  for (const d of [1, 2]) {
    const r = await (await fetch(`https://moviodds.com/results?sport=tennis&stats=1&date=${day(d)}`, { signal: AbortSignal.timeout(60000) })).json();
    for (const x of (r.results || []).filter((y) => !/^(UTR|Esports|E-)/i.test(y.league))) {
      // mesma leitura do servidor (sem pedir de novo à fonte)
      let R = null;
      try { R = F.parseResult(x, 'tennis'); } catch (e) { check(false, `leitura do resultado ${x.fixture_id}: ${e.message}`); continue; }
      if (!R.done) { retired++; continue; }
      n++; if (R.log) withLog++;
      tennisCross(R, `real ${x.home} x ${x.away} ${x.final_score}`);
    }
  }
  console.log(`  partidas reais: ${n} terminadas normalmente (${withLog} com histórico game a game), ${retired} paradas/desistência (ficam para a equipa)`);
  check(n > 50, `poucas partidas reais para testar (${n})`);
  check(withLog / Math.max(n, 1) > 0.9, `histórico game a game válido só em ${withLog} de ${n}`);
}

(async () => {
  console.log('\nTestes dos mercados e do cash out\n');
  if (!OFFLINE) { process.stdout.write('  a ler partidas reais de ténis da MoviOdds...\n'); await realTennis(); }
  console.log(`\n  ${pass} verificações certas · ${failN} erradas\n`);
  for (const f of fails) console.log('  ✘ ' + f);
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
