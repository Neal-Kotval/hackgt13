FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.157.1 \
    && mkdir -p /home/node/workspace /home/node/.codex \
    && chown -R node:node /home/node
ENV HOME=/home/node
ENV CODEX_HOME=/home/node/.codex
USER node
WORKDIR /home/node/workspace
CMD ["sleep", "infinity"]
