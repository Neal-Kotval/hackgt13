# AgentCloud

A token-based React web application laying the coordination foundation for agent-usable remote computers. The planned product gives an agent a persistent project environment that can reach resources such as an SSH-accessible GPU host, and lets the human observe its real work. The GPU host may be the agent's environment or a separate target. Multiple agents, shared services, handoffs, and durable artifact homes build on that core. This build does not connect to remote machines or provision run boxes or artifact homes.

Built with Next.js 16, React 19, and TypeScript. The supplied HTML design exports are preserved in `reference/` as visual inspiration only; the application implements its own reusable token system and does not load their fictional data.

## Run locally

Use Node.js 22 LTS and npm.

```sh
npm install
cp .env.example .env.local
npm run dev
```

With [just](https://github.com/casey/just) installed, the equivalent shortcut is `just setup` once, then `just` (or `just dev`). Run `just --list` to see the other recipes, including `just verify` for all repository checks and a production build. `just setup` preserves an existing `.env.local`.

Open http://127.0.0.1:3000. For a local production build:

```sh
npm run build
npm start
```

The development and production scripts bind to loopback. This is a single-user local application with no human login or tenant isolation; do not expose it publicly as a multi-user service.

## What works and what remains to build

The backend stores project, agent, task, service, handoff, resource catalog, resource request, inference draft, and event records on local disk. Agent credentials are stored as hashes and scoped to a project and identity. A CLI client can establish a real coordination connection. Browser views receive state updates through server-sent events.

The application starts empty. Create a project, add agent identities, and connect clients to populate actual coordination records. There are no seeded projects, agent fixtures, or replay controls. Review provides working handoff records and explicitly empty Changes and Checks panels for future Git diffs and test execution. The application does not launch Codex or Claude, provision a server, clone a repository through the product flow, create worktrees through the product flow, run tests, or merge changes. A local Git provider library exists but is not wired to the API or UI. A newly created project saves setup metadata; compute provisioning remains pending.

The project control plane now includes Resources, Requests, Runs, Graph, and Inference screens. A catalog entry is registered metadata, not connected capacity. A request is persisted with policy `not_evaluated`; it is neither approved nor allocated. Inference configurations are drafts only. Runs show actual stored coordination events and transport heartbeats, with command results empty until a real runner sends them. The graph projects persisted relationships and does not imply a verified allocation.

The target HackGT MVP is employee login, a real remote run environment, server-enforced resource permission, one agent completing a GPU task, and a control surface mirroring actual work. Two-agent collaboration is a later extension. This repository does not yet fulfill the MVP. See [MVP_SPEC.md](MVP_SPEC.md) and [ROADMAP.md](ROADMAP.md) for concrete acceptance gates.

The proposed backend uses one provider-neutral run-box contract: attach an existing SSH GPU host first when available, then implement EC2 as the first managed provider. [BACKEND_PLAN.md](BACKEND_PLAN.md) defines the records, worker, lifecycle, verification gates, and AWS decisions. This is planning documentation; the current app does not launch boxes.

## Explore the application

- **Projects:** saved projects and project creation.
- **Project setup:** name, repository, template, and intended hosted/SSH compute.
- **Project dashboard:** agent roster, assigned tasks, services, handoffs, and activity.
- **Agent setup:** create an identity and obtain a scoped connection token.
- **Review:** inspect and accept handoffs; Changes and Checks describe pending infrastructure.
- **Desktop:** instructions for the CLI connection workflow; native packaging is deferred.
- **Resources:** register and inspect intended resource metadata and its unverified availability.
- **Requests:** save resource requests and inspect the explicit unavailable policy decision.
- **Runs:** inspect real attributed events, task state, and heartbeat separately from model execution.
- **Graph:** inspect relationships derived from saved tasks, agents, requests, services, and handoffs.
- **Inference:** save a model, hardware, scope, and lifetime draft without deploying a service.

For a local coordination walkthrough, create a project and two agent identities, connect each CLI with its own credential, assign tasks, register an endpoint you operate, and send a handoff to the second identity. Observe the resulting activity and saved records, then reopen the project. This demonstrates coordination; employee login, real remote execution, and the GPU demo remain pending.

## Connect a real coordination client

Create a project, add an agent in the web UI, and copy the one-time credential. Use the project and agent IDs shown in the connection instructions. Keep the token out of shell history by reading it interactively:

```sh
read -s AGENTCLOUD_TOKEN
export AGENTCLOUD_TOKEN
node cli/agentcloud.mjs connect PROJECT_ID --agent AGENT_ID
```

Paste the token at the `read` prompt and press Return. The command connects and sends a heartbeat every 15 seconds; stop it with Ctrl+C. Add `--once true` for a single connection request. This client connects to the coordination API; it does not launch a model or open a remote shell.

In a terminal with the same token environment, fetch context or publish collaboration records:

```sh
node cli/agentcloud.mjs context PROJECT_ID --agent AGENT_ID
node cli/agentcloud.mjs service PROJECT_ID --agent AGENT_ID --name listings-api --url http://127.0.0.1:4000
node cli/agentcloud.mjs task PROJECT_ID --agent AGENT_ID --task TASK_ID --status 'in progress'
node cli/agentcloud.mjs handoff PROJECT_ID --agent AGENT_ID --to RECIPIENT_ID --title 'API contract ready' --summary 'Listings endpoint documented' --files api/routes.ts,docs/api.md --next 'Build the listings view'
```

Replace the uppercase IDs with actual values. Service registration stores a reported endpoint without starting or probing it. Only the owner can update an agent task; its dependency must be complete before starting or completing it.

The CLI defaults to `http://127.0.0.1:3000`. Override with `AGENTCLOUD_URL`; nonlocal URLs require HTTPS. The CLI reads its environment directly, so values in Next.js `.env.local` are not automatically loaded into the CLI shell. Set `AGENTCLOUD_TOKEN` separately for each agent identity and run `unset AGENTCLOUD_TOKEN` when finished.

## Persistence

By default, state is stored in `.agentcloud/state.json`, beneath the application working directory. `AGENTCLOUD_DATA_DIR` can point to a different writable directory. Keep this directory on persistent storage if running the app in a container. It contains private project metadata and credential hashes and should not be committed. Fresh storage starts empty; existing saved projects are preserved, not automatically deleted or migrated into demo content.

Agent connections are shown as disconnected after 45 seconds without a heartbeat.

The store is designed for one Node.js application process. It is not a shared database for multiple replicas. Workspace files, installed packages, repository clones, and running remote services are outside its current persistence boundary. Published artifact storage and serving are also not implemented; see [FEATURE_SPEC.md](FEATURE_SPEC.md) for the planned lifecycle.

## Checks

```sh
npm run check
npm test
npm run tokens:check
npm run build
```

The token check enforces the visual-system rules; it does not replace visual inspection. After UI changes, use Playwright MCP headlessly so checks do not focus the user's browser tab. Exercise the changed flows and inspect explicit 375px, 768px, and 1440px viewports. Report observed results rather than assuming a successful build proves the UI works.

## Repository guide

| File or directory | Purpose |
| --- | --- |
| [PRODUCT.md](PRODUCT.md) | Product workflows, scope, trust boundaries, and demo success criteria |
| [MVP_SPEC.md](MVP_SPEC.md) | HackGT employee-login, remote-GPU, permission, and control-surface demo contract |
| [RESOURCE_GRAPH_SPEC.md](RESOURCE_GRAPH_SPEC.md) | Proposed resource dependency graph and private inference API stretch |
| [FEATURE_SPEC.md](FEATURE_SPEC.md) | Planned run-box and artifact-home lifecycles and acceptance |
| [DESIGN.md](DESIGN.md) | Visual system, token rules, component patterns, and responsive behavior |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Application, storage, API, CLI, and future infrastructure boundaries |
| [BACKEND_PLAN.md](BACKEND_PLAN.md) | Proposed identity, worker, run-box provider, events, and EC2 implementation contract |
| [ROADMAP.md](ROADMAP.md) | Dependency-ordered delivery phases and acceptance gates |
| [VERIFICATION.md](VERIFICATION.md) | Recorded check results, remaining verification, and browser-tool limitations |
| [AGENTS.md](AGENTS.md) | Contributor rules for design, testing, collaboration, and truthful capabilities |
| `app/` | Next.js routes, UI, API handlers, and application styling |
| `lib/` | Shared types, initial empty state, and persisted coordination state |
| `cli/` | Node.js agent coordination client |
| `scripts/` | Repository checks, including token enforcement |
| `tests/` | Backend behavior and authorization verification |
| `reference/` | Original supplied prototype exports |

## Next implementation milestone

Add transactional run/decision records, employee login and server-side policy, attach or create a real Linux run environment, and execute one real agent GPU task while mirroring its work. Demonstrate an allowed and a denied resource action at the execution boundary. Keep API authorization separate from shell isolation: an unrestricted SSH connection is trusted access until the execution boundary enforces stronger restrictions. Add a second agent and artifact publication in later phases.
