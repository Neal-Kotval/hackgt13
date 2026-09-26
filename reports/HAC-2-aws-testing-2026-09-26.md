# AWS test evidence - 2026-09-26

## Private authentication staging

- EC2 instance `i-0a2e8ca08fa21139c` was `running` and SSM `Online` in `us-east-1`.
- SSM read-only command `c9361607-72bf-4a76-b12c-b3c2a84c7626` reported active `agentcloud.service` at deployed revision `d6edfef296ec70b36fadd33c3e103be416b60287`.
- `npm run test:aws-auth:smoke` passed against the live localhost SSM tunnel: sign-up, captured email verification, sign-in, identity check, refresh, and sign-out.
- Playwright opened the live `/sign-in` page at 375, 768, and 1440 pixels. The heading and sign-in button were visible, and document width matched each viewport.

## GPU foundation

- `npm run aws:gpu:preflight` passed its read-only checks in account `662660921850`, `us-east-1`: applied 4-vCPU G/VT quota, `g6.xlarge` launch profile, available GPU AMI, encrypted disposable root disk, IMDSv2, expiry tags, no inbound security rules, active two-hour expiry Lambda and five-minute schedule, zero active demo instances, and the $25 monthly alert budget.
- `python3 -m unittest discover -s infra/aws -p 'test_*.py' -v` passed all three expiry-guard tests.
- `npm run check`, `npm test` (29 tests), and `git diff --check` passed on the stacked testing branch.

## Remaining gates

These checks do not prove a GPU launch or a hard cost cap. The server-approved idempotent worker, scoped AWS launch role, worker-owned expiry and reconciliation, live credit and price check, launch-time capacity, and actual GPU workload and cleanup tests are still pending. No GPU instance was launched for this report.
