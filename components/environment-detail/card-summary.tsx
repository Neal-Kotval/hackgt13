"use client";
// Compact, name-first summary of one environment for the Environments list. The list
// (components/environments/index.tsx) is being redesigned separately; it can adopt this
// component as its card header without taking the rest of the detail page.
import Link from "next/link";
import { Brain, Clock, Globe, LockSimple } from "@phosphor-icons/react";
import { environmentName, machineLabel, machineSpecs, memoryStatus, stateInfo, timeLeft, type RunBoxJob } from "./types";
import "./environment-detail.css";

export function environmentHref(projectId: string, jobId: string) {
  return `/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(jobId)}`;
}

export function EnvironmentCardSummary({
  job,
  projectId,
  headingLevel = 4,
  titleId,
  now = Date.now(),
}: {
  job: RunBoxJob;
  projectId: string;
  headingLevel?: 3 | 4;
  titleId?: string;
  now?: number;
}) {
  const state = stateInfo(job.state);
  const specs = machineSpecs(job);
  const Heading = headingLevel === 3 ? "h3" : "h4";
  return (
    <div className={`environment-summary environment-summary--${job.state}`}>
      <div className="environment-summary-top">
        <Heading id={titleId} className={job.name ? "environment-summary-name" : "environment-summary-name environment-detail-unnamed"}>
          <Link href={environmentHref(projectId, job.id)}>{environmentName(job)}</Link>
        </Heading>
        <span className={`environment-state environment-state--${job.state}`}>
          <span className="environment-state-dot" aria-hidden="true" />
          {state.label}
        </span>
      </div>
      <p className="environment-summary-machine">
        {machineLabel(job)}
        {specs && <span> · {specs}</span>}
      </p>
      <p className="environment-summary-meta">
        <span>
          {job.visibility === "public" ? <Globe aria-hidden="true" /> : <LockSimple aria-hidden="true" />}
          {job.visibility === "public" ? "Public" : "Private"}
        </span>
        <span>
          <Clock aria-hidden="true" />
          {timeLeft(job, now)}
        </span>
        {job.memory && (
          <span>
            <Brain aria-hidden="true" />
            Shared memory: {memoryStatus(job)}
          </span>
        )}
      </p>
    </div>
  );
}

/** Small shared-memory status chip that links to the detail page's Settings tab, where it is changed. */
export function EnvironmentMemoryChip({
  job,
  projectId,
}: {
  job: Pick<RunBoxJob, "id" | "memory">;
  projectId: string;
}) {
  const enabled = job.memory?.enabled === true;
  return (
    <Link
      className={`environment-memory-chip${enabled ? " environment-memory-chip--on" : ""}`}
      href={`${environmentHref(projectId, job.id)}?tab=settings`}
      aria-label={`Shared memory: ${memoryStatus(job)}. Change it in environment settings.`}
    >
      <Brain aria-hidden="true" />
      Shared memory: {memoryStatus(job)}
    </Link>
  );
}
