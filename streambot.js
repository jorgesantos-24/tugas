'use strict';
/* Bot da transmissão no servidor: não precisa de janela aberta nem de caixas marcadas.
   - abre o vídeo pelo link guardado na partida (streamsrc.js) com o ffmpeg, 2 imagens por segundo;
   - encontra o HUD sozinho (hudreader.js): placar de rounds, jogadores vivos e os nomes das equipas
     (para saber de que lado está cada uma); procura de novo num mapa novo ou quando o perde;
   - conta os rounds no site com o mesmo "+1 round" do painel (as odds mudam), manda os jogadores vivos,
     suspende os mercados quando tem dúvidas (leitura estranha, placar fora do ecrã com o jogo ao vivo,
     lados por confirmar) e reabre-os depois; liquida as apostas 60 s depois de o placar as decidir;
   - fica gravado no evento (live.bot): depois de um reinício do servidor volta a ligar-se sozinho;
     com várias instâncias, só a que tem a "posse" (renovada a cada 15 s) corre o bot. */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const H = require('./hudreader.js');

const FW = 1280, FH = 720, FPS = 2;
const CONFIRM = 3;     // leituras iguais seguidas para aceitar um placar (1,5 s)
const LOST = 12000;    // jogo ao vivo e placar fora do ecrã há 12 s -> suspende
const SETTLE = 60000;  // liquida 60 s depois de o placar decidir (tempo para corrigir com "desfazer")
const SLOTS = 5;       // jogadores por equipa
const BREAK_MAX = 20 * 60000; // intervalo entre mapas: mercados abertos sem placar no ecrã até 20 min
const PAUSE_KEEP = 120000;     // etiqueta de pausa vista há menos de 2 min: continua a contar como pausa
const BEHIND = 60000;  // placar do vídeo atrás do site: replay ("melhores momentos"); só é erro se durar mais do que isto
const INST = crypto.randomBytes(6).toString('hex'); // esta instância do servidor

// leitura confirmada (r = { h, a }, já com os lados certos) contra o placar do site
function decide(srv, r) {
  if (srv.over) return { do: 'over' };
  if (r.h === srv.a && r.a === srv.b) return { do: 'ok' };
  // o mapa acabou de terminar: o site já está no 0-0 do seguinte e o vídeo ainda mostra o resultado
  if (srv.a === 0 && srv.b === 0 && srv.last && r.h === srv.last.h && r.a === srv.last.a) return { do: 'ok' };
  if (r.h === srv.a + 1 && r.a === srv.b) return { do: 'round', side: 'h' };
  if (r.a === srv.b + 1 && r.h === srv.a) return { do: 'round', side: 'a' };
  // placar de um momento anterior do mapa (replay / melhores momentos mostram o HUD antigo)
  if (r.h <= srv.a && r.a <= srv.b) return { do: 'behind' };
  return { do: 'anomaly' };
}

// imagem reduzida (PNG) para o painel ver o que o bot está a ver
function png(f, W, H2) {
  const sx = f.w / W, sy = f.h / H2, raw = Buffer.alloc((W * 3 + 1) * H2);
  for (let y = 0; y < H2; y++) {
    const row = y * (W * 3 + 1), fy = Math.floor(y * sy);
    for (let x = 0; x < W; x++) { const s = (fy * f.w + Math.floor(x * sx)) * 3; f.rgb.copy(raw, row + 1 + x * 3, s, s + 3); }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type), data]);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H2, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 3 })), chunk('IEND', Buffer.alloc(0))]);
}
// vídeo gravado com "?t=1h50m0s" no link: começa nesse ponto (útil para testar com partidas antigas)
function vodOffset(st) {
  if (st.type !== 'twitch-video') return 0;
  let t = ''; try { t = new URL(st.url).searchParams.get('t') || ''; } catch { /* sem t */ }
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

module.exports = function streamBot(routes, { requireAdmin, fail, manualEvents, variant, now }) {
  const bots = new Map();
  let ocrP = null;
  const ocr = () => (ocrP ||= H.createOcr().catch((e) => { ocrP = null; throw e; }));
  // rotas do painel chamadas por dentro, em nome de quem ligou o bot
  const call = (admin, key, body, query = '') => routes[key]({ asAdmin: admin, body: body || {}, req: { url: '/x' + query, headers: {} }, res: null, user: null });
  const note = (bot, msg, kind = '') => { bot.log.unshift({ t: now(), msg, kind }); bot.log.length = Math.min(bot.log.length, 40); };
  const home = (bot) => bot.ev?.home || 'casa', away = (bot) => bot.ev?.away || 'fora';

  /* ---------- placar do site ---------- */
  function setState(bot, st) {
    const last = st.history[st.history.length - 1] || null;
    bot.srv = { a: st.a, b: st.b, over: !!st.over, last, map: st.curMap, mh: st.mh, ma: st.ma };
    // mapa novo: as equipas podem trocar de lado no ecrã -> procura o HUD e os nomes outra vez
    if (bot.mapN != null && st.history.length !== bot.mapN && !st.over) {
      bot.boxes = null; bot.sidesManual = false; bot.seq = [];
      bot.mapBreak = now();
      note(bot, `Fim do mapa: intervalo até ao mapa ${st.curMap} (mercados continuam abertos sem placar no ecrã).`);
    }
    // bot ligado num intervalo ou antes do 1º round (site em 0-0): a mesma coisa
    if (bot.mapN == null && !st.over && st.a === 0 && st.b === 0) bot.mapBreak = now();
    bot.mapN = st.history.length;
  }
  async function sync(bot) {
    const d = await call(bot.admin, 'GET /api/admin/catalog/event', null, '?id=' + encodeURIComponent(bot.id));
    if (!d.live) throw new Error('O evento já não tem regras do jogo.');
    bot.ev = { home: d.event.home, away: d.event.away, state: d.event.state };
    bot.markets = d.markets || [];
    bot.synced = now();
    setState(bot, d.live.state);
    // encerrado ou arquivado à mão no painel: o bot desliga-se
    if ((d.event.state === 'post' || d.event.archived) && !bot.done) {
      bot.done = true;
      note(bot, d.event.archived ? 'Jogo arquivado no painel.' : 'Jogo encerrado no painel.', 'warn');
      if (bot.opts.autoSettle && d.live.state.over) scheduleSettle(bot, 5000); else await finish(bot);
    }
  }
  async function suspend(bot, why, kind = 'anomaly') {
    bot.why = why;
    if (bot.susp) return;
    bot.suspKind = kind;
    await sync(bot);
    const ids = bot.markets.filter((m) => m.status === 'open').map((m) => m.id);
    if (ids.length) await call(bot.admin, 'POST /api/admin/catalog/market/status', { evId: bot.id, ids, status: 'suspended', bot: true });
    bot.susp = ids;
    note(bot, `Mercados suspensos: ${why}`, 'bad');
  }
  async function reopen(bot) {
    const ids = bot.susp;
    bot.susp = null; bot.why = ''; bot.suspKind = null;
    if (ids?.length) await call(bot.admin, 'POST /api/admin/catalog/market/status', { evId: bot.id, ids, status: 'open', bot: true });
    note(bot, 'Leitura de volta ao normal: mercados reabertos.', 'ok');
  }
  function scheduleSettle(bot, ms = SETTLE) {
    clearTimeout(bot.settleT);
    if (!bot.opts.autoSettle) return;
    bot.settleAt = now() + ms;
    bot.settleT = setTimeout(() => settle(bot).catch((e) => note(bot, 'Liquidação: ' + e.message, 'bad')), ms);
  }
  async function settle(bot) {
    bot.settleAt = null;
    if (bot.susp) { note(bot, 'Liquidação adiada: há mercados suspensos por leitura duvidosa.', 'warn'); return scheduleSettle(bot); }
    const r = await call(bot.admin, 'POST /api/admin/catalog/event/settle-all', { id: bot.id, bot: true });
    if (r.settled) { bot.stats.settled += r.settled; note(bot, `Liquidados pelo placar (apostas pagas): ${r.markets.join(', ')}`, 'ok'); }
    if (bot.done) await finish(bot);
  }
  // partida terminada: desliga o bot (fica o registo)
  async function finish(bot) {
    if (bot.stopped) return;
    kill(bot);
    bot.status = 'partida terminada';
    await call(bot.admin, 'POST /api/admin/catalog/event/bot', { id: bot.id, on: false }).catch(() => {});
    note(bot, 'Partida terminada e liquidada. Bot desligado.', 'ok');
  }

  async function apply(bot, r) {
    let act = decide(bot.srv, r);
    if (act.do !== 'ok') { await sync(bot); act = decide(bot.srv, r); } // o placar pode ter mudado no painel
    bot.scoreOk = act.do === 'ok';
    if (act.do !== 'behind') bot.behindSince = null;
    if (act.do === 'behind') {
      bot.behindSince ||= now();
      bot.replay = true;
      if (now() - bot.behindSince > BEHIND) await suspend(bot, `o vídeo mostra ${r.h}-${r.a} há mais de 1 minuto mas o placar no site é ${bot.srv.a}-${bot.srv.b} (corrija com desfazer, ou "Usar o placar do vídeo")`);
      return;
    }
    bot.replay = false;
    if (act.do === 'over') {
      if (!bot.done) { bot.done = true; note(bot, 'Partida terminada no site.', 'ok'); if (bot.opts.autoSettle) scheduleSettle(bot, 5000); else await finish(bot); }
      return;
    }
    if (act.do === 'ok') {
      if (bot.mapBreak && r.h === bot.srv.a && r.a === bot.srv.b) { bot.mapBreak = null; note(bot, `Placar do mapa ${bot.srv.map} no ecrã: o intervalo acabou.`); }
      if (bot.susp && bot.sidesOk) await reopen(bot);
      return;
    }
    if (act.do === 'round') {
      if (!bot.sidesOk) return suspend(bot, 'round no vídeo mas os lados das equipas ainda não estão confirmados');
      const res = await call(bot.admin, 'POST /api/admin/catalog/event/round', { id: bot.id, side: act.side, bot: true });
      bot.stats.rounds++;
      bot.ev.state = 'in';
      note(bot, `+1 round ${act.side === 'h' ? home(bot) : away(bot)} (${r.h}-${r.a})`, 'ok');
      // round novo: os vivos do anterior já não contam; espera ver todos vivos outra vez
      bot.aliveArmed = false; bot.aliveSent = null; bot.aliveSeq = []; bot.aliveLast = null;
      setState(bot, res.live.state);
      if (bot.susp && bot.sidesOk) await reopen(bot);
      if (res.live.state.over) { bot.done = true; note(bot, 'Último round: partida terminada no site.', 'ok'); }
      if (bot.opts.autoSettle) scheduleSettle(bot, bot.done ? 5000 : SETTLE); else if (bot.done) await finish(bot);
      return;
    }
    await suspend(bot, `o vídeo mostra ${r.h}-${r.a} mas o placar no site é ${bot.srv.a}-${bot.srv.b} (corrija com +1 / desfazer, ou "Usar o placar do vídeo")`);
  }
  /* Placar fora do ecrã com o jogo ao vivo. Pausa (etiqueta "PAUSA TÉCNICA", "TIMEOUT"...) ou intervalo entre mapas:
     o jogo está parado, os mercados ficam abertos. Anúncio da Twitch ou sem explicação: suspende ao fim de LOST
     (o jogo pode estar a decorrer sem o bot o ver). */
  async function lost(bot, f, o) {
    if (bot.ev?.state !== 'in' || bot.srv?.over) return;
    if (f && o && now() - (bot.breakCheck || 0) > 5000) {
      bot.breakCheck = now();
      const t = await H.breakTag(f, o);
      if (t) {
        if (t.kind !== bot.breakKind || now() - (bot.breakSeen || 0) > PAUSE_KEEP) note(bot, t.kind === 'ads' ? 'Anúncio da Twitch no vídeo.' : `${t.kind === 'pause' ? 'Pausa' : 'Intervalo'} no ecrã ("${t.word}"): mercados continuam abertos.`);
        bot.breakKind = t.kind; bot.breakSeen = now();
      }
    }
    const pause = bot.breakSeen && now() - bot.breakSeen < PAUSE_KEEP && bot.breakKind !== 'ads';
    const interval = bot.mapBreak && now() - bot.mapBreak < BREAK_MAX;
    if (pause || interval) {
      bot.status = interval ? 'intervalo entre mapas: mercados abertos' : bot.breakKind === 'break' ? 'intervalo: mercados abertos' : 'pausa: mercados abertos';
      bot.lastGood = now(); // não é sinal perdido
      if (bot.susp && bot.suspKind === 'lost') await reopen(bot);
      return;
    }
    if (now() - bot.lastGood > LOST) await suspend(bot, 'o placar não aparece no vídeo e não há sinal de pausa nem de intervalo (câmaras, anúncio ou sinal perdido)', 'lost');
  }
  // vivos: pelos números escritos no HUD ("5 VS 3", R6) ou pelos cartões dos jogadores (CS2 e outros)
  async function aliveStep(bot, f, o) {
    if (!bot.boxes.AL && bot.bars) {
      const x = H.countBars(f, bot.bars.L, bot.bars.colL), y = H.countBars(f, bot.bars.R, bot.bars.colR);
      return aliveApply(bot, bot.swap ? { h: y, a: x } : { h: x, a: y });
    }
    const x = await H.readBox(f, bot.boxes.AL, o), y = await H.readBox(f, bot.boxes.AR, o);
    const r = x == null || y == null || x > SLOTS || y > SLOTS ? null : bot.swap ? { h: y, a: x } : { h: x, a: y };
    if (!r) {
      bot.aliveRead = null;
      bot.aliveSeq = [];
      // a linha dos vivos muda de altura no ecrã: ao fim de umas falhas procura-a outra vez
      if (++bot.aliveMiss >= 4 && now() - bot.aliveDetect > 2000) {
        bot.aliveDetect = now(); bot.aliveMiss = 0;
        const d = await H.detect(f, o, bot.srv ? { a: bot.srv.a, b: bot.srv.b } : null);
        if (d?.alive && Math.abs(d.score.L.x - bot.boxes.L.x) < 0.02 && Math.abs(d.score.L.y - bot.boxes.L.y) < 0.02) { bot.boxes.AL = d.alive.L; bot.boxes.AR = d.alive.R; }
      }
      return;
    }
    bot.aliveMiss = 0;
    return aliveApply(bot, r);
  }
  async function aliveApply(bot, r) {
    bot.aliveRead = r;
    // só vale com o placar desta mesma imagem igual ao do site (nunca durante um replay)
    const cur = bot.read, sv = bot.srv;
    if (!cur || !sv || cur.h !== sv.a || cur.a !== sv.b) { bot.aliveSeq = []; return; }
    // dentro de um round os vivos só descem: uma leitura que sobe é engano (só o 5v5 de um round novo recomeça)
    const full0 = r.h === SLOTS && r.a === SLOTS, last = bot.aliveLast;
    if (last && !full0 && (r.h > last.h || r.a > last.a)) return;
    bot.aliveSeq.push(r);
    if (bot.aliveSeq.length > 2) bot.aliveSeq.shift();
    if (bot.aliveSeq.length < 2 || bot.aliveSeq.some((z) => z.h !== r.h || z.a !== r.a)) return;
    const full = r.h === SLOTS && r.a === SLOTS;
    if (full) bot.aliveArmed = true; // começou um round (todos vivos): a partir daqui as mortes contam
    if (bot.aliveArmed) bot.aliveLast = r;
    if (!bot.aliveArmed || !bot.scoreOk || bot.susp || !bot.sidesOk || bot.ev?.state !== 'in') return;
    const key = full ? null : `${r.h}v${r.a}`;
    if (key === bot.aliveSent) return;
    await call(bot.admin, 'POST /api/admin/catalog/event/alive', full ? { id: bot.id, h: null } : { id: bot.id, h: r.h, a: r.a });
    bot.aliveSent = key;
    if (!full) note(bot, `Dentro do round: ${r.h} v ${r.a}`);
  }

  /* ---------- cada imagem ---------- */
  async function step(bot, f) {
    bot.frame = f; bot.frameAt = now();
    const o = await ocr();
    // o placar e o estado também mudam no painel (cliques, jogo encerrado): atualiza a cada 10 s
    if (!bot.srv || now() - (bot.synced || 0) > 10000) await sync(bot);
    if (bot.done) return;
    // replay / melhores momentos: o HUD é de outro momento -> ignora a imagem toda durante uns segundos
    if (now() - (bot.replayCheck || 0) > 1500) {
      bot.replayCheck = now();
      const tag = await H.replayTag(f, o);
      if (tag) {
        if (!(now() < (bot.replayUntil || 0))) note(bot, `Replay no ecrã ("${tag}"): placar e vivos ignorados até acabar.`);
        bot.replayUntil = now() + 10000;
      }
    }
    if (now() < (bot.replayUntil || 0)) {
      bot.status = 'replay no ecrã: a ignorar'; bot.seq = []; bot.aliveSeq = []; bot.read = null; bot.aliveRead = null;
      bot.lastGood = now(); // um replay não é sinal perdido
      return;
    }
    // encontrar o HUD: no início, num mapa novo ou quando deixa de o ler
    if (!bot.boxes || (bot.missing >= 6 && now() - bot.lastDetect > 3000)) {
      bot.lastDetect = now();
      let d = await H.detect(f, o, bot.srv ? { a: bot.srv.a, b: bot.srv.b } : null);
      // o placar fica sempre no mesmo sítio: com ele escondido (fim de round) o par de vivos ("0 VS 1") não pode passar por placar.
      // Só aceita outro sítio se ficar 2 min sem conseguir ler nada (a transmissão mudou de layout)
      const near = (x, y) => Math.abs(x.x - y.x) < 0.03 && Math.abs(x.y - y.y) < 0.03;
      if (d && bot.anchor && !near(d.score.L, bot.anchor.L) && now() - bot.lastGood < 120000) d = null;
      if (d) {
        const had = !!bot.boxes;
        bot.anchor = { L: d.score.L };
        bot.boxes = { L: d.score.L, R: d.score.R, AL: d.alive?.L || null, AR: d.alive?.R || null };
        bot.names = d.names; bot.missing = 0;
        if (!bot.sidesManual) {
          const s = H.sides(d.names, home(bot), away(bot));
          if (s.conf >= 0.12) {
            if (bot.swap !== s.swap || !bot.sidesOk) note(bot, `Lados pelos nomes no ecrã ("${d.names.L}" | "${d.names.R}"): ${s.swap ? away(bot) : home(bot)} à esquerda.`, 'ok');
            bot.swap = s.swap; bot.sidesOk = true;
          } else if (!bot.sidesOk) note(bot, `Não percebi os nomes no ecrã ("${d.names.L}" | "${d.names.R}"): confirme os lados no painel.`, 'warn');
        }
        if (!had) note(bot, `Placar encontrado no ecrã${d.alive ? ', com os jogadores vivos' : ''}.`, 'ok');
      }
    }
    if (!bot.boxes) { bot.status = 'à procura do placar no ecrã'; bot.read = null; return lost(bot, f, o); }
    const L = await H.readBox(f, bot.boxes.L, o), R = await H.readBox(f, bot.boxes.R, o);
    if (L == null || R == null || L > 40 || R > 40) {
      bot.missing++; bot.seq = []; bot.read = null;
      bot.status = 'placar fora do ecrã';
      return lost(bot, f, o);
    }
    bot.missing = 0; bot.lastGood = now();
    const r = bot.swap ? { h: R, a: L } : { h: L, a: R };
    bot.read = r;
    bot.seq.push(r);
    if (bot.seq.length > CONFIRM) bot.seq.shift();
    if (bot.seq.length === CONFIRM && bot.seq.every((x) => x.h === r.h && x.a === r.a)) await apply(bot, r);
    bot.status = bot.done ? 'partida terminada' : bot.susp ? 'mercados suspensos' : !bot.sidesOk ? 'lados por confirmar' : bot.replay ? 'replay no vídeo (placar antigo): a ignorar' : 'a seguir o placar';
    if (bot.opts.alive && !bot.done) {
      // sem "5 VS 3" escrito: procura os cartões dos jogadores (fixa-os quando vê os 5 de cada lado com vida);
      // confirma-os de novo a cada início de round (o layout pode mudar, ex.: cartões com fotos noutros momentos)
      if (!bot.boxes.AL && now() - (bot.barsTry || 0) > (bot.bars ? 8000 : 2000)) {
        bot.barsTry = now();
        const b = H.findBars(f);
        const moved = (x, y) => x.L.some((s, i) => Math.abs(s.y - y.L[i].y) > 0.01 || Math.abs(s.x - y.L[i].x) > 0.01);
        if (b && !bot.bars) note(bot, 'Cartões dos jogadores encontrados: os vivos passam a ser lidos por eles.', 'ok');
        else if (b && moved(b, bot.bars)) note(bot, 'Os cartões dos jogadores mudaram de sítio: posição atualizada.');
        if (b) bot.bars = b;
      }
      if ((bot.boxes.AL && bot.boxes.AR) || bot.bars) await aliveStep(bot, f, o);
      else if (now() - bot.aliveDetect > 5000) { bot.aliveDetect = now(); const d = await H.detect(f, o, bot.srv ? { a: bot.srv.a, b: bot.srv.b } : null); if (d?.alive) { bot.boxes.AL = d.alive.L; bot.boxes.AR = d.alive.R; } }
    }
  }
  // processa a imagem mais recente (se o OCR atrasar, as do meio são saltadas)
  async function pump(bot) {
    if (bot.busy) return;
    bot.busy = true;
    while (bot.pending && !bot.stopped) {
      const rgb = bot.pending; bot.pending = null;
      try { await step(bot, { w: FW, h: FH, rgb }); } catch (e) { note(bot, 'Erro: ' + e.message, 'bad'); }
    }
    bot.busy = false;
  }

  /* ---------- vídeo ---------- */
  async function open(bot) {
    if (bot.stopped || bot.ff) return;
    const d = manualEvents.get(bot.id);
    if (!d?.stream) { bot.status = 'sem link de transmissão'; note(bot, 'O jogo não tem link de transmissão.', 'bad'); return retry(bot, 30000); }
    let v;
    try { v = await variant(d.stream); } catch (e) { bot.status = 'transmissão indisponível'; note(bot, 'Transmissão: ' + e.message, 'warn'); await lost(bot).catch(() => {}); return retry(bot, 20000); }
    if (bot.stopped) return;
    const args = ['-loglevel', 'error'], off = vodOffset(d.stream);
    if (d.stream.type === 'twitch-video') args.push('-re'); // vídeo gravado: ao ritmo real, como se fosse ao vivo
    if (off) args.push('-ss', String(off));
    args.push('-i', v.url, '-an', '-vf', `fps=${FPS},scale=${FW}:${FH}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1');
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    bot.ff = ff; bot.quality = v.quality; bot.status = 'à procura do placar no ecrã';
    const size = FW * FH * 3;
    let buf = Buffer.allocUnsafe(size), have = 0, err = '';
    ff.stdout.on('data', (chunk) => {
      for (let o = 0; o < chunk.length;) {
        const n = Math.min(size - have, chunk.length - o);
        chunk.copy(buf, have, o, o + n); have += n; o += n;
        if (have === size) { bot.pending = buf; buf = Buffer.allocUnsafe(size); have = 0; pump(bot); }
      }
    });
    ff.stderr.on('data', (c) => { err = (err + c).slice(-400); });
    ff.on('error', (e) => note(bot, e.code === 'ENOENT' ? 'O ffmpeg não está instalado no servidor.' : 'ffmpeg: ' + e.message, 'bad'));
    ff.on('close', () => {
      if (bot.ff !== ff) return;
      bot.ff = null;
      if (bot.stopped) return;
      note(bot, `A transmissão parou${err.trim() ? ' (' + err.trim().split('\n').pop().slice(0, 120) + ')' : ''}. A abrir outra vez...`, 'warn');
      retry(bot, 5000);
    });
    note(bot, `Transmissão aberta (${v.quality}).`, 'ok');
  }
  function retry(bot, ms) { clearTimeout(bot.retryT); if (!bot.stopped) bot.retryT = setTimeout(() => open(bot).catch((e) => note(bot, e.message, 'bad')), ms); }
  function kill(bot) {
    bot.stopped = true;
    clearTimeout(bot.retryT); clearInterval(bot.leaseT);
    if (bot.ff) { const ff = bot.ff; bot.ff = null; ff.kill('SIGKILL'); }
  }
  async function lease(bot) {
    try { await call(bot.admin, 'POST /api/admin/catalog/event/bot', { id: bot.id, lease: true, inst: INST }); }
    catch (e) { note(bot, 'Bot parado aqui: ' + e.message, 'warn'); kill(bot); bot.status = 'a correr noutra instância'; bot.resumable = true; throw e; }
  }

  function start(id, by, opts) {
    const cur = bots.get(id);
    if (cur && !cur.stopped) return cur;
    const bot = {
      id, admin: { id: by.id, email: String(by.email).startsWith('bot:') ? by.email : 'bot:' + by.email }, by: by.email,
      opts: { autoSettle: opts.autoSettle !== false, alive: opts.alive !== false }, status: 'a ligar', log: [], seq: [], aliveSeq: [],
      stats: { rounds: 0, settled: 0 }, boxes: null, swap: false, sidesOk: false, sidesManual: false, names: null, read: null, aliveRead: null,
      lastGood: now(), lastDetect: 0, missing: 0, susp: null, why: '', scoreOk: false, aliveArmed: false, aliveSent: null,
      settleT: null, settleAt: null, frame: null, frameAt: 0, busy: false, pending: null, ff: null, stopped: false, done: false, mapN: null, quality: null,
      behindSince: null, replay: false, aliveMiss: 0, aliveDetect: 0, anchor: null, bars: null, barsTry: 0, aliveLast: null,
      mapBreak: null, breakKind: null, breakSeen: 0, breakCheck: 0, suspKind: null,
    };
    bots.set(id, bot);
    note(bot, 'Bot ligado no servidor.', 'ok');
    lease(bot)
      .then(() => { bot.leaseT = setInterval(() => lease(bot).catch(() => {}), 15000); return sync(bot); })
      .then(() => open(bot))
      .catch((e) => note(bot, e.message, 'bad'));
    return bot;
  }
  function stop(bot) {
    kill(bot);
    clearTimeout(bot.settleT); bot.settleAt = null;
    bot.status = 'parado';
    note(bot, bot.susp ? 'Bot desligado. Os mercados que ele suspendeu continuam suspensos: reabra-os no painel.' : 'Bot desligado.');
  }
  function status(id) {
    const b = bots.get(id);
    if (!b) return { on: false };
    return {
      on: !b.stopped, status: b.status, quality: b.quality, interval: !!(b.mapBreak && now() - b.mapBreak < BREAK_MAX), read: b.read, alive: b.aliveRead, srv: b.srv, swap: b.swap, sidesOk: b.sidesOk,
      sidesManual: b.sidesManual, names: b.names, susp: !!b.susp, why: b.why, stats: b.stats, opts: b.opts, by: b.by,
      settleIn: b.settleAt ? Math.max(0, Math.round((b.settleAt - now()) / 1000)) : null, boxes: b.boxes, bars: b.bars ? { L: b.bars.L, R: b.bars.R } : null, frameAt: b.frameAt,
      home: home(b), away: away(b), log: b.log.slice(0, 15),
    };
  }

  // retoma os bots ligados (reinício do servidor) e larga os que foram desligados noutro sítio
  setInterval(() => {
    for (const d of manualEvents.values()) {
      const cfg = d.live?.bot, b = bots.get(d.id);
      if (cfg?.on && !d.archived && d.state !== 'post' && (!b || (b.stopped && b.resumable))) {
        if (cfg.lease && cfg.lease.inst !== INST && cfg.lease.until > now()) continue; // está a correr noutra instância
        if (cfg.by) start(d.id, cfg.by, cfg);
      } else if (b && !b.stopped && !cfg?.on && !b.done) { stop(b); note(b, 'Desligado no painel.'); }
    }
  }, 15000).unref();

  const qid = (ctx) => new URL(ctx.req.url, 'http://x').searchParams.get('id') || '';
  const need = (id) => { if (!manualEvents.has(id)) fail(404, 'Evento não encontrado.'); };
  Object.assign(routes, {
    'POST /api/admin/bot/start': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const id = String(ctx.body.id || ''); need(id);
      const opts = { autoSettle: ctx.body.autoSettle !== false, alive: ctx.body.alive !== false };
      await call(admin, 'POST /api/admin/catalog/event/bot', { id, on: true, ...opts });
      const b = bots.get(id);
      if (b && !b.stopped) b.opts = opts; else start(id, admin, opts);
      return status(id);
    },
    'POST /api/admin/bot/stop': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const id = String(ctx.body.id || ''); need(id);
      await call(admin, 'POST /api/admin/catalog/event/bot', { id, on: false });
      const b = bots.get(id);
      if (b && !b.stopped) stop(b);
      return status(id);
    },
    // lados à mão (quando não consegue ler os nomes, ou para corrigir)
    'POST /api/admin/bot/sides': async (ctx) => {
      await requireAdmin(ctx);
      const b = bots.get(String(ctx.body.id || ''));
      if (!b || b.stopped) fail(409, 'O bot não está ligado.');
      b.swap = !!ctx.body.swap; b.sidesOk = true; b.sidesManual = true; b.seq = [];
      note(b, `Lados confirmados no painel: ${b.swap ? away(b) : home(b)} à esquerda.`, 'ok');
      return status(b.id);
    },
    // o site passa a ter o placar que o vídeo mostra (bot ligado a meio de um mapa)
    'POST /api/admin/bot/sync': async (ctx) => {
      const admin = await requireAdmin(ctx);
      const id = String(ctx.body.id || ''), b = bots.get(id), d = manualEvents.get(id);
      if (!b || b.stopped || !d) fail(409, 'O bot não está ligado.');
      if (!b.read || !b.sidesOk) fail(409, 'O bot ainda não está a ler o placar (ou os lados não estão confirmados).');
      await call(admin, 'POST /api/admin/catalog/event', { id, league: d.league, home: d.home, away: d.away, startsAt: d.startsAt, state: 'in', scoreH: b.read.h, scoreA: b.read.a, mapsH: b.srv?.mh || 0, mapsA: b.srv?.ma || 0, clock: d.clock || '' });
      await sync(b);
      b.ev.state = 'in'; b.seq = [];
      note(b, `Placar do site acertado pelo vídeo: ${b.read.h}-${b.read.a}.`, 'ok');
      if (b.susp) await reopen(b);
      return status(id);
    },
    'GET /api/admin/bot/status': async (ctx) => { await requireAdmin(ctx); const id = qid(ctx); need(id); return status(id); },
    'GET /api/admin/bot/frame': async (ctx) => {
      await requireAdmin(ctx);
      const b = bots.get(qid(ctx));
      if (!b?.frame) fail(404, 'Ainda sem imagem.');
      const img = png(b.frame, 640, 360);
      ctx.res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length, 'Cache-Control': 'no-store' });
      ctx.res.end(img);
    },
  });
  return { decide, status };
};
module.exports.decide = decide;
