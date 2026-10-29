'use strict';
/* Tênis de mesa (MoviOdds "table_tennis", decisão de 2026-10-28: todas as ligas, todos os mercados que se liquidam
   sozinhos, sem limites especiais). A bet365 chama "game" ao que no Brasil se diz "set" (partida à melhor de 5).

   O resultado da MoviOdds traz o placar de cada set ("11-8,3-11,11-9,14-16,10-12"): com ele decide-se tudo o que é
   vencedor, sets, pontos, handicaps, totais, margens e 10-10. Não se oferecem "Race To" (quem chega primeiro a N
   pontos), ponto a ponto, "quem lidera após N pontos" nem "set atual / próximo set" (precisam da ordem dos pontos ou
   do set em curso, que a fonte não dá com segurança: o placar ao vivo chega com 25-30 s de atraso).
   Ao vivo (decisão de 2026-10-29, como na bet365): os mesmos mercados por set e da partida; a aposta ao vivo espera
   uns segundos e cai se o placar mudar entretanto (server.js).

   Cotação → { k, per?, pick, line?, mname, name, cat }:
     ml (vencedor) · ttsh (handicap de sets) · ttpt (total de pontos) · ttph (handicap de pontos) · ttcs (placar em sets:
     per M = final, N = após N sets) · ttgw / ttgh / ttgt (vencedor / handicap / total de pontos do set N)
     · ttgwt (vencedor do set N + total) · ttgp (pontos de um jogador no set N; per "N:home") */

const num = (v) => { const m = /[+-]?\d+(?:\.\d+)?/.exec(String(v ?? '')); return m ? Number(m[0]) : NaN; };
// o número do primeiro campo que o tiver (a fonte às vezes manda handicap vazio e a linha no rótulo)
const numOf = (...vs) => { for (const v of vs) { const n = num(v); if (Number.isFinite(n)) return n; } return NaN; };
const half = (v) => Number.isFinite(v) && Math.abs((v * 2) % 2) === 1;
const ou = (s) => (/^\s*over\b/i.test(String(s ?? '')) ? 'over' : /^\s*under\b/i.test(String(s ?? '')) ? 'under' : null);
const fmt = (n) => (n > 0 ? `+${n}` : `${n}`);

// ao vivo: linhas de cabeçalho (sem market_id, odds 0) → tipo de cada market_id ("Winner", "Total", "Handicap (Games)"...)
const headCache = new WeakMap();
function headers(m) {
  const list = m.quotes || [];
  let h = headCache.get(list);
  if (!h) {
    h = new Map();
    for (const q of list) if (!q.market_id && q.sel_id && !(Number(q.odds_dec) > 1) && /^(Game \d|Match)$/.test(String(q.group_name ?? '').trim())) h.set(String(q.sel_id), String(q.label ?? '').trim());
    headCache.set(list, h);
  }
  return h;
}

function quote(q, m) {
  const g = String(q.group_name ?? '').trim(), line = String(q.line ?? '').trim();
  const who = (s) => { const t = String(s ?? '').trim(); return t === m.home ? 'home' : t === m.away ? 'away' : null; };
  const nm = (w) => (w === 'home' ? m.home : m.away);
  const o = (k, pick, mname, name, cat, extra = {}) => ({ k, pick, mname, name, cat, ...extra });
  let x;
  if (g === 'To Win Match') {
    const w = who(q.side);
    if (line === 'To Win') return w && { k: 'ml', pick: w };
    if (line === 'Line') { const l = numOf(q.handicap, q.label); return w && half(l) && o('ttsh', w, 'Handicap de sets', `${nm(w)} ${fmt(l)}`, 'hcp', { line: l }); }
    if (line === 'Total') { const p = ou(q.side), l = numOf(q.handicap, q.label); return p && half(l) && o('ttpt', p, 'Total de pontos da partida', `${p === 'over' ? 'Mais' : 'Menos'} de ${l}`, 'hcp', { line: l }); }
    return null;
  }
  if (g === 'Handicap Betting - Points') { const w = who(q.side), l = numOf(q.handicap, q.label); return w && half(l) && o('ttph', w, 'Handicap de pontos da partida', `${nm(w)} ${fmt(l)}`, 'hcp', { line: l }); }
  // placar em sets: final ("Game Betting") ou depois de 2 / 3 sets (antes do jogo: "after", placar em line; ao vivo é "After", mais abaixo)
  if (g === 'Game Betting' || (x = /^Correct Score after (\d) Games$/.exec(g))) {
    const n = x ? Number(x[1]) : null, sc = /^(\d)-(\d)$/.exec(String(q.line ?? q.label ?? '').trim());
    if (!sc) return null;
    const w = who(q.side);
    if (!w && sc[1] !== sc[2]) return null;
    const pick = w === 'away' ? `${sc[2]}-${sc[1]}` : `${sc[1]}-${sc[2]}`;
    const name = w ? `${nm(w)} ${sc[1]}-${sc[2]}` : `${sc[1]}-${sc[2]}`;
    return o('ttcs', pick, n ? `Placar após ${n} sets` : 'Placar exato em sets', name, 'sets', { per: n ? String(n) : 'M' });
  }
  if ((x = /^(\d)(?:st|nd|rd|th) Game$/.exec(g))) {
    const s = x[1], w = who(q.side), l = numOf(q.handicap, q.label);
    if (line === 'To Win') return w && o('ttgw', w, `Vencedor do ${s}º set`, nm(w), 'sets', { per: s });
    if (line === 'Line') return w && half(l) && o('ttgh', w, `Handicap de pontos do ${s}º set`, `${nm(w)} ${fmt(l)}`, 'sets', { per: s, line: l });
    if (line === 'Total') { const p = ou(q.side); return p && half(l) && o('ttgt', p, `Total de pontos do ${s}º set`, `${p === 'over' ? 'Mais' : 'Menos'} de ${l}`, 'sets', { per: s, line: l }); }
    return null;
  }
  if ((x = /^(\d)(?:st|nd|rd|th) Game Winner and Total Double$/.exec(g))) {
    const w = who(q.line), p = ou(q.side), l = numOf(q.handicap, q.label);
    return w && p && half(l) && o('ttgwt', `${w}:${p}`, `Vencedor do ${x[1]}º set e total de pontos`, `${nm(w)} e ${p === 'over' ? 'mais' : 'menos'} de ${l}`, 'sets', { per: x[1], line: l });
  }
  // ---- ao vivo (grupos sem ordinal: "Game 3", "Match"...) ----
  // "Game N" e "Match": o tipo de cada seleção está numa linha de cabeçalho (sel_id = market_id da seleção)
  if ((x = /^Game (\d)$/.exec(g)) || g === 'Match') {
    const kind = headers(m).get(String(q.market_id ?? '')), w = who(q.side), p = ou(q.side), l = numOf(q.handicap, q.line, q.label);
    if (g === 'Match') {
      if (kind === 'Winner') return w && { k: 'ml', pick: w };
      if (kind === 'Handicap (Games)') return w && half(l) && o('ttsh', w, 'Handicap de sets', `${nm(w)} ${fmt(l)}`, 'hcp', { line: l });
      if (kind === 'Total') return p && half(l) && o('ttpt', p, 'Total de pontos da partida', `${p === 'over' ? 'Mais' : 'Menos'} de ${l}`, 'hcp', { line: l });
      if (kind === 'Line (Points)') return w && half(l) && o('ttph', w, 'Handicap de pontos da partida', `${nm(w)} ${fmt(l)}`, 'hcp', { line: l });
      return null;
    }
    const s = x[1];
    if (kind === 'Winner') return w && o('ttgw', w, `Vencedor do ${s}º set`, nm(w), 'sets', { per: s });
    if (kind === 'Handicap') return w && half(l) && o('ttgh', w, `Handicap de pontos do ${s}º set`, `${nm(w)} ${fmt(l)}`, 'sets', { per: s, line: l });
    if (kind === 'Total') return p && half(l) && o('ttgt', p, `Total de pontos do ${s}º set`, `${p === 'over' ? 'Mais' : 'Menos'} de ${l}`, 'sets', { per: s, line: l });
    return null;
  }
  if (g === 'Odd/Even') { // linha "Game 3" ou "Match"
    const pe = /^odd$/i.test(String(q.side ?? '').trim()) ? 'odd' : /^even$/i.test(String(q.side ?? '').trim()) ? 'even' : null;
    const gm = /^Game (\d)$/.exec(line), per = gm ? gm[1] : line === 'Match' ? 'M' : null;
    return pe && per && o('ttoe', pe, gm ? `Total de pontos do ${per}º set: par ou ímpar` : 'Total de pontos da partida: par ou ímpar', pe === 'odd' ? 'Ímpar' : 'Par', gm ? 'sets' : 'hcp', { per });
  }
  if ((x = /^Game (\d) Winning Margin$/.exec(g))) {
    const w = who(q.side), b = String(q.line || q.label || '').trim();
    return w && /^(2|3-4|5\+)$/.test(b) && o('ttgm', `${w}:${b}`, `Margem de vitória do ${x[1]}º set`, `${nm(w)} por ${b.replace('+', ' ou mais').replace('-', ' a ')}`, 'sets', { per: x[1] });
  }
  if ((x = /^Game (\d) Extra Points$/.exec(g))) { // o set chega aos 10-10
    const y = /^yes$/i.test(String(q.label ?? '').trim()) ? 'yes' : /^no$/i.test(String(q.label ?? '').trim()) ? 'no' : null;
    return y && o('ttgx', y, `${x[1]}º set vai a 10-10`, y === 'yes' ? 'Sim' : 'Não', 'sets', { per: x[1] });
  }
  if (g === 'Match Totals') { // pontos de cada jogador na partida
    const w = who(q.side), p = ou(q.label), l = numOf(q.handicap, q.line, q.label);
    return w && p && half(l) && o('ttmp', p, 'Pontos de cada jogador na partida', `${nm(w)}: ${p === 'over' ? 'mais' : 'menos'} de ${l}`, 'hcp', { per: w, line: l });
  }
  if (g === 'Match Correct Score' || (x = /^Correct Score After (\d) Games$/.exec(g))) {
    const n = x ? Number(x[1]) : null, b = String(q.line || q.label || '').trim(), w = who(q.side);
    if (/^tie$/i.test(b)) return n && n % 2 === 0 && o('ttcs', `${n / 2}-${n / 2}`, `Placar após ${n} sets`, `${n / 2}-${n / 2}`, 'sets', { per: String(n) });
    const sc = /^(\d)-(\d)$/.exec(b);
    if (!sc || !w) return null;
    return o('ttcs', w === 'away' ? `${sc[2]}-${sc[1]}` : `${sc[1]}-${sc[2]}`, n ? `Placar após ${n} sets` : 'Placar exato em sets', `${nm(w)} ${sc[1]}-${sc[2]}`, 'sets', { per: n ? String(n) : 'M' });
  }
  if (g === 'Double Result') { // "Win 1st Game & Win Match"
    const w = who(q.side), d = /^Win 1st Game & (Win|Lose) Match$/i.exec(String(q.line || q.label || '').trim());
    return w && d && o('ttdr', `${w}:${/^win$/i.test(d[1]) ? 'w' : 'l'}`, 'Vencedor do 1º set e da partida', `${nm(w)} ganha o 1º set e ${/^win$/i.test(d[1]) ? 'ganha' : 'perde'} a partida`, 'sets');
  }
  if (g === 'Result and Total Double') { // vencedor da partida + total de pontos
    const w = who(q.line), p = ou(q.side), l = numOf(q.handicap, q.label);
    return w && p && half(l) && o('ttrt', `${w}:${p}`, 'Vencedor e total de pontos da partida', `${nm(w)} e ${p === 'over' ? 'mais' : 'menos'} de ${l}`, 'hcp', { line: l });
  }
  if ((x = /^(?:(\d)(?:st|nd|rd|th) Game|Game (\d)) Player Totals$/.exec(g))) {
    x = [x[0], x[1] || x[2]];
    const w = who(q.line), p = ou(q.side), l = numOf(q.handicap, q.label);
    return w && p && half(l) && o('ttgp', p, `Pontos de cada jogador no ${x[1]}º set`, `${nm(w)}: ${p === 'over' ? 'mais' : 'menos'} de ${l}`, 'sets', { per: `${x[1]}:${w}`, line: l });
  }
  return null;
}

// um set acabado: 11 com 2 de vantagem, ou mais de 11 só com 2 exatos (10-10 em diante)
const okGame = ([x, y]) => { const hi = Math.max(x, y), lo = Math.min(x, y); return (hi === 11 && lo <= 9) || (hi > 11 && hi - lo === 2); };
const NEED = 3; // todas as ligas da fonte jogam à melhor de 5 (776 de 776 partidas terminadas em 27/10)

/* resultado da MoviOdds → { done, h, a, sets, tt } (h/a = sets ganhos). Partida não terminada (status "unknown",
   desistência / abandono): sets acabados valem, o resto é decidido em markets.js (incomplete: true).
   startedAt: início marcado — uma partida em aberto só se dá por abandonada 6 h depois. */
function result(r, startedAt) {
  const games = String(r.final_score ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.split('-').map(Number));
  if (games.some((g) => g.length !== 2 || !g.every(Number.isInteger))) return { done: false, note: `placar ilegível: ${r.final_score}` };
  const per = (r.periods || []).map((p) => String(p.score).trim()).join(',');
  if (per && per !== games.map((g) => g.join('-')).join(',')) return { done: false, note: `sets não batem com o placar: ${r.final_score} / ${per}` };
  const won = (list) => [list.filter(([x, y]) => x > y).length, list.filter(([x, y]) => y > x).length];
  const done = games.filter(okGame);
  const full = done.length === games.length;
  const [h, a] = won(games);
  if (full && (h === NEED) !== (a === NEED) && Math.max(h, a) === NEED) {
    // terminada: quem ganhou tem 3 sets e o último set é dele
    const last = games[games.length - 1];
    if ((last[0] > last[1]) !== (h === NEED)) return { done: false, note: `o último set não é de quem ganhou: ${r.final_score}` };
    return { done: true, h, a, sets: games, tt: true };
  }
  if (r.status === 'finished') return { done: false, note: `terminada sem vencedor à melhor de 5: ${r.final_score}` };
  if (!(Date.now() - startedAt > 6 * 3600000)) return { done: false, note: 'partida por terminar' };
  // abandonada: só os sets acabados contam (um set a meio fica de fora)
  const sets = full ? games : games.slice(0, -1).every(okGame) ? games.slice(0, -1) : null;
  if (!sets) return { done: false, note: `placar estranho numa partida não terminada: ${r.final_score}` };
  const [hh, aa] = won(sets);
  return { done: true, h: hh, a: aa, sets, tt: true, incomplete: true };
}

module.exports = { quote, result, okGame, NEED };
