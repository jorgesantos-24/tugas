'use strict';
/* E-mails do site (confirmação da conta, nova senha) enviados por suporte@tugasbet.com (SMTP da Hostinger),
   com o visual do TUGAS. O link de cada e-mail continua a ser gerado pelo Firebase Authentication.
   Sem SMTP_PASS (ou nos emuladores) fica desligado e o Firebase envia o e-mail dele, como antes. */
const nodemailer = require('nodemailer');

const HOST = process.env.SMTP_HOST || 'smtp.hostinger.com';
const PORT = Number(process.env.SMTP_PORT) || 465;
const USER = process.env.SMTP_USER || process.env.SUPPORT_EMAIL || 'suporte@tugasbet.com';
const PASS = process.env.SMTP_PASS || '';
const SITE = process.env.SITE_NAME || 'TUGAS';
const SITE_URL = (process.env.SITE_URL || 'https://tugasbet.com').replace(/\/$/, '');
const enabled = !!PASS && !process.env.FIREBASE_AUTH_EMULATOR_HOST;

let tx = null;
const transport = () => tx || (tx = nodemailer.createTransport({
  host: HOST, port: PORT, secure: PORT === 465, auth: { user: USER, pass: PASS },
  pool: true, maxConnections: 2, connectionTimeout: 15000, socketTimeout: 20000,
}));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// moldura comum: logótipo, faixa com as cores do site, texto, botão e rodapé (tabelas e estilos inline: funciona no Gmail/Outlook)
function layout({ preheader, title, intro, button, link, outro }) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#090d0b;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#f4f7f5">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#090d0b;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#111814;border:1px solid #25332b;border-radius:16px;overflow:hidden">
<tr><td style="height:5px;background:#1fd36f;background-image:linear-gradient(90deg,#0a8f3c 0%,#1fd36f 30%,#ffcc1f 50%,#ee2b3f 72%,#b3121f 100%)"></td></tr>
<tr><td align="center" style="padding:28px 24px 8px"><a href="${SITE_URL}" style="text-decoration:none"><img src="${SITE_URL}/img/logo.png" width="220" alt="${esc(SITE)}" style="display:block;width:220px;max-width:70%;height:auto;border:0"></a></td></tr>
<tr><td style="padding:16px 32px 0">
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:#f4f7f5;font-weight:800">${esc(title)}</h1>
${intro.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#c9d4ce">${p}</p>`).join('')}
</td></tr>
<tr><td align="center" style="padding:10px 32px 22px">
<a href="${esc(link)}" style="display:inline-block;background:#1fd36f;color:#06210f;font-size:16px;font-weight:800;text-decoration:none;padding:14px 34px;border-radius:10px">${esc(button)}</a>
</td></tr>
<tr><td style="padding:0 32px 24px">
<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#93a39a">${outro}</p>
<p style="margin:0;font-size:12px;line-height:1.5;color:#93a39a">Se o botão não funcionar, copie este link para o navegador:<br><a href="${esc(link)}" style="color:#1fd36f;word-break:break-all">${esc(link)}</a></p>
</td></tr>
<tr><td style="padding:18px 32px;border-top:1px solid #25332b;background:#0d130f">
<p style="margin:0;font-size:12px;line-height:1.6;color:#93a39a">Dúvidas? Responda a este e-mail ou escreva para <a href="mailto:${USER}" style="color:#1fd36f">${USER}</a>.<br>
Jogue com responsabilidade. Proibido para menores de 18 anos.<br>© ${new Date().getFullYear()} ${esc(SITE)} · <a href="${SITE_URL}" style="color:#93a39a">${SITE_URL.replace(/^https?:\/\//, '')}</a></p>
</td></tr>
</table></td></tr></table></body></html>`;
}

const first = (name) => esc(String(name || '').trim().split(/\s+/)[0] || '');

function verifyEmail({ name, link }) {
  const hi = first(name);
  return {
    subject: `Confirme o seu e-mail no ${SITE}`,
    html: layout({
      preheader: `Falta só um passo para ativar a sua conta no ${SITE}.`,
      title: hi ? `Olá, ${hi}! Confirme o seu e-mail` : 'Confirme o seu e-mail',
      intro: [`Obrigado por criar a sua conta no <b>${esc(SITE)}</b>. Para a ativar, confirme que este endereço é seu.`],
      button: 'Confirmar e-mail', link,
      outro: 'Se não criou uma conta no TUGAS, pode ignorar este e-mail.',
    }),
    text: `${hi ? `Olá, ${hi}!\n\n` : ''}Confirme o seu e-mail no ${SITE} abrindo este link:\n${link}\n\nSe não criou uma conta, ignore este e-mail.\n\n${SITE} · ${SITE_URL}`,
  };
}

function resetPassword({ name, link }) {
  const hi = first(name);
  return {
    subject: `Criar uma nova senha no ${SITE}`,
    html: layout({
      preheader: `Pedido de nova senha para a sua conta no ${SITE}.`,
      title: hi ? `Olá, ${hi}! Vamos criar uma nova senha` : 'Vamos criar uma nova senha',
      intro: [`Recebemos um pedido para trocar a senha da sua conta no <b>${esc(SITE)}</b>. Clique no botão para escolher uma nova.`],
      button: 'Criar nova senha', link,
      outro: 'Se não pediu uma nova senha, ignore este e-mail: a sua senha atual continua a funcionar.',
    }),
    text: `${hi ? `Olá, ${hi}!\n\n` : ''}Para criar uma nova senha no ${SITE}, abra este link:\n${link}\n\nSe não pediu, ignore este e-mail.\n\n${SITE} · ${SITE_URL}`,
  };
}

async function send(to, msg) {
  await transport().sendMail({ from: { name: SITE, address: USER }, replyTo: USER, to, ...msg });
}

module.exports = {
  enabled,
  verify: () => transport().verify(),
  sendVerifyEmail: (to, name, link) => send(to, verifyEmail({ name, link })),
  sendResetPassword: (to, name, link) => send(to, resetPassword({ name, link })),
  _templates: { verifyEmail, resetPassword },
};
