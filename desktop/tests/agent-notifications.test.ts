import assert from "node:assert/strict";
import test from "node:test";
import { mergeNotifications, notificationBytes, notificationRequestMatches, notificationStatus, NOTIFICATION_MAX_BYTES, type AgentNotification } from "../src/lib/agent-notifications.ts";
function message(id: string, sequence: number, status: AgentNotification["status"] = "queued"): AgentNotification {
  return { id, sequence, status, fromSessionId: "source", toSessionId: "target", text: "Please review", createdAt: "2026-09-27T00:00:00Z", deliveredAt: null, acknowledgedAt: null, actorId: "person", actorName: "Person", direction: "outgoing" };
}
test("overlapping history pages deduplicate, sort, and preserve newer delivery evidence", () => {
  const accepted = { ...message("two", 2, "acknowledged"), acknowledgedAt: "2026-09-27T00:00:01Z" };
  const result = mergeNotifications([accepted, message("three", 3)], [message("two", 2), message("one", 1)]);
  assert.deepEqual(result.map(item => item.id), ["three", "two", "one"]);
  assert.equal(result[1].acknowledgedAt, accepted.acknowledgedAt);
  assert.equal(mergeNotifications(result, [message("three", 3, "delivered")])[0].status, "delivered");
});
test("ambiguous retries require the original normalized text and exact recipient", () => {
  const pending = { requestId: "stable-request", recipient: "peer-one", text: "Please review" };
  assert.equal(notificationRequestMatches(pending, " Please review \n", "peer-one"), true);
  assert.equal(notificationRequestMatches(pending, "Please review!", "peer-one"), false);
  assert.equal(notificationRequestMatches(pending, "Please review", "all"), false);
});
test("16KB limit counts UTF-8 bytes rather than characters", () => {
  assert.equal(notificationBytes("a".repeat(NOTIFICATION_MAX_BYTES)), NOTIFICATION_MAX_BYTES);
  assert.equal(notificationBytes("🙂".repeat(4097)) > NOTIFICATION_MAX_BYTES, true);
});
test("delivery statuses never imply completed model work", () => {
  assert.equal(notificationStatus("queued"), "Queued");
  assert.equal(notificationStatus("delivered"), "Delivery attempted");
  assert.equal(notificationStatus("acknowledged"), "Accepted by agent");
});
