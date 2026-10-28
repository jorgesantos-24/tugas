'use strict';
/* Testes do ténis: pontos (feeds/points.js), mercados de pontos (markets.js), leitura das cotações (feeds/tennis.js)
   e proteção das odds (guardTennis). Uso: npm run testar:tenis   (com internet testa também a oferta atual da MoviOdds)
   1) reconstrução dos pontos com casos feitos à mão (correções, pontos perdidos, deuce, tie-break)
   2) resultado de cada mercado de pontos e dos novos de aces/quebras, e "sem dados → devolvida"
   3) leitura das cotações: lados certos qualquer que seja a ordem do placar na fonte
   4) proteção: bloqueia odds impossíveis, lados trocados e cotações paradas; não bloqueia odds boas
   5) gravação real (28/10, 57 jogos, 1708 placares) confrontada com o resumo oficial de cada jogo
   6) oferta atual da MoviOdds: todas as cotações de ténis lidas, nenhuma odd boa bloqueada, trocas apanhadas
   7) mercados da partida pagos antes do fim (ex.: 1-1 em sets: "3 sets" ganha), melhor de 5 e desistência entre sets */

const path = require('path');
const fs = require('fs');
process.env.MOVIODDS_WS = '0'; process.env.NO_EXTERNAL = '1';
const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'feeds', 'points.js'));
const TEN = require(path.join(ROOT, 'feeds', 'tennis.js'));
const M = require(path.join(ROOT, 'public', 'markets.js'));

let ok = 0, bad = 0;
const check = (cond, msg) => { if (cond) ok++; else { bad++; console.log('  ✘', msg); } };
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}\n      veio   ${JSON.stringify(a)}\n      queria ${JSON.stringify(b)}`);
const obs = (list, step = 10, t0 = 0) => list.map((x, i) => { const [h, a] = x.split('-'); return { h, a, t: (t0 + i * step) * 1000, t2: (t0 + i * step) * 1000 }; });

/* ================= 1) pontos ================= */
function points() {
  console.log('\n1) reconstrução dos pontos');
  let r = P.resolveGame({ w: 'home', srv: 'home', lp: 30 }, obs(['0-0', '15-0', '15-15', '30-15', '30-30', '40-30']), 60000);
  eq(r.seq, ['home', 'away', 'home', 'away', 'home', 'home'], 'game visto ponto a ponto');
  eq([r.k, r.n, r.bp], [6, 6, false], 'posições seguras, total e break point');
  r = P.resolveGame({ w: 'home', srv: 'home', lp: 30 }, obs(['0-0', '15-0', '30-15', '40-30']), 60000);
  eq([r.seq[0], r.seq[1], r.seq[2]], ['home', null, null], 'ponto perdido com os dois a subir: ordem desconhecida só nessas posições');
  r = P.resolveGame({ w: 'home', srv: 'home', lp: 15 }, obs(['0-0', '30-0', '30-15']), 60000);
  eq(r.seq, ['home', 'home', 'away', 'home', 'home'], 'ponto perdido de um lado só: ordem certa');
  r = P.resolveGame({ w: 'away', srv: 'home', lp: 0 }, obs(['0-0', '15-0', '0-0', '0-15', '0-30', '0-40']), 60000);
  eq(r.seq, ['away', 'away', 'away', 'away'], 'correção da bet365 (15-0 → 0-0): vale o mais recente');
  eq(r.bp, true, 'quebra de saque = houve break point');
  r = P.resolveGame({ w: 'away', srv: 'away', lp: 0 }, [], null);
  eq([r.seq, r.bp], [['away', 'away', 'away', 'away'], false], 'game a zero sem nada gravado: sabe-se tudo pelo resumo');
  r = P.resolveGame({ w: 'home', srv: 'home', lp: 15 }, [], null);
  eq([r.seq.filter(Boolean).length, r.n], [0, 5], 'sem gravação e não foi a zero: ordem desconhecida, total sabido');
  r = P.resolveGame({ w: 'home', srv: 'home', lp: 40 }, obs(['0-0', '15-0', '30-0', '40-0', '40-15', '40-30', '40-40', '40-A', '40-40', 'A-40']), 100000);
  eq([r.k, r.n, r.seq.length, r.bp], [10, 10, 10, true], 'deuce visto depressa: sequência inteira, vantagem de quem recebe = break point');
  r = P.resolveGame({ w: 'home', srv: 'home', lp: 40 }, obs(['0-0', '15-0', '30-0', '40-0', '40-15', '40-30', '40-40', 'A-40'], 40), 400000);
  eq([r.k, r.n, r.bp], [6, null, null], 'deuce visto devagar: só os 6 primeiros pontos são seguros');
  const o = obs(['0-0', '15-0', '30-0', '40-0', '40-15', '40-30', '40-40'], 5); o.push({ h: '40', a: '40', t: 200000, t2: 200000 });
  r = P.resolveGame({ w: 'home', srv: 'home', lp: 40 }, o, 210000);
  eq(r.k, 6, 'mesmo placar de deuce visto muito depois (podem ter sido 2 pontos): só 6 seguros');
  eq(P.resolveGame({ w: 'home', srv: 'home', lp: 15 }, obs(['0-0', '0-15', '0-30']), 30000), null, 'gravação que contradiz o resumo: rejeitada');
  eq(P.resolveGame({ w: 'home', srv: 'home', lp: 15 }, obs(['0-0', '7-3']), 30000), null, 'placar estranho num game normal: rejeitado');
  r = P.resolveTb({ tbScore: [7, 5] }, obs(['0-0', '1-0', '1-1', '2-1', '3-1', '3-2', '4-2', '4-3', '5-3', '5-4', '6-4', '6-5']));
  eq([r.n, r.k, r.seq.slice(0, 6)], [12, 12, ['home', 'away', 'home', 'home', 'away', 'home']], 'tie-break');
  r = P.resolveTb({ tbScore: [7, 5] }, obs(['0-0', '2-0', '1-0', '1-1']));
  eq(r.seq.slice(0, 2), ['home', 'away'], 'tie-break com correção da bet365');
  // gravação ao vivo: game novo que chega ainda com o placar do anterior
  P._matches.clear();
  const st = (sum, hg, ag, hp, ap) => ({ sport: 'tennis', current_set: 1, home: { games: hg, point: hp, serving: true }, away: { games: ag, point: ap }, summary: Array(sum).fill('') });
  let t = 0;
  for (const [s, hg, ag, hp, ap] of [[0, 0, 0, '0', '0'], [0, 0, 0, '15', '0'], [0, 0, 0, '30', '0'], [0, 0, 0, '40', '0'], [1, 0, 0, '40', '0'], [1, 1, 0, '0', '0'], [1, 1, 0, '0', '15'], [1, 1, 0, '0', '30'], [1, 1, 0, '0', '40']]) P.observe('t1', st(s, hg, ag, hp, ap), (t += 20) * 1000);
  const pts = P.resolve('t1', [{ s: 1, g: 1, w: 'home', srv: 'home', lp: 0 }, { s: 1, g: 2, w: 'away', srv: 'away', lp: 0 }]);
  eq([pts['1/1']?.seq, pts['1/2']?.seq], [['home', 'home', 'home', 'home'], ['away', 'away', 'away', 'away']], 'game novo com o placar do anterior na 1ª mensagem');
}

/* ================= 2) mercados ================= */
function markets() {
  console.log('2) resultado dos mercados');
  const log = [{ s: 1, g: 1, w: 'home', srv: 'home', lp: 30 }, { s: 1, g: 2, w: 'away', srv: 'away', lp: 0 }, { s: 1, g: 3, w: 'away', srv: 'home', lp: 40 }];
  const R = { h: 0, a: 0, sets: [[6, 4]], log, aces: [7, 4], dfs: [1, 2], pts: {
    '1/1': P.resolveGame(log[0], obs(['0-0', '15-0', '15-15', '30-15', '30-30', '40-30']), 60000),
    '1/2': P.resolveGame(log[1], [], null),
    '1/3': P.resolveGame(log[2], obs(['0-0', '15-0', '30-0', '40-0', '40-15', '40-30', '40-40', 'A-40'], 40), 400000),
  } };
  const L = (market, per, pick, line) => M.legOutcome({ market, per, pick, line }, R);
  eq(L('tg1p', '1/1', 'home'), 1, '1º ponto ganha'); eq(L('tg1p', '1/1', 'away'), -1, '1º ponto perde');
  eq(L('tgsa', '1/1:2', '1-1'), 1, 'placar 15-15 após 2 pontos'); eq(L('tgsa', '1/1:3', '2-1'), 1, '30-15 após 3'); eq(L('tgsa', '1/1:4', '2-2'), 1, '30-30 após 4');
  eq(L('tgsa', '1/1:2', '2-0'), -1, 'placar errado perde');
  eq(L('tgsa', '1/2:4', '0-4'), 1, 'fora ganha a zero após 4 pontos'); eq(L('tgsa', '1/2:4', '4-0'), -1, 'lados não se trocam');
  eq(L('tgpb', '1/1', 'away', 2), 1, 'ponto a ponto: ponto 2'); eq(L('tgpb', '1/1', 'home', 6), 1, 'ponto 6');
  eq(L('tgbp', '1/1', 'no'), 1, 'sem break point'); eq(L('tgbp', '1/3', 'yes'), 1, 'quebra = break point');
  eq(L('tgtp', '1/1', '6'), 1, 'total 6 pontos'); eq(L('tgtp', '1/2', '4'), 1, 'total 4 pontos'); eq(L('tgtp', '1/3', 'over'), 1, 'deuce = mais de 6');
  eq(L('tgpb', '1/3', 'home', 7), 0, 'ponto do deuce sem forma de saber: devolvida');
  eq(L('tgsa', '1/5:2', '1-1'), 0, 'game não jogado: devolvida');
  eq(L('tfsa', 'away:4', '0-4'), 1, '1º game de serviço de fora: a zero'); eq(L('tfstp', 'home', '6'), 1, '1º game de serviço da casa: 6 pontos');
  eq(L('tfsbp', 'home', 'no'), 1, '1º game de serviço: sem break point'); eq(L('tfsbp', 'away', 'no'), 1, 'idem fora (a zero)');
  eq(L('tace', 'all', '10', 10), 1, 'aces da partida (7+4 ≥ 10)'); eq(L('tace', 'all', '12', 12), -1, 'aces da partida (11 < 12)');
  eq(L('tdf', 'all', '3', 3), 1, 'duplas faltas da partida'); eq(L('tace', 'home', '7', 7), 1, 'aces de um jogador continua igual');
  eq(L('tsbt', '1', 'over', 0.5), 1, 'quebras no 1º set: mais de 0,5'); eq(L('tsbt', '1', 'under', 1.5), 1, 'menos de 1,5');
  eq(L('tsbt', '2', 'over', 0.5), 0, 'set não jogado: devolvida');
  // sem pontos calculados (R.pts ausente): espera, não devolve
  eq(M.legOutcome({ market: 'tg1p', per: '1/1', pick: 'home' }, { ...R, pts: undefined }), null, 'sem pontos calculados: fica à espera');
  eq(M.legOutcome({ market: 'tg1p', per: '1/1', pick: 'home' }, { ...R, pts: {} }), 0, 'pontos calculados mas game sem dados: devolvida');
  // tie-break
  const tbLog = [...Array(12)].map((_, i) => ({ s: 1, g: i + 1, w: i % 2 ? 'away' : 'home', srv: i % 2 ? 'away' : 'home', lp: 15 })).concat([{ s: 1, g: 13, w: 'home', tb: true, tbScore: [7, 5] }]);
  const R2 = { sets: [[7, 6]], log: tbLog, pts: { '1/13': P.resolveTb({ tbScore: [7, 5] }, obs(['0-0', '1-0', '1-1', '2-1', '3-1', '3-2', '4-2'])) } };
  const L2 = (market, per, pick, line) => M.legOutcome({ market, per, pick, line }, R2);
  eq(L2('ttbtp', '1', 'over', 11.5), 1, 'tie-break: total de pontos'); eq(L2('ttbs', '1', '7-5'), 1, 'tie-break: placar exato');
  eq(L2('ttbsa', '1:6', '4-2'), 1, 'tie-break: placar após 6'); eq(L2('ttblead', '1:6', 'home'), 1, 'tie-break: quem lidera após 6');
  eq(L2('ttbpb', '1', 'away', 2), 1, 'tie-break: ponto 2'); eq(L2('ttbtp', '2', 'over', 11.5), 0, 'tie-break de set não jogado: devolvida');
  eq(M.legOutcome({ market: 'ttbtp', per: 'M', pick: 'over', line: 16.5 }, R2), 0, 'sem super tie-break: devolvida');
  const R3 = { sets: [[6, 4], [4, 6], [1, 0]], log: [{ s: 3, g: 1, w: 'home', tb: true, tbScore: [10, 8] }], pts: {} };
  eq(M.legOutcome({ market: 'ttbtp', per: 'M', pick: 'over', line: 16.5 }, R3), 1, 'super tie-break 10-8: mais de 16,5');
}

/* ================= 3) leitura das cotações ================= */
function quotes() {
  console.log('3) leitura das cotações (lados e formatos)');
  const m = { home: 'Ana Casa', away: 'Bia Fora', in_play: true };
  const Q = (group_name, label, side, line, extra = {}) => TEN.quote({ group_name, label, side, line, ...extra }, m);
  // placar após N pontos de um game: casa-fora
  eq(Q('Set 2 - Game 6 Score After 2 Points', '0-30', 'Bia Fora'), { k: 'tgsa', per: '2/6:2', pick: '0-2' }, 'game: "0-30 Bia" = fora a 30');
  eq(Q('Set 2 - Game 6 Score After 3 Points', '30-15', 'Ana Casa'), { k: 'tgsa', per: '2/6:3', pick: '2-1' }, 'game: "30-15 Ana" = casa a 30');
  eq(Q('Set 2 - Game 6 Score After 2 Points', '15-15', 'Tie'), { k: 'tgsa', per: '2/6:2', pick: '1-1' }, 'game: empate');
  eq(Q('Set 2 - Game 6 Score After 4 Points', 'Win to love', 'Bia Fora'), { k: 'tgsa', per: '2/6:4', pick: '0-4' }, 'game: fora a zero');
  // 1º game de serviço: quem serve primeiro no texto — o resultado tem de ser o mesmo
  eq(Q('First Bia Fora Service Game – First 2 Points', '30-0', 'Bia Fora'), { k: 'tfsa', per: 'away:2', pick: '0-2' }, '1º serviço (servidor primeiro): "30-0 Bia" = fora a 30');
  eq(Q('First Bia Fora Service Game – First 4 Points', 'Lose to Love', 'Ana Casa'), { k: 'tfsa', per: 'away:4', pick: '4-0' }, '"Lose to Love" = quem recebe ganha a zero');
  eq(Q('First Ana Casa Service Game – Total Points', 'Over 6 points'), { k: 'tfstp', per: 'home', pick: 'over' }, '1º serviço: total de pontos');
  eq(Q('First Ana Casa Service Game – Yes/No', undefined, 'Yes', 'Break Point'), { k: 'tfsbp', per: 'home', pick: 'yes' }, '1º serviço: break point');
  eq(Q('Set 1 - Game 3 1st Point', 'Bia Fora (Svr)'), { k: 'tg1p', per: '1/3', pick: 'away' }, '1º ponto (com "(Svr)")');
  eq(Q('Point Betting - Set 1 Game 3', undefined, 'Ana Casa (Svr)', '2'), { k: 'tgpb', per: '1/3', pick: 'home', line: 2 }, 'ponto a ponto');
  eq(Q('Point Betting - Set 1 Game 3', undefined, 'Ana Casa', '7'), null, 'ponto a ponto do 7º ponto (deuce): não se oferece');
  eq(Q('Point Betting - Set 1 Game 3', 'Ana Casa', 'Ana Casa', ''), null, 'ponto a ponto sem número: não se oferece');
  eq(Q('Set 1 - Game 3 To Have Break Point', 'Yes'), { k: 'tgbp', per: '1/3', pick: 'yes' }, 'break point no game');
  eq(Q('Set 1 - Game 3 Total Points', '5 points'), { k: 'tgtp', per: '1/3', pick: '5' }, 'total de pontos do game');
  eq(Q('Set 2 Tie Break Score after 6 Points', undefined, 'Bia Fora', '5-1'), { k: 'ttbsa', per: '2:6', pick: '1-5' }, 'tie-break: "5-1 Bia" = fora a 5');
  eq(Q('Match Tie Break Score after 6 Points', undefined, undefined, '3-3'), { k: 'ttbsa', per: 'M:6', pick: '3-3' }, 'super tie-break: empate');
  eq(Q('Point Betting – Match Tie Break', 'Pt 14 - Bia Fora (Svr)'), { k: 'ttbpb', per: 'M', pick: 'away', line: 14 }, 'super tie-break: ponto 14');
  eq(Q('Set 1 Tie Break - Total Points', 'Over', 'Over', '12.5', { handicap: '12.5' }), { k: 'ttbtp', per: '1', pick: 'over', line: 12.5 }, 'tie-break: total');
  eq(Q('Set 1 Tie Break Score', undefined, 'Ana Casa', 'Any Other'), { k: 'ttbs', per: '1', pick: null }, '"Any Other": sem escolha (não se oferece)');
  eq(Q('Ace Totals', undefined, 'Match', '15+'), { k: 'tace', per: 'all', pick: '15', line: 15 }, 'aces da partida');
  eq(Q('Total Breaks of Serve', '7.5', 'Over', 'Match', { handicap: '7.5' }), { k: 'tbrk', pick: 'over', line: 7.5 }, 'quebras na partida');
  eq(Q('First Set - Total Breaks of Serve', '3.5', 'Under', 'Set', { handicap: '3.5' }), { k: 'tsbt', per: '1', pick: 'under', line: 3.5 }, 'quebras no 1º set');
  eq(Q('Go The Distance?', 'Yes'), null, 'set decisivo ao vivo: não se oferece (fonte errada)');
  eq(TEN.quote({ group_name: 'Go The Distance?', label: 'Yes' }, { ...m, in_play: false }), null, 'set decisivo antes do jogo: também não (fonte errada)');
  eq(Q('Next Break of Serve', 'Ana Casa'), null, 'próxima quebra: não se oferece');
}

/* ================= 4) proteção das odds ================= */
const mkt = (k, sels, per) => ({ k, ...(per ? { per } : {}), sels: sels.map(([pick, odds, line]) => ({ pick, odds, lock: false, ...(line != null ? { line } : {}) })) });
const locked = (mk) => mk.sels.every((x) => x.lock);
const open = (mk) => mk.sels.every((x) => !x.lock);
function guard() {
  console.log('4) proteção das odds');
  // Djokovic x Humbert 28/10 (4-6, 4-1)
  let b = new Map([['ml', mkt('ml', [['home', 1.44], ['away', 2.75]])], ['sets', mkt('sets', [['2-1', 1.44], ['1-2', 3.1], ['0-2', 15]])], ['tdist', mkt('tdist', [['no', 1.22], ['yes', 4]])], ['tsets', mkt('tsets', [['2', 9], ['3', 1.06]])]]);
  TEN.guardTennis(b);
  check(locked(b.get('tdist')), 'Djokovic: "set decisivo" errado bloqueado');
  check(open(b.get('tsets')) && open(b.get('ml')) && open(b.get('sets')), 'Djokovic: os mercados certos continuam abertos');
  // vencedor com os lados trocados
  b = new Map([['ml', mkt('ml', [['home', 2.75], ['away', 1.44]])], ['sets', mkt('sets', [['2-1', 1.44], ['1-2', 3.1], ['0-2', 15]])]]);
  TEN.guardTennis(b);
  check(locked(b.get('ml')) && locked(b.get('sets')), 'vencedor trocado em relação ao placar em sets: os dois bloqueados');
  // odds impossíveis (lucro garantido)
  b = new Map([['tgd|1/3', mkt('tgd', [['yes', 2.2], ['no', 2.2]], '1/3')], ['gtotal', mkt('gtotal', [['over', 2.1, 21.5], ['under', 2.05, 21.5], ['over', 1.5, 19.5], ['under', 2.5, 19.5]])]]);
  TEN.guardTennis(b);
  check(locked(b.get('tgd|1/3')), 'sim/não com lucro garantido: bloqueado');
  const gt = b.get('gtotal').sels;
  check(gt[0].lock && gt[1].lock && !gt[2].lock && !gt[3].lock, 'mais/menos: só a linha impossível bloqueia');
  // vencedor do set × placar do set; vencedor do game × placar do game; 1º ponto × ponto 1
  b = new Map([['tsw|2', mkt('tsw', [['home', 1.3], ['away', 3.4]], '2')], ['tscs|2', mkt('tscs', [['6-2', 4], ['6-3', 4], ['6-4', 5], ['7-5', 9], ['3-6', 12], ['4-6', 10], ['5-7', 15], ['7-6', 8], ['6-7', 14]], '2')]]);
  TEN.guardTennis(b);
  check(open(b.get('tsw|2')), 'vencedor do set coerente com o placar do set: aberto');
  b.get('tsw|2').sels.forEach((x) => { x.pick = x.pick === 'home' ? 'away' : 'home'; x.lock = false; });
  TEN.guardTennis(b);
  check(locked(b.get('tsw|2')), 'vencedor do set trocado: bloqueado');
  b = new Map([['tgw|1/5', mkt('tgw', [['home', 1.2], ['away', 4.2]], '1/5')], ['tgs|1/5', mkt('tgs', [['home:0', 4], ['home:15', 3.6], ['home:30', 4.3], ['home:40', 5], ['away:0', 41], ['away:15', 21], ['away:30', 15], ['away:40', 11]], '1/5')]]);
  TEN.guardTennis(b);
  check(open(b.get('tgw|1/5')), 'vencedor do game coerente: aberto');
  b.get('tgw|1/5').sels.reverse().forEach((x, i) => { x.pick = i ? 'away' : 'home'; });
  TEN.guardTennis(b);
  check(locked(b.get('tgw|1/5')), 'vencedor do game trocado: bloqueado');
  b = new Map([['tg1p|1/5', mkt('tg1p', [['home', 1.5], ['away', 2.5]], '1/5')], ['tgpb|1/5', mkt('tgpb', [['home', 2.5, 1], ['away', 1.5, 1], ['home', 1.6, 2], ['away', 2.3, 2]], '1/5')]]);
  TEN.guardTennis(b);
  check(locked(b.get('tg1p|1/5')) && b.get('tgpb|1/5').sels.filter((x) => x.line === 1).every((x) => x.lock), '1º ponto trocado em relação ao ponto a ponto: bloqueado');
  check(b.get('tgpb|1/5').sels.filter((x) => x.line === 2).every((x) => !x.lock), 'o ponto 2 continua aberto');
  // placar em sets suspenso: set decisivo e total de sets sem referência
  b = new Map([['sets', { k: 'sets', sels: [{ pick: '2-0', odds: 1.8, lock: true }, { pick: '2-1', odds: 4 }, { pick: '1-2', odds: 6 }, { pick: '0-2', odds: 5 }] }], ['tsets', mkt('tsets', [['2', 1.3], ['3', 3.4]])]]);
  TEN.guardTennis(b);
  check(locked(b.get('tsets')), 'placar em sets suspenso: total de sets bloqueado');
  b = new Map([['tsets', mkt('tsets', [['2', 1.33], ['3', 3.25]])]]); TEN.guardTennis(b, false);
  check(open(b.get('tsets')), 'antes do jogo, sem placar em sets: total de sets aberto');
  b = new Map([['tsets', mkt('tsets', [['2', 1.33], ['3', 3.25]])]]); TEN.guardTennis(b, true);
  check(locked(b.get('tsets')), 'ao vivo, sem placar em sets: total de sets bloqueado');
  b = new Map([['tsets', mkt('tsets', [['2', 1.44], ['3', 2.63]])], ['tstraight', mkt('tstraight', [['yes', 1.44], ['no', 2.63]])]]); TEN.guardTennis(b, true);
  check(open(b.get('tsets')) && open(b.get('tstraight')), 'ao vivo sem placar em sets: total de sets confirmado pelo "vence sem perder set"');
  b = new Map([['tsets', mkt('tsets', [['2', 2.63], ['3', 1.44]])], ['tstraight', mkt('tstraight', [['yes', 1.44], ['no', 2.63]])]]); TEN.guardTennis(b, true);
  check(locked(b.get('tsets')) && locked(b.get('tstraight')), 'total de sets trocado em relação ao "vence sem perder set": saem os dois');
}

/* ================= 5) gravação real ================= */
function recording() {
  console.log('5) gravação real (28/10) × resumo oficial');
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'dados', 'tenis-pontos-28-10.json'), 'utf8'));
  P._matches.clear();
  for (const j of d.jogos) for (const [t, set, hp, ap, hg, ag, sv, nsum] of j.obs) {
    P.observe(j.id, { sport: 'tennis', current_set: set, home: { point: hp, games: hg, serving: sv === 1 }, away: { point: ap, games: ag, serving: sv === 2 }, summary: Array(nsum).fill('') }, t);
  }
  const c = { jogos: 0, games: 0, coerentes: 0, completos: 0, bp: 0 };
  for (const j of d.jogos) {
    const sets = j.stats.home.sets.map((v, i) => [Number(v), Number(j.stats.away.sets[i])]);
    const log = TEN.gameLog(j, sets);
    if (!log) continue;
    c.jogos++;
    const G = P._matches.get(j.id)?.games || {};
    const pts = P.resolve(j.id, log);
    log.forEach((e, i) => {
      if (!G[i + 1]?.obs.length) return;
      c.games++;
      const p = pts[`${e.s}/${e.g}`];
      check(!!p, `jogo ${j.home} x ${j.away}, set ${e.s} game ${e.g}: gravação incoerente com o resumo`);
      if (!p) return;
      c.coerentes++;
      if (p.k === p.seq.length && p.seq.every(Boolean)) {
        c.completos++;
        // a sequência inteira bate com o resumo: vencedor e pontos do adversário (ou placar do tie-break)
        const won = p.seq.filter((x) => x === e.w).length, lost = p.seq.length - won;
        if (e.tb) check(won === Math.max(...e.tbScore) && lost === Math.min(...e.tbScore), `tie-break ${j.home}: placar`);
        else if (e.lp < 40) check(won === 4 && lost === e.lp / 15, `${j.home} s${e.s}g${e.g}: pontos do adversário`);
        else check(won - lost === 2, `${j.home} s${e.s}g${e.g}: deuce acaba com 2 de vantagem`);
      }
      if (p.bp != null) { c.bp++; if (e.w !== e.srv && e.srv && !e.tb) check(p.bp === true, `${j.home} s${e.s}g${e.g}: quebra sem break point`); }
    });
  }
  console.log(`   ${c.jogos} jogos · ${c.games} games gravados · ${c.coerentes} coerentes com o resumo · ${c.completos} com a sequência inteira · ${c.bp} com break point decidido`);
  check(c.games >= 200, 'gravação real tem pelo menos 200 games');
}

/* ================= 6) oferta atual da MoviOdds ================= */
async function live() {
  console.log('6) oferta atual da MoviOdds (internet)');
  const F = require(path.join(ROOT, 'feeds', 'moviodds.js'));
  let lists;
  try {
    lists = await Promise.all(['https://moviodds.com/odds?sport=tennis&in_play=1&stats=1', 'https://moviodds.com/odds?sport=tennis'].map(async (u) => (await fetch(u, { signal: AbortSignal.timeout(60000) })).json()));
  } catch (e) { console.log(`   sem internet / fonte em baixo (${e.message}): parte 6 não corre`); return; }
  let mk = 0, guarded = 0, swaps = 0, caught = 0, small = 0, arb = 0;
  const kinds = {}, guardedEx = [];
  for (const j of lists) for (const m of j.matches) {
    const ev = F.toEvent(m, Date.parse(j.server_time || j.generated_at) || Date.now(), 'tennis', true);
    if (!ev?.markets) continue;
    for (const x of ev.markets) {
      mk++; kinds[x.k] = (kinds[x.k] || 0) + 1;
      if (x.sels.some((s) => s.guard)) { guarded++; if (guardedEx.length < 5) guardedEx.push(`${m.home} x ${m.away} ${x.k} ${x.sels.map((s) => `${s.pick}@${s.odds}`).join(' ')}`); }
      // antes do jogo (de facto: sem placar ao vivo) nada de bom deve ficar bloqueado; o que bloquear é mostrado
    }
    // trocas simuladas: para cada mercado vigiado, trocar os lados e ver se a proteção apanha
    const base = new Map(ev.markets.filter((x) => !x.sels.some((s) => s.lock)).map((x) => [x.per != null ? `${x.k}|${x.per}` : x.k, x]));
    for (const [key, x] of base) {
      if (!['ml', 'tsw', 'tgw', 'tg1p'].includes(x.k) || x.sels.length !== 2) continue;
      const partner = x.k === 'ml' ? 'sets' : x.k === 'tsw' ? `tscs|${x.per}` : x.k === 'tgw' ? `tgs|${x.per}` : `tgpb|${x.per}`;
      if (!base.has(partner)) continue;
      const pr = (1 / x.sels.find((s) => s.pick === 'home').odds) / x.sels.reduce((q, s) => q + 1 / s.odds, 0);
      const copy = new Map([...base].map(([k, v]) => [k, { ...v, sels: v.sels.map((s) => ({ ...s, lock: false, guard: false })) }]));
      copy.get(key).sels.forEach((s) => { s.pick = s.pick === 'home' ? 'away' : 'home'; });
      TEN.guardTennis(copy);
      const hit = copy.get(key).sels.every((s) => s.lock);
      if (Math.abs(1 - 2 * pr) > 2 * TEN.GUARD_DIFF + 0.02) { swaps++; if (hit) caught++; else console.log(`  ✘ troca não apanhada: ${m.home} x ${m.away} ${key} (prob. ${pr.toFixed(2)})`); }
      else small++;
    }
  }
  guarded = F.guardRemoved.length;
  arb = F.guardRemoved.filter((x) => x.includes('[pré]')).length;
  F.guardRemoved.filter((x) => x.includes('[pré]')).forEach((x) => console.log(`     antes do jogo tirado: ${x}`));
  console.log(`   ${mk} mercados automáticos · ${Object.keys(kinds).length} tipos · ${guarded} tirados do site pela proteção`);
  F.guardRemoved.slice(0, 8).forEach((x) => console.log(`     tirado: ${x}`));
  guardedEx.forEach((x) => console.log(`     bloqueado: ${x}`));
  console.log(`   trocas de lados simuladas: ${caught}/${swaps} apanhadas (mais ${small} quase 50/50, onde trocar muda pouco a odd)`);
  check(arb === 0, `antes do jogo a proteção não deve bloquear odds boas (${arb} bloqueados)`);
  check(caught === swaps, 'todas as trocas de lados com efeito na odd são apanhadas');
}

/* ================= 7) liquidação antecipada da partida e melhor de 5 ================= */
function earlyMatch() {
  console.log('7) mercados da partida antes do fim · melhor de 5');
  let T = 0, st = null;
  const ev = { id: 'e1', sport: 'tennis', state: 'in', home: { name: 'Ana Casa', score: 0 }, away: { name: 'Bia Fora', score: 0 }, markets: [{ k: 'ml', sels: [{ pick: 'home', odds: 1.5, lock: false }] }], date: new Date(0) };
  const events = new Map([['e1', ev]]);
  const E = require(path.join(ROOT, 'early.js'))({ M, TEN, events, liveStats: () => st, now: () => T, POINTS: P });
  let n = 0;
  // devolve o resultado se ficar decidido (pede duas vezes com 3 min de intervalo, como as salvaguardas exigem)
  const run = (sets, market, pick, extra = {}, format = 'best_of_3') => {
    st = { sport: 'tennis', format, home: { sets: sets.map((x) => x[0]), aces: 6, double_faults: 1 }, away: { sets: sets.map((x) => x[1]), aces: 4, double_faults: 2 }, summary: [] };
    const leg = { market, pick, evId: 'e1', key: `k${++n}`, ...extra };
    E.check('b', leg); T += 200000; E.check('b', leg); T += 200000;
    return leg.result || null;
  };
  // o exemplo: 1-1 em sets, 3º set a decorrer
  const s11 = [[6, 4], [3, 6], [2, 1]];
  eq(run(s11, 'tsets', '3'), 'won', '1-1 em sets: "total de sets: 3" ganha já');
  eq(run(s11, 'tsets', '2'), 'lost', '1-1 em sets: "total de sets: 2" perde já');
  eq(run(s11, 'tstraight', 'yes'), 'lost', '1-1 em sets: "vence sem perder set" perde já');
  eq(run(s11, 'tpto', 'aset:yes', { per: 'away' }), 'won', '1-1 em sets: "Bia ganha pelo menos um set" ganha já');
  eq(run(s11, 'tpto', 'aset:yes', { per: 'home' }), 'won', 'idem Ana');
  eq(run(s11, 'ml', 'home'), null, '1-1 em sets: vencedor ainda por decidir');
  eq(run(s11, 'sets', '2-1'), null, '1-1 em sets: placar em sets ainda por decidir');
  eq(run(s11, 'tdr', 'away:W'), 'lost', '"Bia ganha o 1º set e a partida": Bia perdeu o 1º set → perde já');
  // 1-0 em sets
  const s10 = [[6, 4], [2, 1]];
  eq(run(s10, 'tsets', '3'), null, '1-0 em sets: total de sets por decidir');
  eq(run(s10, 'tpto', 'aset:yes', { per: 'home' }), 'won', '1-0: "Ana ganha pelo menos um set" ganha já');
  eq(run(s10, 'tpto', 'aset:yes', { per: 'away' }), null, '1-0: "Bia ganha pelo menos um set" por decidir');
  eq(run(s10, 'sets', '0-2'), 'lost', '1-0: placar 0-2 já impossível → perde');
  eq(run(s10, 'tcast', 'away:WW'), 'lost', '1-0: sequência "Bia V V" já impossível → perde');
  // sem formato da fonte: não se adianta
  eq(run(s11, 'tsets', '3', {}, null), null, 'sem o formato da partida: espera pelo fim');
  // melhor de 5 (Grand Slam)
  eq(run([[6, 4], [6, 3], [2, 2]], 'tsets', '3', {}, 'best_of_5'), null, 'melhor de 5 a 2-0: 3 sets ainda possível, por decidir');
  eq(run([[6, 4], [6, 3], [2, 2]], 'tstraight', 'yes', {}, 'best_of_5'), null, 'melhor de 5 a 2-0: "sem perder set" por decidir');
  eq(run([[6, 4], [3, 6], [1, 0]], 'tstraight', 'yes', {}, 'best_of_5'), 'lost', 'melhor de 5 a 1-1: "sem perder set" perde');
  eq(run([[6, 4], [3, 6], [6, 2], [1, 0]], 'tsets', '3', {}, 'best_of_5'), 'lost', 'melhor de 5 a 2-1: "3 sets" perde');
  eq(run([[6, 4], [3, 6], [6, 2], [1, 0]], 'tsets', '4', {}, 'best_of_5'), null, 'melhor de 5 a 2-1: "4 sets" por decidir');
  eq(run([[6, 4], [3, 6], [2, 6], [6, 1], [1, 0]], 'tsets', '5', {}, 'best_of_5'), 'won', 'melhor de 5 a 2-2: "5 sets" ganha');
  // contagens que só sobem
  const g22 = [[6, 4], [6, 6]];
  eq(run(g22, 'gtotal', 'over', { line: 21.5 }), 'won', '22 games: "mais de 21,5" ganha já');
  eq(run(g22, 'gtotal', 'under', { line: 21.5 }), 'lost', '22 games: "menos de 21,5" perde já');
  eq(run(g22, 'gtotal', 'over', { line: 22.5 }), null, '22 games: "mais de 22,5" por decidir');
  eq(run(g22, 'tace', '10', { per: 'all', line: 10 }), 'won', 'aces 6+4: "10 ou mais" ganha já');
  eq(run(g22, 'tace', '11', { per: 'all', line: 11 }), null, 'aces 10: "11 ou mais" por decidir');
  // resultado final: desistência entre sets num melhor de 5
  const F = require(path.join(ROOT, 'feeds', 'moviodds.js'));
  eq(F.tennisResult({ final_score: '6-4,3-6,6-2', stats: { format: 'best_of_5' } }).done, false, 'melhor de 5 parado a 2-1 (desistência entre sets): fica para a equipa');
  eq(F.tennisResult({ final_score: '6-4,3-6,6-2,6-3', stats: { format: 'best_of_5' } }).done, true, 'melhor de 5 acabado 3-1: liquida');
  eq(F.tennisResult({ final_score: '6-4,6-3', stats: { format: 'best_of_3' } }).done, true, 'melhor de 3 acabado 2-0: liquida');
  eq(F.tennisResult({ final_score: '6-4,6-3,6-2', stats: { format: 'best_of_3' } }).done, false, 'melhor de 3 com 3-0: placar impossível, equipa');
  eq(M.legOutcome({ market: 'tsets', pick: '4' }, { h: 3, a: 1, sets: [[6, 4], [3, 6], [6, 2], [6, 3]] }), 1, 'melhor de 5: total de sets 4');
  eq(M.legOutcome({ market: 'sets', pick: '3-1' }, { h: 3, a: 1, sets: [[6, 4], [3, 6], [6, 2], [6, 3]] }), 1, 'melhor de 5: placar em sets 3-1');
  // proteção: total de sets com 3 opções (melhor de 5)
  let b = new Map([['sets', mkt('sets', [['3-0', 3.5], ['3-1', 4], ['3-2', 6], ['2-3', 9], ['1-3', 12], ['0-3', 21]])], ['tsets', mkt('tsets', [['3', 2.55], ['4', 2.5], ['5', 4.3]])]]);
  TEN.guardTennis(b, false);
  check(open(b.get('tsets')), 'melhor de 5: total de sets coerente com o placar em sets fica');
  b = new Map([['sets', mkt('sets', [['3-0', 3.5], ['3-1', 4], ['3-2', 6], ['2-3', 9], ['1-3', 12], ['0-3', 21]])], ['tsets', mkt('tsets', [['3', 4.3], ['4', 2.5], ['5', 2.55]])]]);
  TEN.guardTennis(b, false);
  check(locked(b.get('tsets')), 'melhor de 5: total de sets trocado (3 ↔ 5) sai');
}

(async () => {
  console.log('Testes do ténis');
  points(); markets(); quotes(); guard(); recording(); earlyMatch();
  await live();
  console.log(`\n  ${ok} verificações certas · ${bad} erradas`);
  process.exit(bad ? 1 : 0);
})();
