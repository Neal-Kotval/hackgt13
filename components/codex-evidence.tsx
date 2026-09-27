"use client";

import { useState } from "react";
import { CaretDown, Copy, FileCode, TerminalWindow } from "@phosphor-icons/react";
import { parseCodexEventDetails } from "./environment-detail/chat-model";
import "./codex-evidence.css";

function CopyEvidence({ text, label }: { text: string; label: string }) {
  const [message, setMessage] = useState("");
  return <span className="evidence-copy"><button type="button" onClick={async () => {
    try { await navigator.clipboard.writeText(text); setMessage("Copied"); }
    catch { setMessage("Could not copy"); }
  }} aria-label={label}><Copy aria-hidden="true" />{label}</button><span role="status">{message}</span></span>;
}

function diffLines(diff: string, operation?: string) {
  const plainFile = (operation === "add" || operation === "delete") && !/^@@ /m.test(diff);
  if (plainFile) diff = diff.replace(/\n$/, "").split("\n").map(line => `${operation === "add" ? "+" : "-"}${line}`).join("\n");
  let oldLine = plainFile ? 1 : 0, newLine = plainFile ? 1 : 0;
  return diff.split("\n").map((text, index) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    let kind = "context", before = "", after = "";
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); kind = "hunk"; }
    else if (/^(---|\+\+\+|diff |index |\\)/.test(text)) kind = "header";
    else if (text.startsWith("+")) { kind = "addition"; after = newLine ? String(newLine++) : ""; }
    else if (text.startsWith("-")) { kind = "deletion"; before = oldLine ? String(oldLine++) : ""; }
    else if (text.startsWith(" ") && oldLine) { before = String(oldLine++); after = String(newLine++); }
    return <span className="evidence-diff-line" data-kind={kind} key={index}><span className="evidence-line-number" aria-hidden="true">{before}</span><span className="evidence-line-number" aria-hidden="true">{after}</span><span>{text || " "}</span></span>;
  });
}

/** Shared by web and desktop; native disclosures retain keyboard behavior. */
export function CodexEvidence({ text, details: rawDetails }: { text: string; details?: unknown }) {
  const details = parseCodexEventDetails(rawDetails);
  if (!details) return <details className="codex-evidence"><summary><TerminalWindow aria-hidden="true" /><span className="evidence-title">{text.split("\n").find(line => line.trim()) || "Command details unavailable"}</span><CaretDown aria-hidden="true" /></summary><div className="evidence-body"><p className="evidence-notice">This older event has no structured command or file details.</p><pre className="evidence-output" tabIndex={0}>{text || "No output was saved for this event."}</pre></div></details>;
  const running = ["inProgress", "running", "started"].includes(details.status);
  const failed = ["failed", "declined", "interrupted", "cancelled"].includes(details.status) || (details.exitCode != null && details.exitCode !== 0);
  const status = running ? "Running" : details.status === "completed" ? "Completed" : details.status === "failed" ? "Failed" : details.status.replace(/([a-z])([A-Z])/g, "$1 $2");
  const files = details.changes ?? [];
  const isCommand = details.type === "commandExecution";
  return <details className="codex-evidence" data-state={failed ? "failed" : running ? "running" : "complete"} open={running || undefined}>
    <summary>{isCommand ? <TerminalWindow aria-hidden="true" /> : <FileCode aria-hidden="true" />}<span className="evidence-title">{isCommand ? <code>{details.command || "Command not reported"}</code> : `${files.length} ${files.length === 1 ? "file change" : "file changes"}`}</span><span className="evidence-status">{status}</span><CaretDown className="evidence-caret" aria-hidden="true" /></summary>
    <div className="evidence-body">
      <dl className="evidence-metadata">
        {isCommand ? <><div><dt>Working directory</dt><dd><code>{details.cwd || "Not reported"}</code></dd></div><div><dt>Exit code</dt><dd>{details.exitCode ?? (running ? "Pending" : "Not reported")}</dd></div><div><dt>Duration</dt><dd>{details.durationMs != null ? `${(details.durationMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })} s` : running ? "In progress" : "Not reported"}</dd></div></> : <div><dt>Change status</dt><dd>{status}</dd></div>}
      </dl>
      {isCommand ? <>
        {details.command ? <div className="evidence-section-header"><span>Command</span><CopyEvidence text={details.command} label="Copy command" /></div> : null}
        {details.command ? <pre className="evidence-output" tabIndex={0}>{details.command}</pre> : null}
        <div className="evidence-section-header"><span>Output</span>{details.output ? <CopyEvidence text={details.output} label="Copy output" /> : null}</div>
        {details.output ? <pre className="evidence-output" tabIndex={0}>{details.output}</pre> : <p className="evidence-notice">{running ? "Waiting for command output…" : details.output === "" ? "Command produced no output." : "Output was not reported for this command."}</p>}
      </> : files.length ? files.map((file, index) => {
        const plainFile = (file.kind === "add" || file.kind === "delete") && !/^@@ /m.test(file.diff);
        const lines = file.diff.replace(/\n$/, "").split("\n");
        const additions = plainFile ? (file.kind === "add" ? lines.length : 0) : lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length;
        const deletions = plainFile ? (file.kind === "delete" ? lines.length : 0) : lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length;
        return <details className="evidence-file" key={`${file.path}-${index}`} open>
          <summary><FileCode aria-hidden="true" /><span className="evidence-title"><code>{file.path}</code><span className="evidence-operation">{file.kind}{file.movePath ? ` → ${file.movePath}` : ""}</span></span>{file.diff ? <span className="evidence-counts"><span data-kind="addition">+{additions}</span><span data-kind="deletion">−{deletions}</span></span> : null}<CaretDown className="evidence-caret" aria-hidden="true" /></summary>
          {file.diff ? <><div className="evidence-section-header"><span>Recorded diff</span><CopyEvidence text={file.diff} label="Copy diff" /></div><pre className="evidence-diff" tabIndex={0} aria-label={`Diff for ${file.path}`}>{diffLines(file.diff, file.kind)}</pre></> : <p className="evidence-notice">No textual diff was reported for this file.</p>}
        </details>;
      }) : <p className="evidence-notice">File details have not been reported.</p>}
      {details.truncated ? <p className="evidence-notice">Recorded details were truncated. Only the retained portion is shown.</p> : null}
    </div>
  </details>;
}
