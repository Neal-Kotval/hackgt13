import { forwardRef, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { DotsThree, MagnifyingGlass, NotePencil, PencilSimple, Trash } from "@phosphor-icons/react";
import { groupChatHistoryByCreator, chatStatusLabel, type HistoryThread } from "../lib/chat-history";
import "./ChatHistory.css";

type ChatHistoryProps = {
  threads: HistoryThread[];
  selectedId: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete?: (id: string) => void;
  deletingId?: string;
  onRename?: (id: string, title: string) => void;
  renamingId?: string;
  error?: string | null;
  setupUrl?: string;
  loading: boolean;
  viewerId?: string;
};

export function ChatHistory({ threads, selectedId, busy, onSelect, onCreate, onDelete, deletingId, onRename, renamingId, error, setupUrl, loading, viewerId }: ChatHistoryProps) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const owners = groupChatHistoryByCreator(threads, query, viewerId);
  const feedback = useChatMotion();

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
        <button ref={createButton} type="button" className="button icon-button chat-history-create" aria-label="New chat" title="New chat" disabled={busy} onClick={onCreate}>
          <NotePencil aria-hidden="true" />
        </button>
      </div>
      <label className="chat-history-search">
        <MagnifyingGlass aria-hidden="true" />
        <span className="visually-hidden">Search chats</span>
        <input ref={input} type="search" placeholder="Search chats, people, agents" value={query} onChange={(event) => setQuery(event.target.value)} />
        <kbd aria-hidden="true">⌘K</kbd>
      </label>
      {error && <p className="chat-history-error" role="alert">{error}</p>}
        <div className="chat-history-groups">
          <AnimatePresence initial={false}>
          {owners.map(owner => (
            <motion.section exit={feedback.exit} transition={feedback.transition} className="chat-history-owner" key={owner.id} aria-label={owner.label}>
              <h3 className="chat-history-owner-heading"><span>{owner.label}</span><span className="chat-history-owner-count" aria-label={`${owner.count} chats`}>{owner.count}</span></h3>
              <AnimatePresence initial={false}>
              {owner.groups.map(group => (
                <motion.div exit={feedback.exit} transition={feedback.transition} className="chat-history-group" key={group.label}>
                  <h4>{group.label}</h4>
                  <ul>
                    <AnimatePresence initial={false}>
                    {group.threads.map(thread => (
                      <HistoryRow key={thread.id} thread={thread} selected={thread.id === selectedId} onSelect={onSelect}
                        onDelete={onDelete} onRename={onRename} deleting={deletingId === thread.id} renaming={renamingId === thread.id}
                        mutationPending={Boolean(deletingId || renamingId)} onRemovedFocus={() => createButton.current?.focus()} />
                    ))}
                    </AnimatePresence>
                  </ul>
                </motion.div>
              ))}
              </AnimatePresence>
            </motion.section>
          ))}
          </AnimatePresence>
        </div>
      {!owners.length && (
        <div className="sidebar-empty" role="status">
          {loading ? "Loading chats…" : query ? `No chats match “${query}”` : "No chats yet"}
          {!loading && !query && setupUrl && <a className="chat-history-setup" href={setupUrl} target="_blank" rel="noreferrer">Project settings</a>}
        </div>
      )}
    </aside>
  );
}


// Read the shared motion contract so desktop feedback also respects reduced motion.
function useChatMotion() {
  const reduced = useReducedMotion();
  const [tokens] = useState(() => {
    const style = getComputedStyle(document.documentElement);
    const number = (name: string) => parseFloat(style.getPropertyValue(name));
    const ease = style.getPropertyValue("--ease-standard").match(/[\d.]+/g)?.map(Number) as [number, number, number, number];
    return { duration: number("--duration-normal") / 1000, hidden: number("--opacity-reveal-start"), visible: number("--opacity-visible"), distance: number("--motion-enter-distance"), ease };
  });
  return {
    initial: { opacity: tokens.hidden, y: reduced ? 0 : -tokens.distance },
    animate: { opacity: tokens.visible, y: 0 },
    exit: { opacity: tokens.hidden },
    transition: { duration: reduced ? 0 : tokens.duration, ease: tokens.ease },
  };
}

const ActionPanel = forwardRef<HTMLDivElement, { children: ReactNode }>(function ActionPanel({ children }, ref) {
  const present = useIsPresent();
  const feedback = useChatMotion();
  return <motion.div ref={ref} className="chat-history-action-panel" inert={!present} aria-hidden={!present || undefined} {...feedback}>
    {children}
  </motion.div>;
});

type HistoryRowProps = {
  thread: HistoryThread;
  selected: boolean;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  deleting: boolean;
  renaming: boolean;
  mutationPending: boolean;
  onRemovedFocus: () => void;
};

function HistoryRow({ thread, selected, onSelect, onDelete, onRename, deleting, renaming, mutationPending, onRemovedFocus }: HistoryRowProps) {
  const [action, setAction] = useState<"menu" | "rename" | "delete" | null>(null);
  const [title, setTitle] = useState(thread.title);
  const row = useRef<HTMLLIElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const restoreAfterRemoval = useRef(onRemovedFocus);
  restoreAfterRemoval.current = onRemovedFocus;
  const panelId = useId();
  const working = deleting || renaming;
  const present = useIsPresent();
  const feedback = useChatMotion();
  useEffect(() => {
    if (!present && row.current?.contains(document.activeElement)) restoreAfterRemoval.current();
  }, [present]);
  const close = () => { setAction(null); trigger.current?.focus(); };

  useLayoutEffect(() => {
    const element = row.current;
    return () => {
      if (element?.contains(document.activeElement)) restoreAfterRemoval.current();
    };
  }, []);

  useEffect(() => {
    if (action === "menu") panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    if (action === "rename") { nameInput.current?.focus(); nameInput.current?.select(); }
    if (action === "delete") cancelButton.current?.focus();
  }, [action, working]);

  useEffect(() => {
    if (!action) return;
    const dismiss = (event: PointerEvent) => {
      if (!working && event.target instanceof Node && !row.current?.contains(event.target)) setAction(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [action, working]);

  useEffect(() => {
    if (action === "rename" && !renaming && thread.title === title.trim()) {
      setAction(null);
      trigger.current?.focus();
    }
  }, [thread.title, renaming]);

  return <motion.li exit={feedback.exit} transition={feedback.transition} inert={!present} aria-hidden={!present || undefined} ref={row} className="chat-history-row" onKeyDown={event => {
    if (event.key === "Escape" && action && !working) { event.preventDefault(); event.stopPropagation(); close(); }
  }} onBlur={event => {
    if (action === "menu" && !event.currentTarget.contains(event.relatedTarget)) setAction(null);
  }}>
    <div className="chat-history-row-main" data-selected={selected}>
      <button type="button" className="chat-history-item" data-selected={selected} aria-current={selected ? "true" : undefined} onClick={() => onSelect(thread.id)} title={thread.title}>
        <span className="chat-history-item-text"><span className="thread-title">{thread.title}</span><span className="chat-history-item-meta"><span>{thread.agentName || "Codex"}</span><span className="chat-history-session-status" data-status={thread.status}>{chatStatusLabel(thread.status)}</span></span></span>
      </button>
      <button ref={trigger} type="button" className="chat-history-more" aria-label={`Chat actions for ${thread.title}`} title="Chat actions" aria-haspopup="menu" aria-expanded={action === "menu"} aria-controls={action === "menu" ? panelId : undefined} disabled={working} onClick={() => setAction(action === "menu" ? null : "menu")}>
        <DotsThree aria-hidden="true" />
      </button>
    </div>
    <AnimatePresence initial={false} mode="popLayout">
    {action && <ActionPanel key={action}>
    {action === "menu" && <div ref={panel} id={panelId} className="chat-history-actions" role="menu" aria-label={`Actions for ${thread.title}`} onKeyDown={event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
      <button type="button" role="menuitem" disabled={!onRename || !thread.canRename || mutationPending} onClick={() => { setTitle(thread.title); setAction("rename"); }}><PencilSimple aria-hidden="true" />Rename</button>
      <button type="button" role="menuitem" className="chat-history-delete" disabled={!onDelete || !thread.canDelete || mutationPending} title={thread.status === "running" ? "Stop the current turn before deleting this chat" : undefined} onClick={() => setAction("delete")}><Trash aria-hidden="true" />Delete</button>
    </div>}
    {action === "rename" && <form className="chat-history-edit" aria-label={`Rename ${thread.title}`} onSubmit={event => {
      event.preventDefault();
      if (title.trim() && !mutationPending) {
        if (title.trim() === thread.title) close();
        else onRename?.(thread.id, title.trim());
      }
    }}>
      <label htmlFor={`${panelId}-title`}>Chat name</label>
      <input ref={nameInput} id={`${panelId}-title`} value={title} maxLength={120} required disabled={renaming} onChange={event => setTitle(event.target.value)} />
      <div className="chat-history-edit-buttons">
        <button type="button" className="button" disabled={renaming} onClick={close}>Cancel</button>
        <button type="submit" className="button primary" disabled={mutationPending || !title.trim()}>{renaming ? "Saving…" : "Save"}</button>
      </div>
    </form>}
    {action === "delete" && <div className="chat-history-edit" role="group" aria-label={`Delete ${thread.title}`}>
      <strong>Delete chat?</strong>
      <p>This permanently removes the saved chat. Your environment and files stay unchanged.</p>
      <div className="chat-history-edit-buttons">
        <button ref={cancelButton} type="button" className="button" disabled={deleting} onClick={close}>Cancel</button>
        <button type="button" className="button danger" disabled={mutationPending || !thread.canDelete} onClick={() => onDelete?.(thread.id)}>{deleting ? "Deleting…" : "Delete"}</button>
      </div>
    </div>}
    </ActionPanel>}
    </AnimatePresence>
  </motion.li>;
}
