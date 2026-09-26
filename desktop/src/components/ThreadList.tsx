import type { ChatThreadSummary } from "../lib/types";

type ThreadListProps = {
  threads: ChatThreadSummary[];
  selectedId: string | null;
  busy: boolean;
  onSelect: (threadId: string) => void;
  onCreate: () => void;
  onDelete: (threadId: string) => void;
};

function formatUpdated(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function ThreadList({
  threads,
  selectedId,
  busy,
  onSelect,
  onCreate,
  onDelete,
}: ThreadListProps) {
  return (
    <aside className="sidebar" aria-label="Local chats">
      <div className="sidebar-header">
        <div>
          <div className="brand">Local chats</div>
          <div className="brand-meta">
            On-device only — not AgentCloud tasks
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onCreate}
          disabled={busy}
        >
          New chat
        </button>
      </div>

      {threads.length === 0 ? (
        <div className="sidebar-empty" role="status">
          No chats yet. Start a new chat to begin. Nothing is seeded.
        </div>
      ) : (
        <div className="thread-list" role="list">
          {threads.map((thread) => (
            <div key={thread.id} className="thread-row" role="listitem">
              <button
                type="button"
                className="thread-item"
                data-selected={thread.id === selectedId ? "true" : "false"}
                aria-current={thread.id === selectedId ? "true" : undefined}
                onClick={() => onSelect(thread.id)}
              >
                <span className="thread-title">{thread.title}</span>
                <span className="thread-meta">
                  {thread.messageCount} message
                  {thread.messageCount === 1 ? "" : "s"} ·{" "}
                  {formatUpdated(thread.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className="btn btn-ghost thread-delete"
                aria-label={`Delete ${thread.title}`}
                disabled={busy}
                onClick={() => {
                  const confirmed = window.confirm(
                    `Delete “${thread.title}”? This removes its messages from local storage.`,
                  );
                  if (confirmed) onDelete(thread.id);
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
