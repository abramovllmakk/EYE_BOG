# syntax=docker/dockerfile:1
# Multi-stage build: one build stage, three small runtime targets (server, demo, traffic).

FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.34.9
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY demo/server/package.json demo/server/
COPY demo/traffic/package.json demo/traffic/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @gqlcov/core build \
 && pnpm --filter @gqlcov/demo-server build \
 && pnpm --filter @gqlcov/server build \
 && pnpm --filter @gqlcov/cli build \
 && pnpm --filter @gqlcov/web build
RUN pnpm --filter @gqlcov/server deploy --prod --legacy /out/server \
 && pnpm --filter @gqlcov/demo-server deploy --prod --legacy /out/demo \
 && pnpm --filter @gqlcov/cli deploy --prod --legacy /out/cli \
 && cp -r apps/web/dist /out/server/web

# --- proxy + UI + API --------------------------------------------------------
FROM node:22-slim AS server
ENV NODE_ENV=production \
    GQLCOV_SERVER__WEB_DIR=/app/web \
    GQLCOV_STORAGE__URL=/data/gqlcov.db
WORKDIR /app
COPY --from=build /out/server /app
COPY --from=build /out/cli /opt/gqlcov-cli
RUN ln -s /opt/gqlcov-cli/dist/bin.js /usr/local/bin/gqlcov && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4000 4001
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD node -e "fetch('http://127.0.0.1:4001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# --- demo GraphQL API --------------------------------------------------------
FROM node:22-slim AS demo
ENV NODE_ENV=production PORT=4100
WORKDIR /app
COPY --from=build /out/demo /app
USER node
EXPOSE 4100
HEALTHCHECK --interval=3s --timeout=3s --retries=20 \
  CMD node -e "fetch('http://127.0.0.1:4100/graphql?query=%7B__typename%7D').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# --- demo test traffic (one-shot) --------------------------------------------
FROM node:22-slim AS traffic
WORKDIR /app
COPY demo/traffic /app
USER node
CMD ["node", "src/run.mjs"]
