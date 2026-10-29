/* Motor do "Criar aposta" — futebol antes do jogo, várias seleções do mesmo jogo numa só odd.
   Testado contra a bet365 (29/10/2026, 60 jogos): mercados sozinhos a 1–4% na maioria; combinações prontas da bet365
   50% iguais e 92% a até 1 degrau da escada de odds; contas conferidas por simulação independente. */
// Um jogo vira 3 blocos independentes de "estados" com probabilidade:
//   golos     (h1,a1,h2,a2)  — Dixon-Coles por tempo
//   escanteios(h1,a1,h2,a2)  — binomial negativa por equipa e tempo
//   cartões   (h,a)          — binomial negativa por equipa
// Jogadores: marcador = cada golo da equipa é dele com prob. s; cartão = cada cartão da equipa é dele com prob. t.
//   Estatísticas (ppFactor): assistência = cada golo da equipa é assistido por ele com prob. a; remates à baliza =
//   os golos dele + Poisson(sot); remates = remates à baliza + Poisson(sh); desarmes, faltas, passes, defesas =
//   binomial negativa própria (sem ligação aos golos).
// Cada seleção é uma função do estado → probabilidade (0..1). Uma combinação = soma dos estados × produto das seleções.

const PLAYERS = require('./players.js'); // cotação de jogador → { estatística, N+, equipa, nome }

const fact = [1]; for (let i = 1; i <= 60; i++) fact[i] = fact[i - 1] * i;
const pois = (k, l) => Math.exp(-l) * l ** k / fact[k];
const lgamma = (z) => { // Lanczos
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let x = c[0]; for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5; return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
};
const nb = (k, mu, r) => (r > 500 ? pois(k, mu) : Math.exp(lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(r / (r + mu)) + k * Math.log(mu / (r + mu))));
// tirar a margem pelo método de potência: p_i = (1/odd_i)^k com Σ p_i = 1 (as odds altas levam mais margem, como nas casas)
const fair = (odds) => {
  const i = odds.map((o) => 1 / o), s = i.reduce((t, x) => t + x, 0);
  if (s <= 1) return i.map((x) => x / s);
  let lo = 1, hi = 3; for (let it = 0; it < 50; it++) { const k = (lo + hi) / 2; if (i.reduce((t, x) => t + x ** k, 0) > 1) lo = k; else hi = k; }
  const k = (lo + hi) / 2; return i.map((x) => x ** k);
};

/* ---------------- blocos de estados ---------------- */
const KG = 8;
function dcm(lh, la, rho) {
  const M = []; let s = 0;
  for (let h = 0; h < KG; h++) { M[h] = []; for (let a = 0; a < KG; a++) {
    let t = 1;
    if (h === 0 && a === 0) t = 1 - lh * la * rho; else if (h === 0 && a === 1) t = 1 + lh * rho; else if (h === 1 && a === 0) t = 1 + la * rho; else if (h === 1 && a === 1) t = 1 - rho;
    M[h][a] = Math.max(0, pois(h, lh) * pois(a, la) * t); s += M[h][a];
  } }
  for (const r of M) for (let a = 0; a < KG; a++) r[a] /= s;
  return M;
}
function goalStates({ lh, la, f, rho }) {
  const A = dcm(lh * f, la * f, rho), B = dcm(lh * (1 - f), la * (1 - f), rho), S = [];
  let t = 0;
  for (let h1 = 0; h1 < KG; h1++) for (let a1 = 0; a1 < KG; a1++) { const p1 = A[h1][a1]; if (p1 < 1e-7) continue;
    for (let h2 = 0; h2 < KG; h2++) for (let a2 = 0; a2 < KG; a2++) { const p = p1 * B[h2][a2]; if (p < 1e-9) continue; S.push({ h1, a1, h2, a2, h: h1 + h2, a: a1 + a2, p }); t += p; } }
  for (const s of S) s.p /= t;
  return S;
}
function countStates({ mh, ma, r, f }, halves, K) {
  const dist = (mu, rr) => { const d = []; let s = 0; for (let k = 0; k < K; k++) { d[k] = nb(k, mu, rr); s += d[k]; } return d.map((x) => x / s); };
  const S = []; let t = 0;
  if (!halves) {
    const H = dist(mh, r), A = dist(ma, r);
    for (let h = 0; h < K; h++) for (let a = 0; a < K; a++) { const p = H[h] * A[a]; if (p > 1e-8) { S.push({ h, a, p }); t += p; } }
  } else {
    // mesma razão média/tamanho nos dois tempos → a soma continua binomial negativa com (m, r)
    const H1 = dist(mh * f, r * f), H2 = dist(mh * (1 - f), r * (1 - f)), A1 = dist(ma * f, r * f), A2 = dist(ma * (1 - f), r * (1 - f));
    for (let h1 = 0; h1 < K; h1++) for (let a1 = 0; a1 < K; a1++) { const p1 = H1[h1] * A1[a1]; if (p1 < 1e-7) continue;
      for (let h2 = 0; h2 < K; h2++) for (let a2 = 0; a2 < K; a2++) { const p = p1 * H2[h2] * A2[a2]; if (p < 1e-9) continue; S.push({ h1, a1, h2, a2, h: h1 + h2, a: a1 + a2, p }); t += p; } }
  }
  for (const s of S) s.p /= t;
  return S;
}
const prob = (S, f) => { let t = 0; for (const s of S) { const v = f(s); if (v) t += s.p * v; } return t; };

/* ---------------- ajuste simples por descida coordenada ---------------- */
function minimize(err, p0, step, lo, hi, iters = 250) {
  let p = p0.slice(), e = err(p), st = step.slice();
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < p.length; i++) for (const d of [1, -1]) {
      const c = p.slice(); c[i] = Math.min(hi[i], Math.max(lo[i], c[i] + d * st[i]));
      const ec = err(c); if (ec < e) { e = ec; p = c; moved = true; }
    }
    if (!moved) { st = st.map((s) => s / 2); if (st.every((s, i) => s < step[i] / 300)) break; }
  }
  return { p, e };
}

/* ---------------- seleções: quote da bet365 → função do estado ----------------
   devolve { b: bloco ('g' golos, 'c' escanteios, 'k' cartões, 'x' sem modelo), f, mk: id do mercado, fam: família,
             pl?: {team, kind, name} para jogadores } ou null se não sabemos modelar */
const RX = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function legOf(m, q) {
  const H = m.home, A = m.away, g = q.group_name;
  const tm = (s) => (s === H ? 'h' : s === A ? 'a' : s === 'Draw' || s === 'Tie' ? 'd' : null);
  const res = (k, x = 'h', y = 'a') => (k === 'h' ? (s) => s[x] > s[y] : k === 'a' ? (s) => s[x] < s[y] : (s) => s[x] === s[y]);
  const rng = (str) => { const mm = String(str).match(/(\d+)\s*-\s*(\d+)/); return mm ? [+mm[1], +mm[2]] : null; };
  const ou = (side, line, val) => { const l = +line; if (!/\.5$/.test(String(line))) return null; return side === 'Over' ? (s) => val(s) > l : side === 'Under' ? (s) => val(s) < l : null; };
  const ex3 = (side, line, val) => { const l = +line; if (!Number.isInteger(l)) return ou(side, line, val); return side === 'Over' ? (s) => val(s) > l : side === 'Under' ? (s) => val(s) < l : side === 'Exactly' ? (s) => val(s) === l : null; };
  const T = (s) => s.h + s.a, T1 = (s) => s.h1 + s.a1, T2 = (s) => s.h2 + s.a2;
  const L = (b, f, fam, mk = g) => (f ? { b, f, fam, mk } : null);
  const dch = (lab, x, y) => { const [u, v] = lab.split(' or ').map(tm); const f1 = res(u, x, y), f2 = res(v, x, y); return (s) => f1(s) || f2(s); };
  const exact = (lab, val) => { if (/No Goal/.test(lab)) return (s) => val(s) === 0; const n = parseInt(lab.replace(/^.* - /, '')); return /\+/.test(lab) ? (s) => val(s) >= n : (s) => val(s) === n; };
  switch (g) {
    // ---------- golos: tempo inteiro ----------
    case 'Full Time Result': return L('g', res(tm(q.label)), 'res');
    case 'Double Chance': return L('g', dch(q.label, 'h', 'a'), 'res');
    case 'Draw No Bet': return null; // anula no empate: fora do Criar aposta
    case 'Goals Over/Under': case 'Alternative Total Goals': return L('g', ou(q.side, q.line, T), 'tot', g + q.line);
    case 'Both Teams To Score': return L('g', q.label === 'Yes' ? (s) => s.h > 0 && s.a > 0 : (s) => !(s.h > 0 && s.a > 0), 'btts');
    case 'Correct Score': { let [x, y] = q.label.split('-').map(Number); if (q.side === A) [x, y] = [y, x]; return L('g', (s) => s.h === x && s.a === y, 'cs'); }
    case 'Team Total Goals': { const [dir, l] = q.label.split(' '); const k = tm(q.side); return L('g', ou(dir, l, k === 'h' ? (s) => s.h : (s) => s.a), 'ttot', g + q.side + l); }
    case 'Match Goals Range': { const r = rng(q.line); return r && L('g', (s) => (T(s) >= r[0] && T(s) <= r[1]) === (q.side === 'Yes'), 'tot', g + q.line); }
    case 'Team Goals Range': { const r = rng(q.handicap), k = tm(q.line); return r && L('g', (s) => (s[k] >= r[0] && s[k] <= r[1]) === (q.side === 'Yes'), 'ttot', g + q.line + q.handicap); }
    case 'Exact Total Goals': return L('g', exact(q.line, T), 'tot');
    case 'Home Team Exact Goals': return L('g', exact(q.label, (s) => s.h), 'ttot');
    case 'Away Team Exact Goals': return L('g', exact(q.label, (s) => s.a), 'ttot');
    case 'Number Of Goals In Match': { const lab = q.label; return L('g', /Under 2/.test(lab) ? (s) => T(s) < 2 : /2 or 3/.test(lab) ? (s) => T(s) === 2 || T(s) === 3 : (s) => T(s) > 3, 'tot'); }
    case 'Winning Margin': { const lab = q.label || q.line || ''; const k = tm(q.side); if (k === 'h' || k === 'a') { const n = parseInt(lab), plus = /\+/.test(lab), sg = k === 'h' ? 1 : -1; return L('g', (s) => (plus ? sg * (s.h - s.a) >= n : sg * (s.h - s.a) === n), 'res'); } if (/Score Draw/.test(lab)) return L('g', (s) => s.h === s.a && s.h > 0, 'res'); if (/No Goal/.test(lab)) return L('g', (s) => T(s) === 0, 'res'); return null; }
    case 'Handicap Result': case 'Alternative Handicap Result': case '1st Half Handicap': case 'Alternative 1st Half Handicap Result': {
      const k = tm(q.side), hc = parseFloat(q.handicap ?? q.line); if (!Number.isInteger(hc)) return null;
      const hh = k === 'h' ? hc : -hc; const half = /1st Half/.test(g); const x = half ? 'h1' : 'h', y = half ? 'a1' : 'a';
      return L('g', k === 'h' ? (s) => s[x] + hh > s[y] : k === 'a' ? (s) => s[y] + hc > s[x] : (s) => s[x] + hh === s[y], half ? 'res1' : 'hc', g + hh); }
    case 'Asian Handicap': case 'Alternative Asian Handicap': case 'Handicap 2-Way': case '1st Half Asian Handicap': case 'Alternative 1st Half Asian Handicap': case '1st Half Handicap 2-Way': {
      const k = tm(q.side), hc = parseFloat(q.handicap ?? q.line ?? q.label); if (!/\.5$/.test(String(Math.abs(hc)))) return null;
      const half = /1st Half/.test(g); const x = half ? 'h1' : 'h', y = half ? 'a1' : 'a';
      return L('g', k === 'h' ? (s) => s[x] + hc > s[y] : (s) => s[y] + hc > s[x], half ? 'res1' : 'hc', g + (k === 'h' ? hc : -hc)); }
    case 'Clean Sheet': { const k = tm(q.side); const f = k === 'h' ? (s) => s.a === 0 : (s) => s.h === 0; return L('g', q.label === 'Yes' ? f : (s) => !f(s), 'ttot', g + q.side); }
    case 'Teams To Score': { const lab = q.label; return L('g', lab === 'Both Teams' ? (s) => s.h > 0 && s.a > 0 : /No Goal/.test(lab) ? (s) => T(s) === 0 : lab.startsWith(H) ? (s) => s.h > 0 && s.a === 0 : (s) => s.a > 0 && s.h === 0, 'btts'); }
    case 'Goals Odd/Even': return L('g', q.label === 'Odd' ? (s) => T(s) % 2 === 1 : (s) => T(s) % 2 === 0, 'oe');
    case '1st Half Goals Odd/Even': return L('g', q.label === 'Odd' ? (s) => T1(s) % 2 === 1 : (s) => T1(s) % 2 === 0, 'oe1');
    case '2nd Half Goals Odd/Even': return L('g', q.label === 'Odd' ? (s) => T2(s) % 2 === 1 : (s) => T2(s) % 2 === 0, 'oe2');
    case 'Home Team Odd/Even Goals': return L('g', /Odd$/.test(q.label) ? (s) => s.h % 2 === 1 : (s) => s.h % 2 === 0, 'ttot', g);
    case 'Away Team Odd/Even Goals': return L('g', /Odd$/.test(q.label) ? (s) => s.a % 2 === 1 : (s) => s.a % 2 === 0, 'ttot', g);
    case 'Specials': { const k = tm(q.side), x = k, y = k === 'h' ? 'a' : 'h', x1 = x + '1', y1 = y + '1', x2 = x + '2', y2 = y + '2';
      if (/Win to Nil/.test(q.line)) return L('g', (s) => s[x] > 0 && s[y] === 0, 'res', g + q.line + k);
      if (/Win Either Half/.test(q.line)) return L('g', (s) => s[x1] > s[y1] || s[x2] > s[y2], 'res', g + q.line + k);
      if (/Win Both Halves/.test(q.line)) return L('g', (s) => s[x1] > s[y1] && s[x2] > s[y2], 'res', g + q.line + k);
      if (/Score in Both Halves/.test(q.line)) return L('g', (s) => s[x1] > 0 && s[x2] > 0, 'ttot', g + q.line + k);
      return null; } // "virar o jogo" depende da ordem dos golos
    case 'First Team To Score': case 'Last Team To Score': { const k = tm(q.label); return { b: 'g', fam: g === 'First Team To Score' ? 'first' : 'last', mk: g, ord: { kind: g === 'First Team To Score' ? 'first' : 'last', team: k || 'none' } }; }
    // ---------- golos: por tempo ----------
    case 'Half Time Result': return L('g', res(tm(q.label), 'h1', 'a1'), 'res1');
    case 'Half Time Double Chance': return L('g', dch(q.label, 'h1', 'a1'), 'res1');
    case '2nd Half Result (Incl. Draw)': return L('g', res(tm(q.label), 'h2', 'a2'), 'res2');
    case 'Half Time Correct Score': { let [x, y] = q.label.split('-').map(Number); if (q.side === A) [x, y] = [y, x]; return L('g', (s) => s.h1 === x && s.a1 === y, 'cs1'); }
    case 'Half Time/Full Time': { const [u, v] = q.label.split(' - ').map(tm); const f1 = res(u, 'h1', 'a1'), f2 = res(v); return L('g', (s) => f1(s) && f2(s), 'htft'); }
    case '1st Half Goals': return L('g', ou(q.side, q.line, T1), 'tot1', g + q.line);
    case '2nd Half Goals': return L('g', ou(q.side, q.line, T2), 'tot2', g + q.line);
    case '1st Half Goals Range': { const r = rng(q.line); return r && L('g', (s) => (T1(s) >= r[0] && T1(s) <= r[1]) === (q.side === 'Yes'), 'tot1', g + q.line); }
    case '2nd Half Goals Range': { const r = rng(q.line); return r && L('g', (s) => (T2(s) >= r[0] && T2(s) <= r[1]) === (q.side === 'Yes'), 'tot2', g + q.line); }
    case 'Exact 1st Half Goals': return L('g', exact(q.line, T1), 'tot1');
    case 'Exact 2nd Half Goals': return L('g', exact(q.line, T2), 'tot2');
    case 'Both Teams To Score In 1st Half': return L('g', q.label === 'Yes' ? (s) => s.h1 > 0 && s.a1 > 0 : (s) => !(s.h1 > 0 && s.a1 > 0), 'btts1');
    case 'Both Teams To Score In 2nd Half': return L('g', q.label === 'Yes' ? (s) => s.h2 > 0 && s.a2 > 0 : (s) => !(s.h2 > 0 && s.a2 > 0), 'btts2');
    case 'Both Teams To Score 1st Half - 2nd Half': { const [u, v] = q.label.split(' / ').map((x) => x === 'Yes'); return L('g', (s) => (s.h1 > 0 && s.a1 > 0) === u && (s.h2 > 0 && s.a2 > 0) === v, 'btts12'); }
    case 'Highest Scoring Half': return L('g', /1st/.test(q.label) ? (s) => T1(s) > T2(s) : /2nd/.test(q.label) ? (s) => T2(s) > T1(s) : (s) => T1(s) === T2(s), 'hsh');
    case 'Home Team Highest Scoring Half': return L('g', /1st/.test(q.label) ? (s) => s.h1 > s.h2 : /2nd/.test(q.label) ? (s) => s.h2 > s.h1 : (s) => s.h1 === s.h2, 'hshh');
    case 'Away Team Highest Scoring Half': return L('g', /1st/.test(q.label) ? (s) => s.a1 > s.a2 : /2nd/.test(q.label) ? (s) => s.a2 > s.a1 : (s) => s.a1 === s.a2, 'hsha');
    case 'To Score In Half': { const k = tm(q.n2), hf = /1st/.test(q.line) ? '1' : '2'; const f = (s) => s[k + hf] > 0; return L('g', q.side === 'Yes' ? f : (s) => !f(s), 'tsh', g + q.n2 + q.line); }
    // combinações prontas (para teste)
    case 'Match Result / Total Goals': { const r = res(tm(q.line)), o = ou(q.side, q.label, T); return o && L('g', (s) => r(s) && o(s), 'combo'); }
    case 'Match Result/Both Teams To Score': { const r = res(tm(q.line)), y = q.side === 'Yes'; return L('g', (s) => r(s) && (s.h > 0 && s.a > 0) === y, 'combo'); }
    case 'Total Goals/Both Teams To Score': { const mm = q.label.match(/(Over|Under) ([\d.]+) & (Yes|No)/); if (!mm) return null; const o = ou(mm[1], mm[2], T); return L('g', (s) => o(s) && (s.h > 0 && s.a > 0) === (mm[3] === 'Yes'), 'combo'); }
    case 'Results/Goals Range': { const r = res(tm(q.line)), rr = rng(q.handicap), y = q.side === 'Yes'; return rr && L('g', (s) => r(s) && (T(s) >= rr[0] && T(s) <= rr[1]) === y, 'combo'); }
    case 'Double Chance/Goals Range': { const r = dch(q.line, 'h', 'a'), rr = rng(q.handicap), y = q.side === 'Yes'; return rr && L('g', (s) => r(s) && (T(s) >= rr[0] && T(s) <= rr[1]) === y, 'combo'); }
    case 'Half Time Result / Total Goals': { const r = res(tm(q.line), 'h1', 'a1'), o = ou(q.side, q.label, T1); return o && L('g', (s) => r(s) && o(s), 'combo'); }
    case 'Half Time Result / Both Teams To Score': { const r = res(tm(q.line), 'h1', 'a1'), y = q.side === 'Yes'; return L('g', (s) => r(s) && (s.h1 > 0 && s.a1 > 0) === y, 'combo'); }
    // ---------- escanteios ----------
    case 'Corners': case 'Alternative Corners': return L('c', ex3(q.side, q.line, T), 'ctot', g + q.line);
    case 'Corners 2-Way': return L('c', ou(q.side, q.line, T), 'ctot', g + q.line);
    case '1st Half Corners': return L('c', ex3(q.side, q.line, T1), 'ctot1', g + q.line);
    case 'Total Corners': { const lab = q.label; let f; const r = rng(lab); if (r) f = (s) => T(s) >= r[0] && T(s) <= r[1]; else if (/Under/.test(lab)) { const n = parseInt(lab.replace(/\D+/, '')); f = (s) => T(s) < n; } else { const n = parseInt(lab.replace(/\D+/, '')); f = (s) => T(s) > n; } return L('c', f, 'ctot'); }
    case 'Team Corners': { const [dir, l] = q.label.split(' '); const k = tm(q.side); return L('c', ou(dir, l, k === 'h' ? (s) => s.h : (s) => s.a), 'cteam', g + q.side + l); }
    case 'Corner Handicap': { const k = tm(q.side), hc = parseFloat(q.handicap); const hh = k === 'h' ? hc : -hc; return L('c', k === 'h' ? (s) => s.h + hh > s.a : k === 'a' ? (s) => s.a + hc > s.h : (s) => s.h + hh === s.a, 'chc', g + hh); }
    case 'Asian Handicap Corners': { const k = tm(q.side), hc = parseFloat(q.handicap); if (!/\.5$/.test(String(Math.abs(hc)))) return null; return L('c', k === 'h' ? (s) => s.h + hc > s.a : (s) => s.a + hc > s.h, 'chc', g + (k === 'h' ? hc : -hc)); }
    case 'Multicorners': { const l = +q.line; if (!/\.5$/.test(q.line)) return null; return L('c', q.side === 'Over' ? (s) => T1(s) * T2(s) > l : (s) => T1(s) * T2(s) < l, 'cmulti'); }
    case 'Asian Corners': case '1st Half Asian Corners': { if (!/\.5$/.test(q.line)) return null; return L('c', ou(q.side, q.line, /1st/.test(g) ? T1 : T), /1st/.test(g) ? 'ctot1' : 'ctot', g + q.line); }
    case 'Team to Get Most': { const k = tm(q.side); const b = q.line === 'Corners' ? 'c' : q.line === 'Cards' ? 'k' : null; if (!b) return null; return L(b, k === 'h' ? (s) => s.h > s.a : k === 'a' ? (s) => s.a > s.h : (s) => s.h === s.a, b === 'c' ? 'cmost' : 'kmost', g + q.line); }
    // ---------- cartões ----------
    case 'Number Of Cards In Match': case 'Asian Total Cards': return /\.5$/.test(q.line) ? L('k', ou(q.side, q.line, T), 'ktot', g + q.line) : null;
    case 'Team Cards': { const [dir, l] = q.label.split(' '); const k = tm(q.side); return L('k', ou(dir, l, k === 'h' ? (s) => s.h : (s) => s.a), 'kteam', g + q.side + l); }
    case 'Card Handicap': { const k = tm(q.side), hc = parseFloat(q.handicap); const hh = k === 'h' ? hc : -hc; return L('k', k === 'h' ? (s) => s.h + hh > s.a : k === 'a' ? (s) => s.a + hc > s.h : (s) => s.h + hh === s.a, 'khc', g + hh); }
    case 'Both Teams to Receive Cards': { if (/Red/.test(q.line)) return null; const n = /2\+/.test(q.line) ? 2 : 1; const f = (s) => s.h >= n && s.a >= n; return L('k', q.side === 'Yes' ? f : (s) => !f(s), 'kboth', g + q.line); }
    // ---------- jogadores ----------
    case 'Goalscorers': case 'Multi Scorers': { const k = tm(q.n2); if (!k) return null;
      const st = ppOf(m, q); if (st) return st; // marca (N+): mesmo modelo dos remates e assistências
      const kind = q.side === 'Anytime' ? 'any' : q.side === 'First' ? 'first' : q.side === 'Last' ? 'last' : q.side === '2 or More' ? 'two' : q.side === '3 or More' ? 'three' : null;
      return kind && { b: 'g', fam: 'pl', mk: g + q.side, pl: { team: k, kind, name: q.line } }; }
    case 'Cards': { const k = tm(q.n2); if (!k || q.side !== 'Booked') return null; return { b: 'k', fam: 'plk', mk: g + q.side, pl: { team: k, kind: 'card', name: q.line } }; }
  }
  return ppOf(m, q); // estatísticas de jogador (remates, assistências, desarmes...)
}
// cotação de jogador (as mesmas que o site abre) → seleção { pp: { team, stat, n, name } } = "faz n ou mais"
function ppOf(m, q) {
  const r = PLAYERS.quote(q, m);
  if (!r) return null;
  const stat = r.per.split('|')[0], [n, side, ...nm] = r.pick.split('#'), name = nm.join('#');
  // sem equipa na cotação (ex.: defesas do guarda-redes): só as estatísticas sem ligação aos golos
  const team = side === 'home' ? 'h' : side === 'away' ? 'a' : IND.includes(stat) ? 'x' : null;
  if (!team || !name || stat === 'sent') return null;
  if (stat === 'booked') return +n === 1 ? { b: 'k', fam: 'plk', mk: 'card' + name, pl: { team, kind: 'card', name } } : null;
  return { b: 'g', fam: 'pp', mk: `pp|${stat}|${name}|${n}`, pp: { team, stat, n: +n, name } };
}

/* ---------------- ajuste de um jogo ----------------
   Para ser rápido, o ajuste não usa os estados completos: cada alvo depende só do placar final, só do 1º tempo ou só
   do 2º tempo, e soma-se numa grelha pequena (máscara pré-calculada). Os estados completos montam-se uma vez no fim. */
const GN = 2 * KG - 1;
const H1G = new Set(['Half Time Result', '1st Half Goals']), H2G = new Set(['2nd Half Goals']), C1G = new Set(['1st Half Corners']);
function maskOf(f, grid, n) {
  const idx = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
    const s = grid === 'ft' ? { h: x, a: y } : grid === 'h1' ? { h1: x, a1: y } : { h2: x, a2: y };
    if (f(s)) idx.push(x * n + y);
  }
  return idx;
}
function fitGoals(m, groups) {
  const T = [];
  for (const g of groups) {
    const sets = {};
    for (const x of m.quotes) { if (x.group_name !== g) continue; const l = legOf(m, x); if (!l || l.b !== 'g' || l.pl || l.ord) continue; (sets[l.mk] ||= []).push({ x, l }); }
    const grid = H1G.has(g) ? 'h1' : H2G.has(g) ? 'h2' : 'ft', n = grid === 'ft' ? GN : KG;
    const wgt = g === 'Correct Score' ? 2 : g === 'Full Time Result' ? 3 : 1;
    for (const set of Object.values(sets)) { if (set.length < 2) continue; const P = fair(set.map((o) => o.x.odds_dec)); set.forEach((o, i) => T.push({ grid, idx: maskOf(o.l.f, grid, n), pt: P[i], w: wgt / set.length })); }
  }
  if (T.length < 3) return null;
  const F = new Float64Array(GN * GN), A1 = new Float64Array(KG * KG), B1 = new Float64Array(KG * KG);
  const err = ([lh, la, f, rho]) => {
    const A = dcm(lh * f, la * f, rho), B = dcm(lh * (1 - f), la * (1 - f), rho);
    F.fill(0);
    for (let h1 = 0; h1 < KG; h1++) for (let a1 = 0; a1 < KG; a1++) { const p = A[h1][a1]; A1[h1 * KG + a1] = p; B1[h1 * KG + a1] = B[h1][a1]; if (p < 1e-9) continue;
      for (let h2 = 0; h2 < KG; h2++) for (let a2 = 0; a2 < KG; a2++) F[(h1 + h2) * GN + a1 + a2] += p * B[h2][a2]; }
    let e = 0;
    for (const t of T) { const G = t.grid === 'ft' ? F : t.grid === 'h1' ? A1 : B1; let s = 0; for (const i of t.idx) s += G[i]; e += t.w * (s - t.pt) ** 2; }
    return e;
  };
  const P = minimize(err, [1.4, 1.1, 0.45, 0], [0.4, 0.4, 0.05, 0.08], [0.1, 0.1, 0.3, -0.25], [5, 5, 0.6, 0.25], 400).p;
  return { lh: P[0], la: P[1], f: P[2], rho: P[3] };
}
function fitCount(m, groups, b, K, def) {
  const T = [];
  for (const g of groups) {
    const sets = {};
    for (const x of m.quotes) { if (x.group_name !== g) continue; const l = legOf(m, x); if (!l || l.b !== b || l.pl) continue; (sets[l.mk] ||= []).push({ x, l }); }
    const grid = C1G.has(g) ? 'h1' : 'ft';
    for (const set of Object.values(sets)) { if (set.length < 2) continue; const P = fair(set.map((o) => o.x.odds_dec)); set.forEach((o, i) => T.push({ grid, idx: maskOf(o.l.f, grid, K), pt: P[i], w: 1 / set.length })); }
  }
  if (T.length < 2) return null;
  const dist = (mu, rr) => { const d = new Float64Array(K); let s = 0; for (let k = 0; k < K; k++) { d[k] = nb(k, mu, rr); s += d[k]; } for (let k = 0; k < K; k++) d[k] /= s; return d; };
  const has1 = T.some((t) => t.grid === 'h1');
  // dispersão em escala logarítmica (r de 1 a 400): passos iguais em qualquer zona
  const err = ([mh, ma, lr, f]) => {
    const r = Math.exp(lr);
    const H = dist(mh, r), A = dist(ma, r), H1 = has1 && dist(mh * f, r * f), A1 = has1 && dist(ma * f, r * f);
    let e = 0;
    for (const t of T) { const X = t.grid === 'ft' ? H : H1, Y = t.grid === 'ft' ? A : A1; let s = 0; for (const i of t.idx) s += X[(i / K) | 0] * Y[i % K]; e += t.w * (s - t.pt) ** 2; }
    return e;
  };
  const P = minimize(err, [def[0], def[1], Math.log(def[2]), def[3]], [1, 1, 0.5, 0.05], [0.3, 0.3, 0, 0.3], [15, 15, 6, 0.6], 400).p;
  return { mh: P[0], ma: P[1], r: Math.exp(P[2]), f: has1 ? P[3] : def[3] };
}
const FIT_G = ['Full Time Result', 'Goals Over/Under', 'Alternative Total Goals', 'Both Teams To Score', 'Team Total Goals', 'Half Time Result', '1st Half Goals', '2nd Half Goals', 'Correct Score'];
const FIT_C = ['Corners', 'Alternative Corners', 'Corners 2-Way', 'Team Corners', '1st Half Corners'];
const FIT_K = ['Number Of Cards In Match', 'Team Cards'];
const CK = 16, KK = 12;
// parâmetros → estados (também serve para refazer as contas mais tarde, com os parâmetros guardados na aposta)
function fromParams(P) {
  const E = { goals: P.goals, G: goalStates(P.goals), corners: P.corners, cards: P.cards, players: P.players || {}, pp: P.pp || {} };
  if (P.corners) E.C = countStates(P.corners, true, CK);
  if (P.cards) E.K = countStates(P.cards, false, KK);
  return E;
}
function build(m) {
  const goals = fitGoals(m, FIT_G);
  if (!goals) return null;
  const corners = fitCount(m, FIT_C, 'c', 26, [5.5, 4.5, 20, 0.47]);
  const cards = fitCount(m, FIT_K, 'k', KK, [2, 2, 20, 0.45]);
  const E = fromParams({ goals, corners, cards });
  E.m = m;
  E.players = fitPlayers(E);
  E.pp = fitPP(E);
  return E;
}

/* jogadores: s = parte dos golos da equipa que são dele.
   Vem do "marca a qualquer momento": P(marca) = Σ P(n golos da equipa)·(1-(1-s)^n). A margem de cada equipa escolhe-se
   para que a soma dos s dos jogadores dê 0.97 (o resto são autogolos e jogadores fora da lista). */
let PLM = 1.1;
function fitPlayers(E) {
  const { m, G } = E; const out = {};
  const any = m.quotes.filter((x) => x.group_name === 'Goalscorers' && x.side === 'Anytime');
  const nd = { h: [], a: [] };
  for (const k of ['h', 'a']) for (let n = 0; n < 16; n++) nd[k][n] = 0;
  for (const st of G) { nd.h[st.h] += st.p; nd.a[st.a] += st.p; }
  const sFor = (k, p) => { let lo = 0, hi = 1; for (let i = 0; i < 40; i++) { const sv = (lo + hi) / 2; let v = 0; for (let n = 1; n < 16; n++) v += nd[k][n] * (1 - (1 - sv) ** n); if (v < p) lo = sv; else hi = sv; } return (lo + hi) / 2; };
  for (const k of ['h', 'a']) {
    const team = k === 'h' ? m.home : m.away, list = any.filter((x) => x.n2 === team);
    if (!list.length) continue;
    const pScore = 1 - nd[k][0];
    // margem fixa por jogador (PLM); a bet365 lista suplentes que podem nem jogar, por isso Σ s não tem de dar 1
    const ss = list.map((x) => sFor(k, Math.min(pScore * 0.999, 1 / x.odds_dec / PLM)));
    list.forEach((x, i) => { out[x.line] = { team: k, s: ss[i] }; });
  }
  // cartões: t = parte dos cartões da equipa que são dele, pelo "Booked" (escala para que a soma bata com o modelo de cartões)
  const booked = m.quotes.filter((x) => (x.group_name === 'Cards' && x.side === 'Booked') || x.group_name === 'Player to be Booked');
  for (const x of booked) {
    const k = x.n2 === m.home ? 'h' : x.n2 === m.away ? 'a' : null; if (!k || !E.K) continue;
    const name = x.group_name === 'Cards' ? x.line : x.label;
    if (out['card:' + name]) continue; // o mesmo jogador nos dois grupos: fica o primeiro
    const pTarget = 1 / x.odds_dec / 1.12; // margem típica dos cartões de jogador
    // resolve t: Σ P(c) (1 - (1-t)^c) = pTarget
    let lo = 0, hi = 1; for (let i = 0; i < 40; i++) { const t = (lo + hi) / 2; const v = prob(E.K, (s) => 1 - (1 - t) ** s[k]); if (v < pTarget) lo = t; else hi = t; }
    (out['card:' + name] = { team: k, t: (lo + hi) / 2 });
  }
  return out;
}

/* estatísticas de jogador: parâmetros de cada um a partir da escada "N ou mais" da bet365 (sem margem: 1/odd/PLM).
   s (golos) e a (assistências): parte dos golos da equipa; sot: remates à baliza além dos golos (Poisson);
   sh: remates fora da baliza (Poisson); ind[estatística] = { mu, r } binomial negativa (desarmes, faltas, passes, defesas) */
const IND = ['tackles', 'fouls', 'fouled', 'passes', 'saves'];
const lpois = (k, l) => (l <= 0 ? (k === 0 ? 1 : 0) : Math.exp(-l + k * Math.log(l) - lgamma(k + 1)));
const tailNB = (k, mu, r = 1e9) => { if (k <= 0) return 1; if (mu <= 0) return 0; let s = 0; for (let i = 0; i < k; i++) s += r > 500 ? lpois(i, mu) : nb(i, mu, r); return Math.max(0, 1 - s); };
const binTail = (n, s, k) => { if (k <= 0) return 1; if (n < k) return 0; let t = 0, c = 1; for (let i = 0; i <= n; i++) { if (i > 0) c = c * (n - i + 1) / i; if (i >= k) t += c * s ** i * (1 - s) ** (n - i); } return t; };
const bisect = (f, target, lo, hi) => { for (let i = 0; i < 40; i++) { const x = (lo + hi) / 2; if (f(x) < target) lo = x; else hi = x; } return (lo + hi) / 2; };
function fitPP(E) {
  const { m, G } = E, out = {};
  const nd = { h: new Array(GN).fill(0), a: new Array(GN).fill(0) };
  for (const st of G) { nd.h[st.h] += st.p; nd.a[st.a] += st.p; }
  // cotações por jogador e estatística: n → probabilidade (a mesma seleção em dois grupos: média)
  const Q = {};
  for (const q of m.quotes) {
    let l; try { l = ppOf(m, q); } catch { continue; }
    if (!l?.pp || !(q.odds_dec > 1)) continue;
    const { name, team, stat, n } = l.pp, x = (Q[name] ||= { team, st: {} });
    if (x.team !== team) continue;
    const r = ((x.st[stat] ||= {})[n] ||= []); r.push(Math.min(0.97, 1 / q.odds_dec / PLM));
  }
  const rungs = (o) => Object.entries(o || {}).map(([n, ps]) => [+n, ps.reduce((a, b) => a + b, 0) / ps.length]).sort((a, b) => a[0] - b[0]);
  for (const [name, { team, st }] of Object.entries(Q)) {
    const D = nd[team] || nd.h, P = { team, ind: {} };
    const teamTail = (k) => D.reduce((t, p, n) => t + (n >= k ? p : 0), 0);
    // golos: s do "marca a qualquer momento" (fitPlayers) ou da escada de golos dele
    const g = team === 'x' ? [] : rungs(st.goals);
    P.s = E.players[name]?.s ?? (g.length ? bisect((s) => D.reduce((t, p, n) => t + p * binTail(n, s, g[0][0]), 0), Math.min(g[0][1], teamTail(g[0][0]) * 0.999), 0, 0.95) : undefined);
    // assistências (ou, sem elas, do "marca ou assiste" com o s já conhecido)
    const a = team === 'x' ? [] : rungs(st.assists), ga = team === 'x' ? [] : rungs(st.ga);
    if (a.length) P.a = bisect((x) => D.reduce((t, p, n) => t + p * binTail(n, x, a[0][0]), 0), Math.min(a[0][1], teamTail(a[0][0]) * 0.999), 0, 0.95);
    else if (ga.length && P.s != null) P.a = Math.max(0, bisect((x) => D.reduce((t, p, n) => t + p * binTail(n, Math.min(0.99, P.s + x), ga[0][0]), 0), Math.min(ga[0][1], teamTail(ga[0][0]) * 0.999), 0, 0.95 - P.s));
    // golos dele: Pg[g] (para os remates)
    const s = P.s || 0, Pg = new Array(GN).fill(0);
    D.forEach((p, n) => { let c = 1; for (let k = 0; k <= n; k++) { if (k > 0) c = c * (n - k + 1) / k; Pg[k] += p * c * s ** k * (1 - s) ** (n - k); } });
    const fit1 = (R, model, hi) => minimize(([x]) => R.reduce((e, [k, pt]) => e + (model(k, x) - pt) ** 2, 0), [hi / 8], [hi / 8], [0], [hi], 120).p[0];
    const sot = team === 'x' ? [] : rungs(st.sot), sh = team === 'x' ? [] : rungs(st.shots);
    if (sot.length) P.sot = fit1(sot, (k, mu) => Pg.reduce((t, p, gg) => t + p * tailNB(k - gg, mu), 0), 12);
    if (sh.length) P.sh = fit1(sh, (k, nu) => Pg.reduce((t, p, gg) => t + p * tailNB(k - gg, (P.sot || 0) + nu), 0), 20);
    for (const stat of IND) {
      const R = rungs(st[stat]);
      if (!R.length) continue;
      const top = Math.max(2, R[R.length - 1][0] * 2);
      if (R.length === 1) { P.ind[stat] = { mu: bisect((mu) => tailNB(R[0][0], mu), R[0][1], 0, top * 2), r: 1e9 }; continue; }
      const f = minimize(([mu, lr]) => R.reduce((e, [k, pt]) => e + (tailNB(k, mu, Math.exp(lr)) - pt) ** 2, 0), [R[0][0] + 1, 2], [top / 6, 0.5], [0.05, 0], [top * 2, 7], 200).p;
      P.ind[stat] = { mu: f[0], r: Math.exp(f[1]) };
    }
    out[name] = P;
  }
  return out;
}
// o motor sabe esta estatística deste jogador?
function ppHas(E, { stat, name }) {
  const P = E.pp[name], s = P?.s ?? E.players[name]?.s;
  if (stat === 'goals') return s > 0;
  if (stat === 'assists') return P?.a > 0;
  if (stat === 'ga') return s > 0 && P?.a != null;
  if (stat === 'sot') return P?.sot != null;
  if (stat === 'shots') return P?.sh != null;
  return !!P?.ind?.[stat];
}
/* seleções de estatística de jogador → { c (parte sem ligação aos golos), h[n], a[n] (probabilidade com n golos da
   equipa) } ou null. Cada golo da equipa: marcado por um dos escolhidos (s) ou outro; assistido por outro escolhido
   (a, nunca quem marcou) ou ninguém da lista. Golos e assistências contam-se até onde as seleções precisam. */
const LINKED = ['goals', 'assists', 'ga', 'sot', 'shots'];
// as mesmas seleções de jogador repetem-se muito (odds do Criar aposta aberto): a conta fica guardada no motor
function ppFactor(E, legs) {
  const memo = (E.ppm ||= new Map()), key = legs.map((l) => `${l.pp.name}|${l.pp.stat}|${l.pp.n}`).sort().join('~');
  if (memo.has(key)) return memo.get(key);
  if (memo.size > 20000) memo.clear();
  const r = ppFactorRaw(E, legs);
  memo.set(key, r);
  return r;
}
function ppFactorRaw(E, legs) {
  const need = {};
  for (const { pp: { team, stat, n, name } } of legs) {
    const x = (need[name] ||= { name, team, goals: 0, assists: 0, ga: 0, sot: 0, shots: 0, ind: {} });
    if (x.team !== team) return null;
    if (LINKED.includes(stat)) x[stat] = Math.max(x[stat], n); else x.ind[stat] = Math.max(x.ind[stat] || 0, n);
  }
  let c = 1;
  for (const x of Object.values(need)) for (const [stat, n] of Object.entries(x.ind)) { const d = E.pp[x.name]?.ind?.[stat]; if (!d) return null; c *= tailNB(n, d.mu, d.r); }
  const out = { c };
  for (const t of ['h', 'a']) {
    const ps = Object.values(need).filter((x) => x.team === t && LINKED.some((k) => x[k]));
    if (!ps.length) continue;
    const S = ps.map((x) => E.pp[x.name]?.s ?? E.players[x.name]?.s ?? 0), A = ps.map((x) => E.pp[x.name]?.a ?? 0);
    const sum = (v) => v.reduce((a, b) => a + b, 0);
    const tot = sum(S); if (tot > 1) for (let i = 0; i < S.length; i++) S[i] /= tot;
    const sOther = Math.max(0, 1 - sum(S));
    const Q = A.map((a, i) => Math.min(0.95, a / Math.max(0.05, 1 - S[i])));
    const capG = ps.map((x) => Math.max(x.goals, x.ga, x.sot, x.shots)), capA = ps.map((x) => Math.max(x.assists, x.ga));
    // remates (à baliza) com g golos dele: P(g + Y ≥ sot e g + Y + Z ≥ shots)
    const shotOk = ps.map((x, i) => { const P = E.pp[x.name] || {}, mu = P.sot || 0, nu = P.sh || 0;
      return Array.from({ length: capG[i] + 1 }, (_, g) => { if (!x.sot && !x.shots) return 1;
        let v = 0; for (let y = 0; y < 40; y++) { const py = lpois(y, mu); if (g + y >= x.sot) v += py * tailNB(x.shots - g - y, nu); if (y > mu && py < 1e-12) break; } return v; }); });
    const val = (st) => { let v = 1; for (let i = 0; i < ps.length; i++) { const g = st[2 * i], a = st[2 * i + 1], x = ps[i];
      if (g < x.goals || a < x.assists || g + a < x.ga) return 0; v *= shotOk[i][g]; if (!v) return 0; } return v; };
    // golo a golo; arr[n] = probabilidade de as seleções baterem com n golos da equipa
    let dp = new Map([[new Array(2 * ps.length).fill(0).join(','), 1]]);
    const arr = new Array(GN).fill(0);
    for (let n = 0; n < GN; n++) {
      for (const [k, pr] of dp) arr[n] += pr * val(k.split(',').map(Number));
      if (n === GN - 1) break;
      const nd = new Map();
      const add = (st, pr) => { const k = st.join(','); nd.set(k, (nd.get(k) || 0) + pr); };
      for (const [k, pr] of dp) {
        const st = k.split(',').map(Number);
        for (let j = -1; j < ps.length; j++) {
          const pj = j < 0 ? sOther : S[j]; if (!(pj > 0)) continue;
          const sj = st.slice(); if (j >= 0) sj[2 * j] = Math.min(capG[j], sj[2 * j] + 1);
          // assistência: um dos outros escolhidos ou ninguém da lista. Q[i] = a/(1-s): a assistência nos golos que não
          // são dele, para que no total ele assista a parte a dos golos da equipa (como no ajuste)
          let rest = 1;
          for (let i = 0; i < ps.length; i++) { if (i === j || !(Q[i] > 0)) continue; const pa = Math.min(rest, Q[i]); if (!(pa > 0)) continue; rest -= pa;
            const si = sj.slice(); si[2 * i + 1] = Math.min(capA[i], si[2 * i + 1] + 1); add(si, pr * pj * pa); }
          if (rest > 0) add(sj, pr * pj * rest);
        }
      }
      dp = nd;
    }
    out[t] = arr;
  }
  return out;
}

/* ---------------- probabilidade de uma combinação ---------------- */
// legs: { b, f } normais; { ord } primeira/última equipa a marcar; { pl } jogadores; { pp } estatísticas de jogador.
// Blocos independentes (golos, escanteios, cartões) multiplicam-se; dentro do bloco soma-se estado a estado.
const BLOCKS = ['g', 'c', 'k'];
const statesOf = (E, b) => (b === 'g' ? E.G : b === 'c' ? E.C : E.K);
/* peso de cada estado com as seleções (W.v[bloco][i] = p do estado × seleções; null = bloco sem seleções) e a parte
   sem estados (W.c). joint = W.c × Π Σ W.v. Guardado, junta-se mais uma seleção sem refazer as outras (jointPlus) */
function weights(E, legs) {
  const W = { c: 1, v: {}, sum: {}, legs };
  for (const b of BLOCKS) {
    const L = legs.filter((l) => l.b === b);
    W.v[b] = null; W.sum[b] = 1;
    if (!L.length) continue;
    const S = statesOf(E, b); if (!S) return null;
    const plain = L.filter((l) => !l.pl && !l.ord && !l.pp);
    const spec = prepSpecial(E, L.filter((l) => l.pl || l.ord));
    if (spec === null) return null;
    if (spec === 0) { W.zero = true; return W; }
    const PP = L.filter((l) => l.pp);
    // 1º/último marcador e estatísticas do mesmo jogador: o modelo não os junta
    if (PP.length && L.some((l) => l.pl && PP.some((x) => x.pp.name === l.pl.name))) return null;
    const pf = PP.length ? ppFactor(E, PP) : null;
    if (PP.length && !pf) return null;
    if (pf) W.c *= pf.c;
    const vec = new Float64Array(S.length); let sum = 0;
    for (let i = 0; i < S.length; i++) {
      const s = S[i]; let v = s.p;
      for (const l of plain) { v *= l.f(s); if (!v) break; }
      if (v && spec) v *= spec(s);
      if (v && pf) { if (pf.h) v *= pf.h[s.h]; if (pf.a) v *= pf.a[s.a]; }
      vec[i] = v; sum += v;
    }
    W.v[b] = vec; W.sum[b] = sum;
  }
  return W;
}
const wTotal = (W) => (W.zero ? 0 : BLOCKS.reduce((p, b) => p * W.sum[b], W.c));
function joint(E, legs) { const W = weights(E, legs); return W ? wTotal(W) : null; }
// joint(E, [...W.legs, l]) sem refazer as seleções de W, quando a nova não mexe nas contas delas
function jointPlus(E, W, l) {
  if (!W) return null;
  if (W.zero) return 0;
  const legs = W.legs, others = (b) => BLOCKS.reduce((p, x) => (x === b ? p : p * W.sum[x]), W.c);
  const pass = (b, f) => { const S = statesOf(E, b); if (!S) return null; const v = W.v[b]; let t = 0; for (let i = 0; i < S.length; i++) { const w = v ? v[i] : S[i].p; if (w) t += w * f(S[i]); } return t; };
  // cartão de um jogador sem outro cartão de jogador da mesma equipa escolhido: só depende dos cartões da equipa
  // (1 - (1-t)^cartões), como uma seleção normal
  const card = l.pl?.kind === 'card' ? E.players['card:' + l.pl.name] : null;
  if (card && !l.f) l.f = (s) => 1 - (1 - card.t) ** s[card.team];
  // 1º/último marcador ou equipa sem outra seleção destas no bloco (nem estatísticas do mesmo jogador): é só uma
  // função do estado, que multiplica com as outras (como em weights)
  const lone = (l.pl || l.ord) && !legs.some((x) => x.b === l.b && (x.pl || x.ord)) && !(l.pl && legs.some((x) => x.pp?.name === l.pl.name));
  if (lone && !l.f) { const sp = prepSpecial(E, [l]); if (sp === null) return null; l.f = sp === 0 ? () => 0 : sp; }
  const simple = !l.pp && (lone || (!l.pl && !l.ord) || (card && !legs.some((x) => x.pl?.kind === 'card' && E.players['card:' + x.pl.name]?.team === card.team)));
  if (simple) {
    const S = statesOf(E, l.b); if (!S) return null;
    const fv = (l._fv ||= Float64Array.from(S, (s) => l.f(s))), v = W.v[l.b];
    // grupo sem seleções neste bloco: a probabilidade da seleção sozinha (guardada; os escanteios têm muitos estados)
    if (!v) { if (l._m == null) { let m = 0; for (let i = 0; i < S.length; i++) if (fv[i]) m += S[i].p * fv[i]; l._m = m; } return others(l.b) * l._m; }
    let t = 0; for (let i = 0; i < S.length; i++) { const w = v[i]; if (w && fv[i]) t += w * fv[i]; }
    return others(l.b) * t;
  }
  if (l.pp && !legs.some((x) => x.pp?.name === l.pp.name || x.pl?.name === l.pp.name)) {
    const { stat, n, name, team } = l.pp;
    if (!LINKED.includes(stat)) { const d = E.pp[name]?.ind?.[stat]; return d ? wTotal(W) * tailNB(n, d.mu, d.r) : null; }
    if (!legs.some((x) => x.pp && x.pp.team === team && LINKED.includes(x.pp.stat))) {
      const pc = (E.ppc ||= new Map()), key = `${name}|${stat}|${n}`;
      if (!pc.has(key)) pc.set(key, ppFactor(E, [l]));
      const pf = pc.get(key); if (!pf) return null;
      const arr = pf[team], t = pass('g', (s) => arr[s[team]]);
      return t == null ? null : others('g') * pf.c * t;
    }
  }
  // estatística ligada aos golos de uma equipa que já tem escolhidas: pesos sem as seleções de jogador dessa equipa
  // (guardados) × a conta dos jogadores dela junta com a nova
  if (l.pp && LINKED.includes(l.pp.stat) && !legs.some((x) => x.pl)) {
    const team = l.pp.team, mine = legs.filter((x) => x.pp?.team === team);
    const W0 = ((W.noTeam ||= {})[team] ??= weights(E, legs.filter((x) => !mine.includes(x))));
    if (!W0) return null;
    if (W0.zero) return 0;
    const pf = ppFactor(E, [...mine, l]); if (!pf) return null;
    const S = E.G, v = W0.v.g, arr = pf[team]; let t = 0;
    for (let i = 0; i < S.length; i++) { const w = v ? v[i] : S[i].p; if (w) t += w * arr[S[i][team]]; }
    return BLOCKS.reduce((p, x) => (x === 'g' ? p : p * W0.sum[x]), W0.c) * pf.c * t;
  }
  return joint(E, [...legs, l]);
}
// junta seleções de ordem e de jogadores numa função do estado
function prepSpecial(E, L) {
  if (!L.length) return undefined;
  let first, last; const pls = {};
  const setOrd = (k, v) => { if (k === 'first') { if (first && first.key !== v.key) return false; first = v; } else { if (last && last.key !== v.key) return false; last = v; } return true; };
  for (const l of L) {
    if (l.ord) { if (!setOrd(l.ord.kind, { team: l.ord.team, key: l.ord.team })) return 0; continue; }
    const { kind, name } = l.pl, isCard = kind === 'card', key = (isCard ? 'card:' : '') + name, info = E.players[key];
    if (!info) return null;
    const P = (pls[key] ||= { team: info.team, w: isCard ? info.t : info.s, card: isCard, min: 0, name });
    if (kind === 'first' || kind === 'last') { if (!setOrd(kind, { team: info.team, key: name, player: P })) return 0; P.min = Math.max(P.min, 1); }
    else P.min = Math.max(P.min, kind === 'two' ? 2 : kind === 'three' ? 3 : 1);
  }
  // a equipa da 1ª/última seleção de jogador tem de bater com a seleção de equipa (se as duas existirem, setOrd já garantiu a mesma chave… mas equipa vs jogador têm chaves diferentes)
  for (const l of L) if (l.ord) { const o = l.ord.kind === 'first' ? first : last; if (o.player && o.team !== l.ord.team) return 0; }
  const list = Object.values(pls);
  // limitar: as fatias dos jogadores escolhidos de uma equipa não podem passar de 100%
  for (const card of [false, true]) for (const t of ['h', 'a']) { const g = list.filter((x) => x.card === card && x.team === t), tot = g.reduce((s, x) => s + x.w, 0); if (tot > 1) for (const x of g) x.w /= tot; }
  return (s) => {
    let v = 1;
    const T = s.h + s.a; const des = { h: [], a: [] }; // golos com dono já definido (1º/último)
    if (first || last) {
      if ((first && first.team === 'none') || (last && last.team === 'none')) { if (T !== 0) return 0; if ((first && first.team !== 'none') || (last && last.team !== 'none')) return 0; }
      else {
        if (T === 0) return 0;
        const fh = s.h1 + s.a1 ? '1' : '2', lh = s.h2 + s.a2 ? '2' : '1';
        const cnt = (t, h) => s[t + h];
        if (first && last && fh === lh) { // os dois no mesmo tempo
          const n = s['h' + fh] + s['a' + fh];
          if (n === 1) { if (first.team !== last.team || (first.player && last.player && first.player !== last.player)) return 0; v *= cnt(first.team, fh) / n; des[first.team].push(first.player || last.player || null); }
          else { v *= cnt(first.team, fh) / n * (cnt(last.team, fh) - (first.team === last.team ? 1 : 0)) / (n - 1); des[first.team].push(first.player || null); des[last.team].push(last.player || null); }
        } else {
          if (first) { v *= cnt(first.team, fh) / (s['h' + fh] + s['a' + fh]); des[first.team].push(first.player || null); }
          if (last) { v *= cnt(last.team, lh) / (s['h' + lh] + s['a' + lh]); des[last.team].push(last.player || null); }
        }
        if (!v) return 0;
      }
    }
    for (const card of [false, true]) for (const t of ['h', 'a']) {
      const g = list.filter((x) => x.card === card && x.team === t);
      if (!g.length) continue;
      let n = s[t];
      const mins = g.map((x) => x.min);
      if (!card) for (const d of des[t]) { n--; if (d) { v *= d.w; mins[g.indexOf(d)]--; } else v *= 1; }
      // golos com dono "qualquer jogador da equipa" (1º/último sem jogador) não mudam nada: são golos da equipa de quem quer que seja
      if (!card && des[t].some((d) => !d)) {
        // esses golos ainda podem ser dos jogadores escolhidos: devolve-os à conta
        const free = des[t].filter((d) => !d).length; n += free;
      }
      if (n < 0) return 0;
      v *= atLeast(n, g.map((x, i) => ({ w: x.w, min: Math.max(0, mins[i]) })));
      if (!v) return 0;
    }
    return v;
  };
}
// P(cada jogador i tem ≥ min_i) com n golos (ou cartões) repartidos: cada um é do jogador i com prob. w_i, senão de outro
function atLeast(n, need) {
  const k = need.length, w = need.map((x) => x.w), other = Math.max(0, 1 - w.reduce((t, x) => t + x, 0));
  if (need.every((x) => x.min === 0)) return 1;
  let dp = new Map([[need.map((x) => x.min).join(','), 1]]);
  for (let g = 0; g < n; g++) {
    const nd = new Map();
    for (const [key, pr] of dp) {
      const st = key.split(',').map(Number);
      for (let i = 0; i < k; i++) { const ns = st.slice(); ns[i] = Math.max(0, ns[i] - 1); const kk = ns.join(','); nd.set(kk, (nd.get(kk) || 0) + pr * w[i]); }
      if (other > 0) nd.set(key, (nd.get(key) || 0) + pr * other);
    }
    dp = nd;
  }
  return dp.get(Array(k).fill(0).join(',')) || 0;
}

/* margem: odd = 1 / (e^a · p^b), arredondada para baixo na escada da bet365 */
const LADDER = [1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.1, 1.11, 1.12, 1.14, 1.16, 1.18, 1.2, 1.22, 1.25, 1.28, 1.3, 1.33, 1.36, 1.4, 1.44, 1.5, 1.53, 1.57, 1.6, 1.61, 1.66, 1.72, 1.8, 1.83, 1.9, 2, 2.05, 2.1, 2.2, 2.25, 2.3, 2.37, 2.4, 2.5, 2.6, 2.62, 2.75, 2.87, 3, 3.1, 3.2, 3.25, 3.4, 3.5, 3.6, 3.75, 4, 4.33, 4.5, 4.75, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 11, 12, 13, 15, 17, 19, 21, 23, 26, 29, 34, 41, 51, 67, 81, 101, 126, 151, 201, 251, 301, 401, 501, 1001];
function price(p, cal, round = true) {
  const o = 1 / (Math.exp(cal.a) * p ** cal.b);
  if (!round) return o;
  let best = LADDER[0]; for (const x of LADDER) if (x <= o * 1.0001) best = x; return best;
}


/* ---------------- preço no site ----------------
   odd = 1 / (e^a · p^b) — a margem da bet365 medida nas combinações dela (cresce com a odd: ~6% a 2.0, ~13% a 10) —
   mais as correções por tipo de par de seleções (ex.: empate + mais golos a bet365 paga menos que a conta pura)
   e a nossa margem extra; arredonda-se para baixo na escada de odds. */
const CAL = {"a": -0.01585, "b": 0.92141};
const CORR = {"res:fav+faixa:yes": -0.0158, "res:fav+faixa:no": -0.0197, "res:empate+faixa:yes": 0.0652, "res:empate+faixa:no": 0.0292, "res:azarão+faixa:yes": -0.0682, "res:azarão+faixa:no": -0.0816, "dupla:azarão/empate+faixa:yes": 0.0085, "dupla:azarão/empate+faixa:no": 0.0163, "dupla:azarão/fav+faixa:yes": -0.0022, "dupla:azarão/fav+faixa:no": -0.0064, "dupla:empate/fav+faixa:yes": 0.0205, "dupla:empate/fav+faixa:no": 0.0307, "res:fav+ambas:yes": 0.0106, "res:fav+ambas:no": 0.0023, "res:empate+ambas:yes": 0.0901, "res:empate+ambas:no": 0.144, "res:azarão+ambas:yes": 0.0017, "res:azarão+ambas:no": -0.0219, "tot:over+ambas:yes": 0.0476, "tot:over+ambas:no": 0.0155, "tot:under+ambas:yes": 0.0866, "tot:under+ambas:no": 0.0209, "int:fav+ambas1:yes": 0.0147, "int:fav+ambas1:no": -0.0013, "int:empate+ambas1:yes": 0.0539, "int:empate+ambas1:no": 0.0508, "int:azarão+ambas1:yes": 0.0502, "int:azarão+ambas1:no": 0.0201, "res:fav+tot:over": 0.015, "res:fav+tot:under": -0.0248, "res:empate+tot:over": 0.1214, "res:empate+tot:under": 0.0865, "res:azarão+tot:over": 0.0266, "res:azarão+tot:under": -0.039, "int:fav+tot1:over": 0.0241, "int:fav+tot1:under": 0.0112, "int:empate+tot1:over": 0.0431, "int:empate+tot1:under": 0.0383, "int:azarão+tot1:over": 0.0322, "int:azarão+tot1:under": 0.0423};
const EXTRA = 1.03;     // margem extra (+3%) sobre a da bet365
const MAX_LEGS = 6;     // como a bet365
const CHECK = 0.25;     // seleção cujo preço sozinho no modelo foge mais de 25% da odd mostrada: fora do Criar aposta

// etiqueta de cada seleção para as correções de pares
function tagOf(E, l) {
  const q = l.q; if (!q) return null;
  const m = E.m, fav = E.goals.lh >= E.goals.la ? 'h' : 'a';
  const side = (s) => (s === 'Draw' || s === 'Tie' ? 'empate' : (s === m.home ? 'h' : s === m.away ? 'a' : null) === fav ? 'fav' : 'azarão');
  switch (q.group_name) {
    case 'Full Time Result': return 'res:' + side(q.label);
    case 'Double Chance': return 'dupla:' + q.label.split(' or ').map(side).sort().join('/');
    case 'Goals Over/Under': case 'Alternative Total Goals': return 'tot:' + String(q.side).toLowerCase();
    case 'Match Goals Range': return 'faixa:' + String(q.side).toLowerCase();
    case 'Both Teams To Score': return 'ambas:' + String(q.label).toLowerCase();
    case 'Half Time Result': return 'int:' + side(q.label);
    case '1st Half Goals': return 'tot1:' + String(q.side).toLowerCase();
    case 'Both Teams To Score In 1st Half': return 'ambas1:' + String(q.label).toLowerCase();
  }
  return null;
}
function corrOf(E, legs) {
  const t = legs.map((l) => tagOf(E, l));
  let c = 0;
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
    if (!t[i] || !t[j]) continue;
    c += CORR[`${t[i]}+${t[j]}`] ?? CORR[`${t[j]}+${t[i]}`] ?? 0;
  }
  return c;
}
const ladderDown = (o) => { let best = 1; for (const x of LADDER) if (x <= o * 1.0001) best = x; return best; };
const oddOf = (p, c = 0) => 1 / (Math.exp(CAL.a + c) * p ** CAL.b) / EXTRA;
/* juntar uma seleção nunca baixa a odd: a combinação paga pelo menos o que paga qualquer parte dela (cada seleção
   sozinha à odd mostrada; cada grupo menor à odd do modelo). Ex.: Flamengo 1.83 + 3+ escanteios = 1.83, não 1.72.
   pOf(mask) = probabilidade das seleções do grupo (bits de mask); singles = odd mostrada de cada uma */
function floorOdds(E, legs, singles, pOf) {
  const n = legs.length, full = (1 << n) - 1;
  let best = Math.max(...singles);
  for (let mask = 1; mask < full; mask++) {
    if ((mask & (mask - 1)) === 0) continue; // uma seleção só: já está em singles
    const pt = pOf(mask);
    if (pt == null || pt < 1e-4) continue;
    best = Math.max(best, ladderDown(oddOf(pt, corrOf(E, legs.filter((_, i) => (mask >> i) & 1)))));
  }
  return best;
}

// seleção do site (cotação da bet365) → seleção do motor; null se o motor não a sabe calcular
// (guardada no motor por cotação: as contas de cada estado ficam na seleção e não se refazem a cada pedido)
function legFor(E, q) {
  const c = (E.lf ||= new WeakMap());
  if (!c.has(q)) c.set(q, legRaw(E, q));
  return c.get(q);
}
function legRaw(E, q) {
  const l = legOf(E.m, q);
  if (!l || l.fam === 'combo') return null;
  if (l.b === 'c' && !E.C) return null;
  if (l.b === 'k' && !E.K) return null;
  if (l.pl && !E.players[(l.pl.kind === 'card' ? 'card:' : '') + l.pl.name]) return null;
  if (l.pp && !ppHas(E, l.pp)) return null;
  l.q = q;
  return l;
}

/* uma seleção por mercado (como na bet365): duas do mesmo mercado ou não podem acontecer juntas ou são outra
   seleção disfarçada (dupla chance "Casa ou empate" + "Fora ou empate" = só o empate, que o modelo pagava acima da odd
   do próprio empate). Jogadores ficam de fora: dois marcadores ou dois amarelos diferentes juntam-se. */
const sameMarket = (a, b) => a.mk === b.mk && !a.pl && !b.pl;

/* preço de uma combinação do mesmo jogo.
   legs: [{ q (cotação da bet365), odds (odd mostrada) }] → { odds, params } ou { reason } */
function quote(E, items) {
  if (items.length < 2) return { reason: 'escolha pelo menos 2 seleções' };
  if (items.length > MAX_LEGS) return { reason: `máximo de ${MAX_LEGS} seleções por jogo` };
  const legs = [];
  for (const it of items) {
    const l = it.q && legFor(E, it.q);
    if (!l) return { reason: `"${it.name}" não entra no Criar aposta`, bad: it.key };
    const p1 = joint(E, [l]);
    if (!p1 || Math.abs(Math.log(oddOf(p1) * EXTRA / it.odds)) > Math.log(1 + CHECK) + 0.15) return { reason: `"${it.name}" não entra no Criar aposta`, bad: it.key };
    const twin = legs.findIndex((x) => sameMarket(x, l));
    if (twin >= 0) return { reason: `"${items[twin].name}" e "${it.name}" são do mesmo mercado`, bad: it.key };
    legs.push(l);
  }
  const p = joint(E, legs);
  if (p == null) return { reason: 'combinação indisponível' };
  if (p < 1e-4) return { reason: 'estas seleções não podem acontecer juntas' };
  // seleção que já está garantida pelas outras (ex.: Flamengo + "Vasco ou Flamengo") só baixava a odd
  for (let i = 0; i < legs.length; i++) {
    const rest = joint(E, legs.filter((_, j) => j !== i));
    if (rest != null && p >= rest * 0.999) return { reason: `"${items[i].name}" já está incluída nas outras seleções`, bad: items[i].key };
  }
  const own = ladderDown(oddOf(p, corrOf(E, legs)));
  const odds = Math.max(own, floorOdds(E, legs, items.map((it) => it.odds), (mask) => joint(E, legs.filter((_, i) => (mask >> i) & 1))));
  if (odds < 1.02) return { reason: 'odd demasiado baixa para esta combinação' };
  return { odds, p, params: paramsOf(E, legs) };
}
/* Criar aposta aberto: com as seleções já escolhidas (items), a odd que a aposta fica a valer ao juntar cada
   candidata (a mesma conta do quote) → { key: odd } com 0 nas que não podem juntar-se. null: as escolhidas não juntam */
function preview(E, items, cands) {
  const legs = [];
  for (const it of items) { const l = it.q && legFor(E, it.q); if (!l) return null; legs.push(l); }
  const single = (E.p1 ||= new WeakMap()); // odd de cada cotação sozinha no modelo (para o CHECK), guardada no motor
  // pesos de cada grupo das escolhidas (W[mask]), calculados uma vez: o de todas, os de cada uma sem uma delas
  // (para ver as redundantes) e os menores (para a odd nunca baixar, floorOdds)
  const n = legs.length, full = (1 << n) - 1, sub = (mask) => legs.filter((_, i) => (mask >> i) & 1);
  const W = Array.from({ length: full + 1 }, (_, mask) => weights(E, sub(mask)));
  const WB = W[full], base = WB ? wTotal(WB) : null;
  // odd atual das escolhidas (a mesma conta do quote) e o seu chão
  const floorBase = n ? (n === 1 ? items[0].odds : Math.max(ladderDown(oddOf(base ?? 1, corrOf(E, legs))), floorOdds(E, legs, items.map((it) => it.odds), (mask) => (W[mask] ? wTotal(W[mask]) : null)))) : 0;
  const out = {};
  for (const c of cands) {
    out[c.key] = 0;
    if (items.length >= MAX_LEGS) continue;
    const l = c.q && legFor(E, c.q);
    if (!l || legs.some((x) => sameMarket(x, l))) continue;
    if (!single.has(c.q)) single.set(c.q, joint(E, [l]));
    const p1 = single.get(c.q);
    if (!p1 || Math.abs(Math.log(oddOf(p1) * EXTRA / c.odds)) > Math.log(1 + CHECK) + 0.15) continue;
    const all = [...legs, l];
    const p = jointPlus(E, WB, l);
    if (p == null || p < 1e-4) continue;
    if (base != null && p >= base * 0.999) continue; // já garantida pelas escolhidas: não acrescenta nada
    // a candidata com cada grupo menor das escolhidas (mask): para as redundantes e para o chão da odd
    const pm = new Array(full).fill(null);
    for (let mask = 1; mask < full; mask++) pm[mask] = jointPlus(E, W[mask], l);
    // ou torna uma das escolhidas redundante (ex.: escolhida "Vasco ou Flamengo", candidata Flamengo)
    if (legs.some((_, i) => { const r = n === 1 ? p1 : pm[full ^ (1 << i)]; return r != null && p >= r * 0.999; })) continue;
    // odd nunca abaixo de nenhuma parte: as escolhidas (floorBase), a candidata sozinha e cada grupo menor com ela
    let odds = Math.max(ladderDown(oddOf(p, corrOf(E, all))), floorBase, c.odds);
    for (let mask = 1; mask < full; mask++) {
      const pt = pm[mask];
      if (pt != null && pt >= 1e-4) odds = Math.max(odds, ladderDown(oddOf(pt, corrOf(E, [...sub(mask), l]))));
    }
    if (odds >= 1.02) out[c.key] = odds;
  }
  return out;
}
// o que fica guardado na aposta para refazer a conta se uma seleção for anulada
function paramsOf(E, legs) {
  const players = {};
  const pp = {};
  for (const l of legs) if (l.pl) { const k = (l.pl.kind === 'card' ? 'card:' : '') + l.pl.name; players[k] = E.players[k]; }
  for (const l of legs) if (l.pp) { pp[l.pp.name] = E.pp[l.pp.name]; if (E.players[l.pp.name]) players[l.pp.name] = E.players[l.pp.name]; }
  return { home: E.m.home, away: E.m.away, goals: E.goals, corners: E.corners || null, cards: E.cards || null, players, pp };
}
// o motor inteiro do jogo, para o navegador calcular as odds da aba Criar aposta sem esperar pelo servidor
const modelOf = (E) => ({ v: E.v, home: E.m.home, away: E.m.away, goals: E.goals, corners: E.corners || null, cards: E.cards || null, players: E.players, pp: E.pp });
// cotação da bet365 → só os campos que o motor usa (vai para a aposta)
const srcOf = (q) => Object.fromEntries(['group_name', 'side', 'label', 'line', 'handicap', 'n2'].filter((k) => q[k] != null).map((k) => [k, q[k]]));

/* aposta com seleções anuladas: nova odd com as que ficaram (mesmos números do momento da aposta).
   src: as cotações guardadas das seleções que ficaram; 1 seleção: a odd dela no momento da aposta. */
function requote(params, kept) {
  if (!kept.length) return 1;
  if (kept.length === 1) return kept[0].odds;
  const E = fromParams(params);
  E.m = { home: params.home, away: params.away, quotes: [] };
  const legs = kept.map((k) => { const l = legOf(E.m, k.src); if (l) l.q = k.src; return l; });
  if (legs.some((l) => !l)) return kept.reduce((t, k) => t * k.odds, 1); // não devia acontecer: multiplica as odds de cada uma
  const p = joint(E, legs);
  if (!p) return 1;
  // a mesma regra do quote: nunca abaixo de nenhuma parte das que ficaram
  const floor = floorOdds(E, legs, kept.map((k) => k.odds), (mask) => joint(E, legs.filter((_, i) => (mask >> i) & 1)));
  return Math.max(1, ladderDown(oddOf(p, corrOf(E, legs))), floor);
}

/* motor de cada jogo, guardado alguns minutos (montar leva ~60 ms) */
const cache = new Map();
const TTL = 3 * 60000;
function engineFor(id, m) {
  const c = cache.get(id);
  if (c && Date.now() - c.at < TTL && c.n === m.quotes.length) return c.E;
  let E = null;
  try { E = build(m); } catch (e) { console.error('[Criar aposta]', id, e.message); }
  if (E) E.v = Date.now(); // versão do motor (o navegador refaz o seu quando muda)
  cache.set(id, { E, at: Date.now(), n: m.quotes.length });
  if (cache.size > 400) for (const [k, v] of cache) if (Date.now() - v.at > TTL) cache.delete(k);
  return E;
}

module.exports = { modelOf, engineFor, quote, preview, requote, srcOf, MAX_LEGS, legOf, joint, build, fromParams, LADDER };
