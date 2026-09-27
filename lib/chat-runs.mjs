/**
 * Read-only projection of the already-redacted Codex conversation snapshots.
 * A run begins at a saved user message, never at environment setup or sign-in.
 * Snapshots retain the latest 300 events: this is recent activity, not an archive.
 */
export function projectChatRuns({ session, events }) {
  const runs = [];
  let current = null;
  for (const event of events) {
    if (event.kind === 'user') {
      current = {
        id: `${session.id}:${event.id}`,
        sessionId: session.id,
        projectId: session.projectId,
        runBoxId: session.target?.runBoxId ?? null,
        environment: {
          profileId: session.target?.profileId ?? null,
          provider: session.target?.provider ?? session.provider ?? null,
          state: session.target?.state ?? null,
        },
        prompt: event.text,
        actorName: event.actorName ?? null,
        status: 'unknown',
        statusReason: 'The final result was not recorded. Open the chat to check its progress.',
        startedAt: event.createdAt,
        finishedAt: null,
        events: [],
      };
      runs.push(current);
    }
    // Setup events and later connection/lifecycle changes are not model work.
    if (!current || current.finishedAt) continue;
    current.events.push({ id: event.id, kind: event.kind, text: event.text, createdAt: event.createdAt });
    const outcome = event.kind === 'status' && /^Turn (completed|failed|interrupted)$/.exec(event.text);
    if (outcome) {
      current.status = { completed: 'completed', failed: 'failed', interrupted: 'stopped' }[outcome[1]];
      current.statusReason = {
        completed: 'The agent finished this request.',
        failed: 'The agent could not finish this request.',
        interrupted: 'This request was stopped before it finished.',
      }[outcome[1]];
      current.finishedAt = event.createdAt;
    } else if (event.kind === 'status' && /^(Codex session closed\.|Docker box stopped\.|Environment stopped\. The Codex session on it was closed\.)/.test(event.text)) {
      current.status = 'stopped';
      current.statusReason = 'The connection or environment was closed before a final result was recorded.';
      current.finishedAt = event.createdAt;
    }
  }
  // Session state only describes the latest request. A later closed connection
  // must not rewrite an earlier completed request as stopped or failed.
  if (current && !current.finishedAt && session.status === 'running') {
    current.status = 'running';
    current.statusReason = 'The agent is working on this request.';
  }
  return runs;
}

export function listChatRuns(service, projectId) {
  return service.list(projectId)
    .filter(session => session.projectId === projectId)
    .flatMap(session => projectChatRuns(service.snapshot(session.id)))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
}
