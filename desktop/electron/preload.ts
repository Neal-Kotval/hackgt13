import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentCloudStateSummary,
  AssistantStreamEvent,
  AuthStatus,
  ChatMessage,
  ChatThread,
  ChatThreadSummary,
  CredentialStatus,
  DesktopApi,
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
  sendAssistant: (threadId, userMessageId) =>
    ipcRenderer.invoke("assistant:send", threadId, userMessageId) as Promise<{
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
};

contextBridge.exposeInMainWorld("agentcloudDesktop", api);

export type { DesktopApi, MessageRole, MessageStatus };
