import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const exec = promisify(execFile);
const temporary = await mkdtemp(path.join(os.tmpdir(), "agentcloud-workspace-test-"));
await writeFile(path.join(temporary, "package.json"), '{"type":"module"}');
const source = await readFile(new URL("../lib/workspace.ts", import.meta.url), "utf8");
await writeFile(
  path.join(temporary, "workspace.js"),
  ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText,
);
const { importRepository, createAgentWorktree, inspectWorkspace, validateRepositoryUrl } =
  await import(path.join(temporary, "workspace.js"));
after(() => rm(temporary, { recursive: true, force: true }));

test("repository URL and workspace IDs reject unsafe input", async () => {
  for (const url of [
    "git@github.com:team/repo.git",
    "http://github.com/team/repo.git",
    "https://user:secret@github.com/team/repo.git",
    "https://github.com/team/repo?token=secret",
    "https://github.com/team/repo#main",
    "https://github.com/",
  ]) assert.throws(() => validateRepositoryUrl(url), { code: "INVALID_REPO" });
  assert.equal(validateRepositoryUrl("https://github.com/team/repo.git"), "https://github.com/team/repo.git");
  await assert.rejects(
    inspectWorkspace({ dataDir: temporary, projectId: "../escape" }),
    { code: "INVALID_ID" },
  );
  await assert.rejects(
    createAgentWorktree({ dataDir: temporary, projectId: "one", agentId: "../../escape" }),
    { code: "INVALID_ID" },
  );
});

test("a real clone persists and separate agent worktrees are verified on disk", async () => {
  const sourceRepo = path.join(temporary, "source");
  const dataDir = path.join(temporary, "data");
  await mkdir(sourceRepo);
  await exec("git", ["init", "-b", "main", sourceRepo]);
  await writeFile(path.join(sourceRepo, "README.md"), "real repository\n");
  await exec("git", ["-C", sourceRepo, "add", "README.md"]);
  await exec("git", ["-C", sourceRepo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);

  // Git's process-local URL rewrite lets this test clone a real repository
  // without network access. The application still receives an HTTPS URL.
  const before = Object.fromEntries(
    ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"].map((key) => [key, process.env[key]]),
  );
  process.env.GIT_CONFIG_COUNT = "2";
  process.env.GIT_CONFIG_KEY_0 = `url.file://${sourceRepo}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://workspace-fixture.invalid/repo.git";
  process.env.GIT_CONFIG_KEY_1 = "protocol.file.allow";
  process.env.GIT_CONFIG_VALUE_1 = "always";
  try {
    const input = {
      dataDir,
      projectId: "project-1",
      repoUrl: "https://workspace-fixture.invalid/repo.git",
    };
    assert.equal(await inspectWorkspace(input), null);
    const imported = await importRepository(input);
    assert.equal(imported.repoUrl, input.repoUrl);
    assert.equal(imported.worktrees.length, 0);
    assert.equal(await readFile(path.join(imported.path, "README.md"), "utf8"), "real repository\n");
    assert.equal((await importRepository(input)).path, imported.path);
    await assert.rejects(
      importRepository({ ...input, repoUrl: "https://other.invalid/repo.git" }),
      { code: "REPO_CONFLICT" },
    );
    const first = await createAgentWorktree({ dataDir, projectId: "project-1", agentId: "codex" });
    const second = await createAgentWorktree({ dataDir, projectId: "project-1", agentId: "claude" });
    assert.notEqual(first.path, second.path);
    assert.equal(first.branch, "agent/codex");
    assert.equal(second.branch, "agent/claude");
    assert.equal(first.head, imported.head);
    assert.equal((await createAgentWorktree({ dataDir, projectId: "project-1", agentId: "codex" })).path, first.path);
    await writeFile(path.join(first.path, "api.ts"), "export const value = 1;\n");
    const inspected = await inspectWorkspace(input);
    assert.equal(inspected.worktrees.length, 2);
    assert.equal(inspected.worktrees.find((tree) => tree.agentId === "codex").dirty, true);
    assert.equal(inspected.worktrees.find((tree) => tree.agentId === "claude").dirty, false);
    assert.equal(inspected.dirty, false);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("an untrusted path cannot be treated as a project worktree", async () => {
  const dataDir = path.join(temporary, "unsafe-data");
  await mkdir(path.join(dataDir, "workspaces"), { recursive: true });
  await symlink(temporary, path.join(dataDir, "workspaces", "linked"));
  await assert.rejects(
    inspectWorkspace({ dataDir, projectId: "linked" }),
    { code: "UNSAFE_PATH" },
  );
});
