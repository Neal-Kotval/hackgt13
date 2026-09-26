# AgentCloud AWS foundation

Terraform here manages the `us-east-1` demo foundation in AWS account `662660921850`. See [AWS_SETUP.md](../../AWS_SETUP.md) for the live preflight, cost ceiling, quota case, and launch gates. Applying this directory creates no EC2 instance.

## Operate

1. Authenticate with `aws login` and verify `aws sts get-caller-identity` returns the intended account.
2. Review the current Free plan and credit expiry, GPU quota request, AMI, and price.
3. Run `terraform -chdir=infra/aws init`, `terraform -chdir=infra/aws plan`, then inspect every proposed action before `terraform -chdir=infra/aws apply`.
4. Run `terraform -chdir=infra/aws plan` again to check for drift.

The AWS provider rejects another account ID. The original budget and GPU quota setting are already imported into this workstation's local Terraform state. The state file is ignored by Git and must be preserved securely; an additional operator needs a protected shared backend and state migration before applying. Never commit state, plan files, ZIP files, or credentials.

The launch template tags instances and volumes for the demo. The worker supplies `AgentCloudJobId`, `AgentCloudCreatedAt`, and `AgentCloudExpiresAt` instance tags as UTC ISO 8601 timestamps. The expiry function terminates a tagged instance when the deadline is missing, invalid, older than now, or more than two hours after creation. It checks every five minutes. It has not terminated a real box yet. The worker must separately enforce the deadline and reconcile provider state after restart.

`worker.tf` declares a scoped `agentcloud-demo-worker` role assumed only from the private auth staging instance role. The worker process refuses root or application role credentials, assumes this role, and uses the existing GPU launch template with the approved job ID as the EC2 client token. Run with `AGENTCLOUD_DATA_DIR` pointing at the staging SQLite database and `AGENTCLOUD_GPU_SUBNET_ID` set to the verified subnet, then `node scripts/run-box-worker.mjs --once`. The worker checks current owner membership and live launch gates, verifies a non-root workspace and CUDA workload through SSM, and records evidence references. Applying the role declaration and performing the first GPU launch remain separate operations; no GPU instance is created by Terraform apply.
