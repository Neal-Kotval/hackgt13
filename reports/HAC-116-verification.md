# HAC-116 local Codex verification

Verified September26,2026 from the dedicated HAC-116 worktree, including current
main's HAC-119 project-chat redesign. No AWS deployment or provisioning occurred.

## Real execution

- Existing local accounts/projects copied from stopped Compose backend into host
  backend data. Original Docker data volume retained as backup.
- Website Settings registered a Codex identity and initialized its actual Docker
  box. User completed the official ChatGPT device-code flow.
- Electron used its real authenticated preload/main-process bridge to submit a
  turn. Codex wrote `/home/node/workspace/agentcloud-connection-check.txt`, ran
  `pwd`, `uname -s`, and `cat`, and reported actual tool results.
- Independent `docker exec ... cat` confirmed the exact file content:
  `AgentCloud desktop connected to Codex in Docker`.
- Website stopped the box; desktop reconnected the same saved conversation.
  Codex read the preserved file and checked bytes with `od`. Its first attempted
  Python check failed because the minimal image has no Python; this real failure
  appeared in the UI before Codex successfully used available tools.
- Stop generation produced an actual `turn/completed` notification with status
  `interrupted`. No simulated assistant replies or command evidence were used.
- Reconnecting a never-used thread exposed Codex's delayed persistence of empty
  threads. Recovery now creates a replacement only if no turn was ever submitted.

## Automated and browser checks

- Backend:154 passed,1 skipped,0 failed (155 tests).
- Desktop:55 passed; unrelated Docker SSH suite explicitly excluded.
- Web/desktop TypeScript and production builds passed; desktop retains an existing
  large-bundle warning.
- Token contract:44 files,169 shared tokens.
- Headless web initialization/authentication/lifecycle flow at375/768/1440px:
  no horizontal overflow. Desktop merged renderer verified at the same widths
  against the real authenticated bridge and session snapshots, with draft
  retention across navigation and reachable send controls.
- Isolated browser tests reproduced ambiguous sends and missing session/project
  links before verifying fixes. Protocol tests cover ownership mismatch,
  unsupported approvals, bounded frames, timeout, process exit, and stop without
  recreating an absent container. API tests cover owner/member separation,
  removed membership, anonymous requests and cross-origin mutation denial.

This verifies local CPU-box agent execution and persistence, not AWS/GPU support,
repository cloning, automatic expiry, or hardened multi-tenant isolation.
