'use strict';
/* Transmissão da partida para o bot (painel da equipa).
   O browser não deixa ler os pixels de um player de outro site (Twitch, YouTube...), por isso o servidor
   descobre o vídeo HLS do link guardado no evento e repassa a playlist e os segmentos pelo próprio site:
   o bot toca-o num <video> do painel (hls.js) e consegue ler o placar.
   Só para admins e só para os servidores de vídeo destes sites (não serve como proxy para outros endereços). */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TWITCH_CLIENT = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // cliente público do player web da Twitch
const HOSTS = ['ttvnw.net', 'twitch.tv', 'cloudfront.net', 'live-video.net', 'googlevideo.com', 'youtube.com', 'kick.com'];
const allowed = (u) => {
  try { const x = new URL(u); return x.protocol === 'https:' && HOSTS.some((h) => x.hostname === h || x.hostname.endsWith('.' + h)); } catch { return false; }
};

module.exports = function streamRoutes(routes, { requireAdmin, fail, manualEvents }) {
  // redirecionamentos seguidos à mão: cada salto tem de ficar nos domínios permitidos
  const get = async (url, opts = {}) => {
    for (let hop = 0; hop < 4; hop++) {
      if (!allowed(url)) fail(400, 'Endereço de vídeo não permitido.');
      const r = await fetch(url, { ...opts, redirect: 'manual', headers: { 'user-agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(15000) });
      const loc = r.status >= 300 && r.status < 400 && r.headers.get('location');
      if (!loc) { Object.defineProperty(r, 'finalUrl', { value: url }); return r; }
      url = new URL(loc, url).href;
    }
    fail(502, 'Demasiados redirecionamentos do site de vídeo.');
  };

  async function twitchToken(login, vod) {
    const query = `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
      streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature }
      videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature } }`;
    const r = await get('https://gql.twitch.tv/gql', {
      method: 'POST', headers: { 'client-id': TWITCH_CLIENT, 'content-type': 'application/json' },
      body: JSON.stringify({ operationName: 'PlaybackAccessToken_Template', query, variables: { isLive: !vod, login: vod ? '' : login, isVod: !!vod, vodID: vod ? login : '', playerType: 'site' } }),
    });
    const d = await r.json().catch(() => null);
    const t = vod ? d?.data?.videoPlaybackAccessToken : d?.data?.streamPlaybackAccessToken;
    if (!t) fail(502, 'A Twitch não devolveu a transmissão (canal ou vídeo inexistente?).');
    return t;
  }

  // link do evento -> playlist HLS principal
  async function resolve(st) {
    const rnd = Math.floor(Math.random() * 1e7);
    if (st.type === 'twitch' || st.type === 'twitch-video') {
      const vod = st.type === 'twitch-video', t = await twitchToken(st.id, vod);
      const q = new URLSearchParams({ sig: t.signature, token: t.value, allow_source: 'true', allow_audio_only: 'true', p: String(rnd), player: 'twitchweb', playlist_include_framerate: 'true' });
      return vod ? `https://usher.ttvnw.net/vod/${encodeURIComponent(st.id)}.m3u8?${q}` : `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(st.id.toLowerCase())}.m3u8?${q}`;
    }
    if (st.type === 'youtube' || st.type === 'youtube-channel') {
      const page = st.type === 'youtube' ? `https://www.youtube.com/watch?v=${encodeURIComponent(st.id)}` : `https://www.youtube.com/channel/${encodeURIComponent(st.id)}/live`;
      const html = await (await get(page, { headers: { 'accept-language': 'en-US,en;q=0.9' } })).text();
      const m = html.match(/"hlsManifestUrl":"([^"]+)"/);
      // o YouTube já não põe o vídeo na página (só o player dele o consegue tocar)
      if (!m) fail(409, 'O servidor não consegue abrir vídeos do YouTube. Use o link da Twitch ou da Kick da mesma transmissão (o YouTube continua a servir para mostrar o vídeo no site).');
      return m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    }
    if (st.type === 'kick') {
      const d = await (await get(`https://kick.com/api/v2/channels/${encodeURIComponent(st.id)}`, { headers: { accept: 'application/json' } })).json().catch(() => null);
      if (!d?.playback_url) fail(409, d ? 'Este canal da Kick não está ao vivo.' : 'A Kick não respondeu (pode estar a bloquear o servidor).');
      return d.playback_url;
    }
    fail(400, 'Tipo de transmissão não suportado.');
  }

  const absolute = (uri, base) => new URL(uri, base).href;
  const plUrl = (u) => `/api/admin/stream/pl?u=${encodeURIComponent(u)}`;
  const segUrl = (u) => `/api/admin/stream/seg?u=${encodeURIComponent(u)}`;
  // escolhe a variante: a maior até 720p (o placar lê-se bem e gasta menos banda), e entre iguais a de menos fps
  function pickVariant(master, base) {
    const lines = master.split(/\r?\n/), vars = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const res = lines[i].match(/RESOLUTION=(\d+)x(\d+)/), fps = Number(lines[i].match(/FRAME-RATE=([\d.]+)/)?.[1] || 30);
      let j = i + 1; while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      if (res && lines[j]) vars.push({ h: Number(res[2]), fps, url: absolute(lines[j], base) });
    }
    if (!vars.length) return null;
    const ok = vars.filter((v) => v.h <= 720);
    const list = ok.length ? ok : vars;
    list.sort((a, b) => b.h - a.h || a.fps - b.fps);
    return list[0];
  }
  // reescreve a playlist: todos os endereços passam pelo site
  function rewrite(text, base) {
    return text.split(/\r?\n/).map((l) => {
      if (!l) return l;
      if (l.startsWith('#')) return l.replace(/URI="([^"]+)"/g, (_, u) => `URI="${segUrl(absolute(u, base))}"`);
      const abs = absolute(l, base);
      return /\.m3u8$/i.test(new URL(abs).pathname) ? plUrl(abs) : segUrl(abs);
    }).join('\n');
  }

  // endereço direto do vídeo (variante até 720p) para o bot do servidor ler com o ffmpeg
  async function variant(st) {
    const master = await resolve(st), r = await get(master);
    if (!r.ok) fail(409, 'A transmissão não está disponível agora (canal offline?).');
    const text = await r.text();
    const v = text.includes('#EXT-X-STREAM-INF') ? pickVariant(text, r.finalUrl || master) : null;
    return { url: v ? v.url : r.finalUrl || master, quality: v ? `${v.h}p` : 'original' };
  }

  Object.assign(routes, {
    // abre a transmissão do evento: devolve a playlist (da variante escolhida) já servida pelo site
    'GET /api/admin/stream/play': async (ctx) => {
      await requireAdmin(ctx);
      const id = new URL(ctx.req.url, 'http://x').searchParams.get('id') || '';
      const d = manualEvents.get(id);
      if (!d) fail(404, 'Evento não encontrado.');
      if (!d.stream) fail(400, 'Este jogo não tem link de transmissão. Preencha o campo "Transmissão" no evento.');
      const master = await resolve(d.stream);
      const r = await get(master);
      if (!r.ok) fail(r.status === 404 || r.status === 403 ? 409 : 502, r.status === 404 || r.status === 403 ? 'A transmissão não está disponível agora (canal offline?).' : 'O site de vídeo não respondeu.');
      const text = await r.text();
      if (!text.startsWith('#EXTM3U')) fail(502, 'Resposta inesperada do site de vídeo.');
      const v = text.includes('#EXT-X-STREAM-INF') ? pickVariant(text, r.finalUrl || master) : null;
      return { src: plUrl(v ? v.url : r.finalUrl || master), quality: v ? `${v.h}p${v.fps > 31 ? Math.round(v.fps) : ''}` : 'original', type: d.stream.type, url: d.stream.url };
    },
    'GET /api/admin/stream/pl': async (ctx) => {
      await requireAdmin(ctx);
      const u = new URL(ctx.req.url, 'http://x').searchParams.get('u') || '';
      const r = await get(u);
      if (!r.ok) fail(r.status === 404 ? 404 : 502, 'Playlist indisponível.');
      const body = rewrite(await r.text(), r.finalUrl || u);
      ctx.res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
      ctx.res.end(body);
    },
    'GET /api/admin/stream/seg': async (ctx) => {
      await requireAdmin(ctx);
      const u = new URL(ctx.req.url, 'http://x').searchParams.get('u') || '';
      const r = await get(u);
      if (!r.ok) fail(r.status === 404 ? 404 : 502, 'Segmento indisponível.');
      const buf = Buffer.from(await r.arrayBuffer());
      ctx.res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'video/mp2t', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      ctx.res.end(buf);
    },
  });
  return { variant };
};
