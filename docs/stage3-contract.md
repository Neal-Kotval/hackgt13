# Stage 3 contract: Codex app-server sessions on remote environments (HAC-153)

Status: in progress. This extends main's server-side Codex sessions (`lib/codex-sessions.mjs`, `lib/codex-docker.mjs`, Project chat) so a session can run Codex on a remote environment (a run box) instead of only in local Docker. It builds on Stage 2 (`docs/stage2-contract.md`): every environment has Codex 0.157.1, a pinned host key and a recorded `workspacePath`.

Decisions:
- **Protocol:** `codex app-server` (JSON-RPC over stdio), the same protocol and client for local Docker and SSH.
- **Sign-in:** ChatGPT device code through the protocol (`account/login/start {type: "chatgptDeviceCode"}`), surfaced in the desktop app. Usage bills to the employee's ChatGPT plan. The owner has ChatGPT Pro, so there is no access-token path (access tokens are Business/Enterprise only).
- **Who opens SSH:** the backend, never the desktop. The desktop only calls the session API.

## Session target

`codex_session` gains `run_box_id TEXT NULL`: null means local Docker, as today. A session is unique per `(project_id, agent_id, run_box_id)`.

```
POST /api/codex-sessions { projectId, agentId, runBoxId? }  -> 202 { session }
```

- With `runBoxId`, the environment must be in the same project, `ready`, with `agent.codex.state === "ready"`; otherwise 409 with a reason.
- Owner-only, as today.
- `GET /api/codex-sessions?projectId=` returns each session with `target: { kind: "local" } | { kind: "runBox", runBoxId, provider, profileId, state }`.
- All other routes (turns, interrupt, login, snapshot) are unchanged. They act on whichever target the session has.

## Runtimes

- `lib/codex-rpc.mjs` (new): the JSON-RPC stdio client extracted from `createCodexDockerRuntime`, unchanged in behavior. That covers the 2 MiB frame limit, answering server requests with a decline or not-supported error, never passing on server error text, and the EOF-then-kill shutdown. `codex-docker.mjs` uses it.
- `lib/codex-ssh.mjs` (new): `createCodexSshRuntime({ sessionId, runBoxId, onNotification, onExit })` runs the system `ssh`:
  ```
  ssh -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
      -o UserKnownHostsFile=<temp 0600 file from run_box_ssh_endpoint> -i <server key> -p <port> \
      agentcloud@<host> 'cd <workspacePath> && exec codex app-server'
  ```
  - The pinned known_hosts file is written from `run_box_ssh_endpoint` and deleted when the runtime closes.
  - A host-key mismatch or refused key maps to a clear session error.
  - Stop and close use the shared client's EOF-then-kill sequence.
- `lib/codex-service.ts` picks the runtime per session: `run_box_id ? createCodexSshRuntime : createCodexDockerRuntime`. `AGENTCLOUD_CODEX_ENABLED=1` gates local Docker only; remote sessions need a ready environment.

## Server SSH identity

- `lib/codex-runner-key.mjs` (new): one ed25519 key per install at `<AGENTCLOUD_DATA_DIR>/codex-runner/id_ed25519`. The directory is 0700 and the files 0600. It's generated with `ssh-keygen` on first use and never logged or returned by any API.
- At allocation, every provider (docker-local, runpod, aws-cpu) adds this public key to the environment's `agentcloud` authorized keys, next to the members' device keys. Its fingerprint is recorded in `run_box_ssh_endpoint.authorized_fingerprints`, tagged as the server key. Environments created before this change don't have it, so a remote session reports "Create a new environment to use Codex on it."

## Desktop (Project chat)

- **Target picker:** "Local Codex box" plus each ready environment of the project whose `agent.codex.state` is `ready`. Choosing one opens or creates that target's session.
- **Sign-in:** if the target's Codex is signed out, Project chat shows **Sign in with ChatGPT**. It calls the existing login route, shows `userCode` large with a copy button, and opens `verificationUrl` (only `https://auth.openai.com/…`) in the system browser. It then waits for `account/login/completed`.
- **Deep links:** `agentcloud://open?projectId&runBoxId&panel=codex` opens Project chat targeting that environment. The Environments "Open Codex" action does the same.
- **One Codex UI:** the Stage 2 Codex panel (HAC-122) is removed from the Environments view in favor of Project chat. Its main-process code is no longer reachable from the UI; delete it if unused.

## Cleanup

- Stage 2 teardown already removes `~/.codex/auth.json` from the box.
- Closing a remote session ends the SSH process and deletes its temporary known_hosts file.
- Stopping an environment closes any sessions targeting it and marks them `error` with "Environment stopped".

## Acceptance

Real AWS CPU box:
- Project chat, targeting the box, signs in with a device code approved by the owner.
- A turn runs a command and writes a file in `workspacePath`, and interrupt works.
- The web Runs page and session history show it.
- Stopping the environment closes the session, the box's `auth.json` is gone before termination, and no SSH processes are left on the server.

Automated:
- Unit tests for the shared client, the SSH runtime, target selection and validation.
- A real-Docker integration test: a docker-local sandbox session over SSH, where `codex app-server` initializes and device-code start returns a URL and code (never approved).
