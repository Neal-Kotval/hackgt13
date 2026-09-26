#!/usr/bin/env bash
set -euo pipefail

# Run on the private staging EC2 host after deploying a committed app release
# and applying the scoped Terraform worker role. Does not approve a job.
if [[ "$(id -u)" != 0 ]]; then
  echo 'Run as root on the private staging host.' >&2
  exit 1
fi
if [[ ! -f /opt/agentcloud/current/scripts/run-box-worker.mjs ]]; then
  echo 'Deploy a release containing the GPU worker first.' >&2
  exit 1
fi

cat >/etc/systemd/system/agentcloud-gpu-worker.service <<'UNIT'
[Unit]
Description=AgentCloud scoped GPU run-box worker
After=network-online.target agentcloud.service
Wants=network-online.target

[Service]
Type=simple
User=agentcloud
Group=agentcloud
WorkingDirectory=/opt/agentcloud/current
Environment=AGENTCLOUD_DATA_DIR=/var/lib/agentcloud
Environment=AGENTCLOUD_GPU_SUBNET_ID=subnet-0d76bc090d2666592
Environment=AWS_DEFAULT_REGION=us-east-1
Environment=HOME=/var/lib/agentcloud
ExecStart=/usr/bin/node-22 /opt/agentcloud/current/scripts/run-box-worker.mjs --loop
Restart=on-failure
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
systemctl enable --now agentcloud-gpu-worker.service
systemctl restart agentcloud-gpu-worker.service
systemctl is-active --quiet agentcloud-gpu-worker.service
echo 'AgentCloud GPU worker service active.'
