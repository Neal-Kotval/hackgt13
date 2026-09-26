# AgentCloud feature spec: run boxes and artifact homes

## Purpose

AgentCloud's core is a remote computer an agent can use for real work, including access to resources the local environment lacks. An existing SSH-accessible GPU machine is one example: it may host the agent's environment or be a separate resource reached from that environment. The product has two distinct lifecycles:

1. **Agent run boxes** provide the agent's remote execution environment, working checkout, tools, processes, and access to permitted resources. They can stop, restart, or be replaced without taking a published artifact offline.
2. **Artifact homes** keep an output available after the run that produced it ends. A website or API may need serving compute; a wiki may need durable storage and a reader without a dedicated always-on process.

“Box” describes a product boundary, not a promise of one virtual machine per item. Artifact homes are managed logical homes that may share underlying infrastructure. Each artifact has its own identity, storage namespace, serving configuration, state, and access policy. The implementation must enforce those boundaries before claiming per-artifact isolation; shared-machine colocation alone is not isolation.

## Product model

| Object | What it owns | Lifetime | Examples |
| --- | --- | --- | --- |
| Project | People, agents, tasks, source repository, and artifact catalog | Until explicitly deleted | Campus Market |
| Agent run box | An execution session, checkout/worktree, logs, and temporary service ports | Task or session duration; may be restarted | Codex API task, Claude frontend task |
| Resource target | A separately identified machine or service the run box is allowed to reach | Managed by its owner; may outlive many runs | SSH GPU host, private database, lab server |
| Artifact | A named, versioned output with provenance and an intended audience | Across agent runs | Site, API, wiki |
| Artifact home | An artifact's managed storage and, when required, serving process; infrastructure may be shared | Until explicitly retired | Static site host, supervised API, wiki store |

The source repository and published artifact versions are durable records. A run box is never the sole copy of either. A service started inside a run box is a **development service**. Its endpoint stays inside the organization's private workspace network and is discoverable only by authorized agents and members of that project while the box runs. It is not a published artifact or a public URL, and it may disappear when the box stops.

Before a run box is marked ready, AgentCloud verifies its host identity, connection, and working directory. A task also checks access to any required resource target. For a GPU task, that includes reaching the target, detecting the accelerator, and running a small representative operation. A host saved in project settings is only an intended target. A transport heartbeat does not prove the agent executed work. Existing SSH access is trusted shell access unless a separate execution boundary enforces restrictions.

An artifact record includes project, name, type, version, source revision, producing task and agent, publish time, home, access mode, and status. It may also include a URL and verification evidence. The record must distinguish a requested publication, an uploaded package, a reported running process, and a server-verified reachable endpoint.

## Core workflow

1. The human first connects a machine or allocates a project environment in the web app. AgentCloud verifies and records the actual machine and workspace identity before any task is required. The human then selects that ready environment in the desktop app, creates/assigns a task, and starts an authorized agent inside it. The web app monitors environment state, operational analytics, task progress, and outputs; task instructions and follow-ups stay in the desktop app.
2. The agent builds and tests in its run box. It may register a temporary, organization-private development service for another authorized project agent to consume. The registry limits discovery to that project, labels the endpoint as temporary, and reports observed reachability separately from client claims. Human preview, if offered, uses authenticated private access rather than exposing the endpoint publicly.
3. The agent proposes an output for publication. The human or a scoped automation selects the artifact type, source revision, build or content package, destination home, and access mode. Publishing is an explicit action with an attributed result.
4. AgentCloud copies or builds the selected version into the artifact home, starts or updates serving when needed, and verifies the result. The artifact catalog links the live version to its source and publish evidence.
5. Stopping or replacing the run box leaves the published artifact and its data available. A later run can publish a new version. Rollback selects a previously retained version if that capability has been implemented and verified.

The artifact home must not silently depend on a run box's filesystem, process, or temporary port. If publication fails, the previously available version remains in place where the deployment method supports atomic switching; otherwise the UI reports the actual outage or degraded state.

## Artifact types

| Type | Persistent need | Serving need | First useful verification |
| --- | --- | --- | --- |
| Small website | Built files or application bundle | Static server or supervised app process | Fetch the public or project URL and confirm the expected revision |
| API | Release package, configuration, and any explicitly attached data | Supervised process and stable ingress | Call a declared health route and one contract example |
| Wiki / knowledge base | Pages, attachments, and revision history | Reader/search interface; dedicated process only if necessary | Reopen content after the producing run box stops |

Runtime data such as an API database and wiki edits belong to durable storage attached to the artifact home. A new release must not overwrite that data. Backups, retention, restore, and migration behavior must be specified before claiming production durability.

## States and user language

Run boxes have `requested`, `starting`, `ready`, `running`, `stopping`, `stopped`, and `failed` states. `ready` means the execution boundary and worktree were checked; a transport heartbeat alone does not prove an agent executed work.

Artifacts have `draft`, `publishing`, `available`, `degraded`, `stopped`, and `failed` states. `available` requires a successful server-side check appropriate to the artifact type. A registered URL or an agent-reported health value is not enough. Show the last check time and deployed revision. The current application contains no seeded replay or sample results.

## Access and safety boundaries

- Agent credentials authorize coordination actions. Publishing requires a separate scoped permission for a specific project and destination; a task assignment alone does not grant unrestricted access to artifact homes.
- Run box shell access is trusted access unless an execution boundary enforces restrictions. Artifact serving credentials, deployment credentials, and agent/model credentials remain separate.
- A publish operation accepts a declared package or repository revision. It does not expose artifact-home shell access to an agent by default.
- Development endpoints have no public ingress. Enforce organization and project boundaries at the network and access layers before describing them as private; a hidden dashboard link alone is not an access control.
- Public deployment requires authenticated administration, tenant isolation, transport security, secret management, and ingress controls. An artifact may allow public reading by explicit access policy. The current local app provides none of those production guarantees.
- Deleting a run box and retiring an artifact are separate explicit actions. Neither is a hidden side effect of task completion.

## Later publication sequence and acceptance

**First publication slice:** after the real two-agent execution loop works, publish a small site or API from an identified run box to a separately managed artifact home. The home may initially share a machine with a run box if separate storage, process supervision, access controls, and lifecycle behavior are demonstrated. State the actual boundary and do not infer isolation from separate paths alone.

Acceptance evidence:

1. An agent edits and tests a repository in an identified run box. Events show command start, result, and attribution.
2. Another agent discovers and consumes a temporary development service while both run boxes are active.
   The endpoint is unreachable from outside the authorized organization/project boundary.
3. A chosen artifact version is published with its source revision, owner, and deploy result recorded.
4. The producing run box is stopped or replaced. The artifact remains reachable and its durable data remains readable.
5. Restart the application and reconnect. The artifact record and live output still agree; a failed health check changes the displayed state.
6. A publish attempt without the required scope is denied. Secrets and tokens do not appear in activity or public state.

The current repository implements local coordination records and a CLI connection protocol. It does not provision run boxes, deploy artifact homes, supervise services, or verify endpoints. These acceptance items describe planned work, not current behavior.

## Open product decisions

- Who may approve a publication, and whether project owners can enable an agent to publish automatically for a named artifact.
- Default retention, backup, restore, and cost limits for artifact data and serving compute.
- Whether a wiki is edited directly in its durable home or published from repository content, and how concurrent edits merge.
