#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
PLATFORM_ADMIN_EMAIL="${AGENTCLOUD_PLATFORM_ADMIN_EMAIL:-}"
[[ "$PLATFORM_ADMIN_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || {
  echo 'Set AGENTCLOUD_PLATFORM_ADMIN_EMAIL to the verified platform operator email before staging deploy.' >&2
  exit 2
}
load_staging_outputs
require_command git
require_command python3
require_command shasum

REVISION="$(git -C "$ROOT_DIR" rev-parse HEAD)"
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || exit 1
MANAGED_STATUS="$(aws --region "$STAGING_REGION" ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=$STAGING_INSTANCE" \
  --query 'InstanceInformationList[0].PingStatus' --output text)"
[[ "$MANAGED_STATUS" == Online ]] || {
  echo "SSM agent is not online for $STAGING_INSTANCE (status: $MANAGED_STATUS)." >&2
  exit 1
}
if ! git -C "$ROOT_DIR" cat-file -e "HEAD:scripts/aws-auth/remote-deploy.sh"; then
  echo 'Commit the deployment scripts before packaging this revision.' >&2
  exit 1
fi
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
ARCHIVE="$WORK_DIR/app.tar.gz"
git -C "$ROOT_DIR" archive --format=tar HEAD | gzip -n > "$ARCHIVE"
CHECKSUM="$(shasum -a 256 "$ARCHIVE" | cut -d ' ' -f1)"

echo "Uploading committed revision $REVISION to the private staging artifact bucket."
aws --region "$STAGING_REGION" s3 cp "$ARCHIVE" "s3://$STAGING_BUCKET/releases/app.tar.gz" --only-show-errors

python3 - "$STAGING_BUCKET" "$REVISION" "$CHECKSUM" "$STAGING_SECRET" "$STAGING_REGION" "$STAGING_PUBLIC_URL" "$PLATFORM_ADMIN_EMAIL" "$WORK_DIR/commands.json" <<'PY'
import json, shlex, sys
bucket, revision, checksum, secret, region, public_url, admin_email, destination = sys.argv[1:]
command = (
    "set -e\n"
    "mkdir -p /opt/agentcloud/incoming\n"
    f"aws s3 cp s3://{bucket}/releases/app.tar.gz /opt/agentcloud/incoming/app.tar.gz --only-show-errors\n"
    f"echo '{checksum}  /opt/agentcloud/incoming/app.tar.gz' | sha256sum -c -\n"
    f"mkdir -p /opt/agentcloud/releases/{revision}\n"
    f"tar -xzf /opt/agentcloud/incoming/app.tar.gz -C /opt/agentcloud/releases/{revision}\n"
    f"bash /opt/agentcloud/releases/{revision}/scripts/aws-auth/remote-deploy.sh {revision} '{secret}' {region} '{public_url}' {shlex.quote(admin_email)}\n"
)
with open(destination, "w", encoding="utf-8") as file:
    json.dump({"commands": [command]}, file)
PY

COMMAND_ID="$(aws --region "$STAGING_REGION" ssm send-command \
  --instance-ids "$STAGING_INSTANCE" --document-name AWS-RunShellScript \
  --comment "AgentCloud staging deploy $REVISION" \
  --parameters "file://$WORK_DIR/commands.json" \
  --timeout-seconds 1800 --query Command.CommandId --output text)"
echo "SSM deployment command: $COMMAND_ID"

for _ in {1..180}; do
  STATUS="$(aws --region "$STAGING_REGION" ssm get-command-invocation \
    --command-id "$COMMAND_ID" --instance-id "$STAGING_INSTANCE" \
    --query Status --output text 2>/dev/null || true)"
  case "$STATUS" in
    Success) echo "Deployed $REVISION. Open $STAGING_PUBLIC_URL/sign-in."; exit 0 ;;
    Failed|Cancelled|TimedOut|Cancelling)
      aws --region "$STAGING_REGION" ssm get-command-invocation \
        --command-id "$COMMAND_ID" --instance-id "$STAGING_INSTANCE" \
        --query '{Status:Status,StandardOutputContent:StandardOutputContent,StandardErrorContent:StandardErrorContent}'
      exit 1 ;;
  esac
  sleep 10
done
echo "Deployment is still running; inspect SSM command $COMMAND_ID." >&2
exit 1
