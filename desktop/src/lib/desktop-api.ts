import type { DesktopApi } from "./types";

declare global {
  interface Window {
    agentcloudDesktop: DesktopApi;
  }
}

export function desktopApi(): DesktopApi {
  if (!window.agentcloudDesktop) {
    throw new Error(
      "Desktop bridge is unavailable. Launch this UI through the Electron shell.",
    );
  }
  return window.agentcloudDesktop;
}
