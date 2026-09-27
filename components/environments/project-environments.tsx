"use client";
// Project-level environment summaries for the projects list and the project overview.
// Both read the same GET /api/run-boxes?projectId= listing as the Environments page.
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Plus } from "@phosphor-icons/react";
import { SkeletonRegion, SkeletonRows } from "@/components/ui/skeleton";
import "../resources/resources.css";
import "./environments.css";
import {
  environmentLabel,
  jobMachine,
  liveState,
  liveStateLabel,
  timeLeft,
  type EnvironmentJob,
} from "./machines";

type Listing = { jobs: EnvironmentJob[] | null; error: boolean; now: number };

export function useProjectEnvironments(projectId: string, intervalMs = 10_000): Listing {
  const [listing, setListing] = useState<Listing>({ jobs: null, error: false, now: Date.now() });
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch(`/api/run-boxes?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
        if (!response.ok) throw new Error("unavailable");
        const data = (await response.json()) as { jobs?: EnvironmentJob[] };
        if (active) setListing({ jobs: Array.isArray(data.jobs) ? data.jobs : [], error: false, now: Date.now() });
      } catch {
        if (active) setListing((current) => ({ ...current, error: current.jobs === null, now: Date.now() }));
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), intervalMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [projectId, intervalMs]);
  return listing;
}

const summaryOrder = ["ready", "provisioning", "stopping", "failed"] as const;

/** "1 ready · CPU Medium", "1 ready · 1 provisioning", or "No environments". */
export function environmentSummary(jobs: EnvironmentJob[]) {
  const active = jobs.filter((job) => liveState(job) !== "stopped");
  if (!active.length) return jobs.length ? "No active environments" : "No environments";
  if (active.length === 1) return `1 ${liveStateLabel[liveState(active[0])]} · ${environmentLabel(active[0])}`;
  return summaryOrder
    .map((state) => [state, active.filter((job) => liveState(job) === state).length] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${liveStateLabel[state]}`)
    .join(" · ");
}

/** Project-row tag derived from live environment state; "setup pending" until one is ready. */
export function environmentTag(jobs: EnvironmentJob[] | null): { tone: string; label: string } {
  const states = (jobs ?? []).map(liveState);
  if (states.includes("ready")) return { tone: "green", label: "environment ready" };
  if (states.includes("provisioning")) return { tone: "yellow", label: "provisioning" };
  if (states.includes("failed")) return { tone: "yellow", label: "environment failed" };
  return { tone: "neutral", label: "setup pending" };
}

function badge(job: EnvironmentJob) {
  const state = liveState(job);
  const className = state === "provisioning" ? job.state : state;
  const label = state.charAt(0).toUpperCase() + state.slice(1);
  return <span className={`resource-badge resource-badge--${className}`}>{label}</span>;
}

/** The overview's Environments card body: real environments, or a start action. */
export function OverviewEnvironments({ projectId, base }: { projectId: string; base: string }) {
  const { jobs, error, now } = useProjectEnvironments(projectId);
  if (error) return <p>Environment status is unavailable right now.</p>;
  if (!jobs)
    return (
      <SkeletonRegion label="Loading environments">
        <SkeletonRows count={2} />
      </SkeletonRegion>
    );
  const active = jobs.filter((job) => liveState(job) !== "stopped");
  const stopped = jobs.length - active.length;
  if (!active.length)
    return (
      <div className="overview-environment-empty">
        <p className="muted">
          {jobs.length
            ? `Nothing is running for this project. ${stopped} stopped ${stopped === 1 ? "environment" : "environments"} in its history.`
            : "Nothing is running for this project. Start an environment to give an agent a machine."}
        </p>
        <div className="overview-environment-actions">
          <Link className="button primary" href={`${base}/environments?new=1`}>
            <Plus aria-hidden="true" /> New environment
          </Link>
          {jobs.length > 0 && (
            <Link className="button secondary" href={`${base}/environments`}>
              Manage environments <ArrowUpRight aria-hidden="true" />
            </Link>
          )}
        </div>
      </div>
    );
  return (
    <>
      <ul className="overview-environments">
        {active.map((job) => {
          const machine = jobMachine(job);
          return (
            <li key={job.id}>
              <Link className="overview-environment" href={`${base}/environments?environment=${encodeURIComponent(job.id)}`}>
                <strong>{environmentLabel(job)}</strong>
                <span className="overview-environment-meta">
                  {machine ? `${machine.vcpu} vCPU · ${machine.memoryGib} GiB${machine.gpu ? ` · ${machine.gpu.model}` : ""} · ` : ""}
                  {timeLeft(job, now)}
                </span>
                {badge(job)}
              </Link>
            </li>
          );
        })}
      </ul>
      {stopped > 0 && (
        <p className="muted">
          {stopped} stopped {stopped === 1 ? "environment" : "environments"} in this project&apos;s history.
        </p>
      )}
      <Link className="button secondary" href={`${base}/environments`}>
        Manage environments <ArrowUpRight aria-hidden="true" />
      </Link>
    </>
  );
}
