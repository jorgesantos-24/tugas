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

/* ================= 5) MMA (UFC) =================
   Dados reais em scripts/dados/ufc-2025-26.json: o resultado oficial de 1088 lutas do UFC (ESPN), o UFC 333 como a
   MoviOdds o registou e as odds da MoviOdds do card de 31/10. */
{
  const FI = require(path.join(__dirname, '..', 'feeds', 'fights.js'));
  const UFC = require(path.join(__dirname, 'dados', 'ufc-2025-26.json'));
  const fightR = (f) => ({ done: true, h: f.out === 'home' ? 1 : 0, a: f.out === 'away' ? 1 : 0, fight: f });
  const FMOV = ['home:kodq', 'home:sub', 'home:dec', 'away:kodq', 'away:sub', 'away:dec', 'draw'];
  const fround = (rounds) => ['draw', ...['home', 'away'].flatMap((s) => [`${s}:dec`, ...Array.from({ length: rounds }, (_, i) => `${s}:r${i + 1}`)])];

  // casos conhecidos
  {
    const ko = fightR({ out: 'away', method: 'ko', round: 2, secs: 294, rounds: 5 }); // Volkanovski x Evloev ao contrário: fora ganha por KO aos 4:54 do 2º
    eq(L('ml', 'away'), ko, 1, 'mma KO'); eq(L('ml', 'home'), ko, -1, 'mma KO');
    eq(L('fmov', 'away:kodq'), ko, 1, 'mma KO'); eq(L('fmov', 'away:sub'), ko, -1, 'mma KO'); eq(L('fmov', 'home:kodq'), ko, -1, 'mma KO'); eq(L('fmov', 'draw'), ko, -1, 'mma KO');
    eq(L('fround', 'away:r2'), ko, 1, 'mma KO'); eq(L('fround', 'away:r1'), ko, -1, 'mma KO'); eq(L('fround', 'away:dec'), ko, -1, 'mma KO');
    eq(L('total', 'over', 1.5), ko, 1, 'mma KO 9:54'); eq(L('total', 'under', 1.5), ko, -1, 'mma KO'); eq(L('total', 'under', 2.5), ko, 1, 'mma KO');
    eq(L('fdist', 'no'), ko, 1, 'mma KO'); eq(L('fdist', 'yes'), ko, -1, 'mma KO');
    // exatamente na linha: 2.5 rounds = 2:30 do 3º round conta como "mais"
    const at = fightR({ out: 'home', method: 'sub', round: 3, secs: 150, rounds: 3 });
    eq(L('total', 'over', 2.5), at, 1, 'mma 2:30 do 3º'); eq(L('total', 'under', 2.5), at, -1, 'mma 2:30 do 3º');
    const before = fightR({ out: 'home', method: 'sub', round: 3, secs: 149, rounds: 3 });
    eq(L('total', 'under', 2.5), before, 1, 'mma 2:29 do 3º');
    // decisão: todos os rounds, até o fim; decisão técnica: "por decisão", mas não foi até o fim
    const dec = fightR({ out: 'home', method: 'dec', round: 3, secs: 300, rounds: 3 });
    eq(L('fdist', 'yes'), dec, 1, 'mma decisão'); eq(L('fround', 'home:dec'), dec, 1, 'mma decisão'); eq(L('fmov', 'home:dec'), dec, 1, 'mma decisão'); eq(L('total', 'over', 2.5), dec, 1, 'mma decisão');
    const td = fightR({ out: 'away', method: 'tdec', round: 3, secs: 36, rounds: 3 });
    eq(L('fdist', 'no'), td, 1, 'mma decisão técnica'); eq(L('fround', 'away:dec'), td, 1, 'mma decisão técnica'); eq(L('fmov', 'away:dec'), td, 1, 'mma decisão técnica'); eq(L('total', 'under', 2.5), td, 1, 'mma decisão técnica');
    // empate: vencedor devolvido; método/round "empate" ganha; técnico (antes do fim) não foi até o fim
    const dr = fightR({ out: 'draw', method: 'draw', round: 3, secs: 300, rounds: 3 });
    eq(L('ml', 'home'), dr, 0, 'mma empate'); eq(L('ml', 'away'), dr, 0, 'mma empate'); eq(L('fmov', 'draw'), dr, 1, 'mma empate'); eq(L('fmov', 'home:dec'), dr, -1, 'mma empate');
    eq(L('fround', 'draw'), dr, 1, 'mma empate'); eq(L('fdist', 'yes'), dr, 1, 'mma empate'); eq(L('total', 'over', 2.5), dr, 1, 'mma empate');
    const tdr = fightR({ out: 'draw', method: 'draw', round: 3, secs: 36, rounds: 3 });
    eq(L('fdist', 'no'), tdr, 1, 'mma empate técnico');
    eq(L('fdist', 'yes'), fightR({ out: 'draw', method: 'draw', round: 3, secs: 300, rounds: null }), null, 'mma empate sem rounds marcados → equipa');
    eq(L('fdist', 'yes'), fightR({ out: 'draw', method: 'draw', round: 3, secs: 300, rounds: 5 }), null, 'mma empate no fim do 3º de uma luta "de 5" (rounds errados na ESPN?) → equipa');
    // DQ conta em "KO, TKO ou desqualificação"; interrupção médica (TKO) também
    eq(L('fmov', 'home:kodq'), fightR({ out: 'home', method: 'dq', round: 1, secs: 139, rounds: 3 }), 1, 'mma DQ');
    eq(L('fround', 'home:r1'), fightR({ out: 'home', method: 'dq', round: 1, secs: 139, rounds: 3 }), 1, 'mma DQ');
    // no contest e luta que não aconteceu: tudo devolvido
    const nc = fightR({ out: 'nc', method: 'nc', round: 1, secs: 51, rounds: 3 });
    for (const l of [L('ml', 'home'), L('ml', 'away'), ...FMOV.map((p) => L('fmov', p)), L('fround', 'home:r1'), L('total', 'over', 0.5), L('fdist', 'no')]) eq(l, nc, 0, 'mma no contest');
    // liquidação completa (settleLeg) e o texto do resultado
    const ev = { state: 'post', completed: true, statusName: '', result: { ...ko, fight: { ...ko.fight, winner: 'Movsar Evloev' } } };
    const leg = { market: 'fmov', pick: 'away:kodq', odds: 4 };
    check(M.settleLeg(leg, ev) && leg.result === 'won' && leg.final === 'Movsar Evloev por KO/TKO · 2º round 4:54', `mma settleLeg: ${JSON.stringify(leg)}`);
  }

  // 1088 lutas reais: cada mercado tem exatamente uma seleção certa (ou tudo devolvido) e os mercados batem certo entre si
  let n = 0;
  const seen = {};
  for (const [day, , , w, method, round, secs, rounds] of UFC.fights) {
    const m = FI.espnMethod(method);
    seen[method] = (seen[method] || 0) + 1;
    check(m, `mma: método da ESPN desconhecido "${method}" (${day})`);
    if (!m) continue;
    const side = m === 'nc' || m === 'draw' ? m : w === 0 ? 'home' : w === 1 ? 'away' : null;
    check(side, `mma: ${method} sem vencedor (${day})`);
    if (!side) continue;
    n++;
    const R = fightR({ out: side, method: m, round, secs, rounds });
    const tag = `mma real ${day} ${method} R${round} ${secs}s/${rounds}`;
    exactlyOne([L('ml', 'home'), L('ml', 'away')], R, `${tag} vencedor`, true);
    exactlyOne(FMOV.map((p) => L('fmov', p)), R, `${tag} método`, true);
    exactlyOne(fround(rounds || 5).map((p) => L('fround', p)), R, `${tag} round`, true);
    if (m !== 'nc') {
      complement(L('fdist', 'yes'), L('fdist', 'no'), R, `${tag} até o fim`);
      for (const ln of [0.5, 1.5, 2.5, 3.5, 4.5]) complement(L('total', 'over', ln), L('total', 'under', ln), R, `${tag} total ${ln}`);
      // até o fim ⇒ passou de (rounds - 0.5); vitória no round N ⇒ mais de N-1.5 e menos de N+0.5
      if (out(L('fdist', 'yes'), R) === 1) check(out(L('total', 'over', round - 0.5), R) === 1, `${tag}: foi até o fim mas não passou de ${round - 0.5} rounds`);
      if (['ko', 'dq', 'sub'].includes(m)) {
        check(out(L('total', 'under', round + 0.5), R) === 1, `${tag}: acabou no ${round}º mas não ficou abaixo de ${round + 0.5}`);
        if (round > 1) check(out(L('total', 'over', round - 1.5), R) === 1, `${tag}: acabou no ${round}º mas não passou de ${round - 1.5}`);
        check(out(L('fdist', 'no'), R) === 1, `${tag}: KO/finalização não vai até o fim`);
      }
    }
  }
  check(n === UFC.fights.length, `mma: só ${n} de ${UFC.fights.length} lutas reais liquidadas sozinhas`);
  console.log(`  UFC: ${n} de ${UFC.fights.length} lutas reais liquidadas sozinhas (${Object.entries(seen).map(([k, v]) => `${k} ${v}`).join(', ')})`);

  // nomes: as 14 lutas do UFC 333 e as 12 do card de 31/10 (MoviOdds) encontram a sua na ESPN, e só essa
  const comps = (day) => UFC.cards[day].map((c) => ({ competitors: c.names.map((x) => ({ athlete: { displayName: x } })), names: c.names }));
  const tryCard = (pairs, day, tag) => {
    let ok = 0;
    const cs = comps(day);
    for (const [h, a] of pairs) {
      const hit = FI.findBout(cs, h, a);
      if (!hit) { check(false, `${tag}: ${h} x ${a} sem luta na ESPN`); continue; }
      const [x, y] = hit.c.names;
      const good = FI.nameScore(h, hit.swap ? y : x) >= 2 && FI.nameScore(a, hit.swap ? x : y) >= 2;
      check(good, `${tag}: ${h} x ${a} ligado a ${x} x ${y} (troca ${hit.swap})`);
      if (good) ok++;
      // adversário trocado: não pode ligar a nenhuma luta
      const other = pairs.find(([h2]) => h2 !== h)[0];
      check(!FI.findBout(cs, h, other), `${tag}: ${h} x ${other} (luta que não existe) ligou a uma luta`);
    }
    return ok;
  };
  const p333 = UFC.moviodds333.map(([, h, a]) => [h, a]);
  const ok333 = tryCard(p333, '2026-10-24', 'UFC 333');
  const p31 = UFC.odds.matches.filter((m) => /^UFC Fight Night/.test(m.league)).map((m) => [m.home, m.away]);
  const ok31 = tryCard(p31, '2026-10-31', 'UFC 31/10');
  console.log(`  UFC: nomes MoviOdds ↔ ESPN: UFC 333 ${ok333}/${p333.length}, card de 31/10 ${ok31}/${p31.length}`);
  check(FI.nameScore('Joseph Kropschot', 'Joe Kropschot') >= 2 && FI.nameScore('Zachary Reese', 'Zach Reese') >= 2 && FI.nameScore('Lucia Szabova', 'Lucia Szabová') >= 2, 'mma: variantes de nomes');
  check(FI.nameScore('Yana Santos', 'Luana Santos') === 0, 'mma: mesmo apelido, outra lutadora');

  // MoviOdds: o objeto "fight" do /results (como está na documentação)
  const mf = (fight, status = 'finished', final_score = '') => FI.moviFight({ status, final_score, fight });
  check(JSON.stringify(mf({ result: 'home', winner: 'A', method: 'KO/TKO', round: 2, time: '4:54' }, 'finished', '1-0')).includes('"out":"home","method":"ko","round":2,"secs":294'), 'mma: MoviOdds KO');
  check(mf({ result: 'away', method: 'TD', round: 3, time: '0:36' }, 'finished', '0-1').method === 'tdec', 'mma: MoviOdds decisão técnica');
  check(mf({ result: 'draw', method: 'DEC', round: 3, time: '5:00' }, 'finished', '0-0').out === 'draw', 'mma: MoviOdds empate');
  check(mf({ result: 'no_contest', method: 'NC', round: 1 }, 'unknown').out === 'nc', 'mma: MoviOdds no contest (vem "unknown")');
  check(mf({ result: 'home', method: 'OTHER', round: 1, time: '1:00' }, 'finished', '1-0').bad, 'mma: MoviOdds método OTHER → equipa');
  check(mf({ result: 'home', method: 'SUB', round: 1, time: '1:00' }, 'finished', '0-1').bad, 'mma: MoviOdds placar ao contrário do vencedor → equipa');
  check(mf({ result: 'home', method: 'SUB', round: 1, time: '' }, 'finished', '1-0').bad, 'mma: MoviOdds sem tempo → equipa');
  check(FI.moviFight({ status: 'unknown', final_score: '', note: 'no fight result' }) === null, 'mma: MoviOdds sem objeto fight → espera');

  // as duas fontes juntas
  const A = { out: 'home', method: 'ko', round: 2, secs: 100, rounds: null, src: 'moviodds' };
  const E = { out: 'home', method: 'ko', round: 2, secs: 102, rounds: 5, src: 'espn' };
  check(FI.combine(A, E, true, 3600000).fight?.src === 'moviodds+espn' && FI.combine(A, E, true, 3600000).fight.rounds === 5, 'mma: as duas concordam → paga (rounds da ESPN)');
  check(FI.combine(A, { ...E, method: 'sub' }, true, 3600000).done === false, 'mma: método diferente → equipa');
  check(FI.combine(A, { ...E, round: 3 }, true, 3600000).done === false, 'mma: round diferente → equipa');
  check(FI.combine(A, { ...E, out: 'away' }, true, 3600000).done === false, 'mma: vencedor diferente → equipa');
  check(FI.combine(null, E, true, 3600000).fight?.src === 'espn', 'mma: só a ESPN → paga pela ESPN');
  check(FI.combine(A, null, true, 3600000).fight?.src === 'moviodds', 'mma: só a MoviOdds → paga pela MoviOdds');
  check(FI.combine(null, null, true, 3600000) === null, 'mma: nenhuma → espera');
  check(FI.combine(null, { missing: true }, true, 20 * 3600000).done === false, 'mma: vista ao vivo mas não está na ESPN → equipa');
  check(FI.combine(null, { missing: true }, false, 3600000) === null, 'mma: não aconteceu? espera 12 h');
  const can = FI.combine(null, { missing: true, replaced: true }, false, 20 * 3600000);
  check(can.done && can.fight.out === 'nc' && can.fight.cancelled, 'mma: luta que não aconteceu → devolvida');
  check(M.legOutcome(L('ml', 'home'), can) === 0, 'mma: luta que não aconteceu → vencedor devolvido');
  check(FI.combine(null, { bad: 'x' }, true, 3600000).done === false, 'mma: ESPN incompleta → equipa');

  // odds reais da MoviOdds: cada luta do UFC vira um evento só com mercados automáticos (nada para a equipa)
  const F = require(path.join(__dirname, '..', 'feeds', 'moviodds.js'));
  const now = Date.parse(UFC.odds.server_time);
  let evs = 0, sels = 0;
  for (const m of UFC.odds.matches) {
    const ev = F.toEvent(m, now, 'mma', true);
    if (!/^UFC /.test(m.league)) { check(!ev, `mma: ${m.league} (fora do UFC) entrou no site`); continue; }
    check(ev, `mma: ${m.home} x ${m.away} (${m.league}) não entrou`);
    if (!ev) continue;
    evs++;
    const ss = M.selections(ev);
    sels += ss.length;
    check(ss.every((s) => ['ml', 'fmov', 'fround', 'fdist', 'total'].includes(s.market)), `mma: mercado não automático em ${m.home} x ${m.away}: ${[...new Set(ss.map((s) => s.market))]}`);
    check(ss.filter((s) => s.market === 'ml').length === 2, `mma: ${m.home} x ${m.away} sem os dois vencedores`);
    check(ss.every((s) => s.name && !/\b(By|Draw|Over|Under|Decision)\b/.test(s.name) && !/Method of|Total Rounds|Round Betting|To Win|Fight/.test(s.marketName)), `mma: texto em inglês em ${m.home} x ${m.away}: ${ss.map((s) => s.marketName + ' / ' + s.name).find((t) => /\b(By|Draw|Over|Under|Decision)\b|Method of|Total Rounds|Round Betting/.test(t))}`);
    check(ss.filter((s) => s.market === 'total').every((s) => s.line % 1 === 0.5), `mma: linha de rounds inteira em ${m.home} x ${m.away}`);
    // ao vivo: nada se aposta
    check(!F.toEvent({ ...m, in_play: true }, now, 'mma', true)?.markets, `mma: ${m.home} x ${m.away} com mercados ao vivo`);
  }
  console.log(`  UFC: ${evs} lutas com odds reais da MoviOdds, ${sels} seleções (só mercados automáticos)`);
  check(evs >= 12, `mma: poucas lutas do UFC nas odds (${evs})`);
  // proteção: odds de método que, com o vencedor do outro lado, dão lucro garantido → o método sai
  {
    const m = UFC.odds.matches.find((x) => /^UFC/.test(x.league) && (x.quotes || []).some((q) => q.group_name === 'Method of Victory'));
    const q2 = m.quotes.map((q) => (q.group_name === 'Method of Victory' && q.side === m.home ? { ...q, odds_dec: 9 } : q));
    const ev = F.toEvent({ ...m, id: 'guard-test', quotes: q2 }, now, 'mma', true);
    check(ev && !M.selections(ev).some((s) => s.market === 'fmov'), 'mma: método com lucro garantido não saiu do site');
    check(ev && M.selections(ev).some((s) => s.market === 'ml'), 'mma: a proteção tirou também o vencedor');
  }
}

/* ================= 6) basquete: mercados que eram da equipa e passaram a automáticos =================
   Dados reais em scripts/dados/basquete-2026-10.json: cotações pré-jogo da MoviOdds (12 jogos, 50 tipos de mercado)
   e 317 resultados reais (placar, quartos). Cada mercado tem de ter exatamente um vencedor em todos os resultados. */
{
  const AUTO = require(path.join(__dirname, '..', 'feeds', 'auto.js'));
  const PARTS = require(path.join(__dirname, '..', 'feeds', 'parts.js'));
  const BK = require(path.join(__dirname, 'dados', 'basquete-2026-10.json'));
  // (as seleções do 3 vias: o "N ou mais" lê-se das irmãs do mesmo mercado)
  const mt = { home: 'Casa', away: 'Fora', league: 'NBA', quotes: [{ group_id: 'g', side: 'Casa', line: '6 or more' }, { group_id: 'g', side: 'Fora', line: '6 or more' }, { group_id: 'g', line: 'Any other result' }] };
  const leg = (q, m = mt) => { const r = AUTO.rule({ group_id: 'g', ...q }, m, 'basketball'); return r && r.pick ? { market: r.k, per: `${r.scope}|g`, pick: r.pick, line: r.line } : null; };
  // jogo com prorrogação: 1º tempo 50-48, quartos 25-20 25-28 20-22 30-30 → tempo regulamentar 100-100, final 111-104
  const ot = { done: true, h: 111, a: 104, parts: { q1: [25, 20], q2: [25, 28], q3: [20, 22], q4: [30, 30], h1: [50, 48], h2: [61, 56], reg: [100, 100] } };
  const B = (q, want, what) => { const l = leg(q); check(!!l, `basquete: lê "${q.group_name}" ${what}`); if (l) eq(l, ot, want, `basquete prorrogação: ${q.group_name} ${what}`); };
  B({ group_name: 'Winning Margin', side: 'Casa', line: '7-9' }, 1, 'casa 7-9 (a margem conta a prorrogação)');
  B({ group_name: 'Winning Margin', side: 'Casa', line: '3-6' }, -1, 'casa 3-6');
  B({ group_name: 'Winning Margin 12-Way', side: 'Casa', line: '6-10' }, 1, 'casa 6-10');
  B({ group_name: 'Winning Margin 3-Way', side: 'Casa', line: '6 or more' }, 1, 'casa por 6+');
  B({ group_name: 'Winning Margin 3-Way', line: 'Any other result' }, -1, 'outro resultado');
  B({ group_name: '1st Half Margin (Bands)', side: 'Casa', line: '1-3' }, 1, '1º tempo casa 1-3');
  B({ group_name: '1st Quarter Winning Margin', side: 'Casa', line: '5-6' }, 1, '1º quarto casa 5-6');
  B({ group_name: '1st Quarter Winning Margin', line: 'Tie' }, -1, '1º quarto empate');
  B({ group_name: 'Tied at End Of Regulation?', label: 'Yes' }, 1, 'sim (100-100)');
  B({ group_name: 'Tied at End Of Regulation?', label: 'No' }, -1, 'não');
  B({ group_name: "Result and Both Teams to Score 'X' Points", side: '100', line: 'Casa and Yes' }, 1, 'casa e os dois 100+');
  B({ group_name: "Result and Both Teams to Score 'X' Points", side: '110', line: 'Casa and No' }, 1, 'casa e não os dois 110+');
  B({ group_name: '1st Half Both Teams to Score X Points', side: 'Yes', line: '50' }, -1, 'os dois 50 no 1º tempo (48)');
  B({ group_name: 'Match Result and Total', side: 'Casa', label: 'Over 214.5', line: '214.5', handicap: '214.5' }, 1, 'casa e mais de 214.5 (215)');
  B({ group_name: 'Match Result and Total', side: 'Over', label: ' 215.5', line: 'Casa' }, -1, 'formato ao vivo, mais de 215.5');
  B({ group_name: '1st Half Result and Total', side: 'Under', label: '98.5', line: 'Casa', handicap: '98.5' }, 1, 'casa e menos de 98.5');
  B({ group_name: 'Match Handicap and Total', label: 'Fora +6.5 & Over 210.5' }, -1, 'fora +6.5 (perde por 7)');
  B({ group_name: 'Match Handicap and Total', label: 'Casa -6.5 & Over 210.5' }, 1, 'casa -6.5 e mais de 210.5');
  B({ group_name: 'Team Total Odd Or Even', side: 'Casa', label: 'Odd' }, 1, 'casa ímpar (111)');
  B({ group_name: 'Game Total - Odd or Even', label: 'Odd' }, 1, 'total ímpar (215)');
  B({ group_name: 'Highest Scoring Half', label: 'Half 2' }, 1, '2º tempo (117, com prorrogação)');
  B({ group_name: 'Highest Scoring Quarter', label: '4th Quarter' }, 1, '4º quarto (60, sem prorrogação)');
  B({ group_name: 'Highest Scoring Quarter', label: 'Tie' }, -1, 'empate');
  B({ group_name: 'Team with highest scoring quarter', label: 'Casa' }, -1, 'casa (30 = 30)');
  B({ group_name: 'Team with highest scoring quarter', label: 'Tie' }, 1, 'empate (30 = 30)');
  B({ group_name: 'Quarter Correct Score', side: 'Casa', line: '2-1' }, -1, 'casa 2-1 (foi 1-2, um empate)');
  B({ group_name: 'Quarter Correct Score', side: 'Fora', line: '2-1' }, 1, 'fora 2-1');
  B({ group_name: 'Quarter Correct Score', line: 'Any Other' }, -1, 'outro');
  B({ group_name: '1st Quarter 3 Way Lines', side: 'Casa', line: 'To Win' }, 1, '1º quarto casa');
  B({ group_name: '1st Half Result (Incl. Tie)', label: 'Casa' }, 1, '1º tempo casa');
  B({ group_name: '1st Half Double Chance', label: 'Draw or Fora', n2: 'X2' }, -1, '1º tempo X2');
  B({ group_name: 'Alternative 1st Half Team Totals', side: 'Over', line: '49.5', handicap: '49.5', n2: 'Casa' }, 1, 'casa mais de 49.5 no 1º tempo');
  // formatos ao vivo (a equipa vem no nome do grupo)
  B({ group_name: 'Casa To Score', side: 'Yes', line: '110' }, 1, 'casa faz 110 (111)');
  B({ group_name: '4th Quarter Fora To Score', side: 'Yes', line: '30' }, 1, 'fora faz 30 no 4º quarto');
  B({ group_name: 'Alternative Fora Totals', side: 'Over', label: 'Over', line: '104.5', handicap: '104.5' }, -1, 'fora mais de 104.5 (104)');
  B({ group_name: 'Alternative 2nd Half Casa Totals', side: 'Under', label: 'Under', line: '60.5', handicap: '60.5' }, -1, 'casa menos de 60.5 no 2º tempo (61)');
  B({ group_name: 'Alternative Point Spread', side: 'Fora', label: ' +7.5', line: '+7.5', handicap: '+7.5' }, 1, 'fora +7.5');
  B({ group_name: 'Both Teams To Score', side: 'Yes', line: '105' }, -1, 'os dois 105 (fora 104)');
  B({ group_name: '3rd Quarter', side: 'Tie', line: 'To Win (3-Way)' }, -1, '3º quarto empate (20-22)');
  B({ group_name: '3rd Quarter Winning Margin', side: 'Fora', line: '1-2' }, 1, '3º quarto fora 1-2');
  B({ group_name: '3rd Quarter - Team Totals', side: 'Fora', label: 'Over 21.5', line: '21.5', handicap: '21.5' }, 1, 'fora mais de 21.5 no 3º quarto');
  // sem dados para decidir: não vira automático (sai do site)
  check(!leg({ group_name: 'Team to Score X Points', side: 'Yes', line: '100' }), 'basquete: "Team to Score X Points" não diz a equipa → sem regra');
  check(!leg({ group_name: 'Match Handicap and Total', label: 'Casa -6 & Over 210.5' }), 'basquete: handicap inteiro em combinação → sem regra');
  check(!leg({ group_name: '1st Quarter 3 Way Lines', side: 'Casa', line: 'Line', handicap: '-2' }), 'basquete: handicap a 3 vias → sem regra');
  // quartos em falta: fica por decidir (nunca adivinha)
  eq(leg({ group_name: 'Highest Scoring Quarter', label: '1st Quarter' }), { done: true, h: 90, a: 80, parts: {} }, null, 'basquete sem quartos: espera');

  // dados reais: todos os mercados com exatamente um vencedor (dupla chance: dois; 2 vias com empate na parte: todos devolvidos)
  const Rs = [];
  for (const r of BK.results) {
    const fin = String(r.final_score).split('-').map(Number);
    const parts = PARTS.finishedParts('basketball', r.stats, fin);
    if (parts.q4) Rs.push({ done: true, h: fin[0], a: fin[1], parts });
  }
  // e os mesmos jogos empatados no fim do 4º quarto, com prorrogação de 11-7
  for (const R of Rs.slice(0, 120)) {
    const p = R.parts, d = p.reg[0] - p.reg[1], q4 = [p.q4[0], p.q4[1] + d], reg = [p.reg[0], p.reg[0]];
    Rs.push({ done: true, h: reg[0] + 11, a: reg[1] + 7, parts: { ...p, q4, reg, h2: [reg[0] + 11 - p.h1[0], reg[1] + 7 - p.h1[1]] } });
  }
  let groups = 0, sels = 0;
  for (const m of BK.matches) {
    const byG = new Map();
    for (const q of m.quotes) {
      const r = AUTO.rule(q, m, 'basketball');
      check(!!(r && r.pick), `basquete real: regra para ${q.group_name}`);
      if (!r || !r.pick) continue;
      sels++;
      const norm = r.k === 'ptot' ? 'L' + r.line : r.k === 'pspr' ? 'L' + (r.pick === 'home' ? r.line : -r.line) : r.k === 'pteam' ? r.pick.split(':')[0] + r.line
        : r.k === 'pcond' ? r.pick.replace(/^!/, '').split(';').filter((c) => !/^(res|dc)=/.test(c)).map((c) => c.replace(/=(gt|lt):/, '=').replace(/bx=(yes|no):/, 'bx=').replace(/hc=(home|away):[+-]?/, 'hc=').replace(/^(m[ha]|ad)=.*/, 'm').replace(/^par=(\w):.*/, 'par$1')).join(';') || (/Margin/.test(q.group_name) ? 'm' : '') : '';
      const key = `${q.group_id}|${r.k}|${r.scope}|${norm}`;
      if (!byG.has(key)) byG.set(key, { g: q.group_name, legs: [] });
      byG.get(key).legs.push({ market: r.k, per: `${r.scope}|${q.group_id}`, pick: r.pick, line: r.line });
    }
    for (const { g, legs } of byG.values()) {
      groups++;
      for (const R of Rs) {
        const outs = legs.map((l) => M.legOutcome(l, R));
        const wins = outs.filter((o) => o === 1).length;
        const ok = !outs.some((o) => o == null) && (legs[0].market === 'pdc' ? wins === 2 : legs[0].market === 'pml2' && outs.every((o) => o === 0) ? true : wins === 1);
        check(ok, `basquete real: ${m.home} x ${m.away} · ${g} → ${legs.map((l, i) => `${l.pick}=${outs[i]}`).join(' ')} (${R.h}-${R.a})`);
      }
    }
  }
  console.log(`  basquete: ${sels} seleções reais da MoviOdds em ${groups} mercados, ${Rs.length} resultados (${Rs.length - 120} reais + 120 com prorrogação), todos com exatamente um vencedor`);
}

/* ================= 7) tênis de mesa =================
   Dados reais em scripts/dados/tenis-de-mesa-2026-10.json: cotações pré-jogo da MoviOdds (15 jogos) e 789 resultados
   (placar de cada set). Cada mercado: exatamente um vencedor (ou tudo devolvido); abandonadas: só o que já se decidiu. */
{
  const TT = require(path.join(__dirname, '..', 'feeds', 'tabletennis.js'));
  const FEED = require(path.join(__dirname, '..', 'feeds', 'moviodds.js'));
  const TD = require(path.join(__dirname, 'dados', 'tenis-de-mesa-2026-10.json'));
  const old = Date.now() - 86400000;
  const res = (fs, status = 'finished') => TT.result({ final_score: fs, periods: fs.split(',').map((score, i) => ({ name: `Set ${i + 1}`, score })), status }, old);
  const T = (market, pick, R, want, what, line, per) => eq({ market, pick, line, per }, R, want, `tênis de mesa: ${what}`);
  // casos conhecidos: 11-8 3-11 11-9 14-16 12-10 → casa 3-2, 51-54 em pontos (105)
  const r5 = res('11-8,3-11,11-9,14-16,12-10');
  // mercados do ao vivo (51-54 pontos, sets 19 / 14 / 20 / 30 / 22 pontos)
  T('ttoe', 'odd', r5, 1, '1º set 19 pontos ímpar', undefined, '1');
  T('ttoe', 'even', r5, -1, 'partida 105 pontos: par perde', undefined, 'M');
  T('ttgx', 'yes', r5, 1, '4º set 14-16 foi a 10-10', undefined, '4');
  T('ttgx', 'no', r5, 1, '1º set 11-8 não foi a 10-10', undefined, '1');
  T('ttgm', 'away:5+', r5, 1, '2º set 3-11: fora por 8', undefined, '2');
  T('ttgm', 'home:2', r5, 1, '5º set 12-10: casa por 2', undefined, '5');
  T('ttgm', 'home:3-4', r5, 1, '1º set 11-8: casa por 3 (banda 3-4)', undefined, '1');
  T('ttgm', 'away:3-4', r5, -1, '1º set 11-8: fora perdeu', undefined, '1');
  T('ttmp', 'under', r5, 1, 'casa 51 pontos, menos de 51.5', 51.5, 'home');
  T('ttmp', 'over', r5, 1, 'fora 54 pontos, mais de 53.5', 53.5, 'away');
  T('ttdr', 'home:w', r5, 1, 'casa ganha 1º set e partida');
  T('ttdr', 'away:l', r5, -1, 'fora não ganhou o 1º set');
  T('ttrt', 'home:over', r5, 1, 'casa ganha e 105 > 100.5', 100.5);
  T('ttrt', 'away:over', r5, -1, 'fora não ganhou', 100.5);
  T('ttcs', '1-1', r5, 1, 'placar após 2 sets 1-1', undefined, '2');
  check(r5.done && r5.h === 3 && r5.a === 2, 'tênis de mesa: 3-2 lido');
  T('ml', 'home', r5, 1, 'vencedor'); T('ttsh', 'away', r5, 1, 'fora +1.5 sets', 1.5); T('ttsh', 'home', r5, -1, 'casa -1.5 sets', -1.5);
  T('ttpt', 'over', r5, 1, 'mais de 103.5 pontos (105)', 103.5); T('ttph', 'away', r5, -1, 'fora -3.5 pontos (fez mais 3)', -3.5); T('ttph', 'away', r5, 1, 'fora -2.5', -2.5);
  T('ttcs', '3-2', r5, 1, 'placar 3-2', null, 'M'); T('ttcs', '2-1', r5, 1, 'após 3 sets 2-1', null, '3'); T('ttcs', '1-1', r5, 1, 'após 2 sets 1-1', null, '2');
  T('ttgw', 'away', r5, 1, '2º set fora', null, '2'); T('ttgt', 'over', r5, 1, '4º set mais de 29.5 (30)', 29.5, '4'); T('ttgh', 'home', r5, 1, '1º set casa -2.5', -2.5, '1');
  T('ttgwt', 'home:under', r5, 1, '1º set casa e menos de 19.5', 19.5, '1'); T('ttgp', 'over', r5, 1, '4º set fora mais de 15.5', 15.5, '4:away');
  // 3-0: o 4º e o 5º set não se jogaram → devolvidas
  const r3 = res('11-5,11-7,11-9');
  T('ttgw', 'home', r3, 0, '4º set não jogado', null, '4'); T('ttcs', '3-0', r3, 1, 'após 3 sets 3-0', null, '3');
  // abandonada a 2-1 (o 4º set a meio fica de fora): sets acabados valem, o resto devolvido
  const ab = res('11-5,8-11,11-9,4-2', 'unknown');
  check(ab.done && ab.incomplete && ab.sets.length === 3, 'tênis de mesa: abandonada lida');
  T('ttgw', 'home', ab, 1, 'abandonada: 3º set decidido', null, '3'); T('ttgw', 'home', ab, 0, 'abandonada: 4º set em aberto', null, '4');
  T('ml', 'home', ab, 0, 'abandonada: vencedor em aberto'); T('ttsh', 'home', ab, 1, 'abandonada: casa +2.5 já decidido', 2.5);
  T('ttpt', 'over', ab, 1, 'abandonada: mais de 50.5 já passado (55)', 50.5); T('ttpt', 'under', ab, 0, 'abandonada: menos de 80.5 em aberto', 80.5);
  T('ttcs', '2-1', ab, 1, 'abandonada: após 3 sets 2-1', null, '3');
  // partida em curso: ainda não se dá por abandonada
  check(!TT.result({ final_score: '11-5,8-11', periods: [], status: 'unknown' }, Date.now()).done, 'tênis de mesa: partida em curso não liquida');
  check(!res('11-5,11-7,11-12').done, 'tênis de mesa: set impossível (11-12) não liquida');
  check(!res('11-5,11-7').done, 'tênis de mesa: terminada a 2-0 (não é melhor de 5) não liquida');
  eq({ market: 'ml', pick: 'home' }, { done: true, h: 0, a: 0, sets: [], tt: true, cancelled: true }, 0, 'tênis de mesa: não se jogou → devolvida');

  // dados reais
  const Rs = TD.results.map((r) => TT.result(r, old)).filter((r) => r.done);
  check(TD.results.filter((r) => r.status === 'finished').every((r) => TT.result(r, old).done && !TT.result(r, old).incomplete), 'tênis de mesa: todas as partidas terminadas liquidam');
  const now = Date.parse(TD.server_time);
  let mk = 0, sels = 0;
  const TL = require(path.join(__dirname, 'dados', 'tenis-de-mesa-aovivo-2026-10.json')); // ao vivo
  for (const m of TD.matches.concat(TL.matches)) {
    const ev = FEED.toEvent(m, now, 'tabletennis', true);
    if (!m.in_play) check(!!ev && !!ev.markets, `tênis de mesa: ${m.home} x ${m.away} entra no site`);
    if (!ev || !ev.markets) continue;
    // ao vivo: os finais possíveis são os sets já jogados + a continuação de cada resultado real
    const done = m.in_play ? String(m.score || '').split(',').map((x) => x.split('-').map(Number)).filter((g) => g.length === 2 && TT.okGame(g)) : [];
    const finals = !m.in_play ? Rs : Rs.filter((R) => !R.incomplete).map((R) => {
      const sets = [];
      for (const g of done.concat(R.sets.slice(done.length))) { if (sets.filter((x) => x[0] > x[1]).length === TT.NEED || sets.filter((x) => x[1] > x[0]).length === TT.NEED) break; sets.push(g); }
      const h = sets.filter((x) => x[0] > x[1]).length, a = sets.length - h;
      return h === TT.NEED || a === TT.NEED ? { done: true, h, a, sets, tt: true } : null;
    }).filter(Boolean);
    const S = M.selections({ ...ev, date: new Date(ev.date) });
    sels += S.length;
    for (const s of S) check(!/\b(Game|Games|Over|Under|Winner|Total Double|Line)\b/.test(s.marketName + ' ' + s.name), `tênis de mesa: texto em português (${s.marketName} · ${s.name})`);
    const by = new Map();
    for (const s of S) {
      const k = s.market === 'ml' ? 'ml' : s.market === 'ttcs' ? 'cs' + s.per : ['ttsh', 'ttph', 'ttgh'].includes(s.market) ? s.market + s.per + '|' + (s.pick === 'home' ? s.line : -s.line) : s.market + (s.per ?? '') + '|' + s.line;
      if (!by.has(k)) by.set(k, []); by.get(k).push(s);
    }
    for (const list of by.values()) {
      mk++;
      for (const R of finals) {
        const outs = list.map((s) => M.legOutcome({ market: s.market, pick: s.pick, line: s.line, per: s.per }, R));
        const wins = outs.filter((x) => x === 1).length;
        // ao vivo a bet365 tira as seleções já impossíveis: pode não haver vencedor entre as que sobram
        const ok = !outs.some((x) => x == null) && (R.incomplete ? wins <= 1 : wins === 1 || outs.every((x) => x === 0) || (m.in_play && wins === 0 && list[0].market === 'ttcs'));
        check(ok, `tênis de mesa real: ${list[0].marketName} → ${list.map((s, i) => `${s.name}=${outs[i]}`).join(' | ')} (${R.sets.map((x) => x.join('-')).join(' ')})`);
      }
    }
  }
  console.log(`  tênis de mesa: ${sels} seleções reais da MoviOdds em ${mk} mercados, ${Rs.length} resultados reais (${Rs.filter((r) => r.incomplete).length} abandonadas)`);
}

/* ================= 8) basquete: mercados de jogadores =================
   Dados reais em scripts/dados/basquete-jogadores-2026-10.json (cotações NBA/WNBA da MoviOdds, uma ao vivo).
   Box score oficial (ESPN) montado à mão: Mais/Menos de cada linha → exatamente um ganha; "N ou mais" sobe com N;
   não jogou ou fora do box score → devolvida; sem box score → equipa. */
{
  const FEED = require(path.join(__dirname, '..', 'feeds', 'moviodds.js'));
  const BD = require(path.join(__dirname, 'dados', 'basquete-jogadores-2026-10.json'));
  const box = [
    { key: M.bpKey('Austin Reaves'), side: 'home', played: true, pts: 24, reb: 4, ast: 10, tpm: 3, stl: 1, blk: 0 },
    { key: M.bpKey('Darius Garland'), side: 'away', played: true, pts: 9, reb: 10, ast: 10, tpm: 2, stl: 2, blk: 1 },
    { key: M.bpKey('Bronny James'), side: 'home', played: false, pts: 0, reb: 0, ast: 0, tpm: 0, stl: 0, blk: 0 },
    { key: M.bpKey('Jalen Williams'), side: 'home', played: true, pts: 10, reb: 3, ast: 2, tpm: 1, stl: 0, blk: 0 },
    { key: M.bpKey('Jaylin Williams'), side: 'home', played: true, pts: 4, reb: 7, ast: 1, tpm: 0, stl: 0, blk: 1 },
  ];
  const R = { done: true, h: 120, a: 118, bp: box };
  const B = (per, pick, want, what) => eq({ market: 'bp', per: `${per}|1`, pick }, R, want, `basquete jogadores: ${what}`);
  B('pts', '24##Austin Reaves', 1, 'Reaves 24 pontos, "24 ou mais" ganha');
  B('pts', '25##Austin Reaves', -1, 'Reaves 24 pontos, "25 ou mais" perde');
  B('pts', 'u24##Austin Reaves', -1, 'Reaves 24 pontos, "Menos de 23.5" perde');
  B('pts', 'u25#home#Austin Reaves', 1, 'Reaves 24 pontos, "Menos de 24.5" ganha');
  B('pra', '38##A Reaves', 1, 'nome abreviado da MoviOdds (24+4+10 = 38)');
  B('pa', '35#away#Austin Reaves', null, 'lado errado → equipa');
  B('dd', '2##Austin Reaves', 1, 'duplo-duplo (pontos + assistências)');
  B('td', '3##Darius Garland', -1, 'triplo-duplo: 9 pontos, 10 rebotes, 10 assistências → perde');
  B('td', 'u3##Darius Garland', 1, 'triplo-duplo "Não" ganha');
  B('sb', '3##Darius Garland', 1, 'roubos + tocos 2+1');
  B('reb', '1##Bronny James', 0, 'não jogou → devolvida');
  B('reb', '1##Kevin Durant', 0, 'fora do box score (inativo) → devolvida');
  B('reb', '1##Austin Williams', null, 'mesmo apelido com outra inicial → equipa');
  B('reb', '1##Jalen Williams', null, 'dois "J Williams" → equipa');
  eq({ market: 'bp', per: 'pts|1', pick: '10##Austin Reaves' }, { done: true, h: 120, a: 118 }, null, 'basquete jogadores: sem box score → equipa');
  // dados reais: cada seleção, com o jogador no box score (valores a variar), dá um resultado coerente
  let sels = 0, mks = 0;
  for (const m of BD.matches) {
    const ev = FEED.toEvent(m, Date.now(), 'basketball', true);
    const bp = (ev?.markets || []).filter((mk) => mk.k === 'bp');
    check(bp.length > 0, `basquete jogadores: ${m.home} x ${m.away} sem mercados de jogadores`);
    for (const mk of bp) {
      mks++;
      const byPlayer = new Map();
      for (const s of mk.sels) { const nm = String(s.pick).split('#').slice(2).join('#'); if (!byPlayer.has(nm)) byPlayer.set(nm, []); byPlayer.get(nm).push(s); }
      for (const [nm, list] of byPlayer) for (const v of [0, 1, 5, 9, 10, 12, 25, 40]) {
        const p = { key: M.bpKey(nm), side: '', played: true, pts: v, reb: v, ast: v, tpm: v, stl: v, blk: v, fb: v > 0 ? 1 : 0, fa: v > 0 ? 1 : 0 };
        const RR = { done: true, h: 100, a: 100, bp: [p] };
        const outs = list.map((s) => M.legOutcome({ market: 'bp', per: mk.per, pick: s.pick }, RR));
        sels += list.length;
        check(outs.every((x) => x === 1 || x === -1), `basquete jogadores real: ${mk.name} ${nm} (${v}) sem decisão`);
        // cada linha: "N ou mais" e "menos de N" (mesmo N) → exatamente um ganha
        const byN = new Map();
        list.forEach((s, i) => { const n = String(s.pick).split('#')[0].replace(/^u/, ''); if (!byN.has(n)) byN.set(n, []); byN.get(n).push(outs[i]); });
        for (const [n, o] of byN) if (o.length === 2) check(o.filter((x) => x === 1).length === 1, `basquete jogadores real: ${mk.name} ${nm} linha ${n} (${v}) → ${o.join(',')}`);
        // "N ou mais": ganha se e só se v >= N
        list.forEach((s, i) => { const x = /^(u?)(\d+)#/.exec(s.pick); const val = M.BP_FIELD[mk.per.split('|')[0]](p); check(outs[i] === ((val >= Number(x[2])) !== !!x[1] ? 1 : -1), `basquete jogadores real: ${mk.name} ${s.name} com ${val}`); });
      }
    }
  }
  check(mks >= 20, `basquete jogadores: poucos mercados reais (${mks})`);
  console.log(`  basquete jogadores: ${mks} mercados reais da MoviOdds, ${sels} liquidações testadas`);
}

/* ================= 8b) basquete: pagar na hora quem passou a linha =================
   Duas fontes (MoviOdds ao vivo + ESPN ao vivo) têm de mostrar a linha passada, estáveis durante o tempo de confirmação. */
{
  process.env.EARLY_SETTLE_S = process.env.EARLY_SETTLE_S || '150';
  const mk = require(path.join(__dirname, '..', 'early.js'));
  let T = 1e12, mv = null, eb = null;
  const ev = { id: 'nb1', sport: 'basketball', league: 'nba', state: 'in', home: { name: 'A' }, away: { name: 'B' }, markets: [{ k: 'ml', sels: [{ lock: false }] }] };
  const events = new Map([[ev.id, ev]]);
  const E = mk({ M, TEN: require(path.join(__dirname, '..', 'feeds', 'tennis.js')), events, liveStats: () => mv, now: () => T, espnBox: () => eb });
  const mvP = (pts, reb) => ({ players: [{ name: 'Austin Reaves', team: 'home', box_score: { minutes: '22:10', points: pts, rebounds: reb, assists: 1, three_pointers_made: 2, steals: 0, blocks: 0, on_court: true } }] });
  const ebP = (pts, reb) => [{ key: M.bpKey('Austin Reaves'), side: 'home', played: true, pts, reb, ast: 1, tpm: 2, stl: 0, blk: 0 }];
  const run = (leg, id) => { let r = false; for (let i = 0; i < 4 && !r; i++) { r = E.check(id, leg); T += 60000; } return r; };
  const L = (pick, stat = 'pts') => ({ evId: ev.id, market: 'bp', per: `${stat}|9`, pick });
  const BPL = require(path.join(__dirname, '..', 'feeds', 'bplayers.js'));
  mv = mvP(21, 4); eb = ebP(21, 4);
  const p = BPL.roster(mv)[0];
  {
    const need = p.pts; // "N ou mais" com N = pontos atuais → já passou
    const over = L(`${need}#${p.side}#${p.name}`), under = L(`u${need}#${p.side}#${p.name}`);
    check(run(over, 'b1') && over.result && over.value === 1, `basquete na hora: ${p.name} ${need}+ pontos → ganha (${over.result})`);
    check(run(under, 'b2') && under.value === -1, `basquete na hora: ${p.name} menos de ${need} → perde (${under.result})`);
    const hi = L(`${need + 1}#${p.side}#${p.name}`);
    check(!run(hi, 'b3') && !hi.result, 'basquete na hora: ainda não passou → fica em aberto');
    eb = eb.map((x) => (x.key === p.key ? { ...x, pts: need - 1 } : x));
    const dis = L(`${need}#${p.side}#${p.name}`);
    check(!run(dis, 'b4') && !dis.result, 'basquete na hora: a ESPN ainda não mostra → fica em aberto');
    eb = null;
    const noE = L(`${need}#${p.side}#${p.name}`);
    check(!run(noE, 'b5') && !noE.result, 'basquete na hora: sem a ESPN → fica em aberto');
    eb = ebP(21, 4); ev.markets = [{ k: 'ml', sels: [{ lock: true }] }];
    const lk = L(`${need}#${p.side}#${p.name}`);
    check(!run(lk, 'b6') && !lk.result, 'basquete na hora: mercados fechados → espera');
    ev.markets = [{ k: 'ml', sels: [{ lock: false }] }];
    // tempo de confirmação: uma passagem só não chega
    const one = L(`${need}#${p.side}#${p.name}`); E.check('b7', one);
    check(!one.result, 'basquete na hora: precisa de confirmação estável');
    // rebotes: a MoviOdds diz 10, a ESPN 9 → "10 ou mais" fica em aberto (a MoviOdds erra rebotes)
    mv = mvP(21, 10); eb = ebP(21, 9);
    const rb = L(`10#home#Austin Reaves`, 'reb');
    check(!run(rb, 'b8') && !rb.result, 'basquete na hora: rebotes só da MoviOdds → espera pela ESPN');
    eb = ebP(21, 10);
    check(run(rb, 'b8') && rb.value === 1, 'basquete na hora: as duas com 10 rebotes → ganha');
    // pontos: só a MoviOdds, se os pontos dos jogadores somarem o placar ao vivo
    eb = null; mv = mvP(21, 4); ev.home.score = 21; ev.away.score = 0;
    const p1 = L('20#home#Austin Reaves'), p1u = L('u20#home#Austin Reaves');
    check(run(p1, 'b9') && p1.value === 1, 'basquete na hora: pontos batem com o placar → ganha sem a ESPN');
    check(run(p1u, 'b10') && p1u.value === -1, 'basquete na hora: pontos batem com o placar → "menos de" perde');
    ev.home.score = 23;
    const p2 = L('20#home#Austin Reaves');
    check(!run(p2, 'b11') && !p2.result, 'basquete na hora: pontos não somam o placar → espera pela ESPN');
    ev.home.score = 21;
    const p3 = L('20#home#Austin Reaves'); E.check('b12', p3); T += 10000; E.check('b12', p3);
    check(!p3.result, 'basquete na hora: pontos com menos de 20 s → ainda não');
    T += 15000; check(E.check('b12', p3) && p3.value === 1, 'basquete na hora: pontos com 20 s estáveis → paga');
    const pa = L('20#home#Austin Reaves', 'pra');
    check(!run(pa, 'b13') && !pa.result, 'basquete na hora: combinado com rebotes/assistências precisa da ESPN');
  }
}

/* ================= 8c) basquete: corrida a X pontos, equipa faz X pontos, margem sem equipa =================
   Dados reais em scripts/dados/basquete-equipas-2026-10.json (68 jogos). */
{
  const AUTO = require(path.join(__dirname, '..', 'feeds', 'auto.js'));
  const BD = require(path.join(__dirname, 'dados', 'basquete-equipas-2026-10.json'));
  const C = (pick, R, want, what, per = 'ft|1') => eq({ market: 'prace', pick, per }, R, want, `corrida: ${what}`);
  const q4 = { q1: [20, 18], q2: [22, 25], q3: [19, 21], q4: [24, 20] };
  const R0 = { h: 85, a: 84, parts: { ...q4, h1: [42, 43], h2: [43, 41] } };
  // leituras ao vivo (pontos de cada quarto)
  const log = [{ hp: [0], ap: [0] }, { hp: [8], ap: [9] }, { hp: [10], ap: [9] }, { hp: [10], ap: [11] }, { hp: [12], ap: [11] }, { hp: [18], ap: [18] }, { hp: [20], ap: [18] }];
  C('home:10', { ...R0, blog: log }, 1, 'casa chegou a 10 com a fora em 9', 'q1|1');
  C('away:10', { ...R0, blog: log }, -1, 'fora perdeu a corrida a 10', 'q1|1');
  C('none:10:n', { ...R0, blog: log }, -1, '"Nenhuma" perde quando alguém chega', 'q1|1');
  C('home:25:n', { ...R0, blog: log }, -1, 'ninguém chegou a 25 no 1º quarto, com "Nenhuma"', 'q1|1');
  C('none:25:n', { ...R0, blog: log }, 1, '"Nenhuma" ganha', 'q1|1');
  C('home:25', { ...R0, blog: log }, 0, 'ninguém chegou e o mercado não tem "Nenhuma" → devolvida', 'q1|1');
  C('home:15', R0, 0, 'as duas passaram 15 no quarto, sem leituras → devolvida', 'q1|1');
  C('home:15', { ...R0, blog: [{ hp: [14], ap: [12] }, { hp: [16], ap: [14] }] }, 1, 'casa 16-14: chegou primeiro', 'q1|1');
  C('home:15', { ...R0, blog: [{ hp: [14], ap: [14] }, { hp: [16], ap: [16] }] }, 0, 'as duas na mesma leitura → devolvida', 'q1|1');
  // cesto anulado: a casa teve 15, voltou a 13, a fora chegou primeiro de vez
  C('away:15', { ...R0, blog: [{ hp: [15], ap: [12] }, { hp: [13], ap: [12] }, { hp: [13], ap: [15] }, { hp: [17], ap: [15] }] }, 1, 'cesto anulado na revisão', 'q1|1');
  // jogo todo pelos fins de quarto: 20-18, 42-43, 61-64 → a 40 a casa (42) e a fora (43) passaram no 2º quarto → sem leituras devolvida
  C('home:40', R0, 0, 'a 40 os dois passaram no mesmo quarto → devolvida');
  C('home:30', { ...R0, parts: { ...R0.parts, q2: [12, 3] } }, 1, 'fim do 2º quarto 32-21: casa chegou a 30 primeiro');
  C('away:84', R0, 0, 'jogo todo: os dois passaram 84 no 4º quarto, sem leituras → devolvida');
  C('home:85', R0, 1, 'só a casa chegou a 85');
  // 2º tempo (conta a prorrogação): quartos 3 e 4 = 43-41; ao fim do 3º 19-21 → a 20 a fora chegou primeiro
  C('away:20', R0, 1, '2º tempo: fim do 3º quarto 19-21', 'h2|1');
  // as leituras usam os quartos da parte: 2º tempo com prorrogação no fim
  C('home:45', { h: 95, a: 90, parts: { ...q4, h1: [42, 43], h2: [53, 47] }, blog: [{ hp: [20, 22, 19, 24], ap: [18, 25, 21, 20] }, { hp: [20, 22, 19, 24, 2], ap: [18, 25, 21, 20, 0] }, { hp: [20, 22, 19, 24, 10], ap: [18, 25, 21, 20, 6] }] }, 1, '2º tempo na prorrogação', 'h2|1');
  check(M.raceFromLog(log, 'q1', 10) === 'home' && M.raceFromLog(log, 'q1', 30) === null, 'corrida: leituras ao vivo');

  // regras com as cotações reais
  let nTeam = 0, nRace = 0, nMargin = 0;
  const RS = [];
  for (const h of [60, 85, 102]) for (const a of [55, 84, 101]) for (const s1 of [[30, 28], [40, 41], [52, 47]]) RS.push({ h, a, parts: { h1: s1, q1: [Math.floor(s1[0] / 2), Math.floor(s1[1] / 2)] } });
  for (const m of BD.matches) {
    const tot = (re, side) => { const r = m.quotes.find((q) => re.test(q.group_name) && (q.side === side || q.n2 === side) && /over/i.test(`${q.label} ${q.side}`)); return r ? AUTO.lineOf(r) : NaN; };
    const groups = new Map();
    for (const q of m.quotes) {
      if (/Team Totals$/.test(q.group_name) || !(q.odds_dec > 1)) continue;
      const r = AUTO.rule(q, m, 'basketball');
      if (!r) continue;
      const key = `${r.scope}|${q.group_id}:${r.sub || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ q, r });
      if (/Team [Tt]o Score X Points$/.test(q.group_name)) {
        nTeam++;
        // a equipa mais forte (total mais alto) tem de ficar com o "Sim" mais barato em cada linha
        const pre = (/^(1st Half|1st Quarter) /.exec(q.group_name) || [])[1];
        const re = new RegExp(`^${pre ? pre + ' (- )?' : ''}Team Totals$`);
        const hl = tot(re, m.home), al = tot(re, m.away);
        if (hl !== al && /^yes/i.test(q.side)) {
          const twin = m.quotes.find((o) => o !== q && o.group_id === q.group_id && o.market_id === q.market_id && o.line === q.line && /^yes/i.test(o.side) && o.odds_dec > 1);
          const strong = hl > al ? 'home' : 'away', mineStrong = q.odds_dec < twin.odds_dec;
          const w = r.sub;
          check((w === strong) === mineStrong, `faz X pontos: ${m.home} x ${m.away} ${q.group_name} ${q.line} ${w} @${q.odds_dec} (totais ${hl}/${al})`);
        }
      }
      if (r.k === 'prace') nRace++;
      if (q.group_name === 'Winning Margin 7-Way') nMargin++;
    }
    // cada mercado: com qualquer resultado, exatamente uma seleção ganha (Sim/Não de cada linha; faixas da margem)
    for (const [key, list] of groups) {
      if (list[0].r.k !== 'pcond') continue;
      const byLine = new Map();
      for (const x of list) { const k = list[0].q.group_name === 'Winning Margin 7-Way' ? 'm' : String(x.q.line); if (!byLine.has(k)) byLine.set(k, []); byLine.get(k).push(x); }
      for (const [L, sels] of byLine) for (const R of RS) {
        const outs = sels.map((x) => M.legOutcome({ market: x.r.k, pick: x.r.pick, per: `${x.r.scope}|1` }, R));
        const exact = sels.length >= 2 && outs.filter((v) => v === 1).length === 1;
        check(exact || (list[0].q.group_name === 'Winning Margin 7-Way' && R.h === R.a), `${m.home} x ${m.away} ${list[0].q.group_name} ${L}: ${outs.join(',')} com ${R.h}-${R.a}`);
      }
    }
  }
  check(nTeam > 300 && nRace > 300 && nMargin > 20, `basquete real: poucas seleções lidas (faz X ${nTeam}, corrida ${nRace}, margem ${nMargin})`);
  console.log(`  basquete real: ${nTeam} "faz X pontos", ${nRace} corridas, ${nMargin} margens sem equipa`);

  // ao vivo (early.js): decide quando uma chega a X e a outra não; "Nenhuma" só no fim da parte
  process.env.EARLY_SETTLE_S = process.env.EARLY_SETTLE_S || '150';
  const mk = require(path.join(__dirname, '..', 'early.js'));
  let T = 2e12, lg = [], st = null;
  const ev = { id: 'rc1', sport: 'basketball', league: 'x', state: 'in', home: { name: 'A', score: 0 }, away: { name: 'B', score: 0 }, markets: [{ k: 'ml', sels: [{ lock: false }] }] };
  const E = mk({ M, TEN: require(path.join(__dirname, '..', 'feeds', 'tennis.js')), events: new Map([[ev.id, ev]]), liveStats: () => st, now: () => T, raceLog: () => lg });
  const set = (hp, ap, summary = []) => { st = { home: { points: hp.reduce((a, b) => a + b, 0), periods: hp }, away: { points: ap.reduce((a, b) => a + b, 0), periods: ap }, summary }; ev.home.score = st.home.points; ev.away.score = st.away.points; lg.push({ hp, ap }); };
  const run = (leg, id) => { let r = false; for (let i = 0; i < 3 && !r; i++) { r = E.check(id, leg); T += 15000; } return r; };
  set([8], [9]); set([10], [9]);
  const a = { evId: ev.id, market: 'prace', per: 'q1|1', pick: 'home:10:n' }, b = { evId: ev.id, market: 'prace', per: 'q1|1', pick: 'away:10:n' }, n = { evId: ev.id, market: 'prace', per: 'q1|1', pick: 'none:25:n' };
  check(run(a, 'r1') && a.value === 1, 'corrida ao vivo: casa chega a 10 → paga');
  check(run(b, 'r2') && b.value === -1, 'corrida ao vivo: fora perde logo');
  check(!run(n, 'r3') && !n.result, 'corrida ao vivo: "Nenhuma" espera pelo fim do quarto');
  set([22], [20], ['Score After 1st Quarter - 22-20']); set([22, 0], [20, 0], ['Score After 1st Quarter - 22-20']);
  check(run(n, 'r3') && n.value === 1, 'corrida ao vivo: fim do 1º quarto 22-20 → "Nenhuma" (25) ganha');
}

/* ================= 8d) basquete: primeiro cesto e primeira assistência (lance a lance da ESPN) =================
   Lance livre conta como primeiro cesto; primeiro rebote e jogadores por quarto não se oferecem (decisão de 2026-10-29). */
{
  const BPL = require(path.join(__dirname, '..', 'feeds', 'bplayers.js'));
  const m = { home: 'ATL Hawks', away: 'CLE Cavaliers' };
  const fq = (side, group = 'Player First') => BPL.quote({ group_name: group, group_id: '78', side, line: 'James Harden', n2: 'CLE Cavaliers' }, m);
  check(fq('Basket')?.per === 'fb|78' && fq('Basket')?.pick === '1#away#James Harden', 'primeiro cesto: leitura da cotação');
  check(fq('Assist')?.per === 'fa|78', 'primeira assistência: leitura da cotação');
  check(!fq('Rebound') && BPL.isPlayerGroup('Player First'), 'primeiro rebote: não se oferece');
  for (const g of ['1st Quarter Points', '1st Quarter Rebounds', '1st Quarter Assists']) check(!fq('7', g) && BPL.isPlayerGroup(g), `${g}: não se oferece`);
  const P = (o) => ({ key: M.bpKey('James Harden'), side: 'away', played: true, pts: 20, reb: 5, ast: 6, tpm: 2, stl: 1, blk: 0, fb: 0, fa: 0, ...o });
  const F = (stat, bp, want, what) => eq({ market: 'bp', per: `${stat}|78`, pick: '1#away#James Harden' }, { done: true, h: 100, a: 99, bp: [bp] }, want, `primeiros: ${what}`);
  F('fb', P({ fb: 1 }), 1, 'primeiro cesto foi dele (lance livre conta)');
  F('fb', P(), -1, 'primeiro cesto de outro');
  F('fa', P({ fa: 1 }), 1, 'primeira assistência foi dele');
  F('fb', P({ played: false }), 0, 'não jogou → devolvida');
  F('fb', P({ fb: undefined }), null, 'sem lance a lance conferido → espera');
  // ao vivo: só a ESPN decide
  process.env.EARLY_SETTLE_S = process.env.EARLY_SETTLE_S || '150';
  const mk = require(path.join(__dirname, '..', 'early.js'));
  let T = 3e12, eb = null;
  const ev = { id: 'fb1', sport: 'basketball', league: 'nba', state: 'in', home: { name: 'ATL Hawks', score: 2 }, away: { name: 'CLE Cavaliers', score: 0 }, markets: [{ k: 'ml', sels: [{ lock: false }] }] };
  const E = mk({ M, TEN: require(path.join(__dirname, '..', 'feeds', 'tennis.js')), events: new Map([[ev.id, ev]]), liveStats: () => ({ players: [] }), now: () => T, espnBox: () => eb });
  const run = (leg, id) => { let r = false; for (let i = 0; i < 4 && !r; i++) { r = E.check(id, leg); T += 15000; } return r; };
  const L = (stat) => ({ evId: ev.id, market: 'bp', per: `${stat}|78`, pick: '1#away#James Harden' });
  eb = [P({ fb: 1 })];
  const a = L('fb'); check(run(a, 'fb1') && a.value === 1, 'primeiro cesto ao vivo: paga logo');
  eb = [P({ fb: 0, played: false })];
  const b = L('fb'); check(!run(b, 'fb2') && !b.result, 'primeiro cesto ao vivo: de outro, mas ele ainda não jogou → espera pelo fim');
  eb = [P({ fb: 0 })];
  check(run(b, 'fb2') && b.value === -1, 'primeiro cesto ao vivo: de outro e ele já jogou → perde');
  eb = null;
  const c = L('fa'); check(!run(c, 'fb3') && !c.result, 'primeira assistência ao vivo: sem a ESPN → espera');
}

/* ================= 9) hóquei: mercados que eram da equipa =================
   Dados reais em scripts/dados/hoquei-2026-10.json (cotações de 16 jogos e 73 resultados com cronologia).
   Cada mercado, com cada resultado (reais + prorrogação + pênaltis montados): exatamente um vencedor, ou tudo para a
   equipa (null) quando a regra não decide (mercados "jogo todo" num jogo com prorrogação). */
{
  const FEED = require(path.join(__dirname, '..', 'feeds', 'moviodds.js'));
  const HD = require(path.join(__dirname, 'dados', 'hoquei-2026-10.json'));
  const H = (market, pick, R, want, what, line, per) => eq({ market, pick, line, per }, R, want, `hóquei: ${what}`);
  // casos conhecidos: 3-2 no tempo regulamentar (casa, fora, casa, fora, casa), 2-1 na prorrogação, 2-2 + pênaltis
  const reg = { done: true, h: 3, a: 2, reg: [3, 2], parts: { p1: [1, 1], p2: [1, 1], p3: [1, 0] }, gorder: ['home', 'away', 'home', 'away', 'home'], greg: 5 };
  const ot = { done: true, h: 2, a: 1, reg: [1, 1], parts: { p1: [1, 0], p2: [0, 1], p3: [0, 0] }, gorder: ['home', 'away', 'home'], greg: 2 };
  const so = { done: true, h: 2, a: 2, reg: [2, 2], so: true, alts: [[3, 2], [2, 3]], parts: { p1: [2, 0], p2: [0, 2], p3: [0, 0] }, gorder: ['home', 'home', 'away', 'away'], greg: 4 };
  H('hend', 'reg', reg, 1, 'acabou nos 60 minutos'); H('hend', 'ot', ot, 1, 'acabou na prorrogação'); H('hend', 'so', so, 1, 'acabou nos pênaltis'); H('hend', '!so', ot, 1, 'não foi a pênaltis');
  H('pcs', '3-2', reg, 1, 'placar exato 3-2 (60 min)', undefined, 'ftr|1'); H('pcs', '2-1', ot, null, 'placar exato com prorrogação → equipa', undefined, 'ftr|1');
  H('pcond', 'mh=in:1-1', reg, 1, 'margem: casa por 1', undefined, 'ftr|1');
  H('pml2', 'home', ot, 0, 'empate anula: 1-1 nos 60 min → devolvida', undefined, 'reg|1');
  H('hng', 'first:home', reg, 1, '1º gol da casa'); H('hng', 'last:home', reg, 1, 'último gol da casa'); H('hng', '6:none', reg, 1, 'não houve 6º gol');
  H('hng', '3:home', ot, null, '3º gol na prorrogação → equipa'); H('hng', 'last:home', so, null, 'último gol com pênaltis → equipa');
  H('hng', 'firstwins:yes', reg, 1, 'quem marcou primeiro ganhou');
  H('hphs', 'tie', reg, 1, 'períodos 2-2-1: empate no mais alto'); H('hmost', 'home', reg, 1, 'casa ganhou mais períodos (1 a 0)');
  H('pcond', 'mh=lt:1', reg, -1, 'handicap a 3: fora +1 perde com 3-2', undefined, 'reg|1');
  // marcadores (NHL, ESPN)
  const hg = { ...reg, hg: { players: [{ key: M.bpKey('Olen Zellweger'), side: 'away', goals: 2 }, { key: M.bpKey('Zach Benson'), side: 'away', goals: 0 }, { key: M.bpKey('Macklin Celebrini'), side: 'home', goals: 3 }],
    order: [{ key: 'm celebrini', side: 'home' }, { key: 'o zellweger', side: 'away' }, { key: 'm celebrini', side: 'home' }, { key: 'o zellweger', side: 'away' }, { key: 'm celebrini', side: 'home' }] } };
  const G = (per, pick, want, what) => eq({ market: 'hgs', per: `${per}|1`, pick }, hg, want, `hóquei marcadores: ${what}`);
  G('any', 'away#Olen Zellweger', 1, 'marcou'); G('any', 'away#Zach Benson', -1, 'jogou e não marcou'); G('any', 'away#Tage Thompson', 0, 'não foi a jogo → devolvida');
  G('n3', 'home#Macklin Celebrini', 1, '3 gols'); G('n2', 'away#Olen Zellweger', 1, '2 gols'); G('n3', 'away#Olen Zellweger', -1, 'só 2');
  G('first', 'home#Macklin Celebrini', 1, 'primeiro gol'); G('last', 'away#Olen Zellweger', -1, 'último gol foi do Celebrini');
  G('any', 'away#Ryan Zellweger', null, 'mesmo apelido, outra inicial → equipa');
  eq({ market: 'hgs', per: 'any|1', pick: 'away#Olen Zellweger' }, reg, null, 'hóquei marcadores: sem a ESPN → equipa');
  // dados reais
  const Rs = [];
  for (const r of HD.results) { const R = FEED.parseResult(r, 'hockey'); if (R?.done) { const { done, finishedAt, note, ...x } = R; Rs.push(x); } }
  Rs.push(reg, ot, so);
  const withOrder = Rs.filter((R) => R.gorder).length;
  let mks = 0, sels = 0;
  for (const m of HD.matches) {
    const ev = FEED.toEvent(m, Date.now(), 'hockey', true);
    if (!ev?.markets) continue;
    const xs = ev.markets.filter((mk) => mk.k === 'x').map((mk) => mk.name);
    check(!xs.length, `hóquei 100% automático: ${ev.home.name} tem mercados da equipa (${xs.join(', ')})`);
    const S = M.selections({ ...ev, date: new Date(ev.date) }).filter((s) => !['hgs', 'x'].includes(s.market));
    sels += S.length;
    const by = new Map();
    for (const s of S) {
      const pk = String(s.pick), base = pk.replace(/^!/, '');
      const twin = s.market === 'pcond' && S.some((o) => o !== s && o.per === s.per && String(o.pick).replace(/^!/, '') === base);
      const k = s.market === 'pspr' || s.market === 'spread' ? `${s.market}|${s.per}|${pk === 'home' ? s.line : -s.line}`
        : s.market === 'pteam' ? `${s.market}|${s.per}|${pk.split(':')[0]}|${s.line}`
          : s.market === 'hng' ? `hng|${s.per}|${pk.split(':')[0]}`
            : s.market === 'pcond' ? `pcond|${s.per}${twin ? '|' + base : ''}`
              : `${s.market}|${s.per ?? ''}|${s.line ?? ''}`;
      if (!by.has(k)) by.set(k, []); by.get(k).push(s);
    }
    for (const list of by.values()) {
      mks++;
      for (const R of Rs) {
        // pênaltis sem vencedor na fonte (alts): vale o que der igual nos dois casos, como em settleLeg
        const one = (s) => { const L = { market: s.market, pick: s.pick, line: s.line, per: s.per }; if (!R.alts) return M.legOutcome(L, R); const v = R.alts.map(([h, a]) => M.legOutcome(L, { ...R, h, a, alts: null })); return v.every((x) => x === v[0]) ? v[0] : null; };
        const outs = list.map(one);
        if (outs.every((x) => x == null) || ['dcr', 'pdc'].includes(list[0].market)) continue; // a equipa decide · dupla chance tem 2 vencedores (ex.: placar exato num jogo com prorrogação)
        const wins = outs.filter((x) => x === 1).length;
        const exactish = ['pcs', 'pcond'].includes(list[0].market); // placares/margens/faixas que a bet365 não lista todos
        const ok = !outs.some((x) => x == null) && (wins === 1 || list.length === 1 || (exactish && wins === 0) || outs.every((x) => x === 0) || (list[0].market === 'pml2' && outs.every((x) => x === 0)));
        check(ok, `hóquei real: ${list[0].marketName} → ${list.map((s, i) => `${s.name}=${outs[i]}`).join(' | ')} (${R.h}-${R.a}${R.so ? ' pên.' : ''} reg ${R.reg})`);
      }
    }
  }
  check(withOrder > 50, `hóquei: ordem dos gols só em ${withOrder} resultados`);
  console.log(`  hóquei: ${sels} seleções reais em ${mks} mercados, ${Rs.length} resultados (${withOrder} com a ordem dos gols)`);
}

/* ================= 4) partidas reais de ténis (MoviOdds) ================= */
async function realTennis() {
  const F = require(path.join(__dirname, '..', 'feeds', 'moviodds.js'));
  const day = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  let n = 0, withLog = 0, retired = 0, retAuto = 0;
  for (const d of [1, 2]) {
    const r = await (await fetch(`https://moviodds.com/results?sport=tennis&stats=1&date=${day(d)}`, { signal: AbortSignal.timeout(60000) })).json();
    for (const x of (r.results || []).filter((y) => !/^(UTR|Esports|E-)/i.test(y.league))) {
      // mesma leitura do servidor (sem pedir de novo à fonte)
      let R = null;
      try { R = F.parseResult(x, 'tennis'); } catch (e) { check(false, `leitura do resultado ${x.fixture_id}: ${e.message}`); continue; }
      if (!R.done) { retired++; continue; }
      // desistência: o que se jogou é liquidado, o resto devolvido — vencedor e placar em sets nunca se decidem aqui
      if (R.retired) {
        retAuto++;
        const tag = `desistência ${x.home} x ${x.away} ${x.final_score}`;
        check(M.legOutcome({ market: 'ml', pick: 'home' }, R) === 0 && M.legOutcome({ market: 'ml', pick: 'away' }, R) === 0, `${tag}: vencedor devolvido`);
        const last = R.sets.length;
        if (!(Math.max(...R.sets[last - 1]) >= 6)) check(M.legOutcome({ market: 'tsw', pick: 'home', per: String(last) }, R) === 0, `${tag}: set a meio devolvido`);
        R.log.forEach((e) => check(M.legOutcome({ market: 'tgw', pick: e.w, per: `${e.s}/${e.g}` }, R) === 1, `${tag}: game jogado ${e.s}/${e.g} liquidado`));
        continue;
      }
      n++; if (R.log) withLog++;
      tennisCross(R, `real ${x.home} x ${x.away} ${x.final_score}`);
    }
  }
  console.log(`  partidas reais: ${n} terminadas normalmente (${withLog} com histórico game a game), ${retAuto} desistências liquidadas pelo que se jogou, ${retired} paradas sem dados seguros (ficam para a equipa)`);
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
