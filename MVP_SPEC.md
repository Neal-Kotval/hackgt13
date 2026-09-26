# AgentCloud HackGT MVP: governed remote agent work

## Demo promise

An employee signs in, connects and verifies a machine in the web app, then creates a task and starts an agent inside that environment from the desktop app, and watches its progress and operational analytics on the web as the agent uses a real remote run environment. AgentCloud provisions that environment on known capacity, grants access according to a server-enforced policy, streams actual agent and command activity to a Codex-like control surface, and records the GPU result. A second employee or agent without permission is denied at the resource boundary.

The GPU machine used in the demo may be a pre-existing host named “Cresix.” Creating a run environment on that host is provisioning; merely saving its SSH address is not. The demo must identify exactly which machine, account, container, worktree, and credential boundary it actually creates or attaches. It must not claim to have procured a new GPU if the host already exists.

AgentCloud should support that known-host path and use EC2 as its first managed run-box provider. The demo may use either path. A provider response alone does not make a box ready: the worker must verify the remote account, workspace, GPU device, and representative workload from the environment where the agent will run. [BACKEND_PLAN.md](BACKEND_PLAN.md) specifies the proposed worker and state contract.

## User flow

1. **Employee login:** A human signs in through one working identity provider. AgentCloud creates a server-side session and associates that employee with a project role. The unauthenticated dashboard/API used by the current local prototype cannot serve this flow.
2. **Connect a machine and evaluate policy:** The employee selects a project and connects a machine or requests an environment in the web app. A server-side policy checks employee identity, project role, resource, and requested environment action. No task or agent run is required at this stage. The UI shows the decision and reason.
3. **Provision and verify:** A provider creates a real run environment on known remote capacity. AgentCloud verifies host identity, the remote execution identity, the worktree or working directory, GPU visibility, and a small representative GPU operation before showing `ready`.
4. **Create a task and start the agent:** In the desktop app, the employee selects the ready environment, creates/assigns a task, and requests an agent start. The server checks task, agent, and environment permissions before one real coding-agent adapter starts or connects to a session inside that environment. The agent executes a task whose local environment lacks the required GPU capacity. The exact local limitation and remote result are recorded, rather than asserting that a terminal agent is inherently unable to do the work.
5. **Monitor actual work:** The web control surface displays the agent session, command start/result, output or bounded logs, task status, resource state, attribution, and analytics derived from recorded run outcomes and durations. Metrics show their time range and freshness; missing telemetry is unavailable. Task instructions and follow-ups are authored in the desktop app. A transport heartbeat and a running model session have separate labels. The UI does not invent commands or results.
6. **Deny and release:** An unauthorized identity attempts the same resource action and is denied by the backend and by the SSH/execution boundary being claimed. The authorized run can be stopped or disconnected; the project record and selected output remain available for review.

## Planned components

| Component | MVP responsibility |
| --- | --- |
| Web control surface | Employee login, environment setup and lifecycle controls, request/approval state, operational analytics, progress, real output, and result viewing |
| Desktop app | Task creation, instructions, agent assignment, and follow-ups persisted through the shared authenticated backend |
| Identity and policy | One OIDC-compatible employee login, project roles, server-side decisions, separate agent/run credentials, and attributed audit events |
| Resource provider | Create/attach/stop a run environment on one known Linux host or provider, verify capability, and report failures honestly |
| Remote runner | Start the selected agent and commands in the intended environment, stream bounded events, and preserve the project worktree across reconnects |
| GPU target | One actual GPU reachable from the run environment; verify device and workload rather than trusting a label |

The control plane talks to the box; the box performs the work. The MVP may run an existing agent CLI on the box and stream its real events. It does not need to implement a new model loop. An MCP interface or Coder integration can be added to the same policy and resource API later; neither is required to prove the first remote run.

## Operational proof sequence

The demo record should contain one unbroken chain of IDs: employee → request → policy decision → box → agent run → GPU verification → result. For an existing host, capture host-key identity and the dedicated remote account. For EC2, capture instance ID, Region, instance profile, workspace volume, and stop confirmation. Expose safe identifiers and evidence summaries to the human; keep secrets and private network details server-side.

Before the run starts, show that the chosen workload is unavailable in the local environment and record the specific reason. During the run, emit actual command start, bounded output, exit status, and device/workload verification with timestamps. After the run, reconnect and inspect the same workspace/result. A second identity then attempts the forbidden resource action; record both the API denial and the execution-boundary denial. An unrestricted shell is labeled trusted access and leaves the execution-boundary denial gate incomplete.

## Permission boundary

- Human login authorizes control-plane actions. Agent identity and remote execution identity are separate and linked to the human-approved task.
- Resource checks happen before allocation and again at the SSH/execution boundary. The demo includes a successful authorized operation and a failed unauthorized operation against the actual boundary.
- A dedicated non-root account, short-lived credential, command gateway, or equivalent mechanism may narrow SSH access. State which one is implemented. An unrestricted SSH shell is trusted access; an API role toggle alone does not restrict its filesystem or commands.
- Do not expose plaintext SSH keys, model credentials, or connection secrets in model context, browser state, activity events, or logs. Revocation is claimed only if an existing session and a new connection are both shown to lose access.
- One organization and one trusted GPU host are sufficient for the HackGT demonstration. Production tenant isolation, device attestation, generalized SSH policy, and cost enforcement remain separate work.

## Acceptance evidence

1. Two employee identities log in and receive different server-enforced resource decisions. An authorized employee can connect and verify the environment before any task exists; that ready environment shows no active agent until a desktop start succeeds.
2. A real run environment is created or attached, with recorded host and execution identity. Restart/reconnect returns to its actual working files.
3. The authorized agent performs a real GPU task remotely. Capture the command, device evidence, output, and a precise explanation of why the local environment could not run the same task.
4. A desktop-created task appears in the web dashboard with matching project/task/run IDs. The dashboard mirrors real agent and command events with timestamps and attribution; killing or disconnecting the agent changes its execution state without inventing work.
5. An unauthorized identity cannot obtain the resource through the API and fails at the claimed SSH/execution boundary. Allowed work still succeeds.
6. Stop or release the run environment and show the resulting state. Claim cost shutdown or credential revocation only if those effects are independently verified.

## Deliberately later

Two-agent service handoffs, a broad CPU/GPU marketplace, managed GPU purchasing, low-latency data connectors, artifact homes, wikis, production multi-tenant SSO, hardware device attestation, and a full interactive terminal emulator are extensions. The MVP should make one remote GPU task and one real permission denial undeniable before adding them.

The current repository is a local single-user coordination foundation. It has no employee login, remote resource provisioner, agent execution adapter, enforced SSH boundary, or GPU workload. This file specifies the next demonstrated capability, not current behavior.
