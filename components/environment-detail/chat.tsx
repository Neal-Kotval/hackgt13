"use client";
// Placeholder owned by slice B so the detail page builds on its own. Slice D replaces this
// file with the real environment chat (docs/environment-model-contract.md); its version wins.
import type { JSX } from "react";
import { ChatCircleDots } from "@phosphor-icons/react";
import type { RunBoxJob } from "./types";

export function EnvironmentChat(props: { projectId: string; job: RunBoxJob }): JSX.Element {
  return (
    <div className="environment-detail-placeholder" data-project-id={props.projectId} data-job-id={props.job.id}>
      <ChatCircleDots aria-hidden="true" />
      <h3>Chat is coming soon</h3>
      <p>
        This tab will let you chat with the Codex agent running on this environment, see its replies as they stream,
        and pick up earlier conversations. Until then, open the environment from the desktop app.
      </p>
    </div>
  );
}
