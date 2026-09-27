# Conversation ownership and notifications

Session DTOs retain `createdBy` (employee ID) and add `createdByName: string | null`.
The production service resolves the current Better Auth user name without exposing
email addresses. Missing users return null; clients should group by the ID, not
the display name. Standalone session-service tests can inject `creatorName(id)`
without creating the authentication schema.

## Human notification API

All routes require a verified employee, membership in the session's project, and
visibility of its environment. Writes retain the same-origin check. Actor identity
always comes from the authenticated employee, never from request JSON.

`POST /api/codex-sessions/:id/peer-messages` supports:

- Directed: `{toSessionId, text, requestId}` → HTTP 202 `{message}`.
- Broadcast: `{broadcast:true, audience?:"agents"|"conversations", text, requestId}`
  → HTTP 202 `{messages}`. Supplying both a recipient and broadcast is invalid.

Both sessions must belong to the same project and non-null environment. A session
cannot notify itself. Independent conversations using the same agent identity can
notify each other. The sender must be ready/running on a ready environment; a busy
or disconnected recipient retains its queued notification until ready/reconnected.

Default audience `agents` preserves the existing behavior: one non-stopped session
per other agent identity, favoring ready/running setup sessions. Explicit audience
`conversations` selects every other non-stopped independent chat on this environment
(`chat_request_id IS NOT NULL`), including conversations with the same agent ID.
Setup sessions are not included in that audience. No recipients returns HTTP 409.
Recipients are frozen on the initial broadcast and cannot expand during retries.

Text must contain 1–16384 UTF-8 bytes; after redaction it must be no longer than
15000 characters, leaving room for the attributed forwarding header within the
existing chat-turn limit. Oversized input returns 400 before queueing. A directed
request ID is a nonempty string up to 128 characters; broadcast IDs must be UUIDs.
Use a new UUID for each intentional notification. Exact retries return existing
records; changed content, target, known actor ID, or audience returns 409.

`GET /api/codex-sessions/:id/peer-messages` retains its pending-incoming response
`{messages}`. `?messageId=...` returns `{message}` only if this session is a sender
or recipient. To read durable history, use:

`GET /api/codex-sessions/:id/peer-messages?view=history&limit=50&beforeSequence=123`

History returns `{messages,nextBeforeSequence}`. It includes incoming and outgoing
notifications in all statuses. The initial page contains the newest records;
records within each page are sorted ascending by sequence. Prepend subsequent
pages using the exclusive `nextBeforeSequence` cursor, until it is null. Limit
is an integer from 1 through 100 (default 50); cursors are positive safe integers.
Unknown views, invalid cursors, or combining history with a message ID return 400.
History does not mutate delivery state. All GET responses are `no-store`.

Every message contains:

```ts
{
  id: string; sequence: number; projectId: string;
  fromSessionId: string; toSessionId: string; requestId: string;
  text: string; actorId: string | null; actorName: string | null;
  status: "queued" | "delivered" | "acknowledged";
  createdAt: string; deliveredAt: string | null; acknowledgedAt: string | null;
  direction?: "incoming" | "outgoing"; // present only in history
}
```

`queued` means saved, `delivered` means a dispatch was attempted, and `acknowledged`
means the Codex turn-start request was accepted. None means the task finished.
Ambiguous sends retain the existing request-ID recovery safeguards and must not be
blindly repeated under a new ID. Incoming chat events retain the recorded actor
and explicitly identify the source conversation. Historical records with no actor
remain null and use “AgentCloud inbox” when dispatched.

## Agent notifications

`POST /api/agent-peer-messages` accepts the same notification fields plus
`projectId`, `agentId`, and `fromSessionId`. Its bearer credential must match both
the supplied identity and the source session. Actors are recorded as the scoped
agent ID and “Connected agent”. The existing `GET` status endpoint remains scoped
to that identity and its source conversation.

The CLI supports directed messages and both broadcast audiences:

```sh
node cli/agentcloud.mjs peer PROJECT --agent AGENT --from-session SOURCE --to-session TARGET --text 'Please review the API'
node cli/agentcloud.mjs peer PROJECT --agent AGENT --from-session SOURCE --all true --audience conversations --text 'The API is ready'
```

Set the existing `AGENTCLOUD_TOKEN` and, when needed, `AGENTCLOUD_URL`. These are
coordination requests to existing sessions, not a new agent-execution mechanism.

## Persistence and secrets

Inbox rows and broadcast records store redacted text, original-request SHA-256
hashes, and authenticated actor attribution. The original plaintext request is
not retained. Dispatch uses the same redacted content the history UI displays.
Recognized credential formats, private-key blocks, secret assignments and command
flags are redacted. Detection is best effort; arbitrary unlabeled secrets cannot
be guaranteed identifiable. Existing unredacted inbox/broadcast rows are hashed
and sanitized in a transaction with SQLite secure deletion enabled. This does not
rewrite external backups. Legacy attribution remains unknown, never invented.
