export type MessageRole = "user" | "assistant";

export type { DeepLinkParseResult, DeepLinkTarget } from "./deep-link";
import type { DeepLinkParseResult } from "./deep-link";
import type { RunBoxSummary } from "./run-boxes";
import type { EnvironmentAccessState } from "./environment-access";
export type { RunBoxSummary, RunBoxState } from "./run-boxes";

export type MessageStatus =
  | "complete"
  | "streaming"
  | "cancelled"
  | "failed";

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  updatedAt: string;
  status: MessageStatus;
  error?: string;
};

export type ChatThread = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

export type ChatThreadSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type ChatStoreSnapshot = {
  version: 1;
  threads: ChatThread[];
};

export type CredentialStatus = {
  configured: boolean;
  source: "agentcloud" | "env" | "none";
  model: string;
  message: string;
};

export type EmployeeIdentity = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
};

export type AuthStatus = {
  signedIn: boolean;
  baseUrl: string;
  serverReachable: boolean | null;
  user: EmployeeIdentity | null;
  message: string;
  secureStorage: boolean;
};

export type AgentCloudStateSummary = {
  revision: number;
  projectCount: number;
  projects: ProjectSnapshot[];
};

export type ProjectAgentSnapshot = {
  id: string;
  name: string;
  role: string;
  status: string;
  lastSeen?: string;
  /** Agent client (e.g. "Codex") when the server reports it. */
  client?: string;
};

export type ProjectTaskSnapshot = {
  id: string;
  title: string;
  owner: string;
  status: string;
  instructions?: string;
  environmentId?: string;
  runBoxId?: string;
};

export type ProjectResourceSnapshot = {
  id: string;
  name: string;
  kind: string;
  status: string;
};

export type ProjectRequestSnapshot = {
  id: string;
  purpose: string;
  status: string;
  decisionStatus: string;
  decisionReason: string;
};

export type ProjectSnapshot = {
  id: string;
  name: string;
  repo: string;
  template: string;
  compute: string;
  host?: string;
  agents: ProjectAgentSnapshot[];
  tasks: ProjectTaskSnapshot[];
  resources: ProjectResourceSnapshot[];
  resourceRequests: ProjectRequestSnapshot[];
};

export type AssistantStreamEvent =
  | { type: "delta"; threadId: string; messageId: string; text: string }
  | {
      type: "status";
      threadId: string;
      messageId: string;
      status: MessageStatus;
      error?: string;
    }
  | { type: "done"; threadId: string; messageId: string };

/** Public status of this device's SSH key. Never includes private material. */
export type DeviceKeyStatus = {
  state: "unavailable" | "registering" | "registered" | "error";
  fingerprint: string | null;
  label: string | null;
  /** True when the private key is stored encrypted on disk (safeStorage). */
  persistent: boolean;
  message: string;
};

export type TerminalEvent =
  | { type: "data"; sessionId: string; data: string }
  | { type: "closed"; sessionId: string; error?: string }
  /** HAC-166: waiting for an aws-cpu environment to admit this Mac's network. */
  | { type: "access"; sessionId: string; state: EnvironmentAccessState };

/**
 * HAC-161: the browser sign-in tunnel closed without being asked to (timeout or SSH drop).
 * HAC-166: `access` while waiting for an aws-cpu environment to admit this Mac's network.
 */
export type CodexSignInEvent =
  | { type: "closed"; sessionId: string; error?: string }
  | { type: "access"; sessionId: string; state: EnvironmentAccessState };

export type DesktopApi = {
  listThreads: () => Promise<ChatThreadSummary[]>;
  createThread: () => Promise<ChatThread>;
  getThread: (threadId: string) => Promise<ChatThread | null>;
  deleteThread: (threadId: string) => Promise<void>;
  renameThread: (threadId: string, title: string) => Promise<ChatThread>;
  appendMessage: (
    threadId: string,
    input: {
      role: MessageRole;
      content: string;
      status?: MessageStatus;
      id?: string;
    },
  ) => Promise<ChatMessage>;
  updateMessage: (
    threadId: string,
    messageId: string,
    patch: Partial<Pick<ChatMessage, "content" | "status" | "error">>,
  ) => Promise<ChatMessage>;
  credentialStatus: () => Promise<CredentialStatus>;
  sendAssistant: (
    threadId: string,
    userMessageId: string,
    options: { projectId: string; agentId?: string },
  ) => Promise<{ assistantMessageId: string }>;
  cancelAssistant: (threadId: string) => Promise<void>;
  onAssistantEvent: (
    handler: (event: AssistantStreamEvent) => void,
  ) => () => void;
  dataDir: () => Promise<string>;
  authStatus: () => Promise<AuthStatus>;
  signIn: (
    email: string,
    password: string,
  ) => Promise<{ user: EmployeeIdentity; status: AuthStatus }>;
  signOut: () => Promise<AuthStatus>;
  fetchHuman: (
    pathOrUrl: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ) => Promise<{ ok: boolean; status: number; body: string }>;
  getState: () => Promise<AgentCloudStateSummary>;
  postAction: (
    body: Record<string, unknown>,
  ) => Promise<{ state: AgentCloudStateSummary; raw: unknown }>;
  takePendingDeepLink: () => Promise<DeepLinkParseResult | null>;
  onDeepLink: (handler: (result: DeepLinkParseResult) => void) => () => void;
  listRunBoxes: (projectId: string) => Promise<RunBoxSummary[]>;
  /** Opens a ChatGPT device sign-in page in the system browser; main rejects anything off https://auth.openai.com/. */
  openChatGptSignIn: (verificationUrl: string) => Promise<void>;
  /**
   * HAC-161: forwards 127.0.0.1:<callbackPort> on this Mac to the environment
   * over SSH, then opens `authUrl` in the system browser. Main re-validates both.
   */
  startChatGptBrowserSignIn: (input: {
    sessionId: string;
    runBoxId: string;
    authUrl: string;
    callbackPort: number;
  }) => Promise<{ callbackPort: number }>;
  /** Closes the sign-in tunnel for a Codex session (finished, cancelled or abandoned). */
  stopChatGptBrowserSignIn: (sessionId: string) => Promise<void>;
  onChatGptSignInEvent: (handler: (event: CodexSignInEvent) => void) => () => void;
  deviceKeyStatus: () => Promise<DeviceKeyStatus>;
  /** Opens an SSH shell for a ready run box. `sessionId` is chosen by the caller. */
  terminalOpen: (
    sessionId: string,
    runBoxId: string,
    size: { cols: number; rows: number },
  ) => Promise<{ sessionId: string; username: string; host: string; port: number }>;
  terminalWrite: (sessionId: string, data: string) => void;
  terminalResize: (sessionId: string, cols: number, rows: number) => void;
  terminalClose: (sessionId: string) => Promise<void>;
  onTerminalEvent: (handler: (event: TerminalEvent) => void) => () => void;
};
