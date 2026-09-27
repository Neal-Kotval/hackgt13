import assert from "node:assert/strict";
import test from "node:test";
import { groupChatHistory } from "../src/lib/chat-history.ts";

const thread = (id: string, updatedAt?: string) => ({ id, title: id, updatedAt, status: "ready" });

test("groups by local calendar boundaries and preserves the source order", () => {
  const now = new Date(2026, 8, 26, 12);
  const stamp = (day: number, hour = 0) => new Date(2026, 8, day, hour).toISOString();
  const threads = [thread("old", stamp(18, 23)), thread("yesterday", stamp(25)), thread("last week", stamp(19)), thread("earlier today", stamp(26)), thread("today", stamp(26, 11)), thread("unknown"), thread("invalid", "bad-date")];
  assert.deepEqual(groupChatHistory(threads, "", now).map(({ label, threads }) => [label, threads.map(({ id }) => id)]), [
    ["Today", ["today", "earlier today"]],
    ["Yesterday", ["yesterday"]],
    ["Previous 7 days", ["last week"]],
    ["Older", ["old", "unknown", "invalid"]],
  ]);
  assert.equal(threads[0].id, "old");
});

test("search is a case-insensitive substring match and hides empty groups", () => {
  const threads = [thread("Project ALTO"), thread("Another project")];
  assert.deepEqual(groupChatHistory(threads, "alto").map(({ threads }) => threads.map(({ id }) => id)), [["Project ALTO"]]);
  assert.deepEqual(groupChatHistory(threads, "missing"), []);
});

test("yesterday uses calendar dates across daylight saving changes", () => {
  const original = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    for (const [month, day] of [[2, 9], [10, 2]]) {
      const now = new Date(2026, month, day, 12);
      const yesterday = new Date(2026, month, day - 1, 0, 15);
      const groups = groupChatHistory([thread("prior day", yesterday.toISOString())], "", now);
      assert.equal(groups[0].label, "Yesterday");
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("creator groups are stable, viewer first, and preserve date subdivisions", async () => {
  const { groupChatHistoryByCreator } = await import("../src/lib/chat-history.ts");
  const now = new Date(2026, 8, 26, 12);
  const source = [
    { ...thread("other"), createdBy: "other", createdByName: "Alex" },
    { ...thread("mine", now.toISOString()), createdBy: "viewer", createdByName: "Zoe" },
    { ...thread("older"), createdBy: "viewer", createdByName: "Zoe" },
  ];
  const groups = groupChatHistoryByCreator(source, "", "viewer", now);
  assert.deepEqual(groups.map(group => group.label), ["You · Zoe", "Alex"]);
  assert.deepEqual(groups[0].groups.map(group => group.label), ["Today", "Older"]);
  assert.equal(groups[0].count, 2);
  assert.equal(source[0].id, "other");
});

test("duplicate names and missing names never combine different creators", async () => {
  const { groupChatHistoryByCreator } = await import("../src/lib/chat-history.ts");
  const groups = groupChatHistoryByCreator([
    { ...thread("a"), createdBy: "12345678-one", createdByName: "Alex" },
    { ...thread("b"), createdBy: "12345678-two", createdByName: "Alex" },
    { ...thread("c"), createdBy: "deleted", createdByName: null },
    thread("legacy"),
  ], "");
  assert.equal(groups.length, 4);
  assert.equal(new Set(groups.map(group => group.label)).size, 4);
  assert.ok(groups.some(group => group.label === "Member · deleted"));
  assert.ok(groups.some(group => group.label === "Unknown creator"));
});

test("search matches creator, agent and title across owner sections", async () => {
  const { groupChatHistoryByCreator } = await import("../src/lib/chat-history.ts");
  const threads = [
    { ...thread("Fix login"), createdBy: "a", createdByName: "Alex", agentName: "Reviewer" },
    { ...thread("Build docs"), createdBy: "a", createdByName: "Alex", agentName: "Coder" },
    { ...thread("Review auth"), createdBy: "b", createdByName: "Blake", agentName: "Reviewer" },
  ];
  assert.equal(groupChatHistoryByCreator(threads, " ALEX ")[0].count, 2);
  assert.equal(groupChatHistoryByCreator(threads, "reviewer").length, 2);
  assert.equal(groupChatHistoryByCreator(threads, "login")[0].count, 1);
  assert.deepEqual(groupChatHistoryByCreator(threads, "missing"), []);
});
