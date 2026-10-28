# Imagem do TUGAS para o Google Cloud Run
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# ffmpeg: o bot da transmissão (streambot.js) lê o vídeo do link da partida
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY . .
# o Cloud Run define a variável PORT (8080)
EXPOSE 8080
USER node
CMD ["node", "server.js"]
