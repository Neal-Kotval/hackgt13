# AWS GPU demo setup

This is the AWS decision and live preflight record for [HAC-3](https://linear.app/startup-yc/issue/HAC-3/p21-aws-confirm-gpu-quota-capacity-and-demo-cost-limits). **Terraform in [infra/aws/](infra/aws/) is the source of truth for AgentCloud AWS resources.** Do not create or edit AWS resources manually; import any preexisting resource into Terraform before changing it. The application still lacks the approved-job worker and EC2 provider described in [BACKEND_PLAN.md](BACKEND_PLAN.md).

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
| Spend policy | Owner wants to stay below the original $100 free-credit amount. The working demo budget is $25 of gross account-wide monthly cost, leaving a large margin. This budget sends alerts; it does not stop EC2 or enforce a hard cap. Do not launch until automated expiry and cleanup are implemented and tested. |

## Read-only checks and account changes, 2026-09-26

- AWS STS resolved the logged-in account to `662660921850`. The session is a root identity; routine worker calls must use a scoped role, never root credentials or keys.
- The Free account plan was active with **$160 remaining credits** at the latest check on 2026-09-26 and an expiration of **2026-09-30 21:30 UTC**. The owner wants to stay below the original $100 free-credit allowance, regardless of the displayed balance. Verify the balance and plan again before launching. The account may close when the Free plan expires; do not treat the workspace as long-term storage.
- The `us-east-1` On-Demand G/VT quota was initially **0 vCPU**. Request `b2037d23f4be4eed829be427a7f4c063lLLSx7mB` for **4 vCPU** (`L-DB2E81BA`) is now `CASE_CLOSED`, and the applied quota was read back as **4 vCPU** on 2026-09-26. This permits one `g6.xlarge` by quota, subject to launch-time capacity. No GPU instance has launched.
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

The configuration is pinned to account `662660921850` and Region `us-east-1`. It uses the existing AWS CLI login (`aws login`) and does not require an AWS access-key `.env` file. Run `npm run aws:gpu:preflight` for a read-only check of the applied quota, launch template, AMI, security group, expiry guard and target, Free plan, current G6 compute price, budget, and existing demo instances. The price excludes storage, network, and taxes. This check does not prove launch-time capacity or worker cleanup and does not authorize a launch. Re-run it immediately before any launch. Before a change, verify `aws sts get-caller-identity`, the Free plan, quota, AMI, and price. Then run `terraform -chdir=infra/aws init`, `terraform -chdir=infra/aws plan`, and review the entire plan before `terraform -chdir=infra/aws apply`. Commit configuration and `.terraform.lock.hcl`, never state, plan files, credentials, or generated ZIPs. The current state is local to this workstation in `infra/aws/terraform.tfstate` and is gitignored; preserve it securely. Shared execution needs a protected remote state backend before another operator applies. The original budget and quota request were made before the Terraform decision and have been imported. Terraform's quota declaration intentionally ignores value drift after AWS's review.

## Gates before a billable GPU run

1. Confirm quota approval and recheck the Free plan, credits, price, and account identity. Do not upgrade the Free plan merely to obtain a GPU without a separate owner decision.
2. Build the server-approved, idempotent job and worker contract. The browser must not receive AWS credentials or arbitrary launch parameters.
3. Build a scoped worker role in Terraform. The SSM profile, launch template, and no-inbound security group are ready, but the worker must verify AMI, subnet connectivity, volume behavior, and tags at launch.
4. Enforce a two-hour expiry independently of AWS Budgets, including reconciliation after worker restart. The Terraform expiry Lambda is a second guard. Test stop, restart, termination, and EBS deletion paths without claiming the current zero-instance check proved them.
5. Launch one instance only from an approved job. Verify the non-root account, workspace, repository revision, GPU device, and CPU-versus-CUDA workload from that account. Record actual command evidence and cleanup state.

The GPU quota is now 4 vCPU, but the approved worker, scoped launch role, cleanup, and actual GPU run are still pending. If those gates cannot be completed before the Free plan expires, use the known-host GPU path in [ROADMAP.md](ROADMAP.md) for the demonstration rather than claiming an EC2 launch.
