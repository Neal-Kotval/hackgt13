#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" != 0 ]]; then
  echo 'Run as root on the private staging host.' >&2
  exit 1
fi
if [[ ! -f /opt/agentcloud/current/scripts/run-box-worker.mjs ||
      ! -f /opt/agentcloud/current/scripts/runpod-worker-start.sh ]]; then
  echo 'Deploy a release containing the Runpod worker first.' >&2
  exit 1
fi
id agentcloud >/dev/null 2>&1 || { echo 'AgentCloud service user is missing.' >&2; exit 1; }
command -v ssh-keygen >/dev/null 2>&1 || dnf install -y openssh-clients >/dev/null
install -d -m 0700 -o agentcloud -g agentcloud /var/lib/agentcloud/runpod
if [[ ! -f /var/lib/agentcloud/runpod/id_ed25519 ]]; then
  runuser -u agentcloud -- ssh-keygen -q -t ed25519 -N '' \
    -f /var/lib/agentcloud/runpod/id_ed25519 >/dev/null
fi
[[ -f /var/lib/agentcloud/runpod/id_ed25519.pub ]] || {
  echo 'Runpod public key file is missing.' >&2
  exit 1
}
chown agentcloud:agentcloud /var/lib/agentcloud/runpod/id_ed25519 /var/lib/agentcloud/runpod/id_ed25519.pub
chmod 0600 /var/lib/agentcloud/runpod/id_ed25519
chmod 0644 /var/lib/agentcloud/runpod/id_ed25519.pub
touch /var/lib/agentcloud/runpod/known_hosts
chown agentcloud:agentcloud /var/lib/agentcloud/runpod/known_hosts
chmod 0600 /var/lib/agentcloud/runpod/known_hosts

cat >/etc/systemd/system/agentcloud-runpod-worker.service <<'UNIT'
[Unit]
Description=AgentCloud guarded Runpod run-box worker
After=network-online.target agentcloud.service
Wants=network-online.target

[Service]
Type=simple
User=agentcloud
Group=agentcloud
WorkingDirectory=/opt/agentcloud/current
Environment=AGENTCLOUD_DATA_DIR=/var/lib/agentcloud
Environment=AWS_DEFAULT_REGION=us-east-1
Environment=HOME=/var/lib/agentcloud
ExecStart=/bin/bash /opt/agentcloud/current/scripts/runpod-worker-start.sh
Restart=always
RestartSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/agentcloud

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now agentcloud-runpod-worker.service
systemctl restart agentcloud-runpod-worker.service
systemctl is-active --quiet agentcloud-runpod-worker.service
echo 'AgentCloud Runpod worker service active. Add its public SSH key to Runpod Credentials before allocation.'
