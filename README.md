# AgentCloud

A token-based React web application laying the coordination foundation for agent-usable remote computers. The planned product gives an agent a persistent project environment that can reach resources such as an SSH-accessible GPU host, and lets the human observe its real work. The GPU host may be the agent's environment or a separate target. Multiple agents, shared services, handoffs, and durable artifact homes build on that core. This build does not connect to remote machines or provision run boxes or artifact homes.

Built with Next.js 16, React 19, and TypeScript. The supplied HTML design exports are preserved in `reference/` as visual inspiration only; the application implements its own reusable token system and does not load their fictional data.

## Run locally

Use Node.js 22 LTS and npm.

```sh
npm install
test -e .env.local || cp .env.example .env.local
npm run auth:setup
npm run dev
```

With [just](https://github.com/casey/just) installed, the equivalent shortcut is `just setup` once, then `npm run auth:setup`, and run `just` (or `just dev`). Run `just --list` to see the other recipes, including `just verify` for all repository checks and a production build. `just setup` preserves an existing `.env.local`.

### Run with Doppler

The repository's `doppler.yaml` selects the shared `hackgt` project and `dev` config. You need access to that specific Doppler project and config. [Install and log in to the Doppler CLI](https://docs.doppler.com/docs/install-cli), then run these commands **in each worktree** (Doppler scopes its selection to a directory):

```sh
npm ci
doppler setup --no-interactive
just auth-setup-doppler
just dev-doppler
```

Without `just`, use `doppler run -- npm run auth:setup` and `doppler run -- npm run dev`. Doppler injects values into those processes; no `.env.local` is needed for this path. If `.env.local` already exists, process environment variables supplied by Doppler take precedence. Use `doppler secrets --only-names` to check names without printing values.

The shared `dev` config contains a stable `BETTER_AUTH_SECRET` of at least 32 characters for local testing and `AGENTCLOUD_URL` for desktop/CLI clients to reach the shared AWS app. Keep the same auth secret alongside the same local `.agentcloud` data directory across restarts; changing configs or secrets invalidates existing sessions. Each developer has a separate local database, so access to the secret does not create an account or copy another developer's users. The auth setup command generates a secret in `.env.local` only when one is not supplied. `BETTER_AUTH_URL` is optional and defaults to `http://127.0.0.1:3000`. `AGENTCLOUD_DATA_DIR` optionally selects a persistent data directory; otherwise each worktree uses its own `.agentcloud` directory. AWS auth staging uses a separate secret from `dev_personal` and AWS Secrets Manager; see [AWS_AUTH_STAGING.md](AWS_AUTH_STAGING.md).

A fresh checkout can run the web app, API, and Better Auth locally with the shared Doppler `dev` secret; no AWS account or AWS credentials are required. This was exercised from a clean worktree with signup, captured-email verification, sign-in, session persistence across a server restart, and organization/project access. Each install stores its own accounts and project data; an account created on another install, including AWS staging, is not copied locally. A teammate can use an existing account only by connecting to the same running app and database. The Doppler setup does not create a shared endpoint; the separate [AWS shared app deployment](AWS_AUTH_STAGING.md) uses CloudFront to let teammates reach one EC2-hosted app without AWS credentials. A remote AWS or Runpod machine for agent work is a separate compute endpoint.

For the shared account, open the `AGENTCLOUD_URL` from Doppler in a browser, or run `just desktop-doppler` after `just desktop-setup`. The local Next.js server started by `just dev-doppler` still uses its own database; setting `AGENTCLOUD_URL` does not redirect that server's routes to AWS. The CloudFront hostname remains stable through EC2 restarts but must be updated in Doppler if the Terraform distribution is replaced.

### Docker backend simulation (no AWS)

With Docker running, use `just sim-up`, then `just dev-docker`. The frontend is at `http://127.0.0.1:3001` and the isolated backend at `http://127.0.0.1:3002`. Both use the same container database. To change the backend port, set `AGENTCLOUD_SIM_PORT` consistently for both commands. `just sim-status` shows container health, `just sim-check` probes the backend, and `just sim-logs` follows recent logs. This mode deliberately ignores the shared AWS URL, requires no Doppler or AWS credentials, and does not provision cloud compute. The container uses Next’s development runtime and runs the real account, organization, project, and resource APIs; GPU/EC2 execution is not simulated as successful.

The simulation starts empty. Sign up with a new local account; AWS accounts are not copied. Verification emails are captured privately in the data volume. To retrieve your own link, run `docker compose exec backend node scripts/docker/mail-link.mjs your@email.com`. Open the link on port 3002 and then sign in on port 3001. The command prints a sensitive, expiring verification link; do not share it in logs or tickets.

The Compose volume keeps accounts, sessions, projects, mail, and an automatically generated auth secret across container restarts. `just sim-down` stops the container without deleting this data. Do not use `down --volumes` unless you intend to erase the simulation. Ports bind only to loopback. The image excludes local secrets, databases, and Terraform state.

[Local Terraform](infra/local/README.md) describes the same backend as an alternative to Compose. Its Docker resources use separate names and data. Existing [AWS app Terraform](infra/aws-auth/README.md) and [AWS GPU Terraform](infra/aws/README.md) remain separate roots. Validation is not provisioning; this workflow does not run any AWS apply or deploy command.

### Local Docker sandbox worker (no cloud spend)

The `docker-local` provider with server-owned profile `local-docker-sandbox` runs a CPU-only Linux container with sshd on the machine running the worker. It has no GPU and costs nothing. SSH access is trusted shell access as the non-root `agentcloud` user; it is not a filesystem or command sandbox.

Run `just sandbox-image` once (the worker also builds `agentcloud-sandbox:dev` from `infra/sandbox/` when it is absent), then `just worker-docker` alongside `just dev`. The worker loads `.env.local` with `node --env-file-if-exists`, so it opens the same `AGENTCLOUD_DATA_DIR` (default `.agentcloud/auth.sqlite` in the repository root) as the app; with Doppler use `doppler run -- just worker-docker`. Every 3 seconds it removes containers for stopped, failed, or unknown jobs, requests stop for expired sandboxes, and processes one queued or stopping job.

For each job the worker generates a pinned ed25519 host key and a one-time verification key in a private temporary directory, starts `agentcloud-sandbox-<jobId>` with a random `127.0.0.1` port, 2 GB memory, 2 CPUs, a PID limit, and dropped capabilities, and records the SSH endpoint. The job becomes `ready` only after SSH with strict host-key checking confirms the account and `~/workspace` (and, when the approved job has a repository URL, clones it to `~/workspace/repo` and records the revision), the verification key has been removed, and that key is refused. Only registered device keys of project members at allocation time remain authorized; with none registered, the job fails with a clear reason. Keys registered later need a new sandbox. The host private key is passed to Docker through the environment, so anyone with Docker access on the worker machine can read it with `docker inspect`. At most one active local sandbox per project is allowed.

### Local frontend with shared AWS data

Run `just dev-aws` (or `doppler run --project hackgt --config dev -- npm run dev:aws`) to serve the local frontend at `http://127.0.0.1:3001` against the shared `AGENTCLOUD_URL`. Sign in with an existing verified AWS account. Authentication, organizations, projects, resource requests, run-box controls, and live events go to that backend; mutations affect shared data. No AWS credentials, local auth setup, or copied database are required.

The launcher explicitly enables `AGENTCLOUD_REMOTE_BACKEND_URL`; ordinary `just dev` and `just dev-doppler` remain self-hosted. The loopback-only bridge forwards API requests and server-rendered identity checks together, with backend-scoped session cookies separate from local self-hosted sessions. It rejects nonlocal hosts and cross-origin browser requests and fails closed on upstream errors. It does not enable public proxy hosting. Verification email links belong to the AWS origin; public signup still requires SMTP there. The public AWS website needs a separate deployment of the committed frontend revision via `scripts/aws-auth/deploy.sh` by an AWS operator.

Email defaults to local capture with no Doppler mail keys. For SMTP, set `AGENTCLOUD_MAIL_MODE=smtp`, `SMTP_HOST`, `SMTP_FROM`, and, if required by the provider, `SMTP_USER` and `SMTP_PASSWORD`. `SMTP_PORT` defaults to 587; set `SMTP_SECURE=true` for implicit TLS, usually on port 465. Keep all secret values and Doppler tokens out of Git. The existing `.env.local` setup remains available.

### Doppler MCP for coding assistants

Doppler also publishes an [experimental MCP server](https://github.com/DopplerHQ/mcp-server) for assistants that need to manage Doppler through its API. This is separate from the CLI path above; the app itself reads environment variables supplied by `doppler run` and does not use MCP. Install the MCP server in your assistant's **personal** MCP settings, not in this repository. For an MCP client that accepts `mcpServers` JSON, the server entry is:

```json
{
  "doppler": {
    "command": "npx",
    "args": ["-y", "@dopplerhq/mcp-server", "--read-only", "--project", "hackgt", "--config", "dev_personal"]
  }
}
```

This is the entry under the client's `mcpServers` object. Authenticate locally with `npx @dopplerhq/mcp-server login`, or configure a config-scoped read-only service token in the MCP client's private settings. A token with broader access remains broad even when `--project` and `--config` are specified; those flags only narrow the tools shown by the server. Remove `--read-only` only when the assistant must change Doppler configuration. Never paste token or secret values into prompts, logs, or tracked MCP settings.

Open http://127.0.0.1:3000. For a local production build:

```sh
npm run build
npm start
```

The development and production scripts bind to loopback. This is a local organization-aware demo with employee login, but no production tenant isolation; do not expose it publicly as a multi-user service.

## Employee authentication (HAC-1)

Authentication uses self-hosted Better Auth and local SQLite. `npm run auth:setup` generates a random secret in the ignored, owner-readable `.env.local` if absent and applies auth and organization migrations. Preserve the secret and data directory across restarts. The server fails closed without its secret. The default origin is `http://127.0.0.1:3000`; set `BETTER_AUTH_URL` when changing it.

1. Open `/sign-up`, create an account, and verify your email.
2. Sign in and create an organization at `/organizations`. Its creator is the owner.
3. Invite a teammate as a member or admin. They sign in with the invited, verified email and accept the invitation.
4. Owners and admins can create and manage all organization projects. Members see only projects explicitly assigned to them. Removing a member or leaving the organization clears their project assignments; joining again requires fresh assignments.

Email defaults to local capture: messages are written to private JSON files in `.agentcloud/mail` (or `AGENTCLOUD_DATA_DIR/mail`). Open the verification or invitation link in the message's `text` field. Nothing is sent to a real inbox in this mode, even where the verification screen says to check email. Local capture is restricted to loopback origins. These files contain sensitive links: do not commit or share them.

For real delivery, set `AGENTCLOUD_MAIL_MODE=smtp`, `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_FROM`, and the provider's `SMTP_USER` and `SMTP_PASSWORD` in `.env.local`. Set `SMTP_SECURE=true` for implicit TLS, typically port 465. Restart the server after changing configuration. SMTP submission does not guarantee inbox delivery. Real recipients need a reachable application origin; a localhost link works only on the machine running the app. Public deployment still requires production hardening.

Invitations expire after 48 hours. Reissuing creates a new invitation and cancels the old link; revoked, declined, and expired invitations cannot be accepted. The UI distinguishes locally captured messages from SMTP submissions. Ownership can be assigned separately by an owner; the last owner cannot be removed or demoted.

Existing pre-organization projects remain hidden until their recorded owner moves them into an organization using the organization page. Adoption clears previous project assignments except the adopting owner's; organization members need an explicit new project grant. Organization owners and admins can access every project in their organization. `auth:bootstrap` remains an optional administrative helper for two accounts and legacy project memberships; it does not replace verification or organization membership. Supply its `AGENTCLOUD_EMPLOYEE1_EMAIL`, `AGENTCLOUD_EMPLOYEE2_EMAIL`, and corresponding `_PASSWORD` variables privately; never commit credentials. Existing passwords are preserved.

All human state, event, and resource routes require verified cookie sessions and organization/project access. Agent CLI bearer tokens remain separate and work only on `/api/agent`. Sign-out invalidates the session; open event streams recheck sessions and memberships every tick. Sessions last seven days. SQLite stores users, sessions, organizations, invitations, memberships, and AWS organization approvals; JSON retains coordination data. Back up both stores and the secret together. Project creation spans both stores without a transaction, so an interrupted write can require administrative repair. This is not production tenant isolation, enterprise SSO, general resource approval policy, or SSH enforcement.

Set `AGENTCLOUD_PLATFORM_ADMIN_EMAIL` to the exact email of a verified AgentCloud account in the server's private environment, then restart the server. Only that account can open `/admin/aws` and call `/api/admin/aws-approvals`. New organizations start without managed AWS access. The operator can approve or revoke access, choose a one- or two-hour maximum run, and reserve 1 to 20 hours of AWS run time per UTC month. Approved AWS decisions reserve their full requested duration, including runs that end early. Revocation or a limit change invalidates queued jobs before EC2 allocation. Local Docker and Runpod decisions are unaffected. This is a compute-time allowance, not a dollar cap: EBS, network, taxes, and AWS billing delay remain outside it. The account-wide AWS budget action and expiry guard remain separate safeguards.

Run `npm test`, `npm run check`, `npm run tokens:check`, and `npm run build`. Authentication tests use temporary databases and generated passwords; they do not populate the running product. After `npm run build`, run `npm run test:auth:browser` with Google Chrome installed and port 3100 free for headless 375/768/1440px checks. The browser check creates a temporary database, exercises both identities and a server restart, and saves screenshots under ignored `artifacts/`.

## What works and what remains to build

The backend stores project, agent, task, service, handoff, resource catalog, resource request, inference draft, and event records on local disk. Agent credentials are stored as hashes and scoped to a project and identity. A CLI client can establish a real coordination connection. Browser views receive state updates through server-sent events.

The Requests form can save a one- or two-hour preference for the small `g6.xlarge` GPU demo profile and shows a dated AWS compute-price estimate. A verified employee with project membership submits it; the server records that employee, organization, and effective project role. This is a planning quote only; storage, network, and taxes are excluded, GPU quota may be unavailable, and the requested duration is not enforced. Saving the request still makes no policy decision and launches no machine. A future worker must recheck authorization, re-price, and enforce expiry before allocation.

The application starts empty. Create a project, add agent identities, and connect clients to populate actual coordination records. There are no seeded projects, agent fixtures, or replay controls. Review provides working handoff records and explicitly empty Changes and Checks panels for future Git diffs and test execution. The application does not launch Codex or Claude, provision a server, clone a repository through the product flow, create worktrees through the product flow, run tests, or merge changes. A local Git provider library exists but is not wired to the API or UI. A newly created project saves setup metadata; compute provisioning remains pending.

The **Environments** screen (`/projects/:id/environments`, first in the project control plane) is the one-step provisioning flow from [docs/sandbox-mvp-contract.md](docs/sandbox-mvp-contract.md). A project owner chooses **New environment**, a server-owned profile (Local Docker sandbox, Runpod RTX 4090, or the AWS EC2 g6 demo), and a one- or two-hour limit. `POST /api/run-boxes` with `{ projectId, profileId, durationHours, idempotencyKey }` records the resource request and the `runbox-v1` decision together and queues one job; a member's request is recorded and denied. The page polls `GET /api/run-boxes?projectId=` and labels each job as requested (queued), provisioning (allocating, connecting, verifying), verified ready, stopping, stopped, or failed. Nothing runs until a worker claims the job, and **Open in desktop** and the SSH command appear only when the listing supplies them. SSH is labelled trusted shell access. Stop is confirmed inline and uses the existing stop route. The Local Docker sandbox is refused until the `docker-local` provider is available in the run-box job store.

The project control plane also includes Resources, Requests, Runs, Graph, and Inference screens. A catalog entry is registered metadata, not connected capacity. A request is persisted with policy `not_evaluated`; it is neither approved nor allocated. Inference configurations are drafts only. Runs show actual stored coordination events and transport heartbeats, with command results empty until a real runner sends them. The graph projects persisted relationships and does not imply a verified allocation.

The target HackGT MVP is employee login, a real remote run environment, server-enforced resource permission, one agent completing a GPU task, and a control surface mirroring actual work. Two-agent collaboration is a later extension. This repository does not yet fulfill the MVP. See [MVP_SPEC.md](MVP_SPEC.md) and [ROADMAP.md](ROADMAP.md) for concrete acceptance gates.

The proposed backend uses one provider-neutral run-box contract: attach an existing SSH GPU host first when available, then implement EC2 as the first managed provider. [BACKEND_PLAN.md](BACKEND_PLAN.md) defines the records, worker, lifecycle, verification gates, and AWS decisions. AWS resources are managed through [Terraform](infra/aws/); the current app does not launch boxes.

## Explore the application

- **Projects:** saved projects and project creation.
- **Project setup:** name, repository, template, and intended hosted/SSH compute.
- **Project dashboard:** agent roster, assigned tasks, services, handoffs, and activity.
- **Agent setup:** create an identity and obtain a scoped connection token.
- **Review:** inspect and accept handoffs; Changes and Checks describe pending infrastructure.
- **Desktop:** CLI connection workflow in the web app; a separate Electron shell for Tasks, Environments, and Project chat lives in [`desktop/`](desktop/) (`just desktop`). See [`desktop/README.md`](desktop/README.md).
- **Environments:** request a time-limited environment in one step, follow its verified state, copy the SSH command, open it in the desktop app, and stop it.
- **Resources:** register and inspect intended resource metadata and its unverified availability.
- **Requests:** save resource requests and inspect the explicit unavailable policy decision.
- **Runs:** inspect real attributed events, task state, and heartbeat separately from model execution.
- **Graph:** inspect relationships derived from saved tasks, agents, requests, services, and handoffs.
- **Inference:** save a model, hardware, scope, and lifetime draft without deploying a service.

For a local coordination walkthrough, create a project and two agent identities, connect each CLI with its own credential, assign tasks, register an endpoint you operate, and send a handoff to the second identity. Observe the resulting activity and saved records, then reopen the project. This demonstrates coordination; real remote execution and the GPU demo remain pending.

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
| [AWS_SETUP.md](AWS_SETUP.md) | Live AWS GPU demo preflight, Terraform workflow, spending policy, quota request, and launch gates |
| [AWS_AUTH_STAGING.md](AWS_AUTH_STAGING.md) | Private EC2 staging deployment, SSM tunnel, and Better Auth verification workflow |
| [ROADMAP.md](ROADMAP.md) | Dependency-ordered delivery phases and acceptance gates |
| [VERIFICATION.md](VERIFICATION.md) | Recorded check results, remaining verification, and browser-tool limitations |
| [AGENTS.md](AGENTS.md) | Contributor rules for design, testing, collaboration, and truthful capabilities |
| `app/` | Next.js routes, UI, API handlers, and application styling |
| `lib/` | Shared types, initial empty state, and persisted coordination state |
| `cli/` | Node.js agent coordination client |
| `desktop/` | Electron Tasks + Project chat shell (see desktop/README.md) |
| `scripts/` | Repository checks, including token enforcement |
| `tests/` | Backend behavior and authorization verification |
| `reference/` | Original supplied prototype exports |

## Next implementation milestone

Add transactional run/decision records and server-side resource policy, attach or create a real Linux run environment, and execute one real agent GPU task while mirroring its work. Demonstrate an allowed and a denied resource action at the execution boundary. Keep API authorization separate from shell isolation: an unrestricted SSH connection is trusted access until the execution boundary enforces stronger restrictions. Add a second agent and artifact publication in later phases.

### Dropdown interaction verification

After `npm run build`, run `npm run test:select:browser` to exercise themed dropdown keyboard navigation, form values, required validation, dialog menus, navigation states, and responsive bounds in headless Chrome. It uses temporary accounts/data and port 3162, then removes its test data. The shared dropdown also has an interactive specimen at `/design-system#components`.

On **People & organizations**, choose **New organization** to open the creation dialog. Cancel or Escape closes it without creating an organization; successful creation refreshes the organization list.

Website navigation uses one shared vertical sidebar for projects, organization management, project views, and the design reference. On narrow screens, **Open navigation** opens a keyboard-accessible drawer. Project view links have durable URLs; organization changes refresh the available project links.

After `npm run build`, run `npm run test:motion:browser` to verify Motion entrances, inline-style cleanup, notification positioning, drawer/dropdown behavior, and reduced-motion preferences in headless Chrome at 375, 768, and 1440 pixels. It uses isolated temporary accounts and port 3183.
