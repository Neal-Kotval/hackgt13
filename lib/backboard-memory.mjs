import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { BackboardError, createBackboardClient } from "./backboard.mjs";

const PROJECT = /^[A-Za-z0-9_-]{1,80}$/;
const RUN_BOX = /^[A-Za-z0-9-]{1,64}$/;
const SECRET = /BEGIN [A-Z ]*PRIVATE KEY|BACKBOARD_API_KEY|sk-[A-Za-z0-9]{8,}|x-api-key/i;

export function openBackboardDb(filename) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename);
  db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS backboard_project (
    project_id TEXT PRIMARY KEY,
    assistant_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS backboard_agent_thread (
    project_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS backboard_environment (
    run_box_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    updated_at TEXT NOT NULL
  );`);
  return db;
}

export function defaultBackboardFile(env = process.env) {
  return path.join(path.resolve(env.AGENTCLOUD_DATA_DIR || ".agentcloud"), "backboard.sqlite");
}

function id(value, name) {
  if (typeof value !== "string" || !PROJECT.test(value)) throw new BackboardError(`Invalid ${name}`);
  return value;
}

function pickId(body, ...keys) {
  for (const key of keys) {
    if (body && typeof body[key] === "string") return body[key];
  }
  throw new BackboardError("Backboard response did not include an id");
}

export function assertMemoryText(content) {
  const text = typeof content === "string" ? content.trim() : "";
  if (!text || text.length > 2000) throw new BackboardError("Memory text must be 1 to 2000 characters");
  if (SECRET.test(text)) throw new BackboardError("Memory text cannot include a secret");
  return text;
}

/** Shared notebook for one project. Creates the Backboard assistant once. */
export async function ensureProjectAssistant(db, client, projectId, projectName) {
  if (!client.configured) return { enabled: false };
  const project = id(projectId, "project id");
  const existing = db.prepare("SELECT assistant_id FROM backboard_project WHERE project_id = ?").get(project);
  if (existing) return { enabled: true, assistantId: existing.assistant_id, created: false };
  const body = await client.createAssistant(projectName || project);
  const assistantId = pickId(body, "assistant_id", "id");
  db.prepare("INSERT INTO backboard_project (project_id, assistant_id, created_at) VALUES (?, ?, ?)").run(
    project,
    assistantId,
    new Date().toISOString(),
  );
  return { enabled: true, assistantId, created: true };
}

/** Private conversation for one agent. Reuses the project assistant. */
export async function ensureAgentThread(db, client, projectId, agentId) {
  if (!client.configured) return { enabled: false };
  const project = id(projectId, "project id");
  const agent = id(agentId, "agent id");
  const assistant = db.prepare("SELECT assistant_id FROM backboard_project WHERE project_id = ?").get(project);
  if (!assistant) throw new BackboardError("Project memory has not been created");
  const existing = db.prepare("SELECT thread_id FROM backboard_agent_thread WHERE project_id = ? AND agent_id = ?").get(project, agent);
  if (existing) return { enabled: true, assistantId: assistant.assistant_id, threadId: existing.thread_id, created: false };
  const body = await client.createThread(assistant.assistant_id);
  const threadId = pickId(body, "thread_id", "id");
  db.prepare("INSERT INTO backboard_agent_thread (project_id, agent_id, thread_id, created_at) VALUES (?, ?, ?, ?)").run(
    project,
    agent,
    threadId,
    new Date().toISOString(),
  );
  return { enabled: true, assistantId: assistant.assistant_id, threadId, created: true };
}

/**
 * Run one assistant tool. Computer tools are refused until they are bound to
 * this agent's own run box. They never accept a host or another box id.
 */
export async function executeProjectTool(client, assistantId, name, args = {}) {
  if (!client.configured) return { enabled: false };
  if (args.host || args.runBoxId || args.run_box_id) throw new BackboardError("A tool cannot choose a computer");
  if (name === "search_project_memory") {
    const body = await client.searchMemories(assistantId, args.query || "");
    return { enabled: true, memories: Array.isArray(body?.memories) ? body.memories : [] };
  }
  if (name === "write_project_memory") {
    const text = assertMemoryText([args.summary, args.branch && `branch ${args.branch}`, args.commit && `commit ${args.commit}`, args.next && `next: ${args.next}`].filter(Boolean).join(". "));
    await client.addMemory(assistantId, text);
    return { enabled: true, saved: true };
  }
  if (name === "git_snapshot" || name === "read_file" || name === "run_command")
    return { enabled: true, available: false, reason: "This agent's computer is not connected to Backboard yet." };
  throw new BackboardError("Unknown project tool");
}

/** Whether this environment's agents share notes. Missing rows stay off. */
export function environmentMemory(filename, runBoxId) {
  if (typeof runBoxId !== "string" || !RUN_BOX.test(runBoxId)) return { enabled: false };
  const db = openBackboardDb(filename);
  try {
    const row = db.prepare("SELECT enabled FROM backboard_environment WHERE run_box_id = ?").get(runBoxId);
    return { enabled: row?.enabled === 1 };
  } finally {
    db.close();
  }
}

/** Save the owner's choice for one environment. */
export function setEnvironmentMemory(filename, runBoxId, enabled) {
  if (typeof runBoxId !== "string" || !RUN_BOX.test(runBoxId)) throw new BackboardError("Invalid environment");
  if (typeof enabled !== "boolean") throw new BackboardError("Shared memory must be on or off");
  const db = openBackboardDb(filename);
  try {
    db.prepare(`INSERT INTO backboard_environment (run_box_id, enabled, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(run_box_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`)
      .run(runBoxId, enabled ? 1 : 0, new Date().toISOString());
    return { enabled };
  } finally {
    db.close();
  }
}

/**
 * Recall project memory before a Codex turn and save the ask after Codex accepts it.
 * Only an environment the owner turned on uses Backboard. Missing configuration or a
 * Backboard failure returns the original text.
 * @param {{ projectId: string, agentId: string, text: string, runBoxId?: string | null, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, file?: string }} [input]
 */
export async function augmentCodexTurn({ projectId, agentId, text, runBoxId, env = process.env, fetchImpl, file } = {}) {
  const store = file || defaultBackboardFile(env);
  if (!environmentMemory(store, runBoxId).enabled) return { text };
  let client;
  try {
    client = createBackboardClient({ env, fetchImpl });
  } catch {
    return { text };
  }
  if (!client.configured) return { text };
  let db;
  try {
    db = openBackboardDb(store);
    const project = await ensureProjectAssistant(db, client, projectId, projectId);
    if (!project.enabled) return { text };
    const thread = await ensureAgentThread(db, client, projectId, agentId);
    const found = await client.searchMemories(project.assistantId, String(text).slice(0, 500));
    const lines = (Array.isArray(found?.memories) ? found.memories : [])
      .map((row) => (row && typeof row.content === "string" ? row.content.trim() : ""))
      .filter(Boolean)
      .slice(0, 8);
    let outbound = text;
    if (lines.length) {
      const preface = `Project memory shared by other agents. This is not a view of their computers.\n${lines.map((line) => `- ${line}`).join("\n")}\n\nHuman message:\n`;
      outbound = preface.length + text.length <= 16000 ? `${preface}${text}` : text;
    }
    const assistantId = project.assistantId;
    return {
      text: outbound,
      threadId: thread.threadId,
      afterSend: async () => {
        try {
          await client.addMemory(assistantId, `An agent was asked: ${assertMemoryText(String(text).slice(0, 500))}`);
        } catch {
          /* The Codex turn already started. */
        }
      },
    };
  } catch {
    return { text };
  } finally {
    db?.close();
  }
}

/** Status for a request path. Does not open the database or the network. */
export function projectMemoryStatus(env = process.env) {
  return { enabled: createBackboardClient({ env, fetchImpl: async () => { throw new Error("network"); } }).configured };
}
