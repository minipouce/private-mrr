# --- Étape de compilation ---------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 est un module natif : il faut une chaîne de compilation pour
# le construire, mais elle n'a rien à faire dans l'image finale.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Élague les dépendances de développement : seul le runtime part en production.
RUN npm prune --omit=dev

# --- Image d'exécution ------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# `tini` assure la transmission correcte de SIGTERM : sans lui, l'arrêt du
# conteneur tue le process sans laisser SQLite fermer proprement son WAL.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Europe/Paris \
    DB_PATH=/data/mrr.db

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY src/db/schema.sql ./dist/db/schema.sql

# L'utilisateur `node` existe déjà dans l'image : on ne tourne jamais en root.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8791

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8791/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
