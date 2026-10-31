'use strict';
/* Auditoria das odds: cada seleção que o site mostra é comparada com a cotação original da MoviOdds de onde veio.
   Uso: node scripts/auditar-odds.js [tennis soccer basketball hockey esports]   (por omissão: todas)
   Para cada seleção confere, de forma independente da leitura do site:
   1) odd = odd da fonte (arredondada a 2 casas, como a bet365 mostra) — nenhuma odd inventada ou transformada;
   2) lado certo: o jogador/equipa, Mais/Menos, Sim/Não, Par/Ímpar e a linha que o site mostra estão no texto da
      cotação original (apanha lados trocados na leitura);
   3) nenhum mercado completo paga mais do que o possível (apostar em todos os resultados não pode dar lucro);
   4) o "Não" de cada "Sim" (pick X / !X, ou yes / no, na mesma linha) é mesmo o contrário: as duas odds juntas
      não podem prometer menos de 100% (apanha um "Não" da fonte que quer dizer outra coisa, como o de
      Resultado/Faixa de gols, retirado a 2026-10-31). */
const path = require('path');
process.env.MOVIODDS_WS = '0'; process.env.NO_EXTERNAL = '1';
const ROOT = path.join(__dirname, '..');
const TEN = require(path.join(ROOT, 'feeds', 'tennis.js'));
const GEN = require(path.join(ROOT, 'feeds', 'generic.js'));
const F = require(path.join(ROOT, 'feeds', 'moviodds.js'));
const M = require(path.join(ROOT, 'public', 'markets.js'));

// regista de que cotação veio cada leitura (ténis e mercados genéricos: as funções exportadas)
const origin = new Map(); // "match|k|per|pick|line" → cotação original
let curMatch = null;
const wrap = (mod, name) => { const f = mod[name]; mod[name] = (q, m, ...r) => { const s = f(q, m, ...r); if (s && s.pick != null) origin.set(`${curMatch}|${s.k}|${s.per ?? ''}|${s.pick}|${s.line ?? ''}`, q); return s; }; };
wrap(TEN, 'quote'); wrap(GEN, 'quote');

const norm = (x) => String(x ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const SRC = { tennis: 'tennis', soccer: 'soccer', basketball: 'basketball', hockey: 'ice_hockey', esports: 'esports' };

(async () => {
  const sports = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SRC);
  const tot = { selecoes: 0, comOrigem: 0, oddDiferente: 0, ladoErrado: 0, linhaErrada: 0, lucroGarantido: 0, oddsSemFonte: 0, naoErrado: 0 };
  const bad = [];
  for (const sport of sports) {
    let lists;
    try { lists = await Promise.all([`https://moviodds.com/odds?sport=${SRC[sport]}&in_play=1`, `https://moviodds.com/odds?sport=${SRC[sport]}`].map(async (u) => (await fetch(u, { signal: AbortSignal.timeout(90000) })).json())); }
    catch (e) { console.log(`${sport}: fonte indisponível (${e.message})`); continue; }
    const c = { selecoes: 0, comOrigem: 0, oddDiferente: 0, ladoErrado: 0, linhaErrada: 0, lucroGarantido: 0, oddsSemFonte: 0, naoErrado: 0 };
    for (const j of lists) for (const m of j.matches || []) {
      curMatch = m.id; origin.clear(); // só as cotações desta lista (o mesmo jogo pode vir ao vivo e antes do jogo, com odds de momentos diferentes)
      const ev = F.toEvent(m, Date.parse(j.server_time || j.generated_at) || Date.now(), sport, true);
      if (!ev) continue;
      const allOdds = new Set((m.quotes || []).map((q) => Math.round(Number(q.odds_dec) * 100) / 100));
      const H = norm(m.home), A = norm(m.away);
      for (const mk of [...(ev.markets || []), ...(ev.extras || [])]) {
        // 3) mercado completo de 2/3 resultados com lucro garantido
        const byLine = new Map();
        // handicaps: a casa com linha L faz par com fora com linha -L (não com fora na mesma linha)
        const hcp = /spread|pspr/.test(mk.k);
        for (const s of mk.sels) { const k = String(s.line == null ? '' : hcp && String(s.pick).startsWith('away') ? -s.line : s.line); if (!byLine.has(k)) byLine.set(k, []); byLine.get(k).push(s); }
        for (const g of byLine.values()) {
          const p = g.map((s) => String(s.pick)).sort().join(',');
          if (['away,home', 'no,yes', 'even,odd', 'over,under', 'away,draw,home'].includes(p) && g.every((s) => !s.lock) && g.reduce((a, s) => a + 1 / s.odds, 0) < 1) { c.lucroGarantido++; bad.push(`[${sport}] lucro garantido: ${m.home} x ${m.away} ${mk.k} ${g.map((s) => `${s.pick}@${s.odds}`).join(' ')}`); }
        }
        // 4) "Não" que não é o contrário do "Sim"
        const twin = new Map(mk.sels.map((s) => [`${s.pick}@${s.line ?? ''}`, s]));
        for (const s of mk.sels) {
          const p = String(s.pick);
          if (p.startsWith('!') || s.lock) continue;
          const t = twin.get(`!${p}@${s.line ?? ''}`) || (/(^|:)yes$/.test(p) ? twin.get(`${p.replace(/yes$/, 'no')}@${s.line ?? ''}`) : null);
          if (t && !t.lock && 1 / s.odds + 1 / t.odds < 0.97) { c.naoErrado++; bad.push(`[${sport}] "Não" não é o contrário do "Sim": ${m.home} x ${m.away} ${mk.k} ${p} @${s.odds} / ${t.pick} @${t.odds}`); }
        }
        for (const s of mk.sels) {
          c.selecoes++;
          // 1) a odd tem de existir na fonte para este jogo
          if (!allOdds.has(s.odds)) { c.oddsSemFonte++; bad.push(`[${sport}] odd sem fonte: ${m.home} x ${m.away} ${mk.k} ${s.pick} @${s.odds}`); }
          const q = origin.get(`${m.id}|${mk.k}|${mk.per ?? ''}|${s.pick}|${s.line ?? ''}`);
          if (!q) continue; // futebol/basquete/hóquei: leitura interna (só a verificação 1 e 3)
          c.comOrigem++;
          if (Math.abs(Math.round(Number(q.odds_dec) * 100) / 100 - s.odds) > 1e-9) { c.oddDiferente++; bad.push(`[${sport}] odd diferente da cotação: ${m.home} x ${m.away} ${mk.k} ${s.pick} site ${s.odds} fonte ${q.odds_dec}`); }
          // 2) lado: o texto da cotação tem de nomear o lado escolhido
          const txt = norm([q.label, q.side, q.line, q.handicap, q.n2, q.group_name].join(' | '));
          const sideTxt = norm([q.label, q.side, q.line, q.n2].join(' | ')); // n2 = equipa nalguns mercados (ex.: Alternative Team Totals) // sem o nome do grupo (que pode ter o nome do outro jogador)
          const pk = String(s.pick);
          const hasH = sideTxt.includes(H), hasA = sideTxt.includes(A);
          let ok = true;
          const sideOf = pk.startsWith('home') ? 'home' : pk.startsWith('away') ? 'away' : null;
          if (sideOf && mk.k !== 'x') {
            // "home"/"home:15"/"home:yes": o jogador da casa tem de estar na cotação (e o de fora não, quando só um aparece)
            const want = sideOf === 'home' ? hasH : hasA, other = sideOf === 'home' ? hasA : hasH;
            if (!want || (other && !(/ (2|3)-way| tie/.test(txt)) && !(hasH && hasA))) ok = false;
          }
          if (/^(over|under)/.test(pk) && !txt.includes(pk.slice(0, 4))) ok = false;
          if ((pk === 'yes' || pk.endsWith(':yes')) && !/\byes\b/.test(txt)) ok = false;
          if ((pk === 'no' || pk.endsWith(':no')) && !/\bno\b/.test(txt)) ok = false;
          if ((pk === 'odd' || pk === 'even') && !txt.includes(pk)) ok = false;
          if (pk === 'draw' && !/\btie\b|\bdraw\b/.test(txt)) ok = false;
          // placar com lado (game/serviço/tie-break): quem lidera no placar do site tem de ser o lado nomeado na cotação
          if (/^\d+-\d+$/.test(pk) && ['tgsa', 'tfsa', 'ttbsa', 'ttbs'].includes(mk.k)) {
            const [h, a] = pk.split('-').map(Number);
            if (h > a && !hasH) ok = false;
            if (a > h && !hasA) ok = false;
          }
          if (!ok) { c.ladoErrado++; bad.push(`[${sport}] lado: ${m.home} x ${m.away} ${mk.k} ${mk.per ?? ''} site "${s.pick}" ← cotação "${q.group_name} | ${q.label ?? ''} | ${q.side ?? ''} | ${q.line ?? ''}"`); }
          // linha: o número tem de estar na cotação
          if (s.line != null && Number.isFinite(s.line) && mk.k !== 'x') {
            const nums = (txt.match(/[+-]?\d+(\.\d+)?/g) || []).map(Number);
            const ok2 = nums.some((n) => Math.abs(Math.abs(n) - Math.abs(s.line)) < 1e-9) || /,/.test(String(q.handicap ?? q.line)); // linha asiática "3.0, 3.5" = 3.25
            if (!ok2) { c.linhaErrada++; bad.push(`[${sport}] linha: ${m.home} x ${m.away} ${mk.k} site ${s.line} ← "${q.label} | ${q.side} | ${q.line} | ${q.handicap}"`); }
          }
        }
      }
    }
    console.log(`${sport.padEnd(10)} ${String(c.selecoes).padStart(7)} seleções · ${c.comOrigem} com a cotação de origem conferida · odd diferente ${c.oddDiferente} · lado errado ${c.ladoErrado} · linha errada ${c.linhaErrada} · odd sem fonte ${c.oddsSemFonte} · lucro garantido ${c.lucroGarantido} · "Não" errado ${c.naoErrado}`);
    for (const k of Object.keys(tot)) tot[k] += c[k];
    origin.clear();
  }
  const dup = F.guardRemoved.filter((x) => x.includes('[duas odds na fonte]'));
  console.log(`
seleções tiradas por terem duas odds diferentes na fonte: ${dup.length}`); dup.slice(0, 6).forEach((x) => console.log('   ', x.slice(25)));
  const errs = tot.oddDiferente + tot.ladoErrado + tot.linhaErrada + tot.oddsSemFonte + tot.lucroGarantido + tot.naoErrado;
  console.log(`\nTOTAL ${tot.selecoes} seleções · problemas: ${errs}`);
  bad.slice(0, 40).forEach((x) => console.log('  ✘', x));
  process.exit(errs ? 1 : 0);
})();
