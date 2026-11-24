# ---- Etapa 1: instala dependencias (better-sqlite3 es nativo; si no hay binario precompilado, compila) ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Etapa 2: imagen final ----
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY tools ./tools
RUN mkdir -p /app/data /app/logs && chown -R node:node /app
USER node
CMD ["node", "src/index.js"]
