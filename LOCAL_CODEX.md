# Local Codex boxes

This opt-in development path runs the web backend on the host and actual Codex
app-server processes inside local Docker CPU containers. It does not provision
AWS, attach GPUs, or prove the remote GPU MVP. The website initializes a registered
Codex identity; the desktop's Project chat directs the same session.

## Start

With Node 22 and Docker running:

```sh
npm ci
npm run codex:setup
npm run dev:codex
```

The backend binds to `http://127.0.0.1:3002`. Its accounts, project records and Codex
session snapshots live in `.agentcloud/local-backend`, with an owner-only auth
secret. A second checkout can run `npm run dev:docker` for the frontend at port3001;
that command uses port3002 regardless of whether the backend runs on the host or
in Compose. Do not run Compose and this backend on the same port simultaneously.
Point desktop `AGENTCLOUD_URL` at the frontend or directly at port3002. Existing
sessions remain tied to their original URL.

Existing Compose data can be migrated by stopping its backend, copying `/data`
into the host data directory with `docker cp`, and retaining the stopped volume
as a backup. Do not copy a live SQLite database or overwrite an existing host
installation. The two copies do not synchronize after migration.

## Use

1. Sign in, choose a project, and register a Codex identity in Settings if needed.
2. In Settings, initialize that identity's **Local Docker** Codex box. This creates
   an empty persistent workspace at `/home/node/workspace`; it does not implicitly
   clone the project's saved repository URL.
3. Choose Sign in to Codex, open the official device verification URL, and enter
   the displayed code. Codex authentication remains in its private Docker volume.
4. Open desktop **Project chat**, choose the project and agent conversation, and send work.
   Replies and command status come from Codex in the same chat interface. Existing
   legacy on-device threads remain on disk but are not shown or sent to Codex.
5. Interrupt cancels a turn; Stop box stops Docker while retaining workspace and
   history. Reconnect restarts the same box and resumes the saved Codex thread.

For operator-managed API authentication, set `AGENTCLOUD_CODEX_API_KEY` on the
backend only. It is sent through private stdio, not Docker arguments or renderer
state. `AGENTCLOUD_CODEX_MODEL` optionally overrides Codex's default model.
Do not mount your host Codex configuration or credentials into the box.

## Boundaries and recovery

Project owners control initialization, authentication, reconnect, and stop.
Current project members may read session output, send messages, or interrupt a
turn. Removing membership denies subsequent API operations. Sessions are shared
within the project, so only use an account you intend to make available for that
project's work. A member removal does not undo an already executing turn.

The container runs as non-root with CPU, memory and process limits, dropped
capabilities, and no host mounts, Docker socket, or published ports. Network
access is available. Codex has trusted command access inside its container;
this is not path-level isolation or a hardened public multi-tenant service.
The Codex credential home is private to that container, but tools run as its user.

One host backend process owns session transports. A backend restart records a
lost connection honestly; reconnect explicitly resumes the saved thread. Message
request IDs prevent retrying the same turn twice. An ambiguous send failure must
be reconciled before submitting new work. API snapshots retain the latest 300
items and cap each text item at 32 KiB. Command arguments, stdout, stderr, and
file paths are not saved in these snapshots; command status and exit code remain.
On upgrade, previously saved command details are replaced with a removal notice.
This does not erase prior database backups, copies, or Codex's full history in its
private Docker volume. User messages and Codex replies may still contain secrets;
only share a session with members trusted to read them.
Containers and volumes are identified by install and session labels. Stop does
not delete them. There is no automatic expiry or cloud cost enforcement here.

## Codex on a remote environment (HAC-153)

A session can also target a ready environment instead of a local Docker box
(`POST /api/codex-sessions { projectId, agentId, runBoxId }`). This does not
need `AGENTCLOUD_CODEX_ENABLED`, but the run-box worker must have created the
environment after this change so it trusts the install's Codex runner key
(`<AGENTCLOUD_DATA_DIR>/codex-runner/id_ed25519`, created on first use). The
backend opens SSH itself. `AGENTCLOUD_CODEX_API_KEY` is never sent to an
environment; sign in with a ChatGPT device code. Stop closes only the SSH
connection. Stopping the environment closes the session with "Environment
stopped". Details are in [docs/stage3-contract.md](docs/stage3-contract.md).

Protocol reference: https://developers.openai.com/codex/app-server/
