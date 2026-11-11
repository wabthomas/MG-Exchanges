# syntax=docker/dockerfile:1
#
# Image de l'API MG-Exchange. Contexte de build : la racine du dépôt.
#   docker build -f infrastructure/docker/api.Dockerfile --target runtime  -t mgx-api .
#   docker build -f infrastructure/docker/api.Dockerfile --target migrator -t mgx-api-migrator .
#
# Trois étapes :
#   build    — installe toutes les dépendances et compile le monorepo ;
#   migrator — exécute les migrations Prisma (tâche ponctuelle, rôle propriétaire du schéma) ;
#   runtime  — image d'exécution minimale : code compilé et dépendances de production
#              uniquement, utilisateur non privilégié.
ARG NODE_VERSION=24

# ------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build

# OpenSSL : requis par le moteur de migration de Prisma.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install --global pnpm@12.18.0
ENV PNPM_HOME=/pnpm
WORKDIR /repo

# Manifestes d'abord : la couche d'installation n'est reconstruite que si les dépendances changent.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY packages/validation/package.json packages/validation/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter "@mgx/api..." run build

# Répertoire autonome : code compilé de l'API et dépendances de production uniquement.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @mgx/api deploy --prod /out

# ------------------------------------------------------------------------------------------
FROM build AS migrator

WORKDIR /repo/apps/api
USER node
# DATABASE_MIGRATION_URL (rôle propriétaire du schéma) est fournie à l'exécution.
# La CLI Prisma est appelée directement : aucun gestionnaire de paquets à l'exécution.
CMD ["/repo/apps/api/node_modules/.bin/prisma", "migrate", "deploy"]

# ------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--enable-source-maps", "dist/main.js"]
