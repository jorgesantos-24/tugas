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
      return { end, winner, pens, qualified, twoLegs: /leg/i.test(notes), espn: `${H.team?.displayName} ${H.score}-${A.score} ${A.team?.displayName} (${detail})` };
    }
  }
  return null;
}

module.exports = { extraTime };
