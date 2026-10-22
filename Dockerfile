# Imagem do TUGAS para o Google Cloud Run
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY . .
# o Cloud Run define a variável PORT (8080)
EXPOSE 8080
USER node
CMD ["node", "server.js"]
