'use strict';
/* Vigilância das apostas ao vivo: deteta quem aposta "sabendo o que vai acontecer" (está no estádio, vê uma
   transmissão mais rápida, ou o atraso de aceitação está curto demais).

   Cada aposta ao vivo aceite é revista 20 s e 45 s depois. Fica marcada (coleção liveAlerts) se:
   - houve gol (futebol, hóquei) até GOAL_WINDOW_S segundos depois de ser aceite; ou
   - a odd apostada caiu ODDS_DROP (15%) ou mais logo a seguir (a casa "percebeu" tarde o que o apostador já sabia).
   "A favor" = o gol/queda ajudou a aposta (ex.: apostou na equipa que marcou, ou em "mais de"). Um apostador com
   muitas apostas marcadas a favor é o padrão a investigar; uma ou outra é normal (gols acontecem).
   Também conta, por jogador, quantas apostas ao vivo fez e quantas foram marcadas (users.liveWatch). */

const GOAL_WINDOW_S = Number(process.env.LIVE_ALERT_GOAL_S || 15);
const ODDS_DROP = Number(process.env.LIVE_ALERT_DROP || 15) / 100;
const CHECKS_MS = [20000, 45000];

module.exports = function liveWatch({ col, inc, M, events, findSel, now }) {
  const goals = new Map(); // jogo → [{ at, side }] (últimos gols, para saber quem marcou e quando)

  // chamado pelo servidor quando o placar de um jogo de gols muda
  function goal(evId, side, at) {
    const list = (goals.get(evId) || []).filter((g) => at - g.at < 5 * 60000);
    list.push({ at, side });
    goals.set(evId, list);
  }

  // a aposta beneficia de um gol deste lado?
  function goalHelps(leg, side) {
    const p = String(leg.pick);
    if (p === 'over' || p === 'yes') return true;
    if (side === 'home') return p === 'home' || p === 'hd' || p === 'ha';
    if (side === 'away') return p === 'away' || p === 'da' || p === 'ha';
    return false;
  }

  function review(bet, user, liveLegs) {
    const found = liveLegs.map((l) => ({ ...l, minOdds: l.odds }));
    let i = 0;
    const step = async () => {
      for (const l of found) {
        const { sel } = findSel(l.key);
        if (sel && !sel.locked && sel.odds > 1) l.minOdds = Math.min(l.minOdds, sel.odds);
      }
      if (++i < CHECKS_MS.length) { setTimeout(step, CHECKS_MS[i] - CHECKS_MS[i - 1]); return; }
      // decisão final
      const flags = [];
      for (const l of found) {
        const g = (goals.get(l.evId) || []).find((x) => x.at > bet.placedAt && x.at - bet.placedAt <= GOAL_WINDOW_S * 1000);
        const drop = 1 - l.minOdds / l.odds;
        if (!g && drop < ODDS_DROP) continue;
        flags.push({
          evId: l.evId, event: l.event, sport: l.sport, marketName: l.marketName, name: l.name, odds: l.odds,
          oddsAfter: M.round2(l.minOdds), drop: Math.round(drop * 100),
          goalAfterS: g ? Math.round((g.at - bet.placedAt) / 1000) : null,
          favorable: g ? goalHelps(l, g.side) : drop >= ODDS_DROP, // a odd cair = a aposta ficou mais provável
          scoreAt: l.liveAtPlacement || null,
        });
      }
      try {
        await col.user(user.id).update({ 'liveWatch.bets': inc(1), 'liveWatch.flags': inc(flags.length ? 1 : 0), ...(flags.some((f) => f.favorable) ? { 'liveWatch.favorable': inc(1) } : {}) });
        if (!flags.length) return;
        await col.liveAlerts().doc(bet.id).set({
          betId: bet.id, userId: user.id, userName: user.name || '', userEmail: user.email || '', stake: bet.stake, potential: bet.potential,
          placedAt: bet.placedAt, at: now(), legs: flags, favorable: flags.some((f) => f.favorable),
        });
        console.warn(`[Ao vivo] aposta ${bet.id} de ${user.email} marcada: ${flags.map((f) => (f.goalAfterS != null ? `gol ${f.goalAfterS}s depois` : `odd caiu ${f.drop}%`) + (f.favorable ? ' (a favor)' : '')).join(', ')}`);
      } catch (e) { console.error('[Ao vivo] erro ao registar vigilância:', e.message); }
    };
    setTimeout(step, CHECKS_MS[0]);
  }

  // chamado depois de uma aposta ser aceite
  function watch(bet, user) {
    const liveLegs = bet.legs.filter((l) => l.liveAtPlacement && events.get(l.evId)?.state === 'in');
    if (liveLegs.length) review(bet, user, liveLegs);
  }

  // painel: alertas recentes e resumo por jogador
  async function list(days = 7) {
    const since = now() - days * 86400000;
    const snap = await col.liveAlerts().where('at', '>=', since).orderBy('at', 'desc').limit(500).get();
    const alerts = snap.docs.map((d) => d.data());
    const byUser = new Map();
    for (const a of alerts) {
      const u = byUser.get(a.userId) || { userId: a.userId, userName: a.userName, userEmail: a.userEmail, alerts: 0, favorable: 0, staked: 0 };
      u.alerts++; if (a.favorable) u.favorable++; u.staked += a.stake;
      byUser.set(a.userId, u);
    }
    const users = [...byUser.values()].sort((a, b) => b.favorable - a.favorable || b.alerts - a.alerts).slice(0, 50);
    // total de apostas ao vivo de cada um (para a percentagem)
    await Promise.all(users.map(async (u) => {
      const s = await col.user(u.userId).get();
      const w = s.exists ? s.data().liveWatch || {} : {};
      Object.assign(u, { liveBets: w.bets || 0, liveFlags: w.flags || 0, liveFavorable: w.favorable || 0, blocked: !!(s.exists && s.data().blocked) });
    }));
    const reais = (c) => Math.round(c) / 100; // no Firestore os valores estão em cêntimos
    for (const u of users) u.staked = reais(u.staked);
    return { alerts: alerts.slice(0, 200).map((a) => ({ ...a, stake: reais(a.stake), potential: reais(a.potential) })), users, goalWindowS: GOAL_WINDOW_S, dropPct: Math.round(ODDS_DROP * 100) };
  }

  return { watch, goal, list };
};
