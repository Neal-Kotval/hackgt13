"use client";
import { Select } from "@/components/ui/select";
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
import { Skeleton, SkeletonHeading, SkeletonPanel, SkeletonRegion, SkeletonRows } from "./ui/skeleton";
import { ResourceGraph } from "./resource-graph";
import { Environments } from "./environments";
import { EnvironmentDetail } from "./environment-detail";
import { AgentSettings } from "./environments/agent-settings";
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
// Section links remount this route, so keep the last snapshot in the browser to
// render the next section immediately while the stream reconnects. Server renders
// never read it, so one visitor's workspace cannot reach another request.
let workspaceSnapshot: State | null = null;
export function CloudApp() {
  const pathname = usePathname();
  const router = useRouter();
  const [state, setState] = useState<State | null>(() => typeof window === "undefined" ? null : workspaceSnapshot);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [online, setOnline] = useState<boolean | null>(null);
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
  // /projects/:projectId/environments/:jobId renders one environment's detail page.
  const environmentId = page === "environments" && pieces[3] ? decodeURIComponent(pieces[3]) : "";
  const tab = ["board", "services", "activity"].includes(page) ? page : "overview";
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
    if (state) workspaceSnapshot = state;
  }, [state]);
  useEffect(() => {
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
  if (!state)
    return (
      <>
        <main className="app-shell" id="workspace-content" tabIndex={-1}>
          {error ? (
            <div className="workspace-load-error">
              <div role="alert" className="alert error">
                <Warning />
                {error}
              </div>
              <button className="button" onClick={() => location.reload()}>
                Try again
              </button>
            </div>
          ) : (
            <WorkspaceSkeleton
              view={isProjects ? "projects" : isSetup ? "setup" : page === "dashboard" ? "overview" : "section"}
            />
          )}
        </main>
      </>
    );
  return (
    <>
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
              {environmentId ? (
                <>
                  <Link href={base + "/environments"}>environments</Link>
                  <CaretRight />
                  <span>{environmentId.slice(0, 8)}</span>
                </>
              ) : (
                <span>{page === "dashboard" ? "overview" : page}</span>
              )}
            </>
          )}
          {online === false && (
            <span className="connection" role="status">
              <span className="status-dot" />
              reconnecting…
            </span>
          )}
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
            {page === "dashboard" ? <>
            <section className="project-heading">
              <div>
                <div className="eyebrow">
                  <span className="status-dot" />
                  Project workspace
                </div>
                <h1>{project.name}</h1>
                <p>
                  Follow your project’s progress and results.
                </p>
              </div>
              <div className="heading-actions">
                <Link className="button primary" href={base + "/environments"}>
                  <Plus />
                  Manage environments
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
              <span className="meta-right">Project workspace pending</span>
            </div>
            </> : environmentId ? null : <h1 className="visually-hidden project-section-title">{({board: "Task board", desktop: "Agent settings"} as Record<string, string>)[page] ?? page.charAt(0).toUpperCase() + page.slice(1)}</h1>}
            {environmentId ? (
              <EnvironmentDetail key={environmentId} projectId={project.id} jobId={environmentId} />
            ) : page === "environments" ? (
              <div className="project-sections">
                <Environments project={project} />
                {/* The Environments flow above is the primary path. Saved requests and
                    manual approvals stay available here for existing flows. */}
                <details className="project-disclosure">
                  <summary>Request history &amp; advanced requests</summary>
                  <ResourceRequests project={project} onAction={resourceAction} />
                </details>
                <details className="project-disclosure">
                  <summary>Machines &amp; resource catalog</summary>
                  <p className="section-description">Save the machines and resources your project may use. Registration alone does not connect or verify a machine.</p>
                  <ResourceCatalog project={project} onAction={resourceAction} />
                </details>
              </div>
            ) : page === "settings" || page === "agents" || page === "desktop" ? (
              <AgentSettings key={project.id} project={project} />
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
                {tab === "overview" ? (
                  <div className="project-sections">
                    <section className="workspace-card">
                      <SectionTitle label="Environments" />
                      <p>Set up the machine your agent will use, then follow its request and approval status.</p>
                      <dl>
                        <dt>Saved resources</dt><dd>{(project.resources ?? []).length}</dd>
                        <dt>Resource requests</dt><dd>{(project.resourceRequests ?? []).length}</dd>
                      </dl>
                      <p className="muted">Saved resources are configuration records. Check requests for allocation and verification evidence.</p>
                      <Link className="button secondary" href={base + "/environments"}>Manage environments <ArrowUpRight /></Link>
                    </section>
                    <section>
                      <SectionTitle label="Task progress" number={project.tasks.length} />
                      <p className="section-description">Monitor tasks here. The desktop app is the intended place to create tasks and send instructions; its integration is still in progress.</p>
                      <TaskTable project={project} />
                    </section>
                    <section className="workspace-card">
                      <SectionTitle label="Agent activity" number={project.agents.length} />
                      <p>See connection status, recorded activity, and command results reported by your agents.</p>
                      <Link className="button secondary" href={base + "/runs"}>View runs <ArrowUpRight /></Link>
                    </section>
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
            alto <span className="muted">/ workspace</span>
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
              className="button success"
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
    </>
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
function TaskTable({ project }: { project: Project }) {
  if (!project.tasks.length)
    return (
      <Empty
        title="No tasks yet"
        text="Tasks will appear here when they are added to this project."
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
                <Tag tone={t.status === "done" ? "green" : t.status === "blocked" ? "yellow" : t.status === "in progress" ? "cyan" : "neutral"}>{t.status}</Tag>
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
        <span>alto</span> activity stream
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
// Mirrors the breadcrumb, heading, and panel geometry of each workspace view.
function WorkspaceSkeleton({ view }: { view: "projects" | "setup" | "overview" | "section" }) {
  return (
    <SkeletonRegion label="Loading workspace">
      <div className="breadcrumb"><Skeleton width="20" /></div>
      {view === "projects" ? (
        <>
          <SkeletonHeading />
          <div className="projects-summary"><Skeleton width="20" /></div>
          <div className="project-list skeleton-project-list"><SkeletonRows count={3} /></div>
        </>
      ) : view === "setup" ? (
        <>
          <SkeletonHeading action={false} />
          <SkeletonPanel rows={0} lines={2} action />
        </>
      ) : view === "overview" ? (
        <>
          <SkeletonHeading />
          <div className="project-meta"><Skeleton width="50" /></div>
          <div className="project-sections">
            <SkeletonPanel rows={2} icon={false} lines={1} action />
            <SkeletonPanel rows={2} />
          </div>
        </>
      ) : (
        <div className="project-sections">
          <SkeletonPanel rows={3} lines={1} />
          <SkeletonPanel rows={0} lines={1} />
        </div>
      )}
    </SkeletonRegion>
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
            Create a project to save repository details, then open Environments
            to request and verify a machine.
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
                      ? "Choose a ready environment after project setup"
                      : "Save an SSH address as project metadata"}
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
              <p>Set up an environment, then add Codex in Settings.</p>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <h3>Coordinate the work</h3>
              <p>Open desktop and give Codex work through chat.</p>
            </div>
          </li>
        </ol>
        <div className="info-note">
          <ShieldCheck />
          This form saves project setup intent. Environment allocation and SSH
          verification happen separately in Environments.
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
