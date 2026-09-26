import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChatCircle, HardDrives, List, ListChecks, SignOut, X } from "@phosphor-icons/react";

export type AppSection = "tasks" | "environments" | "local-chat";
type ShellNavProps = {
  section: AppSection;
  employeeName: string;
  employeeEmail: string;
  busy: boolean;
  onSectionChange: (section: AppSection) => void;
  onSignOut: () => void;
  children: ReactNode;
};
const sections = [
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "environments", label: "Environments", icon: HardDrives },
  { id: "local-chat", label: "Project chat", icon: ChatCircle },
] as const;

export function ShellNav({ section, employeeName, employeeEmail, busy, onSectionChange, onSignOut, children }: ShellNavProps) {
  const [open, setOpen] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const initials = employeeName.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "U";
  useEffect(() => {
    if (!open) return;
    content.current?.setAttribute("inert", "");
    sidebar.current?.querySelector<HTMLButtonElement>(".shell-close")?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
      if (event.key !== "Tab") return;
      const items = Array.from(sidebar.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []).filter(item => item.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
    };
    const media = matchMedia("(max-width: 768px)");
    const resize = () => {if (!media.matches) setOpen(false);};
    document.addEventListener("keydown", keys);
    media.addEventListener("change", resize);
    return () => {
      content.current?.removeAttribute("inert");
      document.removeEventListener("keydown", keys);
      media.removeEventListener("change", resize);
      if (toggle.current?.getClientRects().length) toggle.current.focus();
      else sidebar.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
    };
  }, [open]);
  return (
    <div className="shell">
      <header className="shell-mobile-header">
        <div className="brand">agentcloud<span className="brand-cursor" aria-hidden="true" /></div>
        <button ref={toggle} className="button ghost" aria-label="Open navigation" aria-controls="desktop-navigation" aria-expanded={open} onClick={() => setOpen(true)}><List aria-hidden="true" /></button>
      </header>
      {open && <button className="shell-backdrop" aria-label="Close navigation" tabIndex={-1} onClick={() => setOpen(false)} />}
      <aside ref={sidebar} className="shell-nav" id="desktop-navigation" data-open={open} aria-label="Desktop navigation">
        <div className="shell-brand"><div className="brand">agentcloud<span className="brand-cursor" aria-hidden="true" /></div></div>
        <button className="button ghost shell-close" aria-label="Close navigation" onClick={() => setOpen(false)}><X aria-hidden="true" /></button>
        <nav className="control-nav" aria-label="App sections">
          {sections.map(({ id, label, icon: Icon }) => <button key={id} type="button" className="section-tab" data-active={section === id} aria-current={section === id ? "page" : undefined} onClick={() => {onSectionChange(id); setOpen(false);}}><Icon aria-hidden="true" /><span>{label}</span></button>)}
        </nav>
        <div className="shell-account">
          <div className="account-identity"><span className="account-avatar" aria-hidden="true">{initials}</span><div className="account-details"><strong>{employeeName}</strong><span title={employeeEmail}>{employeeEmail}</span></div></div>
          <button type="button" className="button ghost" onClick={onSignOut} disabled={busy}><SignOut aria-hidden="true" />Sign out</button>
        </div>
      </aside>
      <div ref={content} className="shell-body">{children}</div>
    </div>
  );
}
