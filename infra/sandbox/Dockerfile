# AgentCloud local sandbox: CPU-only Linux container reachable over SSH.
# Access is trusted shell access for member device keys; it is not a
# filesystem or command sandbox. The worker supplies a per-job host key and
# authorized keys at start; the image contains no keys or credentials.

# Pinned toolchain (HAC-121). Node is the official release tarball, verified
# against its published SHA-256; Codex is the pinned npm release.
ARG NODE_VERSION=22.23.3
ARG CODEX_VERSION=0.157.1

FROM debian:bookworm-slim AS toolchain
ARG NODE_VERSION
ARG CODEX_VERSION
ARG TARGETARCH
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) arch=x64; sha=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de ;; \
      arm64) arch=arm64; sha=a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    file="node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    curl -fsSLo "/tmp/${file}" "https://nodejs.org/dist/v${NODE_VERSION}/${file}"; \
    echo "${sha}  /tmp/${file}" | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xJf "/tmp/${file}" -C /opt/node --strip-components=1 --no-same-owner; \
    rm -rf "/tmp/${file}" /opt/node/include /opt/node/share /opt/node/*.md /opt/node/LICENSE \
      /opt/node/lib/node_modules/corepack /opt/node/bin/corepack
ENV PATH=/opt/node/bin:$PATH
RUN npm install --global --no-fund --no-audit "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && test "$(codex --version)" = "codex-cli ${CODEX_VERSION}"

FROM debian:bookworm-slim

# usermod '*' means no usable password without locking the account (sshd refuses locked accounts).
RUN apt-get update \
 && apt-get install --yes --no-install-recommends openssh-server git bash ca-certificates tmux \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_* \
 && mkdir -p /run/sshd \
 && useradd --create-home --shell /bin/bash agentcloud \
 && usermod --password '*' agentcloud

# Merged into /usr/local: /usr/local/bin is on sshd's default PATH, so `codex`,
# `node`, and `npm` resolve for login shells and non-interactive `ssh host cmd`.
COPY --from=toolchain /opt/node/ /usr/local/
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/agentcloud-sandbox-entrypoint
RUN chmod 0644 /etc/ssh/sshd_config && chmod 0755 /usr/local/bin/agentcloud-sandbox-entrypoint \
 && node --version && codex --version && tmux -V

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/agentcloud-sandbox-entrypoint"]
