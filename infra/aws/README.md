# AgentCloud AWS foundation

Terraform here manages the `us-east-1` demo foundation in AWS account `662660921850`. See [AWS_SETUP.md](../../AWS_SETUP.md) for the live preflight, cost ceiling, quota case, and launch gates. Applying this directory creates no EC2 instance.

## Operate

1. Authenticate with `aws login` and verify `aws sts get-caller-identity` returns the intended account.
2. Review the current Free plan and credit expiry, GPU quota request, AMI, and price.
3. Run `terraform -chdir=infra/aws init`, `terraform -chdir=infra/aws plan`, then inspect every proposed action before `terraform -chdir=infra/aws apply`.
4. Run `terraform -chdir=infra/aws plan` again to check for drift.

The AWS provider rejects another account ID. The original budget and GPU quota setting are already imported into this workstation's local Terraform state. The state file is ignored by Git and must be preserved securely; an additional operator needs a protected shared backend and state migration before applying. Never commit state, plan files, ZIP files, or credentials.

`team-iam.tf` manages the `NathanBai` and `AarushMathad` IAM users and their shared `AdministratorAccess` group. Each console login has a 32-character initial password and requires a password change at first sign-in. No access keys are created. Terraform stores only PGP-encrypted initial passwords; the corresponding private key stays outside the repository in the owner's local GPG home. The owner can retrieve one password locally and copy it to the clipboard without printing it:

```sh
terraform -chdir=infra/aws output -json teammate_encrypted_initial_passwords \
  | jq -r '.NathanBai' \
  | base64 --decode \
  | gpg --homedir "$HOME/.config/agentcloud/iam-invites" --decrypt \
  | pbcopy
```

Replace `NathanBai` with `AarushMathad` for the other user. Send each password privately with the account sign-in URL, and have both users set up MFA after their first login. These IAM users can administer resources in this AWS account; they still need the protected shared Terraform backend before they can safely run Terraform applies themselves.

The launch template tags instances and volumes for the demo. The worker supplies `AgentCloudJobId`, `AgentCloudCreatedAt`, and `AgentCloudExpiresAt` instance tags as UTC ISO 8601 timestamps. The expiry function terminates a tagged instance when the deadline is missing, invalid, older than now, or more than two hours after creation. It checks every five minutes. It has not terminated a real box yet. The worker must separately enforce the deadline and reconcile provider state after restart.

`worker.tf` declares a scoped `agentcloud-demo-worker` role assumed only from the private auth staging instance role. The worker process refuses root or application role credentials, assumes this role, and uses the existing GPU launch template with the approved job ID as the EC2 client token. Run with `AGENTCLOUD_DATA_DIR` pointing at the staging SQLite database and `AGENTCLOUD_GPU_SUBNET_ID` set to the verified subnet, then `node scripts/run-box-worker.mjs --once`. After deploying a committed revision on private staging and applying the role, `bash scripts/install-run-box-worker.sh` on that host installs the polling systemd service. Each cycle reconciles expired, stopped, and orphaned instances before claiming another job; unconfirmed cleanup blocks a new allocation. The worker checks current owner membership and live launch gates, clones the immutable approved repository into a non-root workspace, records its commit SHA, and verifies the GPU with a CPU/CUDA matrix workload through SSM. `aws_gpu_verification` stores the instance, remote account/UID, workspace, repository SHA, device probe, correctness, CPU/CUDA timings, command ID, exit code, and output digest before `ready`. Applying the role declaration and performing the first GPU launch remain separate operations; no GPU instance is created by Terraform apply.

## CPU environment (`cpu.tf`, HAC-125)

`cpu.tf` adds the `agentcloud-demo-cpu` launch template (`t3.medium`, Amazon Linux 2023, IMDSv2, encrypted 20 GiB gp3 deleted on termination, instance-initiated shutdown terminates, standard credits, demo expiry tags), the `agentcloud-demo-cpu-ssh` security group with no Terraform-managed ingress, and a separate worker inline policy `ManageOnlyApprovedAgentCloudDemoCPU`. That policy allows `RunInstances` only through the CPU template for `t3.medium`, and lets the worker add or revoke tcp/22 rules on the CPU SSH group only, tagging them at creation. It changes nothing in the GPU policy, budget guard, or expiry guard; the budget deny already covers this role. The first plan was **3 to add, 0 to change, 0 to destroy**. Applying it creates no instance. See [AWS_SETUP.md](../../AWS_SETUP.md#cpu-environment-aws-cpu-hac-125) for the SSH path decision and the smoke test.

## Independent Runpod expiry guard

`runpod-expiry.tf` schedules `runpod_expiry.py` every five minutes. It lists Runpod Pods with a dedicated API key and acts only on names matching `agentcloud-<UUID>--exp-<10-digit Unix seconds>`. If Runpod supplies creation time, a deadline beyond two hours is rejected. If creation time is absent, the encoded deadline controls expiry. The guard confirms deletion by GET returning 404 before publishing its last successful scan time to `/agentcloud/runpod-expiry-guard/last-success`. Failed scans leave that timestamp stale.

Terraform creates only the Secrets Manager secret metadata at `agentcloud/runpod/expiry-guard-api-key`; provision its value outside Terraform after reviewing the plan. Never put the API key in Terraform state, logs, or Git. The staging role can read that exact secret and the guard's read-only health signals. `node scripts/runpod-expiry-preflight.mjs` returns success only when the Lambda is active, its five-minute EventBridge rule and target are enabled, and its latest successful scan is less than ten minutes old. Run it with the staging role before allowing Pod allocation. Applying Terraform does not create a Pod; the preflight will remain unhealthy until a key is provisioned and a scheduled scan succeeds.
