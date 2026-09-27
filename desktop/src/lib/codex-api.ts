import type { CodexDesktopApi } from "./codex-types";

declare global {
  interface Window {
    agentcloudCodex?: CodexDesktopApi;
  }
}

/** Codex bridge from the preload script (HAC-122). */
export function codexApi(): CodexDesktopApi {
  if (!window.agentcloudCodex) {
    throw new Error("Codex bridge is unavailable. Launch this UI through the Electron shell.");
  }
  return window.agentcloudCodex;
}
