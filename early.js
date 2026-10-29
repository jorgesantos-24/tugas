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
const TENNIS_SET = new Set(['tsw', 'tscs', 'tscg', 'tsca', 'tsgt', 'tsgh', 'tstbw', 'tslead', 'tsafter', 'tsrace', 'tsbrk', 'tsbt', 'ttbtp', 'ttbs', 'ttblead', 'ttbsa', 'ttbpb']);
const TENNIS_GAME = new Set(['tgw', 'tgs', 'tgd', 'tgsw', 'tg1p', 'tgsa', 'tgpb', 'tgbp', 'tgtp']);
const TENNIS_GAME2 = new Set(['tgpw', 'tgpd']);
// ténis, mercados da partida que só dependem de quem ganha cada set: decididos quando todas as maneiras possíveis
// de acabar a partida dão o mesmo resultado (ex.: 1-1 em sets → "total de sets: 3" ganha, "vence sem perder set" perde)
const TENNIS_MATCH = new Set(['ml', 'sets', 'tsets', 'tstraight', 'tpto', 'tdr', 'tcast', 'tdist']);
// ténis, contagens que só sobem (games, tie-breaks, quebras, aces, duplas faltas): "mais de" ganha / "menos de" perde
// logo que a contagem passa a linha; "N ou mais" ganha logo que chega a N
const TENNIS_COUNT = new Set(['gtotal', 'ttb', 'tpgw', 'tbrk', 'tpbrk', 'tace', 'tdf']);
const TENNIS_FIRST_SRV = new Set(['tfswin', 'tfsg', 'tfsw', 'tfsd', 'tfsa', 'tfstp', 'tfsbp']);
// mercados de pontos: precisam dos placares gravados ao vivo (feeds/points.js)
const TENNIS_POINTS = new Set(['tg1p', 'tgsa', 'tgpb', 'tgbp', 'tfsa', 'tfsbp', 'ttblead', 'ttbsa', 'ttbpb']);

const PARTS = require('./feeds/parts.js');
const BPL = require('./feeds/bplayers.js');
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

module.exports = function early({ M, TEN, events, liveStats, now, POINTS = null, espnBox = () => null }) {
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

  /* ---- basquete: jogador passou a linha ("N ou mais" ganha, "menos de N" perde, duplo/triplo-duplo feito) ----
     Só com DUAS fontes de acordo: o box score ao vivo da MoviOdds e o da ESPN (a MoviOdds sozinha erra rebotes e
     assistências). As estatísticas só sobem, por isso passar a linha decide; o resto (e quem não jogou) fica para o fim. */
  function basket(leg, ev) {
    if (leg.market !== 'bp' || ev.sport !== 'basketball') return null;
    const stat = String(leg.per ?? '').split('|')[0], get = M.BP_FIELD[stat], n = M.bpNeed(leg);
    const eb = espnBox(ev.id);
    if (!get || !n || !eb) return null;
    const a = M.bpPlayer(leg, BPL.roster(liveStats(ev.id)) || []), b = M.bpPlayer(leg, eb);
    const va = a ? get(a) : NaN, vb = b ? get(b) : NaN;
    if (!(va >= n.need) || !(vb >= n.need)) return null;
    return { v: n.under ? -1 : 1, sig: `${stat}:passou`, text: `${BPL.STAT_PT[stat] || stat} ${Math.min(va, vb)}` };
  }

  // ---- futebol: os 90 minutos acabaram (prorrogação / pênaltis a seguir) ----
  /* A cronologia da fonte escreve "Score After Full Time - X-Y" quando acaba o tempo regulamentar: os mercados que contam
     só os 90 minutos ficam decididos aí, sem esperar pela prorrogação e pelos pênaltis (28/10: LASK x Ried foi a
     prolongamento e a seleção "LASK vence" ficava em aberto). Escanteios, cartões e jogadores ficam de fora (a fonte
     pode juntar-lhes a prorrogação). */
  const REG_KINDS = new Set(['ml', 'dc', 'dnb', 'btts', 'total', 'spread', 'cs']);
  const scoreLine = (tl, re) => { const x = [...tl].reverse().find((t) => re.test(t.text || '')); const m = x && /(\d+)\s*-\s*(\d+)\s*$/.exec(x.text); return m ? [Number(m[1]), Number(m[2])] : null; };
  function regulationEnd(leg, ev) {
    if (ev.sport !== 'soccer' || ev.state !== 'in') return null;
    const k = leg.market;
    if (!REG_KINDS.has(k) && !M.AUTO_KINDS.has(k)) return null;
    const tl = liveStats(ev.id)?.timeline || [];
    const ft = scoreLine(tl, /Score After Full Time/i);
    if (!ft) return null;
    const [h, a] = ft;
    let R;
    if (REG_KINDS.has(k)) R = { h, a };
    else {
      const scope = M.scopeOf(leg);
      if (scope !== 'ft' && scope !== 'h1' && scope !== 'h2') return null; // escanteios, cartões...: a fonte pode incluir a prorrogação
      const h1 = scoreLine(tl, /Score After First Half/i);
      if (scope !== 'ft' && (!h1 || h1[0] > h || h1[1] > a)) return null;
      R = { h, a, parts: { ft: [h, a], ...(h1 ? { h1, h2: [h - h1[0], a - h1[1]] } : {}) } };
    }
    const v = M.legOutcome(leg, R);
    if (v == null) return null;
    return { v, sig: `ft:${h}-${a}`, text: `90 min ${h}-${a}` };
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
    const pts = POINTS ? POINTS.resolve(ev.id, log) : null;
    const v = M.legOutcome(leg, { h: 0, a: 0, sets, log, pts }); // só se chega aqui com a parte da seleção terminada
    if (v == null) return null;
    const setTxt = sets.filter((_, i) => setDone(i + 1)).map((x) => x.join('-')).join(' ');
    // pontos: a sequência reconstruída também entra na assinatura (uma correção recomeça a contagem)
    const ptSig = TENNIS_POINTS.has(k) ? need.map((e) => pts?.[`${e.s}/${e.g}`] || null) : null;
    return { v, sig: JSON.stringify([sets.slice(0, sN || 1), need, ptSig]), text: setTxt ? `sets ${setTxt}` : `${need.length} games` };
  }

  // ---- ténis: mercados da partida decididos antes do fim ----
  // nº de sets para ganhar: a fonte diz o formato ("best_of_3" / "best_of_5"); sem ele não se adianta nada
  const setsToWin = (st) => (st?.format === 'best_of_5' ? 3 : st?.format === 'best_of_3' ? 2 : null);
  function tennisMatch(leg, ev) {
    const k = leg.market;
    if (!TENNIS_MATCH.has(k) && !TENNIS_COUNT.has(k)) return null;
    const st = liveStats(ev.id);
    const hs = st?.home?.sets, as = st?.away?.sets;
    if (!Array.isArray(hs) || !Array.isArray(as) || !hs.length || hs.length !== as.length) return null;
    const sets = hs.map((x, i) => [Number(x), Number(as[i])]);
    if (sets.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
    const need = setsToWin(st);
    if (!need) return null;
    // sets terminados: todos menos o atual (a não ser que o atual já tenha placar final)
    const done = sets.filter((x, i) => i < sets.length - 1 || okSet(x));
    if (done.some((x) => !okSet(x))) return null;
    const hw = done.filter(([x, y]) => x > y).length, aw = done.length - hw;
    if (hw >= need || aw >= need) return null; // acabou: fica para o resultado final
    if (TENNIS_MATCH.has(k)) {
      // todas as maneiras de acabar: sequências de vencedores dos sets que faltam
      const outs = new Set();
      const rec = (h, a, extra) => {
        if (outs.size > 1) return;
        if (h === need || a === need) {
          const all = done.concat(extra.map((w) => (w === 'home' ? [6, 0] : [0, 6])));
          outs.add(M.legOutcome(leg, { h, a, sets: all }));
          return;
        }
        rec(h + 1, a, [...extra, 'home']); rec(h, a + 1, [...extra, 'away']);
      };
      rec(hw, aw, []);
      if (outs.size !== 1) return null;
      const v = [...outs][0];
      if (v == null) return null;
      const txt = done.map((x) => x.join('-')).join(' ');
      return { v, sig: `sets:${txt}`, text: `sets ${txt}` };
    }
    // contagens que só sobem
    const [pa, pb] = String(leg.per ?? '').split(':');
    let cur;
    if (k === 'gtotal') cur = sets.reduce((q, x) => q + x[0] + x[1], 0);
    else if (k === 'tpgw') cur = sets.reduce((q, x) => q + x[pa === 'home' ? 0 : 1], 0);
    else if (k === 'ttb') cur = done.filter((x) => Math.max(...x) === 7 && Math.min(...x) === 6).length;
    else if (k === 'tace' || k === 'tdf') {
      const f = k === 'tace' ? 'aces' : 'double_faults', h = Number(st.home?.[f]), a = Number(st.away?.[f]);
      if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
      cur = pa === 'all' ? h + a : pa === 'home' ? h : a;
      if (cur < leg.line) return null; // "N ou mais": só se decide quando chega
      return { v: 1, sig: `${k}:${cur}`, text: `${k === 'tace' ? 'aces' : 'duplas faltas'} ${cur}` };
    } else {
      const log = TEN.gameLog({ home: ev.home.name, away: ev.away.name, stats: st }, sets);
      if (!log) return null;
      const brk = (e) => e.srv && e.w !== e.srv;
      if (k === 'tbrk') cur = log.filter(brk).length;
      else { const si = Number(pb) || 0; if (si) return null; cur = log.filter((e) => brk(e) && e.w === pa).length; } // tpbrk de um set: no fim do set
    }
    if (!Number.isFinite(cur) || !(cur > leg.line)) return null; // ainda abaixo da linha: "mais"/"menos" por decidir
    const v = leg.pick === 'over' ? 1 : leg.pick === 'under' ? -1 : null;
    if (v == null) return null;
    return { v, sig: `${k}:${cur}`, text: `${k === 'gtotal' || k === 'tpgw' ? 'games' : k === 'ttb' ? 'tie-breaks' : 'quebras'} ${cur}` };
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
    const d = regulationEnd(leg, ev) || mono(leg, ev) || part(leg, ev) || player(leg, ev) || basket(leg, ev) || (ev.sport === 'tennis' ? tennis(leg, ev) || tennisMatch(leg, ev) : ev.sport === 'esports' ? esportsMap(leg, ev) : null);
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
