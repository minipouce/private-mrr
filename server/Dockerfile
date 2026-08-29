# --- Build stage ------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 is a native module: a toolchain is needed to build it, but it
# has no business being in the final image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune development dependencies: only the runtime ships to production.
RUN npm prune --omit=dev

# --- Runtime image ----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# `tini` forwards SIGTERM correctly: without it, stopping the container kills
# the process without letting SQLite close its WAL cleanly.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=UTC \
    DB_PATH=/data/mrr.db

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY src/db/schema.sql ./dist/db/schema.sql

# The `node` user already exists in the image: never run as root.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8791

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8791/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
