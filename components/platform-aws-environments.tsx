"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, Copy, HardDrives } from "@phosphor-icons/react";
import { SkeletonRegion, SkeletonRows } from "./ui/skeleton";
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
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/admin/aws-environments", { cache: "no-store" });
      if (response.status === 401) {
        window.location.assign("/sign-in");
        return;
      }
      if (!response.ok) throw new Error("Could not load AWS environments. Try refreshing.");
      setEnvironments((await response.json()).environments);
      const timestamp = Date.now();
      setNow(timestamp);
      setUpdatedAt(timestamp);
      setLoadError("");
    } finally {
      setRefreshing(false);
    }
  }, []);

  const refresh = useCallback(() => {
    void load().catch((failure) => setLoadError(failure instanceof Error ? failure.message : "Could not load AWS environments."));
  }, [load]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

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
    <div className="aws-environments-heading">
      <div>
        <h2 id="aws-environments-title">AWS environments</h2>
        <p>Active environments across all organizations, with force closures from the last 24 hours.</p>
      </div>
      <button className="button" type="button" disabled={refreshing} onClick={refresh}>
        <ArrowClockwise aria-hidden="true" /> {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </div>
    <div className="aws-environments-toolbar">
      <span>{environments === null ? "Environment inventory" : `${environments.filter((environment) => environment.state !== "stopped").length} active · ${environments.length} listed`}</span>
      <span>{loadError ? "Refresh failed · data may be outdated" : updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })} · refreshes every 15s` : "Refreshes every 15s"}</span>
    </div>
    {loadError && <p className="auth-error" role="alert">{loadError}</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    <p className="auth-success aws-environments-notice" role="status">{notice}</p>
    {environments === null ? loadError ? <div className="aws-environments-empty">
      <HardDrives aria-hidden="true" />
      <h3>Environment inventory unavailable</h3>
      <p>Refresh to try loading the current environment records again.</p>
    </div> : <SkeletonRegion label="Loading AWS environments"><SkeletonRows count={3} /></SkeletonRegion> : environments.length === 0 ?
      <div className="aws-environments-empty">
        <HardDrives aria-hidden="true" />
        <h3>No active AWS environments</h3>
        <p>Active environments and recent force closures will appear here. Nothing needs your attention.</p>
      </div> :
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Environment</th>
              <th scope="col">Owner</th>
              <th scope="col">Profile and state</th>
              <th scope="col">Last transition</th>
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
    <details className="aws-environments-policy">
      <summary>Capacity and force-close policy</summary>
      <p>Only one AWS environment may be active at a time. Force close queues a request for the AWS worker’s next cycle. The worker closes the record when no EC2 resources are tagged for it; otherwise, it runs the standard teardown first.</p>
    </details>
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
      <span className="aws-environments-id aws-environments-stack">
        <code title={environment.id}>{environment.shortId}</code>
        <small>Age: {age(environment.createdAt, now)}</small>
        <code className="aws-environments-instance">{environment.instanceId ?? "No EC2 instance"}</code>
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
    <td data-label="Last transition" className="aws-environments-reason">{environment.lastReason ?? "No reason recorded"}</td>
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
