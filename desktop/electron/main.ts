import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  type IpcMainInvokeEvent,
} from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MissingCredentialsError,
  OpenAIResponsesAdapter,
} from "./assistant.ts";
import { AuthError, DesktopAuthClient } from "./auth-client.ts";
import { LoopbackApiClient, LoopbackApiError } from "./api-client.ts";
import { ChatStore, ChatStoreError } from "./chat-store.ts";
import { SessionStore } from "./session-store.ts";
import type { AssistantStreamEvent } from "../src/lib/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  const existing = BrowserWindow.getAllWindows()[0];
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  }
});

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(process.cwd(), ".env"));
loadEnvFile(path.join(app.getAppPath(), ".env"));

let store: ChatStore;
let authClient: DesktopAuthClient;
let apiClient: LoopbackApiClient;
const assistant = new OpenAIResponsesAdapter(
  () => process.env.OPENAI_API_KEY,
  process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
);

const activeRuns = new Map<
  string,
  { controller: AbortController; messageId: string }
>();

const probeReloadAttempts = new WeakMap<BrowserWindow, number>();
const recoveringWindows = new WeakSet<BrowserWindow>();

function wantDevTools(): boolean {
  return !app.isPackaged && process.env.AGENTCLOUD_DESKTOP_DEVTOOLS === "1";
}

function openDevToolsIfEnabled(win: BrowserWindow): void {
  if (!wantDevTools() || win.isDestroyed()) return;
  // Docked — dies with the BrowserWindow (avoids orphan blank detached DevTools).
  if (!win.webContents.isDevToolsOpened()) {
    win.webContents.openDevTools({ mode: "right" });
  }
}

function showWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  win.focus();
}

function rendererUrl(): { kind: "url" | "file"; target: string } {
  if (process.env.VITE_DEV_SERVER_URL) {
    return { kind: "url", target: process.env.VITE_DEV_SERVER_URL };
  }
  return {
    kind: "file",
    target: path.join(__dirname, "../dist/index.html"),
  };
}

async function loadRenderer(win: BrowserWindow): Promise<void> {
  const target = rendererUrl();
  if (target.kind === "url") {
    await win.loadURL(target.target);
  } else {
    await win.loadFile(target.target);
  }
}

function bridgeErrorHtml(detail: string): string {
  const safe = detail
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>AgentCloud Chat — error</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0f1112;
        color: #e6e4e1;
        font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
        padding: 2rem;
      }
      main {
        max-width: 36rem;
        border: 1px solid #ff458e;
        background: #4b1528;
        border-radius: 0.5rem;
        padding: 1.5rem;
      }
      h1 { font-size: 1.125rem; margin: 0 0 0.75rem; }
      p { margin: 0 0 0.75rem; line-height: 1.6; color: #a8a4a4; }
      code { color: #e6e4e1; }
    </style>
  </head>
  <body>
    <main role="alert">
      <h1>Desktop bridge unavailable</h1>
      <p>${safe}</p>
      <p>Quit this window, then restart with <code>just desktop</code> from the repo root.</p>
      <p>Do not run a second <code>npx electron .</code> alongside Vite.</p>
    </main>
  </body>
</html>`;
}

function showBridgeError(win: BrowserWindow, detail: string): void {
  if (win.isDestroyed()) return;
  console.error("[desktop] showing in-window bridge error:", detail);
  void win
    .loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(bridgeErrorHtml(detail))}`,
    )
    .then(() => showWindow(win))
    .catch((error) => {
      console.error("[desktop] failed to show bridge error page:", error);
      showWindow(win);
    });
}

function recoverWindow(win: BrowserWindow, reason: string): void {
  if (win.isDestroyed()) {
    console.error(`[desktop] window destroyed after ${reason}; creating a new one`);
    createWindow();
    return;
  }
  if (recoveringWindows.has(win)) {
    console.error(`[desktop] recovery already in progress (${reason})`);
    return;
  }
  recoveringWindows.add(win);
  console.error(`[desktop] recovering UI after ${reason}`);

  const finish = () => {
    recoveringWindows.delete(win);
    if (win.isDestroyed()) {
      createWindow();
      return;
    }
    showWindow(win);
    openDevToolsIfEnabled(win);
  };

  win.webContents.once("did-finish-load", finish);

  void loadRenderer(win).catch((error) => {
    console.error("[desktop] recovery reload failed:", error);
    recoveringWindows.delete(win);
    if (win.isDestroyed()) {
      createWindow();
      return;
    }
    showBridgeError(
      win,
      `Renderer recovery failed after ${reason}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

function attachWindowHandlers(win: BrowserWindow): void {
  win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 ERR_ABORTED is common during intentional navigations/reloads.
    if (code === -3) return;
    if (url.startsWith("data:text/html")) return;
    console.error(`Renderer failed to load (${code}): ${description} @ ${url}`);
    recoverWindow(win, `did-fail-load ${code}`);
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer process gone:", details);
    console.error("[desktop] attempting reload/recreate after renderer kill");
    recoverWindow(
      win,
      `render-process-gone (${details.reason}, exit ${details.exitCode})`,
    );
  });

  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    }
  });

  win.on("ready-to-show", () => {
    showWindow(win);
  });

  win.webContents.on("did-finish-load", () => {
    if (win.isDestroyed()) return;
    showWindow(win);
    openDevToolsIfEnabled(win);

    const currentUrl = win.webContents.getURL();
    if (currentUrl.startsWith("data:text/html")) return;

    // Give React a beat to replace the static “Loading…” splash before probing.
    setTimeout(() => {
      if (win.isDestroyed()) return;
      void win.webContents
        .executeJavaScript(
          `({
            text: document.body?.innerText?.slice(0, 500) ?? "",
            bridge: typeof window.agentcloudDesktop !== "undefined",
            rootHTML: document.getElementById("root")?.innerHTML?.slice(0, 300) ?? ""
          })`,
        )
        .then((info: { text: string; bridge: boolean; rootHTML: string }) => {
          console.log("[desktop] renderer ready:", info);
          if (win.isDestroyed()) return;

          const text = info.text.trim();
          const stillLoadingOnly =
            text === "Loading AgentCloud Chat…" || text.length === 0;
          const looksBroken = !info.bridge || stillLoadingOnly;

          if (!looksBroken) {
            probeReloadAttempts.delete(win);
            return;
          }

          const attempts = probeReloadAttempts.get(win) ?? 0;
          if (attempts < 1) {
            probeReloadAttempts.set(win, attempts + 1);
            console.error(
              "[desktop] renderer probe unhealthy; reloading once",
              info,
            );
            recoverWindow(win, "unhealthy renderer probe");
            return;
          }

          showBridgeError(
            win,
            info.bridge
              ? "The chat UI did not finish loading. The desktop bridge is present but the shell stayed empty."
              : "The desktop preload bridge is missing (window.agentcloudDesktop). Preload may have failed — keep preload.cjs and avoid a second Electron process.",
          );
        })
        .catch((error) => {
          console.error("[desktop] renderer probe failed:", error);
          if (!win.isDestroyed()) {
            showBridgeError(
              win,
              `Could not inspect the renderer after load: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        });
    }, 750);
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0f1112",
    title: "AgentCloud Chat",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  attachWindowHandlers(win);
  void loadRenderer(win).catch((error) => {
    console.error("[desktop] initial load failed:", error);
    showBridgeError(
      win,
      `Initial renderer load failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

function broadcast(event: AssistantStreamEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("assistant:event", event);
  }
}

function wrapIpc<T extends unknown[]>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: T) => Promise<unknown>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...(args as T));
    } catch (error) {
      const message =
        error instanceof ChatStoreError ||
        error instanceof MissingCredentialsError ||
        error instanceof AuthError ||
        error instanceof LoopbackApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Unexpected desktop error";
      throw new Error(message);
    }
  });
}

app.whenReady().then(async () => {
  const dataDir = path.join(app.getPath("userData"), "chat");
  store = new ChatStore(dataDir);
  await store.init();

  const sessionDir = path.join(app.getPath("userData"), "auth");
  const sessionStore = new SessionStore(sessionDir, {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (encrypted) => safeStorage.decryptString(encrypted),
  });
  authClient = new DesktopAuthClient(sessionStore, {
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  });
  apiClient = new LoopbackApiClient({
    getBaseUrl: () => authClient.getBaseUrl(),
    request: (path, init) => authClient.fetchHuman(path, init),
  });

  wrapIpc("auth:status", async () => authClient.status());
  wrapIpc("auth:signIn", async (_event, email: string, password: string) => {
    const user = await authClient.signIn(email, password);
    return { user, status: await authClient.status() };
  });
  wrapIpc("auth:signOut", async () => {
    await authClient.signOut();
    return authClient.status();
  });
  wrapIpc(
    "auth:fetchHuman",
    async (
      _event,
      pathOrUrl: string,
      init: { method?: string; body?: string; headers?: Record<string, string> } = {},
    ) => {
      const response = await authClient.fetchHuman(pathOrUrl, {
        method: init.method || "GET",
        headers: init.headers,
        body: init.body,
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        body: text,
      };
    },
  );
  wrapIpc("api:getState", async () => apiClient.getState());
  wrapIpc(
    "api:postAction",
    async (_event, body: Record<string, unknown>) => apiClient.postAction(body),
  );

  wrapIpc("chat:list", async () => store.listThreads());
  wrapIpc("chat:create", async () => store.createThread());
  wrapIpc("chat:get", async (_event, threadId: string) =>
    store.getThread(threadId),
  );
  wrapIpc("chat:delete", async (_event, threadId: string) => {
    const active = activeRuns.get(threadId);
    if (active) {
      active.controller.abort();
      activeRuns.delete(threadId);
    }
    await store.deleteThread(threadId);
  });
  wrapIpc("chat:rename", async (_event, threadId: string, title: string) =>
    store.renameThread(threadId, title),
  );
  wrapIpc(
    "chat:appendMessage",
    async (
      _event,
      threadId: string,
      input: {
        role: "user" | "assistant";
        content: string;
        status?: "complete" | "streaming" | "cancelled" | "failed";
        id?: string;
      },
    ) => store.appendMessage(threadId, input),
  );
  wrapIpc(
    "chat:updateMessage",
    async (
      _event,
      threadId: string,
      messageId: string,
      patch: Partial<{
        content: string;
        status: "complete" | "streaming" | "cancelled" | "failed";
        error: string;
      }>,
    ) => store.updateMessage(threadId, messageId, patch),
  );
  wrapIpc("assistant:credentialStatus", async () =>
    assistant.credentialStatus(),
  );
  wrapIpc("desktop:dataDir", async () => store.rootDir);

  wrapIpc(
    "assistant:send",
    async (_event, threadId: string, _userMessageId: string) => {
      if (activeRuns.has(threadId)) {
        throw new Error("A reply is already in progress for this chat.");
      }

      const thread = await store.getThread(threadId);
      if (!thread) throw new ChatStoreError(`Thread not found: ${threadId}`);

      const status = assistant.credentialStatus();
      const assistantMessage = await store.appendMessage(threadId, {
        id: randomUUID(),
        role: "assistant",
        content: "",
        status: "streaming",
      });

      if (!status.configured) {
        await store.updateMessage(threadId, assistantMessage.id, {
          status: "failed",
          content: "",
          error: status.message,
        });
        broadcast({
          type: "status",
          threadId,
          messageId: assistantMessage.id,
          status: "failed",
          error: status.message,
        });
        broadcast({
          type: "done",
          threadId,
          messageId: assistantMessage.id,
        });
        return { assistantMessageId: assistantMessage.id };
      }

      const controller = new AbortController();
      activeRuns.set(threadId, {
        controller,
        messageId: assistantMessage.id,
      });

      broadcast({
        type: "status",
        threadId,
        messageId: assistantMessage.id,
        status: "streaming",
      });

      let assembled = "";
      void (async () => {
        try {
          const history = thread.messages
            .filter((message) => message.status !== "failed")
            .map((message) => ({
              role: message.role,
              content: message.content,
            }));

          await assistant.streamReply({
            messages: history,
            signal: controller.signal,
            onDelta: (chunk) => {
              assembled += chunk;
              broadcast({
                type: "delta",
                threadId,
                messageId: assistantMessage.id,
                text: chunk,
              });
            },
          });

          await store.updateMessage(threadId, assistantMessage.id, {
            content: assembled,
            status: "complete",
          });
          broadcast({
            type: "status",
            threadId,
            messageId: assistantMessage.id,
            status: "complete",
          });
        } catch (error) {
          if (controller.signal.aborted) {
            await store.updateMessage(threadId, assistantMessage.id, {
              content: assembled,
              status: "cancelled",
              error: "Generation stopped.",
            });
            broadcast({
              type: "status",
              threadId,
              messageId: assistantMessage.id,
              status: "cancelled",
              error: "Generation stopped.",
            });
          } else {
            const message =
              error instanceof Error ? error.message : "Assistant request failed";
            await store.updateMessage(threadId, assistantMessage.id, {
              content: assembled,
              status: "failed",
              error: message,
            });
            broadcast({
              type: "status",
              threadId,
              messageId: assistantMessage.id,
              status: "failed",
              error: message,
            });
          }
        } finally {
          activeRuns.delete(threadId);
          broadcast({
            type: "done",
            threadId,
            messageId: assistantMessage.id,
          });
        }
      })();

      return { assistantMessageId: assistantMessage.id };
    },
  );

  wrapIpc("assistant:cancel", async (_event, threadId: string) => {
    const active = activeRuns.get(threadId);
    if (!active) return;
    active.controller.abort();
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
