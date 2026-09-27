# AgentCloud local sandbox: CPU-only Linux container reachable over SSH.
# Access is trusted shell access for member device keys; it is not a
# filesystem or command sandbox. The worker supplies a per-job host key and
# authorized keys at start; the image contains no keys.
FROM node:22-bookworm-slim AS node-tools

# Install the agent CLI at a fixed version. npm places its package and the
# platform binary under /usr/local, which is copied into the runtime image.
RUN npm install --global --no-audit --no-fund @openai/codex@0.157.1 \
 && codex --version

FROM debian:bookworm-slim

# usermod '*' means no usable password without locking the account (sshd refuses locked accounts).
RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
      openssh-server git bash ca-certificates curl jq ripgrep \
      python3 python3-venv build-essential \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_* \
 && mkdir -p /run/sshd \
 && useradd --create-home --shell /bin/bash agentcloud \
 && usermod --password '*' agentcloud

COPY --from=node-tools /usr/local/ /usr/local/

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/agentcloud-sandbox-entrypoint
RUN chmod 0644 /etc/ssh/sshd_config && chmod 0755 /usr/local/bin/agentcloud-sandbox-entrypoint

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/agentcloud-sandbox-entrypoint"]
