export type MessageRole = "user" | "assistant";

export type { DeepLinkParseResult, DeepLinkTarget } from "./deep-link";
import type { DeepLinkParseResult } from "./deep-link";

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
  source: "env" | "none";
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
};

export type ProjectTaskSnapshot = {
  id: string;
  title: string;
  owner: string;
  status: string;
  instructions?: string;
  environmentId?: string;
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
};
