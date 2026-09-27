#!/usr/bin/env bash
# Turn on real email delivery (org invitations, email verification) for staging through Gmail SMTP.
# Usage: AWS_PROFILE=agentcloud-operator bash scripts/aws-auth/set-smtp.sh you@gmail.com
# Prompts for a Google app password (myaccount.google.com/apppasswords) without echoing it, merges
# the SMTP settings into the staging runtime secret, and restarts the web service. The password is
# never printed, logged, or written to disk.
set -euo pipefail
set +x
source "$(dirname "$0")/common.sh"

SENDER="${1:-}"
[[ "$SENDER" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || {
  echo 'Usage: set-smtp.sh <gmail address>' >&2
  exit 2
}
load_staging_outputs
require_command node

read -rsp "Google app password for $SENDER (input hidden): " APP_PASSWORD
echo
APP_PASSWORD="${APP_PASSWORD// /}"
[[ ${#APP_PASSWORD} -eq 16 ]] || { echo 'A Google app password is 16 letters (spaces are ignored).' >&2; exit 1; }

CURRENT="$(aws --region "$STAGING_REGION" secretsmanager get-secret-value \
  --secret-id "$STAGING_SECRET" --query SecretString --output text)"
# Keep the existing auth secret (plain string or JSON) and add the SMTP fields.
UPDATED="$(CURRENT="$CURRENT" APP_PASSWORD="$APP_PASSWORD" SENDER="$SENDER" node -e '
  const raw = process.env.CURRENT;
  const data = raw.startsWith("{") ? JSON.parse(raw) : { BETTER_AUTH_SECRET: raw };
  Object.assign(data, { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_USER: process.env.SENDER,
    SMTP_PASSWORD: process.env.APP_PASSWORD, SMTP_FROM: `alto <${process.env.SENDER}>` });
  process.stdout.write(JSON.stringify(data));
')"
unset CURRENT APP_PASSWORD
aws --region "$STAGING_REGION" secretsmanager put-secret-value --secret-id "$STAGING_SECRET" \
  --secret-string "$UPDATED" --query VersionId --output text >/dev/null
unset UPDATED
echo 'Stored SMTP settings in the staging runtime secret.'

COMMAND_ID="$(aws --region "$STAGING_REGION" ssm send-command --instance-ids "$STAGING_INSTANCE" \
  --document-name AWS-RunShellScript --parameters 'commands=["systemctl restart agentcloud.service","systemctl is-active agentcloud.service"]' \
  --query Command.CommandId --output text)"
aws --region "$STAGING_REGION" ssm wait command-executed --command-id "$COMMAND_ID" --instance-id "$STAGING_INSTANCE" || true
aws --region "$STAGING_REGION" ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$STAGING_INSTANCE" \
  --query StandardOutputContent --output text
echo "Staging now sends email from $SENDER."
