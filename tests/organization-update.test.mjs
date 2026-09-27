import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareAuth } from "./auth-fixture.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-org-update-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, "data");
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
const fixture = await prepareAuth(directory);
after(async () => {
  fixture.getDatabase().close();
  await rm(directory, { recursive: true, force: true });
});

async function update(data) {
  return fixture.getAuth().handler(new Request("http://localhost:3000/api/auth/organization/update", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie: fixture.users[0].cookie },
    body: JSON.stringify({ organizationId: fixture.organization.id, data }),
  }));
}

test("organization updates enforce create-time name and URL slug rules", async () => {
  const original = fixture.getDatabase().prepare("SELECT name, slug FROM organization WHERE id = ?").get(fixture.organization.id);
  for (const data of [
    { slug: "../../admin" },
    { slug: "has spaces" },
    { slug: "Uppercase" },
    { slug: "x".repeat(81) },
    { name: "x".repeat(101) },
    { name: "   " },
  ]) {
    const response = await update(data);
    assert.equal(response.status, 400, JSON.stringify(data));
    assert.deepEqual(fixture.getDatabase().prepare("SELECT name, slug FROM organization WHERE id = ?").get(fixture.organization.id), original);
  }
  const valid = await update({ name: "Updated team", slug: "updated-team" });
  assert.equal(valid.status, 200);
  assert.deepEqual(fixture.getDatabase().prepare("SELECT name, slug FROM organization WHERE id = ?").get(fixture.organization.id), { name: "Updated team", slug: "updated-team" });
});
