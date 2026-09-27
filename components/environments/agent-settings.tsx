"use client";

import { SkeletonRegion, SkeletonRows } from "@/components/ui/skeleton";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Project } from "@/lib/types";
import { profileLabel, type EnvironmentJob } from "./index";
import { CodexEnvironmentSetup } from "./codex-setup";
import "../resources/resources.css";
import "./environments.css";

/** Environment allocation and model account setup are separate user actions. */
export function AgentSettings({ project }: { project: Project }) {
  const [jobs, setJobs] = useState<EnvironmentJob[] | null>(null);
  const [owner, setOwner] = useState(false);
  const [error, setError] = useState("");
  const [origin, setOrigin] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setOrigin(window.location.origin);
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const [employeeResponse, jobsResponse] = await Promise.all([
          fetch("/api/employee", { cache: "no-store" }),
          fetch(`/api/run-boxes?projectId=${encodeURIComponent(project.id)}`, { cache: "no-store" }),
        ]);
        if (!employeeResponse.ok || !jobsResponse.ok) throw new Error("Could not load your environments.");
        const employee = await employeeResponse.json();
        const data = await jobsResponse.json();
        if (!active) return;
        setOwner(employee.memberships.some((item: { projectId: string; role: string }) => item.projectId === project.id && item.role === "owner"));
        setJobs(data.jobs);
        setError("");
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load your environments.");
      } finally {
        if (active) timer = setTimeout(load, 5000);
      }
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [project.id, retry]);
  useEffect(() => {
    if (!jobs) return;
    const selected = new URL(window.location.href).searchParams.get("environment");
    const target = selected ? document.getElementById(`agent-environment-${selected}`) : document.getElementById("agent-setup");
    if (selected || window.location.hash === "#agent-setup") target?.scrollIntoView({ block: "start" });
  // Focus the requested environment once after initial loading, not every poll.
  }, [jobs === null]);
  const available = jobs?.filter(job => job.state !== "stopped") ?? [];
  return <section id="agent-setup" tabIndex={-1} className="resource-section" aria-labelledby="agent-settings-title">
    <header className="resource-section-heading"><div><p className="eyebrow">Agent settings</p><h2 id="agent-settings-title">Codex</h2></div></header>
    <p className="section-description">Add Codex to an existing environment, sign in with ChatGPT, then start chats in the desktop app.</p>
    {error && <div className="resource-feedback resource-feedback--error" role="alert">{error}<button className="button" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
    {!jobs && !error && <SkeletonRegion label="Loading environments"><SkeletonRows count={2} /></SkeletonRegion>}
    {jobs && !available.length && <div className="resource-panel environment-codex"><h3>Set up an environment first</h3><p className="resource-note">Once your environment is ready, return here to add Codex.</p><div className="environment-actions"><Link className="button primary" href={`/projects/${project.id}/environments`}>Set up environment</Link></div></div>}
    <div className="environment-list">
      {available.map(job => {
        const ready = job.state === "ready" && !job.stop_requested_at && Boolean(job.ssh);
        const desktopUrl = origin ? `agentcloud://open?${new URLSearchParams({ projectId: project.id, runBoxId: job.id, panel: "codex", serverUrl: origin })}` : "";
        return <article key={job.id} id={`agent-environment-${job.id}`} className="resource-panel environment-codex">
          <div className="resource-detail-title"><h3>{profileLabel(job)}</h3><span className={`resource-badge resource-badge--${job.state}`}>{job.stop_requested_at ? "Stopping" : job.state}</span></div>
          <p className="resource-note">{job.provider_resource_id ?? "Waiting for allocation"}</p>
          {ready ? <CodexEnvironmentSetup projectId={project.id} runBoxId={job.id} owner={owner} desktopUrl={desktopUrl} /> : <p className="resource-note">Codex can be added when this environment is ready. <Link href={`/projects/${project.id}/environments?environment=${job.id}`}>View environment</Link></p>}
        </article>;
      })}
    </div>
  </section>;
}
