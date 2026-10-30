# JRS eSign server. Build: docker build -t jrs-esign .   (docker-compose.yml runs it behind Caddy for HTTPS)
FROM node:24-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    BACKUP_DIR=/app/backups

WORKDIR /app
# LibreOffice turns uploaded Word, Excel and PowerPoint files into PDF (images need nothing extra).
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress fonts-liberation fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public

# Data and backups live in volumes owned by the unprivileged "node" user.
RUN mkdir -p /app/data /app/backups && chown -R node:node /app/data /app/backups
USER node
VOLUME ["/app/data", "/app/backups"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
