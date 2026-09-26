#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
load_staging_outputs
require_command doppler

if aws --region "$STAGING_REGION" secretsmanager get-secret-value --secret-id "$STAGING_SECRET" >/dev/null 2>&1; then
  echo 'Staging auth secret already has a value; preserving it and existing sessions.'
  exit 0
fi

# Doppler provides the existing local auth secret. No plaintext reaches the shell
# history, command arguments, Terraform state, or terminal output.
export STAGING_REGION STAGING_SECRET
doppler run --project hackgt --config dev_personal -- bash -c '
  set -euo pipefail
  [[ "${#BETTER_AUTH_SECRET}" -ge 32 ]] || { echo "Doppler BETTER_AUTH_SECRET is missing or too short." >&2; exit 1; }
  printf %s "$BETTER_AUTH_SECRET" | aws --region "$STAGING_REGION" secretsmanager put-secret-value \
    --secret-id "$STAGING_SECRET" --secret-string fileb:///dev/stdin \
    --query VersionId --output text >/dev/null
'
echo 'Copied the stable Doppler auth secret into AWS Secrets Manager.'
