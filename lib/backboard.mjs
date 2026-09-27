// Optional shared project memory. Off unless BACKBOARD_API_KEY is set.
// No route imports this module yet, so the hosted app cannot call Backboard.

const DEFAULT_BASE = "https://app.backboard.io";
const ID = /^[A-Za-z0-9_-]{8,80}$/;

export class BackboardError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "BackboardError";
    this.status = status;
  }
}

/** @param {NodeJS.ProcessEnv} [env] */
export function backboardConfig(env = process.env) {
  const apiKey = typeof env.BACKBOARD_API_KEY === "string" ? env.BACKBOARD_API_KEY.trim() : "";
  if (!apiKey) return { configured: false };
  if (apiKey.length > 512) throw new BackboardError("BACKBOARD_API_KEY is invalid");
  const base = (env.BACKBOARD_API_BASE || DEFAULT_BASE).trim().replace(/\/$/, "");
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new BackboardError("BACKBOARD_API_BASE is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new BackboardError("BACKBOARD_API_BASE must be an HTTPS origin");
  return { configured: true, apiKey, base: `${url.origin}/api` };
}

function identifier(value, name) {
  if (typeof value !== "string" || !ID.test(value)) throw new BackboardError(`Invalid Backboard ${name}`);
  return value;
}

function publicError(text, apiKey) {
  return String(text || "Backboard request failed").replaceAll(apiKey, "[redacted]").slice(0, 180);
}

/**
 * OpenAI-style tools the project assistant will be allowed to call.
 * Computer tools take no host or run-box id; the server picks this agent's box later.
 */
export const projectMemoryTools = [
  {
    type: "function",
    function: {
      name: "search_project_memory",
      description: "Read facts other agents on this project have saved. Does not open their computers.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to look up" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_project_memory",
      description: "Save one short fact for the other agents on this project.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          branch: { type: "string" },
          commit: { type: "string" },
          next: { type: "string", description: "What the next agent should do" },
        },
        required: ["summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_snapshot",
      description: "Branch, commit, and short status on this agent's own computer.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read one workspace file on this agent's own computer.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run one command on this agent's own computer.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
];

/** @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch }} [options] */
export function createBackboardClient({ env = process.env, fetchImpl = fetch } = {}) {
  const config = backboardConfig(env);

  async function request(path, init = {}) {
    if (!config.configured) throw new BackboardError("Backboard is not configured", 503);
    if (typeof path !== "string" || !path.startsWith("/") || path.includes(".."))
      throw new BackboardError("Invalid Backboard path");
    const headers = new Headers(init.headers);
    headers.set("X-API-Key", config.apiKey);
    if (init.body) headers.set("content-type", "application/json");
    const response = await fetchImpl(`${config.base}${path}`, {
      method: init.method || "GET",
      headers,
      body: init.body,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400)
      throw new BackboardError("Backboard redirected", response.status);
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new BackboardError("Backboard returned a non-JSON response", response.status);
      }
    }
    if (!response.ok) throw new BackboardError(publicError(body?.detail || body?.message, config.apiKey), response.status);
    return body;
  }

  return {
    configured: config.configured,
    request,
    createAssistant(name) {
      return request("/assistants", {
        method: "POST",
        body: JSON.stringify({
          name: String(name || "alto project").slice(0, 100),
          instructions: "You share facts across agents who cannot see each other's computers. Recall project memory before acting. After a real step, write one fact. Never request another agent's shell.",
          tools: projectMemoryTools,
        }),
      });
    },
    createThread(assistantId) {
      return request("/threads", {
        method: "POST",
        body: JSON.stringify({ assistant_id: identifier(assistantId, "assistant id") }),
      });
    },
    sendMessage({ assistantId, threadId, content }) {
      return request("/threads/messages", {
        method: "POST",
        body: JSON.stringify({
          assistant_id: identifier(assistantId, "assistant id"),
          thread_id: identifier(threadId, "thread id"),
          content: String(content || "").slice(0, 8000),
          memory: "Auto",
          stream: false,
        }),
      });
    },
    addMemory(assistantId, content) {
      return request(`/assistants/${identifier(assistantId, "assistant id")}/memories`, {
        method: "POST",
        body: JSON.stringify({ content: String(content).slice(0, 2000) }),
      });
    },
    /** Read-only list of the assistant's saved facts. */
    listMemories(assistantId) {
      return request(`/assistants/${identifier(assistantId, "assistant id")}/memories`);
    },
    searchMemories(assistantId, query) {
      return request(`/assistants/${identifier(assistantId, "assistant id")}/memories/search`, {
        method: "POST",
        body: JSON.stringify({ query: String(query).slice(0, 500), limit: 8 }),
      });
    },
  };
}
