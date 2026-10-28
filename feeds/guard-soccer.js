'use strict';
/* Proteção das odds do futebol (corre a cada atualização do jogo, antes de chegar ao site).
   A fonte (MoviOdds, leitura não oficial da bet365) às vezes deixa mercados parados horas enquanto o vencedor (1X2)
   vai mudando — 28/10: Fidelis Andria "empate anula: casa" a 1.80 (visto às 10:08) com o 1X2 das 19:10 a pedir ~1.45;
   Bitlis x Kayserispor "casa ou empate" a 4.50 (14:41) com o 1X2 das 18:43 a pedir ~1.9. Regras:
   - o 1X2 é a referência quando concorda com pelo menos um irmão (dupla hipótese, empate anula, handicap ±0,5/0,
     placar exato): sai só o irmão que discorda. Se não concorda com nenhum, saem o 1X2 e os que discordam.
   - "ambas marcam" × placar exato; total de gols: "mais de L" não pode ser menos provável que "mais de L+1".
   Margens (oferta real 28/10, mercados certos): 1X2 × irmãos diferem ≤ ~0,05 → GUARD 0,07; o placar exato da fonte
   não traz "outro resultado" (goleadas) → 0,09. Marcadas aqui (guard); o feeds/moviodds.js tira-as do site. */
const GUARD = 0.07, GUARD_CS = 0.09;
const open = (mk) => mk && mk.sels.length && mk.sels.every((x) => !x.lock);
const tot = (sels) => sels.reduce((q, x) => q + 1 / x.odds, 0);
const prob = (sels, pred) => { const t = tot(sels); return t > 0 ? sels.filter(pred).reduce((q, x) => q + 1 / x.odds, 0) / t : null; };
const lockMk = (mk, sels = mk.sels) => { for (const x of sels) if (!x.lock) { x.lock = true; x.guard = true; } };
const score = (x) => String(x.pick).split('-').map(Number);

function guardSoccer(byK) {
  const ml = byK.get('ml'), dc = byK.get('dc'), dnb = byK.get('dnb'), btts = byK.get('btts'), cs = byK.get('cs'), total = byK.get('total'), spread = byK.get('spread');
  // placar exato utilizável como referência: aberto e com a maior parte das probabilidades (sem "outro resultado")
  const csOk = open(cs) && cs.sels.length >= 10 && tot(cs.sels) > 0.95 && tot(cs.sels) < 2;
  if (open(ml) && ml.sels.length === 3) {
    const p = { home: prob(ml.sels, (s) => s.pick === 'home'), draw: prob(ml.sels, (s) => s.pick === 'draw'), away: prob(ml.sels, (s) => s.pick === 'away') };
    const checks = []; // { mk, sels, ok }
    if (open(dc) && dc.sels.length === 3) {
      const t = tot(dc.sels) / 2; // cada resultado conta em duas escolhas
      const want = { hd: p.home + p.draw, ha: p.home + p.away, da: p.draw + p.away };
      checks.push({ mk: dc, sels: dc.sels, ok: dc.sels.every((s) => want[s.pick] != null && Math.abs((1 / s.odds) / t - want[s.pick]) <= GUARD) });
    }
    if (open(dnb) && dnb.sels.length === 2) checks.push({ mk: dnb, sels: dnb.sels, ok: Math.abs(prob(dnb.sels, (s) => s.pick === 'home') - p.home / (p.home + p.away)) <= GUARD });
    if (open(spread)) {
      // handicap asiático sem placar de referência: casa -0,5 = vitória da casa; 0 = empate anula
      const pair = (lh) => spread.sels.filter((s) => !s.base && ((s.pick === 'home' && s.line === lh) || (s.pick === 'away' && s.line === -lh)));
      const m5 = pair(-0.5), z = pair(0);
      if (m5.length === 2) checks.push({ mk: spread, sels: m5, ok: Math.abs(prob(m5, (s) => s.pick === 'home') - p.home) <= GUARD });
      if (z.length === 2) checks.push({ mk: spread, sels: z, ok: Math.abs(prob(z, (s) => s.pick === 'home') - p.home / (p.home + p.away)) <= GUARD });
    }
    if (csOk) {
      const c = { home: prob(cs.sels, (s) => { const [h, a] = score(s); return h > a; }), draw: prob(cs.sels, (s) => { const [h, a] = score(s); return h === a; }) };
      checks.push({ mk: cs, sels: cs.sels, ok: Math.abs(c.home - p.home) <= GUARD_CS && Math.abs(c.draw - p.draw) <= GUARD_CS });
    }
    if (checks.length) {
      const anyOk = checks.some((c) => c.ok);
      for (const c of checks) if (!c.ok) lockMk(c.mk, c.sels);
      if (!anyOk) lockMk(ml); // o 1X2 não bate com nenhum irmão: não se sabe qual está certo
    }
  }
  // ambas marcam × placar exato
  if (open(btts) && btts.sels.length === 2 && csOk) {
    const a = prob(btts.sels, (s) => s.pick === 'yes'), b = prob(cs.sels, (s) => { const [h, w] = score(s); return h > 0 && w > 0; });
    if (Math.abs(a - b) > GUARD_CS) { lockMk(btts); lockMk(cs); }
  }
  // total de gols: P(mais de L) não pode subir com a linha
  if (total) {
    const byLine = new Map();
    for (const s of total.sels) if (!s.lock && s.line % 1 === 0.5) { if (!byLine.has(s.line)) byLine.set(s.line, []); byLine.get(s.line).push(s); }
    const lines = [...byLine.keys()].filter((l) => byLine.get(l).length === 2).sort((a, b) => a - b);
    for (let i = 1; i < lines.length; i++) {
      const lo = byLine.get(lines[i - 1]), hi = byLine.get(lines[i]);
      if (prob(hi, (s) => s.pick === 'over') - prob(lo, (s) => s.pick === 'over') > 0.02) { lockMk(total, lo); lockMk(total, hi); }
    }
  }
}

module.exports = { guardSoccer, GUARD, GUARD_CS };
