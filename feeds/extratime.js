'use strict';
/* Futebol: mercados de prolongamento e penáltis (apura-se, forma de vitória, vence no prolongamento / nos penáltis,
   série de penáltis). A bet365 abre-os e a MoviOdds transmite-os, mas o resultado da MoviOdds pára nos 90 minutos:
   o resultado vem da ESPN (feeds/espn.js). Os que não têm regra aqui (cada penálti, morte súbita, último penálti...)
   continuam abertos e ficam para a equipa. */

const yn = (s) => (/^\s*yes\s*$/i.test(String(s ?? '')) ? 'yes' : /^\s*no\s*$/i.test(String(s ?? '')) ? 'no' : null);
const ou = (s) => (/^\s*over/i.test(String(s ?? '')) ? 'over' : /^\s*under/i.test(String(s ?? '')) ? 'under' : null);
// grupos de prolongamento / penáltis (abertos mesmo sem regra: ficam para a equipa)
const ET_GROUP = /qualif|extra time|shootout|penalties|method of victory|winning method|lift the trophy/i;

function quote(q, m) {
  const g = String(q.group_name ?? '').trim();
  const who = (s) => { const t = String(s ?? '').trim(); return t === m.home ? 'home' : t === m.away ? 'away' : null; };
  const mk = (type, pick, line) => (pick ? { k: 'pet', per: `${type}|${q.group_id}`, pick, ...(line != null ? { line } : {}) } : null);
  const how = (s) => { const t = String(s ?? ''); return /90/.test(t) ? '90' : /extra time/i.test(t) ? 'et' : /penalt/i.test(t) ? 'pens' : null; };
  let x;
  if (g === 'To Qualify' || g === 'To Lift The Trophy') return mk('qualify', who(q.label ?? q.side));
  if (g === 'Method of Victory' || g === 'Winning Method') {
    // "side" = equipa e "line" = como; ou tudo na seleção: "Almeria Extra Time", "UD Castellonense 90 Mins"
    let w = who(q.side), h = how(q.line);
    if (!w || !h) { const mm = /^(.*\S)\s+(90 Mins|Extra Time|Penalties)$/i.exec(String(q.label ?? '').trim()); if (mm) { w = who(mm[1]); h = how(mm[2]); } }
    return w && h ? mk('method', `${w}:${h}`) : null;
  }
  if (g === 'Game Won In Extra Time' || g === 'Result Decided in Extra Time') return mk('wonet', yn(q.label ?? q.side));
  if (g === 'Game Won After Penalties' || g === 'Result Decided on Penalties') return mk('wonpens', yn(q.label ?? q.side));
  if (g === 'To Win Shootout') return mk('shootwin', who(q.label ?? q.side));
  if (g === 'Shootout Correct Score') {
    const mm = /^(.*\S)\s+(\d+)-(\d+)$/.exec(String(q.label ?? '').trim());
    const w = mm && who(mm[1]);
    return w && Number(mm[2]) > Number(mm[3]) ? mk('shootcs', `${w}:${mm[2]}-${mm[3]}`) : null;
  }
  const line = Number(q.handicap ?? q.line);
  if (g === 'Penalties Converted in Shootout Over/Under') return Number.isFinite(line) && line % 1 ? mk('shoottot', ou(q.side ?? q.label), line) : null;
  if ((x = /^(.*\S) Penalties Converted in Shootout$/.exec(g))) { const w = who(x[1]); return w && Number.isFinite(line) && line % 1 ? mk(w === 'home' ? 'shoothome' : 'shootaway', ou(q.side ?? q.label), line) : null; }
  return null;
}

module.exports = { quote, ET_GROUP };
