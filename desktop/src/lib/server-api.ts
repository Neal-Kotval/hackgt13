import { desktopApi } from "./desktop-api";
import type { AgentCloudStateSummary } from "./types";

/** Thin renderer wrappers over the main-process loopback API (HAC-42). */
export function getState(): Promise<AgentCloudStateSummary> {
  return desktopApi().getState();
}

export function postAction(
  body: Record<string, unknown>,
): Promise<{ state: AgentCloudStateSummary; raw: unknown }> {
  return desktopApi().postAction(body);
}
