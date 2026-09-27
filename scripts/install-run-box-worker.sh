#!/usr/bin/env bash
set -euo pipefail
set +x

# Run on the private staging EC2 host after deploying a committed app release
# and applying the scoped Terraform worker role. Does not approve a job.
# Idempotent: rerunning keeps the operator key, the subnet, and the data directory.
if [[ "$(id -u)" != 0 ]]; then
  echo 'Run as root on the private staging host.' >&2
  exit 1
fi
APP=/opt/agentcloud/current
DATA=/var/lib/agentcloud
UNIT=/etc/systemd/system/agentcloud-gpu-worker.service
if [[ ! -f "$APP/scripts/run-box-worker.mjs" || ! -f "$APP/scripts/aws-cpu-operator-key.sh" ]]; then
  echo 'Deploy a release containing the run-box worker (HAC-166 or later) first.' >&2
  exit 1
fi
id agentcloud >/dev/null 2>&1 || { echo 'The agentcloud service user is missing; deploy the app first.' >&2; exit 1; }
if ! command -v ssh >/dev/null 2>&1 || ! command -v ssh-keygen >/dev/null 2>&1 || ! command -v ssh-keyscan >/dev/null 2>&1; then
  dnf install -y openssh-clients >/dev/null
fi

# Subnet for aws-ec2 launches: the caller's value, else the installed unit's, else staging's.
SUBNET="${AGENTCLOUD_GPU_SUBNET_ID:-}"
if [[ -z "$SUBNET" && -f "$UNIT" ]]; then
  SUBNET="$(sed -n 's/^Environment=AGENTCLOUD_GPU_SUBNET_ID=//p' "$UNIT" | head -n 1)"
fi
SUBNET="${SUBNET:-subnet-0d76bc090d2666592}"
[[ "$SUBNET" =~ ^subnet-[0-9a-f]+$ ]] || { echo 'Invalid AGENTCLOUD_GPU_SUBNET_ID.' >&2; exit 1; }

# The app (Codex SSH sessions) and this worker share one data directory and user, so
# the Codex runner key at $DATA/codex-runner is readable by both and by no one else.
install -d -m 0700 -o agentcloud -g agentcloud "$DATA"
if [[ -e "$DATA/codex-runner" ]]; then
  chown -R agentcloud:agentcloud "$DATA/codex-runner"
  chmod 0700 "$DATA/codex-runner"
  find "$DATA/codex-runner" -type f -exec chmod 0600 {} +
fi

# Dedicated aws-cpu operator key (private half stays 0600 and is never printed).
CPU_KEY_DIR="$DATA/aws-cpu"
CPU_PUBLIC_KEY="$(bash "$APP/scripts/aws-cpu-operator-key.sh" "$CPU_KEY_DIR" agentcloud)"
[[ "$CPU_PUBLIC_KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+=*$ ]] || { echo 'Operator public key is invalid.' >&2; exit 1; }

cat >"$UNIT" <<UNIT
[Unit]
Description=AgentCloud scoped AWS (GPU and aws-cpu) run-box worker
After=network-online.target agentcloud.service
Wants=network-online.target

[Service]
Type=simple
User=agentcloud
Group=agentcloud
WorkingDirectory=$APP
Environment=AGENTCLOUD_DATA_DIR=$DATA
Environment=AGENTCLOUD_GPU_SUBNET_ID=$SUBNET
Environment=AGENTCLOUD_AWS_CPU_SSH_CIDR=auto
Environment=AGENTCLOUD_AWS_CPU_SSH_KEY_FILE=$CPU_KEY_DIR/id_ed25519
Environment="AGENTCLOUD_AWS_CPU_SSH_PUBLIC_KEY=$CPU_PUBLIC_KEY"
Environment=AWS_DEFAULT_REGION=us-east-1
Environment=HOME=$DATA
ExecStart=/usr/bin/node-22 $APP/scripts/run-box-worker.mjs --loop
Restart=on-failure
RestartSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now agentcloud-gpu-worker.service
systemctl restart agentcloud-gpu-worker.service
systemctl is-active --quiet agentcloud-gpu-worker.service
if ! systemctl show agentcloud.service -p Environment --value | tr ' ' '\n' | grep -qx 'AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER=1'; then
  echo 'Note: agentcloud.service lacks AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER=1; redeploy with scripts/aws-auth/deploy.sh so requester SSH access works.' >&2
fi
echo 'AgentCloud AWS run-box worker service active (GPU and aws-cpu).'
