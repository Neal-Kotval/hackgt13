# AgentCloud product specification

AgentCloud gives an AI agent a remote project computer it can actually use: a persistent place to inspect files, run tools, and reach resources such as an SSH-accessible GPU machine. The GPU host can be the agent's computer or a separate resource the computer connects to. The human chooses the environment and grants access, assigns work, watches attributed activity, and can return to the same project state later. Multiple agents can then collaborate through separate worktrees, shared services, explicit ownership, and structured handoffs.

The remote computer is the core product promise. A **run box** is the agent's execution environment attached to that project and its permitted resources. An **artifact home** is an optional, longer-lived destination for outputs that must remain available after a run stops. [MVP_SPEC.md](MVP_SPEC.md) defines the first employee-login, remote-GPU, permission, and control-surface demonstration; [FEATURE_SPEC.md](FEATURE_SPEC.md) defines later publication lifecycles. These are planned capabilities, not claims about the current local application. The desktop app is the human-facing client for creating tasks and directing agents. It is distinct from the remote run box; a graphical remote desktop is not required by the first SSH workflow.

A proposed [resource graph](RESOURCE_GRAPH_SPEC.md) links identities, tasks, run boxes, GPUs, data sources, services, and outputs using actual allocation and verification evidence. A configurable private inference API is a future service resource backed by an allocated GPU, rather than a separate model-serving engine built by AgentCloud.

## Demo outcome

The target HackGT MVP is one governed remote GPU task:

1. An employee connects a machine or requests a project environment in the web app before creating any task.
2. AgentCloud applies a server-side permission decision, creates or attaches a real run environment on known capacity, and verifies the GPU from that environment.
3. The employee selects the ready environment in the desktop app, creates a task, and starts an authorized agent inside it. The agent runs a GPU workload unavailable in the local environment. The control surface mirrors actual agent, command, and resource events.
4. A second identity is denied access at the claimed execution boundary. The human can disconnect, reconnect, and inspect the same project work and result.

The GPU machine may be a pre-existing host internally named “Cresix”; creating a run environment on it is distinct from procuring a new GPU. Two-agent collaboration, shared private services, and durable artifact homes are valuable extensions after this MVP works. A saved SSH address, heartbeat, agent card, or scripted animation alone does not satisfy the outcome.

The first managed hosting option is planned to be an EC2 GPU run box. An existing SSH GPU host remains a supported attachment path so the first real proof does not depend on a new cloud quota. Both use the same request, policy, run, event, and verification contract described in [BACKEND_PLAN.md](BACKEND_PLAN.md). The UI must identify which provider and machine performed work; it must never imply AgentCloud launched EC2 when it only attached an existing host.

## Current implementation boundary

This repository is the web application and a local coordination foundation. New installations start empty. Projects, agents, tasks, services, handoffs, and activity appear only when users or connected clients create them; the application contains no seeded project or replay workflow.

| Capability | Implementation boundary |
| --- | --- |
| Projects and tasks | Local API records, assignments, and persisted metadata |
| Agent connections | Registration, scoped credentials, connection/heartbeat reporting, and CLI transport |
| Collaboration | Shared service records, structured handoffs, and streamed activity |
| Persistence | JSON state on the application server's local disk; not remote workspace persistence |
| Dashboard and review | Human coordination views and functional handoffs; Changes and Checks are explicit empty future-state panels |
| Employee login and resource policy | Local Better Auth verified accounts, organization invitations/roles, and project memberships; human routes require authentication. Resource decisions remain unevaluated; no allocation approval or SSH enforcement |
| Resource graph and inference | Graph of persisted coordination relationships and configuration drafts only; no GPU allocation, private endpoint, or serving process |
| SSH / hosted compute | Setup intent and metadata only until a workspace provider is implemented |
| Run boxes and artifact homes | Planned execution and publication lifecycles; neither is provisioned by this application yet |
| Repository import / worktrees | Repository and branch metadata in the app; an isolated local Git provider exists but is not connected to project actions, so no project clone or Git isolation is claimed |
| Codex / Claude execution | Agent identities and protocol foundation; real tool adapters and remote execution remain to build |
| Merge / test execution | Planned operations; no live diff, merge, or test execution |
| Access control | Scope checks on agent API operations; no filesystem or shell sandbox claim |

See [ROADMAP.md](ROADMAP.md) for acceptance gates before claiming the remote demo is complete.

## Primary workflows

### Give an agent a remote computer

The primary journey is machine-first: connect a machine on the web → verify the environment → select it in the desktop app → create a task and start the agent → monitor progress and analytics on the web. A ready environment can have no tasks or active agents. Environment setup must not require a task or implicitly start an agent. The web empty state leads with “Connect a machine”; a ready environment with no run explains how to continue in the desktop app.

The human attaches an existing machine or later provisions one, selects the project and agent identity, and verifies the connection. The human may also attach a separate resource target, such as a GPU host reachable over SSH. The agent works in the intended remote environment, with access to the files, tools, network, and resources actually granted. An SSH connection grants trusted shell access unless an enforced execution boundary narrows it. A saved host address or a heartbeat is not evidence that the agent reached the machine or ran a workload. For a GPU claim, verify that the agent can reach the device and execute a representative workload.

The request, permission decision, box allocation, GPU verification, and agent execution are separate steps in the human view. A person can inspect the decision reason and the evidence behind `ready`; a failed probe leaves the box in a failure state with a concrete next action. Stopping an attached host run stops the run process but does not claim to power off the host. An EBS-backed EC2 instance retains attached volume data when stopped; termination follows the recorded volume-retention policy.

### Create and resume a project

The Projects screen lists saved projects. Setup collects a name, repository URL, template, and intended compute source. Compute choices must describe whether they are configured, connected, or unavailable. A saved project remains accessible after a browser refresh and application restart with the same data directory.

### Create tasks in the desktop app and monitor them on the web

The desktop app owns task creation, task instructions, agent assignment, and follow-up instructions. It submits tasks to the shared backend and uses the project environments configured in the web app. The web dashboard displays those tasks, their owners, dependencies, progress, and results; it does not offer a task composer or create follow-up tasks. A task blocked on another agent's output should explain the dependency rather than merely show a red status.

The current local prototype still has web task mutations and handoff acceptance that can create follow-up tasks. Moving those authoring flows to the desktop app is planned work; this responsibility change does not claim that the current UI or API has already been migrated.

Agent setup issues a distinct connection credential. Credentials must not appear in activity logs or saved UI snapshots. Connection status reflects client heartbeats; a connected identity does not imply a running model session.

### Collaborate through outputs

The shared service registry gives agents a way to discover another agent's output. Development endpoints are temporary and remain inside the organization's private workspace network, accessible only to authorized project agents and members. A service includes its owner, endpoint, purpose, and reported state. Registration is not a health check: do not claim an endpoint is reachable without probing it. The current local prototype has no enforced organization network boundary.

A handoff includes sender, recipient, summary, changed files, relevant services or artifacts, and next steps. Verification evidence should include what ran and its result when available. Handoffs are durable project records, not transient chat bubbles.

### Review the combined project

Review groups work by agent and connects changes to tasks and handoffs. Eventually the human can inspect actual diffs, run combined checks, resolve conflicts, and request a merge. Until those operations exist, the Changes and Checks panels explicitly explain the unavailable capabilities. No sample diffs or executed test results are presented as live evidence.

### Monitor environment health and progress

The web app prioritizes environment configuration, access and resource decisions, verified readiness, and environment lifecycle controls. It also shows agent/task progress, run history, real output, and operational analytics derived from recorded events. Initial analytics should cover run counts by outcome, observed durations, failures, and environment state, with a stated time range and freshness. GPU utilization, token usage, and cost require their own measured data sources; missing telemetry is unavailable, not zero. These analytics are planned capabilities, not claims about current instrumentation.

## Product surfaces

| Surface | Responsibility |
| --- | --- |
| Web app | Target ownership: project/environment setup, access and resource decisions, environment lifecycle controls, operational analytics, and viewing agent/task progress and results. Task creation belongs to the desktop app |
| Desktop app | Target ownership: create tasks, supply instructions, assign agents, and send follow-ups using shared backend records and configured environments; this integration remains to build |
| CLI | Current coordination transport; future adapter/desktop integration can reuse it without duplicating backend state |
| Backend | Current coordination validation and attribution; planned employee policy decisions and resource lifecycle |
| Future run-box service | Attach or provision Linux execution; clone repositories; manage agent worktrees and temporary development services |
| Future artifact-home service | Publish versioned sites, APIs, and knowledge bases; preserve output and data independently of agent runs; verify availability |
| Future agent adapters | Connect actual Codex and Claude sessions to the assigned workspace and collaboration API |

The CLI remains a coordination client. The HackGT MVP additionally requires authenticated employee access, real remote execution, and a web control surface that mirrors actual work. Desktop task creation and its shared-backend integration are required for the target workflow. Tray features, notifications, file sync, and graphical remote desktop remain deferred.

## Access and trust

API authorization and operating-system permissions are separate boundaries. An unrestricted SSH shell is **trusted access**. It must never be presented as restricted by an API path toggle. A filesystem restriction is only a product feature once the execution boundary actually enforces it and a forbidden operation has been demonstrated to fail.

The current local application is a local organization-aware development deployment with employee sessions. Production requires tenant isolation, transport security, secret management, and an audited workspace execution boundary. Never expose the development server to an untrusted network as a multi-tenant product.

## Experience requirements

- For the MVP, make web environment setup, resource requests, permission decisions, operational analytics, run state, and actual agent activity legible. Task creation and follow-up authoring belong in the desktop app. Keep task ownership, dependencies, shared outputs, and handoffs available for later collaboration.
- Preserve useful state across refreshes and show explicit errors for failed mutations.
- Use the rigid token system in [DESIGN.md](DESIGN.md); no component-specific literal visual values.
- Provide usable layouts at 375, 768, and 1440 pixels and visible keyboard focus.
- Start with useful empty states. Do not seed fictional projects, agents, events, endpoints, or review outcomes.
- Use specific action labels and distinguish “registered,” “reported healthy,” and “verified reachable.”

## Success measures

For the current foundation: create and reopen a saved project; register separate agent identities; connect a real CLI client; observe attributed updates in another browser view; persist a service and a handoff; reject an unauthorized scoped API action.

For the remote MVP: show employee login, an actual provisioned or attached run environment, one verified GPU workload executed by a real agent, mirrored command evidence, a denied resource action at the execution boundary, and a successful reconnect to the same work. Capture command output, denial evidence, and UI evidence from actual operations. [MVP_SPEC.md](MVP_SPEC.md) gives the detailed gates.

## Deferred scope

Managed GPU purchasing, spend management, generalized resource marketplaces, two-agent service integration, artifact homes, snapshots and restore, graphical desktop packaging, and automatic conflict resolution are outside the first reliable demo. Attaching an existing SSH-accessible GPU machine is part of the remote-computer path; AgentCloud must verify access before showing it as ready. A resource request must control an actual allocation or attachment to be presented as functional. Do not claim enforced cost or expiry limits until they affect the real resource.

The normal project navigation is Overview, Environments, Runs, and Settings. Overview shows read-only task progress and setup guidance; Environments groups resource requests/approvals with an expandable catalog; Runs contains activity and reported output; Settings contains agent registration and an expandable CLI guide. Organization management is labeled Organizations. Design system, collaboration/stretch pages, and the legacy task board remain directly addressable but are absent from normal navigation. This presentation change preserves records and API contracts; it does not claim desktop integration or remote execution is complete.
