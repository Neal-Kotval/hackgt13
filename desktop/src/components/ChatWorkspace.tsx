import { useState, type ReactNode } from "react";
import { ChatCircleText, FileCode, TerminalWindow } from "@phosphor-icons/react";
import { CodexEvidence } from "../../../components/codex-evidence";
import { parseCodexEventDetails } from "../../../components/environment-detail/chat-model";
import type { CodexEvent } from "./CodexConversation";
import { ProjectChatTerminal } from "./ProjectChatTerminal";
import "./ChatWorkspace.css";

/** Recorded file changes and the selected environment's real SSH shell alongside chat. */
export function ChatWorkspace({ projectId, runBoxId, shellEnabled, events, children }: {
  projectId: string; runBoxId?: string; shellEnabled: boolean; events: CodexEvent[]; children: ReactNode;
}) {
  const [view, setView] = useState<"chat" | "files">("chat");
  const [shellMode, setShellMode] = useState<"hidden" | "split" | "shell">("hidden");
  const showShell = shellMode !== "hidden";
  const [shellMounted, setShellMounted] = useState(false);
  const files = new Map<string, { details: NonNullable<ReturnType<typeof parseCodexEventDetails>>; updatedAt: string }>();
  for (const event of events) {
    const details = parseCodexEventDetails(event.details);
    if (details?.type !== "fileChange") continue;
    for (const change of details.changes ?? []) files.set(change.path, { details: { ...details, changes: [change] }, updatedAt: event.updatedAt });
  }
  function selectView(next: "chat" | "files") {
    setView(next);
    if (next === "chat" || shellMode === "shell" || matchMedia("(max-width: 768px)").matches) setShellMode("hidden");
  }
  return <section className="chat-workspace" aria-label="Conversation workspace">
    <div className="chat-workspace-toolbar" aria-label="Workspace views">
      <button type="button" className="button ghost" aria-pressed={view === "chat" && !showShell} onClick={() => selectView("chat")}><ChatCircleText aria-hidden="true" />Chat</button>
      <button type="button" className="button ghost" aria-pressed={view === "files" && shellMode !== "shell"} onClick={() => selectView("files")}><FileCode aria-hidden="true" />Files ({files.size})</button>
      <button type="button" className="button ghost chat-workspace-split" aria-pressed={shellMode === "split"} disabled={!runBoxId || (!shellMounted && !shellEnabled)} onClick={() => { setShellMode(shellMode === "split" ? "hidden" : "split"); setShellMounted(true); }}><TerminalWindow aria-hidden="true" />Chat + shell</button>
      <button type="button" className="button ghost" aria-pressed={shellMode === "shell"} disabled={!runBoxId || (!shellMounted && !shellEnabled)} title={!shellEnabled ? "A ready environment with SSH access is required" : undefined} onClick={() => { setShellMode(shellMode === "shell" ? "hidden" : "shell"); setShellMounted(true); }}><TerminalWindow aria-hidden="true" />Shell</button>
    </div>
    <div className="chat-workspace-body" data-shell={showShell} data-mode={shellMode}>
      <div className="chat-workspace-main">
        <div className="chat-workspace-chat" hidden={view !== "chat"}>{children}</div>
        <section className="chat-workspace-files" hidden={view !== "files"} aria-label="Files changed in this conversation">
          <h2>Recorded file changes</h2>
          <p>Latest reported edit for each file in this conversation. These records are not a live file browser or a combined Git diff.</p>
          {files.size ? [...files].map(([path, file]) => <div key={path}><CodexEvidence text="File change" details={file.details} /></div>) : <p role="status">No file changes have been reported in this conversation yet.</p>}
        </section>
      </div>
      {shellMounted && runBoxId ? <aside className="chat-workspace-shell" hidden={!showShell} aria-label="Environment shell"><ProjectChatTerminal projectId={projectId} runBoxId={runBoxId} onClose={() => { setShellMode("hidden"); setShellMounted(false); }} /></aside> : null}
    </div>
  </section>;
}
