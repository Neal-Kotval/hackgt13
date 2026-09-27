"use client";
// Placeholder owned by slice B so the detail page builds on its own. Slice C replaces this
// file with the real browser terminal (docs/environment-model-contract.md); its version wins.
import type { JSX } from "react";
import { TerminalWindow } from "@phosphor-icons/react";
import type { RunBoxJob } from "./types";

export function EnvironmentTerminal(props: { projectId: string; job: RunBoxJob }): JSX.Element {
  return (
    <div className="environment-detail-placeholder" data-project-id={props.projectId} data-job-id={props.job.id}>
      <TerminalWindow aria-hidden="true" />
      <h3>Terminal is coming soon</h3>
      <p>
        This tab will open a shell on this environment in your browser, with the same trusted access as SSH.
        Until then, use the SSH command from the Environments list.
      </p>
    </div>
  );
}
