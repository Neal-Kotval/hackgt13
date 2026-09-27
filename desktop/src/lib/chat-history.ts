export type HistoryThread = {
  id: string;
  title: string;
  updatedAt?: string;
  status: string;
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
  const normalizedQuery = query.toLocaleLowerCase();
  const matches = threads.filter((thread) => thread.title.toLocaleLowerCase().includes(normalizedQuery));
  matches.sort((a, b) => timestamp(b) - timestamp(a));
  for (const thread of matches) {
    const updatedAt = timestamp(thread);
    const index = updatedAt >= today.getTime() ? 0 : updatedAt >= yesterday.getTime() ? 1 : updatedAt >= weekAgo.getTime() ? 2 : 3;
    groups[index].threads.push(thread);
  }
  return groups.filter((group) => group.threads.length > 0);
}
