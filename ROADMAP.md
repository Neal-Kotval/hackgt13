# AgentCloud roadmap

Ship one governed remote GPU task before expanding into multiple agents or an infrastructure catalog. This is a dependency-ordered roadmap, not a claim that the remote MVP already works. [MVP_SPEC.md](MVP_SPEC.md) defines the HackGT acceptance gates.

## Client responsibility and migration

The desktop app owns task creation, instructions, agent assignment, and follow-ups. The web app owns environment setup and lifecycle management, operational analytics, and progress/results viewing. Existing web task controls are part of the local foundation, not the target product responsibility.

Before declaring the target workflow complete, connect desktop task creation to the shared authenticated backend, migrate web task/follow-up authoring to that desktop flow, and preserve existing task records and agent updates. Connect or allocate and verify the environment before a task exists. Then create the task in the desktop app and authorize an agent start against that ready environment; environment readiness must not depend on an active task. Web analytics initially summarize recorded run outcomes, durations, failures, and environment state with time range/freshness; mark missing telemetry unavailable.

## Next implementation increments

These are reviewable slices within phases 1–4, in the order they should land. [BACKEND_PLAN.md](BACKEND_PLAN.md) defines the proposed records and worker/provider contract.

| Slice | Build | Exit evidence |
| --- | --- | --- |
| A. Durable contract | Database migrations for employee membership, request decisions, box jobs, runs, events, and verification; import path for existing local projects; idempotent state transitions | Restart and retry a job without losing a decision, duplicating a box, or reclassifying a local draft as an allocation |
| B. Identity and decision | Local Better Auth sessions and project roles (HAC-1), followed by a policy check before allocation | Two real test employees get different server decisions; unauthenticated mutation fails |
| C. Known-host box | Worker and existing-host provider with pinned host identity, remote account/workspace evidence, stop and reconciliation | Attached box passes a GPU workload from the intended execution account; failed probe never shows ready |
| D. Managed EC2 box | EC2 adapter under the same provider interface, with account/Region quota check, instance identity, Systems Manager management path, EBS retention, stop confirmation | Real launch, verification, stop/restart, and workspace recovery; request/box IDs tie each result to the same run |
| E. Real agent run | One supported agent adapter, bounded command/result events, event replay, and an authorized/denied resource test | Agent completes the GPU task; dashboard mirrors actual work; reconnect and denial evidence pass [MVP_SPEC.md](MVP_SPEC.md) |

The known-host path can complete the HackGT proof if AWS GPU quota or capacity is unavailable. EC2 is the first managed provider, not a prerequisite for proving the run contract on existing capacity. Do not start a GPU instance merely to populate UI state.

## 0 — Web and local coordination foundation (implemented locally)

Deliver the token-based React/Next.js app, project setup, roster, tasks, service records, handoffs, activity streaming, disk persistence, and a CLI connection protocol. Start with an empty project list and guide the user through creating real coordination records. Do not ship seeded projects or replay controls.

The current repository also has local resource catalog/request records, inference configuration drafts, a run-activity view, and a graph projection of saved records. Requests remain unevaluated; these screens do not add remote infrastructure.

Acceptance:

- Create a project and task, assign an agent, refresh, and recover the saved records after server restart.
- Connect the CLI with an issued agent credential and observe a real connection event.
- Register a service and handoff through an authenticated client; see each attributed to its agent.
- Reject out-of-scope agent operations and never return stored plaintext credentials.
- Pass type, build, backend, and token checks; exercise changed UI flows using Playwright at 375, 768, and 1440 pixels.

This phase does not provide a remote machine, execute a model, or guarantee filesystem isolation.

## 1 — Employee login and resource policy

HAC-1 implements local Better Auth email/password sessions, SQLite auth migrations, verified signup, organization creation and invitations, and project memberships. Local email capture is the default; SMTP is configurable. Human APIs validate verified sessions and organization/project access. Resource decisions, transactional jobs, enterprise OIDC, and remote enforcement remain pending.

Add one working employee identity-provider integration, server-side sessions, project roles, and resource request decisions. First migrate decisions and job records to transactional storage with explicit migrations and a path for existing local state. Keep employee, agent, and remote execution identities distinct. Local development may use one organization; it must not be presented as production tenant isolation.

Acceptance:

- Two employees can sign in and receive different server-enforced decisions for the same resource request.
- Unauthenticated access to human mutation APIs is denied; a UI-only role change cannot bypass the backend.
- Decisions record the employee, task, resource, action, and reason without exposing credentials.
- An approved request creates one idempotent worker job; a retry does not create another allocation. A denied request creates no provider job.

## 2 — Remote agent run box

Build an agent run-box provider interface and one real Linux implementation. Attach a known SSH machine first, including a GPU host when that is the resource the task needs; implement EC2 as the first managed provider after the same contract works. The run box is the agent's remote computer, not the permanent home of a published output.

**2a — Known host:** pin/approve the host key, use a named execution account, create or identify the workspace, and run both a GPU device probe and representative workload there. Stopping this run must report whether the host itself remains on.

**2b — EC2:** check the selected account/Region's GPU quota and capacity before depending on it for the demo. Launch one identified instance per active run, record the instance and workspace volume, use Systems Manager where supported, and confirm stop/restart and EBS retention behavior. Select G6 or G6e from the workload's measured requirements. AWS lists the default On-Demand G/VT quota as zero; request a quota increase early if necessary. [AWS quotas](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html), [GPU instance specifications](https://docs.aws.amazon.com/ec2/latest/instancetypes/ac.html)

Acceptance:

- Verify SSH host identity and connectivity; report failures without marking the workspace ready.
- Create or attach an identified run environment on that host and stop it through a real provider operation; report whether the underlying GPU machine itself remains running.
- Verify task-critical capabilities from inside the remote environment (for a GPU task, detect the device and run a small workload); do not infer them from the machine label.
- Clone a user-specified repository into a durable workspace directory.
- Stop/restart the application and reconnect to the same working files and installed dependencies while that run box is retained.
- Record provider, workspace identity, connection state, and attributed provisioning events.
- Label unrestricted SSH execution as trusted access.
- Retry or restart the worker without duplicating a box; reconcile a provider resource that exists while the database says allocation failed.
- Record a failed stop as failed or stopping until the provider confirms the process/instance state.

Depends on phase 0's project and event records and phase 1's employee authorization. If a GPU host is already owned, provisioning means creating a real run environment on that capacity; it does not mean purchasing or creating the GPU machine.

## 3 — First real agent execution

Implement one actual Codex adapter or supported client integration against the remote workspace. Keep agent credentials separate from provider/model credentials.

Acceptance:

- A user creates and assigns a task in the desktop app against a ready project environment previously connected and verified on the web; a documented connect/launch flow lets a real agent edit a file remotely.
- A command runs in the intended workspace and emits attributed start, completion, and error events.
- Disconnect and reconnect preserve the project and do not create duplicate ownership.
- The dashboard distinguishes transport connection, model execution, and idle state.
- Each run event has a stable run ID, ordered sequence, timestamp, actor, kind, and bounded output/evidence reference; reconnect resumes without duplicating commands.

## 4 — Governed GPU task and control surface (HackGT MVP)

Complete the end-to-end scenario in [MVP_SPEC.md](MVP_SPEC.md). The desktop app creates tasks and directs agents. The web app configures environments and displays operational analytics, progress, and real agent/command activity from the remote box; it does not need a task composer, a new model loop, or a simulated terminal.

Acceptance:

- An authorized employee connects and verifies the GPU environment on the web first, then creates the task and starts an authorized agent inside it from the desktop app; a real agent completes a representative GPU task there. Record why the local environment cannot run the same workload and the remote device/result evidence.
- A second identity is denied by both the resource API and the SSH/execution boundary being claimed; an allowed command still works.
- The web dashboard displays actual session, command, output, and resource states with attribution, plus analytics derived from recorded events with an explicit time range and freshness. Transport connection and model execution are distinct.
- Reconnect to the same project work, then stop or release the run environment and show its actual state.
- Show one traceable chain from authenticated employee and decision through provider box, agent session, GPU result, and stop evidence.
- Do not claim SSH path or command restrictions, credential revocation, or cost shutdown without demonstrating each at its enforcement boundary.

## Inference API and resource graph stretch

Project real MVP allocation records into a resource dependency graph. If the core GPU demo is complete, add one configurable private inference API on known GPU capacity: launch a serving engine, verify an authenticated request, show the agent-to-endpoint-to-GPU relationship, then stop and confirm resource release. [RESOURCE_GRAPH_SPEC.md](RESOURCE_GRAPH_SPEC.md) defines the proposal. This stretch does not replace the phase 4 acceptance gates and should not be presented as implemented from a registered URL.

## 5 — Two-agent collaboration

Add an independently connected Claude client and one Git worktree per agent. Make task dependencies, shared services, and handoffs available to both tools through a documented protocol.

Acceptance:

- Codex and Claude run concurrently in distinct, verified on-disk worktrees.
- Codex starts an actual API and publishes a contract and endpoint.
- Claude discovers that endpoint through the registry and successfully consumes it while Codex remains active.
- The development endpoint has private ingress and is denied to clients outside the authorized organization/project boundary.
- A structured handoff contains real changed files, the service address, completed work, and next steps.
- The human can follow attributed live activity and reconnect to the project afterward.

Record this demonstration end to end using actual connected clients and outputs.

## 6 — Artifact homes

Add a publication path from a run box to a managed artifact home with per-artifact isolation, durable output, and, where needed, supervised serving. Underlying infrastructure may be shared. Start with one small website or API. Keep the artifact available after its producing run box stops, and record its source revision and verification result. Add wiki content and durable runtime data only with explicit storage, retention, and restore behavior. [FEATURE_SPEC.md](FEATURE_SPEC.md) defines the product contract.

Acceptance:

- Publish an identified artifact version from a real run, then stop or replace that run box without losing the output.
- Verify the site/API endpoint or reopen wiki content after restart; distinguish registered, reported, and verified states.
- Enforce each artifact's storage and access boundary even when homes share infrastructure.
- Deny publication outside a credential's scope and keep deployment and model credentials out of public state.
- Show the deployed revision and failure state; do not present a temporary development service as a durable artifact.

## 7 — Deeper access controls and review

Add a mediated execution boundary if restricted access is part of the demo. Implement actual diff retrieval, integration checks, conflict reporting, and human-requested merges.

Acceptance:

- A forbidden file or command operation fails at the execution boundary, with a visible denial event.
- Allowed operations continue to work; direct shell access cannot bypass any claimed restrictions.
- Review reads actual worktree diffs and test output with command, timestamp, and revision context.
- A requested merge either succeeds with a resulting commit or reports conflicts without losing either agent's work.

If this phase is incomplete, demo only trusted SSH access and clearly label merge/test actions as unavailable.

## 8 — Reviewer and broader resource requests

Add a reviewer agent that tests the integrated preview and creates an actionable issue or follow-up task. Expand resource requests to more providers only where the backend can enforce approval, duration, expiry, and a real spending limit.

Acceptance:

- The reviewer catches an intentionally introduced integration issue and names reproducible evidence.
- The human assigns a follow-up and sees a verified resolution.
- No temporary resource starts before approval; it stops at expiry and records lifecycle events.

## Later

Snapshots and rollback, graphical desktop access, notifications, file sync, managed GPU purchasing, production tenant isolation, multi-region database/event scaling, quotas, and billing. Access to an existing SSH GPU host belongs to phase 2; procuring GPUs belongs here. Prioritize these from observed demo limitations rather than adding decorative controls.

## External decisions before the remote milestone

- Choose one employee identity provider and supply two test identities with distinct project roles.
- Supply a known SSH GPU host and execution account, or an AWS account/Region with confirmed GPU quota, plus the required host or IAM trust setup.
- Choose a repository and a small GPU workload with a checkable output and a specific local limitation.
- Decide whether an attached host offers trusted shell access or a separately enforced command/OS boundary; specify the denied action to test.
- Set stop, volume retention, and spending expectations before launching an EC2 GPU box.

## Release evidence

For each phase, record the tested revision, commands and results, screenshots or browser trace, and any remaining limitations. Do not mark a phase complete from implementation alone. [PRODUCT.md](PRODUCT.md) defines product truth; [ARCHITECTURE.md](ARCHITECTURE.md) defines the technical boundaries; [DESIGN.md](DESIGN.md) defines visual constraints.

## Local Docker Codex integration (HAC-116)

The opt-in local Codex path initializes a real Codex app-server in a Docker CPU
box from project Settings and lets desktop send turns to the same persistent
thread. Employee membership gates reads and chat; owners control setup and
lifecycle. SQLite stores bounded attributed session items, while the Docker
volume retains Codex history and workspace files. This local implementation does
not satisfy the AWS/GPU execution or public multi-tenant milestones above. See
[LOCAL_CODEX.md](LOCAL_CODEX.md) for setup, authentication, recovery and limits.
