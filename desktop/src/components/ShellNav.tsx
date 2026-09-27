import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChatCircle,
  HardDrives,
  List,
  SignOut,
  X,
} from "@phosphor-icons/react";

export type AppSection = "environments" | "local-chat";
type ShellNavProps = {
  section: AppSection;
  employeeName: string;
  employeeEmail: string;
  busy: boolean;
  onSectionChange: (section: AppSection) => void;
  onSignOut: () => void;
  children: ReactNode;
  renderHistory?: (closeNavigation: () => void) => ReactNode;
};
const sections = [
  { id: "environments", label: "Environments", icon: HardDrives },
  { id: "local-chat", label: "Project chat", icon: ChatCircle },
] as const;

export function ShellNav({
  section,
  employeeName,
  employeeEmail,
  busy,
  onSectionChange,
  onSignOut,
  children,
  renderHistory,
}: ShellNavProps) {
  const [open, setOpen] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const searchRequested = useRef(false);
  useEffect(() => {
    const openSearch = () => {
      if (
        matchMedia("(max-width: 768px)").matches &&
        !sidebar.current?.getClientRects().length
      ) {
        searchRequested.current = true;
        setOpen(true);
      } else
        sidebar.current
          ?.querySelector<HTMLInputElement>(".chat-history-search input")
          ?.focus();
    };
    window.addEventListener("alto:open-chat-search", openSearch);
    return () =>
      window.removeEventListener("alto:open-chat-search", openSearch);
  }, []);
  const initials =
    employeeName
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "U";
  useEffect(() => {
    if (!open) return;
    content.current?.setAttribute("inert", "");
    if (searchRequested.current) {
      sidebar.current
        ?.querySelector<HTMLInputElement>(".chat-history-search input")
        ?.focus();
      searchRequested.current = false;
    } else
      sidebar.current
        ?.querySelector<HTMLButtonElement>(".shell-close")
        ?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
      if (event.key !== "Tab") return;
      const items = Array.from(
        sidebar.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), a[href], input:not(:disabled)",
        ) ?? [],
      ).filter((item) => item.getClientRects().length);
      const first = items[0],
        last = items[items.length - 1];
      if (!sidebar.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const media = matchMedia("(max-width: 768px)");
    const resize = () => {
      if (!media.matches) setOpen(false);
    };
    document.addEventListener("keydown", keys);
    media.addEventListener("change", resize);
    return () => {
      content.current?.removeAttribute("inert");
      document.removeEventListener("keydown", keys);
      media.removeEventListener("change", resize);
      if (toggle.current?.getClientRects().length) toggle.current.focus();
      else
        sidebar.current
          ?.querySelector<HTMLButtonElement>('[aria-current="page"]')
          ?.focus();
    };
  }, [open]);
  // A deleted history row can remove the focused control while the drawer is open.
  useEffect(() => {
    if (
      !open ||
      busy ||
      (document.activeElement &&
        document.activeElement !== document.body &&
        document.activeElement.isConnected)
    )
      return;
    const next =
      sidebar.current?.querySelector<HTMLButtonElement>(".chat-history-item") ??
      sidebar.current?.querySelector<HTMLButtonElement>(".shell-close");
    next?.focus();
  }, [busy, open, renderHistory]);
  return (
    <div className="shell">
      <header className="shell-mobile-header">
        <div className="brand">
          alto
          <span className="brand-dot" aria-hidden="true">.</span>
        </div>
        <button
          ref={toggle}
          className="button ghost"
          aria-label="Open navigation"
          aria-controls="desktop-navigation"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <List aria-hidden="true" />
        </button>
      </header>
      {open && (
        <button
          className="shell-backdrop"
          aria-label="Close navigation"
          tabIndex={-1}
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        ref={sidebar}
        className="shell-nav"
        id="desktop-navigation"
        data-open={open}
        aria-label="Desktop navigation"
      >
        <div className="shell-brand">
          <div className="brand">
            alto
            <span className="brand-dot" aria-hidden="true">.</span>
          </div>
        </div>
        <button
          className="button ghost shell-close"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        >
          <X aria-hidden="true" />
        </button>
        <nav className="control-nav" aria-label="App sections">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className="section-tab"
              data-active={section === id}
              aria-current={section === id ? "page" : undefined}
              onClick={() => {
                onSectionChange(id);
                setOpen(false);
              }}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {renderHistory?.(() => setOpen(false))}
        <div className="shell-account">
          <div className="account-identity">
            <span className="account-avatar" aria-hidden="true">
              {initials}
            </span>
            <div className="account-details">
              <strong>{employeeName}</strong>
              <span title={employeeEmail}>{employeeEmail}</span>
            </div>
          </div>
          <button
            type="button"
            className="button ghost"
            onClick={onSignOut}
            disabled={busy}
          >
            <SignOut aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>
      <div ref={content} className="shell-body">
        {children}
      </div>
    </div>
  );
}
