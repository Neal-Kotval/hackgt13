# Local development simulator only. AWS production deployment remains separate.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=development NEXT_TELEMETRY_DISABLED=1 AGENTCLOUD_DATA_DIR=/data AGENTCLOUD_MAIL_MODE=local
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=node:node app ./app
COPY --chown=node:node components ./components
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node tsconfig.json next-env.d.ts next.config.ts proxy.ts ./
RUN mkdir -p /data /app/.next && chown node:node /data /app /app/.next
USER node
EXPOSE 3000
CMD ["node", "scripts/docker/start.mjs"]
