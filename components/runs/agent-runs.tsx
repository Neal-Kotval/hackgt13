"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, ChatText, CheckCircle, Circle, X, Warning } from "@phosphor-icons/react";
import { SkeletonRegion, SkeletonRows } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";
import type { Project } from "@/lib/types";
import styles from "./agent-runs.module.css";

import { groupChatConversations, type ChatRun, type ChatConversation, type ChatRunStatus as Status } from "@/lib/chat-conversations";

const labels: Record<Status, string> = { running: "In progress", completed: "Completed", failed: "Needs attention", stopped: "Stopped", unknown: "Outcome unavailable" };
const tones: Record<Status, string> = { running: "running", completed: "succeeded", failed: "failed", stopped: "cancelled", unknown: "cancelled" };
function date(value: string) { return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
function environment(run: ChatRun) {
  const provider = run.environment?.provider;
  const name = provider === "docker-local" ? "Docker environment" : provider === "aws" || provider === "aws-ec2" ? "AWS environment" : provider === "runpod" ? "Runpod environment" : "Environment";
  return `${name} · ${run.runBoxId.slice(0, 8)}`;
}
function Badge({ status }: { status: Status }) {
  const Icon = status === "completed" ? CheckCircle : status === "running" ? Circle : Warning;
  return <span className={`${styles.badge} ${styles[tones[status]]}`}><Icon aria-hidden="true" />{labels[status]}</span>;
}
function Details({ run, closeHref }: { run: ChatConversation; closeHref: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [run.id]);
  const replies = run.events.filter(event => event.kind === "assistant" && event.text);
  const steps = run.events.filter(event => ["command", "error", "reasoning", "file-change"].includes(event.kind));
  const openChat = `agentcloud://open?${new URLSearchParams({ projectId: run.projectId, codexSessionId: run.sessionId, ...(typeof window !== "undefined" ? {serverUrl: window.location.origin} : {}) })}`;
  return <section className={styles.detail} aria-labelledby="run-detail-heading">
    <div className={styles.detailTop}>
      <div className={styles.detailTitle}><h3 id="run-detail-heading" ref={heading} tabIndex={-1}>Conversation details</h3></div>
      <Link className={styles.close} href={closeHref} scroll={false} aria-label="Close conversation details"><X aria-hidden="true" /></Link>
    </div>
    <Badge status={run.status} />
    <div><h4 className={styles.label}>Latest request</h4><p className={styles.prompt}>{run.prompt}</p></div>
    <dl className={styles.facts}>
      <div><dt>Last message from</dt><dd>{run.actorName || "Project member"}</dd></div>
      <div><dt>Environment</dt><dd>{environment(run)}</dd></div>
      <div><dt>Last activity</dt><dd><time dateTime={run.updatedAt}>{date(run.updatedAt)}</time></dd></div>
      <div><dt>Saved requests</dt><dd>{run.requests.length}</dd></div>
    </dl>
    <h4 className={styles.eventsHeading}>{run.status === "running" ? "Agent response so far" : "Agent response"}</h4>
    {replies.length ? replies.map(event => <p className={styles.message} key={event.id}>{event.text}</p>) : <p className={styles.note}>{run.status === "running" ? "Your agent is working. Its response will appear here automatically." : "No response was saved for the latest request."}</p>}
    {run.status === "unknown" && <p className={styles.note}>This chat has no saved completion for this request. Open the chat to review what happened.</p>}
    {run.status === "stopped" && <p className={styles.note}>Work stopped before a completion was recorded.</p>}
    {steps.length > 0 && <details className={styles.activity}><summary>Work details ({steps.length})</summary><ol className={styles.events}>{steps.map(event => <li className={styles.eventBody} key={event.id}><strong>{event.kind === "error" ? "Issue" : event.kind === "command" ? "Action" : event.kind === "file-change" ? "File update" : "Progress update"}</strong><p className={styles.message}>{event.text}</p></li>)}</ol></details>}
    {run.requests.length > 1 && <details className={styles.activity}><summary>Earlier messages ({run.requests.length - 1})</summary><ol className={styles.events}>{run.requests.slice(0, -1).map(request => <li className={styles.eventBody} key={request.id}><div className={styles.runTop}><strong>{request.actorName || "Project member"}</strong><Badge status={request.status} /></div><p className={styles.message}>{request.prompt}</p>{request.events.filter(event => event.kind === "assistant").map(event => <p className={styles.message} key={event.id}><strong>Agent response</strong><br />{event.text}</p>)}</li>)}</ol></details>}
    <div className={styles.detailActions}><a href={openChat} className="button primary">Open chat in desktop <ArrowSquareOut aria-hidden="true" /></a></div>
  </section>;
}

export function AgentRuns({ project }: { project: Project }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get("conversation") || params.get("run");
  const [runs, setRuns] = useState<ChatConversation[] | null>(null);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useRef<() => void>(() => {});
  const refreshNow = useCallback(() => refresh.current(), []);
  useEffect(() => {
    let active = true;
    let busy = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const load = async () => {
      if (busy || !active) return;
      clearTimeout(timer); busy = true; setRefreshing(true);
      try {
        const response = await fetch(`/api/chat-runs?projectId=${encodeURIComponent(project.id)}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 401 ? "Sign in again to see the latest conversations." : "We couldn’t update your conversations. Try Refresh or wait for the next update.");
        const data = await response.json() as { runs: ChatRun[] };
        if (active) { setRuns(groupChatConversations(data.runs)); setError(""); setUpdated(new Date().toLocaleTimeString(undefined, { timeStyle: "short" })); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "We couldn’t update your conversations."); }
      finally { busy = false; if (active) { setRefreshing(false); timer = setTimeout(load, 4000); } }
    };
    refresh.current = () => void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    void load();
    return () => { active = false; controller.abort(); clearTimeout(timer); window.removeEventListener("focus", onFocus); };
  }, [project.id]);
  const visible = runs?.filter(run => filter === "all" || run.status === filter);
  const current = runs?.find(run => run.id === selected || run.requests.some(request => request.id === selected));
  const runHref = (id: string) => `${pathname}?${new URLSearchParams({ conversation: id })}`;
  return <section className={styles.root} aria-labelledby="recent-runs-heading">
    <div className={styles.heading}>
      <div><h3 id="recent-runs-heading">Conversations</h3><p className={styles.note}>{error ? "Updates paused — retrying automatically" : updated ? `Updates automatically · Last checked ${updated}` : "Checking for recent activity…"}</p></div>
      <button className="button secondary" onClick={refreshNow} disabled={refreshing}><ArrowClockwise aria-hidden="true" />Refresh</button>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.toolbar}><Select aria-label="Filter conversations by status" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All conversations</option>{Object.entries(labels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</Select>{runs && <span className={styles.count}>{visible?.length} {visible?.length === 1 ? "conversation" : "conversations"}</span>}</div>
    {runs === null && !error && <SkeletonRegion label="Loading conversations"><SkeletonRows count={3} /></SkeletonRegion>}
    <div className={`${styles.layout} ${selected ? styles.withDetail : ""}`}>
      <div className={styles.listColumn}>
        {runs && !runs.length && <div className={styles.empty}><ChatText aria-hidden="true" /><h3>Your conversations will appear here</h3><p>Start a chat with your agent in the desktop app. Follow-up messages stay together in one conversation here.</p><Link href={`/projects/${project.id}/environments`} className="button secondary">View environments</Link></div>}
        {runs && runs.length > 0 && !visible?.length && <p className={styles.note}>No conversations match this status. Choose All conversations to see the rest.</p>}
        <ul className={styles.list}>{visible?.map(run => <li key={run.id}><Link className={`${styles.runLink} ${current?.id === run.id ? styles.selected : ""}`} href={runHref(run.id)} scroll={false} aria-current={current?.id === run.id ? "true" : undefined}><div className={styles.runTop}><strong className={styles.runPrompt}>{run.title}</strong><Badge status={run.status} /></div><div className={styles.runMeta}><span>{run.actorName || "Project member"}</span><span>{environment(run)}</span><time dateTime={run.updatedAt}>{date(run.updatedAt)}</time></div></Link></li>)}</ul>
      </div>
      {current ? <Details run={current} closeHref={pathname} /> : selected && runs && <section className={styles.detail}><h3>Conversation unavailable</h3><p className={styles.note}>This conversation is no longer in the available chat history.</p><Link href={pathname} className="button secondary">Back to conversations</Link></section>}
    </div>
  </section>;
}
