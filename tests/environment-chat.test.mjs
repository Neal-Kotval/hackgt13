import test from "node:test";
import assert from "node:assert/strict";
import {
  authorLabel, composerState, desktopConversationUrl, environmentConversations, groupTurns, parseChatEvents,
  parseChatSession, settingsSignInHref, setupSession, shouldSendOnKey,
} from "../components/environment-detail/chat-model.ts";
import { parseInline, parseMarkdown, safeHref } from "../components/environment-detail/chat-markdown.ts";
import { parseAgentCloudDeepLink } from "../desktop/src/lib/deep-link.ts";

const raw = (id, overrides = {}) => ({
  id, title: "New chat", isSetupSession: false, projectId: "p1", agentId: "a1", createdBy: "u1",
  target: { kind: "runBox", runBoxId: "job-1" }, status: "ready", activeTurnId: null, error: null,
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...overrides,
});
const ev = (id, kind, text, extra = {}) => ({ id, kind, text, createdAt: "t", updatedAt: "t", actorId: null, actorName: null, ...extra });
const readyJob = { id: "job-1", state: "ready", stop_requested_at: null, permissions: { open: true }, agent: { codex: { state: "ready" } } };

test("parses sessions and keeps only this environment, newest first", () => {
  const sessions = [
    raw("setup", { isSetupSession: true, createdAt: "2026-09-01T00:00:00.000Z" }),
    raw("newer", { createdAt: "2026-09-03T00:00:00.000Z", title: "Fix tests" }),
    raw("other-env", { target: { kind: "runBox", runBoxId: "job-2" }, createdAt: "2026-09-04T00:00:00.000Z" }),
    raw("local", { target: { kind: "local" }, createdAt: "2026-09-05T00:00:00.000Z" }),
    raw("older", { createdAt: "2026-09-02T00:00:00.000Z" }),
    { nonsense: true },
  ].map(parseChatSession).filter(Boolean);
  assert.equal(sessions.length, 5);
  assert.deepEqual(environmentConversations(sessions, "job-1").map(s => s.id), ["newer", "older", "setup"]);
  assert.equal(setupSession(sessions, "job-1").id, "setup");
  assert.equal(setupSession(sessions, "job-9"), null);
  assert.equal(parseChatSession(raw("x", { title: "" })).title, "New chat");
  assert.equal(parseChatSession(raw("s", { isSetupSession: true })).title, "Main chat");
  assert.equal(parseChatSession(raw("s", { isSetupSession: true, title: "Deploy" })).title, "Deploy");
});

test("drops malformed events", () => {
  const events = parseChatEvents([ev("1", "user", "hi"), { id: 2, kind: "user" }, ev("3", "bogus", "x"), null]);
  assert.deepEqual(events.map(e => e.id), ["1"]);
});

test("groups turns and derives running/completed/failed/interrupted", () => {
  const events = [
    ev("s0", "status", "Codex is ready in the environment workspace /w."),
    ev("u1", "user", "one", { actorName: "Ada" }),
    ev("a1", "assistant", "reply one"),
    ev("turn-1", "status", "Turn completed"),
    ev("u2", "user", "two"),
    ev("c2", "command", "Command completed · exit 0. Output is not saved."),
    ev("turn-2", "status", "Turn interrupted"),
    ev("u3", "user", "three"),
    ev("turn-3", "status", "Turn failed"),
    ev("u4", "user", "four"),
    ev("a4", "assistant", "partial"),
  ];
  const turns = groupTurns(events, "running");
  assert.deepEqual(turns.map(t => t.status), ["completed", "interrupted", "failed", "running"]);
  assert.deepEqual(turns[0].items.map(i => i.id), ["a1"]);
  assert.deepEqual(turns[1].items.map(i => i.id), ["c2"]);
  assert.equal(groupTurns(events, "ready").at(-1).status, "unknown");
  assert.equal(groupTurns(events, "error").at(-1).status, "failed");
  assert.deepEqual(groupTurns([ev("s", "status", "Connecting")], "ready"), []);
});

test("author labels show names and mark the viewer", () => {
  assert.equal(authorLabel(ev("u", "user", "x", { actorId: "u1", actorName: "Ada" }), "u1"), "Ada (you)");
  assert.equal(authorLabel(ev("u", "user", "x", { actorId: "u2", actorName: "Grace" }), "u1"), "Grace");
  assert.equal(authorLabel(ev("u", "user", "x"), "u1"), "Project member");
});

test("composer explains why it is disabled", () => {
  const setup = parseChatSession(raw("setup", { isSetupSession: true }));
  const chat = parseChatSession(raw("c"));
  const base = { job: readyJob, setup, sessionsLoaded: true, session: chat, forbidden: false };
  assert.deepEqual(composerState(base), { enabled: true });
  assert.match(composerState({ ...base, forbidden: true }).reason, /permission/);
  assert.match(composerState({ ...base, job: { ...readyJob, permissions: { open: false } } }).reason, /permission/);
  assert.match(composerState({ ...base, job: { ...readyJob, state: "allocating" } }).reason, /ready/);
  assert.match(composerState({ ...base, job: { ...readyJob, stop_requested_at: "now" } }).reason, /stopping/);
  assert.match(composerState({ ...base, job: { ...readyJob, agent: { codex: { state: "failed" } } } }).reason, /not available/);
  const signIn = composerState({ ...base, setup: parseChatSession(raw("setup", { isSetupSession: true, status: "auth_required" })) });
  assert.equal(signIn.signIn, true);
  assert.equal(composerState({ ...base, setup: null }).signIn, true);
  assert.equal(composerState({ ...base, session: null }).enabled, false);
  assert.match(composerState({ ...base, session: { ...chat, status: "running" } }).reason, /responding/);
  const disconnected = composerState({ ...base, session: { ...chat, status: "error", error: "Environment stopped" } });
  assert.equal(disconnected.reconnect, true);
  assert.equal(disconnected.reason, "Environment stopped");
  // A job without the new permissions field (older server) is not treated as forbidden.
  assert.deepEqual(composerState({ ...base, job: { id: "job-1", state: "ready" } }), { enabled: true });
});

test("desktop link opens the conversation and parses in the desktop app", () => {
  const url = desktopConversationUrl("p1", "c-1", "http://127.0.0.1:3036");
  const parsed = parseAgentCloudDeepLink(url);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.target, { projectId: "p1", codexSessionId: "c-1", serverUrl: "http://127.0.0.1:3036" });
  assert.equal(settingsSignInHref("p1", "job-1"), "/projects/p1/settings?environment=job-1#agent-setup");
});

test("Enter sends and Shift+Enter or composition does not", () => {
  assert.equal(shouldSendOnKey({ key: "Enter", shiftKey: false }), true);
  assert.equal(shouldSendOnKey({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSendOnKey({ key: "Enter", shiftKey: false, isComposing: true }), false);
  assert.equal(shouldSendOnKey({ key: "a", shiftKey: false }), false);
});

test("markdown renders a safe subset as data", () => {
  const blocks = parseMarkdown("# Title\n\nSome **bold** and `code` and [link](https://example.com).\n\n- one\n- two\n\n```js\nconst a = '<script>';\n```\n\n1. first\n2. second\n\n> quoted\n\n---\n<img src=x onerror=alert(1)>");
  assert.deepEqual(blocks.map(b => b.type), ["heading", "paragraph", "list", "code", "list", "quote", "rule", "paragraph"]);
  assert.equal(blocks[3].language, "js");
  assert.equal(blocks[3].text, "const a = '<script>';");
  assert.equal(blocks[4].ordered, true);
  // Raw HTML stays literal text; there is no HTML node type at all.
  assert.deepEqual(blocks[7].children, [{ type: "text", text: "<img src=x onerror=alert(1)>" }]);
  assert.deepEqual(parseInline("[x](javascript:alert)"), [{ type: "link", href: null, children: [{ type: "text", text: "x" }] }]);
  assert.equal(safeHref("https://example.com/a"), "https://example.com/a");
  assert.equal(safeHref("data:text/html,hi"), null);
  assert.equal(safeHref("/relative"), null);
  assert.deepEqual(parseInline("snake_case_name"), [{ type: "text", text: "snake_case_name" }]);
  assert.deepEqual(parseInline("*em*"), [{ type: "em", children: [{ type: "text", text: "em" }] }]);
  // A fence still streaming renders as code up to the end.
  assert.deepEqual(parseMarkdown("```\npartial"), [{ type: "code", language: null, text: "partial" }]);
});

test("preserves structured command output and rejects malformed evidence", () => {
  const details = { type: "commandExecution", status: "completed", command: "printf hello", cwd: "/workspace", output: "hello", exitCode: 0, durationMs: 42 };
  assert.deepEqual(parseChatEvents([{ ...ev("cmd", "command", "Completed"), details }])[0].details, details);
  assert.equal(parseChatEvents([{ ...ev("cmd", "command", "legacy"), details: { type: "unknown", status: "completed" } }])[0].details, undefined);
  assert.deepEqual(parseChatEvents([{ ...ev("file", "command", "Changed files"), details: { type: "fileChange", status: "completed", changes: [{ path: "a.ts", kind: "update", diff: "-old\n+new" }, null, { path: 7 }] } }])[0].details.changes, [{ path: "a.ts", kind: "update", diff: "-old\n+new" }]);
});
