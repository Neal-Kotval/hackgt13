# AWS GPU demo setup

This is the AWS decision and live preflight record for [HAC-3](https://linear.app/startup-yc/issue/HAC-3/p21-aws-confirm-gpu-quota-capacity-and-demo-cost-limits). It does not mean AgentCloud can provision EC2 yet. The application still lacks the approved-job worker and EC2 provider described in [BACKEND_PLAN.md](BACKEND_PLAN.md).

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
- The Free account plan was active with **$120 remaining credits** and an expiration of **2026-09-30 21:30 UTC**. Verify the balance and plan again before launching. The account may close when the Free plan expires; do not treat the workspace as long-term storage.
- The `us-east-1` On-Demand G/VT quota was **0 vCPU**. A request for **4 vCPU** (`L-DB2E81BA`) was submitted as `b2037d23f4be4eed829be427a7f4c063lLLSx7mB`; its last observed state was `PENDING`. No GPU instance has launched.
- EC2 lists `g6.xlarge` offerings in several `us-east-1` availability zones. An offering listing does **not** prove launch-time capacity.
- The AWS Price List API returned **$0.8048 per running hour** for Linux On-Demand `g6.xlarge` in US East (N. Virginia) on this date. Two hours of instance compute is about **$1.61**, before EBS, public IPv4 if used, data transfer, logs, taxes, and any other services. Recheck the quote before showing it to a user or launching.
- The account has a default VPC with public subnets. Network design for the run box is not yet applied; no new security group, subnet, role, or instance profile has been created.
- Created and read back account-wide monthly cost budget `AgentCloud-Demo-Gross-25` for **$25**, with credits and refunds excluded. Actual-cost email notifications to the account owner are set at 50%, 80%, and 100%. A monthly budget is a warning, not a per-run cap or shutdown mechanism.
- Cost Explorer returned `DataUnavailableException` for current-month costs; its history cannot currently confirm usage or remaining credit. The Free Tier plan API supplied the credit snapshot above.

## Gates before a billable GPU run

1. Confirm quota approval and recheck the Free plan, credits, price, and account identity. Do not upgrade the Free plan merely to obtain a GPU without a separate owner decision.
2. Build the server-approved, idempotent job and worker contract. The browser must not receive AWS credentials or arbitrary launch parameters.
3. Create a scoped worker role and a minimal SSM instance profile. Verify AMI, networking, no inbound SSH, encrypted gp3 volume, instance and volume tags, and deletion settings.
4. Enforce a two-hour expiry independently of AWS Budgets, including reconciliation after worker restart. Test stop, restart, termination, and EBS deletion paths without claiming a preview operation performed them.
5. Launch one instance only from an approved job. Verify the non-root account, workspace, repository revision, GPU device, and CPU-versus-CUDA workload from that account. Record actual command evidence and cleanup state.

If the quota request remains unavailable before the Free plan expires, use the known-host GPU path in [ROADMAP.md](ROADMAP.md) for the demonstration rather than claiming an EC2 launch.
