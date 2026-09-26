#!/usr/bin/env bash
set -euo pipefail
set +x

MODE="${1:-}"
[[ "$MODE" == setup || "$MODE" == start ]] || exit 2
: "${AGENTCLOUD_AUTH_SECRET_ID:?Missing auth secret identifier}"
SECRET="$(aws secretsmanager get-secret-value \
  --secret-id "$AGENTCLOUD_AUTH_SECRET_ID" --query SecretString --output text)"
(( ${#SECRET} >= 32 )) || { echo 'Staging auth secret is not initialized.' >&2; exit 1; }
export BETTER_AUTH_SECRET="$SECRET"
unset SECRET
export BETTER_AUTH_URL=http://127.0.0.1:3000
export AGENTCLOUD_DATA_DIR=/var/lib/agentcloud
export AGENTCLOUD_MAIL_MODE=local
export NODE_ENV=production
export NEXT_TELEMETRY_DISABLED=1
cd /opt/agentcloud/current

if [[ "$MODE" == setup ]]; then
  exec /usr/bin/npm-22 run auth:setup
fi
exec /usr/bin/npm-22 start
