'use strict';
/* UFC (MMA): resultado das lutas e fotos dos lutadores.

   Resultado de uma luta (decisão do dono, 2026-10-28: "se a MoviOdds oferece isso, vamos usar a MoviOdds"):
   - MoviOdds primeiro: o /results traz um objeto "fight" (vencedor, método, round, tempo) que ela lê da Wikipedia.
     Em 28/10 ainda não vinha em nenhuma luta (UFC 333: 0 de 14), por isso:
   - ESPN de reserva: o scoreboard do UFC (quem ganhou, round, tempo, rounds marcados) e a API "core" (método oficial:
     KO/TKO, finalização, decisão unânime/dividida/majoritária, DQ, empate, no contest). 1088 lutas de 2025-26: todas
     com método oficial.
   - As duas com resultado: têm de dizer o mesmo (vencedor, método e round); se não, fica para a equipa.
   Nunca se adivinha: lutador sem correspondência, duas lutas possíveis ou método desconhecido → equipa.

   R de uma luta (markets.js fightOutcome): { done, h, a, fight: { out, method, round, secs, rounds, winner, src } }
     out    = 'home' | 'away' | 'draw' | 'nc' (no contest: tudo devolvido)
     method = 'ko' (KO/TKO, interrupção médica) | 'dq' | 'sub' | 'dec' | 'tdec' (decisão técnica) | 'draw' | 'nc'
     round  = round em que acabou · secs = segundos jogados nesse round (0-300) · rounds = rounds marcados (3/5) ou null */

const SB = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard';
const CORE = 'https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/';
const OFF = process.env.FIGHTS_ESPN === '0'; // desliga a ESPN (resultados só pela MoviOdds; fotos desligadas)
const ROUND_S = 300; // UFC: rounds de 5 minutos

/* ---------- nomes dos lutadores ----------
   As duas fontes escrevem o mesmo lutador de formas diferentes: "Joseph Kropschot" / "Joe Kropschot",
   "Lucia Szabova" / "Lucia Szabová", "Zachary Reese" / "Zach Reese", "Abdul Rakhman" / "Abdul-Rakhman". */
const NICK = {
  joe: 'joseph', joey: 'joseph', zach: 'zachary', zack: 'zachary', alex: 'alexander', mike: 'michael', matt: 'matthew',
  chris: 'christopher', nick: 'nicholas', nate: 'nathan', dan: 'daniel', danny: 'daniel', tony: 'anthony', ben: 'benjamin',
  sam: 'samuel', tom: 'thomas', tommy: 'thomas', tim: 'timothy', timmy: 'timothy', rob: 'robert', bob: 'robert', bobby: 'robert',
  jim: 'james', jimmy: 'james', will: 'william', bill: 'william', billy: 'william', josh: 'joshua', jon: 'jonathan',
  johnny: 'john', jake: 'jacob', steve: 'steven', stephen: 'steven', dave: 'david', ed: 'edward', eddie: 'edward', rick: 'richard',
  ricky: 'richard', fred: 'frederick', freddy: 'frederick', greg: 'gregory', jeff: 'jeffrey', ken: 'kenneth', kenny: 'kenneth',
  pat: 'patrick', pete: 'peter', ray: 'raymond', ron: 'ronald', andy: 'andrew', drew: 'andrew', manny: 'manuel', vince: 'vincent',
  gabe: 'gabriel', max: 'maxim', nik: 'nikita', sasha: 'alexander', kathy: 'katherine', kate: 'katherine', liz: 'elizabeth',
};
const toks = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’`.]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((x) => x && !/^(jr|sr|ii|iii|iv)$/.test(x));
const first = (x) => NICK[x] || x;
const letters = (t) => t.join('').split('').sort().join('');
// 3 = igual · 2 = mesmo apelido e nome compatível (ou as mesmas letras, ex.: "Jeongyeong Lee" / "Lee Jeong-yeong") · 0 = outro
function nameScore(a, b) {
  const A = toks(a), B = toks(b);
  if (!A.length || !B.length) return 0;
  if (A.join(' ') === B.join(' ')) return 3;
  if (A.length >= 2 && B.length >= 2) {
    const sa = A.slice(1).join(''), sb = B.slice(1).join(''); // apelido (pode ter várias palavras)
    const fa = first(A[0]), fb = first(B[0]);
    const firstOk = fa === fb || (Math.min(fa.length, fb.length) >= 3 && (fa.startsWith(fb) || fb.startsWith(fa)));
    if (sa === sb && firstOk) return 2;
  }
  const la = letters(A), lb = letters(B);
  return la.length >= 6 && la === lb ? 2 : 0;
}
/* luta da ESPN (lista de competições) para os dois lutadores da MoviOdds: { c, swap } ou null (nenhuma ou mais de uma) */
function findBout(comps, home, away) {
  const hits = [];
  for (const c of comps) {
    const [x, y] = (c.competitors || []).map((p) => p.athlete?.displayName || p.athlete?.fullName || '');
    if (!x || !y) continue;
    const direct = Math.min(nameScore(home, x), nameScore(away, y)), swapped = Math.min(nameScore(home, y), nameScore(away, x));
    if (direct >= 2 && direct >= swapped) hits.push({ c, swap: false });
    else if (swapped >= 2) hits.push({ c, swap: true });
  }
  return hits.length === 1 ? hits[0] : null;
}
// algum dos lutadores aparece no card (contra outro adversário)? — distingue "luta cancelada" de "nome que não bateu"
const onCard = (comps, name) => comps.some((c) => (c.competitors || []).some((p) => nameScore(name, p.athlete?.displayName || '') >= 2));

/* ---------- ESPN ---------- */
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
const sbCache = new Map(); // intervalo de datas → { at, events }
async function scoreboard(from, to) {
  const k = `${ymd(from)}-${ymd(to)}`;
  const c = sbCache.get(k);
  if (c && Date.now() - c.at < 90000) return c.events;
  const r = await fetch(`${SB}?dates=${k}&limit=200`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`ESPN HTTP ${r.status}`);
  const events = (await r.json()).events || [];
  sbCache.set(k, { at: Date.now(), events });
  if (sbCache.size > 200) sbCache.delete(sbCache.keys().next().value);
  return events;
}
async function coreStatus(eventId, compId) {
  const r = await fetch(`${CORE}${eventId}/competitions/${compId}/status`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`ESPN core HTTP ${r.status}`);
  return r.json();
}
// método oficial da ESPN (status.result.name) → método do site; null = desconhecido (equipa)
function espnMethod(name) {
  const n = String(name || '').toLowerCase();
  if (/no-?contest/.test(n)) return 'nc';
  if (/draw/.test(n)) return 'draw';
  if (/^decision/.test(n)) return /technical/.test(n) ? 'tdec' : 'dec';
  if (/^(kotko|ko|tko)/.test(n)) return 'ko';
  if (/^submission/.test(n)) return 'sub';
  if (/^(dq|disqualification)/.test(n)) return 'dq';
  return null;
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
/* luta já com resultado na ESPN, nos lados do site; null = ainda não; { missing } = o card acabou e a luta não está lá */
async function espnFight(ev) {
  const t = +ev.date;
  const events = await scoreboard(t - 36 * 3600000, t + 36 * 3600000);
  const comps = events.flatMap((e) => (e.competitions || []).map((c) => ({ ...c, eventId: e.id })));
  const hit = findBout(comps, ev.home.name, ev.away.name);
  if (!hit) {
    // card inteiro terminado (todas as lutas do dia acabaram) e a luta não está lá
    const day = comps.filter((c) => Math.abs(Date.parse(c.date) - t) < 18 * 3600000);
    const allDone = day.length > 0 && day.every((c) => c.status?.type?.completed);
    return allDone ? { missing: true, replaced: onCard(day, ev.home.name) || onCard(day, ev.away.name) } : null;
  }
  const { c, swap } = hit;
  if (!c.status?.type?.completed || c.status.type.state !== 'post') return null;
  const st = await coreStatus(c.eventId, c.id);
  const method = espnMethod(st.result?.name);
  const winners = (c.competitors || []).filter((p) => p.winner);
  const round = Number(st.period ?? c.status.period), secs = Math.round(Number(st.clock ?? c.status.clock));
  const rounds = Number(c.format?.regulation?.periods) || null;
  const base = { round, secs, rounds, src: 'espn', detail: st.result?.displayName || '' };
  if (!method || !(round >= 1) || !(secs >= 0 && secs <= ROUND_S)) return { bad: `ESPN: resultado incompleto (${st.result?.name || 'sem método'}, R${round} ${secs}s)` };
  if (method === 'nc' || method === 'draw') {
    if (winners.length) return { bad: `ESPN: ${method} com vencedor` };
    return { ...base, out: method, method };
  }
  if (winners.length !== 1) return { bad: `ESPN: ${winners.length} vencedores` };
  const wi = c.competitors.indexOf(winners[0]); // 0 = primeiro da ESPN
  const out = (wi === 0) !== swap ? 'home' : 'away';
  return { ...base, out, method, winner: winners[0].athlete?.displayName || '' };
}

/* ---------- MoviOdds ---------- */
const MO_METHOD = { 'KO/TKO': 'ko', SUB: 'sub', DEC: 'dec', TD: 'tdec', DQ: 'dq', NC: 'nc' };
// objeto "fight" do /results → luta do site; null = sem resultado; { bad } = resultado que não se percebe
function moviFight(r) {
  const f = r && r.fight;
  if (!f) return null;
  if (f.result === 'no_contest') return { out: 'nc', method: 'nc', round: Number(f.round) || null, secs: null, rounds: null, src: 'moviodds' };
  if (r.status !== 'finished') return null;
  const tm = /^(\d+):(\d{2})$/.exec(String(f.time || '').trim());
  const round = Number(f.round), secs = tm ? Number(tm[1]) * 60 + Number(tm[2]) : null;
  if (!(round >= 1) || secs == null || secs > ROUND_S) return { bad: `MoviOdds: round/tempo ilegível (${f.round} ${f.time})` };
  if (f.result === 'draw') return { out: 'draw', method: 'draw', round, secs, rounds: null, src: 'moviodds' };
  const method = MO_METHOD[f.method];
  if (!method || method === 'nc') return { bad: `MoviOdds: método ${f.method}` };
  if (f.result !== 'home' && f.result !== 'away') return { bad: `MoviOdds: resultado ${f.result}` };
  if ((r.final_score === '1-0') !== (f.result === 'home')) return { bad: `MoviOdds: placar ${r.final_score} não bate com ${f.result}` };
  return { out: f.result, method, round, secs, rounds: null, winner: f.winner || '', src: 'moviodds', detail: f.method_detail || '' };
}

/* resultado final de uma luta do site: null (ainda não), { done: false, note } (equipa) ou R (ver no topo).
   r = linha do /results da MoviOdds (ou undefined: a MoviOdds não a devolve — a luta não chegou a começar). */
async function result(r, ev) {
  const mo = moviFight(r);
  if (mo?.bad) return { done: false, note: mo.bad };
  let es = null;
  if (!OFF) {
    try { es = await espnFight(ev); } catch (e) { if (!mo) return null; } // ESPN fora do ar: com a MoviOdds segue sozinha
  }
  return combine(mo, es, !!r, Date.now() - +ev.date);
}
/* junta as duas fontes (sem pedidos: também usado pelos testes). mo/es = leitura da MoviOdds/ESPN (ou null),
   listed = a MoviOdds devolveu a luta no /results (foi vista ao vivo), age = ms desde a hora marcada */
function combine(mo, es, listed, age) {
  if (mo?.bad) return { done: false, note: mo.bad };
  if (es?.bad && !mo) return { done: false, note: es.bad };
  if (es?.missing) {
    if (mo) es = null; // a MoviOdds tem o resultado: segue com ela
    else if (listed) return { done: false, note: 'luta registada ao vivo pela MoviOdds, mas não encontrada na ESPN' };
    // nenhuma das duas tem a luta e o card acabou: não aconteceu (ou mudou de adversário) → devolvida
    else if (age > 12 * 3600000) return { done: true, h: 0, a: 0, fight: { out: 'nc', method: 'nc', round: null, secs: null, rounds: null, src: 'espn', cancelled: true, replaced: !!es.replaced } };
    else return null;
  }
  if (es?.bad) es = null;
  let f = mo || es;
  if (!f) return null;
  if (mo && es) {
    const same = mo.out === es.out && mo.method === es.method && (mo.out === 'nc' || (mo.round === es.round && Math.abs(mo.secs - es.secs) <= 5));
    if (!same) return { done: false, note: `MoviOdds e ESPN discordam: ${describe(mo)} / ${describe(es)}` };
    f = { ...mo, rounds: es.rounds, src: 'moviodds+espn' };
  }
  const h = f.out === 'home' ? 1 : 0, a = f.out === 'away' ? 1 : 0;
  return { done: true, h, a, fight: f };
}
const M_PT = { ko: 'KO/TKO', dq: 'desqualificação', sub: 'finalização', dec: 'decisão', tdec: 'decisão técnica', draw: 'empate', nc: 'sem resultado (no contest)' };
function describe(f) {
  if (f.cancelled) return f.replaced ? 'luta não aconteceu (mudança de adversário)' : 'luta não aconteceu';
  if (f.out === 'nc') return 'no contest';
  const when = f.round ? ` · ${f.round}º round${f.secs != null ? ` ${mmss(f.secs)}` : ''}` : '';
  return (f.out === 'draw' ? 'Empate' : `Vitória ${f.out === 'home' ? 'da casa' : 'de fora'} por ${M_PT[f.method]}`) + when;
}

/* ---------- fotos dos lutadores (no lugar do emblema) ----------
   Do scoreboard da ESPN (cards da semana passada aos próximos 60 dias): a foto (headshot) se existir, senão a
   bandeira do país. Lido de 6 em 6 h, em segundo plano; as fotos novas são confirmadas uma a uma (HEAD). */
const photos = new Map(); // nome normalizado → url
const checked = new Map(); // id ESPN → url da foto ('' = não tem)
let photosAt = 0, photosBusy = false;
async function loadPhotos() {
  if (OFF || photosBusy) return;
  photosBusy = true;
  try {
    const events = await scoreboard(Date.now() - 7 * 86400000, Date.now() + 60 * 86400000);
    for (const e of events) for (const c of e.competitions || []) for (const p of c.competitors || []) {
      const id = p.athlete?.id || p.id, name = p.athlete?.displayName;
      if (!id || !name) continue;
      if (!checked.has(id)) {
        const url = `https://a.espncdn.com/i/headshots/mma/players/full/${id}.png`;
        let ok = false;
        try { ok = (await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) })).ok; } catch { /* tenta na próxima leitura */ continue; }
        checked.set(id, ok ? url : '');
      }
      const u = checked.get(id) || p.athlete?.flag?.href || '';
      if (u) photos.set(toks(name).join(' '), u);
    }
    photosAt = Date.now();
  } catch (e) { console.error('[UFC] fotos:', e.message); } finally { photosBusy = false; }
}
function photo(name) {
  if (OFF) return '';
  if (Date.now() - photosAt > 6 * 3600000) loadPhotos();
  const k = toks(name).join(' ');
  if (photos.has(k)) return photos.get(k);
  for (const [n, u] of photos) if (nameScore(name, n) >= 2) return u;
  return '';
}

module.exports = { result, combine, moviFight, espnMethod, nameScore, findBout, describe, photo, loadPhotos, ROUND_S };
