import type { RunBoxSummary } from "./run-boxes";

const PREFERENCE_KEY = "alto.environments.hideStopped";

/** Filtering never suppresses failures, in-flight stops, or unknown server states. */
export function visibleEnvironments<T extends Pick<RunBoxSummary, "state">>(jobs: T[], hideStopped: boolean): T[] {
  return hideStopped ? jobs.filter((job) => job.state !== "stopped") : jobs;
}

export function readHideStopped(): boolean {
  try {
    return localStorage.getItem(PREFERENCE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveHideStopped(value: boolean): void {
  try {
    localStorage.setItem(PREFERENCE_KEY, String(value));
  } catch {
    // The control still works for this visit when storage is unavailable.
  }
}
