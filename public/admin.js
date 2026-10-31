'use strict';
/* Painel da equipa: pedidos de saque, depósitos, apostas, jogadores e registo de ações. */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (v) => (v == null ? '—' : BRL.format(v));
const dt = (t) => (t ? new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `há ${m} min` : m < 1440 ? `há ${Math.round(m / 60)} h` : `há ${Math.round(m / 1440)} d`; };
const parseMoney = (s) => { const n = parseFloat(String(s ?? '').replace(/\s|R\$/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const DEP_LABEL = { CREATING: 'a gerar', PENDING: 'à espera do PIX', PAID: 'pago', EXPIRED: 'expirado', FAILED: 'falhou', REFUNDED: 'estornado', CHARGEBACK: 'contestado', REVIEW: 'em revisão', DISMISSED: 'descartado', DUPLICATE: 'duplicado (não creditado)' };

// odds ao vivo: ligação por WebSocket à fonte e navegadores ligados em tempo real
function liveCard(l) {
  if (!l) return '';
  const w = l.ws || {};
  const bad = Object.entries(w.health || {}).filter(([k, v]) => ['soccer', 'basketball', 'tennis', 'ice_hockey', 'mma', 'table_tennis', 'esports'].includes(k) && (v.live !== 'ok' || v.pre !== 'ok'));
  const state = w.open ? `<b style="color:#22c55e">Tempo real ligado</b>` : `<b style="color:#f59e0b">Só pedidos normais</b>`;
  const lp = w.livePolls || {};
  return `<div class="card"><small>Odds ao vivo (WebSocket)</small>${state}<span>${w.withData || 0}/${w.subscribed || 0} jogos seguidos · ${w.kbPerSec || 0} KB/s · ${l.browsers} navegadores · ${l.live} ao vivo` +
    `${w.connects > 1 ? ` · ${w.connects - 1} religações` : ''}${lp.light || lp.heavy ? ` · pedidos leves ${Math.round((100 * (lp.light || 0)) / ((lp.light || 0) + (lp.heavy || 0)))}%` : ''}` +
    `${bad.length ? `<br><b style="color:#f59e0b">Fonte com problemas: ${esc(bad.map(([k, v]) => `${k} (${v.live}${v.reason ? `, ${v.reason}` : ''})`).join(', '))}</b>` : ''}</span></div>`;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}
async function api(method, url, body) {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await r.json(); } catch { /* vazio */ }
  if (!r.ok) { const e = new Error(data.error || 'Falha de comunicação com o servidor.'); e.status = r.status; throw e; }
  return data;
}
function openModal(html) {
  $('#modal').innerHTML = `<button class="close" data-action="close">×</button>` + html;
  $('#modal').classList.add('show'); $('#overlay').classList.add('show');
  const f = $('#modal input, #modal textarea'); if (f) setTimeout(() => f.focus(), 30);
}
function closeModal() { $('#modal').classList.remove('show'); $('#overlay').classList.remove('show'); }
const formErr = (msg) => { const el = $('#formErr'); if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; } };
const pill = (status, label) => `<span class="pill ${esc(status)}">${esc(label || status)}</span>`;

const A = { me: null, view: 'saques', wdFilter: 'OPEN', depFilter: 'ALL', betFilter: 'late', userQuery: '', userId: null, summary: null };

/* ---------- entrada ---------- */
async function boot() {
  try { A.me = (await api('GET', '/api/me')).user; } catch { A.me = null; }
  if (!A.me) return showLogin();
  // conta sem acesso: volta ao site sem revelar nada sobre o painel
  if (!A.me.isAdmin) return location.replace('/');
  if (!A.me.emailVerified) { $('#main').innerHTML = `<div class="center-box"><h3>Confirme o seu e-mail</h3><p class="sub">Para usar o painel, confirme primeiro o e-mail ${esc(A.me.email)} (no site: Minha conta → Perfil).</p><a class="btn btn-green btn-block" href="/">Ir ao site</a></div>`; return; }
  $('#who').innerHTML = `<span>${esc(A.me.email)}</span><b>${esc((A.me.name || A.me.email || '?').trim()[0].toUpperCase())}</b>`;
  renderTabs();
  go(location.hash.slice(1) || 'saques');
  setInterval(() => { if (A.view === 'saques' && !$('#modal').classList.contains('show')) render(); else loadSummary(); }, 20000);
}
function showLogin() {
  $('#tabs').innerHTML = '';
  $('#main').innerHTML = `<div class="center-box"><h3>Entrar no painel</h3>
    <form id="loginForm"><label class="lbl">E-mail</label><input class="inp" name="email" type="email" required autocomplete="email">
    <label class="lbl">Senha</label><input class="inp" name="password" type="password" required autocomplete="current-password">
    <div class="form-err" id="formErr"></div><button class="btn btn-green btn-block" type="submit" style="margin-top:14px">Entrar</button></form></div>`;
}

// menu lateral, por área: [área, [[vista, nome, ícone, contador]]]
function renderTabs() {
  const s = A.summary;
  const open = s ? s.withdrawals.pending + s.withdrawals.processing : 0;
  const groups = [
    ['Dinheiro', [['saques', 'Saques', '💸', open], ['depositos', 'Depósitos', '🏦', s ? s.deposits.review : 0]]],
    ['Apostas', [['apostas', 'Apostas', '🎟️', s && s.bets ? s.bets.late : 0], ['mercados', 'Mercados por liquidar', '⚖️', s && s.bets ? s.bets.pendingMarkets : 0], ['aovivo', 'Ao vivo suspeitas', '🚨', s ? s.liveAlerts24h || 0 : 0]]],
    ['Conteúdo', [['esportes', 'Esportes e mercados', '🏟️', 0]]],
    ['Pessoas', [['jogadores', 'Jogadores', '👥', 0]]],
    ['Sistema', [['registo', 'Registo', '📜', 0]]],
  ];
  const isOn = (k) => A.view === k || (k === 'jogadores' && A.view === 'jogador') || (k === 'esportes' && A.view === 'esporte-ev');
  $('#tabs').innerHTML = groups.map(([g, tabs]) => `<div class="adm-group"><span>${g}</span>${tabs.map(([k, l, ic, n]) => `<button class="${isOn(k) ? 'active' : ''}" data-go="${k}"><i>${ic}</i>${l}${n ? `<span class="cnt">${n}</span>` : ''}</button>`).join('')}</div>`).join('');
  const cur = groups.find(([, tabs]) => tabs.some(([k]) => isOn(k)));
  const tab = cur && cur[1].find(([k]) => isOn(k));
  $('#pageTitle').innerHTML = tab ? `${tab[2]} ${esc(tab[1])} <small>· ${esc(cur[0])}</small>` : 'Painel';
  document.title = (open ? `(${open}) ` : '') + 'Painel da equipa';
}
async function loadSummary() {
  try { A.summary = await api('GET', '/api/admin/summary'); renderTabs(); } catch (e) { if (e.status === 401) location.reload(); }
}
function go(view, extra = {}) {
  document.body.classList.remove('nav-open');
  Object.assign(A, { view }, extra);
  history.replaceState(null, '', '#' + view);
  render();
}
async function render() {
  await loadSummary();
  const m = $('#main');
  try {
    if (A.view === 'saques') m.innerHTML = await viewWithdrawals();
    else if (A.view === 'depositos') m.innerHTML = await viewDeposits();
    else if (A.view === 'apostas') m.innerHTML = await viewBets();
    else if (A.view === 'mercados') m.innerHTML = await viewPendingMarkets();
    else if (A.view === 'aovivo') m.innerHTML = await viewLiveAlerts();
    // aba "Esportes e mercados" (admin-catalog.js)
    else if (A.view === 'esportes') m.innerHTML = await viewCatalog();
    else if (A.view === 'esporte-ev') m.innerHTML = A.catEv ? await viewCatEvent() : await viewCatalog();
    else if (A.view === 'jogadores') m.innerHTML = await viewUsers();
    else if (A.view === 'jogador') m.innerHTML = await viewUser();
    else if (A.view === 'registo') m.innerHTML = await viewLogs();
    else return go('saques');
  } catch (e) { m.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  renderTabs();
}

/* ---------- saques ---------- */
function summaryCards() {
  const s = A.summary;
  if (!s) return '';
  return `<div class="cards">
    <div class="card"><small>Saques por tratar</small><b>${s.withdrawals.pending + s.withdrawals.processing}</b><span>${money(s.withdrawals.openTotal)} · ${s.withdrawals.processing} em processamento</span></div>
    <div class="card"><small>Saques pagos hoje</small><b>${money(s.withdrawals.paidTodayTotal)}</b><span>${s.withdrawals.paidToday} saques</span></div>
    <div class="card"><small>Depósitos hoje</small><b>${money(s.deposits.todayTotal)}</b><span>${s.deposits.today} PIX pagos · ${s.deposits.pendingPix} à espera</span></div>
    ${s.users ? `<div class="card"><small>Jogadores</small><b>${s.users.count}</b><span>Saldo total em contas: ${money(s.users.balances)}</span></div>` : ''}
  </div>${s.deposits.review ? `<div class="warn">${s.deposits.review} depósito(s) em revisão (valor pago diferente do pedido). <a href="#" data-go="depositos" data-depfilter="REVIEW" class="link">Ver</a></div>` : ''}`;
}
async function viewWithdrawals() {
  const { withdrawals } = await api('GET', '/api/admin/withdrawals?status=' + A.wdFilter);
  const opts = [['OPEN', 'Por tratar'], ['PAID', 'Pagos'], ['REJECTED', 'Recusados'], ['CANCELED', 'Cancelados'], ['ALL', 'Todos']];
  const rows = withdrawals.map((w) => {
    const mine = w.handledBy === A.me.email;
    let acts = '';
    if (w.status === 'PENDING') acts = `<button class="btn btn-green" data-wd-claim="${w.id}">Assumir</button><button class="btn btn-ghost" data-wd-reject="${w.id}">Recusar</button>`;
    if (w.status === 'PROCESSING') acts = `<button class="btn btn-green" data-wd-pay="${w.id}">Marcar como pago</button>${mine ? `<button class="btn btn-ghost" data-wd-release="${w.id}">Devolver à fila</button>` : ''}<button class="btn btn-ghost" data-wd-reject="${w.id}">Recusar</button>`;
    return `<tr>
      <td>${dt(w.createdAt)}<div class="sub">${ago(w.createdAt)}</div></td>
      <td><a href="#" class="link" data-user="${esc(w.userId)}">${esc(w.userName)}</a><div class="sub">${esc(w.userEmail)}</div></td>
      <td><span class="key">${esc(w.pixKey)}</span><button class="copy" data-copy="${esc(w.pixKeyRaw)}">copiar</button><div class="sub">chave CPF</div></td>
      <td class="num">${money(w.amount)}</td>
      <td>${pill(w.status, w.statusLabel)}${w.handledBy ? `<div class="sub">${esc(w.handledBy)}</div>` : ''}${w.proof ? `<div class="sub">E2E: ${esc(w.proof)}</div>` : ''}${w.note ? `<div class="sub">${esc(w.note)}</div>` : ''}</td>
      <td><div class="acts">${acts}</div></td></tr>`;
  }).join('');
  return `${summaryCards()}
    <div class="bar"><h2>Pedidos de saque</h2>
      <select id="wdFilter">${opts.map(([k, l]) => `<option value="${k}" ${A.wdFilter === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn btn-ghost" data-action="refresh">Atualizar</button></div>
    <div class="tbl-wrap">${withdrawals.length ? `<table><thead><tr><th>Pedido</th><th>Jogador</th><th>Enviar PIX para</th><th class="num">Valor</th><th>Estado</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Nenhum pedido aqui. 🎉</div>'}</div>
    <p class="note" style="text-align:left">Como funciona: <b>Assumir</b> avisa a equipa de que está a tratar → faça o PIX para a chave CPF indicada (só para o CPF do titular) → <b>Marcar como pago</b> com o ID da transação (E2E). <b>Recusar</b> devolve o valor ao saldo do jogador.</p>`;
}
async function findWd(id) {
  const { withdrawals } = await api('GET', '/api/admin/withdrawals?status=ALL');
  return withdrawals.find((w) => w.id === id) || (await api('GET', '/api/admin/withdrawals?status=OPEN')).withdrawals.find((w) => w.id === id);
}
async function payModal(id) {
  const w = await findWd(id);
  if (!w) return toast('Saque não encontrado', 'err');
  openModal(`<h3>Confirmar pagamento</h3><p class="sub">Só marque como pago <b>depois</b> de enviar o PIX.</p>
    <div class="kv2"><span>Jogador</span><b>${esc(w.userName)}</b></div>
    <div class="kv2"><span>Chave PIX (CPF)</span><b class="key">${esc(w.pixKey)} <button class="copy" data-copy="${esc(w.pixKeyRaw)}">copiar</button></b></div>
    <div class="kv2"><span>Valor a enviar</span><b>${money(w.amount)}</b></div>
    <form id="payForm" data-id="${esc(w.id)}">
      <label class="lbl">ID da transação PIX (E2E) ou referência do comprovante *</label><input class="inp" name="proof" required minlength="4" maxlength="120" placeholder="E12345678202610211234abcdef...">
      <label class="lbl">Observação (opcional)</label><input class="inp" name="note" maxlength="300">
      <label class="check" style="margin:14px 0"><input type="checkbox" name="ok" required> Confirmo que enviei ${money(w.amount)} para o CPF ${esc(w.pixKey)} (${esc(w.userName)}).</label>
      <div class="form-err" id="formErr"></div>
      <button class="btn btn-green btn-block" type="submit">Marcar como pago</button></form>`);
}
async function rejectModal(id) {
  const w = await findWd(id);
  if (!w) return toast('Saque não encontrado', 'err');
  openModal(`<h3>Recusar saque</h3><p class="sub">${money(w.amount)} de ${esc(w.userName)} volta para o saldo do jogador. O motivo aparece no extrato dele.</p>
    <form id="rejectForm" data-id="${esc(w.id)}">
      <label class="lbl">Motivo *</label><input class="inp" name="reason" required minlength="3" maxlength="300" placeholder="Ex.: dados bancários não conferem com o titular">
      <div class="form-err" id="formErr"></div>
      <button class="btn btn-red btn-block" type="submit" style="margin-top:14px">Recusar e devolver o valor</button></form>`);
}

/* ---------- depósitos ---------- */
async function viewDeposits() {
  const { deposits } = await api('GET', '/api/admin/deposits?status=' + A.depFilter);
  const opts = ['ALL', 'PAID', 'PENDING', 'REVIEW', 'EXPIRED', 'REFUNDED', 'CHARGEBACK', 'FAILED', 'DISMISSED', 'DUPLICATE'];
  const rows = deposits.map((d) => `<tr>
    <td>${dt(d.createdAt)}<div class="sub">${esc(d.id)}${d.bpId ? ' · BravoPay ' + esc(d.bpId) : ''}</div></td>
    <td><a href="#" class="link" data-user="${esc(d.userId)}">${esc(d.userName || d.userId)}</a><div class="sub">${esc(d.userEmail || '')}</div></td>
    <td class="num">${money(d.amount)}${d.fee != null ? `<div class="sub">taxa ${money(d.fee)}</div>` : ''}</td>
    <td>${pill(d.status, DEP_LABEL[d.status])}${d.paidAt ? `<div class="sub">pago ${dt(d.paidAt)}</div>` : ''}${d.reviewReason ? `<div class="sub">${esc(d.reviewReason)}</div>` : ''}${d.note ? `<div class="sub">${esc(d.note)}</div>` : ''}</td>
    <td>${d.status === 'REVIEW' ? `<div class="acts"><button class="btn btn-green" data-dep-credit="${d.id}" data-amt="${d.paidAmount ?? d.amount}">Creditar</button><button class="btn btn-ghost" data-dep-dismiss="${d.id}">Descartar</button></div>` : ''}</td></tr>`).join('');
  return `<div class="bar"><h2>Depósitos PIX</h2>
    <select id="depFilter">${opts.map((k) => `<option value="${k}" ${A.depFilter === k ? 'selected' : ''}>${k === 'ALL' ? 'Todos (últimos 300)' : DEP_LABEL[k]}</option>`).join('')}</select>
    <button class="btn btn-ghost" data-action="refresh">Atualizar</button></div>
    <div class="tbl-wrap">${deposits.length ? `<table><thead><tr><th>Data</th><th>Jogador</th><th class="num">Valor</th><th>Estado</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Nenhum depósito.</div>'}</div>`;
}

/* ---------- jogadores ---------- */
async function viewUsers() {
  const { users } = await api('GET', '/api/admin/users?q=' + encodeURIComponent(A.userQuery));
  const rows = users.map((u) => `<tr data-user="${esc(u.id)}" style="cursor:pointer">
    <td><b>${esc(u.name)}</b><div class="sub">${esc(u.email)}</div></td><td class="key">${esc(u.cpf || '—')}</td>
    <td class="num">${money(u.balance)}</td><td>${u.blocked ? pill('bad', 'bloqueado') : u.excludedUntil ? pill('PENDING', 'em pausa') : pill('ok', 'ativo')}${u.emailVerified ? '' : ' ' + pill('PENDING', 'e-mail por confirmar')}</td>
    <td>${dt(u.createdAt)}</td></tr>`).join('');
  return `<div class="bar"><h2>Jogadores</h2>
    <form id="userSearch" style="display:flex;gap:8px"><input name="q" value="${esc(A.userQuery)}" placeholder="E-mail, CPF, nome ou ID" style="min-width:260px"><button class="btn btn-green" type="submit">Procurar</button></form></div>
    <div class="tbl-wrap">${users.length ? `<table><thead><tr><th>Jogador</th><th>CPF</th><th class="num">Saldo</th><th>Estado</th><th>Registo</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Ninguém encontrado. Procure pelo e-mail exato, CPF ou início do nome.</div>'}</div>`;
}
async function viewUser() {
  const d = await api('GET', '/api/admin/user?id=' + encodeURIComponent(A.userId));
  const u = d.user;
  const kv = (k, v) => `<div class="kv2"><span>${k}</span><b>${v}</b></div>`;
  const table = (head, rows, empty) => `<div class="tbl-wrap">${rows.length ? `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>` : `<div class="empty">${empty}</div>`}</div>`;
  return `<div class="bar"><h2>${esc(u.name)}</h2><button class="btn btn-ghost" data-go="jogadores">← Jogadores</button></div>
    ${u.blocked ? `<div class="warn">Conta bloqueada: ${esc(u.blockedReason || '')}</div>` : ''}
    <div class="grid2">
      <div class="card">${kv('E-mail', esc(u.email) + (d.auth?.emailVerified ? ' ✓' : ' (por confirmar)'))}${kv('CPF', `<span class="key">${esc(u.cpf || '—')}</span>`)}${kv('Nascimento', esc(u.birthdate))}
        ${kv('Registo', dt(u.createdAt))}${kv('Último login', dt(u.lastLogin))}${kv('ID', `<span class="key" style="font-size:11px">${esc(u.id)}</span>`)}</div>
      <div class="card">${kv('Saldo', money(u.balance))}${kv('Total depositado', money(d.totals.deposited))}${kv('Total sacado', money(d.totals.withdrawn))}
        ${kv('Limites', `depósito/dia ${money(u.depositLimit)} · perda/dia ${money(u.lossLimitDay)} · perda/mês ${money(u.lossLimitMonth)}`)}
        ${kv('Pausa', u.excludedUntil ? 'até ' + dt(u.excludedUntil) : 'não')}
        <div class="acts" style="margin-top:12px"><button class="btn btn-ghost" data-adjust="${esc(u.id)}">Ajustar saldo</button>
        ${u.blocked ? `<button class="btn btn-green" data-block="${esc(u.id)}" data-val="0">Desbloquear</button>` : `<button class="btn btn-red" data-block="${esc(u.id)}" data-val="1">Bloquear conta</button>`}</div></div>
    </div>
    <div class="section"><h3>Saques</h3>${table(['Data', 'Valor', 'Estado', 'Detalhe'], d.withdrawals.map((w) => `<tr><td>${dt(w.createdAt)}</td><td class="num">${money(w.amount)}</td><td>${pill(w.status, w.statusLabel)}</td><td>${esc([w.handledBy, w.proof && 'E2E ' + w.proof, w.note].filter(Boolean).join(' · '))}</td></tr>`), 'Sem saques.')}</div>
    <div class="section"><h3>Depósitos</h3>${table(['Data', 'Valor', 'Estado'], d.deposits.map((x) => `<tr><td>${dt(x.createdAt)}</td><td class="num">${money(x.amount)}</td><td>${pill(x.status, DEP_LABEL[x.status])}</td></tr>`), 'Sem depósitos.')}</div>
    <div class="section"><h3>Apostas (últimas 50)</h3>${table(['Data', 'Seleções', 'Valor', 'Odd', 'Estado', 'Retorno', ''], d.bets.map((b) => `<tr><td>${dt(b.placedAt)}<div class="sub">${esc(b.id)}</div></td><td>${b.legs.map((l) => `<div class="sub" style="color:var(--text)">${esc(l)}</div>`).join('')}</td><td class="num">${money(b.stake)}</td><td>${b.odds.toFixed(2)}</td><td>${esc(BET_LABEL[b.status] || b.status)}</td><td class="num">${money(b.payout)}</td><td>${b.status === 'cashout' ? '' : `<button class="btn btn-ghost" style="padding:6px 10px;font-size:12px" data-settle="${esc(u.id)}|${esc(b.id)}|${esc(b.status)}">${b.status === 'open' ? 'Liquidar' : 'Corrigir'}</button>`}</td></tr>`), 'Sem apostas.')}</div>
    <div class="section"><h3>Extrato (últimos 100)</h3>${table(['Data', 'Movimento', 'Valor'], d.transactions.map((t) => `<tr><td>${dt(t.at)}</td><td>${esc(t.type)}${t.status ? ' ' + pill(t.status) : ''}${t.note ? `<div class="sub">${esc(t.note)}</div>` : ''}</td><td class="num" style="color:${t.amount >= 0 ? 'var(--green)' : 'var(--red)'}">${money(t.amount)}</td></tr>`), 'Sem movimentos.')}</div>`;
}

/* ---------- registo ---------- */
const LOG_KEYS = { amount: 'valor', credit: 'creditado', results: 'resultados', bets: 'apostas', user: 'jogador', proof: 'comprovante', note: 'nota', reason: 'motivo', event: 'evento', markets: 'mercados', market: 'mercado', state: 'estado', score: 'placar', name: 'nome', country: 'país', sport: 'esporte', hidden: 'oculto', result: 'resultado', status: 'estado' };
const LOG_VERB = { paid: 'pago', processing: 'em processamento', pending: 'devolvido à fila', rejected: 'recusado', canceled: 'cancelado', credit: 'creditado', dismiss: 'descartado', ajuste: 'ajuste de saldo' };
// "saque:paid" → "Saque · pago" (o código original fica no title)
const logLabel = (a) => { const [obj, verb = ''] = String(a).split(':'); return `${obj.charAt(0).toUpperCase() + obj.slice(1)}${verb ? ' · ' + (LOG_VERB[verb] || verb) : ''}`; };
const logKind = (a) => (/paid|pay|settle|liquid|abrir|open|create|criar/i.test(a) ? 'pay' : /reject|recus|suspend|arquivar|delete|apagar|ban|block/i.test(a) ? 'bad' : /edit|update|processing|corrig/i.test(a) ? 'edit' : '');
// detalhes de uma ação como "campo: valor" (valores de saque, depósito e ajuste de saldo vêm em centavos)
function logDetails(l) {
  const d = l.details || {};
  const cents = /^(saque|deposito|jogador):/.test(l.action);
  const val = (k, v) => ((k === 'amount' || k === 'credit') && cents && Number.isFinite(v) ? money(v / 100) : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'sim' : 'não') : v && typeof v === 'object' ? JSON.stringify(v) : String(v));
  const kv = Object.entries(d).filter(([k, v]) => v != null && v !== '' && !/At$/.test(k));
  return kv.length ? `<div class="kvs">${kv.map(([k, v]) => `<span><i>${esc(LOG_KEYS[k] || k)}</i>${esc(val(k, v))}</span>`).join('')}</div>` : '<span class="sub">—</span>';
}
async function viewLogs() {
  const { logs } = await api('GET', '/api/admin/logs');
  const rows = logs.map((l) => `<tr><td>${dt(l.at)}<div class="sub">${ago(l.at)}</div></td><td>${esc(l.admin)}</td><td><span class="log-act ${logKind(l.action)}" title="${esc(l.action)}">${esc(logLabel(l.action))}</span><div class="sub">${esc(l.target || '')}</div></td><td>${logDetails(l)}</td></tr>`).join('');
  return `<div class="bar"><h2>Registo de ações da equipa</h2></div>
    <div class="tbl-wrap">${logs.length ? `<table><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Detalhes</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Ainda sem ações.</div>'}</div>`;
}

/* ---------- apostas ao vivo suspeitas ---------- */
async function viewLiveAlerts() {
  const days = A.alertDays || 7;
  const { alerts, users, goalWindowS, dropPct } = await api('GET', `/api/admin/live-alerts?days=${days}`);
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
  const urows = users.map((u) => `<tr data-user="${esc(u.userId)}" style="cursor:pointer">
    <td><b>${esc(u.userName || u.userId)}</b><div class="sub">${esc(u.userEmail)}</div>${u.blocked ? pill('bad', 'bloqueado') : ''}</td>
    <td>${u.alerts}</td><td><b>${u.favorable}</b></td><td>${u.liveBets}</td>
    <td>${u.liveBets >= 10 && u.liveFavorable / u.liveBets >= 0.2 ? pill('bad', pct(u.liveFavorable, u.liveBets)) : pct(u.liveFavorable, u.liveBets)}</td>
    <td>${money(u.staked)}</td></tr>`).join('');
  const what = (l) => (l.goalAfterS != null ? `gol ${l.goalAfterS}s depois` : `odd caiu ${l.drop}% (${l.odds} → ${l.oddsAfter})`);
  const arows = alerts.map((a) => `<tr><td>${dt(a.placedAt)}</td>
    <td><a href="#" class="link" data-user="${esc(a.userId)}">${esc(a.userName || a.userId)}</a><div class="sub">${esc(a.userEmail)}</div></td>
    <td>${a.legs.map((l) => `<div><b>${esc(l.name)}</b> @${l.odds} · ${esc(l.marketName)}<div class="sub">${esc(l.event)}${l.scoreAt ? ` · ${esc(l.scoreAt)}` : ''}</div></div>`).join('')}</td>
    <td>${a.legs.map((l) => `<div>${esc(what(l))} ${l.favorable ? pill('bad', 'a favor') : pill('', 'contra')}</div>`).join('')}</td>
    <td>${money(a.stake)}<div class="sub">prêmio ${money(a.potential)}</div><div class="sub">${esc(a.betId)}</div></td></tr>`).join('');
  return `<div class="bar"><h2>Apostas ao vivo suspeitas</h2>
      <select id="alertDays">${[1, 7, 30, 90].map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>últimos ${d} dia${d > 1 ? 's' : ''}</option>`).join('')}</select></div>
    <p class="sub" style="margin:0 0 12px">Cada aposta ao vivo é revista 20 s e 45 s depois de aceite. Fica aqui se houve gol até ${goalWindowS} s depois ou se a odd caiu ${dropPct}% ou mais.
      "A favor" = o lance ajudou a aposta. Gols acontecem: uma ou outra é normal. O sinal de alerta é um jogador com muitas apostas ao vivo e uma percentagem alta "a favor" (marcado a vermelho a partir de 20% com 10+ apostas) —
      quer dizer que vê os lances antes da casa. Nesse caso: aumentar a espera dessa modalidade (LIVE_DELAY_… no .env) ou bloquear a conta na ficha do jogador.</p>
    <h3 style="margin:10px 0">Por jogador</h3>
    <div class="tbl-wrap">${users.length ? `<table><thead><tr><th>Jogador</th><th>Marcadas</th><th>A favor</th><th>Apostas ao vivo (total)</th><th>% a favor (total)</th><th>Apostado nas marcadas</th></tr></thead><tbody>${urows}</tbody></table>` : '<div class="empty">Nenhuma aposta ao vivo marcada neste período.</div>'}</div>
    ${alerts.length ? `<h3 style="margin:18px 0 10px">Apostas marcadas</h3><div class="tbl-wrap"><table><thead><tr><th>Aceite</th><th>Jogador</th><th>Seleção</th><th>O que aconteceu</th><th>Valor</th></tr></thead><tbody>${arows}</tbody></table></div>` : ''}`;
}

/* ---------- apostas ---------- */
const BET_LABEL = { open: 'em aberto', won: 'ganha', lost: 'perdida', void: 'devolvida', cashout: 'cash out' };
const RES_LABEL = { won: 'Ganhou', lost: 'Perdeu', void: 'Devolvida', halfwon: 'Meio ganho', halflost: 'Meia perda' };
// jogo sem resultado final na fonte (parou antes do fim, placar ilegível): a equipa confere e liquida à mão
const legVerify = (l) => {
  if (l.result) return '';
  const fs = `<a href="${esc(l.flashscore)}" target="_blank" rel="noopener" class="copy">ver no Flashscore</a>`;
  if (l.issue === 'unconfirmed') return `<div class="sub" style="margin-top:3px">${pill('bad', 'sem resultado final')}${l.note ? ' · ' + esc(l.note) : ''} ${fs}</div>`;
  return l.now && (l.now.state === 'post' || l.now.clock === 'Aguardando resultado') ? `<div class="sub">${fs}</div>` : '';
};
const legNow = (l) => legNowBase(l) + legVerify(l);
const legNowBase = (l) => {
  if (l.result) return pill(l.result === 'lost' || l.result === 'halflost' ? 'bad' : 'ok', (RES_LABEL[l.result] || l.result) + (l.final ? ' · ' + l.final : '') + (l.manual ? ' · equipa' : ''));
  if (!l.now) return pill('REVIEW', 'sem dados do jogo');
  if (l.now.state === 'in') return pill('PROCESSING', `ao vivo ${l.now.score || ''} · ${l.now.clock || ''}`);
  if (l.now.state === 'post') return pill('REVIEW', `terminado ${l.now.score || ''} · ${l.now.status || ''}`);
  return pill('', 'começa ' + dt(l.startsAt));
};
async function viewBets() {
  const { bets, summary } = await api('GET', '/api/admin/bets?filter=' + A.betFilter);
  const rows = bets.map((b) => `<tr>
    <td>${dt(b.placedAt)}<div class="sub">${esc(b.id)}</div>${b.late ? pill('REVIEW', 'atenção') : ''}</td>
    <td><a href="#" class="link" data-user="${esc(b.userId)}">${esc(b.userName)}</a><div class="sub">${esc(b.userEmail)}</div></td>
    <td>${b.legs.map((l) => `<div style="margin-bottom:6px"><b>${esc(l.event)}</b> <span class="sub">${esc(l.leagueName || '')}</span><div class="sub">${esc(l.marketName)}: ${esc(l.name)} @${l.odds.toFixed(2)}</div>${legNow(l)}</div>`).join('')}</td>
    <td class="num">${money(b.stake)}<div class="sub">odd ${b.odds.toFixed(2)}</div></td>
    <td class="num">${money(b.potential)}</td>
    <td><button class="btn btn-green" style="padding:6px 10px;font-size:12px" data-settle="${esc(b.userId)}|${esc(b.id)}|open">Liquidar</button></td></tr>`).join('');
  return `<div class="cards">
      <div class="card"><small>Apostas em aberto</small><b>${summary.open}</b><span>${money(summary.staked)} apostados</span></div>
      <div class="card"><small>Prêmio máximo em risco</small><b>${money(summary.exposure)}</b><span>se todas ganharem</span></div>
      <div class="card"><small>Precisam de atenção</small><b>${summary.late}</b><span>atrasadas ou placar não confirmado</span></div>
      <div class="card"><small>Fonte dos resultados</small><b>${esc(summary.feed || '—')}</b><span>cada placar é lido 2 vezes (5 min de intervalo) antes de pagar</span></div>
      ${liveCard(summary.live)}
    </div>
    <div class="bar"><h2>Apostas</h2>
      <select id="betFilter"><option value="late" ${A.betFilter === 'late' ? 'selected' : ''}>Precisam de atenção</option><option value="open" ${A.betFilter === 'open' ? 'selected' : ''}>Todas em aberto</option></select>
      <button class="btn btn-ghost" data-action="refresh">Atualizar</button></div>
    <div class="tbl-wrap">${bets.length ? `<table><thead><tr><th>Feita em</th><th>Jogador</th><th>Seleções e estado do jogo</th><th class="num">Valor</th><th class="num">Prêmio</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">${A.betFilter === 'late' ? 'Nenhuma aposta precisa de atenção. A liquidação automática está em dia.' : 'Nenhuma aposta em aberto.'}</div>`}</div>
    <p class="note" style="text-align:left">As apostas são liquidadas sozinhas quando o jogo termina. Use <b>Liquidar</b> só quando o feed falhar (jogo sem resultado) e <b>Corrigir</b> (no perfil do jogador) quando o resultado automático estiver errado. Tudo fica no Registo.</p>`;
}
/* ---------- mercados por liquidar ----------
   Mercados que o site não decide sozinho (escanteios, cartões, jogadores...) e os automáticos que a fonte não
   deixou decidir. A equipa confere o resultado (ex.: no Flashscore) e marca cada seleção: vale para todas as apostas. */
async function viewPendingMarkets() {
  const { groups } = await api('GET', '/api/admin/markets/pending');
  A.pending = groups;
  const done = groups.filter((g) => g.state === 'post'), later = groups.filter((g) => g.state !== 'post');
  const card = (g, i) => `<div class="card" style="margin-bottom:12px">
    <form class="pmForm" data-i="${i}">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:baseline"><b>${esc(g.event)}</b><span class="sub">${esc(g.leagueName || '')} · ${dt(g.startsAt)}</span>
        ${g.state === 'post' ? pill('ok', 'terminado' + (g.result ? ' · ' + g.result : '')) : g.state === 'in' ? pill('PROCESSING', 'ao vivo') : pill('', 'por começar')}
        ${g.auto ? pill('REVIEW', 'automático sem decisão') : ''}</div>
      <div style="margin:6px 0 8px"><b>${esc(g.marketName)}</b>${g.note ? `<div class="sub">${esc(g.note)}</div>` : ''}
        <a href="https://www.google.com/search?q=${encodeURIComponent('flashscore ' + g.event.replace(' x ', ' '))}" target="_blank" rel="noopener" class="copy">ver no Flashscore</a></div>
      <table><thead><tr><th>Seleção</th><th class="num">Odd</th><th class="num">Apostas</th><th class="num">Apostado</th><th class="num">Prêmio se ganhar</th><th>Resultado</th></tr></thead><tbody>
      ${g.picks.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.odds.toFixed(2)}</td><td class="num">${p.bets}</td><td class="num">${money(p.stake)}</td><td class="num">${money(p.potential)}</td>
        <td><select class="inp" style="width:130px" data-pick="${esc(p.pick)}"><option value="">—</option><option value="won">Ganhou</option><option value="lost">Perdeu</option><option value="void">Devolvida</option></select></td></tr>`).join('')}
      </tbody></table>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><input class="inp" name="reason" placeholder="Fonte / motivo (ex.: Flashscore: 11 escanteios)" style="flex:1;min-width:220px" required minlength="3">
        <button class="btn btn-green" type="submit">Liquidar mercado</button></div>
    </form></div>`;
  return `<div class="bar"><h2>Mercados por liquidar</h2><button class="btn btn-ghost" data-action="refresh">Atualizar</button></div>
    <p class="note" style="text-align:left">Mercados sem resultado automático. Confira o resultado numa fonte (Flashscore, site da liga) e marque cada seleção.
      As apostas com todas as seleções decididas são pagas na hora. Tudo fica no Registo. Seleções só aparecem aqui se alguém apostou nelas.</p>
    ${done.length ? `<div class="section"><h3>Jogos terminados (${done.length})</h3>${done.map((g) => card(g, groups.indexOf(g))).join('')}</div>` : ''}
    ${later.length ? `<div class="section"><h3>Ainda a decorrer ou por começar (${later.length})</h3>${later.map((g) => card(g, groups.indexOf(g))).join('')}</div>` : ''}
    ${groups.length ? '' : '<div class="tbl-wrap"><div class="empty">Nenhum mercado por liquidar.</div></div>'}`;
}

let settleCtx = null;
async function settleModal(uid, id, expect) {
  const { bet } = await api('GET', `/api/admin/bet?userId=${encodeURIComponent(uid)}&id=${encodeURIComponent(id)}`);
  settleCtx = bet;
  const opt = (v, cur) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${RES_LABEL[v]}</option>`;
  const correcting = bet.status !== 'open';
  openModal(`<h3>${correcting ? 'Corrigir resultado' : 'Liquidar aposta'}</h3>
    <p class="sub">${esc(bet.userName)} · ${esc(bet.id)} · ${money(bet.stake)} @ ${bet.odds.toFixed(2)}${correcting ? ` · hoje: <b>${esc(bet.statusLabel)}</b>, retorno ${money(bet.payout)}` : ''}</p>
    <form id="settleForm" data-uid="${esc(uid)}" data-id="${esc(bet.id)}" data-expect="${esc(expect || bet.status)}">
      ${bet.legs.map((l, i) => `<div class="kv2" style="align-items:center"><span style="color:var(--text)"><b>${esc(l.event)}</b><br><small class="muted">${esc(l.marketName)}: ${esc(l.name)} @${l.odds.toFixed(2)}${l.now && l.now.score ? ' · placar ' + esc(l.now.score) : ''}${l.final ? ' · final ' + esc(l.final) : ''}</small></span>
        <select class="inp" style="width:140px" data-leg="${i}"><option value="">—</option>${opt('won', l.result)}${opt('lost', l.result)}${opt('void', l.result)}</select></div>`).join('')}
      <div class="kv2"><span>Novo retorno ao jogador</span><b id="settlePreview">—</b></div>
      <label class="lbl">Motivo * (fica no registo${correcting ? ' e no extrato do jogador' : ''})</label><input class="inp" name="reason" required minlength="5" placeholder="Ex.: resultado oficial 2x1 confirmado no site da CBF">
      <div class="form-err" id="formErr"></div>
      <button class="btn btn-green btn-block" type="submit" style="margin-top:14px">${correcting ? 'Corrigir e ajustar saldo' : 'Liquidar'}</button></form>`);
  updateSettlePreview();
}
function updateSettlePreview() {
  const el = $('#settlePreview'); if (!el || !settleCtx) return;
  const vals = [...document.querySelectorAll('select[data-leg]')].map((x) => x.value);
  if (vals.some((v) => !v)) { el.textContent = 'escolha todas as seleções'; return; }
  const f = vals.reduce((p, v, i) => p * (v === 'won' ? settleCtx.legs[i].odds : v === 'void' ? 1 : 0), 1);
  const payout = Math.round(settleCtx.stake * f * 100) / 100;
  const diff = settleCtx.status === 'open' ? payout : payout - (settleCtx.payout || 0);
  el.innerHTML = `${money(payout)} <span class="sub">(saldo do jogador ${diff >= 0 ? '+' : ''}${money(diff)})</span>`;
}

/* ---------- eventos ---------- */
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a, tr[data-user]');
  if (!t) return;
  const d = t.dataset;
  if (t.tagName === 'A' && (d.go || d.user)) e.preventDefault();
  try {
    if (d.action === 'close') return closeModal();
    if (d.action === 'nav-open') return document.body.classList.add('nav-open');
    if (d.action === 'nav-close') return document.body.classList.remove('nav-open');
    if (d.action === 'refresh') return render();
    if (d.copy) { await navigator.clipboard.writeText(d.copy).catch(() => {}); t.textContent = 'copiado!'; setTimeout(() => { t.textContent = 'copiar'; }, 1500); return; }
    if (d.go) { if (d.depfilter) A.depFilter = d.depfilter; return go(d.go); }
    if (d.user) return go('jogador', { userId: d.user });
    if (d.wdClaim) { await api('POST', '/api/admin/withdrawals/claim', { id: d.wdClaim }); toast('Saque assumido. Faça o PIX e marque como pago.', 'ok'); return render(); }
    if (d.wdRelease) { await api('POST', '/api/admin/withdrawals/release', { id: d.wdRelease }); toast('Saque devolvido à fila'); return render(); }
    if (d.settle) { const [uid, id, expect] = d.settle.split('|'); return settleModal(uid, id, expect); }
    if (d.wdPay) return payModal(d.wdPay);
    if (d.wdReject) return rejectModal(d.wdReject);
    if (d.depCredit) {
      openModal(`<h3>Creditar depósito em revisão</h3><p class="sub">Confira no painel da BravoPay quanto foi realmente pago.</p>
        <form id="depForm" data-id="${esc(d.depCredit)}" data-act="credit"><label class="lbl">Valor a creditar (R$)</label><input class="inp" name="amount" value="${String(d.amt).replace('.', ',')}" required>
        <label class="lbl">Motivo *</label><input class="inp" name="reason" required minlength="3"><div class="form-err" id="formErr"></div>
        <button class="btn btn-green btn-block" type="submit" style="margin-top:14px">Creditar no saldo</button></form>`);
      return;
    }
    if (d.depDismiss) {
      openModal(`<h3>Descartar depósito</h3><p class="sub">Nada é creditado ao jogador.</p><form id="depForm" data-id="${esc(d.depDismiss)}" data-act="dismiss">
        <label class="lbl">Motivo *</label><input class="inp" name="reason" required minlength="3"><div class="form-err" id="formErr"></div>
        <button class="btn btn-red btn-block" type="submit" style="margin-top:14px">Descartar</button></form>`);
      return;
    }
    if (d.adjust) {
      openModal(`<h3>Ajustar saldo</h3><p class="sub">Use valor negativo para retirar (ex.: -50). Fica no extrato do jogador e no registo da equipa.</p>
        <form id="adjForm" data-id="${esc(d.adjust)}"><label class="lbl">Valor (R$)</label><input class="inp" name="amount" required placeholder="50,00 ou -50,00">
        <label class="lbl">Motivo *</label><input class="inp" name="reason" required minlength="5"><div class="form-err" id="formErr"></div>
        <button class="btn btn-green btn-block" type="submit" style="margin-top:14px">Aplicar ajuste</button></form>`);
      return;
    }
    if (d.block) {
      const on = d.val === '1';
      openModal(`<h3>${on ? 'Bloquear conta' : 'Desbloquear conta'}</h3><p class="sub">${on ? 'O jogador deixa de conseguir entrar e todas as sessões terminam. O saldo e os saques pendentes não mudam.' : 'O jogador volta a conseguir entrar.'}</p>
        <form id="blockForm" data-id="${esc(d.block)}" data-val="${d.val}"><label class="lbl">Motivo *</label><input class="inp" name="reason" required minlength="3"><div class="form-err" id="formErr"></div>
        <button class="btn ${on ? 'btn-red' : 'btn-green'} btn-block" type="submit" style="margin-top:14px">${on ? 'Bloquear' : 'Desbloquear'}</button></form>`);
    }
  } catch (err) { toast(err.message, 'err'); render(); }
});
$('#overlay').onclick = closeModal;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
document.addEventListener('change', (e) => {
  if (e.target.matches('select[data-leg]')) return updateSettlePreview();
  if (e.target.id === 'betFilter') { A.betFilter = e.target.value; render(); }
  if (e.target.id === 'wdFilter') { A.wdFilter = e.target.value; render(); }
  if (e.target.id === 'depFilter') { A.depFilter = e.target.value; render(); }
  if (e.target.id === 'alertDays') { A.alertDays = Number(e.target.value); render(); }
});
document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, fd = Object.fromEntries(new FormData(f));
  const btn = f.querySelector('button[type=submit]');
  formErr(''); if (btn) btn.disabled = true;
  try {
    if (f.id === 'loginForm') { await api('POST', '/api/login', fd); return boot(); }
    if (f.id === 'userSearch') { A.userQuery = fd.q.trim(); return render(); }
    if (f.id === 'payForm') { await api('POST', '/api/admin/withdrawals/pay', { id: f.dataset.id, proof: fd.proof, note: fd.note }); closeModal(); toast('Saque marcado como pago ✓', 'ok'); }
    if (f.id === 'rejectForm') { await api('POST', '/api/admin/withdrawals/reject', { id: f.dataset.id, reason: fd.reason }); closeModal(); toast('Saque recusado; valor devolvido ao jogador', 'ok'); }
    if (f.id === 'depForm') { await api('POST', '/api/admin/deposits/resolve', { id: f.dataset.id, action: f.dataset.act, amount: parseMoney(fd.amount), reason: fd.reason }); closeModal(); toast('Feito', 'ok'); }
    if (f.id === 'settleForm') {
      const results = [...f.querySelectorAll('select[data-leg]')].map((x) => x.value);
      if (results.some((r) => !r)) { formErr('Escolha o resultado de todas as seleções.'); if (btn) btn.disabled = false; return; }
      const r = await api('POST', '/api/admin/bets/settle', { userId: f.dataset.uid, id: f.dataset.id, expect: f.dataset.expect, results, reason: fd.reason });
      closeModal(); toast(`Aposta ${BET_LABEL[r.status]} · retorno ${money(r.payout)} · saldo do jogador ${r.diff >= 0 ? '+' : ''}${money(r.diff)}`, 'ok');
    }
    if (f.classList.contains('pmForm')) {
      const g = A.pending[Number(f.dataset.i)];
      const results = Object.fromEntries([...f.querySelectorAll('select[data-pick]')].filter((x) => x.value).map((x) => [x.dataset.pick, x.value]));
      if (!Object.keys(results).length) { toast('Escolha o resultado de pelo menos uma seleção', 'err'); if (btn) btn.disabled = false; return; }
      if (!confirm(`Liquidar "${g.marketName}" (${g.event})? As apostas são pagas a seguir.`)) { if (btn) btn.disabled = false; return; }
      const r = await api('POST', '/api/admin/markets/settle', { key: g.key, results, reason: fd.reason });
      toast(`Mercado liquidado · ${r.bets} aposta(s) atualizadas`, 'ok');
    }
    if (f.id === 'adjForm') { await api('POST', '/api/admin/user/adjust', { id: f.dataset.id, amount: parseMoney(fd.amount), reason: fd.reason }); closeModal(); toast('Saldo ajustado', 'ok'); }
    if (f.id === 'blockForm') { await api('POST', '/api/admin/user/block', { id: f.dataset.id, blocked: f.dataset.val === '1', reason: fd.reason }); closeModal(); toast('Feito', 'ok'); }
    render();
  } catch (err) {
    if (btn) btn.disabled = false;
    if (!$('#formErr')) toast(err.message, 'err'); else formErr(err.message);
  }
});

boot();
