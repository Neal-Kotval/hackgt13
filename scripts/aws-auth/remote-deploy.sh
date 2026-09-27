#!/usr/bin/env bash
set -euo pipefail
REVISION="${1:-}"
SECRET_ID="${2:-}"
REGION="${3:-}"
PUBLIC_URL="${4:-}"
PLATFORM_ADMIN_EMAIL="${5:-}"
[[ "$REVISION" =~ ^[a-f0-9]{40}$ && "$SECRET_ID" == arn:aws:secretsmanager:* && "$REGION" =~ ^[a-z0-9-]+$ && "$PUBLIC_URL" =~ ^https://[a-z0-9]+\.cloudfront\.net$ && "$PLATFORM_ADMIN_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || exit 2
RELEASE="/opt/agentcloud/releases/$REVISION"

systemctl is-active --quiet amazon-ssm-agent || { echo 'Amazon SSM agent is not active.' >&2; exit 1; }
dnf install -y nodejs22 nodejs22-npm tar gzip make gcc-c++ >/dev/null
command -v curl >/dev/null 2>&1 || dnf install -y curl-minimal >/dev/null
command -v aws >/dev/null 2>&1 || dnf install -y awscli >/dev/null
# Codex sessions on remote environments run the system ssh with the install's runner key.
command -v ssh >/dev/null 2>&1 && command -v ssh-keygen >/dev/null 2>&1 || dnf install -y openssh-clients >/dev/null
if ! id agentcloud >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/agentcloud --shell /sbin/nologin agentcloud
fi
install -d -m 0700 -o agentcloud -g agentcloud /var/lib/agentcloud
install -d -m 0755 /opt/agentcloud/releases

# Keep this small host responsive during the Next.js production build.
if [[ ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
fi
swapon --show=NAME | grep -qx /swapfile || swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

chown -R agentcloud:agentcloud "$RELEASE"
cd "$RELEASE"
runuser -u agentcloud -- env NODE_OPTIONS=--max-old-space-size=1536 NEXT_TELEMETRY_DISABLED=1 /usr/bin/npm-22 ci --no-audit --no-fund
runuser -u agentcloud -- env NODE_OPTIONS=--max-old-space-size=1536 NEXT_TELEMETRY_DISABLED=1 /usr/bin/npm-22 run build
runuser -u agentcloud -- /usr/bin/npm-22 prune --omit=dev --no-audit --no-fund

install -m 0755 "$RELEASE/scripts/aws-auth/service-start.sh" /usr/local/bin/agentcloud-service-start
cat > /etc/systemd/system/agentcloud.service <<EOF
[Unit]
Description=AgentCloud private auth staging
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agentcloud
Group=agentcloud
WorkingDirectory=/opt/agentcloud/current
Environment=AGENTCLOUD_AUTH_SECRET_ID=$SECRET_ID
Environment=AWS_DEFAULT_REGION=$REGION
Environment=AGENTCLOUD_PUBLIC_ORIGIN=$PUBLIC_URL
Environment=AGENTCLOUD_PLATFORM_ADMIN_EMAIL=$PLATFORM_ADMIN_EMAIL
# HAC-166: the app port admits only CloudFront's origin-facing prefix list, so the
# CloudFront-Viewer-Address header is trustworthy here (aws-cpu requester SSH access).
Environment=AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER=1
Environment=HOME=/var/lib/agentcloud
ExecStartPre=/usr/local/bin/agentcloud-service-start setup
ExecStart=/usr/local/bin/agentcloud-service-start start
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/agentcloud

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/agentcloud-mail-reader.service <<EOF
[Unit]
Description=AgentCloud private captured mail reader
After=agentcloud.service

[Service]
Type=simple
User=agentcloud
Group=agentcloud
WorkingDirectory=/opt/agentcloud/current
ExecStart=/usr/bin/node-22 /opt/agentcloud/current/scripts/aws-auth/mail-reader.mjs
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/agentcloud

[Install]
WantedBy=multi-user.target
EOF

ln -sfn "$RELEASE" /opt/agentcloud/current.next
mv -Tf /opt/agentcloud/current.next /opt/agentcloud/current
systemctl daemon-reload
systemctl enable --now agentcloud.service >/dev/null
systemctl enable --now agentcloud-mail-reader.service >/dev/null
systemctl restart agentcloud.service
systemctl restart agentcloud-mail-reader.service
if systemctl is-enabled --quiet agentcloud-gpu-worker.service; then
  systemctl restart agentcloud-gpu-worker.service
fi
if systemctl is-enabled --quiet agentcloud-runpod-worker.service; then
  systemctl restart agentcloud-runpod-worker.service
fi
for _ in {1..30}; do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/sign-in >/dev/null; then
    echo "AgentCloud staging healthy at revision $REVISION (loopback only)."
    exit 0
  fi
  sleep 2
done
systemctl status --no-pager agentcloud.service || true
echo 'AgentCloud staging did not become healthy on loopback.' >&2
exit 1
