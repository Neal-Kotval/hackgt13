# Sandbox MVP contract: create an environment on the web, open it in the desktop app

Status: in progress. This is the shared interface for the parallel backend, web, and desktop slices. It describes planned behavior until each slice lands and is verified.

## Journey

1. On the web **Environments** page (`/projects/:id/environments`), a project owner chooses **New environment**, picks a profile and duration, and submits. The server records a request and a policy decision and queues one run-box job (existing `run_box_decision` / `run_box_job` records).
2. A worker allocates the environment and verifies SSH access against a **pinned host key it generated for this job**. Only then does the job reach `ready`.
3. The Environments page shows the ready environment with **Open in desktop**, which navigates to `agentcloud://open?projectId=<projectId>&runBoxId=<jobId>`.
4. The desktop app (signed in as the same employee, with a registered device key) fetches connection details and opens an in-app SSH terminal. It refuses any host key other than the pinned one.
5. **Stop** requests a stop; the worker tears the environment down and records `stopped`.

Access over SSH is **trusted shell access** to the environment. It is not a filesystem or command sandbox and must be labelled that way.

## Profiles (server-owned)

| Profile ID | Provider | What it is | GPU |
| --- | --- | --- | --- |
| `local-docker-sandbox` | `docker-local` | Linux container with sshd on the machine running the worker; for local development and demos | None. Never label as GPU |
| `runpod-rtx-4090` | `runpod` | Runpod Secure Cloud Pod | RTX 4090, verified by probe |
| `aws-g6-demo` | `aws-ec2` | Existing EC2 path (SSM only; no desktop SSH yet) | Verified by probe |

## Device SSH keys

The desktop app generates one ed25519 keypair per device in the Electron main process. The private key never leaves the device (it is stored with `safeStorage`). Only the OpenSSH public key is registered.

Table `employee_ssh_key` (module `lib/ssh-keys.mjs`): `id`, `user_id`, `label`, `public_key` (`ssh-ed25519 AAAA…` without comment), `fingerprint` (`SHA256:…`), `created_at`, `revoked_at`.

```
GET    /api/ssh-keys                -> { keys: [{ id, label, fingerprint, createdAt }] }
POST   /api/ssh-keys { label, publicKey } -> 201 { key: { id, label, fingerprint, createdAt } }   (idempotent per user+fingerprint: 200 with the existing key)
DELETE /api/ssh-keys/:id            -> { ok: true }   (sets revoked_at; own keys only)
```

All require a verified employee session (cookie). Plaintext private keys are never accepted; non-ed25519 or malformed keys return 400. Deleting an unknown, already revoked, or another user's key returns 404. Mutations reject a mismatched `Origin` (403); requests without `Origin` (the desktop main process) are accepted on the strength of the session cookie. Revoking a key also stops `/connection` from authorizing it, even on environments where it was injected.

`authorizedKeysForProject(db, projectId)` returns non-revoked public keys of every user with owner/member access to the project at allocation time. Keys registered **after** allocation are not present on that environment (documented MVP limitation).

## Per-job SSH endpoint

Table `run_box_ssh_endpoint` (module `lib/run-box-ssh.mjs`): `job_id` (PK, FK `run_box_job`), `host`, `port`, `username`, `host_public_key` (`ssh-ed25519 AAAA…`), `authorized_fingerprints` (JSON array), `recorded_at`.

- `recordRunBoxSshEndpoint(db, jobId, { host, port, username, hostPublicKey, authorizedFingerprints })`
- `getRunBoxSshEndpoint(db, jobId)` -> row or `null`

Workers record the endpoint before verification and verify with a `known_hosts` built from `host_public_key`. For Runpod, `username` is the non-root `agentcloud` account; root holds only the operator key. The Runpod host private key is passed in the Pod env, so it is visible to the Runpod account holder (see RUNPOD_SETUP.md).

## Connection API

```
GET /api/run-boxes/:id/connection
200 { runBoxId, projectId, provider, profileId, state: "ready",
      host, port, username, hostPublicKey, knownHostsLine,
      access: "trusted-shell",
      authorized: true }                           // caller has a key whose fingerprint was injected
409 { error } when the job is not ready or has no endpoint
403 { error } when the caller is not a project member, or has no injected key
    ({ error, code: "no_authorized_key" } so the desktop can explain re-provisioning)
```

`knownHostsLine` is `[host]:port ssh-ed25519 AAAA…` (or `host ssh-ed25519 …` for port 22).

## Environments listing (existing, extended)

`GET /api/run-boxes?projectId=` keeps its shape and adds per job: `profileId`, `ssh: { host, port, username } | null` (non-null only when `ready` and an endpoint is recorded), `desktopUrl` (`agentcloud://open?...` only when `ready`, otherwise `null`), `access: "trusted-shell"`.

`POST /api/run-boxes` gains a one-step owner path: `{ projectId, profileId, durationHours, idempotencyKey }` creates the resource request and decision together. Members receive a denied decision (existing `runbox-v1` policy).

## Desktop deep link

`agentcloud://open?projectId=<id>&runBoxId=<jobId>` (existing `environmentId` form stays supported). The desktop fetches `/api/run-boxes?projectId=` and `/api/run-boxes/:id/connection`; it never trusts host/port values from the URL.
