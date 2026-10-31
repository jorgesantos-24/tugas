// Tema de Halloween: liga sozinho de 24/10 a 01/11 (data do aparelho). Volta todos os anos.
// Para testar noutro dia: ?tema=halloween   ·   para desligar: ?tema=normal
(function () {
  var root = document.documentElement;
  var q = /[?&]tema=([a-z]+)/.exec(location.search);
  var d = new Date(), m = d.getMonth() + 1, dia = d.getDate();
  var ligado = (m === 10 && dia >= 24) || (m === 11 && dia === 1);
  if (q) ligado = q[1] === 'halloween';
  if (!ligado) return;
  root.classList.add('theme-halloween');
  try { if (sessionStorage.getItem('hwStripOff') === '1') root.classList.add('hw-strip-off'); } catch (e) {}

  var WEB = '<svg viewBox="0 0 100 100" fill="none" stroke="#fff" stroke-width="1.2">' +
    '<path d="M0 0L100 100M0 0L100 40M0 0L40 100M0 0L100 0M0 0L0 100"/>' +
    '<path d="M20 0Q16 8 18 18Q8 16 0 20"/><path d="M42 0Q34 18 38 38Q18 34 0 42"/>' +
    '<path d="M66 0Q54 28 60 60Q28 54 0 66"/><path d="M92 0Q76 40 84 84Q40 76 0 92"/></svg>';
  var BAT = '<svg viewBox="0 0 64 32"><path d="M32 10c2-4 3-6 3-8 1 2 2 3 3 3l2-3c0 4 2 7 6 8 4-6 10-8 18-6-5 2-7 6-7 11-3-2-6-2-9 1-2-3-5-3-8-1-1 3-3 6-8 8-5-2-7-5-8-8-3-2-6-2-8 1-3-3-6-3-9-1 0-5-2-9-7-11 8-2 14 0 18 6 4-1 6-4 6-8l2 3c1 0 2-1 3-3 0 2 1 4 3 8z"/></svg>';

  function montar() {
    var top = document.querySelector('.topbar');
    if (top && !top.querySelector('.hw-web')) {
      var w = document.createElement('span'); w.className = 'hw-web'; w.innerHTML = WEB; w.setAttribute('aria-hidden', 'true');
      top.insertBefore(w, top.firstChild);
    }
    if (top && !document.querySelector('.hw-strip')) {
      var s = document.createElement('div'); s.className = 'hw-strip'; s.setAttribute('role', 'note');
      s.innerHTML = '<span>🎃 <b>Noite de Halloween</b> na TugasBet<span class="hw-long"> — boas apostas, sem sustos!</span> 🦇</span>' +
        '<button type="button" aria-label="Fechar aviso de Halloween">×</button>';
      s.querySelector('button').addEventListener('click', function () {
        root.classList.add('hw-strip-off');
        try { sessionStorage.setItem('hwStripOff', '1'); } catch (e) {}
      });
      top.parentNode.insertBefore(s, top.nextSibling);
    }
    if (!document.querySelector('.hw-layer')) {
      var l = document.createElement('div'); l.className = 'hw-layer'; l.setAttribute('aria-hidden', 'true');
      var bats = '';
      for (var i = 0; i < 5; i++) bats += '<div class="hw-bat">' + BAT + '</div>';
      l.innerHTML = bats + '<div class="hw-moon"></div><div class="hw-corner l">' + WEB + '</div><div class="hw-corner r">' + WEB + '</div><div class="hw-spider"></div>';
      document.body.appendChild(l);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar); else montar();
})();
