import type { ReactNode } from "react";

export type AppSection = "tasks" | "environments" | "local-chat";

type ShellNavProps = {
  section: AppSection;
  employeeLabel: string;
  busy: boolean;
  onSectionChange: (section: AppSection) => void;
  onSignOut: () => void;
  children: ReactNode;
};

export function ShellNav({
  section,
  employeeLabel,
  busy,
  onSectionChange,
  onSignOut,
  children,
}: ShellNavProps) {
  return (
    <div className="shell">
      <header className="shell-nav" aria-label="Primary">
        <div className="shell-brand">
          <div className="brand">AgentCloud</div>
          <div className="local-label" title={employeeLabel}>
            {employeeLabel}
          </div>
        </div>
        <nav className="control-nav" aria-label="App sections">
          <button
            type="button"
            className="section-tab"
            data-active={section === "tasks" ? "true" : "false"}
            aria-current={section === "tasks" ? "page" : undefined}
            onClick={() => onSectionChange("tasks")}
          >
            Tasks
          </button>
          <button
            type="button"
            className="section-tab"
            data-active={section === "environments" ? "true" : "false"}
            aria-current={section === "environments" ? "page" : undefined}
            onClick={() => onSectionChange("environments")}
          >
            Environments
          </button>
          <button
            type="button"
            className="section-tab"
            data-active={section === "local-chat" ? "true" : "false"}
            aria-current={section === "local-chat" ? "page" : undefined}
            onClick={() => onSectionChange("local-chat")}
          >
            Project chat
          </button>
        </nav>
        <button
          type="button"
          className="button ghost"
          onClick={onSignOut}
          disabled={busy}
        >
          Sign out
        </button>
      </header>
      <div className="shell-body">{children}</div>
    </div>
  );
}
