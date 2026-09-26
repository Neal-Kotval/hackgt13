#!/bin/bash
# Install the worker-generated host key and member public keys, then run sshd.
# Never echo either variable: the host key is private.
set -euo pipefail

if [ -z "${AGENTCLOUD_HOST_KEY:-}" ] || [ -z "${AGENTCLOUD_AUTHORIZED_KEYS:-}" ]; then
  echo "agentcloud-sandbox: AGENTCLOUD_HOST_KEY and AGENTCLOUD_AUTHORIZED_KEYS are required" >&2
  exit 64
fi

umask 077
printf '%s' "$AGENTCLOUD_HOST_KEY" | base64 -d > /etc/ssh/ssh_host_ed25519_key
chmod 600 /etc/ssh/ssh_host_ed25519_key
chown root:root /etc/ssh/ssh_host_ed25519_key

install -d -m 700 -o agentcloud -g agentcloud /home/agentcloud/.ssh
printf '%s\n' "$AGENTCLOUD_AUTHORIZED_KEYS" > /home/agentcloud/.ssh/authorized_keys
chmod 600 /home/agentcloud/.ssh/authorized_keys
chown agentcloud:agentcloud /home/agentcloud/.ssh/authorized_keys
install -d -m 755 -o agentcloud -g agentcloud /home/agentcloud/workspace

/usr/sbin/sshd -t
# Drop the key material from sshd's environment before it serves sessions.
exec env -u AGENTCLOUD_HOST_KEY -u AGENTCLOUD_AUTHORIZED_KEYS /usr/sbin/sshd -D -e
