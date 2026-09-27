export type ChatRunStatus = "running" | "completed" | "failed" | "stopped" | "unknown";
export type ChatRun = {
  id: string; sessionId: string; projectId: string; runBoxId: string;
  prompt: string; status: ChatRunStatus; startedAt: string; finishedAt: string | null;
  actorName: string | null;
  environment: { profileId: string | null; provider: string; state: string } | null;
  events: { id: string; kind: string; text: string; createdAt: string }[];
};
export type ChatConversation = ChatRun & {
  title: string;
  updatedAt: string;
  requests: ChatRun[];
};

/** Group only recorded requests; empty setup chats remain absent. */
export function groupChatConversations(runs: ChatRun[]): ChatConversation[] {
  const groups = new Map<string, ChatRun[]>();
  for (const run of runs) {
    const key = `${run.projectId}:${run.sessionId}`;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  return [...groups.values()].map(requests => {
    requests.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
    const first = requests[0];
    const latest = requests[requests.length - 1];
    const updatedAt = latest.events.reduce((last, event) => event.createdAt > last ? event.createdAt : last, latest.finishedAt || latest.startedAt);
    return { ...latest, id: latest.sessionId, title: first.prompt, updatedAt, requests };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
