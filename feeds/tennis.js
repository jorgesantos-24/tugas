'use strict';
/* Ténis na MoviOdds (bet365): leitura dos mercados pelo nome do grupo e histórico game a game para liquidar.

   Mercados: cada cotação vira { k, pick, line?, per? } (ver a lista e as regras no markets.js, "ténis").
     per = de que parte do jogo se trata: "2" (2º set), "1/9" (1º set, game 9), "1:4" (1º set, 4 games),
           "home"/"away" (jogador), "home:0" (jogador, partida toda) ou "home:2" (jogador, 2º set).
   Ficam de fora (por agora): ponto a ponto, "próxima quebra", quebras no "set atual/seguinte" e os handicaps
   ao vivo ("Match Line", "Set N Handicap") — dependem do momento da aposta e a regra ainda não foi confirmada.

   Liquidação: o resultado final (/results?stats=1) traz "summary" — uma linha por game:
     "Game 10 - Antonia Ruzic - breaks to 30"  (quem ganhou; "holds" = ganhou a servir, "breaks" = quebrou;
                                                 "to 30" = pontos do adversário: love, 15, 30 ou 40)
   O histórico só é usado se bater certo com o placar dos sets (número de games e vencedores de cada set). */

const parseScore = (s) => { const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(s ?? '').trim()); return m ? [Number(m[1]), Number(m[2])] : null; };
const num = (v) => parseFloat(String(v ?? '').replace(/[^\d.+-]/g, ''));
const stripSvr = (s) => String(s ?? '').replace(/\s*\(Svr\)\s*$/i, '').trim();
const PTS = { love: 0, 0: 0, 15: 15, 30: 30, 40: 40 };
const ptsOf = (s) => { const m = /(love|\d+)\s*$/i.exec(String(s ?? '').trim()); return m && m[1].toLowerCase() in PTS ? PTS[m[1].toLowerCase()] : null; };
const maxPts = (s) => { const n = String(s ?? '').match(/\d+/g); return n ? Math.max(...n.map(Number)) : null; };
const yn = (s) => (/^yes$/i.test(String(s ?? '').trim()) ? 'yes' : /^no$/i.test(String(s ?? '').trim()) ? 'no' : null);
const ou = (s) => (/^\s*over/i.test(String(s ?? '')) ? 'over' : /^\s*under/i.test(String(s ?? '')) ? 'under' : null);
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
  if (g === 'Go The Distance?') return { k: 'tdist', pick: yn(q.label) };
  if (g === 'Total Tie Breaks in Match') return { k: 'ttb', pick: ou(q.side ?? q.label), line: num(q.handicap ?? q.line) };
  if (g === 'Match Total Games Odd/Even') return { k: 'toe', pick: /^odd$/i.test(q.label) ? 'odd' : /^even$/i.test(q.label) ? 'even' : null };
  if (/^Match Result (&|and) Total Games$/.test(g)) return { k: 'tmrt', pick: both(who(q.line), ou(q.side)), line: num(q.handicap ?? q.label) };
  if (g === 'Double Result') { x = /^(.+) to win 1st set and (WIN|LOSE) match$/i.exec(String(q.label ?? '').trim()); return x ? { k: 'tdr', pick: both(who(x[1]), x[2].toUpperCase()[0]) } : null; }
  if (g === 'Setcast') { x = /^(.+) ([WL]+)$/.exec(String(q.label ?? '').trim()); return x ? { k: 'tcast', pick: both(who(x[1]), x[2]) } : null; }
  if (g === 'First Break Of Serve') return { k: 'tfbrk', pick: who(q.label) };
  if (g === 'Total Breaks of Serve in Match') return { k: 'tbrk', pick: ou(q.label), line: num(q.handicap ?? q.line) };
  if (g === 'Total Breaks of Serve') { const w = who(q.line); return w ? { k: 'tpbrk', per: `${w}:0`, pick: ou(q.side), line: num(q.handicap ?? q.label) } : null; }
  if (g === 'First Set - Total Breaks of Serve') { const w = who(q.line); return w ? { k: 'tpbrk', per: `${w}:1`, pick: ou(q.side), line: num(q.handicap ?? q.label) } : null; }
  if (g === 'Player Total Breaks of Serve') { const w = who(q.side); return w ? { k: 'tpbrk', per: `${w}:0`, pick: ou(q.label), line: num(q.handicap ?? q.line) } : null; }
  if ((x = /^Set (\d) - Player Breaks of Serve$/.exec(g))) { const w = who(q.side); return w ? { k: 'tpbrk', per: `${w}:${x[1]}`, pick: ou(q.label), line: num(q.handicap ?? q.line) } : null; }
  if (g === 'Player Games Won') { const w = who(q.side); return w ? { k: 'tpgw', per: w, pick: ou(q.label), line: num(q.handicap ?? q.line) } : null; }
  if (g === 'Ace Totals' || g === 'Double Fault Totals') {
    const w = who(q.side), n = parseInt(q.line, 10);
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
  // ---- 1º game de serviço de cada jogador (antes do jogo)
  if ((x = /^First (.+?) Service Game\s*[–-]\s*(Score|To Win To|Winners|Yes\/No)$/.exec(g))) {
    const srv = who(x[1]);
    if (!srv) return null;
    if (x[2] === 'Score') { const p = ptsOf(q.line); return { k: 'tfsg', per: srv, pick: p == null ? null : both(who(q.side), String(p)) }; }
    if (x[2] === 'To Win To') { const n = maxPts(q.line); return n == null ? null : { k: 'tfsw', per: srv, pick: yn(q.side), line: n }; }
    if (x[2] === 'Winners') return { k: 'tfswin', per: srv, pick: who(q.side) };
    return /deuce/i.test(q.line) ? { k: 'tfsd', per: srv, pick: yn(q.side) } : null; // "Break Point" não se sabe pelo histórico
  }
  return null;
}

// ordem dos mercados na página do jogo
const ORDER = ['ml', 'sets', 'tsets', 'gtotal', 'gspread', 'tsw', 'tscs', 'tscg', 'tsca', 'tsgt', 'tsgh', 'tslead', 'tsafter', 'tsrace', 'tstbw',
  'tsbrk', 'tgw', 'tgs', 'tgd', 'tgsw', 'tgpw', 'tgpd', 'tfswin', 'tfsg', 'tfsw', 'tfsd', 'tfbrk', 'tpbrk', 'tbrk', 'tstraight', 'tdist',
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

module.exports = { quote, marketSort, gameLog, extras };
