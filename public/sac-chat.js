'use strict';
/* Chat do SAC: assistente automático que responde às dúvidas comuns.
   Não guarda nada no servidor. "Falar com uma pessoa" abre o e-mail de suporte já com a conversa. */
(() => {
  const $ = (id) => document.getElementById(id);
  const chat = $('chat'), log = $('chatLog'), quick = $('chatQuick'), form = $('chatForm'), input = $('chatInput');
  const site = { supportEmail: 'suporte@tugasbet.com', withdrawEta: 'até 24 horas' };
  const history = []; // conversa, para mandar no e-mail
  let misses = 0;

  fetch('/api/site').then((r) => r.json()).then((d) => {
    Object.assign(site, Object.fromEntries(Object.entries(d.site || {}).filter(([, v]) => v)));
    const mail = $('sacEmail');
    if (site.supportEmail) mail.href = 'mailto:' + site.supportEmail; else mail.removeAttribute('href');
  }).catch(() => {});

  // tira acentos e põe em minúsculas, para comparar palavras
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  /* Cada tema: palavras que o identificam e a resposta (texto + links opcionais).
     As respostas seguem os Termos de uso; se as regras mudarem, atualize aqui também. */
  const TOPICS = [
    { id: 'deposito', label: 'PIX não caiu', words: ['deposit', 'pix', 'caiu', 'credit', 'saldo', 'pagamento', 'paguei', 'comprovativo', 'comprovante'],
      answer: () => ['O depósito costuma ser creditado automaticamente assim que o banco confirma o PIX.',
        'Veja no Extrato se está como "pendente" e confirme que o PIX saiu de uma conta no seu próprio CPF: pagamentos de terceiros não são creditados e voltam à origem.',
        'Se já passou algum tempo e o saldo não apareceu, fale com uma pessoa e envie o comprovativo.'] },
    { id: 'saque', label: 'Prazo do saque', words: ['saque', 'sacar', 'retirar', 'retirada', 'levantar', 'levantamento', 'receber', 'prazo', 'demora'],
      answer: () => [`Cada saque é conferido pela nossa equipa e pago em ${site.withdrawEta}, por PIX, para uma chave PIX em seu nome.`,
        'Enquanto o pedido estiver "pendente", pode cancelá-lo no Extrato e o valor volta ao saldo.',
        'Para sacar precisa de ter o e-mail confirmado e já ter feito um depósito por PIX.'] },
    { id: 'terceiros', label: 'Sacar para outra pessoa', words: ['outra pessoa', 'terceiro', 'familia', 'amigo', 'conta de', 'nome de', 'chave'],
      answer: () => ['Por segurança e por exigência da lei, os saques vão sempre para uma chave PIX em nome do próprio titular da conta. Não é possível enviar para outra pessoa.'] },
    { id: 'senha', label: 'Esqueci a senha', words: ['senha', 'password', 'entrar', 'login', 'acesso', 'acessar', 'esqueci', 'bloque'],
      answer: () => ['No ecrã de entrada, clique em "Esqueci minha senha" e indique o e-mail da conta. Enviamos um link para criar uma nova senha.',
        'Se não receber o e-mail, veja a pasta de spam. Se a conta estiver bloqueada, fale com uma pessoa.'] },
    { id: 'email', label: 'Confirmar e-mail', words: ['confirmar', 'confirmacao', 'verificar', 'verificacao', 'link'],
      answer: () => ['Depois do registo enviamos um link de confirmação para o seu e-mail. Abra-o para ativar todas as funções da conta, incluindo os saques.',
        'Se não encontrar a mensagem, veja a pasta de spam.'] },
    { id: 'anulada', label: 'Aposta anulada', words: ['anulad', 'cancelad', 'aposta', 'odd', 'resultado', 'multipla', 'cash out', 'cashout'],
      answer: () => ['Uma seleção é anulada quando o evento é adiado, cancelado ou abandonado, ou quando a odd foi publicada com erro evidente.',
        'Nas apostas simples o valor é devolvido; nas múltiplas, essa seleção passa a contar com odd 1,00.'],
      links: [['Termos de uso', '/termos']] },
    { id: 'pausa', label: 'Limites e pausa', words: ['pausa', 'limite', 'autoexclus', 'excluir', 'fechar', 'encerrar', 'apagar conta', 'parar'],
      answer: () => ['Na sua conta pode definir limites de depósito e de perda, ativar uma pausa ou a autoexclusão. Durante a pausa continua a poder sacar o saldo.'],
      links: [['Jogo responsável', '/jogo-responsavel']] },
    { id: 'ajuda', words: ['vicio', 'viciado', 'nao consigo parar', 'perdi tudo', 'divida', 'desesper', 'ansiedade'],
      answer: () => ['Lamentamos que esteja a passar por isto. Pode ativar já uma pausa ou a autoexclusão na sua conta.',
        'Se precisar de falar com alguém, ligue para o CVV no 188 (gratuito, 24h) ou procure os Jogadores Anónimos.'],
      links: [['Jogo responsável', '/jogo-responsavel']] },
    { id: 'bonus', words: ['bonus', 'promo', 'brinde', 'oferta', 'cupao', 'cupom'],
      answer: () => ['Não oferecemos bónus de entrada nem promoções para incentivar apostas, conforme a regulação em vigor.'] },
    { id: 'golpe', words: ['golpe', 'fraude', 'whatsapp', 'liberar', 'taxa'],
      answer: () => ['A nossa equipa nunca pede a sua senha, códigos de verificação nem pagamentos para "liberar" saques.',
        'Se alguém o contactou assim em nosso nome, não pague nada e fale connosco.'] },
  ];
  const QUICK = TOPICS.filter((t) => t.label);

  function bubble(who, lines, links) {
    const el = document.createElement('div');
    el.className = 'msg msg-' + who;
    for (const line of [].concat(lines)) { const p = document.createElement('p'); p.textContent = line; el.append(p); }
    for (const [text, href] of links || []) {
      const a = document.createElement('a'); a.className = 'link'; a.textContent = text + ' →'; a.href = href; el.append(a);
    }
    log.append(el);
    log.scrollTop = log.scrollHeight;
    history.push((who === 'user' ? 'Cliente: ' : 'Assistente: ') + [].concat(lines).join(' '));
  }

  function chips(list) {
    quick.replaceChildren();
    for (const c of list) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip' + (c.human ? ' chip-human' : ''); b.textContent = c.label;
      b.onclick = () => (c.human ? human() : ask(c.label, c));
      quick.append(b);
    }
  }
  const HUMAN = { label: '👤 Falar com uma pessoa', human: true };
  const mainChips = () => chips([...QUICK, HUMAN]);

  function find(text) {
    const t = norm(text);
    if (/\b(atendente|humano|operador)\b|falar com (uma pessoa|alguem|a equipa|a equipe)/.test(t)) return 'human';
    if (/^(ola|oi|bom dia|boa tarde|boa noite|hey)\b/.test(t) && t.length < 20) return 'hello';
    if (/\b(obrigad|valeu|agradec)/.test(t)) return 'thanks';
    let best = null, score = 0;
    for (const topic of TOPICS) {
      const s = topic.words.reduce((n, w) => n + (t.includes(w) ? w.length : 0), 0);
      if (s > score) { best = topic; score = s; }
    }
    return best;
  }

  function reply(topic) {
    if (topic === 'human') return human();
    if (topic === 'hello') { bubble('bot', 'Olá! Em que posso ajudar? Escolha um tema abaixo ou escreva a sua dúvida.'); return mainChips(); }
    if (topic === 'thanks') { bubble('bot', 'De nada! Se precisar de mais alguma coisa, estou por aqui.'); return mainChips(); }
    if (!topic) {
      misses++;
      bubble('bot', misses > 1 ? 'Ainda não consegui ajudar com isso. Prefere passar a sua dúvida a uma pessoa da equipa?' : 'Não percebi bem. Pode escrever de outra forma, ou escolher um dos temas abaixo?');
      return chips(misses > 1 ? [HUMAN, ...QUICK] : [...QUICK, HUMAN]);
    }
    misses = 0;
    bubble('bot', topic.answer(), topic.links);
    bubble('bot', 'Isto resolveu a sua dúvida?');
    chips([{ label: '👍 Sim, obrigado', id: 'ok' }, HUMAN, ...QUICK.filter((q) => q !== topic)]);
  }

  function ask(text, topic) {
    bubble('user', text);
    if (topic && topic.id === 'ok') { bubble('bot', 'Ótimo! Se precisar de mais alguma coisa, estou por aqui.'); return mainChips(); }
    setTimeout(() => reply(topic && topic.words ? topic : find(text)), 350); // pequena pausa para parecer natural
  }

  function human() {
    if (!site.supportEmail) {
      bubble('bot', 'De momento não conseguimos abrir o contacto com a equipa. Tente de novo dentro de instantes.');
      return mainChips();
    }
    bubble('bot', ['Vamos abrir o seu e-mail com esta conversa já escrita. Basta acrescentar os detalhes e enviar.',
      'Indique o e-mail da sua conta e, se for sobre um pagamento, a data, o valor e o comprovativo.']);
    const body = ('Olá, preciso de ajuda.\n\nE-mail da conta: \nDetalhes: \n\n--- Conversa no chat ---\n' + history.join('\n')).slice(0, 1800);
    const url = 'mailto:' + site.supportEmail + '?subject=' + encodeURIComponent('Atendimento pelo chat do site') + '&body=' + encodeURIComponent(body);
    setTimeout(() => { location.href = url; }, 600);
    mainChips();
  }

  function open() {
    chat.hidden = false;
    document.body.classList.add('chat-on');
    if (!log.childElementCount) {
      bubble('bot', ['Olá! Sou o assistente de atendimento da Tugas.', 'Escolha um tema abaixo ou escreva a sua dúvida.']);
      mainChips();
    }
    input.focus();
  }
  function close() { chat.hidden = true; document.body.classList.remove('chat-on'); }

  document.querySelectorAll('[data-chat-open]').forEach((b) => b.addEventListener('click', open));
  document.querySelector('[data-chat-close]').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !chat.hidden) close(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    ask(text);
  });
  if (location.hash === '#chat') open();
})();
