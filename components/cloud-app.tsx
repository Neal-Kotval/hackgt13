"use client";
import { Select } from "@/components/ui/select";
import { EmployeeMenu } from "./employee-auth";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  TerminalWindow,
  SquaresFour,
  GitBranch,
  Plus,
  ArrowUpRight,
  ArrowRight,
  Check,
  Copy,
  CaretRight,
  CaretDown,
  Command,
  Lightning,
  PlugsConnected,
  Globe,
  Database,
  Clock,
  GitPullRequest,
  ShieldCheck,
  X,
  Users,
  Code,
  PaperPlaneTilt,
  Desktop,
  Warning,
  ListChecks,
  Circle,
  FolderSimple,
  CheckCircle,
  DotsThree,
  HardDrives,
} from "@phosphor-icons/react";
import type { State, Project, Agent, Task, Handoff } from "@/lib/types";
import { ResourceCatalog, ResourceRequests, InferenceDraft } from "./resources";
import { RunControl } from "./runs/run-control";
import { ResourceGraph } from "./resource-graph";
type Tab = "overview" | "board" | "services" | "activity";
type Action = Record<string, unknown>;
const iconProps = { weight: "duotone" as const };
function Icon({ children }: { children: ReactNode }) {
  return <span className="icon">{children}</span>;
}
function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span className={`tag ${tone}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}
function ownerName(p: Project, id: string) {
  return p.agents.find((a) => a.id === id)?.name || id;
}
function agentTone(id: string) {
  return id.toLowerCase().includes("claude")
    ? "pink"
    : id.toLowerCase().includes("review")
      ? "yellow"
      : "cyan";
}
function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}
export function CloudApp() {
  const pathname = usePathname();
  const router = useRouter();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [online, setOnline] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"task" | "handoff" | null>(null);
  const [selectedHandoff, setSelectedHandoff] = useState<Handoff | null>(null);
  const [filter, setFilter] = useState("all");
  const pieces = pathname.split("/").filter(Boolean);
  const isProjects = pathname === "/projects";
  const isSetup = pathname === "/projects/new";
  const id = pieces[0] === "projects" ? pieces[1] : undefined;
  const project =
    id && id !== "new"
      ? state?.projects.find((p) => p.id === id)
      : state?.projects[0];
  const page = pieces[2] || "dashboard";
  const refresh = async () => {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error("Could not load projects.");
    setState(await response.json());
  };
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const source = new EventSource("/api/events");
    source.onmessage = (e) => {
      setState(JSON.parse(e.data));
      setOnline(true);
    };
    source.onopen = () => setOnline(true);
    source.onerror = () => setOnline(false);
    return () => source.close();
  }, []);
  useEffect(() => {
    setTab("overview");
    setFilter("all");
  }, [pathname]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  async function action(body: Action) {
    setBusy(true);
    try {
      const r = await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project?.id, ...body }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Could not save changes.");
      if (data.state) setState(data.state);
      else await refresh();
      return data;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function resourceAction(body: Action) {
    const response = await fetch("/api/resources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, projectId: project?.id }),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Could not save resource record.");
    if (data.state) setState(data.state);
    return data;
  }
  const base = `/projects/${project?.id || id || ""}`;
  const nav = [
    {
      label: "Projects",
      url: "/projects",
      icon: <SquaresFour {...iconProps} />,
    },
    ...(project
      ? [
          {
            label: "Workspace",
            url: base,
            icon: <TerminalWindow {...iconProps} />,
          },
          {
            label: "Review",
            url: base + "/review",
            icon: <GitPullRequest {...iconProps} />,
          },
          {
            label: "Connect",
            url: base + "/agents",
            icon: <PlugsConnected {...iconProps} />,
          },
        ]
      : []),
  ];
  const isActiveNav = (label: string) =>
    (label === "Projects" && (isProjects || isSetup)) ||
    (label === "Workspace" &&
      !isProjects &&
      !isSetup &&
      ["dashboard", "resources", "requests", "runs", "graph", "inference", "desktop"].includes(page)) ||
    (label === "Review" && page === "review") ||
    (label === "Connect" && page === "agents");
  if (!state)
    return (
      <main className="loading">
        <TerminalWindow {...iconProps} />
        <h1>
          agentcloud<span className="cyan-text">_</span>
        </h1>
        <p>{error || "Opening your workspace…"}</p>
        {error && (
          <button className="button" onClick={() => location.reload()}>
            Try again
          </button>
        )}
      </main>
    );
  return (
    <div className="app-frame">
      <a className="skip-link" href="#workspace-content">
        Skip to content
      </a>
      <header className="global-header">
        <Link className="brand" href="/projects">
          agentcloud
          <span className="brand-cursor" aria-hidden="true" />
        </Link>
        <nav aria-label="Main navigation">
          {nav.map((n) => (
            <Link
              key={n.label}
              className={isActiveNav(n.label) ? "active" : ""}
              aria-current={isActiveNav(n.label) ? "page" : undefined}
              href={n.url}
            >
              <Icon>{n.icon}</Icon>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="header-right">
          <EmployeeMenu />
        </div>
      </header>
      <main className="app-shell" id="workspace-content" tabIndex={-1}>
        <div className="breadcrumb">
          <Link href="/projects">workspace</Link>
          <CaretRight />
          {isProjects ? (
            <span>projects</span>
          ) : isSetup ? (
            <span>new project</span>
          ) : (
            <>
              <Link href={base}>
                {project?.name.toLowerCase().replaceAll(" ", "-")}
              </Link>
              <CaretRight />
              <span>{page === "dashboard" ? "overview" : page}</span>
            </>
          )}
          <span className={`connection ${online ? "connected" : ""}`}>
            <span className="status-dot" />
            {online ? "stream connected" : "reconnecting…"}
          </span>
        </div>
        {error && (
          <div role="alert" className="alert error">
            <Warning />
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X />
            </button>
          </div>
        )}
        {isProjects ? (
          <Projects projects={state.projects} />
        ) : isSetup ? (
          <Setup
            onCreate={async (values) => {
              const result = await action({ type: "createProject", ...values });
              if (result) router.push("/projects/" + result.id);
            }}
            busy={busy}
          />
        ) : !project ? (
          <div className="empty">
            <h1>{id ? "Project not found" : "No projects yet"}</h1>
            <Link className="button primary" href="/projects/new">
              Create a project
            </Link>
          </div>
        ) : (
          <>
            <section className="project-heading">
              <div>
                <div className="eyebrow">
                  <span className="status-dot" />
                  Remote control plane / setup pending
                </div>
                <h1>{project.name}</h1>
                <p>
                  Coordinate work, inspect requests, and follow recorded
                  activity.
                </p>
              </div>
              <div className="heading-actions">
                <Link className="button primary" href={base + "/agents"}>
                  <Plus />
                  Connect agent
                </Link>
              </div>
            </section>
            <div className="project-meta">
              <span>
                <GitBranch />
                {project.repo.replace(/^https?:\/\//, "")}
              </span>
              <span>
                <HardDrives />
                {project.compute}
              </span>
              <span>
                <ShieldCheck />
                Saved to disk
              </span>
              <span className="meta-right">Provisioning not configured</span>
            </div>
            <div className="demo-note">
              <Warning />
              <span>Project saved.</span>
              <span className="muted">
                Resource records and requests are local. Remote compute, GPU
                execution, and Git worktrees are not provisioned yet.
              </span>
            </div>
            <nav className="control-nav" aria-label="Project control plane">
              {[
                ["Resources", "resources"],
                ["Requests", "requests"],
                ["Runs", "runs"],
                ["Graph", "graph"],
                ["Inference", "inference"],
              ].map(([label, segment]) => (
                <Link
                  key={segment}
                  href={base + "/" + segment}
                  aria-current={page === segment ? "page" : undefined}
                  className={page === segment ? "active" : ""}
                >
                  {label}
                </Link>
              ))}
            </nav>
            {page === "agents" ? (
              <AgentSetup
                project={project}
                action={action}
                busy={busy}
                notify={setNotice}
              />
            ) : page === "review" ? (
              <Review
                project={project}
                action={action}
                busy={busy}
                openHandoff={(h) => {
                  setSelectedHandoff(h);
                  setModal("handoff");
                }}
              />
            ) : page === "desktop" ? (
              <DesktopPage project={project} notify={setNotice} />
            ) : page === "resources" ? (
              <ResourceCatalog project={project} onAction={resourceAction} />
            ) : page === "requests" ? (
              <ResourceRequests project={project} onAction={resourceAction} />
            ) : page === "runs" ? (
              <RunControl project={project} />
            ) : page === "graph" ? (
              <ResourceGraph project={project} />
            ) : page === "inference" ? (
              <InferenceDraft project={project} onAction={resourceAction} />
            ) : (
              <>
                <div
                  className="workspace-tabs"
                  role="tablist"
                  aria-label="Workspace views"
                >
                  {(["overview", "board", "services", "activity"] as Tab[]).map(
                    (t) => (
                      <button
                        key={t}
                        role="tab"
                        aria-selected={tab === t}
                        className={tab === t ? "selected" : ""}
                        onClick={() => setTab(t)}
                      >
                        {t === "overview" ? (
                          <SquaresFour />
                        ) : t === "board" ? (
                          <ListChecks />
                        ) : t === "services" ? (
                          <Database />
                        ) : (
                          <Lightning />
                        )}
                        {t === "board"
                          ? "Task board"
                          : t[0].toUpperCase() + t.slice(1)}
                        {t !== "overview" && (
                          <span className="count">
                            {t === "board"
                              ? project.tasks.length
                              : t === "services"
                                ? project.services.length
                                : project.events.length}
                          </span>
                        )}
                      </button>
                    ),
                  )}
                  <Link className="view-link" href={base + "/desktop"}>
                    <Desktop />
                    CLI connection
                    <ArrowUpRight />
                  </Link>
                </div>
                {tab === "overview" ? (
                  <div className="dashboard-grid">
                    <div className="main-column">
                      <section>
                        <SectionTitle
                          label="Agent team"
                          number={project.agents.length}
                          action={
                            <Link href={base + "/agents"}>
                              Manage agents <ArrowUpRight />
                            </Link>
                          }
                        />
                        {project.agents.length ? (
                          <div className="agent-grid">
                            {project.agents.map((a) => (
                              <AgentCard
                                key={a.id}
                                agent={a}
                                project={project}
                              />
                            ))}
                          </div>
                        ) : (
                          <Empty
                            title="Your team starts here"
                            text="Connect an agent, give it a role, and assign its first task."
                            href={base + "/agents"}
                            label="Connect an agent"
                          />
                        )}
                      </section>
                      {project.handoffs.some((h) => !h.accepted) && (
                        <div className="handoff-callout">
                          <div className="handoff-symbol">
                            <PaperPlaneTilt {...iconProps} />
                          </div>
                          <div>
                            <span className="eyebrow pink-text">
                              Handoff · awaiting you
                            </span>
                            <h3>
                              {project.handoffs.find((h) => !h.accepted)!.title}
                            </h3>
                            <p>
                              {ownerName(
                                project,
                                project.handoffs.find((h) => !h.accepted)!.from,
                              )}{" "}
                              <ArrowRight />{" "}
                              {ownerName(
                                project,
                                project.handoffs.find((h) => !h.accepted)!.to,
                              )}{" "}
                              · context ready to pass
                            </p>
                          </div>
                          <button
                            className="button pink-button"
                            onClick={() => {
                              setSelectedHandoff(
                                project.handoffs.find((h) => !h.accepted)!,
                              );
                              setModal("handoff");
                            }}
                          >
                            Review <ArrowUpRight />
                          </button>
                        </div>
                      )}
                      <section>
                        <SectionTitle
                          label="Project tasks"
                          number={project.tasks.length}
                          action={
                            <button onClick={() => setModal("task")}>
                              <Plus />
                              New task
                            </button>
                          }
                        />
                        <TaskTable
                          project={project}
                          action={action}
                          busy={busy}
                        />
                      </section>
                      <section>
                        <SectionTitle
                          label="Shared services"
                          number={project.services.length}
                          action={
                            <button onClick={() => setTab("services")}>
                              View registry <ArrowUpRight />
                            </button>
                          }
                        />
                        <Services project={project} notify={setNotice} />
                      </section>
                    </div>
                    <aside className="side-column">
                      <ActivityFeed project={project} filter="all" />
                      <div className="workspace-card">
                        <div className="section-heading">
                          <span>
                            <HardDrives />
                            Workspace
                          </span>
                          <Tag tone="cyan">pending</Tag>
                        </div>
                        <dl>
                          <dt>Compute</dt>
                          <dd>{project.compute}</dd>
                          <dt>Worktrees</dt>
                          <dd>Not provisioned</dd>
                          <dt>Access</dt>
                          <dd>Trusted clients</dd>
                          <dt>Persistence</dt>
                          <dd>Local disk</dd>
                        </dl>
                        <p>
                          <ShieldCheck />
                          Each client gets a separate identity. Shell
                          restrictions are not claimed.
                        </p>
                      </div>
                      <div className="team-note">
                        <GitBranch {...iconProps} />
                        <p>
                          Work independently.
                          <br />
                          <strong>Build something together.</strong>
                        </p>
                      </div>
                    </aside>
                  </div>
                ) : tab === "board" ? (
                  <section className="standalone">
                    <SectionTitle
                      label="Project board"
                      action={
                        <button
                          className="button secondary"
                          onClick={() => setModal("task")}
                        >
                          <Plus />
                          New task
                        </button>
                      }
                    />
                    <div className="board">
                      {(
                        ["queued", "in progress", "blocked", "done"] as const
                      ).map((status) => (
                        <div className="board-column" key={status}>
                          <h3>
                            <Tag
                              tone={
                                status === "done"
                                  ? "green"
                                  : status === "blocked"
                                    ? "yellow"
                                    : status === "in progress"
                                      ? "cyan"
                                      : "neutral"
                              }
                            >
                              {status}
                            </Tag>
                            <span>
                              {
                                project.tasks.filter((t) => t.status === status)
                                  .length
                              }
                            </span>
                          </h3>
                          {project.tasks
                            .filter((t) => t.status === status)
                            .map((t) => (
                              <div className="task-card" key={t.id}>
                                <span className="muted">{t.id}</span>
                                <h4>{t.title}</h4>
                                {t.instructions ? (
                                  <p className="muted">{t.instructions}</p>
                                ) : null}
                                {t.environmentId ? (
                                  <small>
                                    Environment {t.environmentId}
                                  </small>
                                ) : null}
                                <p
                                  className={
                                    agentTone(ownerName(project, t.owner)) +
                                    "-text"
                                  }
                                >
                                  {ownerName(project, t.owner)}
                                </p>
                                {t.dependency && (
                                  <small>Depends on {t.dependency}</small>
                                )}
                                <StatusSelect
                                  task={t}
                                  action={action}
                                  busy={busy}
                                />
                              </div>
                            ))}
                          {!project.tasks.some((t) => t.status === status) && (
                            <p className="column-empty">
                              No tasks{" "}
                              {status === "queued" ? "waiting" : status}.
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                ) : tab === "services" ? (
                  <section className="standalone">
                    <SectionTitle
                      label="Service registry"
                      number={project.services.length}
                    />
                    <p className="section-description">
                      Agents publish endpoints here so teammates can discover
                      and use their work.
                    </p>
                    <Services project={project} notify={setNotice} />
                    <div className="info-panel">
                      <Code />
                      <div>
                        <h3>Publish from a connected client</h3>
                        <p>
                          Register a running service with the CLI. Registration
                          does not start the service or verify its health.
                        </p>
                        <code>
                          node cli/agentcloud.mjs service {project.id} --agent
                          &lt;agent-id&gt; --name api --url
                          http://your-host:8000
                        </code>
                      </div>
                    </div>
                  </section>
                ) : (
                  <section className="standalone">
                    <SectionTitle
                      label="Activity stream"
                      action={
                        <Select
                          aria-label="Filter activity"
                          value={filter}
                          onChange={(e) => setFilter(e.target.value)}
                        >
                          <option value="all">All agents</option>
                          <option value="human">Human</option>
                          {project.agents.map((a) => (
                            <option value={a.id} key={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </Select>
                      }
                    />
                    <ActivityFeed project={project} filter={filter} />
                  </section>
                )}
              </>
            )}
          </>
        )}
        <footer>
          <span>
            <TerminalWindow />
            agentcloud <span className="muted">/ HackGT build</span>
            <Link href="/design-system">
              Design system <ArrowUpRight />
            </Link>
          </span>
          <span className="muted">
            Single-user development environment
            <span className="footer-dot">●</span> v0.1
          </span>
        </footer>
      </main>
      {notice && (
        <div className="toast" role="status">
          <CheckCircle />
          {notice}
        </div>
      )}
      {modal === "task" && project && (
        <Modal
          title="Create a task"
          close={() => {
            setModal(null);
            setError("");
          }}
        >
          {error && (
            <p className="alert error" role="alert">
              {error}
            </p>
          )}
          <TaskForm
            project={project}
            busy={busy}
            submit={async (values) => {
              if (await action({ type: "addTask", ...values })) {
                setModal(null);
                setNotice("Task created and assigned.");
              }
            }}
          />
        </Modal>
      )}
      {modal === "handoff" && selectedHandoff && project && (
        <Modal
          title="Agent handoff"
          close={() => {
            setModal(null);
            setError("");
          }}
        >
          {error && (
            <p className="alert error" role="alert">
              {error}
            </p>
          )}
          <div className="handoff-detail">
            <span className="eyebrow">
              {ownerName(project, selectedHandoff.from)} <ArrowRight />{" "}
              {ownerName(project, selectedHandoff.to)}
            </span>
            <h3>{selectedHandoff.title}</h3>
            <p>{selectedHandoff.summary}</p>
            <h4>Files reported by agent</h4>
            {selectedHandoff.files.map((f) => (
              <code className="file-line" key={f}>
                <Code />
                {f}
              </code>
            ))}
            <h4>Next step</h4>
            <p>{selectedHandoff.next}</p>
            <button
              className="button primary"
              disabled={busy || selectedHandoff.accepted}
              onClick={async () => {
                if (
                  await action({
                    type: "acceptHandoff",
                    handoffId: selectedHandoff.id,
                  })
                ) {
                  setModal(null);
                  setNotice("Handoff accepted and follow-up assigned.");
                }
              }}
            >
              {selectedHandoff.accepted ? (
                <>
                  <Check />
                  Already accepted
                </>
              ) : (
                <>
                  Assign to {ownerName(project, selectedHandoff.to)}
                  <ArrowRight />
                </>
              )}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function SectionTitle({
  label,
  number,
  action,
}: {
  label: string;
  number?: number;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <h2>
        {label}
        {number !== undefined && (
          <span className="count">{String(number).padStart(2, "0")}</span>
        )}
      </h2>
      {action}
    </div>
  );
}
function Empty({
  title,
  text,
  href,
  label,
}: {
  title: string;
  text: string;
  href?: string;
  label?: string;
}) {
  return (
    <div className="empty">
      <FolderSimple {...iconProps} />
      <h3>{title}</h3>
      <p>{text}</p>
      {href && (
        <Link className="button secondary" href={href}>
          {label}
          <ArrowRight />
        </Link>
      )}
    </div>
  );
}
function AgentCard({ agent, project }: { agent: Agent; project: Project }) {
  const task =
    project.tasks.find(
      (t) => t.owner === agent.id && t.status === "in progress",
    ) || project.tasks.find((t) => t.owner === agent.id && t.status !== "done");
  const tone = agentTone(agent.name);
  return (
    <article className={`agent-card ${tone}`}>
      <div className="agent-card-top">
        <span className="agent-avatar">
          {agent.name === "Codex" ? (
            <Command />
          ) : agent.name === "Claude" ? (
            <span>✳</span>
          ) : (
            <ShieldCheck />
          )}
        </span>
        <Tag
          tone={
            agent.status === "working" || agent.status === "connected"
              ? tone
              : "neutral"
          }
        >
          {agent.status}
        </Tag>
      </div>
      <h3>
        {agent.name}
        <span className="muted">
          / {agent.client === agent.name ? "agent" : agent.client}
        </span>
      </h3>
      <p className="agent-role">{agent.role}</p>
      <div className="branch">
        <GitBranch />
        {agent.branch}
      </div>
      <div className="current-task">
        <span className="muted">Current assignment</span>
        <p>{task?.title || "Ready for the next task"}</p>
      </div>
      <div className="agent-foot">
        <span className="status-dot" />
        {agent.status === "connected"
          ? "Client connected"
          : "Waiting for connection"}
      </div>
    </article>
  );
}
function StatusSelect({
  task,
  action,
  busy,
}: {
  task: Task;
  action: (a: Action) => Promise<unknown>;
  busy: boolean;
}) {
  return (
    <Select
      className={`status-select ${task.status.replace(" ", "-")}`}
      aria-label={`Status for ${task.title}`}
      value={task.status}
      disabled={busy}
      onChange={(e) =>
        action({ type: "taskStatus", taskId: task.id, status: e.target.value })
      }
    >
      {["queued", "in progress", "blocked", "done"].map((s) => (
        <option key={s}>{s}</option>
      ))}
    </Select>
  );
}
function TaskTable({
  project,
  action,
  busy,
}: {
  project: Project;
  action: (a: Action) => Promise<unknown>;
  busy: boolean;
}) {
  if (!project.tasks.length)
    return (
      <Empty
        title="Give your team a direction"
        text="Create a task and choose an agent to own it."
      />
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Owner</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {project.tasks.map((t, i) => (
            <tr key={t.id}>
              <td>
                <span className="task-number">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>{t.title}</span>
                {t.instructions ? (
                  <p className="muted">{t.instructions}</p>
                ) : null}
                {t.environmentId ? (
                  <span className="dependency" title="Bound environment">
                    env {t.environmentId.slice(0, 8)}
                  </span>
                ) : null}
                {t.dependency && (
                  <span
                    className="dependency"
                    title={`Depends on ${t.dependency}`}
                  >
                    <GitBranch />
                  </span>
                )}
              </td>
              <td>
                <span
                  className={`owner ${agentTone(ownerName(project, t.owner))}-text`}
                >
                  <span className="status-dot" />
                  {ownerName(project, t.owner)}
                </span>
              </td>
              <td>
                <StatusSelect task={t} action={action} busy={busy} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Services({
  project,
  notify,
}: {
  project: Project;
  notify: (s: string) => void;
}) {
  if (!project.services.length)
    return (
      <Empty
        title="Shared context starts with a service"
        text="Publish an API or preview from the CLI so another agent can discover it."
      />
    );
  return (
    <div className="services-grid">
      {project.services.map((s) => (
        <article className="service-card" key={s.id}>
          <div className="service-top">
            <span className="service-icon">
              {s.name.includes("api") ? (
                <Database {...iconProps} />
              ) : (
                <Globe {...iconProps} />
              )}
            </span>
            <h3>{s.name}</h3>
            <Tag
              tone={
                s.status === "healthy"
                  ? "green"
                  : s.status === "building"
                    ? "yellow"
                    : "neutral"
              }
            >
              {s.status}
            </Tag>
          </div>
          <button
            className="endpoint"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(s.url);
                notify("Endpoint copied.");
              } catch {
                notify(
                  "Clipboard unavailable. Select the endpoint to copy it.",
                );
              }
            }}
            aria-label={`Copy ${s.name} endpoint`}
          >
            {s.url}
            <Copy />
          </button>
          <div className="service-connection">
            <span className={agentTone(ownerName(project, s.owner)) + "-text"}>
              {ownerName(project, s.owner)}
            </span>
            <ArrowRight />
            <span>
              {s.consumers.length
                ? s.consumers.map((c) => ownerName(project, c)).join(", ")
                : "No consumers yet"}
            </span>
          </div>
        </article>
      ))}
    </div>
  );
}
function ActivityFeed({
  project,
  filter,
}: {
  project: Project;
  filter: string;
}) {
  const events = project.events.filter(
    (e) => filter === "all" || e.actor === filter,
  );
  return (
    <div className="activity-panel">
      <div className="activity-heading">
        <span>
          <TerminalWindow />
          Activity stream
        </span>
        <Tag tone="green">live</Tag>
      </div>
      <div className="terminal-command">
        <span>$</span> agentcloud logs --follow
      </div>
      <div className="timeline">
        {events.length ? (
          events.slice(0, 20).map((e, i) => (
            <article className="event" key={e.id}>
              <div
                className={`event-marker ${agentTone(ownerName(project, e.actor))}-text`}
              >
                {e.kind === "handoff" ? (
                  <PaperPlaneTilt />
                ) : e.kind === "service" ? (
                  <Globe />
                ) : e.kind === "connection" ? (
                  <PlugsConnected />
                ) : (
                  <Code />
                )}
              </div>
              <div>
                <div className="event-meta">
                  <strong
                    className={agentTone(ownerName(project, e.actor)) + "-text"}
                  >
                    {ownerName(project, e.actor)}
                  </strong>
                  <time>{time(e.time)}</time>
                </div>
                <p>{e.text}</p>
                {e.detail && <code>{e.detail}</code>}
                {i === 0 && <span className="latest">latest event</span>}
              </div>
            </article>
          ))
        ) : (
          <p className="empty-log">Waiting for your team’s first event.</p>
        )}
      </div>
      <div className="terminal-end">
        <span className="cursor">▍</span>
        <span>Listening for project events</span>
      </div>
    </div>
  );
}
function Projects({ projects }: { projects: Project[] }) {
  return (
    <>
      <section className="project-heading">
        <div>
          <div className="eyebrow">Your workspace</div>
          <h1>Your projects.</h1>
          <p>Set up your computers. Follow the work.</p>
        </div>
        <Link className="button primary" href="/projects/new">
          <Plus />
          New project
        </Link>
      </section>
      <div className="projects-summary">
        <span>{projects.length} projects</span>
        <span>Local persistence enabled</span>
      </div>
      {!projects.length && (
        <section className="welcome-panel" aria-labelledby="welcome-title">
          <span className="eyebrow">
            <span className="status-dot" />
            Getting started
          </span>
          <h2 id="welcome-title">A place for your next project.</h2>
          <p>
            Create a project to save your repository and machine setup. Remote
            connection and verification are not available yet.
          </p>
          <Link className="button primary" href="/projects/new">
            Create your first project <ArrowRight />
          </Link>
        </section>
      )}
      <div className="project-list">
        {projects.map((p) => (
          <Link className="project-row" href={"/projects/" + p.id} key={p.id}>
            <span className="project-glyph">
              <FolderSimple {...iconProps} />
            </span>
            <div>
              <h2>
                {p.name}
                <Tag tone="neutral">setup pending</Tag>
              </h2>
              <p>{p.repo.replace(/^https?:\/\//, "")}</p>
            </div>
            <div className="project-row-meta">
              <span>
                <Users />
                {p.agents.length} agents
              </span>
              <span>
                <HardDrives />
                {p.compute}
              </span>
            </div>
            <ArrowUpRight />
          </Link>
        ))}
      </div>
      <div className="intro-grid">
        <div>
          <span className="intro-icon">
            <GitBranch {...iconProps} />
          </span>
          <h3>Room to work independently.</h3>
          <p>
            Give each agent a role and a task. Keep ownership clear as your
            project grows.
          </p>
        </div>
        <div>
          <span className="intro-icon">
            <PlugsConnected {...iconProps} />
          </span>
          <h3>Context that travels with the work.</h3>
          <p>
            Discover shared services and pass structured handoffs between
            teammates.
          </p>
        </div>
        <div>
          <span className="intro-icon">
            <Clock {...iconProps} />
          </span>
          <h3>Pick up where you left off.</h3>
          <p>
            Project metadata, tasks, and handoffs stay saved between sessions.
          </p>
        </div>
      </div>
    </>
  );
}
function Setup({
  onCreate,
  busy,
}: {
  onCreate: (a: Action) => Promise<void>;
  busy: boolean;
}) {
  const [compute, setCompute] = useState("Hosted Linux");
  return (
    <div className="setup-layout">
      <section>
        <div className="eyebrow">Project setup</div>
        <h1>Create a project.</h1>
        <p className="section-description">
          Add your repository and choose where the work will happen.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void onCreate({
              name: f.get("name"),
              repo: f.get("repo"),
              template: f.get("template"),
              compute,
              host: f.get("host"),
            });
          }}
        >
          <label>
            Project name
            <input
              name="name"
              placeholder="my-next-big-thing"
              required
              maxLength={60}
            />
          </label>
          <label>
            Git repository
            <input
              name="repo"
              type="url"
              placeholder="https://github.com/your-team/project"
              required
              pattern="https://.*"
            />
            <small>
              Saved as project metadata. Repository cloning is a future step.
            </small>
          </label>
          <label>
            <span className="visually-hidden">Template</span>
            <Select name="template">
              <option>Next.js + Node API</option>
              <option>React + Python API</option>
              <option>Empty workspace</option>
            </Select>
          </label>
          <fieldset>
            <legend>Compute source</legend>
            {["Hosted Linux", "SSH machine"].map((c) => (
              <label
                className={`compute-option ${compute === c ? "chosen" : ""}`}
                key={c}
              >
                <input
                  type="radio"
                  checked={compute === c}
                  onChange={() => setCompute(c)}
                  name="compute"
                />
                <HardDrives />
                <span>
                  <strong>{c}</strong>
                  <small>
                    {c === "Hosted Linux"
                      ? "Managed workspace · provisioning coming next"
                      : "Your own machine · trusted shell access"}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          {compute === "SSH machine" && (
            <label>
              SSH host
              <input name="host" placeholder="user@your-server" required />
              <small>
                Connection details only. No SSH connection is made yet.
              </small>
            </label>
          )}
          <button className="button primary" disabled={busy}>
            {busy ? "Creating…" : "Create project"}
            <ArrowRight />
          </button>
        </form>
      </section>
      <aside className="setup-aside">
        <TerminalWindow {...iconProps} />
        <h2>A team, not a tab collection.</h2>
        <p>
          One project holds the plan, the shared services, and the context that
          connects your agents.
        </p>
        <ol>
          <li>
            <span>01</span>
            <div>
              <h3>Create your project</h3>
              <p>Save the repo and compute preference.</p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <h3>Connect the team</h3>
              <p>Give clients separate tokens and roles.</p>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <h3>Coordinate the work</h3>
              <p>Assign tasks. Publish services. Pass handoffs.</p>
            </div>
          </li>
        </ol>
        <div className="info-note">
          <ShieldCheck />
          This build persists collaboration state locally. It does not provision
          or sandbox remote machines.
        </div>
      </aside>
    </div>
  );
}
function TaskForm({
  project,
  submit,
  busy,
}: {
  project: Project;
  submit: (a: Action) => Promise<void>;
  busy: boolean;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void submit({
          title: f.get("title"),
          owner: f.get("owner"),
          dependency: f.get("dependency"),
        });
      }}
    >
      <label>
        What needs to be done?
        <input
          name="title"
          required
          maxLength={160}
          placeholder="Build the search endpoint"
          autoFocus
        />
      </label>
      <label>
        <span className="visually-hidden">Assign to</span>
        <Select
          name="owner"
          required
          defaultValue={project.agents[0]?.id || ""}
        >
          {!project.agents.length && (
            <option value="">Connect an agent first</option>
          )}
          {project.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} — {a.role}
            </option>
          ))}
        </Select>
      </label>
      <label>
        <span className="visually-hidden">Depends on</span>
        <Select name="dependency" defaultValue="">
          <option value="">No dependency</option>
          {project.tasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </Select>
      </label>
      <button
        className="button primary"
        disabled={busy || !project.agents.length}
      >
        <Plus />
        Create task
      </button>
    </form>
  );
}
function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal-inner">
        <header>
          <h2 id={titleId}>{title}</h2>
          <button
            className="button ghost square"
            aria-label="Close dialog"
            onClick={close}
          >
            <X />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
function AgentSetup({
  project,
  action,
  busy,
  notify,
}: {
  project: Project;
  action: (a: Action) => Promise<any>;
  busy: boolean;
  notify: (s: string) => void;
}) {
  const [result, setResult] = useState<{
    token: string;
    agentId: string;
  } | null>(null);
  const [client, setClient] = useState("Codex");
  return (
    <div className="setup-layout connect-layout">
      <section>
        <SectionTitle label="Connect an agent" />
        <p className="section-description">
          A separate identity for every teammate. Give it a role, then connect
          the CLI.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const data = await action({
              type: "addAgent",
              client,
              role: f.get("role"),
            });
            if (data) {
              setResult(data);
              notify("Agent registered. Save its connection token.");
            }
          }}
        >
          <fieldset>
            <legend>Agent client</legend>
            <div className="client-options">
              {["Codex", "Claude", "Other"].map((c) => (
                <button
                  type="button"
                  key={c}
                  className={client === c ? "selected" : ""}
                  aria-pressed={client === c}
                  onClick={() => setClient(c)}
                >
                  {c === "Codex" ? (
                    <Command />
                  ) : c === "Claude" ? (
                    <span>✳</span>
                  ) : (
                    <Code />
                  )}
                  {c}
                </button>
              ))}
            </div>
          </fieldset>
          <label>
            Role
            <input
              name="role"
              required
              placeholder={
                client === "Codex" ? "Backend engineer" : "Frontend engineer"
              }
              maxLength={80}
            />
          </label>
          <div className="info-note">
            <ShieldCheck />
            Trusted client access to collaboration metadata. This connection
            does not launch an AI tool or enforce filesystem permissions.
          </div>
          <button className="button primary" disabled={busy}>
            <PlugsConnected />
            Generate connection token
          </button>
        </form>
        {result && (
          <div className="token-panel">
            <Tag tone="green">Agent registered</Tag>
            <h3>Save this token now</h3>
            <p>
              It is shown once. Set it as an environment variable in the
              terminal running your client.
            </p>
            <code className="token-value">{result.token}</code>
            <button
              className="button secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(result.token);
                  notify("Connection token copied.");
                } catch {
                  notify("Clipboard unavailable. Select the token to copy it.");
                }
              }}
            >
              <Copy />
              Copy token
            </button>
            <pre>{`export AGENTCLOUD_TOKEN='<your-token>'\nnode cli/agentcloud.mjs connect ${project.id} --agent ${result.agentId}`}</pre>
            <p>Keep this process running to report your connection status.</p>
          </div>
        )}
      </section>
      <aside>
        <SectionTitle label="Project roster" number={project.agents.length} />
        <div className="roster">
          {project.agents.map((a) => (
            <div key={a.id}>
              <span
                className={`agent-avatar ${agentTone(ownerName(project, a.id))}`}
              >
                {a.name.slice(0, 1)}
              </span>
              <div>
                <h3>{a.name}</h3>
                <p>{a.role}</p>
              </div>
              <Tag tone={a.status === "connected" ? "green" : "neutral"}>
                {a.status}
              </Tag>
            </div>
          ))}
        </div>
        <Link className="text-link" href={`/projects/${project.id}/desktop`}>
          CLI setup guide <ArrowUpRight />
        </Link>
      </aside>
    </div>
  );
}
function Review({
  project,
  action,
  busy,
  openHandoff,
}: {
  project: Project;
  action: (a: Action) => Promise<unknown>;
  busy: boolean;
  openHandoff: (h: Handoff) => void;
}) {
  const [selected, setSelected] = useState("handoffs");
  return (
    <section className="standalone">
      <SectionTitle label="Bring the work together" />
      <p className="section-description">
        Read the context, inspect the next step, and keep the team moving.
      </p>
      <div className="review-grid">
        <div>
          <div className="segmented">
            {["handoffs", "changes", "checks"].map((t) => (
              <button
                key={t}
                className={selected === t ? "selected" : ""}
                onClick={() => setSelected(t)}
              >
                {t}
              </button>
            ))}
          </div>
          {selected === "handoffs" ? (
            project.handoffs.length ? (
              project.handoffs.map((h) => (
                <article className="review-card" key={h.id}>
                  <div className="review-card-top">
                    <span className="eyebrow">
                      {ownerName(project, h.from)} <ArrowRight />{" "}
                      {ownerName(project, h.to)}
                    </span>
                    <Tag tone={h.accepted ? "green" : "pink"}>
                      {h.accepted ? "accepted" : "needs review"}
                    </Tag>
                  </div>
                  <h3>{h.title}</h3>
                  <p>{h.summary}</p>
                  <div className="file-chips">
                    {h.files.map((f) => (
                      <code key={f}>
                        <Code />
                        {f}
                      </code>
                    ))}
                  </div>
                  <button
                    className="button secondary"
                    onClick={() => openHandoff(h)}
                  >
                    Read handoff <ArrowUpRight />
                  </button>
                </article>
              ))
            ) : (
              <Empty
                title="No handoffs yet"
                text="When an agent passes work to a teammate, its context will appear here."
              />
            )
          ) : selected === "changes" ? (
            <Empty
              title="Git review is the next step"
              text="Actual worktree diffs and merges require a connected workspace. This build does not execute Git operations."
            />
          ) : (
            <Empty
              title="No test runner connected"
              text="Connect workspace execution before reporting real test results."
            />
          )}
        </div>
        <aside className="review-summary">
          <GitPullRequest {...iconProps} />
          <h3>Human in the loop</h3>
          <p>Agents pass context. You decide what happens next.</p>
          <dl>
            <dt>Handoffs</dt>
            <dd>{project.handoffs.length}</dd>
            <dt>Pending</dt>
            <dd>{project.handoffs.filter((h) => !h.accepted).length}</dd>
            <dt>Completed tasks</dt>
            <dd>
              {project.tasks.filter((t) => t.status === "done").length} /{" "}
              {project.tasks.length}
            </dd>
          </dl>
          <div className="info-note">
            Merge and app preview become available once real workspace execution
            is connected.
          </div>
        </aside>
      </div>
    </section>
  );
}
function DesktopPage({
  project,
  notify,
}: {
  project: Project;
  notify: (s: string) => void;
}) {
  const command = `node cli/agentcloud.mjs connect ${project.id} --agent <agent-id>`;
  return (
    <div className="setup-layout">
      <section>
        <div className="eyebrow">Your local bridge</div>
        <h2 className="large-heading">
          Same tools.
          <br />
          Shared project.
        </h2>
        <p className="section-description">
          The CLI connects a client identity to AgentCloud and keeps your team’s
          context within reach.
        </p>
        <ol className="cli-steps">
          <li>
            <h3>1. Create an agent identity</h3>
            <p>Choose a role and generate a scoped connection token.</p>
            <Link
              className="button secondary"
              href={`/projects/${project.id}/agents`}
            >
              Agent setup <ArrowRight />
            </Link>
          </li>
          <li>
            <h3>2. Set your token</h3>
            <pre>export AGENTCLOUD_TOKEN=&apos;&lt;your-token&gt;&apos;</pre>
          </li>
          <li>
            <h3>3. Connect from this repository</h3>
            <pre>{command}</pre>
            <button
              className="button ghost"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(command);
                  notify(
                    "Connection command copied. Replace <agent-id> with your agent ID.",
                  );
                } catch {
                  notify(
                    "Clipboard unavailable. Select the command to copy it.",
                  );
                }
              }}
            >
              <Copy />
              Copy command
            </button>
          </li>
        </ol>
      </section>
      <aside className="setup-aside">
        <Desktop {...iconProps} />
        <h2>A small bridge for a bigger team.</h2>
        <p>
          The CLI supports real session heartbeats, task updates, service
          registration, and handoffs through the collaboration API.
        </p>
        <div className="info-note">
          <Warning />
          Remote terminals, editor launching, Codex/Claude tool adapters, and a
          native desktop shell are planned. The CLI does not launch an AI agent.
        </div>
        <Link className="text-link" href={`/projects/${project.id}`}>
          Back to workspace <ArrowRight />
        </Link>
      </aside>
    </div>
  );
}
