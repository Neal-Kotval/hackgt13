import { useCallback, useEffect, useState } from "react";
import { TerminalPanel } from "./TerminalPanel";
import { desktopApi } from "../lib/desktop-api";
import { ipcErrorMessage } from "../lib/terminal-theme";
import {
  canOpenTerminal,
  isTransitional,
  runBoxStateLabel,
  terminalBlockedReason,
  type RunBoxSummary,
} from "../lib/run-boxes";

const POLL_MS = 5000;

type ProjectChatTerminalProps = {
  projectId: string;
  runBoxId: string;
  onClose: () => void;
};

/**
 * Opens the website environment inside Project chat: poll until the run box
 * is ready, then attach the in-app SSH terminal.
 */
export function ProjectChatTerminal({
  projectId,
  runBoxId,
  onClose,
}: ProjectChatTerminalProps) {
  const [job, setJob] = useState<RunBoxSummary | null>(null);
  const [status, setStatus] = useState("Looking up the environment…");
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    const jobs = await desktopApi().listRunBoxes(projectId);
    return jobs.find((row) => row.id === runBoxId) ?? null;
  }, [projectId, runBoxId]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    async function tick() {
      try {
        const found = await refresh();
        if (cancelled) return;
        setFailed(false);
        setJob(found);
        if (!found) {
          setStatus(
            `Environment ${runBoxId} was not found on this project. Start it on the website, then open it in desktop again.`,
          );
          return;
        }
        if (canOpenTerminal(found)) {
          setStatus("");
          return;
        }
        if (isTransitional(found) && !found.stopRequested) {
          setStatus(
            `Waiting for the environment to become ready (currently ${runBoxStateLabel(found).toLowerCase()}). SSH starts automatically.`,
          );
          timer = window.setTimeout(() => {
            void tick();
          }, POLL_MS);
          return;
        }
        setStatus(
          terminalBlockedReason(found) ??
            `Environment ${found.id} cannot open a terminal.`,
        );
      } catch (error) {
        if (cancelled) return;
        setFailed(true);
        setStatus(ipcErrorMessage(error, "Could not load the environment from the web app."));
      }
    }

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refresh, runBoxId]);

  if (job && canOpenTerminal(job)) {
    return (
      <div className="chat-terminal">
        <TerminalPanel
          runBoxId={job.id}
          title={job.profileId ? `${job.profileId} · ${job.id}` : job.id}
          onClose={onClose}
        />
      </div>
    );
  }

  return (
    <div className="conversation">
      <div className="main-empty" role="status">
        <p className={failed ? "error-banner" : "brand-meta"}>{status}</p>
        <button type="button" className="button ghost" onClick={onClose}>
          Back to chat
        </button>
      </div>
    </div>
  );
}
