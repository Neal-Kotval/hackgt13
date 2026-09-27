# AWS GPU demo setup

This is the AWS decision and live preflight record for [HAC-3](https://linear.app/startup-yc/issue/HAC-3/p21-aws-confirm-gpu-quota-capacity-and-demo-cost-limits). **Terraform in [infra/aws/](infra/aws/) is the source of truth for AgentCloud AWS resources.** Do not create or edit AWS resources manually; import any preexisting resource into Terraform before changing it. The approved-job worker and EC2 provider are implemented, but AWS G6 allocation is blocked by the account plan.

## Selected demo profile

| Item | Decision or observation |
| --- | --- |
| Account | `662660921850`, confirmed by the owner; no account alias |
| Region | `us-east-1` |
| Workload | A bounded PyTorch CPU-versus-CUDA matrix computation, run as the agent's non-root account; record both times and the GPU device |
| Candidate box | One On-Demand `g6.xlarge` (4 vCPU, one NVIDIA L4, 16 GiB system RAM, about 22 GiB GPU memory) |
| AMI candidate | AWS Deep Learning OSS Nvidia Driver AMI GPU PyTorch 2.10 (Amazon Linux 2023), resolved on 2026-09-26 to `ami-0bf870650c1cfee60`; its root volume is 25 GiB gp3. Resolve and verify the AMI again at launch. |
| Management | Systems Manager using an EC2 instance role, with no inbound SSH rule. Select and verify networking before launch. |
| Runtime policy | At most two hours for the demo. Stop and restart once to prove workspace retention, then terminate and delete the EBS workspace after collecting evidence. The worker must enforce the deadline and verify the final EC2 and volume states before this is a real limit. |
| Spend policy | Owner wants to stay below the original $100 free-credit amount. The working demo budget is $25 of gross account-wide monthly cost, leaving a large margin. At 100% of actual gross spend, a Terraform-managed AWS Budgets action (HAC-115) automatically attaches `agentcloud-budget-launch-deny` to the `agentcloud-demo-worker` role, blocking AgentCloud `RunInstances`, `StartInstances`, and `CreateVolume`. It does not stop running instances (the expiry guard bounds those), restrict the root user or other roles, or act before Budgets data updates, which can lag by hours. It is not an account-wide hard cap. |

## Read-only checks and account changes, 2026-09-26

- AWS STS resolved the logged-in account to `662660921850`. The session is a root identity; routine worker calls must use a scoped role, never root credentials or keys.
- **2026-09-26: the owner upgraded the account to the Paid plan** (`aws freetier upgrade-account-plan --account-plan-type PAID`). A read-back showed `PAID`/`ACTIVE` with **$160 remaining credits** and no Free-plan expiration. Usage beyond credits is billed to the payment method on file. AWS Settings project spend limits were not available to this account at that time; HAC-115 added the budget launch block instead. Before that upgrade, the Free account plan was active with **$160 remaining credits** and an expiration of **2026-09-30 21:30 UTC**. The owner wants to stay below the original $100 free-credit allowance, regardless of the displayed balance. Verify the balance and plan again before launching. The account may close when the Free plan expires; do not treat the workspace as long-term storage.
- The `us-east-1` On-Demand G/VT quota was initially **0 vCPU**. Request `b2037d23f4be4eed829be427a7f4c063lLLSx7mB` for **4 vCPU** (`L-DB2E81BA`) is now `CASE_CLOSED`, and the applied quota was read back as **4 vCPU** on 2026-09-26. This meets the quota requirement, but quota approval does not override account-plan eligibility. No GPU instance has launched.
- A live approved G6 job reached `RunInstances`, which AWS rejected with `Client.InvalidParameterCombination`: `g6.xlarge is not eligible for Free Tier`. CloudTrail recorded the rejection and no instance was created. The worker and read-only preflight now require an active **Paid** account plan before another G6 attempt. Switching plans is a separate owner billing decision; this demo is proceeding with another GPU provider instead. Existing credits and the $25 gross warning budget do not make a Free-plan G6 launch eligible.
- EC2 lists `g6.xlarge` offerings in several `us-east-1` availability zones. An offering listing does **not** prove launch-time capacity.
- The AWS Price List API returned **$0.8048 per running hour** for Linux On-Demand `g6.xlarge` in US East (N. Virginia) on this date. Two hours of instance compute is about **$1.61**, before EBS, public IPv4 if used, data transfer, logs, taxes, and any other services. Recheck the quote before showing it to a user or launching.
- The local Requests UI now shows this dated compute quote for a one- or two-hour GPU request and saves the selected profile and duration as intent. This does not provision a box or enforce an expiry. Other resource categories do not yet have priced provider profiles.
- After the main-branch employee-auth integration, `POST /api/resources` accepts a GPU request only from a verified employee with current project membership. The server records the authenticated employee ID, active organization ID, and effective project role at request time; client-supplied identity fields are rejected. Members may submit intent, but no role can approve or launch AWS from this route. A future decision worker must recheck current membership, policy, quota, credit, and price before using a scoped AWS role.
- The account has a default VPC with public subnets. Terraform created security group `sg-0446333335c7914f6` with no inbound rules and only TCP 443 egress, an SSM instance role/profile, and GPU launch template `lt-068a4a4399752a47b`. The template specifies the verified AMI, `g6.xlarge`, IMDSv2, an encrypted 25 GiB gp3 root volume deleted on termination, and demo instance/volume tags. A launch worker must select a subnet with working SSM connectivity and verify it on the actual box.
- Created and read back account-wide monthly cost budget `AgentCloud-Demo-Gross-25` for **$25**, with credits and refunds excluded. It and the existing quota were imported into Terraform state. Actual-cost email notifications to the account owner are set at 50%, 80%, and 100%. A monthly budget is a warning, not a per-run cap or shutdown mechanism.
- Terraform created an EventBridge schedule and Lambda `agentcloud-demo-expiry` that check tagged demo instances every five minutes. For a launch to remain active, the worker must set UTC `AgentCloudCreatedAt` and `AgentCloudExpiresAt` tags on the instance, with the deadline no later than 120 minutes after creation. Missing, malformed, or expired tags cause a termination request on the next check. The role may terminate only instances tagged `Project=AgentCloudDemo` and `AgentCloudAutoExpire=true`. This is a backup guard, not a substitute for worker reconciliation or a guaranteed hard dollar cap. Its first real termination has not been tested because no instance was launched.
- Terraform apply added 14 foundation resources and changed none of the imported budget/quota resources. A post-apply plan reported no changes. Direct checks confirmed no inbound security-group rules and no demo instances. A manual Lambda invocation returned `expired_count: 0` without error.
- Cost Explorer returned `DataUnavailableException` for current-month costs; its history cannot currently confirm usage or remaining credit. The Free Tier plan API supplied the credit snapshot above.

## Terraform workflow

The configuration is pinned to account `662660921850` and Region `us-east-1`. It uses the existing AWS CLI login (`aws login`) and does not require an AWS access-key `.env` file. Run `npm run aws:gpu:preflight` for a read-only check of the applied quota, launch template, AMI, security group, expiry guard and target, **Paid-plan eligibility**, remaining credits and runtime window, current G6 compute price, budget, and existing demo instances. It must report `FAIL Paid plan required for G6` on the current Free account. Its compute-only price check fails above $1/hour; the price excludes storage, network, and taxes. This check does not prove launch-time capacity or worker cleanup and does not authorize a launch. Re-run it immediately before any future launch. Before a change, verify `aws sts get-caller-identity`, account plan, quota, AMI, and price. Then run `terraform -chdir=infra/aws init`, `terraform -chdir=infra/aws plan`, and review the entire plan before `terraform -chdir=infra/aws apply`. Commit configuration and `.terraform.lock.hcl`, never state, plan files, credentials, or generated ZIPs. The current state is local to this workstation in `infra/aws/terraform.tfstate` and is gitignored; preserve it securely. Shared execution needs a protected remote state backend before another operator applies. The original budget and quota request were made before the Terraform decision and have been imported. Terraform's quota declaration intentionally ignores value drift after AWS's review.

## Gates before a billable GPU run

1. Obtain a separate owner decision to switch this account to Paid. Until then, the G6 preflight fails and no AWS GPU run is authorized. Recheck credits, price, quota, and account identity after any plan change.
2. Set `AGENTCLOUD_PLATFORM_ADMIN_EMAIL` to the verified platform operator's email and approve the organization at `/admin/aws`. A project owner alone cannot authorize platform AWS spend. Launch only from a server-approved job through the scoped worker role. The browser must not receive AWS credentials or arbitrary launch parameters.
3. Verify AMI, subnet connectivity, volume behavior, tags, and cleanup on the actual box. The Terraform expiry Lambda is a second guard; the existing zero-instance check did not test a real termination.
4. Verify the non-root account, workspace, repository revision, GPU device, and CPU-versus-CUDA workload. Record command evidence and final EC2 and EBS cleanup state.

The GPU quota is 4 vCPU and the worker and scoped role exist, but the Free plan blocks `g6.xlarge`. No AWS GPU workload or real EC2 cleanup has been verified. The live demonstration is moving to another GPU provider; do not claim an EC2 launch.

## CPU environment (`aws-cpu`, HAC-125)

Status: **planned, not applied, never launched.** Terraform in [infra/aws/cpu.tf](infra/aws/cpu.tf) plans 3 additions and no changes. The worker, provider, and smoke script are unit-tested with a fake AWS CLI only.

| Item | Decision |
| --- | --- |
| Profile | `aws-cpu` on provider `aws-ec2`. It shares the single-active AWS box guard, EC2 reconciliation, the expiry Lambda, and the HAC-115 budget deny on the worker role. GPU `aws-ec2` jobs stay profile-less and are claimed only by the GPU worker. |
| Box | One On-Demand `t3.medium` (2 vCPU, 4 GiB, no GPU), standard CPU credits, Amazon Linux 2023 x86_64 `ami-0fef201115eefe936` (resolved 2026-09-26 from the public SSM parameter; re-verify before apply), encrypted 20 GiB gp3 root deleted on termination, IMDSv2 required, existing `agentcloud-demo-instance` SSM role. |
| Bootstrap | Worker-supplied user data installs `git`, `tmux`, Node `22.23.3` (official tarball, SHA-256 pinned), and `@openai/codex@0.157.1`; creates non-root `agentcloud`; writes `~/.codex/config.toml` with `cli_auth_credentials_store = "file"` (0600) so sign-in lands in `~/.codex/auth.json`; logs progress to `/var/log/agentcloud-bootstrap.log`; writes `/var/lib/agentcloud/bootstrap.done` or `bootstrap.failed`. |
| Self-destruct | User data schedules `shutdown -P +N` (N ≤ the approved deadline, 20 minutes for the smoke test). The template sets instance-initiated shutdown to **terminate**, so the box and its volume are removed even if the worker and Lambda both fail. The deadline tag also drives the five-minute expiry Lambda. |
| Workspace | `/home/agentcloud/agentcloud/<jobId>/repo` (approved repository checkout). |
| Quoted cost | `t3.medium` $0.0416/h (AWS Price List, 2026-09-26) + public IPv4 $0.005/h + 20 GiB gp3 about $0.0022/h ≈ **$0.049/h**; about $0.10 for a two-hour environment and $0.02 for the 20-minute smoke test, before data transfer and tax. The worker refuses a compute price above $0.10/h. |

### Desktop SSH path decision

The desktop app connects with ssh2 to `host:port` from `/api/run-boxes/:id/connection`, pins the recorded host key, and authenticates with its device key. It never holds AWS credentials. The product runs locally first, so the worker and the desktop app usually share one public address.

| Option | Cost | Security | Complexity with the current desktop | Decision |
| --- | --- | --- | --- | --- |
| EC2 Instance Connect Endpoint | No hourly charge; no public IPv4 | No inbound internet exposure | The desktop would need AWS credentials and a SigV4 WebSocket tunnel (`aws ec2-instance-connect open-tunnel`) in front of ssh2; connections are limited to one hour. | Rejected for now |
| SSM port forwarding | No charge; no public IPv4 | No inbound ports | Also needs AWS credentials plus the Session Manager plugin on each employee device. | Rejected for now; still used by the worker for host-key readback |
| **Security group: tcp/22 from the requester's /32** | $0.005/h public IPv4 | One public address may reach port 22; key-only auth; per-job host key pinned; no passwords, no root login, EC2 Instance Connect key injection disabled | Works with the existing ssh2 + pinned-host-key flow unchanged | **Chosen** |

How it works:

1. Terraform creates `agentcloud-demo-cpu-ssh` with **no** ingress rules. The worker adds one rule per job, `tcp/22` from the requester's public `/32`, tagged `AgentCloudJobId`, and revokes it before termination. Preflight revokes leftover rules; it also requires no other demo instance to be running.
2. The worker address is `AGENTCLOUD_AWS_CPU_SSH_CIDR`: an explicit public `/32`, or `auto` to discover the worker host's address from `https://checkip.amazonaws.com/` at allocation time. Private, loopback, link-local, CGNAT, benchmarking, multicast, reserved, and wider ranges are rejected. The worker (verification) and the backend's Codex sessions reach the box from this address.
   **Requester address (HAC-166).** When the app runs with `AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER=1`, `POST /api/run-boxes` for `aws-cpu` records the caller's public IPv4 from CloudFront's `CloudFront-Viewer-Address` header (`ip:port`) in table `aws_cpu_ssh_access`. IPv6 (bare or bracketed), private, loopback, link-local, CGNAT, multicast, and reserved addresses are ignored, and `X-Forwarded-For` is never read. Without the flag every header is ignored. The worker then adds a second job-tagged `/32` rule for that address (or reuses its own rule when the addresses are equal) before verification; `revokeSshForJob` removes every rule tagged with the job before termination. The existing `worker_cpu` IAM statements already allow several tagged rules per group, so no Terraform change is needed. **Set the flag only where the origin is reachable exclusively through CloudFront** (staging: port 3000 admits only CloudFront's origin-facing prefix list; CloudFront sets the header itself). Anywhere else a client could forge it and open port 22 to an address of its choice (key authentication still applies). TODO: a "Refresh my SSH access" request for members whose address changes.
3. The ed25519 host key is generated **on the box** during bootstrap. The worker reads its public half back over Systems Manager (an authenticated AWS channel, not trust on first use) and requires `ssh-keyscan 127.0.0.1` on the box to return the same key. The private key never leaves the instance and is not in user data or logs.
4. The worker then SSHes to the public IPv4 as `agentcloud` with its operator key and the pinned `known_hosts`, waits for `bootstrap.done`, and checks `codex --version` (0.157.1), `tmux -V`, `git`, Node 22, and the repository checkout. Only then does it record `run_box_ssh_endpoint` and mark the job `ready`, so the existing desktop terminal works without changes.

Limitations and caveats:

- **User data is not secret.** Any on-box process can read it through IMDS, and account principals with `ec2:DescribeInstanceAttribute` can read it through the API. It therefore carries only public keys, pinned versions, and a checksum; the host key is generated on the box instead.
- Device keys are read at allocation. Keys registered later are not on the box (the existing MVP limitation).
- If the requester's public address changes (network switch, VPN), SSH from the desktop stops working until a new environment is requested (refreshing access is a TODO). Only the creator's address is recorded; other project members reach the box only from the worker's address. Behind carrier-grade NAT, other users of the same address can reach port 22, though only authorized keys can log in.
- Worker verification needs SSH reachability from the worker host. On staging the worker runs on the app instance with `AGENTCLOUD_AWS_CPU_SSH_CIDR=auto` (its public IPv4, in the same subnet as the boxes), and the requester's address comes from CloudFront as above.
- The worker must run as the scoped `agentcloud-demo-worker` role, as for GPU. **The AWS root user cannot assume roles**, and the role's trust policy admits only the private staging instance role. A run from an operator workstation needs a separate owner-approved trust change for a non-root operator principal; that change is not part of this plan.
- Teardown terminates the instance and deletes its EBS volume; the Stage 2 `codex logout` cleanup step belongs to HAC-121 and is not run by this worker yet.

### Worker configuration

`node scripts/run-box-worker.mjs --once aws-ec2` (or `--loop`) also processes one `aws-cpu` job per cycle when these are set: `AGENTCLOUD_AWS_CPU_SSH_CIDR` (`auto` or `<ip>/32`), `AGENTCLOUD_AWS_CPU_SSH_KEY_FILE` (operator ed25519 private key path), and `AGENTCLOUD_AWS_CPU_SSH_PUBLIC_KEY` (its public key line). Evidence lands in table `aws_cpu_environment` (instance, public IP, SSH rule, pinned host key, bootstrap step, tool versions, workspace, output digest). The owner-only one-step `POST /api/run-boxes` accepts `profileId: "aws-cpu"`.

On staging, `sudo bash /opt/agentcloud/current/scripts/install-run-box-worker.sh` (after a deploy) writes `agentcloud-gpu-worker.service` with `AGENTCLOUD_AWS_CPU_SSH_CIDR=auto`, `AGENTCLOUD_AWS_CPU_SSH_KEY_FILE=/var/lib/agentcloud/aws-cpu/id_ed25519`, its `AGENTCLOUD_AWS_CPU_SSH_PUBLIC_KEY`, and `AGENTCLOUD_GPU_SUBNET_ID` (the caller's value, else the installed unit's, else `subnet-0d76bc090d2666592`). `scripts/aws-cpu-operator-key.sh` generates that dedicated ed25519 key only when absent (directory 0700, files 0600, owned by `agentcloud`) and prints only its public half. The app service (written by `scripts/aws-auth/remote-deploy.sh`) and the worker both run as `agentcloud` with `AGENTCLOUD_DATA_DIR=/var/lib/agentcloud`, so remote Codex sessions use the same runner key the worker injects; the installer normalizes that key's ownership. The script is idempotent.

### Supervised smoke test

`scripts/aws-cpu-smoke.mjs` runs the real worker and EC2 adapter against a throwaway SQLite database, never the app database. Without `--launch` it runs only the read-only preflight. With `--launch` it allocates one box, waits for `ready`, SSHes in with the supplied key against the pinned host key, prints `whoami`, `codex --version`, `tmux -V`, and a sanitized `codex login status`, then revokes the SSH rule, terminates the instance, and confirms EBS deletion. It aborts after 18 minutes; the box's own timer and deadline tag are 20 minutes; cleanup also runs on SIGINT/SIGTERM. It targets only its own job's instance.

```sh
ssh-keygen -t ed25519 -N '' -f ~/.ssh/agentcloud_smoke_ed25519
node scripts/aws-cpu-smoke.mjs --key ~/.ssh/agentcloud_smoke_ed25519            # preflight only
node scripts/aws-cpu-smoke.mjs --key ~/.ssh/agentcloud_smoke_ed25519 --launch   # billable, about $0.02
```

The credentials must be the `agentcloud-demo-worker` role session, or the private staging instance role that may assume it.
