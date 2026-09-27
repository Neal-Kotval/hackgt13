"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy } from "@phosphor-icons/react";
import "./resources/resources.css";
import "./platform-aws-environments.css";

type ForceCloseStatus = "requested" | "terminating" | "closed" | "failed";

type AwsEnvironment = {
  id: string;
  shortId: string;
  ownerEmail: string | null;
  organizationName: string | null;
  projectName: string | null;
  projectId: string;
  profile: string;
  state: string;
  createdAt: string;
  lastReason: string | null;
  instanceId: string | null;
  forceClose: { status: ForceCloseStatus; requestedBy: string; detail: string | null; updatedAt: string | null } | null;
};

const POLL_MS = 15_000;

// Badge tone for each force-close status; the visible word always carries the meaning.
const forceCloseTone: Record<ForceCloseStatus, string> = {
  requested: "requested",
  terminating: "stopping",
  closed: "stopped",
  failed: "failed",
};

const forceCloseCopy: Record<ForceCloseStatus, string> = {
  requested: "Force close requested",
  terminating: "Terminating",
  closed: "Closed",
  failed: "Force close failed",
};

function age(createdAt: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60_000));
  if (!Number.isFinite(minutes)) return "Unknown";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d`;
}

function profileLabel(profile: string) {
  return profile === "aws-cpu" ? "aws-cpu" : profile === "gpu" ? "GPU" : `GPU · ${profile}`;
}

export function PlatformAwsEnvironments() {
  const [environments, setEnvironments] = useState<AwsEnvironment[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/aws-environments", { cache: "no-store" });
    if (response.status === 401) {
      window.location.assign("/sign-in");
      return;
    }
    if (!response.ok) throw new Error("Could not load AWS environments. Reload the page to try again.");
    setEnvironments((await response.json()).environments);
    setNow(Date.now());
  }, []);

  useEffect(() => {
    const refresh = () => void load().catch((failure) => setError(failure instanceof Error ? failure.message : "Could not load AWS environments."));
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function copyId(id: string) {
    setError("");
    try {
      await navigator.clipboard.writeText(id);
      setNotice("Environment ID copied.");
    } catch {
      setError("Clipboard unavailable. Select the ID to copy it.");
    }
  }

  async function forceClose(environment: AwsEnvironment) {
    setBusy(environment.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/aws-environments/${encodeURIComponent(environment.id)}/force-close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The force-close request could not be recorded.");
      setConfirming(null);
      await load();
      setNotice(`${environment.shortId}: ${forceCloseCopy[result.forceClose.status as ForceCloseStatus].toLowerCase()}. The worker acts on its next cycle.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The force-close request could not be recorded.");
    } finally {
      setBusy(null);
    }
  }

  return <section className="organization-panel aws-environments" aria-labelledby="aws-environments-title">
    <div>
      <h2 id="aws-environments-title">Active AWS environments</h2>
      <p>Every AWS environment that is not stopped across all organizations, plus any force closed in the last day. Only one may be active at a time. Force close is performed by the AWS worker on its next cycle: with no EC2 resources tagged for the environment it is closed; otherwise the standard teardown runs.</p>
    </div>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <p className="auth-success aws-environments-notice" role="status">{notice}</p>
    {environments === null ? <p role="status">Loading AWS environments…</p> : environments.length === 0 ?
      <p>No AWS environments are active.</p> :
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Environment</th>
              <th scope="col">Owner</th>
              <th scope="col">Profile and state</th>
              <th scope="col">Age</th>
              <th scope="col">Last transition</th>
              <th scope="col">EC2 instance</th>
              <th scope="col">Force close</th>
            </tr>
          </thead>
          <tbody>
            {environments.map((environment) => <EnvironmentRow key={environment.id} environment={environment} now={now}
              confirming={confirming === environment.id} busy={busy === environment.id} anyBusy={busy !== null}
              onCopy={() => void copyId(environment.id)} onConfirm={() => setConfirming(environment.id)}
              onCancel={() => setConfirming(null)} onForceClose={() => void forceClose(environment)} />)}
          </tbody>
        </table>
      </div>}
  </section>;
}

function EnvironmentRow({ environment, now, confirming, busy, anyBusy, onCopy, onConfirm, onCancel, onForceClose }: {
  environment: AwsEnvironment;
  now: number;
  confirming: boolean;
  busy: boolean;
  anyBusy: boolean;
  onCopy: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onForceClose: () => void;
}) {
  const confirmButton = useRef<HTMLButtonElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
    else if (wasConfirming.current) openButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const status = environment.forceClose?.status ?? null;
  const pending = status === "requested" || status === "terminating";
  const stopped = environment.state === "stopped";
  const confirmId = `force-close-${environment.id}`;

  return <tr>
    <td data-label="Environment">
      <span className="aws-environments-id">
        <code title={environment.id}>{environment.shortId}</code>
        <button className="button ghost aws-environments-copy" type="button" onClick={onCopy}
          aria-label={`Copy full environment ID ${environment.id}`}>
          <Copy aria-hidden="true" /> Copy full ID
        </button>
      </span>
    </td>
    <td data-label="Owner">
      <span className="aws-environments-stack">
        <span>{environment.ownerEmail ?? "Unknown owner"}</span>
        <small>{environment.organizationName ?? "Unknown organization"} · {environment.projectName ?? environment.projectId}</small>
      </span>
    </td>
    <td data-label="Profile and state">
      <span className="aws-environments-stack">
        <span>{profileLabel(environment.profile)}</span>
        <span className={`resource-badge resource-badge--${environment.state}`}>{environment.state}</span>
      </span>
    </td>
    <td data-label="Age" className="aws-environments-age">{age(environment.createdAt, now)}</td>
    <td data-label="Last transition" className="aws-environments-reason">{environment.lastReason ?? "No reason recorded"}</td>
    <td data-label="EC2 instance"><code>{environment.instanceId ?? "none"}</code></td>
    <td data-label="Force close">
      <span className="aws-environments-stack aws-environments-action">
        {status && <span className={`resource-badge resource-badge--${forceCloseTone[status]}`}
          title={environment.forceClose?.detail ?? undefined}>{forceCloseCopy[status]}</span>}
        {status && environment.forceClose?.detail && <small>{environment.forceClose.detail}</small>}
        {!stopped && !pending && !confirming &&
          <button ref={openButton} className="button danger" type="button" disabled={anyBusy} onClick={onConfirm}
            aria-controls={confirmId}>{status === "failed" ? "Retry force close" : "Force close"}</button>}
        {!stopped && !pending && confirming &&
          <span id={confirmId} className="aws-environments-confirm" role="group" aria-label={`Confirm force close ${environment.shortId}`}
            onKeyDown={(event) => { if (event.key === "Escape" && !busy) onCancel(); }}>
            <small>Force close {environment.shortId}? {environment.instanceId ? "Its EC2 instance is torn down first." : "It closes if EC2 has nothing tagged for it."}</small>
            <span className="aws-environments-buttons">
              <button ref={confirmButton} className="button danger" type="button" disabled={busy} onClick={onForceClose}>
                {busy ? "Requesting…" : "Confirm force close"}
              </button>
              <button className="button" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
            </span>
          </span>}
      </span>
    </td>
  </tr>;
}
