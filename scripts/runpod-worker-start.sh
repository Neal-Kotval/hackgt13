#!/usr/bin/env bash
set -euo pipefail

KEY_FILE=/var/lib/agentcloud/runpod/id_ed25519
KNOWN_HOSTS=/var/lib/agentcloud/runpod/known_hosts
[[ -r "$KEY_FILE" && -r "$KEY_FILE.pub" && -r "$KNOWN_HOSTS" ]] || {
  echo 'Runpod SSH files are not ready.' >&2
  exit 1
}
read -r KEY_TYPE KEY_BODY KEY_COMMENT < "$KEY_FILE.pub"
[[ "$KEY_TYPE" == ssh-ed25519 && "$KEY_BODY" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || {
  echo 'Runpod SSH public key is invalid.' >&2
  exit 1
}
PUBLIC_KEY="$KEY_TYPE $KEY_BODY"
export AGENTCLOUD_RUNPOD_SSH_KEY_FILE="$KEY_FILE"
export AGENTCLOUD_RUNPOD_KNOWN_HOSTS_FILE="$KNOWN_HOSTS"
export AGENTCLOUD_RUNPOD_SSH_PUBLIC_KEY="$PUBLIC_KEY"
exec /usr/bin/node-22 /opt/agentcloud/current/scripts/run-box-worker.mjs --loop runpod
