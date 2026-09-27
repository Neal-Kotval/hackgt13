# Test Codex through a standard environment

The product runs Codex inside a selected execution environment. Project chat uses
the same SSH connection, readiness checks, sign-in, and run recording for each
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
5. In desktop **Project chat**, choose the project and ready environment. Sign in
   to Codex through the environment's device flow, then give it work in chat.
6. Inspect real runs and results on the website. Stop the environment through its
   normal lifecycle controls when finished.

The worker clones the configured eligible repository, pins the SSH host key, and
injects registered project-member device keys. Desktop keeps private keys in its
main process and runs Codex as the environment user. ChatGPT authentication stays
inside that environment. Only use an account intended for the project's members.
SSH is trusted shell access, not a filesystem or command sandbox.

Docker environments expire according to their allocation and are removed on stop;
the worker cleans Codex authentication and temporary agent state during teardown.
Do not assume files or conversation state survive environment removal. Export any
needed changes before stopping it. A request or running container is not evidence
of successful SSH verification or model execution.

## Legacy test-box data

The old `/api/codex-sessions` app-server implementation and its private Docker
volumes may still exist for compatibility. It is not used by the product UI.
Leave `AGENTCLOUD_CODEX_ENABLED` unset or disabled for the environment-based flow.
Existing legacy workspace and history are not deleted or silently imported.
An operator can retain the old box stopped while moving specifically needed files
and credentials privately into an authorized test environment. The old box cannot
be adopted unchanged: it lacks the standard SSH account, host key and lifecycle.
