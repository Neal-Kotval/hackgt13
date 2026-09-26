# Runpod run-box worker

Runpod is the selected alternative for the live GPU test while the AWS account remains on its Free plan. The backend supports an approved, leased `runpod` job with profile `runpod-rtx-4090`: one NVIDIA GeForce RTX 4090, `runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404`, Secure cloud, and a disposable 50 GB container disk. The worker checks current catalog availability and a live Secure price at or below $1/hour before creating a Pod. The quote covers the Pod price returned by Runpod's catalog; it is not a hard spending limit.

Run `node scripts/run-box-worker.mjs --once runpod` for one reconciliation and job cycle, or `node scripts/run-box-worker.mjs --loop runpod` for a continuing worker. The worker shares the private app SQLite database selected by `AGENTCLOUD_DATA_DIR`. Its `RUNPOD_API_KEY` must be supplied server-side, for example through the existing Doppler setup. Never expose it to a browser or commit it. The worker also requires an absolute path in `AGENTCLOUD_RUNPOD_SSH_KEY_FILE` (the operator private key, which must exist before allocation) and its ed25519 public key in `AGENTCLOUD_RUNPOD_SSH_PUBLIC_KEY`. `AGENTCLOUD_RUNPOD_KNOWN_HOSTS_FILE` is no longer used: the worker pins a host key it generates for each job (see below). The worker records a `runpod_connection_wait` reason and retries verification when the SSH endpoint or pin is missing; it does not accept an unverified host key.

## Pinned host key and device keys (HAC-87)

Before each Pod create the worker runs `ssh-keygen -t ed25519` in a private (0700) temporary directory, which it removes immediately. It records only the public host key (`runpod_ssh_host_key`) and passes the Pod, through the Runpod v2 `env` object:

- `AGENTCLOUD_SSH_HOST_KEY_B64`: the base64 OpenSSH private host key.
- `AGENTCLOUD_SSH_HOST_PUBLIC_KEY` and `AGENTCLOUD_OPERATOR_PUBLIC_KEY`: public keys.
- `AGENTCLOUD_AUTHORIZED_KEYS_B64`: the operator key plus the active device keys of every verified project member at allocation time (`authorizedKeysForProject`).

The v2 `cmd` override (`bash -c …`, keeping the image ENTRYPOINT) installs the host key at `/etc/ssh/ssh_host_ed25519_key`, restricts sshd to that key through `/etc/ssh/sshd_config.d/00-agentcloud-hostkey.conf`, gives root only the operator key, installs the authorized keys for the non-root `agentcloud` account, unsets the secret variables, and `exec`s the image's normal `/start.sh` (which leaves an existing host key in place and starts sshd). When the direct endpoint appears, the worker records `run_box_ssh_endpoint` with username `agentcloud` and the member fingerprints, and verifies with a per-job `known_hosts` built from the pinned key. The GPU proof's root bootstrap rewrites the same `agentcloud` key list, so the desktop connects as `agentcloud`.

**The host private key is visible to anyone who can read the Pod's configuration in the Runpod account** (the Runpod console or API shows Pod env). It is never logged, stored in the app database, or returned by the provider adapter. Treat the Runpod account holder as trusted for that environment. Keys registered after allocation are not installed on a running environment. The `cmd` override and `/start.sh` behavior have been exercised only with mocks; a live Pod has not been booted with them.

Every cycle lists managed Pods and reconciles stop requests and expired jobs before claiming an allocation. **The production worker currently blocks allocation until an independent cleanup guard can attest that it is active.** This guard is not implemented yet, so the worker records a visible `allocating` retry and issues no Runpod POST. If the guard becomes unavailable after allocation, reconciliation requests Pod termination. Creation, once enabled, uses a deterministic job and expiry marker and recovers an existing matching Pod. Uncertain create responses leave a failed job for reconciliation; the worker never blindly posts another Pod. Termination requires the Runpod DELETE operation followed by a fresh GET that returns no Pod before `stopped` is recorded. A create with no durable Pod ID remains an explicit retry because one empty list cannot prove that an uncertain POST did not allocate.

After SSH proof, `runpod_gpu_verification` stores the non-root account/UID, workspace, checked-out repository SHA, GPU device, CPU/CUDA timings and correctness, output hash, and evidence reference. A running Pod is not proof of a completed GPU test. The Pod remains billable until termination is confirmed.

## Live launch blockers

- A Runpod API key and billing authorization for a bounded Pod run are required. Neither is in the repository.
- The per-job pinned host key has not been exercised on a live Pod. A Pod without a recorded pin is never trusted; the worker waits rather than using trust-on-first-use.
- The reconciliation loop is the current expiry mechanism. The private staging host may stop, so a separate always-on cleanup guard or verified provider-side TTL is required before a billable live run. A `$1/hour` price check and warning budget cannot replace that guard.
- No Runpod Pod has been launched or GPU verification observed by this implementation. Tests use a mock provider and verifier.

The AWS G6 attempt and current Free-plan block remain recorded in [AWS_SETUP.md](AWS_SETUP.md).
