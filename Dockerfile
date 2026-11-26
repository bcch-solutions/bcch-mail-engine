# ============================================================
# BCCH MAIL ENGINE — Dockerfile multi-stage
# ============================================================
FROM node:20-bookworm-slim AS builder
WORKDIR /engine
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /engine
ENV NODE_ENV=production
COPY --from=builder /engine/node_modules ./node_modules
COPY --from=builder /engine/dist ./dist
COPY --from=builder /engine/package.json ./
# Certificados CA para TLS IMAP/SMTP
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
EXPOSE 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8443/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]