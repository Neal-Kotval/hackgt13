import { NotePencil, Trash } from "@phosphor-icons/react";
import type { ChatThreadSummary } from "../lib/types";

type ThreadListProps = {
  threads: ChatThreadSummary[];
  selectedId: string | null;
  busy: boolean;
  onSelect: (threadId: string) => void;
  onCreate: () => void;
  onDelete: (threadId: string) => void;
};

export function ThreadList({
  threads,
  selectedId,
  busy,
  onSelect,
  onCreate,
  onDelete,
}: ThreadListProps) {
  return (
    <aside className="sidebar" aria-label="Project chat">
      <div className="sidebar-header">
        <h2 className="brand">Chats</h2>
        <button
          type="button"
          className="button icon-button"
          aria-label="New chat"
          title="New chat"
          onClick={onCreate}
          disabled={busy}
        >
          <NotePencil aria-hidden="true" />
        </button>
      </div>

      {threads.length === 0 ? (
        <div className="sidebar-empty" role="status">
          No chats yet
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
              </button>
              <button
                type="button"
                className="button danger thread-delete icon-button"
                aria-label={`Delete ${thread.title}`}
                title={`Delete ${thread.title}`}
                disabled={busy}
                onClick={() => {
                  const confirmed = window.confirm(
                    `Delete “${thread.title}”? This removes its messages from local storage.`,
                  );
                  if (confirmed) onDelete(thread.id);
                }}
              >
                <Trash aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
