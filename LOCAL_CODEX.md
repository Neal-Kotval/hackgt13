# Test Codex through a standard environment

The product runs Codex inside a selected execution environment. Project chat uses
the same backend SSH transport, readiness checks, sign-in, and session history for each
supported environment. There is no separate website workflow for creating a local
Codex agent.

For development, a Docker CPU sandbox stands in for a remote machine. It appears
in the ordinary Environments list and uses the same desktop connection path.
Its provider remains `docker-local`; this test does not claim AWS or GPU execution.

## Run locally

With Node 22 and Docker available:

1. Start the normal local website/backend (`just setup`, then `just dev`). Keep
   existing installations on their original data directory and auth secret.
2. Run `just worker-docker` against that same `AGENTCLOUD_DATA_DIR`. It builds the
   pinned sandbox image when needed and processes environment requests.
3. Sign into desktop using that website URL. Desktop registers its device SSH key.
4. In website **Environments**, create a **Local Docker sandbox · CPU only** using
   the existing environment form. A project owner approves allocation; the worker
   must verify SSH and report the actual Codex check before it is usable.
5. After the environment is ready, open website **Settings**, choose **Add Codex**,
   then **Sign in with ChatGPT** if needed. Desktop connects the environment's
   callback tunnel and opens standard ChatGPT browser login. No device code or
   connection token is needed. Keep desktop running and signed into the same
   website. When authorization completes, open chats in desktop; **Open in desktop**
   remains available if the browser blocks the application handoff.
6. Desktop selects that environment. Create independent chats with **New chat**,
   or reopen an existing chat. Native desktop offers existing environments and
   their chats; setup and sign-in link back to the website.
7. Inspect real runs and results on the website. Stop the environment through its
   normal lifecycle controls when finished.

The worker clones the configured eligible repository, pins the SSH host key, and
injects registered project-member device keys and the backend's per-install runner
key. The backend runs `codex app-server` as the environment user over pinned SSH;
desktop calls the authenticated session API. ChatGPT authentication stays
inside that environment. Only use an account intended for the project's members.
SSH is trusted shell access, not a filesystem or command sandbox.

Docker environments expire according to their allocation and are removed on stop;
the worker cleans Codex authentication and temporary agent state during teardown.
Do not assume files or conversation state survive environment removal. Export any
needed changes before stopping it. A request or running container is not evidence
of successful SSH verification or model execution.

## Legacy test-box data

Legacy standalone Docker sessions and their private volumes may still exist for
compatibility. They are not exposed by the product UI. `/api/codex-sessions`
remains the shared protocol for environment sessions, always with a `runBoxId`.
Leave `AGENTCLOUD_CODEX_ENABLED` unset or disabled for the environment-based flow.
Existing legacy workspace and history are not deleted or silently imported.
An operator can retain the old box stopped while moving specifically needed files
and credentials privately into an authorized test environment. The old box cannot
be adopted unchanged: it lacks the standard SSH account, host key and lifecycle.

New environments must be allocated by the current worker so they include the
backend runner key. See [docs/stage3-contract.md](docs/stage3-contract.md) for
session ownership, reconnect, redaction, and execution boundaries. Stopping a
session ends its SSH transport; stopping an environment tears down the machine.

### Existing sandbox conflicts

Only one non-stopped Docker environment is allowed per project, including imported
container templates. Creating another returns HTTP 409 with instructions to use
the existing environment or stop it first; it does not record another resource
request. Stopping must finish before creating its replacement. Replaying the
original creation key still returns the original decision and environment.

## Settings browser sign-in (HAC-169)

Settings hands desktop only project, environment and session identifiers plus
the website origin. Desktop verifies the origin and authenticated session target
before requesting browser login. The OAuth URL comes from the authenticated API,
never from the deep link. The existing pinned SSH tunnel carries the loopback
callback to Codex in the selected environment. Login URLs, codes and credentials
are not logged or stored in activity. Callback-port conflicts and unavailable
desktop/SSH connections are actionable failures; there is no device-code fallback
in the environment UI. Legacy CLI token records and authenticated transport APIs
remain compatible, but new managed Codex identities have no connection token.

## Command and file-change history

Desktop and web environment chat display structured Codex execution evidence:
commands, working directories, exit codes, durations, output, and per-file paths,
operations and textual diffs. Details update on the existing item ID while work
runs and remain in the saved session snapshot. Completed output lines stream;
an unfinished line waits until the next newline or command completion so secrets
split across notifications can be redacted together.

The backend retains at most 300 events per session, 100 files per execution item,
and 32,768 characters across an item's text fields. The viewer labels truncation,
missing output and empty output separately. Recognized credentials and private
keys are redacted before persistence; redaction cannot identify every arbitrary,
unlabeled secret. Avoid asking an agent to print credentials.

Older releases discarded command and file details. Reconnecting can recover
items that Codex still returns from its saved thread; history absent there cannot
be reconstructed. These diffs describe reported agent edits, not a live Git diff
or an integration/merge result.
