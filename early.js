'use strict';
/* Liquidação antecipada: uma seleção é paga (ou dada como perdida) assim que o seu resultado já não pode mudar,
   sem esperar pelo fim do jogo.

   Quando uma seleção está decidida:
   - placar que só sobe (gols, pontos, mapas): "mais de 2,5" com 3 gols, "ambas marcam: sim" com as duas a marcar,
     placar exato ultrapassado, "menos de" ultrapassado... — decidida se nenhum placar futuro mudar o resultado;
   - ténis: set terminado (vencedor, placar, games, tie-break, quem lidera...), game terminado (vencedor do game,
     placar do game, deuce...), primeiro jogo de serviço de cada um, primeira quebra;
   - e-Sports (CS2/Valorant): vencedor do mapa N quando o mapa acabou.

   Salvaguardas (todas têm de se cumprir):
   1. os dados que decidem a seleção (placar, set, game, mapa) e o resultado ficaram IGUAIS durante EARLY_SETTLE_S
      (2,5 min) — um gol anulado, um placar corrigido ou um erro da fonte recomeçam a contagem;
   2. futebol e hóquei: depois do último gol a bet365 reabriu os mercados (VAR resolvido) e estão abertos há
      EARLY_OPEN_S (60 s) seguidos — uma revisão do VAR volta a fechá-los e recomeça a contagem;
   3. o jogo tem odds frescas agora (a fonte está a ler o jogo; odds em atraso ficam bloqueadas).
   O resto (vencedor do jogo, handicaps, mercados da equipa...) continua a ser liquidado no fim, como antes. */

const SETTLE_MS = Number(process.env.EARLY_SETTLE_S || 150) * 1000;
const OPEN_MS = Number(process.env.EARLY_OPEN_S || 60) * 1000;
const OFF = process.env.EARLY_SETTLE === '0';

// placar → resultado: tipos em que mais gols/pontos/mapas nunca "desfazem" um resultado já decidido
const MONO = { soccer: ['total', 'btts', 'cs'], hockey: ['total', 'btts', 'cs'], basketball: ['total'], esports: ['ecs', 'e1m'] };
const TENNIS_SET = new Set(['tsw', 'tscs', 'tscg', 'tsca', 'tsgt', 'tsgh', 'tstbw', 'tslead', 'tsafter', 'tsrace', 'tsbrk']);
const TENNIS_GAME = new Set(['tgw', 'tgs', 'tgd', 'tgsw']);
const TENNIS_GAME2 = new Set(['tgpw', 'tgpd']);
const TENNIS_FIRST_SRV = new Set(['tfswin', 'tfsg', 'tfsw', 'tfsd']);

const PARTS = require('./feeds/parts.js');
const PLAYERS = require('./feeds/players.js');
const SCOPE_PT = (s) => ({ ft: 'jogo', h1: '1º tempo', h2: '2º tempo', corners: 'escanteios', cards: 'cartões' }[s]
  || (/^q(\d)$/.exec(s) ? `${s.slice(1)}º quarto` : /^p(\d)$/.exec(s) ? `${s.slice(1)}º período` : /^map(\d+)$/.exec(s) ? `mapa ${s.slice(3)}` : s));
/* futebol: só no tempo regulamentar (um gol no prolongamento não conta para os mercados).
   A fonte mostra "90'+" tanto nos descontos como no prolongamento, por isso os descontos do 2º tempo só contam nas
   competições sem prolongamento: campeonatos. Taças, eliminatórias, play-offs e provas internacionais ficam de fora
   (na dúvida, fica de fora). Os descontos do 1º tempo ("45'+") contam sempre. */
const MAY_HAVE_EXTRA_TIME = /cup|copa|ta[cç]a|pokal|coupe|coppa|beker|kupa|puchar|cupa|\bkup|trophy|trof[eé]u|shield|play.?off|playout|final|knockout|qualif|friendl|amist|champions\b|campe[õo]es|\bmls\b|liguilla|europa|conference|libertadores|sul.?americana|sudamericana|nations|world|mundial|\beuro\b|internacional|international/i;
const noExtraTime = (ev) => !MAY_HAVE_EXTRA_TIME.test(`${ev.leagueName || ''} ${ev.league || ''} ${ev.country || ''}`);
const inRegulation = (ev) => {
  const c = ev.clock || '';
  if (c === 'Intervalo' || c === "45'+") return true;
  if (c === "90'+") return noExtraTime(ev);
  const mm = /^(\d+)'$/.exec(c);
  return !!(mm && Number(mm[1]) < 90);
};
const MONO_PART = new Set(['ptot', 'pteam', 'pbtts', 'pcln', 'pot']);
// combinações em que mais gols nunca desfazem: só ambas marcam e "mais/menos de" (sem resultado, faixas ou "exatamente")
const monoCond = (pick) => String(pick).replace(/^!/, '').split(';').every((c) => /^(btts=(yes|no)|(tot|th|ta)=(gt|lt):[\d.]+)$/.test(c));

module.exports = function early({ M, TEN, events, liveStats, now }) {
  const seen = new Map();     // aposta|seleção → { sig, since }
  const openSince = new Map(); // jogo → desde quando os mercados estão abertos (null = fechados)

  const hasOpenOdds = (ev) => (ev.markets || []).some((mk) => mk.k !== 'x' && mk.sels.some((s) => !s.lock));
  // a cada passagem: mercados do jogo abertos (sem suspensão, com odds frescas)?
  function tick() {
    const t = now();
    for (const ev of events.values()) {
      if (ev.state !== 'in') { openSince.delete(ev.id); continue; }
      const open = !M.isSuspended(ev, t) && hasOpenOdds(ev);
      if (!open) openSince.set(ev.id, null);
      else if (!openSince.get(ev.id)) openSince.set(ev.id, t);
    }
    for (const k of seen.keys()) if (!events.has(k.split('|')[1])) seen.delete(k);
  }

  // ---- placar que só sobe ----
  function mono(leg, ev) {
    if (!(MONO[ev.sport] || []).includes(leg.market) || (leg.per != null && leg.market !== 'e1m')) return null; // e1m: "per" = de que equipa
    // futebol: só no tempo regulamentar (ver inRegulation: descontos do 2º tempo só nos campeonatos)
    if (ev.sport === 'soccer' && !inRegulation(ev)) return null;
    const h = ev.home.score, a = ev.away.score;
    if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
    const out = (x, y) => M.legOutcome(leg, { h: x, a: y });
    const v = out(h, a);
    if (v == null) return null;
    if (leg.market === 'total') { // só conta a soma: decidido se somar muito mais não muda nada
      if (out(h + 1000, a) !== v) return null;
    } else {
      const K = ev.sport === 'esports' ? 4 : 15;
      for (let i = 0; i <= K; i++) for (let j = 0; j <= K; j++) if (out(h + i, a + j) !== v) return null;
    }
    return { v, sig: `${h}-${a}`, text: `${h}-${a}` };
  }

  // ---- mercados por parte do jogo (tempos, quartos, períodos, escanteios, mapas) ----
  function part(leg, ev) {
    if (!M.AUTO_KINDS.has(leg.market)) return null;
    const st = liveStats(ev.id);
    if (!st) return null;
    if (ev.sport === 'soccer' && !inRegulation(ev)) return null;
    const score = [ev.home.score, ev.away.score];
    if (!score.every(Number.isFinite)) return null;
    const done = PARTS.finishedParts(ev.sport, st, score, { live: true });
    const scope = M.scopeOf(leg);
    const R = { h: score[0], a: score[1], parts: done };
    if (leg.market === 'phtft') { // intervalo/final: perdida logo que o intervalo não bate com a escolha
      if (!done.h1) return null;
      const r = (x) => (x[0] > x[1] ? 'home' : x[0] < x[1] ? 'away' : 'draw');
      if (String(leg.pick).split('-')[0] === r(done.h1)) return null;
      return { v: -1, sig: done.h1.join('-'), text: `intervalo ${done.h1.join('-')}` };
    }
    // parte terminada (e verificada): resultado direto
    if (scope !== 'ft' && done[scope]) {
      const v = M.legOutcome(leg, R);
      return v == null ? null : { v, sig: done[scope].join('-'), text: `${SCOPE_PT(scope)} ${done[scope].join('-')}` };
    }
    // parte a decorrer: só os mercados em que mais gols/pontos/rondas já não mudam o resultado
    let cur = null;
    if (scope === 'ft') cur = ev.sport === 'soccer' || ev.sport === 'basketball' ? score : null;
    else if (scope === 'corners') cur = ev.sport === 'soccer' && Number.isFinite(st.home?.corners) && Number.isFinite(st.away?.corners) ? [st.home.corners, st.away.corners] : null;
    // cartões: os amarelos são o mínimo certo (um vermelho só pode somar) → "mais de" ganha / "menos de" perde
    else if (scope === 'cards') cur = ev.sport === 'soccer' ? PARTS.soccerCards(st)?.lo || null : null;
    else { const c = PARTS.currentPart(ev.sport, st, score); if (c && c.scope === scope) cur = c.score; }
    if (!cur || !cur.every((x) => Number.isFinite(x) && x >= 0)) return null;
    const out = (x, y) => M.legOutcome(leg, { h: x, a: y, parts: { [scope]: [x, y] } });
    const [x, y] = cur;
    let v;
    if (leg.market === 'pcs') { const p = String(leg.pick).split('-').map(Number); if (!(x > p[0] || y > p[1])) return null; v = -1; }
    else if (MONO_PART.has(leg.market) || (leg.market === 'pcond' && monoCond(leg.pick))) {
      v = out(x, y);
      if (v == null || out(x + 1000, y) !== v || out(x, y + 1000) !== v || out(x + 1000, y + 1000) !== v) return null;
    } else return null;
    return { v, sig: `${x}-${y}`, text: `${SCOPE_PT(scope)} ${x}-${y}` };
  }

  // ---- jogadores (futebol): "N ou mais" já atingido nas estatísticas ao vivo → ganha (as perdas só no fim) ----
  function player(leg, ev) {
    if (leg.market !== 'pp' || ev.sport !== 'soccer' || !inRegulation(ev)) return null;
    const roster = PLAYERS.roster(liveStats(ev.id));
    const p = roster ? M.ppPlayer(leg, roster) : null;
    const stat = String(leg.per ?? '').split('|')[0];
    const get = M.PP_FIELD[stat];
    const v = p && get ? get(p) : undefined;
    if (!Number.isFinite(v) || v < Number(String(leg.pick).split('#')[0])) return null;
    return { v: 1, sig: `${stat}:${v}`, text: `${PLAYERS.STAT_PT[stat] || stat} ${v}` };
  }

  // ---- ténis: sets e games terminados ----
  const okSet = ([x, y]) => { const hi = Math.max(x, y), lo = Math.min(x, y); return (hi === 6 && lo <= 4) || (hi === 7 && (lo === 5 || lo === 6)) || (hi > 7 && hi - lo === 2); };
  function tennis(leg, ev) {
    const k = leg.market;
    if (!TENNIS_SET.has(k) && !TENNIS_GAME.has(k) && !TENNIS_GAME2.has(k) && !TENNIS_FIRST_SRV.has(k) && k !== 'tfbrk' && k !== 'set1') return null;
    const st = liveStats(ev.id);
    const hs = st?.home?.sets, as = st?.away?.sets;
    if (!Array.isArray(hs) || !Array.isArray(as) || !hs.length || hs.length !== as.length) return null;
    const sets = hs.map((x, i) => [Number(x), Number(as[i])]);
    if (sets.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
    // o histórico game a game tem de bater certo com o placar (mesmos nomes, mesmo número de games, mesmos vencedores)
    const log = TEN.gameLog({ home: ev.home.name, away: ev.away.name, stats: st }, sets);
    if (!log) return null;
    const [pa, pb] = String(leg.per ?? '').split(/[:/]/);
    const sN = k === 'set1' ? 1 : Number(pa), N = Number(pb);
    // set terminado: há um set a seguir, ou o placar é final (6-4, 7-5, 7-6...) — e o histórico confirma-o
    const setDone = (n) => n >= 1 && n <= sets.length && (n < sets.length || okSet(sets[n - 1]));
    let need;
    if (TENNIS_SET.has(k) || k === 'set1') { if (!setDone(sN)) return null; need = log.filter((e) => e.s === sN); }
    else if (TENNIS_GAME.has(k) || TENNIS_GAME2.has(k)) {
      const gs = log.filter((e) => e.s === sN);
      const last = N + (TENNIS_GAME2.has(k) ? 1 : 0);
      if (gs.length < last) { if (!setDone(sN)) return null; } // o set acabou antes deste game: devolvida
      need = gs.slice(0, last);
    } else if (TENNIS_FIRST_SRV.has(k)) {
      const e = log.find((x) => x.srv === pa);
      if (!e) return null;
      need = log.slice(0, log.indexOf(e) + 1);
    } else { // primeira quebra
      const i = log.findIndex((e) => e.srv && e.w !== e.srv);
      if (i < 0) return null;
      need = log.slice(0, i + 1);
    }
    const v = M.legOutcome(leg, { h: 0, a: 0, sets, log }); // só se chega aqui com a parte da seleção terminada
    if (v == null) return null;
    const setTxt = sets.filter((_, i) => setDone(i + 1)).map((x) => x.join('-')).join(' ');
    return { v, sig: JSON.stringify([sets.slice(0, sN || 1), need]), text: setTxt ? `sets ${setTxt}` : `${need.length} games` };
  }

  // ---- e-Sports: vencedor do mapa N (CS2/Valorant: rondas de cada mapa) ----
  function esportsMap(leg, ev) {
    if (leg.market !== 'emw') return null;
    const st = liveStats(ev.id);
    const maps = st?.maps, wh = st?.home?.maps_won, wa = st?.away?.maps_won;
    const n = Number(leg.per);
    if (!Array.isArray(maps) || !Number.isFinite(wh) || !Number.isFinite(wa) || n > wh + wa) return null; // mapa ainda não acabou
    const rounds = maps.slice(0, wh + wa).map((x) => [Number(x.home), Number(x.away)]);
    // os mapas terminados têm de bater certo com os mapas ganhos
    const won = rounds.reduce((s, [x, y]) => [s[0] + (x > y), s[1] + (y > x)], [0, 0]);
    if (rounds.length !== wh + wa || won[0] !== wh || won[1] !== wa) return null;
    const v = M.legOutcome(leg, { h: wh, a: wa, maps: rounds });
    if (v == null) return null;
    return { v, sig: JSON.stringify(rounds.slice(0, n)), text: `mapa ${n}: ${rounds[n - 1].join('-')}` };
  }

  /* Uma seleção ainda sem resultado: devolve true (e preenche leg.result) se ficou decidida e passou as salvaguardas. */
  function check(betId, leg) {
    if (OFF || leg.result || leg.market === 'x') return false;
    const ev = events.get(leg.evId);
    const key = `${betId}|${leg.evId}|${leg.key}`;
    if (!ev || ev.state !== 'in') { seen.delete(key); return false; }
    const d = mono(leg, ev) || part(leg, ev) || player(leg, ev) || (ev.sport === 'tennis' ? tennis(leg, ev) : ev.sport === 'esports' ? esportsMap(leg, ev) : null);
    if (!d) { seen.delete(key); return false; }
    const t = now();
    const sig = `${d.sig}|${d.v}`;
    const s = seen.get(key);
    if (!s || s.sig !== sig) { seen.set(key, { sig, since: t }); return false; }
    if (t - s.since < SETTLE_MS) return false;
    // salvaguardas: odds frescas agora; futebol/hóquei: mercados reabertos depois do último gol e abertos há 1 min
    if (!hasOpenOdds(ev)) return false;
    if (M.GOAL_SPORTS.has(ev.sport)) {
      const op = openSince.get(ev.id);
      if (!op || t - op < OPEN_MS || (ev.goalAt && op < ev.goalAt)) return false;
    }
    seen.delete(key);
    leg.value = d.v;
    leg.result = M.outcomeLabel(d.v);
    leg.final = `ao vivo · ${d.text}`;
    leg.early = t; // liquidada antes do fim do jogo
    return true;
  }

  return { tick, check, settleMs: SETTLE_MS };
};
