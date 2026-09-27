import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentCloudStateSummary,
  AssistantStreamEvent,
  AuthStatus,
  ChatMessage,
  CodexSignInEvent,
  ChatThread,
  ChatThreadSummary,
  CredentialStatus,
  DesktopApi,
  DeviceKeyStatus,
  RunBoxSummary,
  TerminalEvent,
  EmployeeIdentity,
  MessageRole,
  MessageStatus,
} from "../src/lib/types.ts";

const api: DesktopApi = {
  listThreads: () =>
    ipcRenderer.invoke("chat:list") as Promise<ChatThreadSummary[]>,
  createThread: () => ipcRenderer.invoke("chat:create") as Promise<ChatThread>,
  getThread: (threadId) =>
    ipcRenderer.invoke("chat:get", threadId) as Promise<ChatThread | null>,
  deleteThread: (threadId) =>
    ipcRenderer.invoke("chat:delete", threadId) as Promise<void>,
  renameThread: (threadId, title) =>
    ipcRenderer.invoke("chat:rename", threadId, title) as Promise<ChatThread>,
  appendMessage: (threadId, input) =>
    ipcRenderer.invoke("chat:appendMessage", threadId, input) as Promise<ChatMessage>,
  updateMessage: (threadId, messageId, patch) =>
    ipcRenderer.invoke(
      "chat:updateMessage",
      threadId,
      messageId,
      patch,
    ) as Promise<ChatMessage>,
  credentialStatus: () =>
    ipcRenderer.invoke("assistant:credentialStatus") as Promise<CredentialStatus>,
  sendAssistant: (threadId, userMessageId, options) =>
    ipcRenderer.invoke(
      "assistant:send",
      threadId,
      userMessageId,
      options,
    ) as Promise<{
      assistantMessageId: string;
    }>,
  cancelAssistant: (threadId) =>
    ipcRenderer.invoke("assistant:cancel", threadId) as Promise<void>,
  onAssistantEvent: (handler) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: AssistantStreamEvent,
    ) => {
      handler(payload);
    };
    ipcRenderer.on("assistant:event", listener);
    return () => {
      ipcRenderer.removeListener("assistant:event", listener);
    };
  },
  dataDir: () => ipcRenderer.invoke("desktop:dataDir") as Promise<string>,
  authStatus: () => ipcRenderer.invoke("auth:status") as Promise<AuthStatus>,
  signIn: (email, password) =>
    ipcRenderer.invoke("auth:signIn", email, password) as Promise<{
      user: EmployeeIdentity;
      status: AuthStatus;
    }>,
  signOut: () => ipcRenderer.invoke("auth:signOut") as Promise<AuthStatus>,
  fetchHuman: (pathOrUrl, init) =>
    ipcRenderer.invoke("auth:fetchHuman", pathOrUrl, init) as Promise<{
      ok: boolean;
      status: number;
      body: string;
    }>,
  getState: () =>
    ipcRenderer.invoke("api:getState") as Promise<AgentCloudStateSummary>,
  postAction: (body) =>
    ipcRenderer.invoke("api:postAction", body) as Promise<{
      state: AgentCloudStateSummary;
      raw: unknown;
    }>,
  takePendingDeepLink: () =>
    ipcRenderer.invoke("deepLink:takePending") as Promise<
      import("../src/lib/deep-link.ts").DeepLinkParseResult | null
    >,
  onDeepLink: (handler) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: import("../src/lib/deep-link.ts").DeepLinkParseResult,
    ) => {
      handler(payload);
    };
    ipcRenderer.on("deep-link", listener);
    return () => {
      ipcRenderer.removeListener("deep-link", listener);
    };
  },
  listRunBoxes: (projectId) =>
    ipcRenderer.invoke("api:listRunBoxes", projectId) as Promise<RunBoxSummary[]>,
  openChatGptSignIn: (verificationUrl) =>
    ipcRenderer.invoke("codexSignIn:open", verificationUrl) as Promise<void>,
  startChatGptBrowserSignIn: (input) =>
    ipcRenderer.invoke("codexSignIn:startBrowser", {
      sessionId: input.sessionId,
      runBoxId: input.runBoxId,
      authUrl: input.authUrl,
      callbackPort: input.callbackPort,
    }) as Promise<{ callbackPort: number }>,
  stopChatGptBrowserSignIn: (sessionId) =>
    ipcRenderer.invoke("codexSignIn:stopBrowser", sessionId) as Promise<void>,
  onChatGptSignInEvent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: CodexSignInEvent) => {
      handler(payload);
    };
    ipcRenderer.on("codexSignIn:event", listener);
    return () => {
      ipcRenderer.removeListener("codexSignIn:event", listener);
    };
  },
  deviceKeyStatus: () =>
    ipcRenderer.invoke("deviceKey:status") as Promise<DeviceKeyStatus>,
  terminalOpen: (sessionId, runBoxId, size) =>
    ipcRenderer.invoke("terminal:open", sessionId, runBoxId, {
      cols: size.cols,
      rows: size.rows,
    }) as Promise<{ sessionId: string; username: string; host: string; port: number }>,
  terminalWrite: (sessionId, data) => {
    ipcRenderer.send("terminal:write", sessionId, data);
  },
  terminalResize: (sessionId, cols, rows) => {
    ipcRenderer.send("terminal:resize", sessionId, cols, rows);
  },
  terminalClose: (sessionId) =>
    ipcRenderer.invoke("terminal:close", sessionId) as Promise<void>,
  onTerminalEvent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalEvent) => {
      handler(payload);
    };
    ipcRenderer.on("terminal:event", listener);
    return () => {
      ipcRenderer.removeListener("terminal:event", listener);
    };
  },
};

contextBridge.exposeInMainWorld("agentcloudDesktop", api);

export type { DesktopApi, MessageRole, MessageStatus };
