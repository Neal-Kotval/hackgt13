export type HistoryThread = {
  id: string;
  title: string;
  updatedAt?: string;
  status: string;
  createdBy?: string;
  createdByName?: string | null;
  agentName?: string;
  canDelete?: boolean;
  canRename?: boolean;
};

export function groupChatHistory(threads: HistoryThread[], query: string, now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const groups = ["Today", "Yesterday", "Previous 7 days", "Older"].map((label) => ({
    label,
    threads: [] as HistoryThread[],
  }));
  const timestamp = (thread: HistoryThread) => {
    const value = thread.updatedAt ? Date.parse(thread.updatedAt) : NaN;
    return Number.isFinite(value) ? value : -Infinity;
  };
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = threads.filter((thread) => [thread.title, thread.createdByName, thread.agentName].some(value => value?.toLocaleLowerCase().includes(normalizedQuery)));
  matches.sort((a, b) => timestamp(b) - timestamp(a));
  for (const thread of matches) {
    const updatedAt = timestamp(thread);
    const index = updatedAt >= today.getTime() ? 0 : updatedAt >= yesterday.getTime() ? 1 : updatedAt >= weekAgo.getTime() ? 2 : 3;
    groups[index].threads.push(thread);
  }
  return groups.filter((group) => group.threads.length > 0);
}


/** Creator attribution is independent of the human or agent's online presence. */
export function groupChatHistoryByCreator(threads: HistoryThread[], query: string, viewerId?: string, now = new Date()) {
  const owners = new Map<string, { id: string; name: string | null; threads: HistoryThread[] }>();
  for (const thread of threads) {
    const id = thread.createdBy?.trim() || "";
    let owner = owners.get(id);
    if (!owner) { owner = { id, name: null, threads: [] }; owners.set(id, owner); }
    owner.name ||= thread.createdByName?.trim() || null;
    owner.threads.push(thread);
  }
  const all = [...owners.values()];
  function shortId(id: string) {
    let length = Math.min(8, id.length);
    while (length < id.length && all.some(owner => owner.id !== id && owner.id.startsWith(id.slice(0, length)))) length++;
    return id.slice(0, length);
  }
  return all.map(owner => {
    const isViewer = Boolean(viewerId && owner.id === viewerId);
    const duplicateName = owner.name && all.some(other => other.id !== owner.id && other.name?.toLocaleLowerCase() === owner.name?.toLocaleLowerCase());
    const name = owner.name ? `${owner.name}${duplicateName ? ` · ${shortId(owner.id)}` : ""}` : owner.id ? `Member · ${shortId(owner.id)}` : "Unknown creator";
    const label = isViewer ? `You${owner.name ? ` · ${owner.name}` : ""}` : name;
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const ownerMatches = label.toLocaleLowerCase().includes(normalizedQuery);
    const groups = groupChatHistory(owner.threads, ownerMatches ? "" : query, now);
    return { id: owner.id, label, isViewer, groups, count: groups.reduce((count, group) => count + group.threads.length, 0) };
  }).filter(owner => owner.count > 0).sort((a, b) => Number(b.isViewer) - Number(a.isViewer) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

export function chatStatusLabel(status: string): string {
  return ({ running: "Working", ready: "Ready", initializing: "Starting", auth_required: "Sign-in required", error: "Needs attention", stopped: "Stopped" } as Record<string, string>)[status] ?? "Status unavailable";
}
