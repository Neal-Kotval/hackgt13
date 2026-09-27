import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { getContainerTemplate, inspectContainerImage, listContainerTemplates,
  loadContainerArchive, registerContainerTemplate, retainContainerImage } from "../lib/container-templates.mjs";

const imageId = `sha256:${"a".repeat(64)}`;

test("template registration records an immutable image and rejects changed reuse", () => {
  const db = new Database(":memory:");
  try {
    const input = { id: "python-agent", label: "Python agent", imageRef: "example/agent@sha256:abc",
      imageId, source: "registry" };
    const first = registerContainerTemplate(db, input);
    assert.equal(first.image_id, imageId);
    assert.deepEqual(registerContainerTemplate(db, input), first);
    assert.deepEqual(listContainerTemplates(db), [first]);
    assert.equal(getContainerTemplate(db, "missing"), null);
    assert.throws(() => registerContainerTemplate(db, { ...input, imageId: `sha256:${"b".repeat(64)}` }),
      /already registered/);
  } finally { db.close(); }
});

test("template inputs reject unsafe IDs, references, and image identities", () => {
  const db = new Database(":memory:");
  try {
    const valid = { id: "node-agent", label: "Node agent", imageRef: "node:22", imageId, source: "archive" };
    assert.throws(() => registerContainerTemplate(db, { ...valid, id: "../escape" }), /Template ID/);
    assert.throws(() => registerContainerTemplate(db, { ...valid, imageRef: "node:22 --privileged" }), /image reference/);
    assert.throws(() => registerContainerTemplate(db, { ...valid, imageId: "node:22" }), /image ID/);
    assert.throws(() => registerContainerTemplate(db, { ...valid, source: "unknown" }), /source/);
  } finally { db.close(); }
});

test("Docker image import uses argument arrays and checks the immutable identity", async () => {
  const calls = [];
  const docker = async (args) => { calls.push(args); return args[0] === "load"
    ? "Loaded image: example/agent:1\n" : imageId; };
  assert.equal(await inspectContainerImage("example/agent:1", { docker }), imageId);
  assert.deepEqual(await loadContainerArchive("/tmp/image.tar", { docker }), new Set(["example/agent:1"]));
  assert.equal(await retainContainerImage("node-agent", imageId, { docker }), "agentcloud-template-node-agent:pinned");
  assert.deepEqual(calls, [
    ["image", "inspect", "--format", "{{.Id}}", "example/agent:1"],
    ["load", "--input", "/tmp/image.tar"],
    ["tag", imageId, "agentcloud-template-node-agent:pinned"],
  ]);
  await assert.rejects(() => loadContainerArchive("../image.tar", { docker }), /absolute/);
  await assert.rejects(() => inspectContainerImage("bad image", { docker }), /image reference/);
});

test("archive load reports only image references Docker actually loaded", async () => {
  const loaded = await loadContainerArchive("/tmp/image.tar", { docker: async () =>
    "Loading layer abc\nLoaded image: other/agent:1\nLoaded image ID: sha256:123\n" });
  assert.equal(loaded.has("example/agent:1"), false);
  assert.equal(loaded.has("other/agent:1"), true);
  assert.equal(loaded.has("sha256:123"), true);
});
