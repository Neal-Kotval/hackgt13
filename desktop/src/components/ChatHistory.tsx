import { useEffect, useRef, useState } from "react";
import { MagnifyingGlass, NotePencil } from "@phosphor-icons/react";
import { groupChatHistory, type HistoryThread } from "../lib/chat-history";
import "./ChatHistory.css";

type ChatHistoryProps = {
  threads: HistoryThread[];
  selectedId: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  setupUrl?: string;
  loading: boolean;
};

export function ChatHistory({ threads, selectedId, busy, onSelect, onCreate, setupUrl, loading }: ChatHistoryProps) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const groups = groupChatHistory(threads, query);

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
        <input ref={input} type="search" placeholder="Search chats" value={query} onChange={(event) => setQuery(event.target.value)} />
        <kbd aria-hidden="true">⌘K</kbd>
      </label>
      {groups.length ? (
        <div className="chat-history-groups">
          {groups.map((group) => (
            <section className="chat-history-group" key={group.label} aria-label={group.label}>
              <h3>{group.label}</h3>
              <ul>
                {group.threads.map((thread) => (
                  <li key={thread.id}>
                    <button type="button" className="chat-history-item" data-selected={thread.id === selectedId} aria-current={thread.id === selectedId ? "true" : undefined} onClick={() => onSelect(thread.id)} title={thread.title}>
                      <span className="thread-title">{thread.title}</span>
                      {thread.status === "running" && <span className="chat-history-responding" title="Responding"><span className="visually-hidden">Responding</span></span>}
                    </button>
                  </li>
                ))}
              </ul>
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
