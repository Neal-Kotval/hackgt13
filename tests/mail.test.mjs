import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mailDeliveryStatus, mailMode, sendAuthMail } from "../lib/mail.mjs";

test("public deployments report unavailable local mail without enabling secret capture", async (t) => {
  const keys = ["BETTER_AUTH_URL", "AGENTCLOUD_MAIL_MODE", "AGENTCLOUD_DATA_DIR", "SMTP_HOST", "SMTP_FROM", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-mail-status-"));
  t.after(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  for (const key of keys) delete process.env[key];
  process.env.AGENTCLOUD_DATA_DIR = directory;
  process.env.BETTER_AUTH_URL = "https://shared.example.test";
  process.env.AGENTCLOUD_MAIL_MODE = "local";
  assert.equal(mailDeliveryStatus(), "unavailable");
  assert.throws(mailMode, /loopback/);
  await assert.rejects(sendAuthMail({ to: "employee@example.test", subject: "Verify", text: "private-verification-token" }), /loopback/);
  assert.deepEqual(await readdir(directory), []);

  process.env.BETTER_AUTH_URL = "http://127.0.0.1:3000";
  assert.equal(mailDeliveryStatus(), "local");
  process.env.AGENTCLOUD_MAIL_MODE = "smtp";
  assert.equal(mailDeliveryStatus(), "unavailable");
  process.env.SMTP_HOST = "mail.example.test";
  process.env.SMTP_FROM = "AgentCloud <hello@example.test>";
  assert.equal(mailDeliveryStatus(), "smtp");
  process.env.SMTP_USER = "mailer";
  assert.equal(mailDeliveryStatus(), "unavailable");
  process.env.SMTP_PASSWORD = "test-only-password";
  assert.equal(mailDeliveryStatus(), "smtp");
  process.env.SMTP_PORT = "invalid";
  assert.equal(mailDeliveryStatus(), "unavailable");
  process.env.SMTP_PORT = "65536";
  assert.equal(mailDeliveryStatus(), "unavailable");
  process.env.SMTP_PORT = "465";
  assert.equal(mailDeliveryStatus(), "smtp");
  process.env.BETTER_AUTH_URL = "https://shared.example.test";
  assert.equal(mailDeliveryStatus(), "smtp");
  process.env.AGENTCLOUD_MAIL_MODE = "unknown";
  assert.equal(mailDeliveryStatus(), "unavailable");
});
