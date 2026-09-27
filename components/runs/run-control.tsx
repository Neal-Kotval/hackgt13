"use client";
import { Suspense } from "react";
import type { Project } from "@/lib/types";
import styles from "./run-control.module.css";
import { AgentRuns } from "./agent-runs";

export function RunControl({ project }: { project: Project }) {
  return <section className={styles.root} aria-labelledby="runs-heading">
    <header className={styles.heading}>
      <div>
        <h2 id="runs-heading">Runs</h2>
        <p>Follow your agent’s work by conversation. Review the latest progress and response, with earlier messages kept together.</p>
      </div>
    </header>
    <Suspense fallback={null}><AgentRuns key={project.id} project={project} /></Suspense>
  </section>;
}
