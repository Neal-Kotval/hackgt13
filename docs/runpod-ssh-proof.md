# Runpod SSH proof boundary

`verifyRunpodSsh` accepts a Pod's **direct** SSH IPv4 address and mapped TCP port, a dedicated private key file, its public key, and an OpenSSH `known_hosts` file containing that Pod's approved host key. The verifier uses strict host-key checking and batch public-key authentication. It never auto-accepts a key observed over the same connection.

The worker generates the Pod's ed25519 host key itself before create and injects it through the Pod env (see RUNPOD_SETUP.md), then writes a per-job `known_hosts` from the recorded public key for this verifier. Keep the operator private key on the worker host, outside the repository and browser payloads. A missing or changed pin blocks verification. The staging worker also needs outbound TCP access to the Pod's mapped SSH port; its current AWS security group permits HTTPS egress only, so this is a deployment prerequisite.

The first SSH command bootstraps the `agentcloud` account and job workspace from the Pod's root account, writing the operator key plus the member device keys chosen at allocation (`connection.authorizedKeys`) to `agentcloud`'s `authorized_keys`. The desktop app connects as `agentcloud`. The second command connects as `agentcloud`, clones the approved HTTPS repository, checks the revision, probes `nvidia-smi` and CUDA, and runs a small CPU/GPU matrix multiplication. `ready` must be recorded only after this evidence is validated and persisted. The bootstrap SSH session is trusted root access; it does not enforce a filesystem sandbox.

This module has mocked tests, but no live Runpod Pod has been connected. A restricted Runpod API key, billing balance, Pod SSH public key, approved host key, and worker egress are still needed for a live end-to-end test.
