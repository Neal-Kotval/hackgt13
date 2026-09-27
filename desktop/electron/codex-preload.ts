/**
 * Renderer bridge for the Codex panel (HAC-122), exposed by preload.ts as
 * `window.agentcloudCodex`. Arguments are ids, prompts and options only.
 */
import type { IpcRenderer, IpcRendererEvent } from "electron";
import type { CodexDesktopApi, CodexPanelEvent } from "../src/lib/codex-types.ts";

export function createCodexBridge(ipc: IpcRenderer): CodexDesktopApi {
  return {
    status: (runBoxId) => ipc.invoke("codex:status", runBoxId),
    login: (runBoxId) => ipc.invoke("codex:login", runBoxId),
    useLocalLogin: (runBoxId) => ipc.invoke("codex:useLocalLogin", runBoxId),
    run: (runBoxId, prompt, options) => ipc.invoke("codex:run", runBoxId, prompt, options),
    stop: (sessionId) => ipc.invoke("codex:stop", sessionId),
    exportChanges: (runBoxId, options) => ipc.invoke("codex:export", runBoxId, options),
    openDeviceUrl: (sessionId) => ipc.invoke("codex:openDeviceUrl", sessionId),
    openRunOnWeb: (projectId, runId) => ipc.invoke("codex:openRunOnWeb", projectId, runId),
    onEvent: (handler) => {
      const listener = (_event: IpcRendererEvent, payload: CodexPanelEvent) => handler(payload);
      ipc.on("codex:event", listener);
      return () => {
        ipc.removeListener("codex:event", listener);
      };
    },
  };
}
