'use strict';
/* Resultado de prolongamento e penáltis na ESPN (a MoviOdds só regista os 90 minutos).
   Devolve { end: 'ft'|'aet'|'pens', winner, pens, qualified } (lados do jogo do site) ou null se não encontrar
   o jogo, se ainda não terminou ou se os dados não baterem certo com o placar dos 90 minutos. */

const { ESPN_LEAGUE } = require('./logos.js');
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/';
const OFF = process.env.ESPN_RESULTS === '0'; // desliga a consulta (os mercados ficam para a equipa)

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\b(fc|cf|sc|ac|afc|cd|ca|ec|se|club|clube|de|da|do|la|futebol|football|esporte|sport|calcio|the|ud|sd|rc|ssc|as|us|sv|vfb|vfl|tsg|bsc|fk|sk|cp)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const toks = (s) => norm(s).split(' ').filter((x) => x.length >= 3);
// mesmo clube? (uma palavra significativa em comum e, nos nomes curtos, todas as palavras)
function same(a, b) {
  const A = toks(a), B = toks(b);
  if (!A.length || !B.length) return false;
  const hit = A.filter((x) => B.some((y) => y === x || (Math.min(x.length, y.length) >= 4 && (y.startsWith(x) || x.startsWith(y)))));
  return hit.length >= 1 && hit.length >= Math.min(A.length, B.length) * 0.5;
}

const cache = new Map(); // slug|dia → { at, events }
async function scoreboard(slug, day) {
  const k = `${slug}|${day}`;
  const c = cache.get(k);
  if (c && Date.now() - c.at < 90000) return c.events;
  const r = await fetch(`${BASE}${slug}/scoreboard?dates=${day}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`ESPN HTTP ${r.status}`);
  const events = (await r.json()).events || [];
  cache.set(k, { at: Date.now(), events });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return events;
}

/* ev = jogo do site (league, home.name, away.name, date) · reg = placar dos 90 minutos [c, f] (MoviOdds) */
async function extraTime(ev, reg) {
  if (OFF) return null;
  const slug = ESPN_LEAGUE[ev.league];
  if (!slug || !slug.startsWith('soccer/')) return null;
  const t = +ev.date;
  const days = [-1, 0, 1].map((d) => new Date(t + d * 86400000).toISOString().slice(0, 10).replace(/-/g, ''));
  for (const day of days) {
    for (const e of await scoreboard(slug, day)) {
      const c = e.competitions?.[0];
      if (!c || Math.abs(Date.parse(c.date || e.date) - t) > 6 * 3600000) continue;
      const H = c.competitors?.find((x) => x.homeAway === 'home'), A = c.competitors?.find((x) => x.homeAway === 'away');
      if (!H || !A) continue;
      let swap;
      if (same(ev.home.name, H.team?.displayName) && same(ev.away.name, A.team?.displayName)) swap = false;
      else if (same(ev.home.name, A.team?.displayName) && same(ev.away.name, H.team?.displayName)) swap = true;
      else continue;
      if (!c.status?.type?.completed) return null; // ainda a decorrer: tenta-se mais tarde
      const [h, a] = swap ? [A, H] : [H, A];
      const detail = String(c.status.type.detail || c.status.type.shortDetail || '');
      const end = /pen/i.test(detail) || c.status.type.name === 'STATUS_FINAL_PEN' ? 'pens' : /AET|extra/i.test(detail) || /AET/.test(c.status.type.name) ? 'aet' : 'ft';
      const sc = [Number(h.score), Number(a.score)];
      // conferência: sem prolongamento, o placar da ESPN tem de ser o dos 90 minutos; com penáltis (sem prolongamento) também
      if (reg && end === 'ft' && (sc[0] !== reg[0] || sc[1] !== reg[1])) return null;
      if (reg && end !== 'ft' && (sc[0] < reg[0] || sc[1] < reg[1])) return null;
      const pens = end === 'pens' && Number.isFinite(Number(h.shootoutScore)) && Number.isFinite(Number(a.shootoutScore)) ? [Number(h.shootoutScore), Number(a.shootoutScore)] : null;
      if (end === 'pens' && (!pens || pens[0] === pens[1])) return null;
      const winner = h.winner === true ? 'home' : a.winner === true ? 'away' : end === 'ft' && sc[0] !== sc[1] ? (sc[0] > sc[1] ? 'home' : 'away') : null;
      if (end === 'pens' && winner !== (pens[0] > pens[1] ? 'home' : 'away')) return null;
      // quem passa: jogo único, ou decidido no prolongamento/penáltis; na 1ª mão (ou 2ª mão decidida no agregado) não se sabe
      const notes = (c.notes || []).map((n) => n.headline || n.text || '').join(' ');
      const qualified = end !== 'ft' ? winner : /\bleg\b/i.test(notes) ? null : winner;
      // prolongamento jogado? ("AET", "AET-Pens"; "FT-Pens" = penáltis logo a seguir aos 90 minutos)
      const etPlayed = end === 'aet' || /AET|extra/i.test(detail);
      const etGoals = etPlayed ? await extraTimeGoals(slug, e.id, swap, H, A, sc, reg) : null;
      return { end, winner, pens, qualified, etPlayed, etGoals, twoLegs: /\bleg\b/i.test(notes), espn: `${H.team?.displayName} ${H.score}-${A.score} ${A.team?.displayName} (${detail})` };
    }
  }
  return null;
}

/* Gols do prolongamento, do resumo do jogo na ESPN (cada gol com período: 1-2 = 90 minutos, 3-4 = prolongamento).
   Só vale se bater certo duas vezes: gols dos períodos 1+2 = placar dos 90 minutos (MoviOdds) e todos = placar final
   da ESPN (um autogolo atribuído à equipa errada, ou um gol em falta, deixa de bater → null → equipa).
   → { p3: [c, f], p4: [c, f], order: ['home', 'away', ...] } (gols do prolongamento por ordem) ou null. */
async function extraTimeGoals(slug, id, swap, H, A, sc, reg) {
  try {
    const r = await fetch(`${BASE}${slug}/summary?event=${encodeURIComponent(id)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const s = await r.json();
    const per = { 1: [0, 0], 2: [0, 0], 3: [0, 0], 4: [0, 0] }, order = [];
    const goals = (s.keyEvents || []).filter((k) => k.scoringPlay && Number(k.period?.number) <= 4); // período 5 = penáltis
    for (const k of goals) {
      const p = Number(k.period.number), tn = k.team?.displayName;
      const espnSide = same(tn, H.team?.displayName) ? 0 : same(tn, A.team?.displayName) ? 1 : -1;
      if (espnSide < 0 || !per[p]) return null;
      const side = swap ? 1 - espnSide : espnSide; // lado do jogo do site
      per[p][side]++;
      if (p >= 3) order.push(side === 0 ? 'home' : 'away');
    }
    const espnTot = swap ? [sc[1], sc[0]] : sc; // placar final no lado da ESPN → no lado do site já vem em sc
    const all = [0, 1].map((i) => per[1][i] + per[2][i] + per[3][i] + per[4][i]);
    if (all[0] !== sc[0] || all[1] !== sc[1]) return null;
    if (reg && (per[1][0] + per[2][0] !== reg[0] || per[1][1] + per[2][1] !== reg[1])) return null;
    void espnTot;
    return { p3: per[3], p4: per[4], order };
  } catch { return null; }
}

/* Disputa de pênaltis cobrança a cobrança (ao vivo e no fim), do resumo do jogo na ESPN ("shootout").
   → { home: [{ p: 'Foden', ok: true }, ...], away: [...], score: [c, f], done } no lado do jogo do site, ou null. */
async function shootout(ev) {
  if (OFF) return null;
  const slug = ESPN_LEAGUE[ev.league];
  if (!slug || !slug.startsWith('soccer/')) return null;
  const t = +ev.date;
  for (const day of [0, 1, -1].map((d) => new Date(t + d * 86400000).toISOString().slice(0, 10).replace(/-/g, ''))) {
    let list;
    try {
      const r = await fetch(`${BASE}${slug}/scoreboard?dates=${day}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      list = (await r.json()).events || [];
    } catch { continue; }
    for (const e of list) {
      const c = e.competitions?.[0];
      if (!c || Math.abs(Date.parse(c.date || e.date) - t) > 6 * 3600000) continue;
      const H = c.competitors?.find((x) => x.homeAway === 'home'), A = c.competitors?.find((x) => x.homeAway === 'away');
      if (!H || !A) continue;
      let swap;
      if (same(ev.home.name, H.team?.displayName) && same(ev.away.name, A.team?.displayName)) swap = false;
      else if (same(ev.home.name, A.team?.displayName) && same(ev.away.name, H.team?.displayName)) swap = true;
      else continue;
      const st = c.status?.type || {};
      if (!/SHOOTOUT|PEN/i.test(`${st.name} ${st.detail}`)) return null; // ainda sem pênaltis
      const r = await fetch(`${BASE}${slug}/summary?event=${encodeURIComponent(e.id)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const so = (await r.json()).shootout || [];
      const side = (name) => (same(name, H.team?.displayName) ? (swap ? 'away' : 'home') : same(name, A.team?.displayName) ? (swap ? 'home' : 'away') : null);
      const out = { home: [], away: [], done: !!st.completed };
      for (const tm of so) {
        const sd = side(tm.team);
        if (!sd) return null;
        out[sd] = (tm.shots || []).slice().sort((a, b) => a.shotNumber - b.shotNumber).map((x) => ({ p: String(x.player || '').split(' ').slice(-1)[0], n: x.player || '', ok: !!x.didScore }));
      }
      out.score = [out.home.filter((x) => x.ok).length, out.away.filter((x) => x.ok).length];
      return out;
    }
  }
  return null;
}

/* Box score do basquete (NBA/WNBA), reserva da MoviOdds para os mercados de jogadores.
   fin = placar final do site [c, f] → [{ key, side, played, pts, reb, ast, tpm, stl, blk }] (lados do site), ou null
   se o jogo não estiver terminado na ESPN, se o placar não bater certo ou se os pontos dos jogadores não somarem o placar.
   live = true: o box score do jogo a decorrer (os pontos dos jogadores têm de somar o placar atual da ESPN). */
async function basketBox(ev, fin, bpKey, live = false) {
  if (OFF) return null;
  const slug = ESPN_LEAGUE[ev.league];
  if (!slug || !/^basketball\/(nba|wnba)$/.test(slug)) return null;
  const t = +ev.date;
  for (const day of [0, -1, 1].map((d) => new Date(t + d * 86400000).toISOString().slice(0, 10).replace(/-/g, ''))) {
    let list;
    try { list = await scoreboard(slug, day); } catch { continue; }
    for (const e of list) {
      const c = e.competitions?.[0];
      if (!c || Math.abs(Date.parse(c.date || e.date) - t) > 6 * 3600000) continue;
      const H = c.competitors?.find((x) => x.homeAway === 'home'), A = c.competitors?.find((x) => x.homeAway === 'away');
      if (!H || !A) continue;
      let swap;
      if (same(ev.home.name, H.team?.displayName) && same(ev.away.name, A.team?.displayName)) swap = false;
      else if (same(ev.home.name, A.team?.displayName) && same(ev.away.name, H.team?.displayName)) swap = true;
      else continue;
      if (live ? c.status?.type?.state !== 'in' : !c.status?.type?.completed) return null;
      const r = await fetch(`${BASE}${slug}/summary?event=${encodeURIComponent(e.id)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const d = await r.json();
      if (live) { // placar atual da ESPN, nos lados do site
        const cs = d.header?.competitions?.[0]?.competitors || [];
        const sc = (id) => Number(cs.find((x) => String(x.id ?? x.team?.id) === String(id))?.score);
        fin = swap ? [sc(A.team?.id), sc(H.team?.id)] : [sc(H.team?.id), sc(A.team?.id)];
        if (!fin.every(Number.isFinite)) return null;
      }
      const out = [];
      for (const tm of d.boxscore?.players || []) {
        const espnHome = String(tm.team?.id) === String(H.team?.id), espnAway = String(tm.team?.id) === String(A.team?.id);
        if (!espnHome && !espnAway) return null;
        const side = espnHome !== swap ? 'home' : 'away';
        const s = tm.statistics?.[0];
        const ix = (k) => (s?.keys || []).indexOf(k);
        const iP = ix('points'), iR = ix('rebounds'), iA = ix('assists'), i3 = ix('threePointFieldGoalsMade-threePointFieldGoalsAttempted'), iS = ix('steals'), iB = ix('blocks'), iM = ix('minutes');
        if ([iP, iR, iA, i3, iS, iB].some((i) => i < 0)) return null;
        for (const x of s.athletes || []) {
          const n = x.athlete?.displayName;
          if (!n) continue;
          const v = (i) => (x.didNotPlay || !x.stats?.length ? 0 : parseInt(String(x.stats[i]).split('-')[0], 10));
          const o = { key: bpKey(n), name: n, side, pts: v(iP), reb: v(iR), ast: v(iA), tpm: v(i3), stl: v(iS), blk: v(iB), min: v(iM), id: String(x.athlete?.id ?? ''), starter: !!x.starter };
          o.played = !x.didNotPlay && ((o.min || 0) > 0 || [o.pts, o.reb, o.ast, o.stl, o.blk].some((y) => y > 0));
          if ([o.pts, o.reb, o.ast, o.tpm, o.stl, o.blk].some((y) => !Number.isFinite(y))) return null;
          out.push(o);
        }
      }
      const sum = (sd) => out.filter((p) => p.side === sd).reduce((q, p) => q + p.pts, 0);
      if (!out.length || sum('home') !== fin[0] || sum('away') !== fin[1]) return null;
      firsts(d, out);
      for (const p of out) { delete p.id; delete p.starter; }
      return out;
    }
  }
  return null;
}

/* Primeiro cesto (fb: lance livre conta) e primeira assistência (fa) de cada jogador, pelo lance a lance da ESPN.
   Só entra se o lance a lance do jogo todo der exatamente o box score de TODOS os jogadores (pontos = cestos de quem
   marcou, assistências = 2º participante do cesto, rebotes = jogadas de ressalto); senão os campos ficam de fora e
   as apostas esperam. Testado em 12 jogos da NBA de 28/10/2026: 256 jogadores, 0 diferenças. */
function firsts(d, out) {
  const acc = new Map(), z = { pts: 0, reb: 0, ast: 0 };
  const get = (id) => { if (!acc.has(id)) acc.set(id, { ...z }); return acc.get(id); };
  let fb = null, fa = null;
  for (const p of d.plays || []) {
    const ids = (p.participants || []).map((x) => String(x.athlete?.id ?? '')), ast = p.scoringPlay && ids[1] && /assists\)/i.test(p.text || '');
    if (p.scoringPlay && ids[0]) { get(ids[0]).pts += Number(p.scoreValue) || 0; if (!fb) fb = ids[0]; }
    if (ast) { get(ids[1]).ast++; if (!fa) fa = ids[1]; }
    if (/rebound/i.test(p.type?.text || '') && ids[0]) get(ids[0]).reb++;
  }
  if (!out.every((o) => { const x = acc.get(o.id) || z; return o.id && x.pts === o.pts && x.reb === o.reb && x.ast === o.ast; })) return;
  for (const o of out) { if (fb) o.fb = o.id === fb ? 1 : 0; if (fa) o.fa = o.id === fa ? 1 : 0; }
}

/* Hóquei (NHL): marcadores para os mercados de jogadores. goals = gols de cada equipa sem os pênaltis [c, f].
   → { players: [{ key, side, goals }] (quem foi a jogo), order: [{ key, side }] (gols pela ordem, com prorrogação) }
   ou null se o jogo não estiver terminado, se não bater com o placar ou se faltar algum marcador. */
async function hockeyGoals(ev, goals, bpKey) {
  if (OFF) return null;
  const slug = ESPN_LEAGUE[ev.league];
  if (slug !== 'hockey/nhl') return null;
  const t = +ev.date;
  for (const day of [0, -1, 1].map((d) => new Date(t + d * 86400000).toISOString().slice(0, 10).replace(/-/g, ''))) {
    let list;
    try { list = await scoreboard(slug, day); } catch { continue; }
    for (const e of list) {
      const c = e.competitions?.[0];
      if (!c || Math.abs(Date.parse(c.date || e.date) - t) > 6 * 3600000) continue;
      const H = c.competitors?.find((x) => x.homeAway === 'home'), A = c.competitors?.find((x) => x.homeAway === 'away');
      if (!H || !A) continue;
      let swap;
      if (same(ev.home.name, H.team?.displayName) && same(ev.away.name, A.team?.displayName)) swap = false;
      else if (same(ev.home.name, A.team?.displayName) && same(ev.away.name, H.team?.displayName)) swap = true;
      else continue;
      if (!c.status?.type?.completed) return null;
      const r = await fetch(`${BASE}${slug}/summary?event=${encodeURIComponent(e.id)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const d = await r.json();
      const sideOf = (id) => (String(id) === String(H.team?.id) ? (swap ? 'away' : 'home') : String(id) === String(A.team?.id) ? (swap ? 'home' : 'away') : null);
      const players = [];
      for (const tm of d.boxscore?.players || []) {
        const side = sideOf(tm.team?.id);
        if (!side) return null;
        for (const s of tm.statistics || []) {
          const iG = (s.keys || []).indexOf('goals');
          for (const x of s.athletes || []) {
            const n = x.athlete?.displayName;
            if (!n || x.didNotPlay) continue;
            players.push({ key: bpKey(n), side, goals: iG >= 0 ? parseInt(x.stats?.[iG], 10) || 0 : 0 });
          }
        }
      }
      const order = [];
      for (const p of d.plays || []) {
        if (!p.scoringPlay) continue;
        if (/shootout/i.test(`${p.type?.text} ${p.period?.displayValue}`) || p.shootoutPlay) continue;
        const sc = (p.participants || []).find((x) => x.type === 'scorer')?.athlete?.displayName;
        const side = sideOf(p.team?.id);
        if (!sc || !side) return null;
        order.push({ key: bpKey(sc), side });
      }
      const cnt = (sd) => order.filter((x) => x.side === sd).length, pg = (sd) => players.filter((x) => x.side === sd).reduce((q, x) => q + x.goals, 0);
      if (cnt('home') !== goals[0] || cnt('away') !== goals[1] || pg('home') !== goals[0] || pg('away') !== goals[1]) return null;
      return { players, order };
    }
  }
  return null;
}

module.exports = { extraTime, shootout, basketBox, hockeyGoals };
