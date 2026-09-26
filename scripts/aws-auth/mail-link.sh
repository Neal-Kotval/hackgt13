#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
load_staging_outputs
require_command python3
require_command curl
EMAIL="${1:-}"
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || {
  echo 'Usage: mail-link.sh email@example.com' >&2
  exit 2
}
LOCAL_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
LOG_FILE="$(mktemp)"
aws --region "$STAGING_REGION" ssm start-session \
  --target "$STAGING_INSTANCE" --document-name AWS-StartPortForwardingSession \
  --parameters "portNumber=3101,localPortNumber=$LOCAL_PORT" >"$LOG_FILE" 2>&1 &
SESSION_PID=$!
trap 'kill "$SESSION_PID" 2>/dev/null || true; wait "$SESSION_PID" 2>/dev/null || true; rm -f "$LOG_FILE"' EXIT
for _ in {1..20}; do
  if ! kill -0 "$SESSION_PID" 2>/dev/null; then
    cat "$LOG_FILE" >&2
    exit 1
  fi
  if LINK="$(curl -fsS --max-time 2 -G --data-urlencode "email=$EMAIL" "http://127.0.0.1:$LOCAL_PORT/latest" 2>/dev/null)"; then
    printf '%s\n' "$LINK"
    exit 0
  fi
  sleep 1
done
echo 'No captured verification link found for that email yet.' >&2
exit 1
