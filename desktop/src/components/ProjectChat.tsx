import { useEffect, useRef, useState, type ReactNode } from "react";
import { desktopApi } from "../lib/desktop-api";
import type { DeepLinkParseResult, ProjectSnapshot } from "../lib/types";
import { CodexConversation } from "./CodexConversation";
import { CodexPanel } from "./CodexPanel";
import { ChatProjectPicker } from "./ChatProjectPicker";
import { ChatHistory } from "./ChatHistory";
import { canOpenTerminal, runBoxStateLabel, type RunBoxSummary } from "../lib/run-boxes";
import "./ProjectChat.css";

type Conversation = { projectId: string; box: RunBoxSummary; title: string; updatedAt: string; busy: boolean };

/** Chat always executes through the same verified environment/SSH bridge as Environments. */
export function ProjectChat({ webBaseUrl, deepLink, onDeepLinkHandled, onSelectConversation, onOpenTerminal, children }: {
  webBaseUrl: string;
  deepLink: DeepLinkParseResult | null;
  onDeepLinkHandled: () => void;
  onSelectConversation?: () => void;
  onOpenTerminal?: (projectId: string, runBoxId: string) => void;
  children: (chat: { content: ReactNode; sidebar: (close: () => void) => ReactNode; busy: boolean }) => ReactNode;
}) {
  const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
  const [projectId, setProjectId] = useState("");
  const [runBoxes, setRunBoxes] = useState<RunBoxSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [conversations, setConversations] = useState<Record<string, Conversation>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const requestedBox = useRef<string | null>(null);
  const blockAutoProject = useRef(false);
  const busy = Object.values(conversations).some(item => item.busy);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const selected = conversations[selectedId];
  useEffect(() => {
    let cancelled = false;
    desktopApi().getState().then(state => {
      if (cancelled) return;
      setProjects(state.projects);
      if (deepLink?.ok) {
        if (busyRef.current) {
          setError("Finish or stop the current operation before opening another environment.");
        } else if (!state.projects.some(project => project.id === deepLink.target.projectId)) {
          blockAutoProject.current = true;
          setProjectId(""); setSelectedId(""); setRunBoxes([]); requestedBox.current = null;
          setError("The linked project is not available to your account. Choose a project to continue.");
        } else {
          setProjectId(deepLink.target.projectId); setSelectedId("");
          requestedBox.current = deepLink.target.runBoxId || deepLink.target.taskRunBoxId || null;
          setError(deepLink.target.codexSessionId ? "This legacy test-agent link is no longer used. Choose a ready project environment to chat." : null);
          setRetry(value => value + 1);
        }
        onDeepLinkHandled();
      } else if (!blockAutoProject.current) setProjectId(current => current || state.projects[0]?.id || "");
      setLoading(false);
    }).catch(cause => {
      if (!cancelled) { setError(cause.message); setLoading(false); onDeepLinkHandled(); }
    });
    return () => { cancelled = true; };
  }, [deepLink, onDeepLinkHandled]);

  useEffect(() => {
    setRunBoxes([]);
    if (!projectId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const boxes = (await desktopApi().listRunBoxes(projectId)).filter(box => box.projectId === projectId);
        if (cancelled) return;
        setRunBoxes(boxes);
        if (requestedBox.current) {
          const box = boxes.find(item => item.id === requestedBox.current);
          if (box && canOpenTerminal(box)) {
            const id = box.id;
            setConversations(current => ({ ...current, [id]: current[id] || { projectId, box, title: `Codex · ${box.profileId || box.id}`, updatedAt: new Date().toISOString(), busy: false } }));
            setSelectedId(id); requestedBox.current = null; setError(null);
          } else setError(box ? `The linked environment is ${runBoxStateLabel(box).toLowerCase()}. Chat will open once SSH is ready.` : "The linked environment is not available in this project. Choose an environment explicitly to continue.");
        }
        setConversations(current => Object.fromEntries(Object.entries(current).map(([id, item]) => [id, item.projectId !== projectId ? item : { ...item, box: boxes.find(box => box.id === id) || { ...item.box, state: "unknown", ssh: null } }])));
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not load environments.");
          setRunBoxes([]);
          setConversations(current => Object.fromEntries(Object.entries(current).map(([id, item]) => [id, item.projectId === projectId ? { ...item, box: { ...item.box, state: "unknown", ssh: null } } : item])));
        }
      } finally { if (!cancelled) { setLoading(false); timer = setTimeout(poll, 5000); } }
    };
    setLoading(true); void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [projectId, retry]);

  function chooseProject(id: string) {
    if (busy) return;
    setProjectId(id); setSelectedId(""); requestedBox.current = null; setError(null); onSelectConversation?.();
  }
  function chooseEnvironment(id: string) {
    if (busy) return;
    const box = runBoxes.find(item => item.id === id);
    if (!box || !canOpenTerminal(box)) return;
    requestedBox.current = null; setError(null);
    setConversations(current => ({ ...current, [id]: current[id] || { projectId, box, title: `Codex · ${box.profileId || box.id}`, updatedAt: new Date().toISOString(), busy: false } }));
    setSelectedId(id); onSelectConversation?.();
  }
  const environmentsUrl = projectId ? `${webBaseUrl}/projects/${encodeURIComponent(projectId)}/environments` : webBaseUrl;
  const context = (variant: "empty" | "header" | "toolbar") => <ChatProjectPicker
    variant={variant} projectId={projectId} sessionId="codex" projects={projects.map(project => ({ value: project.id, label: project.name }))}
    agents={[{ value: "codex", label: "Codex" }]} environments={runBoxes.map(box => ({ value: box.id, label: box.profileId || box.id, status: runBoxStateLabel(box), disabled: !canOpenTerminal(box) }))}
    environmentValue={selectedId} environmentTone={selected && canOpenTerminal(selected.box) ? "success" : "muted"} disabled={busy}
    onProject={chooseProject} onAgent={() => {}} onEnvironment={chooseEnvironment}
  />;
  const sidebar = (close: () => void) => <ChatHistory threads={Object.entries(conversations).map(([id, item]) => ({ id, title: item.title, updatedAt: item.updatedAt, status: item.busy ? "running" : "ready" }))}
    selectedId={selectedId} busy={busy} loading={loading} setupUrl={environmentsUrl}
    onSelect={id => { if (busy) return; const item = conversations[id]; setProjectId(item.projectId); setSelectedId(id); requestedBox.current = null; setError(null); onSelectConversation?.(); close(); }}
    onCreate={() => { if (busy) return; setSelectedId(""); requestedBox.current = null; setError(null); onSelectConversation?.(); close(); }}
  />;
  const content = <div className="app-shell"><main className="main project-chat-main" data-empty={!selected}>
    <header className="main-header"><h1 title={selected?.title}>{selected?.title || "Project chat"}</h1><div className="project-chat-status">
      {selected && <button type="button" className="button ghost" disabled={busy || !canOpenTerminal(selected.box)} onClick={() => onOpenTerminal?.(projectId, selectedId)}>Terminal</button>}
    </div></header>
    {error && <p className="error-banner" role="alert">{error} <button className="button ghost" onClick={() => setRetry(value => value + 1)}>Refresh environments</button></p>}
    {!selected && <CodexConversation events={[]} working={false} emptyContent={<div className="chat-context-empty-state">{context("empty")}<p>{loading ? "Loading environments…" : "Choose a ready environment to chat with Codex."}</p><a className="button ghost" href={environmentsUrl} target="_blank" rel="noreferrer">Manage environments</a></div>} />}
    {Object.entries(conversations).map(([id, item]) => <div className="environment-chat-session" hidden={id !== selectedId} key={id}>
      <CodexPanel runBoxId={id} projectId={item.projectId} title={item.box.profileId || item.box.id} chat={{ context: context("toolbar"), ready: canOpenTerminal(item.box), onBusy: value => setConversations(current => current[id]?.busy === value ? current : { ...current, [id]: { ...current[id], busy: value } }), onTitle: title => setConversations(current => ({ ...current, [id]: { ...current[id], title, updatedAt: new Date().toISOString() } })) }} />
    </div>)}
  </main></div>;
  return children({ content, sidebar, busy });
}
