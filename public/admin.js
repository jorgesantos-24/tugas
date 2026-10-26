'use strict';
/* Painel da equipa: pedidos de saque, depósitos, apostas, esportes e mercados, jogadores e registo de ações. */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (v) => (v == null ? '—' : BRL.format(v));
const dt = (t) => (t ? new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `há ${m} min` : m < 1440 ? `há ${Math.round(m / 60)} h` : `há ${Math.round(m / 1440)} d`; };
const parseMoney = (s) => { const n = parseFloat(String(s ?? '').replace(/\s|R\$/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const DEP_LABEL = { CREATING: 'a gerar', PENDING: 'à espera do PIX', PAID: 'pago', EXPIRED: 'expirado', FAILED: 'falhou', REFUNDED: 'estornado', CHARGEBACK: 'contestado', REVIEW: 'em revisão', DISMISSED: 'descartado', DUPLICATE: 'duplicado (não creditado)' };

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

const A = { me: null, view: 'saques', wdFilter: 'OPEN', depFilter: 'ALL', betFilter: 'late', userQuery: '', userId: null, summary: null,
  catTab: 'eventos', catArchived: false, catEv: null, cat: null, catData: null, realQuery: '' };

/* ---------- entrada ---------- */
async function boot() {
  try { A.me = (await api('GET', '/api/me')).user; } catch { A.me = null; }
  if (!A.me) return showLogin();
  if (!A.me.isAdmin) { $('#main').innerHTML = `<div class="center-box"><h3>Sem acesso</h3><p class="sub">A conta ${esc(A.me.email)} não faz parte da equipa. Peça para incluírem o seu e-mail em <b>ADMIN_EMAILS</b> no ficheiro .env do servidor.</p><a class="btn btn-ghost btn-block" href="/">Voltar ao site</a></div>`; return; }
  if (!A.me.emailVerified) { $('#main').innerHTML = `<div class="center-box"><h3>Confirme o seu e-mail</h3><p class="sub">Para usar o painel, confirme primeiro o e-mail ${esc(A.me.email)} (no site: Minha conta → Perfil).</p><a class="btn btn-green btn-block" href="/">Ir ao site</a></div>`; return; }
  $('#who').textContent = A.me.email;
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

function renderTabs() {
  const s = A.summary;
  const open = s ? s.withdrawals.pending + s.withdrawals.processing : 0;
  const tabs = [['saques', 'Saques', open], ['depositos', 'Depósitos', s ? s.deposits.review : 0], ['apostas', 'Apostas', s && s.bets ? s.bets.late : 0], ['mercados', 'Esportes e mercados', 0], ['jogadores', 'Jogadores', 0], ['registo', 'Registo', 0]];
  $('#tabs').innerHTML = tabs.map(([k, l, n]) => `<button class="${A.view === k || (k === 'jogadores' && A.view === 'jogador') || (k === 'mercados' && A.view === 'mercado-ev') ? 'active' : ''}" data-go="${k}">${l}${n ? `<span class="cnt">${n}</span>` : ''}</button>`).join('');
  document.title = (open ? `(${open}) ` : '') + 'Painel da equipa';
}
async function loadSummary() {
  try { A.summary = await api('GET', '/api/admin/summary'); renderTabs(); } catch (e) { if (e.status === 401) location.reload(); }
}
function go(view, extra = {}) {
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
    else if (A.view === 'mercados') m.innerHTML = await viewCatalog();
    else if (A.view === 'mercado-ev') m.innerHTML = A.catEv ? await viewCatEvent() : await viewCatalog();
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
async function viewLogs() {
  const { logs } = await api('GET', '/api/admin/logs');
  const rows = logs.map((l) => `<tr><td>${dt(l.at)}</td><td>${esc(l.admin)}</td><td><b>${esc(l.action)}</b><div class="sub">${esc(l.target || '')}</div></td><td class="sub">${esc(JSON.stringify(l.details || {}))}</td></tr>`).join('');
  return `<div class="bar"><h2>Registo de ações da equipa</h2></div>
    <div class="tbl-wrap">${logs.length ? `<table><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Detalhes</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Ainda sem ações.</div>'}</div>`;
}

/* ---------- apostas ---------- */
const BET_LABEL = { open: 'em aberto', won: 'ganha', lost: 'perdida', void: 'devolvida', cashout: 'cash out' };
const RES_LABEL = { won: 'Ganhou', lost: 'Perdeu', void: 'Devolvida', halfwon: 'Meio ganho', halflost: 'Meia perda' };
const VERIFY_LABEL = { ok: 'confirmado pela API-Football', pending: 'à espera da confirmação', mismatch: 'PLACAR DIVERGENTE', notfound: 'não encontrado na API-Football' };
const legVerify = (l) => {
  const fs = `<a href="${esc(l.flashscore)}" target="_blank" rel="noopener" class="copy">ver no Flashscore</a>`;
  const v = l.verify;
  if (!v) return l.now && l.now.state === 'post' && !l.result ? `<div class="sub">${fs}</div>` : '';
  const cls = v.state === 'ok' ? 'ok' : v.state === 'pending' ? '' : 'bad';
  const det = v.state === 'mismatch' ? ` · ESPN ${esc(v.espn)} × API ${esc(v.other)} (${esc(v.status)})` : v.error ? ` · ${esc(v.error)}` : '';
  return `<div class="sub" style="margin-top:3px">${pill(cls, VERIFY_LABEL[v.state] || v.state)}${det} ${fs}</div>`;
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
      <div class="card"><small>Confirmação de resultados</small><b>${summary.verifyOn ? 'ESPN + API-Football' : 'Só ESPN'}</b><span>${summary.verifyOn ? (summary.quota.error ? 'erro: ' + esc(summary.quota.error) : summary.quota.remaining != null ? summary.quota.remaining + ' de ' + summary.quota.limit + ' pedidos restantes hoje' : 'ainda sem pedidos hoje') : 'defina APIFOOTBALL_KEY no .env'}</span></div>
    </div>
    <div class="bar"><h2>Apostas</h2>
      <select id="betFilter"><option value="late" ${A.betFilter === 'late' ? 'selected' : ''}>Precisam de atenção</option><option value="open" ${A.betFilter === 'open' ? 'selected' : ''}>Todas em aberto</option></select>
      <button class="btn btn-ghost" data-action="refresh">Atualizar</button></div>
    <div class="tbl-wrap">${bets.length ? `<table><thead><tr><th>Feita em</th><th>Jogador</th><th>Seleções e estado do jogo</th><th class="num">Valor</th><th class="num">Prêmio</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">${A.betFilter === 'late' ? 'Nenhuma aposta precisa de atenção. A liquidação automática está em dia.' : 'Nenhuma aposta em aberto.'}</div>`}</div>
    <p class="note" style="text-align:left">As apostas são liquidadas sozinhas quando o jogo termina. Use <b>Liquidar</b> só quando o feed falhar (jogo sem resultado) e <b>Corrigir</b> (no perfil do jogador) quando o resultado automático estiver errado. Tudo fica no Registo.</p>`;
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

/* ---------- esportes e mercados ---------- */
const EV_STATE = { pre: ['PENDING', 'por começar'], in: ['PROCESSING', 'ao vivo'], post: ['', 'encerrado'] };
const MK_STATE = { open: ['ok', 'aberto'], suspended: ['REVIEW', 'suspenso'], settled: ['', 'liquidado'] };
const RES_PILL = { won: ['ok', 'Ganhou'], lost: ['bad', 'Perdeu'], void: ['', 'Devolvida'] };
const SPORT_ICONS = ['🎾', '🏐', '🥊', '🥋', '🏎️', '🎮', '🏓', '🏉', '🤾', '⛳', '🏇', '🎯', '🏸', '🚴', '🏊', '🎱'];
const fmtOddIn = (o) => String(o.toFixed(2));
const localInput = (t) => { const d = new Date(t); return new Date(t - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const evState = (ev) => pill(EV_STATE[ev.state][0], EV_STATE[ev.state][1] + (ev.score ? ` ${ev.score.h}-${ev.score.a}` : '') + (ev.state === 'in' && ev.clock ? ' · ' + ev.clock : ''));
const evName = (ev) => `${ev.home}${ev.away ? ' x ' + ev.away : ''}`;
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
    <td>${dt(ev.startsAt)}</td><td>${esc(ev.leagueName)}</td><td><b>${esc(evName(ev))}</b></td><td>${evState(ev)}</td>
    <td>${ev.markets ? `${ev.open} abertos de ${ev.markets}` : '<span class="sub">nenhum</span>'}${ev.toSettle && ev.state === 'post' ? `<div class="sub" style="color:var(--yellow)">${ev.toSettle} por liquidar</div>` : ''}</td>
    <td class="num">${ev.bets || ''}</td>
    <td><button class="btn btn-green" style="padding:6px 10px;font-size:12px" data-catev="${esc(ev.id)}">Gerir mercados</button></td></tr>`).join('');
  return `<div class="bar"><h2 style="font-size:15px">Eventos criados pela equipa</h2>
      <select id="catArchived"><option value="0" ${A.catArchived ? '' : 'selected'}>Ativos</option><option value="1" ${A.catArchived ? 'selected' : ''}>Arquivados</option></select>
      <button class="btn btn-green" data-action="newEvent">+ Novo evento</button></div>
    <div class="tbl-wrap">${list.length ? `<table><thead><tr><th>Início</th><th>Campeonato</th><th>Evento</th><th>Estado</th><th>Mercados</th><th class="num">Apostas abertas</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">${A.catArchived ? 'Nenhum evento arquivado.' : 'Ainda não há eventos. Crie um com "+ Novo evento" (pode ser num campeonato da ESPN ou num criado por si em "Modalidades e campeonatos").'}</div>`}</div>
    <p class="note" style="text-align:left">Num evento da equipa, todos os mercados e odds são definidos por si. O placar e o estado (por começar / ao vivo / encerrado) também são atualizados à mão. As apostas são pagas quando <b>liquidar</b> cada mercado.</p>`;
}

function viewLeagues(cat) {
  const vis = (x) => (x.hidden ? pill('REVIEW', 'oculto') : pill('ok', 'no site'));
  const sportRows = cat.sports.map((s) => `<tr><td style="font-size:18px">${esc(s.icon)}</td><td><b>${esc(s.name)}</b></td><td>${s.builtin ? '<span class="sub">automática (ESPN)</span>' : 'equipa'}</td><td class="num">${s.leagues}</td>
    <td>${s.builtin ? '' : vis(s)}</td>
    <td>${s.builtin ? '' : `<div class="acts"><button class="btn btn-ghost" data-sportedit="${esc(s.key)}">Editar</button><button class="btn btn-ghost" data-sporthide="${esc(s.key)}">${s.hidden ? 'Mostrar' : 'Ocultar'}</button><button class="btn btn-ghost" data-sportdel="${esc(s.key)}">Apagar</button></div>`}</td></tr>`).join('');
  const mine = cat.leagues.filter((l) => !l.builtin), auto = cat.leagues.filter((l) => l.builtin);
  const lgRows = mine.map((l) => `<tr><td>${esc(l.sportName)}</td><td><b>${esc(l.name)}</b></td><td>${esc(l.country || '—')}</td><td class="num">${l.events}</td><td>${vis(l)}</td>
    <td><div class="acts"><button class="btn btn-ghost" data-lgedit="${esc(l.key)}">Editar</button><button class="btn btn-ghost" data-lghide="${esc(l.key)}">${l.hidden ? 'Mostrar' : 'Ocultar'}</button><button class="btn btn-ghost" data-lgdel="${esc(l.key)}">Apagar</button></div></td></tr>`).join('');
  return `<div class="bar"><h2 style="font-size:15px">Modalidades</h2><button class="btn btn-green" data-action="newSport">+ Nova modalidade</button></div>
    <div class="tbl-wrap"><table><thead><tr><th></th><th>Modalidade</th><th>Origem</th><th class="num">Campeonatos</th><th>Estado</th><th></th></tr></thead><tbody>${sportRows}</tbody></table></div>
    <div class="section"><div class="bar"><h2 style="font-size:15px">Campeonatos da equipa</h2><button class="btn btn-green" data-action="newLeague">+ Novo campeonato</button></div>
    <div class="tbl-wrap">${mine.length ? `<table><thead><tr><th>Modalidade</th><th>Campeonato</th><th>País/região</th><th class="num">Eventos</th><th>Estado</th><th></th></tr></thead><tbody>${lgRows}</tbody></table>` : '<div class="empty">Nenhum campeonato criado pela equipa.</div>'}</div></div>
    <p class="note" style="text-align:left">Modalidades e campeonatos novos aparecem no menu do site assim que tiverem eventos. Campeonatos automáticos da ESPN (${auto.length}): ${esc(auto.map((l) => l.name).join(', '))}.</p>`;
}

async function viewRealEvents() {
  const { events } = await api('GET', '/api/admin/catalog/real');
  const q = A.realQuery.trim().toLowerCase();
  const list = events.filter((ev) => !q || `${ev.home} ${ev.away} ${ev.leagueName}`.toLowerCase().includes(q)).slice(0, 200);
  const rows = list.map((ev) => `<tr><td>${dt(ev.startsAt)}</td><td>${esc(ev.leagueName)}</td><td><b>${esc(evName(ev))}</b></td><td>${evState(ev)}</td>
    <td>${ev.markets ? `${ev.markets}${ev.toSettle ? ` · <span style="color:var(--yellow)">${ev.toSettle} por liquidar</span>` : ''}` : '<span class="sub">—</span>'}</td><td class="num">${ev.bets || ''}</td>
    <td><button class="btn ${ev.markets ? 'btn-green' : 'btn-ghost'}" style="padding:6px 10px;font-size:12px" data-catev="${esc(ev.id)}">${ev.markets ? 'Gerir mercados' : '+ Mercados'}</button></td></tr>`).join('');
  return `<div class="bar"><h2 style="font-size:15px">Jogos do feed da ESPN</h2>
      <form id="realSearch" style="display:flex;gap:8px"><input name="q" value="${esc(A.realQuery)}" placeholder="Equipa ou campeonato" style="min-width:220px"><button class="btn btn-ghost" type="submit">Filtrar</button></form></div>
    <div class="tbl-wrap">${list.length ? `<table><thead><tr><th>Início</th><th>Campeonato</th><th>Jogo</th><th>Estado</th><th>Mercados da equipa</th><th class="num">Apostas abertas</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Nenhum jogo encontrado.</div>'}</div>
    <p class="note" style="text-align:left">Os mercados da ESPN (resultado, totais, handicap...) continuam automáticos. Aqui acrescenta mercados seus a um jogo real (ex.: escanteios, cartões, marca primeiro), com odds e liquidação feitas pela equipa.</p>`;
}

async function viewCatEvent() {
  const d = await api('GET', '/api/admin/catalog/event?id=' + encodeURIComponent(A.catEv));
  A.catData = d;
  const ev = d.event;
  let info;
  if (ev.manual) {
    const cat = await catalog();
    info = `<div class="card"><form id="evForm" data-id="${esc(ev.id)}" class="ev-form">
      <label>Campeonato<select class="mini" name="league">${leagueOptions(cat, ev.league)}</select></label>
      <label>Casa / participante 1<input class="mini" name="home" value="${esc(ev.home)}" required></label>
      <label>Fora / participante 2<input class="mini" name="away" value="${esc(ev.away)}" required></label>
      <label>Início<input class="mini" type="datetime-local" name="startsAt" value="${localInput(ev.startsAt)}" required></label>
      <label>Estado<select class="mini" name="state">${Object.entries(EV_STATE).map(([k, [, l]]) => `<option value="${k}" ${ev.state === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Placar casa<input class="mini" name="scoreH" type="number" min="0" max="999" value="${ev.score ? ev.score.h : ''}"></label>
      <label>Placar fora<input class="mini" name="scoreA" type="number" min="0" max="999" value="${ev.score ? ev.score.a : ''}"></label>
      <label>Tempo (texto livre)<input class="mini" name="clock" value="${esc(ev.clock)}" placeholder="Ex.: 2º tempo 67'"></label>
      <button class="btn btn-green" type="submit">Guardar evento</button>
    </form><div class="form-err" id="formErr"></div>
    <div class="acts" style="margin-top:10px"><button class="btn btn-ghost" data-archive="${esc(ev.id)}" data-val="${ev.archived ? '0' : '1'}">${ev.archived ? 'Reativar no site' : 'Arquivar (tirar do site)'}</button></div></div>`;
  } else {
    info = `<div class="card"><div class="kv2"><span>Campeonato</span><b>${esc(ev.leagueName)}</b></div><div class="kv2"><span>Início</span><b>${dt(ev.startsAt)}</b></div>
      <div class="kv2"><span>Estado (feed da ESPN)</span><b>${evState(ev)}</b></div>
      <p class="sub" style="margin:8px 0 0">Jogo real: placar e mercados automáticos vêm da ESPN. Os mercados abaixo são só os da equipa.</p></div>`;
  }
  const markets = d.markets.map(marketCard).join('');
  const pendingN = d.markets.filter((m) => m.status !== 'settled').length;
  return `<div class="bar"><h2>${esc(evName(ev))}</h2><span class="sub">${esc(ev.leagueName)}</span><button class="btn btn-ghost" data-go="mercados">← Voltar</button></div>
    ${ev.state === 'post' && pendingN ? `<div class="warn">O evento terminou e há ${pendingN} mercado(s) por liquidar. As apostas só são pagas depois de liquidar.</div>` : ''}
    ${info}
    <div class="section"><div class="bar"><h2 style="font-size:15px">Mercados (${d.markets.length})</h2>
      ${pendingN ? `<button class="btn btn-ghost" data-mkstatus="*|suspended">Suspender todos</button><button class="btn btn-ghost" data-mkstatus="*|open">Abrir todos</button>` : ''}
      <button class="btn btn-green" data-action="newMarket">+ Novo mercado</button></div>
    ${markets || '<div class="tbl-wrap"><div class="empty">Sem mercados. Crie o primeiro com "+ Novo mercado".</div></div>'}</div>`;
}

function marketCard(m) {
  const [cls, label] = MK_STATE[m.status];
  const betsN = m.sels.reduce((s, x) => s + x.bets, 0);
  if (m.status === 'settled') {
    return `<div class="mk-card settled"><div class="mk-head"><b class="grow">${esc(m.name)}</b>${pill(cls, label)}<span class="sub">${dt(m.settledAt)} · ${esc(m.settledBy || '')}</span></div>
      <table><tbody>${m.sels.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${s.odds.toFixed(2)}</td><td>${pill(...RES_PILL[s.result])}</td></tr>`).join('')}</tbody></table>
      ${m.note ? `<div class="sub" style="margin-top:6px">${esc(m.note)}</div>` : ''}</div>`;
  }
  const rows = m.sels.map((s) => selRow(s)).join('');
  return `<form class="mk-card mkForm" data-mk="${esc(m.id)}">
    <div class="mk-head"><input class="mini grow" name="name" value="${esc(m.name)}" required maxlength="80" title="Nome do mercado">${pill(cls, label)}
      <label class="sub" style="display:flex;gap:6px;align-items:center">Aposta máx. R$<input class="mini" name="maxStake" style="width:90px" value="${m.maxStake != null ? String(m.maxStake).replace('.', ',') : ''}" placeholder="sem limite"></label></div>
    <div class="tbl-wrap" style="border:0"><table><thead><tr><th>Seleção</th><th>Odd</th><th class="num">Apostas</th><th class="num">Apostado</th><th class="num" title="Prêmio a pagar se esta seleção ganhar (apostas simples)">A pagar se ganhar</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="mk-foot"><button type="button" class="btn btn-ghost" data-seladd="${esc(m.id)}">+ Seleção</button>
      <button type="submit" class="btn btn-green">Guardar odds</button>
      <button type="button" class="btn btn-ghost" data-mkstatus="${esc(m.id)}|${m.status === 'open' ? 'suspended' : 'open'}">${m.status === 'open' ? 'Suspender' : 'Abrir'}</button>
      <button type="button" class="btn btn-ghost" data-mksettle="${esc(m.id)}">Liquidar</button>
      ${betsN ? '' : `<button type="button" class="btn btn-ghost" data-mkdel="${esc(m.id)}">Apagar</button>`}
      <span class="sub">${betsN ? `${betsN} seleção(ões) em apostas abertas` : 'sem apostas'}${m.maxStake != null ? ` · máx. ${money(m.maxStake)} por aposta` : ''}</span></div>
  </form>`;
}
const selRow = (s = {}) => `<tr data-sel="${esc(s.id || '')}">
  <td><input class="mini" name="sname" value="${esc(s.name || '')}" required maxlength="60" style="width:100%"></td>
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
  openModal(`<h3>Novo evento</h3><p class="sub">Escolha o campeonato (pode criar um novo em "Modalidades e campeonatos"). Depois adicione os mercados.</p>
    <form id="newEvForm"><label class="lbl">Campeonato *</label><select class="inp" name="league" required>${leagueOptions(cat, cat.leagues.find((l) => !l.builtin)?.key)}</select>
      <label class="lbl">Casa / participante 1 *</label><input class="inp" name="home" required maxlength="60">
      <label class="lbl">Fora / participante 2 *</label><input class="inp" name="away" required maxlength="60">
      <label class="lbl">Início *</label><input class="inp" type="datetime-local" name="startsAt" value="${localInput(t.getTime())}" required>
      <div class="form-err" id="formErr"></div><button class="btn btn-green btn-block" type="submit" style="margin-top:14px">Criar evento</button></form>`);
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
      <div class="form-err" id="formErr"></div><button class="btn btn-green btn-block" type="submit" style="margin-top:14px">Guardar</button></form>`);
}
function marketModal() {
  const ev = A.catData.event;
  const tpls = [
    ['Vencedor (1X2)', 'Vencedor', `${ev.home}; \nEmpate; \n${ev.away}; `],
    ['Vencedor (sem empate)', 'Vencedor', `${ev.home}; \n${ev.away}; `],
    ['Sim / Não', '', 'Sim; \nNão; '],
    ['Mais / Menos', 'Total — 2.5', 'Mais de 2.5; \nMenos de 2.5; '],
    ['Handicap', 'Handicap', `${ev.home} -1.5; \n${ev.away} +1.5; `],
  ];
  openModal(`<h3>Novo mercado</h3><p class="sub">${esc(evName(ev))}</p>
    <form id="newMkForm"><label class="lbl">Nome do mercado *</label><input class="inp" name="name" id="mkName" required maxlength="80" placeholder="Ex.: Total de escanteios, Marca primeiro, Vencedor do set">
      <label class="lbl">Seleções e odds * (uma por linha: <b>Nome; odd</b>)</label>
      <div class="tpl">${tpls.map(([l, n, v], i) => `<button type="button" data-tpl="${i}" data-name="${esc(n)}" data-val="${esc(v)}">${esc(l)}</button>`).join('')}</div>
      <textarea class="inp" name="sels" id="mkSels" required placeholder="Flamengo; 1.85&#10;Empate; 3.40&#10;Palmeiras; 4.20"></textarea>
      <label class="lbl">Aposta máxima por aposta (R$, opcional)</label><input class="inp" name="maxStake" placeholder="sem limite">
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
        <select class="inp" style="width:140px" data-res="${esc(s.id)}"><option value="">—</option><option value="won">Ganhou</option><option value="lost">Perdeu</option><option value="void">Devolvida</option></select></div>`).join('')}
      <div class="acts" style="margin:10px 0"><button type="button" class="btn btn-ghost" data-allvoid="1">Anular mercado (tudo devolvido)</button></div>
      <label class="lbl">Observação (opcional, fica no registo)</label><input class="inp" name="note" maxlength="300" placeholder="Ex.: resultado oficial confirmado na súmula">
      <div class="form-err" id="formErr"></div><button class="btn btn-green btn-block" type="submit" style="margin-top:14px">Liquidar e pagar apostas</button></form>`);
}

/* ---------- eventos ---------- */
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a, tr[data-user]');
  if (!t) return;
  const d = t.dataset;
  if (t.tagName === 'A' && (d.go || d.user)) e.preventDefault();
  try {
    if (d.action === 'close') return closeModal();
    if (d.action === 'refresh') return render();
    if (d.copy) { await navigator.clipboard.writeText(d.copy).catch(() => {}); t.textContent = 'copiado!'; setTimeout(() => { t.textContent = 'copiar'; }, 1500); return; }
    if (d.go) { if (d.depfilter) A.depFilter = d.depfilter; return go(d.go); }
    if (d.user) return go('jogador', { userId: d.user });
    if (d.wdClaim) { await api('POST', '/api/admin/withdrawals/claim', { id: d.wdClaim }); toast('Saque assumido. Faça o PIX e marque como pago.', 'ok'); return render(); }
    if (d.wdRelease) { await api('POST', '/api/admin/withdrawals/release', { id: d.wdRelease }); toast('Saque devolvido à fila'); return render(); }
    if (d.settle) { const [uid, id, expect] = d.settle.split('|'); return settleModal(uid, id, expect); }
    // esportes e mercados
    if (d.cattab) { A.catTab = d.cattab; return render(); }
    if (d.catev) return go('mercado-ev', { catEv: d.catev });
    if (d.action === 'newEvent') return newEventModal();
    if (d.action === 'newSport') return sportModal(null);
    if (d.action === 'newLeague') return leagueModal(null);
    if (d.action === 'newMarket') return marketModal();
    if (d.icon) { $('#sportIcon').value = d.icon; return; }
    if (d.tpl) { $('#mkSels').value = d.val; if (d.name && !$('#mkName').value) $('#mkName').value = d.name; $('#mkSels').focus(); return; }
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
  // liquidar mercado: ao marcar uma vencedora, as que ainda não têm resultado passam a "Perdeu"
  if (e.target.matches('select[data-res]') && e.target.value === 'won') document.querySelectorAll('select[data-res]').forEach((x) => { if (!x.value) x.value = 'lost'; });
  if (e.target.id === 'catArchived') { A.catArchived = e.target.value === '1'; render(); }
  if (e.target.id === 'betFilter') { A.betFilter = e.target.value; render(); }
  if (e.target.id === 'wdFilter') { A.wdFilter = e.target.value; render(); }
  if (e.target.id === 'depFilter') { A.depFilter = e.target.value; render(); }
});
document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, fd = Object.fromEntries(new FormData(f));
  const btn = f.querySelector('button[type=submit]');
  formErr(''); if (btn) btn.disabled = true;
  try {
    if (f.id === 'loginForm') { await api('POST', '/api/login', fd); return boot(); }
    if (f.id === 'userSearch') { A.userQuery = fd.q.trim(); return render(); }
    if (f.id === 'realSearch') { A.realQuery = fd.q; return render(); }
    if (f.id === 'sportForm') { await api('POST', '/api/admin/catalog/sport', { key: f.dataset.key || undefined, name: fd.name, icon: fd.icon, hidden: !!f.dataset.hidden }); closeModal(); toast('Modalidade guardada', 'ok'); }
    if (f.id === 'leagueForm') { await api('POST', '/api/admin/catalog/league', { key: f.dataset.key || undefined, name: fd.name, country: fd.country, sport: fd.sport, hidden: !!f.dataset.hidden }); closeModal(); toast('Campeonato guardado', 'ok'); }
    if (f.id === 'newEvForm') {
      const r = await api('POST', '/api/admin/catalog/event', { league: fd.league, home: fd.home, away: fd.away, startsAt: new Date(fd.startsAt).getTime(), state: 'pre' });
      closeModal(); toast('Evento criado. Agora adicione os mercados.', 'ok'); return go('mercado-ev', { catEv: r.id });
    }
    if (f.id === 'evForm') {
      await api('POST', '/api/admin/catalog/event', { id: f.dataset.id, league: fd.league, home: fd.home, away: fd.away, startsAt: new Date(fd.startsAt).getTime(), state: fd.state, scoreH: fd.scoreH, scoreA: fd.scoreA, clock: fd.clock });
      toast('Evento atualizado', 'ok');
    }
    if (f.id === 'newMkForm') {
      await api('POST', '/api/admin/catalog/market', { evId: A.catEv, name: fd.name, sels: parseSelLines(fd.sels), maxStake: fd.maxStake, open: !!fd.open });
      closeModal(); toast('Mercado criado', 'ok');
    }
    if (f.classList.contains('mkForm')) {
      const sels = [...f.querySelectorAll('tr[data-sel]')].map((tr) => ({ id: tr.dataset.sel || undefined, name: tr.querySelector('[name=sname]').value, odds: tr.querySelector('[name=sodds]').value }));
      await api('POST', '/api/admin/catalog/market', { evId: A.catEv, id: f.dataset.mk, name: fd.name, maxStake: fd.maxStake, sels });
      toast('Mercado guardado', 'ok');
    }
    if (f.id === 'settleMkForm') {
      const results = Object.fromEntries([...f.querySelectorAll('select[data-res]')].map((x) => [x.dataset.res, x.value]));
      if (Object.values(results).some((v) => !v)) { formErr('Escolha o resultado de todas as seleções.'); if (btn) btn.disabled = false; return; }
      await api('POST', '/api/admin/catalog/market/settle', { evId: A.catEv, id: f.dataset.id, results, note: fd.note });
      closeModal(); toast('Mercado liquidado. As apostas foram decididas.', 'ok');
    }
    if (f.id === 'payForm') { await api('POST', '/api/admin/withdrawals/pay', { id: f.dataset.id, proof: fd.proof, note: fd.note }); closeModal(); toast('Saque marcado como pago ✓', 'ok'); }
    if (f.id === 'rejectForm') { await api('POST', '/api/admin/withdrawals/reject', { id: f.dataset.id, reason: fd.reason }); closeModal(); toast('Saque recusado; valor devolvido ao jogador', 'ok'); }
    if (f.id === 'depForm') { await api('POST', '/api/admin/deposits/resolve', { id: f.dataset.id, action: f.dataset.act, amount: parseMoney(fd.amount), reason: fd.reason }); closeModal(); toast('Feito', 'ok'); }
    if (f.id === 'settleForm') {
      const results = [...f.querySelectorAll('select[data-leg]')].map((x) => x.value);
      if (results.some((r) => !r)) { formErr('Escolha o resultado de todas as seleções.'); if (btn) btn.disabled = false; return; }
      const r = await api('POST', '/api/admin/bets/settle', { userId: f.dataset.uid, id: f.dataset.id, expect: f.dataset.expect, results, reason: fd.reason });
      closeModal(); toast(`Aposta ${BET_LABEL[r.status]} · retorno ${money(r.payout)} · saldo do jogador ${r.diff >= 0 ? '+' : ''}${money(r.diff)}`, 'ok');
    }
    if (f.id === 'adjForm') { await api('POST', '/api/admin/user/adjust', { id: f.dataset.id, amount: parseMoney(fd.amount), reason: fd.reason }); closeModal(); toast('Saldo ajustado', 'ok'); }
    if (f.id === 'blockForm') { await api('POST', '/api/admin/user/block', { id: f.dataset.id, blocked: f.dataset.val === '1', reason: fd.reason }); closeModal(); toast('Feito', 'ok'); }
    render();
  } catch (err) {
    if (btn) btn.disabled = false;
    // os cartões de mercado não têm caixa de erro própria
    if (f.classList.contains('mkForm') || !$('#formErr')) toast(err.message, 'err'); else formErr(err.message);
  }
});

boot();
