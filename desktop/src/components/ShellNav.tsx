import type { ReactNode, SVGProps } from "react";

export type AppSection = "tasks" | "local-chat";

type ShellNavProps = {
  section: AppSection;
  employeeName: string;
  employeeEmail: string;
  busy: boolean;
  onSectionChange: (section: AppSection) => void;
  onSignOut: () => void;
  children: ReactNode;
};

function initials(name: string, email: string): string {
  const source = name.trim() || email.trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "");
  return letters.join("") || "•";
}

function Icon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      className="shell-nav-icon"
      viewBox="0 0 256 256"
      aria-hidden="true"
      {...props}
    />
  );
}

function TasksIcon() {
  return (
    <Icon>
      <path
        fill="currentColor"
        d="M224 128a8 8 0 0 1-8 8H40a8 8 0 0 1 0-16h176a8 8 0 0 1 8 8Zm-8-56H40a8 8 0 0 0 0 16h176a8 8 0 0 0 0-16Zm0 112H40a8 8 0 0 0 0 16h176a8 8 0 0 0 0-16Z"
      />
    </Icon>
  );
}

function ChatIcon() {
  return (
    <Icon>
      <path
        fill="currentColor"
        d="M216 48H40a16 16 0 0 0-16 16v160a8 8 0 0 0 13.66 5.66L80 187.31V224a8 8 0 0 0 13.66 5.66L136 187.31h80a16 16 0 0 0 16-16V64a16 16 0 0 0-16-16Zm0 123.31h-84.69a8 8 0 0 0-5.65 2.34L96 203.31v-24a8 8 0 0 0-8-8H40V64h176Z"
      />
    </Icon>
  );
}

export function ShellNav({
  section,
  employeeName,
  employeeEmail,
  busy,
  onSectionChange,
  onSignOut,
  children,
}: ShellNavProps) {
  const name = employeeName.trim() || "Signed in";
  const email = employeeEmail.trim();

  return (
    <div className="shell">
      <aside className="shell-sidebar" aria-label="Desktop navigation">
        <div className="shell-brand">
          <div className="brand">
            agentcloud
            <span className="brand-cursor" aria-hidden="true" />
          </div>
        </div>
        <nav className="shell-navigation" aria-label="App sections">
          <button
            type="button"
            className="shell-nav-link"
            data-active={section === "tasks" ? "true" : "false"}
            aria-current={section === "tasks" ? "page" : undefined}
            onClick={() => onSectionChange("tasks")}
          >
            <TasksIcon />
            <span>Tasks</span>
          </button>
          <button
            type="button"
            className="shell-nav-link"
            data-active={section === "local-chat" ? "true" : "false"}
            aria-current={section === "local-chat" ? "page" : undefined}
            onClick={() => onSectionChange("local-chat")}
          >
            <ChatIcon />
            <span>Project chat</span>
          </button>
        </nav>
        <div className="shell-account">
          <div className="account-identity">
            <span className="account-avatar" aria-hidden="true">
              {initials(name, email)}
            </span>
            <div className="account-details">
              <strong className="local-label">{name}</strong>
              {email ? (
                <span className="account-email" title={email}>
                  {email}
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className="button ghost"
            onClick={onSignOut}
            disabled={busy}
          >
            Sign out
          </button>
        </div>
      </aside>
      <div className="shell-body">{children}</div>
    </div>
  );
}
