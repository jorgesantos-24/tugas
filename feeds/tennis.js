'use strict';
/* Ténis na MoviOdds (bet365): leitura dos mercados pelo nome do grupo e histórico game a game para liquidar.

   Mercados: cada cotação vira { k, pick, line?, per? } (ver a lista e as regras no markets.js, "ténis").
     per = de que parte do jogo se trata: "2" (2º set), "1/9" (1º set, game 9), "1:4" (1º set, 4 games),
           "home"/"away" (jogador), "home:0" (jogador, partida toda) ou "home:2" (jogador, 2º set).
   Pontos (1º ponto, placar após N pontos, ponto a ponto, break point, total de pontos, tie-break): liquidados com os
   placares gravados ao vivo pelo feeds/points.js. "Ponto a ponto" sem número de ponto e "Any Other" ficam para a equipa.
   Ficam de fora (por agora): "próxima quebra", quebras no "set atual/seguinte" e os handicaps
   ao vivo ("Match Line", "Set N Handicap") — dependem do momento da aposta e a regra ainda não foi confirmada.

   Liquidação: o resultado final (/results?stats=1) traz "summary" — uma linha por game:
     "Game 10 - Antonia Ruzic - breaks to 30"  (quem ganhou; "holds" = ganhou a servir, "breaks" = quebrou;
                                                 "to 30" = pontos do adversário: love, 15, 30 ou 40)
   O histórico só é usado se bater certo com o placar dos sets (número de games e vencedores de cada set). */

const parseScore = (s) => { const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(s ?? '').trim()); return m ? [Number(m[1]), Number(m[2])] : null; };
// número de uma linha: "2.5", "+1.5", "Over 2.5"; linha asiática "3.0, 3.5" = 3.25 (metade da aposta em cada uma)
const num = (v) => {
  const t = String(v ?? '');
  const n = t.match(/[+-]?\d+(\.\d+)?/g);
  if (!n) return NaN;
  return /,/.test(t) && n.length === 2 ? (Number(n[0]) + Number(n[1])) / 2 : Number(n[0]);
};
const stripSvr = (s) => String(s ?? '').replace(/\s*\(Svr\)\s*$/i, '').trim();
const PTS = { love: 0, 0: 0, 15: 15, 30: 30, 40: 40 };
const ptsOf = (s) => { const m = /(love|\d+)\s*$/i.exec(String(s ?? '').trim()); return m && m[1].toLowerCase() in PTS ? PTS[m[1].toLowerCase()] : null; };
const maxPts = (s) => { const n = String(s ?? '').match(/\d+/g); return n ? Math.max(...n.map(Number)) : null; };
const yn = (s) => (/^yes$/i.test(String(s ?? '').trim()) ? 'yes' : /^no$/i.test(String(s ?? '').trim()) ? 'no' : null);
const ou = (s) => (/^\s*over/i.test(String(s ?? '')) ? 'over' : /^\s*under/i.test(String(s ?? '')) ? 'under' : null);
/* Placar de pontos → "casa-fora" em nº de pontos (0..4). A fonte escreve-o umas vezes casa-fora (games),
   outras com quem serve primeiro (1º game de serviço) — por isso só se usa quem lidera (side) e os dois números:
   o maior é de quem lidera. "Win to love"/"Lose to Love" = quem lidera ganhou o game a zero. */
const PV = { 0: 0, 15: 1, 30: 2, 40: 3 };
function ptsPick(label, side, who) {
  const t = String(label ?? '').trim(), w = side == null || side === 'Tie' ? null : who(side);
  if (/^(win|lose) to love$/i.test(t)) return w === 'home' ? '4-0' : w === 'away' ? '0-4' : null;
  const m = /^(\d+)-(\d+)$/.exec(t);
  if (!m || PV[m[1]] == null || PV[m[2]] == null) return null;
  const hi = Math.max(PV[m[1]], PV[m[2]]), lo = Math.min(PV[m[1]], PV[m[2]]);
  if (hi === lo) return w ? null : `${hi}-${lo}`;
  return w === 'home' ? `${hi}-${lo}` : w === 'away' ? `${lo}-${hi}` : null;
}
// placar do tie-break ("5-1" do lado de quem lidera) → "casa-fora"
function leadScore(line, side, who) {
  const p = parseScore(line);
  if (!p) return null;
  const hi = Math.max(...p), lo = Math.min(...p), w = side == null || side === '' || side === 'Tie' ? null : who(side);
  if (hi === lo) return w ? null : `${hi}-${lo}`;
  return w === 'home' ? `${hi}-${lo}` : w === 'away' ? `${lo}-${hi}` : null;
}
// "4 points" / "Over 6 points" → '4' / 'over'
const totPts = (s) => { const t = String(s ?? '').trim(); return /^over 6 points?$/i.test(t) ? 'over' : (/^([456]) points?$/i.exec(t) || [])[1] || null; };
const TO = { 'win from behind': 'behind', 'win from behind (sets)': 'behind', 'win in straight sets': 'straight', 'win a set': 'aset' };

// uma cotação → { k, pick, line?, per?, main? } ou null (mercado que não usamos)
function quote(q, m) {
  const who = (name) => { const n = stripSvr(name); return n === m.home ? 'home' : n === m.away ? 'away' : null; };
  const both = (a, b) => (a && b ? `${a}:${b}` : null);
  // placar com o lado = quem lidera/ganha ("3-1" do lado de fora = 1-3); sem lado só vale empate ("2-2")
  const orient = (side, score) => {
    const p = parseScore(score);
    if (!p) return null;
    const w = side == null || side === 'Tie' ? null : who(side);
    if (w === 'home') return `${p[0]}-${p[1]}`;
    if (w === 'away') return `${p[1]}-${p[0]}`;
    return p[0] === p[1] && (side == null || side === 'Tie') ? `${p[0]}-${p[1]}` : null;
  };
  const g = String(q.group_name ?? '').trim();
  let x;
  // ---- partida
  if (/^To Win( Match)?$/.test(g)) return { k: 'ml', pick: who(q.side && q.line === 'Match' ? q.side : q.label || q.side) || who(q.side) };
  if (g === 'Set Betting') return { k: 'sets', pick: orient(q.side, q.line) };
  if (g === 'Total Sets') return { k: 'tsets', pick: (/^(\d) Sets?$/i.exec(String(q.label ?? '').trim()) || [])[1] || null };
  if (g === 'Match Handicap (Games)') return m.in_play ? null : { k: 'gspread', pick: who(q.side), line: num(q.handicap ?? q.line ?? q.label), main: true };
  if (/^Total Games (2-Way|in Match)$/.test(g)) return { k: 'gtotal', pick: ou(q.side), line: num(q.handicap ?? q.line), main: true };
  if (g === 'Straight Sets Winner') return { k: 'tstraight', pick: yn(q.label) };
  // 'Go The Distance?' não se oferece: a fonte manda-o errado antes e durante o jogo (28/10: Fritz x Hijikata 'Sim' a 11.00
  // com 'Total de sets: 3' a 3.25; Djokovic x Humbert 'Sim' a 4.00 com o 3º set quase certo). 'Total de sets' responde ao mesmo
  if (g === 'Go The Distance?') return null;
  if (g === 'Total Tie Breaks in Match') return { k: 'ttb', pick: ou(q.side ?? q.label), line: num(q.handicap ?? q.line) };
  if (g === 'Match Total Games Odd/Even') return { k: 'toe', pick: /^odd$/i.test(q.label) ? 'odd' : /^even$/i.test(q.label) ? 'even' : null };
  if (/^Match Result (&|and) Total Games$/.test(g)) return { k: 'tmrt', pick: both(who(q.line), ou(q.side)), line: num(q.handicap ?? q.label) };
  if (g === 'Double Result') { x = /^(.+) to win 1st set and (WIN|LOSE) match$/i.exec(String(q.label ?? '').trim()); return x ? { k: 'tdr', pick: both(who(x[1]), x[2].toUpperCase()[0]) } : null; }
  if (g === 'Setcast') { x = /^(.+) ([WL]+)$/.exec(String(q.label ?? '').trim()); return x ? { k: 'tcast', pick: both(who(x[1]), x[2]) } : null; }
  if (g === 'First Break Of Serve') return { k: 'tfbrk', pick: who(q.label) };
  if (g === 'Total Breaks of Serve in Match') return { k: 'tbrk', pick: ou(q.label), line: num(q.handicap ?? q.line) };
  // total de quebras dos dois: "Match" (partida) / "Set" (1º set) no lugar do nome do jogador
  if (g === 'Total Breaks of Serve' && q.line === 'Match') return { k: 'tbrk', pick: ou(q.side), line: num(q.handicap ?? q.label) };
  if (g === 'First Set - Total Breaks of Serve' && q.line === 'Set') return { k: 'tsbt', per: '1', pick: ou(q.side), line: num(q.handicap ?? q.label) };
  if (g === 'Total Breaks of Serve') { const w = who(q.line); return w ? { k: 'tpbrk', per: `${w}:0`, pick: ou(q.side), line: num(q.handicap ?? q.label) } : null; }
  if (g === 'First Set - Total Breaks of Serve') { const w = who(q.line); return w ? { k: 'tpbrk', per: `${w}:1`, pick: ou(q.side), line: num(q.handicap ?? q.label) } : null; }
  if (g === 'Player Total Breaks of Serve') { const w = who(q.side); return w ? { k: 'tpbrk', per: `${w}:0`, pick: ou(q.label), line: num(q.handicap ?? q.line) } : null; }
  if ((x = /^Set (\d) - Player Breaks of Serve$/.exec(g))) { const w = who(q.side); return w ? { k: 'tpbrk', per: `${w}:${x[1]}`, pick: ou(q.label), line: num(q.handicap ?? q.line) } : null; }
  if (g === 'Player Games Won') { const w = who(q.side); return w ? { k: 'tpgw', per: w, pick: ou(q.label), line: num(q.handicap ?? q.line) } : null; }
  if (g === 'Ace Totals' || g === 'Double Fault Totals') {
    const w = q.side === 'Match' ? 'all' : who(q.side), n = parseInt(q.line, 10); // "Match" = dos dois jogadores somados
    return w && n > 0 ? { k: g === 'Ace Totals' ? 'tace' : 'tdf', per: w, pick: String(n), line: n } : null;
  }
  if ((x = /^(.+) To$/.exec(g)) && who(x[1])) { const t = TO[String(q.line ?? '').trim().toLowerCase()]; return t ? { k: 'tpto', per: who(x[1]), pick: both(t, yn(q.side)) } : null; }
  // ---- sets ("First Set ..." = 1º set)
  if ((x = /^(?:Set (\d) Winner|(\d)(?:st|nd|rd|th) Set Winner)$/.exec(g))) return { k: 'tsw', per: x[1] || x[2], pick: who(q.label) };
  if ((x = /^(?:Set (\d) Score|First Set Score)$/.exec(g))) return { k: 'tscs', per: x[1] || '1', pick: orient(q.side, q.line) };
  if ((x = /^(?:First Set|Set (\d)) Correct Score Group$/.exec(g))) return { k: 'tscg', per: x[1] || '1', pick: both(who(q.side), String(q.line ?? '').replace(/\s+/g, '')) };
  if ((x = /^(?:First Set Score Any Player|Set (\d) Correct Score Any Player)$/.exec(g))) {
    const p = parseScore(q.label);
    return p ? { k: 'tsca', per: x[1] || '1', pick: `${Math.max(...p)}-${Math.min(...p)}` } : null;
  }
  if ((x = /^(?:(\d)(?:st|nd|rd|th) Set Total Games|Total Games in Set (\d))$/.exec(g))) return { k: 'tsgt', per: x[1] || x[2], pick: ou(q.side), line: num(q.handicap ?? q.line) };
  if (g === 'First Set Handicap') return m.in_play ? null : { k: 'tsgh', per: '1', pick: who(q.side), line: num(q.label ?? q.line) };
  if ((x = /^(?:First Set Lead After \(Games\)|Set (\d) Lead after)$/.exec(g))) {
    const n = parseInt(q.line, 10);
    return n > 0 ? { k: 'tslead', per: `${x[1] || 1}:${n}`, pick: q.side === 'Tie' ? 'draw' : who(q.side) } : null;
  }
  if ((x = /^(?:First Set Score After (\d) Games|Set (\d) Score after (\d) Games)$/i.exec(g))) return { k: 'tsafter', per: `${x[2] || 1}:${x[1] || x[3]}`, pick: orient(q.side, q.line) };
  if ((x = /^(?:First Set Race To \(Games\)|Set (\d) Race to)$/.exec(g))) {
    const n = parseInt(q.line, 10);
    return n > 0 ? { k: 'tsrace', per: `${x[1] || 1}:${n}`, pick: who(q.side) } : null;
  }
  if ((x = /^Set (\d) Tie Break Winner$/.exec(g))) return { k: 'tstbw', per: x[1], pick: who(q.label) };
  if ((x = /^(?:Set (\d) To Break Serve|First Set Player To Break Serve)$/.exec(g))) return { k: 'tsbrk', per: x[1] || '1', pick: both(who(q.line), yn(q.side)) };
  // ---- games
  if ((x = /^Set (\d)(?: -)? Game (\d+) Winner$/.exec(g))) return { k: 'tgw', per: `${x[1]}/${x[2]}`, pick: who(q.label) };
  if ((x = /^Set (\d)(?: -)? Game (\d+) Score$/.exec(g))) { const p = ptsOf(q.line); return { k: 'tgs', per: `${x[1]}/${x[2]}`, pick: p == null ? null : both(who(q.side), String(p)) }; }
  if ((x = /^Set (\d)(?: -)? Game (\d+) [Tt]o Deuce$/.exec(g))) return { k: 'tgd', per: `${x[1]}/${x[2]}`, pick: yn(q.label) };
  if ((x = /^Set (\d) - Game (\d+) Server to Win$/.exec(g))) { const n = maxPts(q.line); return n == null ? null : { k: 'tgsw', per: `${x[1]}/${x[2]}`, pick: yn(q.side), line: n }; }
  if ((x = /^Set (\d) - Games (\d+) & (\d+) - (Winner|Either Game To Deuce)$/.exec(g))) {
    if (Number(x[3]) !== Number(x[2]) + 1) return null;
    return x[4] === 'Winner' ? { k: 'tgpw', per: `${x[1]}/${x[2]}`, pick: q.label === 'Tie' ? 'draw' : who(q.label) }
      : { k: 'tgpd', per: `${x[1]}/${x[2]}`, pick: yn(q.label) };
  }
  // ---- pontos (liquidados com os placares gravados ao vivo: feeds/points.js)
  if ((x = /^Set (\d+) - Game (\d+) 1st Point$/.exec(g))) return { k: 'tg1p', per: `${x[1]}/${x[2]}`, pick: who(q.label) };
  if ((x = /^Set (\d+) - Game (\d+) Score After (\d) Points$/.exec(g))) return { k: 'tgsa', per: `${x[1]}/${x[2]}:${x[3]}`, pick: ptsPick(q.label, q.side, who) };
  if ((x = /^Set (\d+) - Game (\d+) To Have Break Point$/.exec(g))) return { k: 'tgbp', per: `${x[1]}/${x[2]}`, pick: yn(q.label) };
  if ((x = /^Set (\d+) - Game (\d+) Total Points$/.exec(g))) return { k: 'tgtp', per: `${x[1]}/${x[2]}`, pick: totPts(q.label) };
  if ((x = /^Point Betting - Set (\d+) Game (\d+)$/.exec(g))) { const n = parseInt(q.line, 10); return n > 0 && n <= 6 ? { k: 'tgpb', per: `${x[1]}/${x[2]}`, pick: who(q.side), line: n } : null; }
  if ((x = /^First (.+?) Service Game\s*[–-]\s*First (\d) Points$/.exec(g))) { const srv = who(x[1]); return srv ? { k: 'tfsa', per: `${srv}:${x[2]}`, pick: ptsPick(q.label, q.side, who) } : null; }
  if ((x = /^First (.+?) Service Game\s*[–-]\s*Total Points$/.exec(g))) { const srv = who(x[1]); return srv ? { k: 'tfstp', per: srv, pick: totPts(q.label) } : null; }
  // ---- tie-break ("Match Tie Break" = super tie-break no lugar do set decisivo → per "M")
  if ((x = /^(?:Set (\d) |Match )Tie Break - Total Points$/.exec(g))) return { k: 'ttbtp', per: x[1] || 'M', pick: ou(q.side ?? q.label), line: num(q.handicap ?? q.line) };
  if ((x = /^(?:Set (\d) |Match )Tie Break Lead after (\d+) Points$/.exec(g))) return { k: 'ttblead', per: `${x[1] || 'M'}:${x[2]}`, pick: q.label === 'Tie' ? 'draw' : who(q.label) };
  if ((x = /^(?:Set (\d) |Match )Tie Break Score after (\d+) Points$/.exec(g))) return { k: 'ttbsa', per: `${x[1] || 'M'}:${x[2]}`, pick: leadScore(q.line, q.side, who) };
  if ((x = /^Point Betting\s*[–-]\s*(?:Set (\d) |Match )Tie Break$/.exec(g))) {
    const p = /^Pt (\d+) - (.+)$/.exec(String(q.label ?? '').trim());
    return p ? { k: 'ttbpb', per: x[1] || 'M', pick: who(p[2]), line: Number(p[1]) } : null;
  }
  if ((x = /^Set (\d) Tie Break Score$/.exec(g))) return { k: 'ttbs', per: x[1], pick: leadScore(q.line, q.side, who) }; // "Any Other" → null (equipa)
  // ---- 1º game de serviço de cada jogador (antes do jogo)
  if ((x = /^First (.+?) Service Game\s*[–-]\s*(Score|To Win To|Winners|Yes\/No)$/.exec(g))) {
    const srv = who(x[1]);
    if (!srv) return null;
    if (x[2] === 'Score') { const p = ptsOf(q.line); return { k: 'tfsg', per: srv, pick: p == null ? null : both(who(q.side), String(p)) }; }
    if (x[2] === 'To Win To') { const n = maxPts(q.line); return n == null ? null : { k: 'tfsw', per: srv, pick: yn(q.side), line: n }; }
    if (x[2] === 'Winners') return { k: 'tfswin', per: srv, pick: who(q.side) };
    if (/break point/i.test(q.line)) return { k: 'tfsbp', per: srv, pick: yn(q.side) }; // com os pontos gravados ao vivo (feeds/points.js)
    return /deuce/i.test(q.line) ? { k: 'tfsd', per: srv, pick: yn(q.side) } : null;
  }
  return null;
}

// ordem dos mercados na página do jogo
const ORDER = ['ml', 'sets', 'tsets', 'gtotal', 'gspread', 'tsw', 'tscs', 'tscg', 'tsca', 'tsgt', 'tsgh', 'tslead', 'tsafter', 'tsrace', 'tstbw',
  'ttbs', 'ttbtp', 'ttblead', 'ttbsa', 'ttbpb',
  'tsbrk', 'tgw', 'tgs', 'tgd', 'tgsw', 'tg1p', 'tgsa', 'tgpb', 'tgbp', 'tgtp', 'tgpw', 'tgpd', 'tfswin', 'tfsg', 'tfsw', 'tfsd', 'tfsa', 'tfstp', 'tfsbp', 'tfbrk', 'tsbt', 'tpbrk', 'tbrk', 'tstraight', 'tdist',
  'tpto', 'tdr', 'tcast', 'tmrt', 'tpgw', 'toe', 'ttb', 'tace', 'tdf'];
const perKey = (p) => String(p ?? '').split(/[:/]/).map((v) => (isNaN(v) ? v : String(v).padStart(3, '0'))).join('|');
const marketSort = (a, b) => (perKey(a.per) < perKey(b.per) ? -1 : perKey(a.per) > perKey(b.per) ? 1 : 0) || ORDER.indexOf(a.k) - ORDER.indexOf(b.k);

/* Histórico game a game do resultado final → [{ s, g, w, srv?, lp? , tb? }] (set, game no set, vencedor,
   quem servia, pontos do adversário) ou null se não bater certo com o placar dos sets. */
function gameLog(r, sets) {
  const sum = r?.stats?.summary;
  if (!Array.isArray(sum) || !sets?.length) return null;
  const total = sets.reduce((t, [h, a]) => t + h + a, 0);
  if (sum.length !== total) return null;
  const log = [];
  let i = 0;
  for (let s = 0; s < sets.length; s++) {
    const n = sets[s][0] + sets[s][1], wins = [0, 0];
    for (let g = 1; g <= n; g++, i++) {
      const line = String(sum[i]).trim();
      // tie-break (e super tie-break): "Set 1 tie break score 8-6" — placar casa-fora, sem "Game N"
      const tb = /^Set (\d+) tie break score (\d+)-(\d+)$/i.exec(line);
      if (tb) {
        const h = Number(tb[2]), a = Number(tb[3]);
        if (Number(tb[1]) !== s + 1 || g !== n || h === a) return null; // tem de ser o último game do set certo
        const w = h > a ? 'home' : 'away';
        wins[w === 'home' ? 0 : 1]++;
        log.push({ s: s + 1, g, w, tb: true, tbScore: [h, a] });
        continue;
      }
      const mm = /^Game (\d+) - (.+?) - (.+)$/.exec(line);
      if (!mm || Number(mm[1]) !== i + 1) return null;
      const w = mm[2] === r.home ? 'home' : mm[2] === r.away ? 'away' : null;
      if (!w) return null;
      const e = { s: s + 1, g, w };
      const hb = /^(holds|breaks) to (love|15|30|40)$/i.exec(mm[3].trim());
      if (hb) { e.srv = /^holds$/i.test(hb[1]) ? w : w === 'home' ? 'away' : 'home'; e.lp = PTS[hb[2].toLowerCase()]; }
      else e.tb = true; // tie-break (ou outro texto): sem quem servia nem pontos
      wins[w === 'home' ? 0 : 1]++;
      log.push(e);
    }
    if (wins[0] !== sets[s][0] || wins[1] !== sets[s][1]) return null;
  }
  return log;
}
const pair = (st, key) => (st && Number.isFinite(st.home?.[key]) && Number.isFinite(st.away?.[key]) ? [st.home[key], st.away[key]] : null);
// extras do resultado: histórico de games, aces e duplas faltas (null quando não há ou não bate certo)
const extras = (r, sets) => ({ log: gameLog(r, sets), aces: pair(r?.stats, 'aces'), dfs: pair(r?.stats, 'double_faults') });

/* ---------- proteção das odds do ténis (corre a cada atualização do jogo, antes de chegar ao site) ----------
   A fonte (MoviOdds, leitura não oficial da bet365) às vezes manda cotações paradas ou com os lados trocados
   (ex.: Djokovic x Humbert 28/10, 4-6 4-1: "vai ao 3º set? Sim" a 4.00 com o placar em sets da própria bet365 a dar
   ~94%). Nenhuma odd suspeita chega aberta ao site:
   1) odds impossíveis: num mercado com todos os resultados (casa/fora, sim/não, mais/menos da mesma linha...),
      apostar em todos dá lucro garantido (soma das probabilidades < 100%) → bloqueado;
   2) mercados que medem a mesma coisa têm de concordar (diferença ≤ GUARD_DIFF na probabilidade sem margem):
      vencedor × placar em sets · vence sem perder set × placar em sets · set decisivo / total de sets × placar em sets
      · vencedor do set N × placar do set N · vencedor do game × placar do game · 1º ponto × ponto a ponto (ponto 1).
      Se não concordam, os dois ficam bloqueados (não se sabe qual está errado) até voltarem a bater certo.
      Ao vivo, o placar em sets suspenso ou ausente também bloqueia o que só ele confirma (set decisivo, total de sets).
   Marcadas aqui (guard); o feeds/moviodds.js tira-as do site até voltarem a bater certo. */
// 28/10, oferta real: quando a fonte está certa, mercados irmãos nunca diferem mais de ~0,04 → margem 0,07
const GUARD_DIFF = 0.07;
const COMPLETE = [['home', 'away'], ['yes', 'no'], ['odd', 'even'], ['over', 'under'], ['home', 'away', 'draw']];
// só as que estariam abertas: uma suspensa (ponto a decorrer) já tem cadeado e não deve sumir do site
const lockMk = (mk) => { if (mk) for (const x of mk.sels) if (!x.lock) { x.lock = true; x.guard = true; } };
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
// 1) odds impossíveis
function guardOverround(byK) {
  for (const mk of byK.values()) {
    const byLine = new Map();
    // handicaps: casa com linha L faz par com fora com linha -L (casa -0,25 e fora -0,25 são apostas diferentes)
    const hcp = /spread|pspr/.test(mk.k);
    for (const x of mk.sels) { const k = x.line == null ? '' : String(hcp && String(x.pick).startsWith('away') ? -x.line : x.line) + '|' + String(x.base ?? ''); if (!byLine.has(k)) byLine.set(k, []); byLine.get(k).push(x); }
    for (const g of byLine.values()) {
      const picks = g.map((x) => String(x.pick));
      if (!COMPLETE.some((c) => sameSet(c, picks))) continue;
      const tot = g.reduce((q, x) => q + 1 / x.odds, 0);
      if (tot < 1) for (const x of g) if (!x.lock) { x.lock = true; x.guard = true; }
    }
  }
}
// probabilidade (sem margem) de um grupo de seleções num mercado: soma das escolhidas / soma de todas
function probOf(mk, pred, minTot = 0.95, maxTot = 1.6) {
  if (!mk || !mk.sels.length || mk.sels.some((x) => x.lock)) return null;
  const tot = mk.sels.reduce((q, x) => q + 1 / x.odds, 0);
  if (!(tot >= minTot && tot <= maxTot)) return null; // mercado incompleto (seleções que caíram): não serve de referência
  return mk.sels.filter(pred).reduce((q, x) => q + 1 / x.odds, 0) / tot;
}
const two = (mk, yes) => (mk && mk.sels.length === 2 ? probOf(mk, (x) => String(x.pick) === yes, 0.9, 1.6) : null);
function agree(a, b, mkA, mkB) {
  if (a == null || b == null) return;
  if (Math.abs(a - b) > GUARD_DIFF) { lockMk(mkA); lockMk(mkB); }
}
// 2) cruzamentos
function guardTennis(byK, live = true) {
  guardOverround(byK);
  const sets = byK.get('sets');
  const score = (x) => String(x.pick).split('-').map(Number);
  const fromSets = (pred) => (sets ? probOf(sets, (x) => pred(score(x)), 0.9, 1.4) : null);
  // vencedor × placar em sets
  agree(two(byK.get('ml'), 'home'), fromSets(([h, a]) => h > a), byK.get('ml'), sets);
  // vence sem perder set × placar em sets
  agree(two(byK.get('tstraight'), 'yes'), fromSets(([h, a]) => Math.min(h, a) === 0), byK.get('tstraight'), sets);
  /* total de sets (e set decisivo): confirmado pelo placar em sets; sem ele (1º set a decorrer a fonte não o manda),
     pelo "vence sem perder set" — a mesma pergunta (2 sets = alguém vence sem perder set). Sem nenhuma das duas
     referências: ao vivo sai do site (não se arrisca); antes do jogo a fonte é fiável. */
  const straight = byK.get('tstraight');
  const maxSets = sets ? Math.max(...sets.sels.map((x) => score(x)[0] + score(x)[1])) : 3;
  let dec = fromSets(([h, a]) => h + a === maxSets), ref = sets;
  if (dec == null && maxSets === 3) { const y = two(straight, 'yes'); if (y != null) { dec = 1 - y; ref = straight; } } // só no melhor de 3: 2 sets = sem perder set
  for (const k of ['tdist', 'tsets']) {
    const mk = byK.get(k);
    if (!mk) continue;
    // melhor de 5: "total de sets" tem 3 opções (3, 4, 5) — cada uma tem de bater com o placar em sets
    if (k === 'tsets' && mk.sels.length > 2) {
      if (!sets || fromSets(() => true) == null) { if (live) lockMk(mk); continue; }
      for (const x of mk.sels) {
        const p = probOf(mk, (y) => y === x, 0.9, 1.6), q = fromSets(([h, a]) => h + a === Number(x.pick));
        if (p == null || q == null || Math.abs(p - q) > GUARD_DIFF) { lockMk(mk); lockMk(sets); break; }
      }
      continue;
    }
    if (dec == null) { if (live) lockMk(mk); continue; }
    const yes = k === 'tdist' ? 'yes' : String(Math.max(...mk.sels.map((x) => Number(x.pick))));
    const p = two(mk, yes);
    if (p == null || Math.abs(p - dec) > GUARD_DIFF) { lockMk(mk); if (ref === straight) lockMk(straight); } // não se sabe qual dos dois está errado
  }
  for (const mk of byK.values()) {
    // vencedor do set N × placar do set N
    if (mk.k === 'tsw') {
      const sc = byK.get(`tscs|${mk.per}`);
      agree(two(mk, 'home'), sc ? probOf(sc, (x) => { const [h, a] = score(x); return h > a; }) : null, mk, sc);
    }
    // vencedor do game × placar do game ("home:15" = casa ganha com o adversário a 15)
    if (mk.k === 'tgw') {
      const gs = byK.get(`tgs|${mk.per}`);
      agree(two(mk, 'home'), gs ? probOf(gs, (x) => String(x.pick).startsWith('home:')) : null, mk, gs);
    }
    // 1º ponto × ponto a ponto (ponto 1)
    if (mk.k === 'tg1p') {
      const pt1 = (byK.get(`tgpb|${mk.per}`)?.sels || []).filter((x) => Number(x.line) === 1);
      const p = two(mk, 'home'), q = pt1.length === 2 ? two({ sels: pt1 }, 'home') : null;
      if (p != null && q != null && Math.abs(p - q) > GUARD_DIFF) { lockMk(mk); lockMk({ sels: pt1 }); }
    }
  }
}

module.exports = { GUARD_DIFF, guardTennis, guardOverround, quote, marketSort, gameLog, extras };
