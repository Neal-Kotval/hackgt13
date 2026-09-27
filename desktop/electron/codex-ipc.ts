/**
 * IPC registration for the Codex panel (HAC-122). main.ts calls
 * `registerCodexIpc` once; everything else lives here so the main-process
 * diff stays to a few lines.
 *
 * Only statuses, run events and the device-code URL/code cross IPC. The
 * employee session, device private key and this Mac's Codex auth file stay in
 * the main process and are never logged.
 */
import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CodexExportResult, CodexPanelEvent } from "../src/lib/codex-types.ts";
import { DEVICE_URL_ORIGIN } from "./codex-events.ts";
import { CodexSessions, type CodexSessionDeps } from "./codex-session.ts";

/** Local Codex auth file: `$CODEX_HOME/auth.json`, default `~/.codex/auth.json`. */
export function localCodexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  return path.join(home, "auth.json");
}

const ID = /^[A-Za-z0-9_.:-]{1,256}$/;

/** Build `/projects/<id>/runs?run=<runId>` on the AgentCloud origin only. */
export function runWebUrl(baseUrl: string, projectId: string, runId: string): string {
  if (!ID.test(projectId) || !ID.test(runId)) throw new Error("Invalid run link.");
  const origin = new URL(baseUrl).origin;
  const url = new URL(
    `/projects/${encodeURIComponent(projectId)}/runs?run=${encodeURIComponent(runId)}`,
    origin,
  );
  if (url.origin !== origin) throw new Error("Refusing to open a link outside AgentCloud.");
  return url.toString();
}

export type CodexIpcDeps = Pick<CodexSessionDeps, "request" | "privateKey" | "beforeConnect"> & {
  getBaseUrl: () => string;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function registerCodexIpc(deps: CodexIpcDeps): CodexSessions {
  const authPath = () => localCodexAuthPath();
  const sessions = new CodexSessions({
    request: deps.request,
    privateKey: deps.privateKey,
    beforeConnect: deps.beforeConnect,
    localAuthExists: () => existsSync(authPath()),
    readLocalAuth: () => readFile(authPath()),
  });

  const tracked = new WeakSet<WebContents>();
  const track = (sender: WebContents) => {
    if (tracked.has(sender)) return;
    tracked.add(sender);
    const ownerId = sender.id;
    sender.once("destroyed", () => sessions.closeOwner(ownerId));
    sender.on("render-process-gone", () => sessions.closeOwner(ownerId));
  };
  const sendTo = (sender: WebContents) => (event: CodexPanelEvent) => {
    if (!sender.isDestroyed()) sender.send("codex:event", event);
  };

  const handle = (
    channel: string,
    handler: (sender: WebContents, ...args: unknown[]) => Promise<unknown>,
  ) => {
    ipcMain.handle(channel, async (event, ...args) => {
      track(event.sender);
      try {
        return await handler(event.sender, ...args);
      } catch (error) {
        throw new Error(errorMessage(error, "Codex request failed."));
      }
    });
  };

  handle("codex:status", async (_sender, runBoxId) => sessions.status(runBoxId as string));
  handle("codex:login", async (sender, runBoxId) =>
    sessions.login(sender.id, sendTo(sender), runBoxId as string),
  );
  // Returns only the sanitized remote status; the file content never leaves main.
  handle("codex:useLocalLogin", async (_sender, runBoxId) =>
    sessions.useLocalLogin(runBoxId as string),
  );
  handle("codex:run", async (sender, runBoxId, prompt, options) =>
    sessions.run(
      sender.id,
      sendTo(sender),
      runBoxId as string,
      prompt as string,
      (options ?? {}) as { projectId: string; recordPrompt?: string },
    ),
  );
  handle("codex:stop", async (sender, sessionId) => sessions.stop(sender.id, sessionId as string));
  handle("codex:export", async (sender, runBoxId, options): Promise<CodexExportResult> => {
    const projectId = (options as { projectId?: unknown } | undefined)?.projectId;
    const { patch, files } = await sessions.exportPatch(runBoxId as string, projectId as string);
    if (files === 0) return { savedTo: null, reason: "no-changes" };
    const win = BrowserWindow.fromWebContents(sender);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const options_ = {
      title: "Export changes",
      defaultPath: path.join(app.getPath("downloads"), `agentcloud-${runBoxId as string}-${stamp}.patch`),
      filters: [{ name: "Patch", extensions: ["patch", "diff"] }],
    };
    const choice = win
      ? await dialog.showSaveDialog(win, options_)
      : await dialog.showSaveDialog(options_);
    if (choice.canceled || !choice.filePath) return { savedTo: null, reason: "cancelled" };
    await writeFile(choice.filePath, patch, { encoding: "utf8", mode: 0o600 });
    return { savedTo: choice.filePath, bytes: Buffer.byteLength(patch), files };
  });
  handle("codex:openDeviceUrl", async (sender, sessionId) => {
    const url = sessions.deviceUrl(sender.id, sessionId as string);
    if (!url || new URL(url).origin !== DEVICE_URL_ORIGIN) {
      throw new Error("No sign-in link is available for this session.");
    }
    await shell.openExternal(url);
  });
  handle("codex:openRunOnWeb", async (_sender, projectId, runId) => {
    await shell.openExternal(runWebUrl(deps.getBaseUrl(), projectId as string, runId as string));
  });

  app.on("before-quit", () => {
    void sessions.closeAll();
  });
  return sessions;
}
