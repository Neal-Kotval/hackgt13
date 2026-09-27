"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "@phosphor-icons/react";
import { SkeletonRegion, SkeletonRows } from "@/components/ui/skeleton";
import { profileLabel, type EnvironmentJob } from "@/components/environments";
import { CodexEnvironmentSetup } from "@/components/environments/codex-setup";
import "../resources/resources.css";
import "../environments/environments.css";

/** Name is added by the environment model (slice A); older job JSON has none. */
export type NamedJob = EnvironmentJob & { name?: string | null };

export function environmentLabel(job: NamedJob) {
  return job.name?.trim() || profileLabel(job);
}

export function environmentHref(projectId: string, jobId: string, tab?: string) {
  return `/projects/${projectId}/environments/${jobId}${tab ? `?tab=${tab}` : ""}`;
}

/** Polls this project's environments once for every Settings section that needs them. */
export function useProjectJobs(projectId: string) {
  const [jobs, setJobs] = useState<NamedJob[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch(`/api/run-boxes?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Could not load this project's environments.");
        const data = await response.json();
        if (!active) return;
        setJobs(data.jobs);
        setError("");
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load this project's environments.");
      } finally {
        if (active) timer = setTimeout(load, 5000);
      }
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [projectId, retry]);
  return { jobs, error, retry: () => setRetry((value) => value + 1) };
}

/**
 * Codex for this project's environments. ChatGPT sign-in is per environment, so this keeps the
 * previous Agent settings flow (Add Codex, sign in, open in desktop, add agents) and links each
 * environment to its detail page for everything else.
 */
export function ProjectCodex({ projectId, owner, jobs, error, retry }: {
  projectId: string; owner: boolean; jobs: NamedJob[] | null; error: string; retry: () => void;
}) {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    if (!jobs) return;
    // Desktop deep links still target ?environment=<id> or #agent-setup.
    const selected = new URL(window.location.href).searchParams.get("environment");
    const target = selected ? document.getElementById(`agent-environment-${selected}`) : document.getElementById("agent-setup");
    if (selected || window.location.hash === "#agent-setup") target?.scrollIntoView({ block: "start" });
  // Scroll once after the first load, not on every poll.
  }, [jobs === null]);
  const available = jobs?.filter((job) => job.state !== "stopped") ?? [];
  return <div id="agent-setup" tabIndex={-1} className="project-settings-codex">
    {error && <div className="resource-feedback resource-feedback--error" role="alert">{error}<button className="button" type="button" onClick={retry}>Try again</button></div>}
    {!jobs && !error && <SkeletonRegion label="Loading environments"><SkeletonRows count={2} /></SkeletonRegion>}
    {jobs && !available.length && <div className="resource-panel project-settings-empty">
      <p>No running environments. Start one, then sign in to Codex here.</p>
      <Link className="button" href={`/projects/${projectId}/environments`}>Open Environments</Link>
    </div>}
    {available.length > 0 && <ul className="project-settings-environments">
      {available.map((job) => {
        const ready = job.state === "ready" && !job.stop_requested_at && Boolean(job.ssh);
        const desktopUrl = origin ? `agentcloud://open?${new URLSearchParams({ projectId, runBoxId: job.id, panel: "codex", serverUrl: origin })}` : "";
        const label = environmentLabel(job);
        return <li key={job.id} id={`agent-environment-${job.id}`} className="resource-panel project-settings-environment">
          <div className="project-settings-environment-heading">
            <div>
              <h4>{label}</h4>
              <p className="resource-note">{job.name ? `${profileLabel(job)} · ` : ""}{job.provider_resource_id ?? "Waiting for allocation"}</p>
            </div>
            <span className={`resource-badge resource-badge--${job.state}`}>{job.stop_requested_at ? "Stopping" : job.state}</span>
          </div>
          {ready
            ? <CodexEnvironmentSetup projectId={projectId} runBoxId={job.id} owner={owner} desktopUrl={desktopUrl} />
            : <p className="resource-note">Codex can be added when this environment is ready.</p>}
          <Link className="project-settings-link" href={environmentHref(projectId, job.id, "settings")}>
            Environment settings for {label}<ArrowUpRight aria-hidden="true" />
          </Link>
        </li>;
      })}
    </ul>}
  </div>;
}
