'use strict';
/* Preenche as páginas legais com os dados da empresa definidos no .env do servidor. */
fetch('/api/site').then((r) => r.json()).then(({ site }) => {
  const fill = { name: site.name, company: site.company || '[RAZÃO SOCIAL]', cnpj: site.cnpj || '[CNPJ]', license: site.license || '[Nº DA AUTORIZAÇÃO SPA/MF]', supportEmail: site.supportEmail || '[E-MAIL DE SUPORTE]', supportPhone: site.supportPhone || '[TELEFONE]', withdrawEta: site.withdrawEta };
  document.querySelectorAll('[data-site]').forEach((el) => { el.textContent = fill[el.dataset.site] ?? ''; });
}).catch(() => {});
