import { useEffect, useRef, useState } from "react";
import { MagnifyingGlass, NotePencil } from "@phosphor-icons/react";
import { groupChatHistoryByCreator, chatStatusLabel, type HistoryThread } from "../lib/chat-history";
import "./ChatHistory.css";

type ChatHistoryProps = {
  threads: HistoryThread[];
  selectedId: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  setupUrl?: string;
  loading: boolean;
  viewerId?: string;
};

export function ChatHistory({ threads, selectedId, busy, onSelect, onCreate, setupUrl, loading, viewerId }: ChatHistoryProps) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const owners = groupChatHistoryByCreator(threads, query, viewerId);

  useEffect(() => {
    let frame = 0;
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      if (window.matchMedia("(max-width: 768px)").matches) {
        window.dispatchEvent(new CustomEvent("alto:open-chat-search"));
      }
      frame = window.requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener("keydown", focusSearch);
    return () => {
      window.removeEventListener("keydown", focusSearch);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <aside className="sidebar chat-history" aria-label="Chat history">
      <div className="sidebar-header">
        <h2 className="brand">Chats</h2>
        <button type="button" className="button icon-button chat-history-create" aria-label="New chat" title="New chat" disabled={busy} onClick={onCreate}>
          <NotePencil aria-hidden="true" />
        </button>
      </div>
      <label className="chat-history-search">
        <MagnifyingGlass aria-hidden="true" />
        <span className="visually-hidden">Search chats</span>
        <input ref={input} type="search" placeholder="Search chats, people, agents" value={query} onChange={(event) => setQuery(event.target.value)} />
        <kbd aria-hidden="true">⌘K</kbd>
      </label>
      {owners.length ? (
        <div className="chat-history-groups">
          {owners.map(owner => (
            <section className="chat-history-owner" key={owner.id} aria-label={owner.label}>
              <h3 className="chat-history-owner-heading"><span>{owner.label}</span><span className="chat-history-owner-count" aria-label={`${owner.count} chats`}>{owner.count}</span></h3>
              {owner.groups.map(group => (
                <div className="chat-history-group" key={group.label}>
                  <h4>{group.label}</h4>
                  <ul>
                    {group.threads.map(thread => (
                      <li key={thread.id}>
                        <button type="button" className="chat-history-item" data-selected={thread.id === selectedId} aria-current={thread.id === selectedId ? "true" : undefined} onClick={() => onSelect(thread.id)} title={thread.title}>
                          <span className="chat-history-item-text"><span className="thread-title">{thread.title}</span><span className="chat-history-item-meta"><span>{thread.agentName || "Codex"}</span><span className="chat-history-session-status" data-status={thread.status}>{chatStatusLabel(thread.status)}</span></span></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="sidebar-empty" role="status">
          {loading ? "Loading chats…" : query ? `No chats match “${query}”` : "No chats yet"}
          {!loading && !query && setupUrl && <a className="chat-history-setup" href={setupUrl} target="_blank" rel="noreferrer">Project settings</a>}
        </div>
      )}
    </aside>
  );
}
