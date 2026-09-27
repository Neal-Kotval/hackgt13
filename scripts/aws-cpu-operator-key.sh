#!/usr/bin/env bash
set -euo pipefail
set +x

# HAC-166: ensure the aws-cpu worker's dedicated ed25519 operator key exists.
# Usage: aws-cpu-operator-key.sh <directory> [owner]
# Creates <directory> (0700) and <directory>/id_ed25519 (0600) only when absent,
# rewrites the public half from the private key, fixes modes, and (as root) hands
# both files to <owner>. Prints only the public key line; never the private key.
DIR="${1:-}"
OWNER="${2:-}"
[[ "$DIR" == /* ]] || { echo 'Usage: aws-cpu-operator-key.sh <absolute directory> [owner]' >&2; exit 2; }
KEY="$DIR/id_ed25519"
umask 077
install -d -m 0700 "$DIR"
if [[ -L "$KEY" || -L "$KEY.pub" ]]; then
  echo 'Operator key path must not be a symbolic link.' >&2
  exit 1
fi
if [[ ! -f "$KEY" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C 'agentcloud-aws-cpu-operator' -f "$KEY" >/dev/null </dev/null
fi
chmod 0600 "$KEY"
PUBLIC="$(ssh-keygen -y -f "$KEY" | awk '{print $1" "$2}')"
[[ "$PUBLIC" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+=*$ ]] || { echo 'Operator key is not an ed25519 key.' >&2; exit 1; }
printf '%s agentcloud-aws-cpu-operator\n' "$PUBLIC" > "$KEY.pub"
chmod 0600 "$KEY.pub"
if [[ -n "$OWNER" && "$(id -u)" == 0 ]]; then
  chown "$OWNER:$OWNER" "$DIR" "$KEY" "$KEY.pub"
fi
printf '%s\n' "$PUBLIC"
