# AgentCloud resource graph and inference API proposal

## Purpose

AgentCloud should show how people, agents, run environments, scarce resources, services, and durable outputs relate. The graph is an operational view of real allocations and dependencies, not a decorative diagram or a substitute for verification.

The first graph can be a projection of ordinary persisted records. A graph database is unnecessary until queries or scale justify it. Every node and edge carries an organization/project scope, owner, lifecycle state, source of truth, and last verified time where applicable. Requested and reported relationships are visually distinct from verified ones.

The current UI projects only local project records and shows unlinked records separately. The proposed durable run, allocation, and verification records in [BACKEND_PLAN.md](BACKEND_PLAN.md) supply the first evidence-backed `runs_on`, `allocates`, and `can_access` edges. A request-to-resource edge remains a request even after a policy decision; the graph adds a separate allocation edge only after the worker records a real provider result.

## Resource model

| Node | Examples | Key state |
| --- | --- | --- |
| Identity | Employee, agent session, remote execution identity | Authenticated, active, revoked |
| Work | Project, task, run | Requested, running, complete, failed |
| Execution resource | CPU run box, GPU host, test box | Available, allocated, starting, ready, stopped, failed |
| Attachment | Private data source, shared workspace | Registered, reachable, access verified |
| Service | Development API, configurable inference API | Requested, starting, healthy, degraded, stopped |
| Durable output | Model package, site, API release, wiki | Draft, published, verified, retired |

Relations include `requested_by`, `authorized_by`, `runs_on`, `allocates`, `can_access`, `serves_model`, `consumes`, `produced_by`, and `published_to`. An allocation edge records the requesting identity, approving decision, task, start, expiry if enforced, and released time. A `can_access` edge is shown as verified only after a permitted operation succeeds; a denied attempt is an attributed event, not an access edge.

For the HackGT MVP, the graph needs only the real chain **employee → authorized task → agent run → remote run box → GPU → result**. It can be a compact dependency view backed by the same records as the dashboard. Two-agent edges, data sources, and artifact homes can appear when those capabilities actually work.

## Configurable inference API as a resource

An inference API is a service resource backed by compute. Its desired specification names the model source and immutable version, serving engine, GPU requirements, access scope, endpoint lifetime, and bounded runtime settings. A later advanced configuration may expose context length, quantization, batching, LoRA adapters, replica count, and scaling policy. Start with a small validated set of presets and retain the exact effective configuration for reproducibility.

The lifecycle is:

1. An authorized employee or agent requests a model endpoint for a project and task.
2. Policy reserves an available GPU allocation and checks model access and any enforced cost or duration limit.
3. A provider starts a real serving process in an identified run environment using a serving engine such as vLLM or Ray Serve LLM.
4. AgentCloud verifies process state, a health check, and one authenticated inference request. The endpoint becomes `healthy` only after that check succeeds.
5. Authorized agent runs discover and call the endpoint through private project access. Requests and responses are attributed without logging sensitive prompt or model credentials by default.
6. Stop or expiry shuts down the serving process, removes access, and releases the GPU allocation. The graph retains the historical dependency and evidence.

The API is an inference endpoint, not automatically a durable artifact home. A long-lived endpoint requires separate serving, storage, availability, and cost policies. Merely registering a URL or starting a process in a temporary run box is not publication.

## Boundary and proof

- AgentCloud controls allocation, identity, policy, private access, lifecycle, and provenance. The serving engine performs inference; AgentCloud need not implement model inference itself.
- The graph must not reveal private endpoints, credentials, model paths, or data-source details to unauthorized viewers.
- Do not claim low latency without measuring end-to-end request latency from the consuming run environment. Placement near a GPU or data source is an intent until verified.
- A private endpoint needs enforced network and request authorization. A hidden URL or project-scoped registry record alone does not make it private.
- A stopped endpoint must fail a new request, and its GPU allocation must be shown as released only after the provider confirms release.

## Stretch demonstration after the core MVP

After the single-agent GPU task in [MVP_SPEC.md](MVP_SPEC.md) passes, use the same known GPU host to start one small private inference API. Show its effective model configuration and graph dependencies; make a real authorized request from an agent run; deny an unauthorized request; stop the endpoint and verify that the GPU allocation is released. This is a stretch slice, not a prerequisite for the HackGT MVP.

The current repository projects saved project, task, agent, request, service, and handoff records into a graph view. It has no provisioning, serving, private ingress, verified allocation edge, or GPU execution. Its service registry stores reported HTTP(S) URLs only; inference API configurations are undeployed drafts.
