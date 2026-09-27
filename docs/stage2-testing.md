# Testing environments and Codex (Stage 1 + Stage 2)

This page describes how to verify environment provisioning, SSH access, Codex install and agent runs. Every check exercises real behavior; nothing is seeded into the running product. Status markers: ✅ verified on the integrated branch, 🔨 lane still in progress, ⏳ waiting on an owner action.

## 1. Automated checks (run on every change)

```bash
npm install && npm --prefix desktop install
npm run check            # TypeScript
npm test                 # backend, API and worker tests (includes the real-Docker integration test when Docker is running)
npm run tokens:check     # design tokens
npm run build            # production build
just desktop-verify      # desktop typecheck, tokens, tests, build
```

| Suite | What it proves |
| --- | --- |
| `tests/docker-sandbox.integration.test.mjs` (real Docker) | Builds the sandbox image; a job reaches `ready` only after pinned-host-key SSH. The device key logs in as `agentcloud`; an outsider key and root are denied. Codex 0.157.1, Node 22 and tmux are present; the Codex config uses the file store. A seeded `~/.codex/auth.json` and scratch files are gone before the container is removed. Stop removes the container. |
| `tests/ssh-connection-api.test.mjs` | Device key API (ed25519 only, idempotent, per-user). Connection API matrix: anonymous 401, non-member 403, not ready 409, no injected key 403 `no_authorized_key`. Listing fields. |
| `tests/agent-check.test.mjs` | Codex version and config checks, migrations, cleanup ordering (cleanup before removal; a failed cleanup never blocks removal), Runpod start script, Runpod cleanup before terminate. |
| `tests/agent-runs-api.test.mjs` | Run events: auth and membership matrix, origin rules, not-ready 409, sequence idempotency, bounds and truncation, a 200-event batch limit, ordering. |
| `tests/runpod-*.test.mjs` | Runpod adapter, pinned-key injection, operator-pin override, budget profile selection, local watchdog heartbeat (all against mocks). |
| `desktop/tests/*` | Device key encoding (matches `ssh-keygen`), deep-link parsing, host-key verifier, and a real sshd container terminal session. |

Result on the integrated Stage 2 branch after HAC-121, HAC-124 and HAC-126: `npm test` 158 tests, 157 pass, 0 fail, 1 skipped (a test that no longer applies). `check` and `tokens:check` pass. ✅

## 2. Local end-to-end (free): web → Docker sandbox → desktop

Use a separate data directory or worktree so test accounts stay out of your real install.

```bash
cp .env.example .env.local && echo BETTER_AUTH_URL=http://127.0.0.1:3012 >> .env.local
npm run auth:setup
npx next dev --hostname 127.0.0.1 --port 3012          # terminal 1
just worker-docker                                      # terminal 2 (builds agentcloud-sandbox:dev if needed)
AGENTCLOUD_URL=http://127.0.0.1:3012 just desktop       # terminal 3
```

1. Sign up at `/sign-up`. The verification link is in `.agentcloud/mail/*.json` (`text` field). Create an organization and a project with a public HTTPS repository.
2. **Sign in to the desktop app first.** Environments → "Device key registered".
3. On the web, open the project → **Environments** → **New environment** → **Local** (free) → **Local Docker sandbox** → **Create environment**. The environment reaches **Verified ready** in about 10 seconds. The card shows `agent.codex` ready (0.157.1).
4. Click **Open in desktop**. The terminal connects to `agentcloud@127.0.0.1:<port>`. Run `whoami` (should print `agentcloud`), `codex --version` (`codex-cli 0.157.1`) and `ls ~/workspace/repo`.
5. **Outsider denial:** `ssh -i <some other key> -p <port> agentcloud@127.0.0.1` fails with `Permission denied (publickey)`.
6. Click **Stop**. The container disappears (`docker ps --filter label=agentcloud.managed=docker-local`), and `run_box_cleanup_log` shows the Codex auth removal.

The scripted version of this flow (Playwright web + Electron + real Docker, 19 checks) passes. ✅

## 3. Codex in the environment (Stage 2) 🔨

This needs the HAC-122 (Codex panel) and HAC-123 (terminal and deep links) lanes. Once merged:

1. Open a ready environment in the desktop app → **Codex** tab.
2. **Sign in.** Preferred: **Sign in with device code**. The panel shows a URL and one-time code; approve it in your browser with your ChatGPT account. This may need "Sign in with Device Code" enabled in ChatGPT security settings. Fallback: **Use this Mac's Codex login**, which copies `~/.codex/auth.json` to the box and may sign out Codex on this Mac.
3. Send a prompt, for example "list the files in this repo and add a README section". The panel should stream Codex messages, the commands it runs with exit codes, and the files it changes.
4. **Command bar:** type `git status`. It appears and runs in the terminal's tmux session. Close and reopen the terminal and it reattaches with the earlier output.
5. **Web Runs page:** the same run appears with its events. **Open in desktop** from the run returns to the Codex panel, and **View on web** in the desktop app lands on the run.
6. **Export changes** saves a `.patch` locally. **Stop** removes the box, and the cleanup log shows `~/.codex/auth.json` absent before teardown.

## 4. Runpod GPU (costs money; supervised) ✅

Runs from `~/hackgt13`, whose Doppler scope can read `hackgt/dev`:

```bash
just runpod-local-check          # read-only: key resolves, lists pod count
just runpod-watchdog 10          # terminal A: deletes managed pods 10 min after creation
just worker-runpod-local         # terminal B: local-mode worker (allocates only while the watchdog heartbeats)
```

The web picker no longer offers Runpod profiles; the API still accepts `profileId: "runpod-budget-gpu"` (for example from a script with a signed-in session), and existing Runpod jobs keep their labels. For a budget run the worker picks the cheapest in-stock listed GPU at or below $0.50/hr. Verified live on 2026-09-26: RTX 2000 Ada, ready in about 45 s, desktop terminal ran `nvidia-smi` and `cuda True`, and Stop and the watchdog both deleted the pod.

## 5. AWS CPU environment ⏳🔨

HAC-125 delivers a plan-only Terraform change and `scripts/aws-cpu-smoke.mjs`. The owner has authorized apply and a real launch. Procedure:
1. Review `terraform -chdir=infra/aws plan` (additive only), then apply.
2. Run the smoke script. It allocates one CPU box through the worker, waits for ready, and runs `codex --version`, `whoami` and `tmux -V` over pinned SSH. It then terminates the instance and confirms it's gone, with a hard 20-minute self-destruct.
3. Repeat sections 2–3 with **New environment** → **CPU** → **Small** (`aws-cpu`, t3.medium). The picker also lists CPU Medium and Large and GPU T4, L4 and A10G sizes from `lib/machine-catalog.mjs`, with a disk choice (GPU sizes start at 50 GiB) and a dated hourly estimate; each size needs its own backend and Terraform support before it can launch.

Guards: the $25 per month budget action blocks worker launches (HAC-115), and the expiry Lambda terminates tagged instances at their deadline.

## What is not yet verified

- The Codex panel, tmux command bar and deep-link race fix (HAC-122, HAC-123).
- An AWS launch (HAC-125).
- A live ChatGPT device sign-in (needs the owner's approval in a browser).
- Save work on Stop (HAC-127).
