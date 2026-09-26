#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
load_staging_outputs
LOCAL_PORT="${1:-3000}"
[[ "$LOCAL_PORT" =~ ^[0-9]+$ ]] && (( LOCAL_PORT >= 1024 && LOCAL_PORT <= 65535 )) || {
  echo 'Specify an unprivileged local port (1024–65535).' >&2
  exit 1
}
echo "Private SSM tunnel: local 127.0.0.1:$LOCAL_PORT -> EC2 127.0.0.1:3000 (Ctrl+C to close)."
exec aws --region "$STAGING_REGION" ssm start-session \
  --target "$STAGING_INSTANCE" \
  --document-name AWS-StartPortForwardingSession \
  --parameters "portNumber=3000,localPortNumber=$LOCAL_PORT"
