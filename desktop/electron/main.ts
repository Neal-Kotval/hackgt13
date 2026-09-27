import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MissingCredentialsError,
  MissingProjectError,
  ProjectAgentChatAdapter,
  type AssistantAdapter,
} from "./assistant.ts";
import { AuthError, DesktopAuthClient } from "./auth-client.ts";
import { LoopbackApiClient, LoopbackApiError } from "./api-client.ts";
import { ChatStore, ChatStoreError } from "./chat-store.ts";
import { SessionStore } from "./session-store.ts";
import { DeviceKeyRegistrar, DeviceKeyStore } from "./device-key.ts";
import { TerminalSessions } from "./terminal-sessions.ts";
import { isChatGptVerificationUrl } from "../src/lib/chatgpt-sign-in.ts";
import type { AssistantStreamEvent, TerminalEvent } from "../src/lib/types.ts";
import {
  findDeepLinkUrl,
  parseAgentCloudDeepLink,
  type DeepLinkParseResult,
} from "../src/lib/deep-link.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROTOCOL = "agentcloud";
let pendingDeepLink: DeepLinkParseResult | null = null;

function focusMainWindow(): BrowserWindow | null {
  const existing = BrowserWindow.getAllWindows()[0] ?? null;
  if (!existing || existing.isDestroyed()) return null;
  if (existing.isMinimized()) existing.restore();
  existing.show();
  existing.focus();
  return existing;
}

function publishDeepLink(result: DeepLinkParseResult): void {
  pendingDeepLink = result;
  const win = focusMainWindow();
  if (win && !win.webContents.isLoading()) {
    win.webContents.send("deep-link", result);
  } else if (win) {
    win.webContents.once("did-finish-load", () => {
      if (!win.isDestroyed()) win.webContents.send("deep-link", result);
    });
  }
}

function ingestDeepLinkUrl(raw: string | null | undefined): void {
  if (!raw) return;
  publishDeepLink(parseAgentCloudDeepLink(raw));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", (_event, argv) => {
  ingestDeepLinkUrl(findDeepLinkUrl(argv));
  focusMainWindow();
});

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  ingestDeepLinkUrl(url);
});

ingestDeepLinkUrl(findDeepLinkUrl(process.argv));

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
let terminals: TerminalSessions | null = null;
let assistant: AssistantAdapter;

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
    <title>alto — error</title>
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
            text === "Loading alto…" || text.length === 0;
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
    backgroundColor: "#090b0f",
    title: "alto",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  attachWindowHandlers(win);
  const ownerId = win.webContents.id;
  // SSH sessions belong to this renderer; tear them down with it.
  win.webContents.once("destroyed", () => terminals?.closeOwner(ownerId));
  win.webContents.on("render-process-gone", () => terminals?.closeOwner(ownerId));
  win.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) terminals?.closeOwner(ownerId);
  });
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
        error instanceof MissingProjectError ||
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
  assistant = new ProjectAgentChatAdapter(apiClient);

  // HAC-90: one ed25519 key per device, encrypted with safeStorage. The
  // private key stays in this process; only public status crosses IPC.
  const keyStore = new DeviceKeyStore(path.join(app.getPath("userData"), "ssh"), {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (encrypted) => safeStorage.decryptString(encrypted),
  });
  const registrar = new DeviceKeyRegistrar(keyStore, hostname(), (requestPath, init) =>
    authClient.fetchHuman(requestPath, init),
  );
  const terminalSessions = new TerminalSessions({
    request: (requestPath, init) => authClient.fetchHuman(requestPath, init),
    privateKey: () => registrar.privateKey(),
    beforeConnect: async () => {
      await registrar.ensureRegistered();
    },
  });
  terminals = terminalSessions;

  wrapIpc("auth:status", async () => {
    const status = await authClient.status();
    if (status.signedIn) void registrar.ensureRegistered();
    return status;
  });
  wrapIpc("auth:signIn", async (_event, email: string, password: string) => {
    const user = await authClient.signIn(email, password);
    void registrar.ensureRegistered();
    return { user, status: await authClient.status() };
  });
  wrapIpc("auth:signOut", async () => {
    terminalSessions.closeAll();
    registrar.reset();
    await authClient.signOut();
    return authClient.status();
  });
  wrapIpc("deviceKey:status", async () => {
    const status = registrar.status();
    // Retry a failed/unstarted registration when a session exists.
    if (
      (status.state === "error" || status.state === "unavailable") &&
      authClient.hasLocalSession()
    ) {
      return registrar.ensureRegistered();
    }
    return status;
  });
  // HAC-153: ChatGPT device sign-in for a Codex session. Only OpenAI's auth
  // origin is ever opened; the URL is re-checked here, not trusted from the renderer.
  wrapIpc("codexSignIn:open", async (_event, verificationUrl: unknown) => {
    if (!isChatGptVerificationUrl(verificationUrl)) {
      throw new Error("Refusing to open a sign-in address outside https://auth.openai.com/.");
    }
    await shell.openExternal(verificationUrl);
  });
  wrapIpc("api:listRunBoxes", async (_event, projectId: string) =>
    apiClient.listRunBoxes(projectId),
  );
  wrapIpc(
    "terminal:open",
    async (
      event,
      sessionId: string,
      runBoxId: string,
      size: { cols: number; rows: number },
    ) => {
      const sender = event.sender;
      return terminalSessions.open(
        sender.id,
        (payload: TerminalEvent) => {
          if (!sender.isDestroyed()) sender.send("terminal:event", payload);
        },
        sessionId,
        runBoxId,
        size,
      );
    },
  );
  ipcMain.on("terminal:write", (event, sessionId: string, data: string) => {
    terminalSessions.write(event.sender.id, sessionId, data);
  });
  ipcMain.on(
    "terminal:resize",
    (event, sessionId: string, cols: number, rows: number) => {
      terminalSessions.resize(event.sender.id, sessionId, cols, rows);
    },
  );
  wrapIpc("terminal:close", async (event, sessionId: string) => {
    terminalSessions.close(event.sender.id, sessionId);
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
  wrapIpc("deepLink:takePending", async () => {
    const next = pendingDeepLink;
    pendingDeepLink = null;
    return next;
  });

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
    async (
      _event,
      threadId: string,
      _userMessageId: string,
      options: { projectId: string; agentId?: string },
    ) => {
      if (activeRuns.has(threadId)) {
        throw new Error("A reply is already in progress for this chat.");
      }

      const projectId = options?.projectId?.trim() || "";
      if (!projectId) {
        throw new MissingProjectError(
          "Select a project before chatting. Desktop chat talks to that project's agent, not a local OpenAI key.",
        );
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
            projectId,
            agentId: options.agentId,
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

app.on("before-quit", () => {
  terminals?.closeAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
