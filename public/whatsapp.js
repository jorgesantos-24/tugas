'use strict';
/* Botão flutuante do WhatsApp do suporte, no canto inferior esquerdo de todas as páginas do cliente
   (no telemóvel, na página principal, fica por cima da barra de baixo).
   O canto direito fica livre para o boletim (mobile) e para o chat do SAC.
   Para trocar o número, altere WHATSAPP abaixo (só dígitos, com o 55 do Brasil). */
(() => {
  const WHATSAPP = '5511968355612';
  const MESSAGE = 'Olá! Preciso de ajuda com a minha conta TUGAS.';
  if (document.getElementById('waFab')) return;

  const css = `
.wa-fab{position:fixed;left:18px;bottom:18px;z-index:45;display:flex;align-items:center;gap:10px;text-decoration:none;font-family:inherit}
.wa-btn{position:relative;display:grid;place-items:center;width:56px;height:56px;border-radius:50%;background:#25d366;color:#fff;box-shadow:0 8px 24px rgba(37,211,102,.4);transition:transform .15s}
.wa-btn svg{width:30px;height:30px;fill:currentColor}
.wa-btn::before{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid #25d366;animation:waPulse 2.4s ease-out infinite}
.wa-shield{position:absolute;right:-4px;bottom:-4px;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#0c120f;border:2px solid #25d366;font-size:11px;line-height:1}
.wa-tip{display:flex;flex-direction:column;padding:8px 12px;border-radius:12px;background:#111814;border:1px solid #25332b;color:#f4f7f5;box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:13px;line-height:1.3;white-space:nowrap;opacity:0;transform:translateX(-6px);pointer-events:none;transition:opacity .2s,transform .2s}
.wa-tip b{font-size:13.5px}
.wa-tip small{color:#93a39a;font-size:11.5px}
.wa-fab:hover .wa-btn,.wa-fab:focus-visible .wa-btn{transform:scale(1.07)}
.wa-fab:hover .wa-tip,.wa-fab:focus-visible .wa-tip,.wa-fab.wa-hello .wa-tip{opacity:1;transform:none}
.wa-fab:focus-visible{outline:none}
.wa-fab:focus-visible .wa-btn{outline:3px solid #ffcc1f;outline-offset:3px}
@keyframes waPulse{0%{transform:scale(1);opacity:.7}80%,100%{transform:scale(1.5);opacity:0}}
@media (max-width:760px){.wa-fab{left:12px;bottom:14px}.wa-btn{width:50px;height:50px}.wa-btn svg{width:27px;height:27px}}
@media (prefers-reduced-motion:reduce){.wa-btn::before{animation:none;display:none}.wa-btn,.wa-tip{transition:none}}
@media print{.wa-fab{display:none}}
/* página com a barra de baixo (telemóvel): o botão fica por cima dela, do lado esquerdo, à altura do Boletim */
@media (max-width:900px){
  .wa-above-nav .wa-fab{left:12px;bottom:calc(76px + env(safe-area-inset-bottom))}
  .wa-above-nav .wa-btn{width:46px;height:46px}
  .wa-above-nav .wa-btn svg{width:25px;height:25px}
  .wa-above-nav .wa-shield{width:19px;height:19px;font-size:9px}
}
/* computador: o menu lateral acaba acima do botão, para não ficar tapado */
@media (min-width:901px){ .has-wa .sidebar{max-height:calc(100vh - 170px)} }
body.ft-open .wa-fab{display:none}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const a = document.createElement('a');
  a.id = 'waFab';
  a.className = 'wa-fab';
  a.href = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(MESSAGE)}`;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.setAttribute('aria-label', 'Falar com o suporte pelo WhatsApp (abre numa nova janela)');
  a.innerHTML = `
<span class="wa-btn" aria-hidden="true">
  <svg viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
  <span class="wa-shield">🛡</span>
</span>
<span class="wa-tip"><b>Precisa de ajuda?</b><small>Suporte pelo WhatsApp</small></span>`;
  document.body.appendChild(a);
  document.body.classList.add('has-wa');
  if (document.getElementById('bottomNav')) document.body.classList.add('wa-above-nav');

  // Na primeira visita da sessão, mostra o balão "Precisa de ajuda?" por alguns segundos (só em ecrãs largos).
  try {
    if (window.matchMedia('(min-width:761px)').matches && !sessionStorage.getItem('waHello')) {
      sessionStorage.setItem('waHello', '1');
      setTimeout(() => { a.classList.add('wa-hello'); setTimeout(() => a.classList.remove('wa-hello'), 5000); }, 2500);
    }
  } catch { /* sem sessionStorage: o balão só aparece ao passar o rato */ }
})();
