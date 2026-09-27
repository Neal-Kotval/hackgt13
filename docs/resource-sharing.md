# Sharing a project environment

A project environment is one computer shared by its project members and the
agents running on it. Each person signs in with an employee account and uses a
registered device SSH key. Each remote Codex agent for a project with a cloned
repository gets a separate Git worktree and branch. The agents still share the
machine's CPU, memory, disk, network, ports, and any attached GPU.

## Divide work before starting agents

1. Give each agent one area of ownership, such as the API, UI, or integration
   checks. Put the owner, expected files, and next step in the project task or
   handoff record.
2. Use different agent identities for independent work. Check the actual
   workspace path in each Codex session before editing; older sessions and
   projects without a cloned repository may still use one shared directory.
3. Commit a coherent change in the agent's branch before another agent depends
   on it. A branch or saved repository URL alone does not mean a worktree or
   clone exists, and AgentCloud does not merge branches automatically.
4. Pass contracts, changed files, and verification results through a handoff.
   If one agent needs to interrupt another, send a directed peer message and
   inspect the recipient's session history to see whether the turn ran.

## Share machine resources deliberately

| Resource | Coordination rule |
| --- | --- |
| CPU and memory | Agree which agent runs builds or tests. Several large jobs can exhaust the same box; the app does not reserve capacity per agent. |
| GPU | Treat the device as shared capacity. Confirm availability from inside the environment before starting a workload; a machine label is not a GPU check. |
| Disk and files | Keep edits in each agent's verified worktree. Place intentionally shared artifacts in a named project path and include that path in a handoff. |
| Ports and services | Assign a port owner in the handoff. Register an endpoint only after starting it, and verify a real request before calling it reachable. Registration alone is not a health check or private ingress. |
| Credentials | Keep model, provider, and SSH secrets out of worktrees, messages, logs, and shared memory. SSH is trusted shell access, so project members and agents on the box do not have private files from one another. |

Stopping the environment affects every agent and terminal on it. Project owners
control setup and stop; project members can use its shared Codex conversations
and their own authorized device keys. Revoking a member's key blocks new SSH
connections after the worker reconciles access, but does not terminate an
existing shell.

## Notes and messages serve different purposes

**Shared memory** uses Backboard when a project owner turns it on for the
environment and the server has `BACKBOARD_API_KEY`. Before a Codex turn, the
backend may recall project facts and add them to that turn. After Codex accepts
the turn, it saves a short note about the request. Backboard failures leave the
original turn unchanged. Shared memory is background context, not an alert or
proof that another agent completed work.

**Peer messages** use AgentCloud's durable inbox. A project member can address
one Codex session from another session on the same ready box through
`POST /api/codex-sessions/<sourceSessionId>/peer-messages`. The recipient gets
the message as a Codex turn when ready. `queued` means it is waiting;
`acknowledged` means Codex accepted the turn request. Check the recipient's
session history for the actual result. Existing token-bearing agent clients can
send through the scoped CLI; managed Codex agents created in Settings are
tokenless and cannot currently send autonomously through that route.

For a time-sensitive handoff, use the inbox and include a short summary. Use
Backboard for reusable facts such as an API contract or a verified command;
do not use it as a queue. Both systems are scoped to the local application
server's state, and neither creates operating-system isolation on the box.
