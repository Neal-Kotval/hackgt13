#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="$ROOT_DIR/infra/aws-auth"

require_command() {
  command -v "$1" >/dev/null 2>&1 || { printf 'Missing command: %s\n' "$1" >&2; exit 1; }
}

tf_output() {
  terraform -chdir="$TF_DIR" output -raw "$1"
}

load_staging_outputs() {
  require_command terraform
  require_command aws
  STAGING_REGION="$(tf_output region)"
  STAGING_INSTANCE="$(tf_output instance_id)"
  STAGING_BUCKET="$(tf_output artifact_bucket_name)"
  STAGING_SECRET="$(tf_output auth_secret_arn)"
  [[ "$STAGING_REGION" =~ ^[a-z0-9-]+$ && "$STAGING_INSTANCE" =~ ^i-[a-f0-9]+$ && "$STAGING_BUCKET" =~ ^[a-z0-9.-]+$ && "$STAGING_SECRET" =~ ^arn:aws:secretsmanager: ]] || {
    echo 'Terraform staging outputs are missing or invalid; apply the reviewed Terraform plan first.' >&2
    exit 1
  }
}
