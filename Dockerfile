FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY public ./public
COPY tsconfig.json next-env.d.ts proxy.ts ./
RUN npm run build && npm prune --omit=dev --no-audit --no-fund && node -e "require('fs').rmSync('.next/cache', { recursive: true, force: true })"

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 AGENTCLOUD_DATA_DIR=/data AGENTCLOUD_MAIL_MODE=local
WORKDIR /app
COPY --from=build --chown=node:node /app /app
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "scripts/docker/start.mjs"]
