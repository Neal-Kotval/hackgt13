#!/usr/bin/env bash
set -euo pipefail
set +x

MODE="${1:-}"
[[ "$MODE" == setup || "$MODE" == start ]] || exit 2
: "${AGENTCLOUD_AUTH_SECRET_ID:?Missing auth secret identifier}"
SECRET="$(aws secretsmanager get-secret-value \
  --secret-id "$AGENTCLOUD_AUTH_SECRET_ID" --query SecretString --output text)"
# A plain string is the auth secret. JSON may also set BACKBOARD_API_KEY for the hosted app.
eval "$(printf '%s' "$SECRET" | /usr/bin/node-22 /usr/local/lib/agentcloud/runtime-secret.mjs)"
unset SECRET
: "${BETTER_AUTH_SECRET:?Staging auth secret is not initialized.}"
: "${AGENTCLOUD_PUBLIC_ORIGIN:?Missing public application origin}"
export BETTER_AUTH_URL="$AGENTCLOUD_PUBLIC_ORIGIN"
export AGENTCLOUD_DATA_DIR=/var/lib/agentcloud
# Real delivery when the runtime secret carries SMTP settings (scripts/aws-auth/set-smtp.sh).
if [[ -n "${SMTP_HOST:-}" ]]; then export AGENTCLOUD_MAIL_MODE=smtp; else export AGENTCLOUD_MAIL_MODE=local; fi
export NODE_ENV=production
export NEXT_TELEMETRY_DISABLED=1
cd /opt/agentcloud/current

if [[ "$MODE" == setup ]]; then
  exec /usr/bin/npm-22 run auth:setup
fi
exec /usr/bin/node-22 node_modules/next/dist/bin/next start --hostname 0.0.0.0
