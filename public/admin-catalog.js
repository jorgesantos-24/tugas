'use strict';
/* Painel da equipa → aba "Esportes e mercados" (servidor: catalog.js, livemodel.js, streambot.js).
   Modalidades e campeonatos novos, eventos da equipa com mercados e odds (à mão ou automáticas por rounds:
   R6, CS2, Valorant), mapas escolhidos, jogadores vivos, longo prazo, transmissão e o bot da transmissão.
   Fica num ficheiro à parte do admin.js e usa as funções dele (api, render, go, pill, openModal...). */

Object.assign(A, { catTab: 'eventos', catArchived: false, catEv: null, cat: null, catData: null, realQuery: '' });

const EV_STATE = { pre: ['PENDING', 'por começar'], in: ['PROCESSING', 'ao vivo'], post: ['', 'encerrado'] };
const MK_STATE = { open: ['ok', 'aberto'], suspended: ['REVIEW', 'suspenso'], settled: ['', 'liquidado'] };
const RES_PILL = { won: ['ok', 'Ganhou'], lost: ['bad', 'Perdeu'], void: ['', 'Devolvida'] };
const SPORT_ICONS = ['🎾', '🏐', '🥊', '🥋', '🏎️', '🎮', '🏓', '🏉', '🤾', '⛳', '🏇', '🎯', '🏸', '🚴', '🏊', '🎱'];
const fmtOddIn = (o) => String(o.toFixed(2));
const localInput = (t) => { const d = new Date(t); return new Date(t - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const evState = (ev) => pill(EV_STATE[ev.state][0], EV_STATE[ev.state][1] + (ev.score ? ` ${ev.score.h}-${ev.score.a}` : '') + (ev.state === 'in' && ev.clock ? ' · ' + ev.clock : ''));
const evName = (ev) => (ev.outright ? `🏆 ${ev.home}` : `${ev.home}${ev.away ? ' x ' + ev.away : ''}`);
async function catalog(fresh) { if (fresh || !A.cat) A.cat = await api('GET', '/api/admin/catalog'); return A.cat; }

async function viewCatalog() {
  const subs = [['eventos', 'Eventos da equipa'], ['jogos', 'Mercados em jogos reais'], ['campeonatos', 'Modalidades e campeonatos']];
  const head = `<div class="bar"><h2>Esportes e mercados</h2></div>
    <div class="subtabs">${subs.map(([k, l]) => `<button class="${A.catTab === k ? 'active' : ''}" data-cattab="${k}">${l}</button>`).join('')}</div>`;
  if (A.catTab === 'jogos') return head + await viewRealEvents();
  const cat = await catalog(true);
  return head + (A.catTab === 'campeonatos' ? viewLeagues(cat) : viewManualEvents(cat));
}

function viewManualEvents(cat) {
  const list = cat.events.filter((ev) => ev.archived === A.catArchived);
  const rows = list.map((ev) => `<tr>
    <td>${dt(ev.startsAt)}</td><td>${esc(ev.leagueName)}</td><td><b>${esc(evName(ev))}</b></td><td>${ev.outright ? pill(ev.startsAt > Date.now() ? 'ok' : 'REVIEW', ev.startsAt > Date.now() ? 'longo prazo · aberto' : 'prazo terminado') : evState(ev)}</td>
    <td>${ev.markets ? `${ev.open} abertos de ${ev.markets}` : '<span class="sub">nenhum</span>'}${ev.toSettle && ev.state === 'post' ? `<div class="sub" style="color:var(--yellow)">${ev.toSettle} por liquidar</div>` : ''}</td>
    <td class="num">${ev.bets || ''}</td>
    <td><button class="btn btn-green" style="padding:6px 10px;font-size:12px" data-catev="${esc(ev.id)}">Gerir mercados</button></td></tr>`).join('');
  return `<div class="bar"><h2 style="font-size:15px">Eventos criados pela equipa</h2>
      <select id="catArchived"><option value="0" ${A.catArchived ? '' : 'selected'}>Ativos</option><option value="1" ${A.catArchived ? 'selected' : ''}>Arquivados</option></select>
      <button class="btn btn-green" data-action="newEvent">+ Novo evento</button></div>
    <div class="tbl-wrap">${list.length ? `<table><thead><tr><th>Início</th><th>Campeonato</th><th>Evento</th><th>Estado</th><th>Mercados</th><th class="num">Apostas abertas</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">${A.catArchived ? 'Nenhum evento arquivado.' : 'Ainda não há eventos. Crie um com "+ Novo evento" (pode ser num campeonato da fonte ou num criado por si em "Modalidades e campeonatos").'}</div>`}</div>
    <p class="note" style="text-align:left">Num evento da equipa, todos os mercados e odds são definidos por si. O placar e o estado (por começar / ao vivo / encerrado) também são atualizados à mão. As apostas são pagas quando <b>liquidar</b> cada mercado.</p>`;
}

function viewLeagues(cat) {
  const vis = (x) => (x.hidden ? pill('REVIEW', 'oculto') : pill('ok', 'no site'));
  const sportRows = cat.sports.map((s) => `<tr><td style="font-size:18px">${esc(s.icon)}</td><td><b>${esc(s.name)}</b></td><td>${s.builtin ? '<span class="sub">automática (fonte)</span>' : 'equipa'}</td><td class="num">${s.leagues}</td>
    <td>${s.builtin ? '' : vis(s)}</td>
    <td>${s.builtin ? '' : `<div class="acts"><button class="btn btn-ghost" data-sportedit="${esc(s.key)}">Editar</button><button class="btn btn-ghost" data-sporthide="${esc(s.key)}">${s.hidden ? 'Mostrar' : 'Ocultar'}</button><button class="btn btn-ghost" data-sportdel="${esc(s.key)}">Apagar</button></div>`}</td></tr>`).join('');
  const mine = cat.leagues.filter((l) => !l.builtin), auto = cat.leagues.filter((l) => l.builtin);
  const lgRows = mine.map((l) => `<tr><td>${esc(l.sportName)}</td><td><b>${esc(l.name)}</b>${l.rules ? `<div class="sub">⚡ odds ao vivo: ${esc(rulesSummary(l.rules))}</div>` : ''}</td><td>${esc(l.country || '—')}</td><td class="num">${l.events}</td><td>${vis(l)}</td>
    <td><div class="acts"><button class="btn btn-ghost" data-lgedit="${esc(l.key)}">Editar</button><button class="btn btn-ghost" data-lghide="${esc(l.key)}">${l.hidden ? 'Mostrar' : 'Ocultar'}</button><button class="btn btn-ghost" data-lgdel="${esc(l.key)}">Apagar</button></div></td></tr>`).join('');
  return `<div class="bar"><h2 style="font-size:15px">Modalidades</h2><button class="btn btn-green" data-action="newSport">+ Nova modalidade</button></div>
    <div class="tbl-wrap"><table><thead><tr><th></th><th>Modalidade</th><th>Origem</th><th class="num">Campeonatos</th><th>Estado</th><th></th></tr></thead><tbody>${sportRows}</tbody></table></div>
    <div class="section"><div class="bar"><h2 style="font-size:15px">Campeonatos da equipa</h2><button class="btn btn-green" data-action="newLeague">+ Novo campeonato</button></div>
    <div class="tbl-wrap">${mine.length ? `<table><thead><tr><th>Modalidade</th><th>Campeonato</th><th>País/região</th><th class="num">Eventos</th><th>Estado</th><th></th></tr></thead><tbody>${lgRows}</tbody></table>` : '<div class="empty">Nenhum campeonato criado pela equipa.</div>'}</div></div>
    <p class="note" style="text-align:left">Modalidades e campeonatos novos aparecem no menu do site assim que tiverem eventos. Campeonatos automáticos da fonte (${auto.length}): ${esc(auto.map((l) => l.name).join(', '))}.</p>`;
}

async function viewRealEvents() {
  const { events } = await api('GET', '/api/admin/catalog/real');
  const q = A.realQuery.trim().toLowerCase();
  const list = events.filter((ev) => !q || `${ev.home} ${ev.away} ${ev.leagueName}`.toLowerCase().includes(q)).slice(0, 200);
  const rows = list.map((ev) => `<tr><td>${dt(ev.startsAt)}</td><td>${esc(ev.leagueName)}</td><td><b>${esc(evName(ev))}</b></td><td>${evState(ev)}</td>
    <td>${ev.markets ? `${ev.markets}${ev.toSettle ? ` · <span style="color:var(--yellow)">${ev.toSettle} por liquidar</span>` : ''}` : '<span class="sub">—</span>'}</td><td class="num">${ev.bets || ''}</td>
    <td><button class="btn ${ev.markets ? 'btn-green' : 'btn-ghost'}" style="padding:6px 10px;font-size:12px" data-catev="${esc(ev.id)}">${ev.markets ? 'Gerir mercados' : '+ Mercados'}</button></td></tr>`).join('');
  return `<div class="bar"><h2 style="font-size:15px">Jogos da fonte (MoviOdds)</h2>
      <form id="realSearch" style="display:flex;gap:8px"><input name="q" value="${esc(A.realQuery)}" placeholder="Equipa ou campeonato" style="min-width:220px"><button class="btn btn-ghost" type="submit">Filtrar</button></form></div>
    <div class="tbl-wrap">${list.length ? `<table><thead><tr><th>Início</th><th>Campeonato</th><th>Jogo</th><th>Estado</th><th>Mercados da equipa</th><th class="num">Apostas abertas</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Nenhum jogo encontrado.</div>'}</div>
    <p class="note" style="text-align:left">Os mercados da fonte (resultado, totais, handicap...) continuam automáticos. Aqui acrescenta mercados seus a um jogo real (ex.: escanteios, cartões, marca primeiro), com odds e liquidação feitas pela equipa.</p>`;
}

async function viewCatEvent() {
  const d = await api('GET', '/api/admin/catalog/event?id=' + encodeURIComponent(A.catEv));
  A.catData = d;
  const ev = d.event;
  let info;
  if (ev.manual && ev.outright) {
    const cat = await catalog();
    info = `<div class="card"><form id="evForm" data-id="${esc(ev.id)}" class="ev-form">
      <label>Campeonato<select class="mini" name="league">${leagueOptions(cat, ev.league)}</select></label>
      <label style="grid-column:span 2">Título<input class="mini" name="home" value="${esc(ev.home)}" required maxlength="80"></label>
      <label>Apostas fecham em<input class="mini" type="datetime-local" name="startsAt" value="${localInput(ev.startsAt)}" required></label>
      <label>Estado<select class="mini" name="state"><option value="pre" ${ev.state !== 'post' ? 'selected' : ''}>em aberto</option><option value="post" ${ev.state === 'post' ? 'selected' : ''}>terminado</option></select></label>
      <button class="btn btn-green" type="submit">Guardar evento</button>
    </form><div class="form-err" id="formErr"></div>
    <p class="sub" style="margin:8px 0 0">${ev.startsAt > Date.now() ? `Apostas abertas até ${dt(ev.startsAt)}; depois fecham sozinhas.` : 'O prazo terminou: as apostas estão fechadas. Quando souber o resultado, liquide cada mercado (marque o vencedor; os outros ficam "Perdeu").'}</p>
    <div class="acts" style="margin-top:10px"><button class="btn btn-ghost" data-archive="${esc(ev.id)}" data-val="${ev.archived ? '0' : '1'}">${ev.archived ? 'Reativar no site' : 'Arquivar (tirar do site)'}</button></div></div>`;
  } else if (ev.manual) {
    const cat = await catalog();
    info = `<div class="card"><form id="evForm" data-id="${esc(ev.id)}" class="ev-form">
      <label>Campeonato<select class="mini" name="league">${leagueOptions(cat, ev.league)}</select></label>
      <label>Casa / participante 1<input class="mini" name="home" value="${esc(ev.home)}" required></label>
      <label>Fora / participante 2<input class="mini" name="away" value="${esc(ev.away)}" required></label>
      <label>Início<input class="mini" type="datetime-local" name="startsAt" value="${localInput(ev.startsAt)}" required></label>
      <label>Estado<select class="mini" name="state">${Object.entries(EV_STATE).map(([k, [, l]]) => `<option value="${k}" ${ev.state === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${d.live && d.live.bestOf > 1 ? `<label>Mapas casa<input class="mini" name="mapsH" type="number" min="0" max="9" value="${d.live.state.mh}"></label>
      <label>Mapas fora<input class="mini" name="mapsA" type="number" min="0" max="9" value="${d.live.state.ma}"></label>` : ''}
      <label>Placar casa${d.rules ? ` (${esc(d.rules.unit)})` : ''}<input class="mini" name="scoreH" type="number" min="0" max="999" value="${ev.score ? ev.score.h : ''}"></label>
      <label>Placar fora${d.rules ? ` (${esc(d.rules.unit)})` : ''}<input class="mini" name="scoreA" type="number" min="0" max="999" value="${ev.score ? ev.score.a : ''}"></label>
      <label>Tempo (texto livre)<input class="mini" name="clock" value="${esc(ev.clock)}" placeholder="Ex.: 2º tempo 67'"></label>
      <label>Jogo<select class="mini" name="game">${gameOptions(ev.game, true)}</select></label>
      <label style="grid-column:span 2">Transmissão (link Twitch, YouTube ou Kick)<input class="mini" name="stream" value="${esc(ev.stream || '')}" placeholder="Ex.: https://www.twitch.tv/rainbow6br" maxlength="300"></label>
      <button class="btn btn-green" type="submit">Guardar evento</button>
    </form><div class="form-err" id="formErr"></div>
    <div class="acts" style="margin-top:10px"><button class="btn btn-ghost" data-archive="${esc(ev.id)}" data-val="${ev.archived ? '0' : '1'}">${ev.archived ? 'Reativar no site' : 'Arquivar (tirar do site)'}</button></div></div>
    ${catLiveCard(d)}`;
  } else {
    info = `<div class="card"><div class="kv2"><span>Campeonato</span><b>${esc(ev.leagueName)}</b></div><div class="kv2"><span>Início</span><b>${dt(ev.startsAt)}</b></div>
      <div class="kv2"><span>Estado (fonte)</span><b>${evState(ev)}</b></div>
      <p class="sub" style="margin:8px 0 0">Jogo real: placar e mercados automáticos vêm da fonte. Os mercados abaixo são só os da equipa.</p></div>`;
  }
  let lastG;
  const markets = d.markets.map((m) => {
    const g = m.group || null;
    const head = new Set(d.markets.map((x) => x.group).filter(Boolean)).size > 1 && g !== lastG ? `<h3 class="map-sec">${esc(g || 'Partida')}</h3>` : '';
    lastG = g;
    return head + marketCard(m);
  }).join('');
  const pendingN = d.markets.filter((m) => m.status !== 'settled').length;
  const ready = d.markets.filter((m) => m.status !== 'settled' && m.sels.length && m.sels.every((s) => s.suggest)).length;
  return `<div class="bar"><h2>${esc(evName(ev))}</h2><span class="sub">${esc(ev.leagueName)}</span>${ready ? `<button class="btn btn-green" data-settleall="1">Liquidar tudo pelo placar (${ready})</button>` : ''}<button class="btn btn-ghost" data-go="esportes">← Voltar</button></div>
    ${ev.state === 'post' && pendingN ? `<div class="warn">O evento terminou e há ${pendingN} mercado(s) por liquidar. As apostas só são pagas depois de liquidar.</div>` : ''}
    ${info}
    <div class="section"><div class="bar"><h2 style="font-size:15px">Mercados (${d.markets.length})</h2>
      ${pendingN ? `<button class="btn btn-ghost" data-mkstatus="*|suspended">Suspender todos</button><button class="btn btn-ghost" data-mkstatus="*|open">Abrir todos</button>` : ''}
      <button class="btn btn-green" data-action="newMarket">+ Novo mercado</button></div>
    ${markets || '<div class="tbl-wrap"><div class="empty">Sem mercados. Crie o primeiro com "+ Novo mercado".</div></div>'}</div>`;
}

// mapas da série: quem escolheu cada um (o último é o decisivo por defeito)
const defaultPick = (n, bestOf) => (n === bestOf ? '' : n % 2 ? 'h' : 'a');
function mapsRows(bestOf, maps, home, away, chances) {
  let html = '';
  for (let n = 1; n <= bestOf; n++) {
    const m = maps?.[n - 1], pick = m ? m.pick || '' : defaultPick(n, bestOf), c = chances?.[n - 1];
    html += `<div class="map-row"><b>Mapa ${n}</b><input class="mini" name="mapName${n}" value="${esc(m?.name || '')}" maxlength="30" placeholder="nome (ex.: Clubhouse)">
      <select class="mini" name="mapPick${n}"><option value="h" ${pick === 'h' ? 'selected' : ''}>escolha de ${esc(home)}</option><option value="a" ${pick === 'a' ? 'selected' : ''}>escolha de ${esc(away)}</option><option value="" ${pick === '' ? 'selected' : ''}>decisivo / sem escolha</option></select>
      ${c != null ? `<span class="sub">${esc(home)} ${c}% · ${esc(away)} ${Math.round((100 - c) * 10) / 10}%</span>` : ''}</div>`;
  }
  return html;
}
const mapsFrom = (fd, bestOf) => Array.from({ length: Number(bestOf) || 1 }, (_, i) => ({ name: fd['mapName' + (i + 1)] || '', pick: fd['mapPick' + (i + 1)] || null }));

function catLiveCard(d) {
  const ev = d.event, lv = d.live, R = d.rules;
  if (!R) return `<div class="card" style="margin-top:12px"><b>Odds automáticas ao vivo</b><p class="sub" style="margin:6px 0 0">Para as odds acompanharem o placar, defina as <b>regras do jogo</b> do campeonato ${esc(ev.leagueName)} (Modalidades e campeonatos → Editar).</p></div>`;
  const st = lv.state, last = st.history[st.history.length - 1];
  const [h, a] = st.over && last ? [last.h, last.a] : [st.a, st.b];
  const maps = lv.bestOf > 1 ? `<div class="lv-maps">${st.over ? 'Partida terminada' : `${esc(R.mapName)} ${st.curMap} (melhor de ${lv.bestOf})`} · ${esc(R.mapName)}s <b>${st.mh}-${st.ma}</b>${st.history.length ? ' · ' + st.history.map((m, i) => `${esc(R.mapName)} ${i + 1}: ${m.h}-${m.a}`).join(' · ') : ''}</div>` : '';
  const btn = (side, name) => `<button class="btn btn-green lv-btn" data-round="${side}" ${st.over ? 'disabled' : ''}>+1 ${esc(R.unit.replace(/s$/, ''))}<small>${esc(name)}</small></button>`;
  return `<div class="card live-card">
    <div class="mk-head"><b class="grow">Placar ao vivo ${lv.auto ? pill('ok', 'odds automáticas ligadas') : pill('', 'odds automáticas desligadas')}</b><span class="sub">${esc(rulesSummary(R))}</span></div>
    <div class="lv-score">${btn('h', ev.home)}<div class="lv-num">${h} : ${a}</div>${btn('a', ev.away)}</div>
    ${maps}
    <div class="acts" style="justify-content:center;margin-top:8px"><button class="btn btn-ghost" data-round="undo" ${lv.rounds ? '' : 'disabled'}>↶ Desfazer último round</button><button class="btn btn-ghost" data-bot="1" ${st.over ? 'disabled' : ''} title="Versão antiga: corre neste browser e precisa de marcar as caixas">Bot no browser (manual)</button></div>
    ${srvBotCard(d)}
    <p class="sub" style="text-align:center;margin:8px 0 14px">Cada clique conta 1 round, põe o evento ao vivo e recalcula as odds dos mercados automáticos. ${esc(R.mapName)} ganho passa sozinho ao seguinte; no fim, o evento fica encerrado.</p>
    <form id="liveForm" class="ev-form">
      <label class="check" style="margin:0"><input type="checkbox" name="auto" ${lv.auto ? 'checked' : ''}> Odds automáticas ao vivo</label>
      <label>Melhor de<select class="mini" name="bestOf">${[1, 3, 5, 7].map((n) => `<option ${lv.bestOf === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Chance de ${esc(ev.home)} ganhar, antes do jogo (%)<input class="mini" name="strength" inputmode="decimal" placeholder="${lv.prematch ?? lv.fromOdds ?? 'ex.: 65'}"></label>
      <button class="btn btn-green" type="submit">Guardar</button>
      <button type="button" class="btn btn-ghost" data-calib="1">Usar odds do Vencedor${lv.fromOdds != null ? ` (${lv.fromOdds}%)` : ''}</button>
    </form>
    <p class="sub" style="margin:8px 0 0">Mercados padrão (abrem ao ligar as odds automáticas): por ${esc(R.mapName)} — vencedor, total e handicap de ${esc(R.unit)} e corridas a X ${esc(R.unit)}; só antes do jogo — ${esc(R.unit)} de cada equipa, margem de vitória e placar exato (o placar do 1º tempo fica também ao vivo, até ao intervalo)${lv.bestOf > 1 ? `; na série — total e handicap de ${esc(R.mapName)}s, placar exato e ambas ganham um ${esc(R.mapName)}` : ''}. As odds seguem a força das equipas. <button type="button" class="btn btn-ghost" style="padding:5px 10px;font-size:12px" data-openmaps="1">Abrir mercados padrão</button></p>
    <form id="mapsForm" style="margin-top:12px"><b>Mapas ${lv.bestOf > 1 ? 'da série' : 'do jogo'}</b> <span class="sub">— quem escolhe o mapa fica mais forte nele; o adversário começa no lado bom (vantagem nas primeiras rounds e nas corridas)</span>
      ${mapsRows(lv.bestOf, lv.maps, ev.home, ev.away, lv.maps?.map((m) => m.chance))}
      <button class="btn btn-ghost" type="submit" style="margin-top:6px">Guardar mapas</button></form>
    ${ev.state === 'in' && !st.over ? `<form id="aliveForm" class="ev-form" style="margin-top:12px"><b style="grid-column:1/-1">Dentro do round ${lv.alive ? pill('ok', `${lv.alive.h} v ${lv.alive.a}`) : ''} <span class="sub">jogadores vivos agora (o bot da transmissão preenche sozinho)</span></b>
      <label>Vivos ${esc(ev.home)}<select class="mini" name="h">${[5, 4, 3, 2, 1, 0].map((n) => `<option ${(lv.alive ? lv.alive.h : 5) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Vivos ${esc(ev.away)}<select class="mini" name="a">${[5, 4, 3, 2, 1, 0].map((n) => `<option ${(lv.alive ? lv.alive.a : 5) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button class="btn btn-green" type="submit">Aplicar</button>${lv.alive ? '<button type="button" class="btn btn-ghost" data-aliveclear="1">Limpar</button>' : ''}</form>` : ''}
    <p class="sub" style="margin:10px 0 0">${lv.p != null ? `Modelo: ${esc(ev.home)} ganha cada round com <b>${(lv.p * 100).toFixed(1)}%</b> → chance de ganhar a partida antes do jogo <b>${lv.prematch}%</b>, agora <b>${lv.chance}%</b>.` : 'Força ainda não calibrada: crie um mercado do tipo "Vencedor da partida" e clique em "Usar odds do Vencedor" (ou escreva a chance).'}</p>
  </div>`;
}
/* ---------- bot da transmissão no servidor (streambot.js) ----------
   O servidor abre o link da partida, encontra o placar sozinho e administra o jogo; aqui só se liga/desliga e vê. */
function srvBotCard(d) {
  const ev = d.event, on = !!d.live.bot?.on, o = d.live.bot || {};
  return `<div class="srvbot" id="srvBot" data-ev="${esc(ev.id)}">
    <div class="mk-head"><b class="grow">🤖 Bot da transmissão ${on ? pill('ok', 'ligado no servidor') : pill('', 'desligado')}</b>
      <button class="btn ${on ? 'btn-ghost' : 'btn-green'}" data-srvbot="${on ? 'stop' : 'start'}" ${!ev.stream || d.live.state.over ? 'disabled' : ''}>${on ? '⏸ Desligar' : '▶ Ligar bot'}</button></div>
    ${ev.stream ? `<p class="sub" style="margin:4px 0">Lê o vídeo de <b>${esc(ev.stream)}</b> no servidor (sem janela aberta e sem marcar nada): encontra o placar e os nomes das equipas, conta os rounds, suspende quando tem dúvidas e liquida as apostas.</p>`
      : '<p class="sub" style="margin:4px 0">Preencha o campo <b>Transmissão</b> do jogo (acima) com o link para ligar o bot.</p>'}
    <div class="bot-opts"><label class="check"><input type="checkbox" id="srvBotSettle" ${o.autoSettle === false ? '' : 'checked'}> Liquidar as apostas sozinho (60 s depois de o placar decidir)</label>
      <label class="check"><input type="checkbox" id="srvBotAlive" ${o.alive === false ? '' : 'checked'}> Ler jogadores vivos (odd dentro do round)</label></div>
    <div id="srvBotInfo">${on ? '<p class="sub">A ligar...</p>' : ''}</div>
    <div class="bot-prev" id="srvBotPrev" style="display:none"><img id="srvBotImg" alt="o que o bot está a ver"><div id="srvBotBoxes"></div></div>
    <div class="bot-log" id="srvBotLog"></div></div>`;
}
const BOT_KIND = { ok: 'ok', warn: 'warn', bad: 'bad' };
function srvBotFill(s) {
  const box = $('#srvBot');
  if (!box) return;
  const info = $('#srvBotInfo'), prev = $('#srvBotPrev');
  if (!s.on && !s.log) { info.innerHTML = ''; prev.style.display = 'none'; return; }
  const [L, R] = s.swap ? [s.away, s.home] : [s.home, s.away];
  const read = s.read ? `${esc(s.home)} <b>${s.read.h}</b> x <b>${s.read.a}</b> ${esc(s.away)}` : '—';
  const site = s.srv ? `${s.srv.a}-${s.srv.b}${s.srv.map ? ` (mapa ${s.srv.map})` : ''}` : '—';
  info.innerHTML = `<div class="bot-state ${s.susp ? 'bad' : !s.on ? '' : s.sidesOk ? 'ok' : 'warn'}">${s.susp ? '⚠️ Mercados suspensos pelo bot: ' + esc(s.why) : esc(s.status || 'parado')}${s.quality ? ` · vídeo ${esc(s.quality)}` : ''}</div>
    <div class="bot-grid"><div><small>No vídeo</small>${read}</div><div><small>No site</small><b>${site}</b></div><div><small>Vivos no vídeo</small><b>${s.alive ? `${s.alive.h} v ${s.alive.a}` : '—'}</b></div></div>
    <div class="acts" style="align-items:center;margin:6px 0"><span class="sub">No ecrã: <b>${esc(L)}</b> à esquerda${s.names ? ` (lido "${esc(s.names.L)}" | "${esc(s.names.R)}")` : ''}${s.sidesManual ? ' · confirmado à mão' : ''}</span>
      ${s.on ? `<button class="btn btn-ghost" data-srvside="0">Esquerda é ${esc(s.home)}</button><button class="btn btn-ghost" data-srvside="1">Esquerda é ${esc(s.away)}</button>` : ''}
      ${s.on && s.read && s.srv && (s.read.h !== s.srv.a || s.read.a !== s.srv.b) ? '<button class="btn btn-ghost" data-srvsync="1" title="Ligou o bot a meio de um mapa? O site passa a ter o placar do vídeo">Usar o placar do vídeo</button>' : ''}</div>
    <p class="sub" style="margin:0">Nesta partida: ${s.stats?.rounds || 0} round(s) contado(s) · ${s.stats?.settled || 0} mercado(s) liquidado(s)${s.settleIn != null ? ` · próxima liquidação em ${s.settleIn} s` : ''}</p>`;
  if (s.frameAt) {
    prev.style.display = '';
    const img = $('#srvBotImg');
    if (img.dataset.at !== String(s.frameAt)) { img.dataset.at = String(s.frameAt); img.src = `/api/admin/bot/frame?id=${encodeURIComponent(box.dataset.ev)}&t=${s.frameAt}`; }
    const pct = (b, cls, lbl) => (b ? `<div class="bbox ${cls}" style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%"><span>${esc(lbl)}</span></div>` : '');
    $('#srvBotBoxes').innerHTML = (s.boxes ? pct(s.boxes.L, 'l', L) + pct(s.boxes.R, 'r', R) + pct(s.boxes.AL, 'l', '') + pct(s.boxes.AR, 'r', '') : '')
      + (s.bars ? s.bars.L.map((b) => pct(b, 'l', '')).join('') + s.bars.R.map((b) => pct(b, 'r', '')).join('') : '');
  }
  $('#srvBotLog').innerHTML = (s.log || []).slice(0, 10).map((x) => `<div class="${BOT_KIND[x.kind] || ''}"><span>${new Date(x.t).toLocaleTimeString('pt-BR')}</span> ${esc(x.msg)}</div>`).join('');
}
// atualiza o cartão do bot a cada 2 s; quando o bot conta um round, redesenha a página (placar e odds novas)
let srvBotSeen = null;
async function srvBotTick() {
  const box = $('#srvBot');
  if (!box || A.view !== 'esporte-ev' || $('#modal').classList.contains('show')) return;
  try {
    const s = await api('GET', '/api/admin/bot/status?id=' + encodeURIComponent(box.dataset.ev));
    if (!$('#srvBot')) return;
    srvBotFill(s);
    const sig = s.srv ? `${box.dataset.ev}|${s.srv.a}|${s.srv.b}|${s.srv.mh}|${s.srv.ma}|${s.stats.settled}|${s.susp}|${s.on}` : null;
    const lv = A.catData?.live?.state;
    if (sig && srvBotSeen && sig !== srvBotSeen && lv) render();
    srvBotSeen = sig;
  } catch { /* sem sessão / rede: tenta no próximo */ }
}
setInterval(srvBotTick, 2000);

const sideTag = (s, ev) => {
  if (!s.side) return '';
  const nm = { home: ev.home, away: ev.away, over: `mais de ${s.line}`, under: `menos de ${s.line}` }[s.side];
  const ln = (s.side === 'home' || s.side === 'away') && s.line != null ? ` ${s.line > 0 ? '+' : ''}${s.line}` : '';
  return `<div class="sub">→ ${esc(nm)}${ln}${s.hidden ? ' · linha antiga (fora do site)' : s.locked ? ' · 🔒 fechada no site' : ''}${s.suggest ? ` · placar diz: ${RES_PILL[s.suggest][1].toLowerCase()}` : ''}</div>`;
};
const typeSelect = (auto) => {
  const T = A.cat?.types || {};
  return `<select class="mini" name="atype" title="Como as odds deste mercado são definidas"><option value="">Odds à mão</option>${Object.entries(T).filter(([, t]) => !t.gen).map(([k, t]) => `<option value="${k}" ${auto?.type === k ? 'selected' : ''}>⚡ ${esc(t.label)}</option>`).join('')}</select>
    <label class="sub" style="display:flex;gap:4px;align-items:center">mapa<input class="mini" name="amap" type="number" min="1" max="9" style="width:52px" value="${auto?.map || 1}"></label>
    <label class="sub" style="display:flex;gap:4px;align-items:center" title="Handicap e totais: a linha acompanha o placar (as linhas antigas saem do site)"><input type="checkbox" name="amove" ${auto?.lines === 'fixed' ? '' : 'checked'}> linhas móveis</label>`;
};

function marketCard(m) {
  const [cls, label] = MK_STATE[m.status];
  const betsN = m.sels.reduce((s, x) => s + x.bets, 0);
  const T = m.auto && A.cat?.types?.[m.auto.type];
  if (T && T.gen && m.status !== 'settled') {
    // mercado do pacote padrão: odds e seleções só do modelo
    const vis = m.sels.filter((s) => !s.hidden || s.bets);
    const when = T.pre ? 'só antes do jogo' : 'antes e durante o jogo';
    return `<div class="mk-card"><div class="mk-head"><b class="grow">${esc(m.name)}</b>${vis.some((s) => !s.hidden) ? pill(cls, label) : pill('REVIEW', 'fora do site')}<span class="sub">⚡ automático · ${when}</span></div>
      ${vis.length ? `<table><tbody>${vis.map((s) => `<tr${s.hidden ? ' class="old-line"' : ''}><td>${esc(s.name)}${s.suggest ? `<div class="sub">placar diz: ${RES_PILL[s.suggest][1].toLowerCase()}</div>` : ''}</td><td class="num">${s.hidden ? '—' : s.locked ? '🔒' : s.odds.toFixed(2)}</td><td class="num">${s.bets ? `${s.bets} aposta(s) · ${money(s.stake)}` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="sub" style="margin:0">Sem seleções no site neste momento.</p>'}
      <div class="mk-foot"><button type="button" class="btn btn-ghost" data-mkstatus="${esc(m.id)}|${m.status === 'open' ? 'suspended' : 'open'}">${m.status === 'open' ? 'Suspender' : 'Abrir'}</button>
        <button type="button" class="btn btn-ghost" data-mksettle="${esc(m.id)}">Liquidar</button>${betsN ? '' : `<button type="button" class="btn btn-ghost" data-mkdel="${esc(m.id)}">Apagar</button>`}</div></div>`;
  }
  if (m.status === 'settled') {
    return `<div class="mk-card settled"><div class="mk-head"><b class="grow">${esc(m.name)}</b>${pill(cls, label)}<span class="sub">${dt(m.settledAt)} · ${esc(m.settledBy || '')}</span></div>
      <table><tbody>${m.sels.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${s.odds.toFixed(2)}</td><td>${pill(...RES_PILL[s.result])}</td></tr>`).join('')}</tbody></table>
      ${m.note ? `<div class="sub" style="margin-top:6px">${esc(m.note)}</div>` : ''}</div>`;
  }
  const rows = m.sels.map((s) => selRow(s, A.catData.event)).join('');
  const oldN = m.sels.filter((s) => s.hidden).length;
  const closed = m.auto && m.sels.length && m.sels.every((s) => s.hidden);
  return `<form class="mk-card mkForm" data-mk="${esc(m.id)}">
    <div class="mk-head"><input class="mini grow" name="name" value="${esc(m.name)}" required maxlength="80" title="Nome do mercado">${closed ? pill('REVIEW', 'fora do site (reta final)') : pill(cls, label)}${A.catData.event.manual ? typeSelect(m.auto) : ''}
      <label class="sub" style="display:flex;gap:6px;align-items:center">Aposta máx. R$<input class="mini" name="maxStake" style="width:90px" value="${m.maxStake != null ? String(m.maxStake).replace('.', ',') : ''}" placeholder="sem limite"></label>
      <label class="sub" style="display:flex;gap:6px;align-items:center" title="Depois desta data o mercado fecha sozinho (opcional)">Fecha em<input class="mini" type="datetime-local" name="mclose" value="${m.closesAt ? localInput(m.closesAt) : ''}"></label>
      ${m.closesAt && m.closesAt <= Date.now() ? pill('REVIEW', 'prazo terminado') : ''}</div>
    <div class="tbl-wrap" style="border:0"><table><thead><tr><th>Seleção</th><th>Odd</th><th class="num">Apostas</th><th class="num">Apostado</th><th class="num" title="Prêmio a pagar se esta seleção ganhar (apostas simples)">A pagar se ganhar</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="mk-foot"><button type="button" class="btn btn-ghost" data-seladd="${esc(m.id)}">+ Seleção</button>
      <button type="submit" class="btn btn-green">Guardar odds</button>
      <button type="button" class="btn btn-ghost" data-mkstatus="${esc(m.id)}|${m.status === 'open' ? 'suspended' : 'open'}">${m.status === 'open' ? 'Suspender' : 'Abrir'}</button>
      <button type="button" class="btn btn-ghost" data-mksettle="${esc(m.id)}">Liquidar</button>
      ${betsN ? '' : `<button type="button" class="btn btn-ghost" data-mkdel="${esc(m.id)}">Apagar</button>`}
      <span class="sub">${betsN ? `${betsN} seleção(ões) em apostas abertas` : 'sem apostas'}${m.maxStake != null ? ` · máx. ${money(m.maxStake)} por aposta` : ''}${m.auto ? ' · ⚡ odds recalculadas a cada round (o que escrever à mão vale até ao próximo round)' : ''}${oldN ? ` · ${oldN} linha(s) antiga(s) fora do site` : ''}</span></div>
  </form>`;
}
const selRow = (s = {}, ev) => `<tr data-sel="${esc(s.id || '')}"${s.hidden ? ` class="old-line"${s.bets ? '' : ' style="display:none"'}` : ''}>
  <td><input class="mini" name="sname" value="${esc(s.name || '')}" required maxlength="60" style="width:100%">${ev ? sideTag(s, ev) : ''}</td>
  <td><input class="mini odd-in" name="sodds" value="${s.odds ? fmtOddIn(s.odds) : ''}" required inputmode="decimal" placeholder="1.85"></td>
  <td class="num">${s.bets || ''}</td><td class="num">${s.bets ? money(s.stake) : ''}</td><td class="num">${s.bets ? money(s.singles) : ''}</td>
  <td>${s.bets ? '' : '<button type="button" class="rm" data-selrm="1" title="Remover">×</button>'}</td></tr>`;

function leagueOptions(cat, cur) {
  const groups = new Map();
  for (const l of cat.leagues) { if (!groups.has(l.sportName)) groups.set(l.sportName, []); groups.get(l.sportName).push(l); }
  return [...groups].map(([sp, ls]) => `<optgroup label="${esc(sp)}">${ls.map((l) => `<option value="${esc(l.key)}" ${l.key === cur ? 'selected' : ''}>${esc(l.name)}${l.builtin ? '' : ' (equipa)'}${l.hidden ? ' — oculto' : ''}</option>`).join('')}</optgroup>`).join('');
}
async function newEventModal() {
  const cat = await catalog(true);
  const t = new Date(); t.setMinutes(0, 0, 0); t.setHours(t.getHours() + 2);
  // de preferência um campeonato com regras do jogo (já vem com os mercados automáticos)
  const pick = (cat.leagues.find((l) => !l.builtin && l.rules && !l.hidden) || cat.leagues.find((l) => !l.builtin))?.key;
  openModal(`<h3>Novo evento</h3><p class="sub">Escolha o campeonato (pode criar um novo em "Modalidades e campeonatos").</p>
    <form id="newEvForm"><div class="subtabs" style="margin:0 0 6px"><label class="check" style="margin:0 12px 0 0"><input type="radio" name="kind" value="game" checked> Jogo (casa x fora)</label><label class="check" style="margin:0"><input type="radio" name="kind" value="outright"> 🏆 Longo prazo (campeão, artilheiro...)</label></div>
      <label class="lbl">Campeonato *</label><select class="inp" name="league" id="newEvLeague" required>${leagueOptions(cat, pick)}</select>
      <fieldset id="evKindGame" style="border:0;padding:0;margin:0">
        <label class="lbl">Casa / participante 1 *</label><input class="inp" name="home" required maxlength="60">
        <label class="lbl">Fora / participante 2 *</label><input class="inp" name="away" required maxlength="60">
        <label class="lbl">Início *</label><input class="inp" type="datetime-local" name="startsAt" value="${localInput(t.getTime())}" required>
        <label class="lbl">Transmissão (opcional: link Twitch, YouTube ou Kick)</label><input class="inp" name="stream" maxlength="300" placeholder="Ex.: https://www.twitch.tv/rainbow6br">
        <div id="newEvAuto"></div>
      </fieldset>
      <fieldset id="evKindOut" style="border:0;padding:0;margin:0;display:none" disabled>
        <label class="lbl">Título *</label><input class="inp" name="title" required maxlength="80" placeholder="Ex.: Campeão do SIX Major 2026">
        <label class="lbl">Apostas fecham em *</label><input class="inp" type="datetime-local" name="closesAt" value="${localInput(t.getTime() + 7 * 86400000)}" required>
        <label class="lbl">Mercado *</label><input class="inp" name="mkName" value="Campeão" required maxlength="80">
        <label class="lbl">Participantes e odds * (um por linha: <b>Nome; odd</b>)</label>
        <textarea class="inp" name="mkSels" required placeholder="FaZe Clan; 3.50&#10;Team Liquid; 4.00&#10;w7m esports; 5.00&#10;Team Falcons; 6.50"></textarea>
        <p class="sub" style="margin:6px 0 0">Depois do prazo as apostas fecham sozinhas. Pode juntar mais mercados (ex.: melhor jogador) na página do evento, cada um com o seu prazo.</p>
      </fieldset>
      <div class="form-err" id="formErr"></div><button class="btn btn-green btn-block" type="submit" style="margin-top:14px">Criar evento</button></form>`);
  renderNewEvAuto();
}
// jogo do evento (R6 / CS2 / Valorant): define as regras dos rounds; vazio = as do campeonato
const gameOptions = (cur, withNone) => (withNone ? `<option value="" ${!cur ? 'selected' : ''}>regras do campeonato</option>` : '')
  + Object.entries(A.cat?.presets || {}).map(([k, x]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${esc(x.label)}</option>`).join('');
// campeonato com regras do jogo (ou jogo escolhido): o evento já nasce com o Vencedor e o pacote padrão de mercados automáticos
function renderNewEvAuto() {
  const box = $('#newEvAuto'), sel = $('#newEvLeague');
  if (!box || !sel) return;
  const f = sel.form, keep = (k) => f.elements[k]?.value;
  const lg = A.cat.leagues.find((l) => l.key === sel.value), LR = lg?.rules;
  // jogo: o que já estava escolhido; senão o do campeonato
  const game = keep('game') ?? (LR && A.cat.presets[LR.preset] ? LR.preset : '');
  const R = game && A.cat.presets[game] ? { ...A.cat.presets[game], ...(LR ? { margin: LR.margin } : {}) } : LR;
  const old = { oddsHome: keep('oddsHome') || '', oddsAway: keep('oddsAway') || '', bestOf: Number(keep('bestOf')) || R?.bestOf || 1 };
  const gameSel = `<label class="lbl">Jogo</label><select class="inp" name="game" id="newEvGame"><option value="" ${!game ? 'selected' : ''}>${LR ? 'Regras do campeonato' : '— outro (sem odds automáticas)'}</option>${gameOptions(game, false)}</select>`;
  if (!R) { box.innerHTML = gameSel + '<p class="sub" style="margin-top:10px">Sem jogo escolhido e o campeonato não tem regras: os mercados são criados à mão depois.</p>'; return; }
  box.innerHTML = gameSel + `<div class="rules-box"><label class="check" style="color:var(--text);margin:0 0 8px"><input type="checkbox" name="auto" checked> <b>Mercados padrão com odds automáticas</b></label>
    <div class="grid2">
      <div><label class="lbl">Odd do Vencedor — casa</label><input class="inp" name="oddsHome" inputmode="decimal" placeholder="1.85" value="${esc(old.oddsHome)}"></div>
      <div><label class="lbl">Odd do Vencedor — fora</label><input class="inp" name="oddsAway" inputmode="decimal" placeholder="1.85" value="${esc(old.oddsAway)}"></div>
      <div><label class="lbl">Melhor de (${esc(R.mapName)}s)</label><select class="inp" name="bestOf" id="newEvBestOf">${[1, 3, 5, 7].map((n) => `<option ${old.bestOf === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    </div>
    <label class="lbl">Mapas (quem escolheu cada um)</label><div id="newEvMaps">${mapsRows(old.bestOf, null, 'casa', 'fora')}</div>
    <p class="sub" style="margin:8px 0 0">Abre logo: Vencedor, total e handicap de ${esc(R.unit)}, corridas, placar do 1º tempo, ${esc(R.unit)} de cada equipa, margem e placar exato${R.bestOf > 1 ? ', e os da série' : ''} (em melhor de 3+, um bloco por ${esc(R.mapName)}). As odds saem da força das equipas, tirada das odds do Vencedor (vazio = 50/50).<br>Regras: ${esc(rulesSummary(R))}</p></div>`;
}
function sportModal(s) {
  openModal(`<h3>${s ? 'Editar modalidade' : 'Nova modalidade'}</h3>
    <form id="sportForm" data-key="${esc(s?.key || '')}" data-hidden="${s?.hidden ? '1' : ''}"><label class="lbl">Nome *</label><input class="inp" name="name" value="${esc(s?.name || '')}" required maxlength="40" placeholder="Ex.: Tênis, Vôlei, MMA, eSports">
      <label class="lbl">Ícone (emoji)</label><input class="inp" name="icon" id="sportIcon" value="${esc(s?.icon || '')}" maxlength="8" placeholder="🏅">
      <div class="icons">${SPORT_ICONS.map((i) => `<button type="button" data-icon="${i}">${i}</button>`).join('')}</div>
      <div class="form-err" id="formErr"></div><button class="btn btn-green btn-block" type="submit" style="margin-top:14px">Guardar</button></form>`);
}
async function leagueModal(l) {
  const cat = await catalog();
  openModal(`<h3>${l ? 'Editar campeonato' : 'Novo campeonato'}</h3>
    <form id="leagueForm" data-key="${esc(l?.key || '')}" data-hidden="${l?.hidden ? '1' : ''}"><label class="lbl">Modalidade *</label>
      <select class="inp" name="sport" required>${cat.sports.filter((s) => !s.hidden || s.key === l?.sport).map((s) => `<option value="${esc(s.key)}" ${s.key === l?.sport ? 'selected' : ''}>${esc(s.icon)} ${esc(s.name)}</option>`).join('')}</select>
      <label class="lbl">Nome *</label><input class="inp" name="name" value="${esc(l?.name || '')}" required maxlength="60" placeholder="Ex.: Campeonato Carioca, Roland Garros, UFC 320">
      <label class="lbl">País / região</label><input class="inp" name="country" value="${esc(l?.country || '')}" maxlength="40" placeholder="Ex.: Brasil, Mundo">
      ${rulesFields(l?.rules || null)}
      <div class="form-err" id="formErr"></div><button class="btn btn-green btn-block" type="submit" style="margin-top:14px">Guardar</button></form>`);
  updateRulesExample();
}
/* Regras do jogo do campeonato: o motor de odds ao vivo usa-as para saber como se ganha um mapa e a partida */
const OT_LABEL = { none: 'Sem prorrogação: no empate, o round seguinte decide', by2: 'Vence quem abrir 2 rounds de vantagem', blocks: 'Blocos de rounds: vence quem ganhar a maioria do bloco' };
function rulesFields(r) {
  const P = A.cat.presets, on = !!r;
  r = r || { ...P.r6, preset: 'r6', notes: '' };
  const f = (label, html) => `<div><label class="lbl">${label}</label>${html}</div>`;
  return `<div class="rules-box"><label class="check" style="color:var(--text)"><input type="checkbox" name="rulesOn" id="rulesOn" ${on ? 'checked' : ''}> <b>Regras do jogo por rounds</b> &nbsp;<span class="sub">(liga as odds automáticas ao vivo nos eventos deste campeonato)</span></label>
    <div id="rulesBody" style="${on ? '' : 'display:none'}">
      ${f('Modelo', `<select class="inp" name="preset" id="rulesPreset">${Object.entries(P).map(([k, x]) => `<option value="${k}" ${r.preset === k ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}<option value="custom" ${r.preset === 'custom' ? 'selected' : ''}>Personalizado</option></select>`)}
      <div class="grid2">
        ${f('Rounds para ganhar um mapa', `<input class="inp" name="target" type="number" min="1" max="50" value="${r.target}">`)}
        ${f('Partida: melhor de (mapas)', `<select class="inp" name="bestOf">${[1, 3, 5, 7].map((n) => `<option value="${n}" ${r.bestOf === n ? 'selected' : ''}>${n}</option>`).join('')}</select>`)}
        ${f('Prorrogação (empate em N-1 x N-1)', `<select class="inp" name="ot">${Object.entries(OT_LABEL).map(([k, l]) => `<option value="${k}" ${r.ot === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
        ${f('Rounds por bloco da prorrogação', `<input class="inp" name="otBlock" type="number" min="1" max="20" value="${r.otBlock}">`)}
        ${f('Margem da casa (%)', `<input class="inp" name="margin" value="${r.margin}">`)}
        ${f('Nome da unidade / do mapa', `<div style="display:flex;gap:6px"><input class="inp" name="unit" value="${esc(r.unit)}" placeholder="rounds"><input class="inp" name="mapName" value="${esc(r.mapName)}" placeholder="mapa"></div>`)}
        ${f('Odd mínima das linhas (handicap e totais)', `<input class="inp" name="minOdd" inputmode="decimal" value="${r.minOdd ?? 1.15}" title="Linhas com odd abaixo disto ficam bloqueadas: não deixa apostas fáceis">`)}
        ${f('Reta final: reduzir a 1 linha a X rounds do fim', `<input class="inp" name="endgame" type="number" min="0" max="10" value="${r.endgame ?? 2}" title="Ex.: 2 no R6 → a partir de 5 rounds só a linha equilibrada; no match point (6) handicap e totais do mapa saem do site. 0 = desligado">`)}
        ${f('Rounds do 1º tempo (0 = sem mercado de 1º tempo)', `<input class="inp" name="half" type="number" min="0" max="40" value="${r.half ?? 0}" title="R6: 6 · CS2 e Valorant: 12">`)}
        ${f('Quem escolhe o mapa: + pontos % por round', `<input class="inp" name="pickEdge" inputmode="decimal" value="${r.pickEdge ?? P[r.preset]?.pickEdge ?? 3}" title="Ex.: 3 → num mapa equilibrado quem o escolheu ganha cada round com 53%">`)}
        ${f('Lado bom (1º tempo de quem não escolheu): + pontos %', `<input class="inp" name="sideEdge" inputmode="decimal" value="${r.sideEdge ?? P[r.preset]?.sideEdge ?? 0}" title="R6: 6 · CS2: 4 · Valorant: 3. O adversário de quem escolheu o mapa escolhe o lado e começa no lado bom; no 2º tempo troca">`)}
        ${f('Peso dos jogadores vivos (dentro do round)', `<input class="inp" name="aliveEdge" inputmode="decimal" value="${r.aliveEdge ?? P[r.preset]?.aliveEdge ?? 3}" title="3 → 5v4 dá ~73% ao round, 5v3 ~89%, 2v1 ~85%">`)}
        ${f('Linhas por mercado (móveis)', `<select class="inp" name="lines">${[1, 3, 5].map((n) => `<option value="${n}" ${(r.lines ?? 3) === n ? 'selected' : ''}>${n === 1 ? '1 (só a equilibrada)' : `${n} (equilibrada ± ${(n - 1) / 2})`}</option>`).join('')}</select>`)}
      </div>
      <p class="sub" id="rulesExample" style="margin:8px 0"></p>
      ${f('Notas sobre as regras (para a equipa)', `<textarea class="inp" name="notes" style="min-height:64px;font-family:inherit" maxlength="1000" placeholder="Ex.: regulamento do SIX Major; mapas escolhidos por veto">${esc(r.notes || '')}</textarea>`)}
    </div></div>`;
}
function rulesExample(N, ot, B) {
  if (!(N >= 1)) return '';
  if (ot === 'none') return `Ganha o mapa quem chegar primeiro a ${N}. Em ${N - 1}-${N - 1}, o round seguinte decide (no máximo ${2 * N - 1} rounds).`;
  if (ot === 'by2') return `Ganha quem chegar a ${N}. Em ${N - 1}-${N - 1} joga-se até alguém abrir 2 de vantagem (${N + 1}-${N - 1}, ${N + 2}-${N}, ...).`;
  const k = Math.floor(B / 2) + 1;
  return `Ganha quem chegar a ${N}. Em ${N - 1}-${N - 1} jogam-se blocos de ${B} rounds e ganha quem fizer ${k} no bloco (ex.: ${N - 1 + k}-${N - 1}, ${N - 1 + k}-${N - 1 + k - 1})${B % 2 === 0 ? `; bloco empatado ${B / 2}-${B / 2} → novo bloco` : ''}.`;
}
function updateRulesExample() {
  const f = $('#leagueForm'); if (!f) return;
  const x = f.elements, el = $('#rulesExample'); if (el) el.textContent = rulesExample(Number(x.target.value), x.ot.value, Number(x.otBlock.value));
}
const rulesSummary = (R) => `${R.target} ${R.unit} por ${R.mapName}${R.bestOf > 1 ? `, melhor de ${R.bestOf}` : ''}, prorrogação: ${R.ot === 'none' ? 'não' : R.ot === 'by2' ? '2 de vantagem' : `blocos de ${R.otBlock}`}, margem ${R.margin}%, odd mínima ${R.minOdd ?? 1.15}, ${R.lines ?? 3} linha(s)${R.endgame ? `, reta final a ${R.endgame} do fim` : ''}`;
function marketModal() {
  const ev = A.catData.event;
  const tpls = [
    ['Vencedor (1X2)', 'Vencedor', `${ev.home}; \nEmpate; \n${ev.away}; `],
    ['Vencedor (sem empate)', 'Vencedor', `${ev.home}; \n${ev.away}; `],
    ['Sim / Não', '', 'Sim; \nNão; '],
    ['Mais / Menos', 'Total — 2.5', 'Mais de 2.5; \nMenos de 2.5; '],
    ['Handicap', 'Handicap', `${ev.home} -1.5; \n${ev.away} +1.5; `],
  ];
  // com regras do jogo: modelos com odds automáticas (o tipo vai junto)
  if (A.catData.rules) {
    const U = A.catData.rules.unit, T = A.catData.rules.target;
    tpls.splice(0, tpls.length,
      ['⚡ Vencedor da partida', 'Vencedor', `${ev.home}; 1.85\n${ev.away}; 1.85`, 'match'],
      ['⚡ Total de ' + U, `Total de ${U}`, `Mais de ${T + 3}.5; 1.85\nMenos de ${T + 3}.5; 1.85`, 'map_total'],
      ['⚡ Handicap de ' + U, `Handicap de ${U}`, `${ev.home} -2.5; 1.85\n${ev.away} +2.5; 1.85`, 'map_handicap'],
      ['⚡ Vencedor do ' + A.catData.rules.mapName, `Vencedor do ${A.catData.rules.mapName} 1`, `${ev.home}; 1.85\n${ev.away}; 1.85`, 'map_winner'],
      ['Sim / Não (à mão)', '', 'Sim; \nNão; ', ''],
    );
  }
  openModal(`<h3>Novo mercado</h3><p class="sub">${esc(evName(ev))}</p>
    <form id="newMkForm"><label class="lbl">Nome do mercado *</label><input class="inp" name="name" id="mkName" required maxlength="80" placeholder="Ex.: Total de escanteios, Marca primeiro, Vencedor do set">
      <label class="lbl">Seleções e odds * (uma por linha: <b>Nome; odd</b>)</label>
      <div class="tpl">${tpls.map(([l, n, v, t], i) => `<button type="button" data-tpl="${i}" data-name="${esc(n)}" data-val="${esc(v)}" data-type="${t ?? ''}">${esc(l)}</button>`).join('')}</div>
      ${ev.manual ? `<label class="lbl">Odds</label><div style="display:flex;gap:8px;align-items:center" id="mkType">${typeSelect(null)}</div>${A.catData.rules ? '' : '<p class="sub">⚡ Odds automáticas: defina as regras do jogo no campeonato.</p>'}` : ''}
      <textarea class="inp" name="sels" id="mkSels" required placeholder="Flamengo; 1.85&#10;Empate; 3.40&#10;Palmeiras; 4.20"></textarea>
      <label class="lbl">Aposta máxima por aposta (R$, opcional)</label><input class="inp" name="maxStake" placeholder="sem limite">
      <label class="lbl">Apostas fecham em (opcional)</label><input class="inp" type="datetime-local" name="mclose">
      <label class="check"><input type="checkbox" name="open" checked> Abrir já para apostas (senão fica suspenso)</label>
      <div class="form-err" id="formErr"></div><button class="btn btn-green btn-block" type="submit">Criar mercado</button></form>`);
}
function parseSelLines(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line, i) => {
    const m = line.match(/^(.+?)\s*[;@\t|]\s*([\d.,]+)\s*$/);
    if (!m) throw new Error(`Linha ${i + 1} ("${line}"): falta a odd. Use "Nome; 1.85".`);
    return { name: m[1].trim(), odds: m[2].replace(',', '.') };
  });
}
function settleMkModal(id) {
  const m = A.catData.markets.find((x) => x.id === id);
  if (!m) return;
  const betsN = m.sels.reduce((s, x) => s + x.bets, 0);
  openModal(`<h3>Liquidar mercado</h3><p class="sub">${esc(evName(A.catData.event))} · <b>${esc(m.name)}</b><br>${betsN ? `${betsN} seleção(ões) em apostas abertas serão decididas agora.` : 'Sem apostas abertas neste mercado.'} Não pode ser desfeito (só corrigindo aposta a aposta).</p>
    <form id="settleMkForm" data-id="${esc(m.id)}">
      ${m.sels.map((s) => `<div class="kv2" style="align-items:center"><span style="color:var(--text)"><b>${esc(s.name)}</b> @${s.odds.toFixed(2)}<br><small class="muted">${s.bets ? `${s.bets} aposta(s) · a pagar se ganhar ${money(s.singles)}` : 'sem apostas'}</small></span>
        <select class="inp" style="width:140px" data-res="${esc(s.id)}">${['', 'won', 'lost', 'void'].map((v) => `<option value="${v}" ${s.suggest === v ? 'selected' : ''}>${v ? RES_PILL[v][1] : '—'}</option>`).join('')}</select></div>`).join('')}
      ${m.sels.some((s) => s.suggest) ? '<p class="sub">Resultados pré-preenchidos pelo placar. Confira antes de liquidar.</p>' : ''}
      <div class="acts" style="margin:10px 0"><button type="button" class="btn btn-ghost" data-allvoid="1">Anular mercado (tudo devolvido)</button></div>
      <label class="lbl">Observação (opcional, fica no registo)</label><input class="inp" name="note" maxlength="300" placeholder="Ex.: resultado oficial confirmado na súmula">
      <div class="form-err" id="formErr"></div><button class="btn btn-green btn-block" type="submit" style="margin-top:14px">Liquidar e pagar apostas</button></form>`);
}

/* ---------- cliques, mudanças e formulários desta aba ---------- */
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  const d = t.dataset;
  try {
    if (d.cattab) { A.catTab = d.cattab; return render(); }
    if (d.catev) return go('esporte-ev', { catEv: d.catev });
    if (d.action === 'newEvent') return newEventModal();
    if (d.action === 'newSport') return sportModal(null);
    if (d.action === 'newLeague') return leagueModal(null);
    if (d.action === 'newMarket') return marketModal();
    if (d.icon) { $('#sportIcon').value = d.icon; return; }
    if (d.tpl) {
      $('#mkSels').value = d.val; if (d.name && !$('#mkName').value) $('#mkName').value = d.name;
      const ts = document.querySelector('#mkType select[name=atype]'); if (ts && d.type !== undefined && A.catData.rules) ts.value = d.type;
      $('#mkSels').focus(); return;
    }
    if (d.bot) return StreamBot.open(A.catData);
    if (d.srvbot) {
      if (d.srvbot === 'stop' && !confirm('Desligar o bot desta partida?')) return;
      t.disabled = true;
      await api('POST', `/api/admin/bot/${d.srvbot}`, { id: A.catEv, autoSettle: $('#srvBotSettle')?.checked !== false, alive: $('#srvBotAlive')?.checked !== false });
      toast(d.srvbot === 'start' ? 'Bot ligado no servidor: a abrir a transmissão' : 'Bot desligado', 'ok');
      srvBotSeen = null; await render(); return srvBotTick();
    }
    if (d.srvside != null) { srvBotFill(await api('POST', '/api/admin/bot/sides', { id: A.catEv, swap: d.srvside === '1' })); return; }
    if (d.srvsync) {
      if (!confirm('O placar do site passa a ser o que o vídeo mostra. Continuar?')) return;
      await api('POST', '/api/admin/bot/sync', { id: A.catEv }); toast('Placar do site acertado pelo vídeo', 'ok'); return render();
    }
    if (d.aliveclear) { await api('POST', '/api/admin/catalog/event/alive', { id: A.catEv, h: null }); return render(); }
    if (d.round) {
      t.disabled = true;
      await api('POST', '/api/admin/catalog/event/round', { id: A.catEv, side: d.round });
      return render();
    }
    if (d.settleall) {
      if (!confirm('Liquidar todos os mercados que o placar já decidiu? As apostas são pagas a seguir.')) return;
      const r = await api('POST', '/api/admin/catalog/event/settle-all', { id: A.catEv });
      toast(`${r.settled} mercado(s) liquidado(s) pelo placar`, 'ok'); return render();
    }
    if (d.openmaps) {
      const f = $('#liveForm');
      const r = await api('POST', '/api/admin/catalog/event/live', { id: A.catEv, auto: true, bestOf: f.elements.bestOf.value });
      toast(r.made ? `${r.made} mercados abertos` : 'Os mercados padrão já estavam abertos', 'ok'); return render();
    }
    if (d.calib) {
      const f = $('#liveForm');
      await api('POST', '/api/admin/catalog/event/live', { id: A.catEv, auto: f.elements.auto.checked, bestOf: f.elements.bestOf.value, fromOdds: true });
      toast('Força calibrada pelas odds do Vencedor', 'ok'); return render();
    }
    if (d.sportedit) return sportModal(A.cat.sports.find((x) => x.key === d.sportedit));
    if (d.lgedit) return leagueModal(A.cat.leagues.find((x) => x.key === d.lgedit));
    if (d.sporthide) {
      const s = A.cat.sports.find((x) => x.key === d.sporthide);
      await api('POST', '/api/admin/catalog/sport', { key: s.key, name: s.name, icon: s.icon, hidden: !s.hidden });
      toast(s.hidden ? 'Modalidade visível no site' : 'Modalidade oculta do site', 'ok'); return render();
    }
    if (d.lghide) {
      const l = A.cat.leagues.find((x) => x.key === d.lghide);
      await api('POST', '/api/admin/catalog/league', { key: l.key, name: l.name, country: l.country, sport: l.sport, hidden: !l.hidden });
      toast(l.hidden ? 'Campeonato visível no site' : 'Campeonato oculto do site', 'ok'); return render();
    }
    if (d.sportdel) { if (!confirm('Apagar esta modalidade?')) return; await api('POST', '/api/admin/catalog/sport/delete', { key: d.sportdel }); toast('Modalidade apagada', 'ok'); return render(); }
    if (d.lgdel) { if (!confirm('Apagar este campeonato?')) return; await api('POST', '/api/admin/catalog/league/delete', { key: d.lgdel }); toast('Campeonato apagado', 'ok'); return render(); }
    if (d.archive) {
      await api('POST', '/api/admin/catalog/event/archive', { id: d.archive, archived: d.val === '1' });
      toast(d.val === '1' ? 'Evento arquivado (saiu do site)' : 'Evento de volta ao site', 'ok'); return render();
    }
    if (d.mkstatus) {
      const [id, status] = d.mkstatus.split('|');
      await api('POST', '/api/admin/catalog/market/status', { evId: A.catEv, id, status });
      toast(status === 'open' ? 'Aberto para apostas' : 'Suspenso', 'ok'); return render();
    }
    if (d.mksettle) return settleMkModal(d.mksettle);
    if (d.mkdel) { if (!confirm('Apagar este mercado?')) return; await api('POST', '/api/admin/catalog/market/delete', { evId: A.catEv, id: d.mkdel }); toast('Mercado apagado', 'ok'); return render(); }
    if (d.seladd) { t.closest('form').querySelector('tbody').insertAdjacentHTML('beforeend', selRow()); return; }
    if (d.selrm) { t.closest('tr').remove(); return; }
    if (d.allvoid) { document.querySelectorAll('select[data-res]').forEach((x) => { x.value = 'void'; }); return; }
  } catch (err) { toast(err.message, 'err'); render(); }
});

document.addEventListener('change', (e) => {
  // liquidar mercado: ao marcar uma vencedora, as que ainda não têm resultado passam a "Perdeu"
  if (e.target.matches('select[data-res]') && e.target.value === 'won') document.querySelectorAll('select[data-res]').forEach((x) => { if (!x.value) x.value = 'lost'; });
  if (e.target.id === 'catArchived') { A.catArchived = e.target.value === '1'; render(); }
  if (e.target.id === 'newEvLeague' || e.target.id === 'newEvGame') renderNewEvAuto();
  // opções do bot com ele ligado: aplica já
  if ((e.target.id === 'srvBotSettle' || e.target.id === 'srvBotAlive') && A.catData?.live?.bot?.on) {
    api('POST', '/api/admin/bot/start', { id: A.catEv, autoSettle: $('#srvBotSettle').checked, alive: $('#srvBotAlive').checked }).then(() => toast('Opções do bot guardadas', 'ok')).catch((x) => toast(x.message, 'err'));
  }
  if (e.target.id === 'newEvBestOf') $('#newEvMaps').innerHTML = mapsRows(Number(e.target.value), null, 'casa', 'fora');
  if (e.target.name === 'kind' && e.target.form?.id === 'newEvForm') {
    const out = e.target.value === 'outright';
    $('#evKindGame').disabled = out; $('#evKindGame').style.display = out ? 'none' : '';
    $('#evKindOut').disabled = !out; $('#evKindOut').style.display = out ? '' : 'none';
  }
  if (e.target.id === 'rulesOn') $('#rulesBody').style.display = e.target.checked ? '' : 'none';
  if (e.target.id === 'rulesPreset' && A.cat.presets[e.target.value]) {
    const P = A.cat.presets[e.target.value], f = e.target.form;
    for (const k of ['target', 'bestOf', 'ot', 'otBlock', 'margin', 'unit', 'mapName', 'minOdd', 'lines', 'endgame', 'half', 'pickEdge', 'sideEdge', 'aliveEdge']) f.elements[k].value = P[k];
  }
  if (e.target.form && e.target.form.id === 'leagueForm') updateRulesExample();
});

// formulários desta aba: tratados aqui (fase de captura), sem passar pelo tratamento geral do admin.js
const CAT_FORMS = new Set(['realSearch', 'sportForm', 'leagueForm', 'mapsForm', 'aliveForm', 'liveForm', 'newEvForm', 'evForm', 'newMkForm', 'settleMkForm']);
document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (!CAT_FORMS.has(f.id) && !f.classList.contains('mkForm')) return;
  e.preventDefault(); e.stopPropagation();
  const fd = Object.fromEntries(new FormData(f));
  const btn = f.querySelector('button[type=submit]');
  formErr(''); if (btn) btn.disabled = true;
  try {
    if (f.id === 'realSearch') { A.realQuery = fd.q; return render(); }
    if (f.id === 'sportForm') { await api('POST', '/api/admin/catalog/sport', { key: f.dataset.key || undefined, name: fd.name, icon: fd.icon, hidden: !!f.dataset.hidden }); closeModal(); toast('Modalidade guardada', 'ok'); }
    if (f.id === 'leagueForm') {
      const rules = fd.rulesOn ? { enabled: true, preset: fd.preset, target: fd.target, bestOf: fd.bestOf, ot: fd.ot, otBlock: fd.otBlock, margin: fd.margin, unit: fd.unit, mapName: fd.mapName, notes: fd.notes, minOdd: fd.minOdd, lines: fd.lines, endgame: fd.endgame, half: fd.half, pickEdge: fd.pickEdge, sideEdge: fd.sideEdge, aliveEdge: fd.aliveEdge } : { enabled: false };
      await api('POST', '/api/admin/catalog/league', { key: f.dataset.key || undefined, name: fd.name, country: fd.country, sport: fd.sport, hidden: !!f.dataset.hidden, rules });
      closeModal(); toast('Campeonato guardado', 'ok');
    }
    if (f.id === 'mapsForm') {
      const lv = A.catData.live;
      await api('POST', '/api/admin/catalog/event/live', { id: A.catEv, auto: lv.auto, bestOf: lv.bestOf, maps: mapsFrom(fd, lv.bestOf) });
      toast('Mapas guardados: odds recalculadas', 'ok');
    }
    if (f.id === 'aliveForm') {
      await api('POST', '/api/admin/catalog/event/alive', { id: A.catEv, h: fd.h, a: fd.a });
      toast(`Dentro do round: ${fd.h} v ${fd.a}`, 'ok');
    }
    if (f.id === 'liveForm') {
      const r = await api('POST', '/api/admin/catalog/event/live', { id: A.catEv, auto: !!fd.auto, bestOf: fd.bestOf, strength: fd.strength });
      toast(r.made ? `Odds automáticas guardadas · ${r.made} mercados abertos` : 'Odds automáticas guardadas', 'ok');
    }
    if (f.id === 'newEvForm') {
      const r = fd.kind === 'outright'
        ? await api('POST', '/api/admin/catalog/event', { league: fd.league, outright: true, home: fd.title, away: '', startsAt: new Date(fd.closesAt).getTime(), state: 'pre', market: { name: fd.mkName, sels: parseSelLines(fd.mkSels) } })
        : await api('POST', '/api/admin/catalog/event', { league: fd.league, home: fd.home, away: fd.away, startsAt: new Date(fd.startsAt).getTime(), state: 'pre', auto: !!fd.auto, oddsHome: fd.oddsHome, oddsAway: fd.oddsAway, bestOf: fd.bestOf, stream: fd.stream, game: fd.game || null, maps: mapsFrom(fd, fd.bestOf) });
      closeModal(); toast(fd.kind === 'outright' ? 'Evento de longo prazo criado' : r.made ? `Evento criado com ${r.made} mercados automáticos` : 'Evento criado. Agora adicione os mercados.', 'ok'); return go('esporte-ev', { catEv: r.id });
    }
    if (f.id === 'evForm') {
      await api('POST', '/api/admin/catalog/event', { id: f.dataset.id, league: fd.league, home: fd.home, away: fd.away, startsAt: new Date(fd.startsAt).getTime(), state: fd.state, scoreH: fd.scoreH, scoreA: fd.scoreA, mapsH: fd.mapsH, mapsA: fd.mapsA, clock: fd.clock, stream: fd.stream, game: fd.game || null });
      toast('Evento atualizado', 'ok');
    }
    if (f.id === 'newMkForm') {
      await api('POST', '/api/admin/catalog/market', { evId: A.catEv, name: fd.name, sels: parseSelLines(fd.sels), maxStake: fd.maxStake, open: !!fd.open, auto: fd.atype ? { type: fd.atype, map: fd.amap, lines: fd.amove ? 'move' : 'fixed' } : null, closesAt: fd.mclose ? new Date(fd.mclose).getTime() : null });
      closeModal(); toast('Mercado criado', 'ok');
    }
    if (f.classList.contains('mkForm')) {
      const sels = [...f.querySelectorAll('tr[data-sel]')].map((tr) => ({ id: tr.dataset.sel || undefined, name: tr.querySelector('[name=sname]').value, odds: tr.querySelector('[name=sodds]').value }));
      await api('POST', '/api/admin/catalog/market', { evId: A.catEv, id: f.dataset.mk, name: fd.name, maxStake: fd.maxStake, sels, auto: fd.atype ? { type: fd.atype, map: fd.amap, lines: fd.amove ? 'move' : 'fixed' } : null, closesAt: fd.mclose ? new Date(fd.mclose).getTime() : null });
      toast('Mercado guardado', 'ok');
    }
    if (f.id === 'settleMkForm') {
      const results = Object.fromEntries([...f.querySelectorAll('select[data-res]')].map((x) => [x.dataset.res, x.value]));
      if (Object.values(results).some((v) => !v)) { formErr('Escolha o resultado de todas as seleções.'); if (btn) btn.disabled = false; return; }
      await api('POST', '/api/admin/catalog/market/settle', { evId: A.catEv, id: f.dataset.id, results, note: fd.note });
      closeModal(); toast('Mercado liquidado. As apostas foram decididas.', 'ok');
    }
    render();
  } catch (err) {
    if (btn) btn.disabled = false;
    // os cartões de mercado não têm caixa de erro própria
    if (f.classList.contains('mkForm') || !$('#formErr')) toast(err.message, 'err'); else formErr(err.message);
  }
}, true);
