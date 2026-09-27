import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentWorktreePath, remoteAgentWorktreeCommand } from "../lib/codex-agent-worktree.mjs";

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function fixture(t, name = "agentcloud-worktree-") {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), name)));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "AgentCloud Test");
  git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(path.join(repo, "README.md"), "first commit\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "first commit");
  return { base, repo };
}

function run(repo, agentId) {
  return spawnSync("sh", ["-c", `${remoteAgentWorktreeCommand(repo, agentId)} pwd -P`], { encoding: "utf8" });
}

test("creates distinct agent worktrees and resumes each without changing the source", (t) => {
  const { repo } = fixture(t);
  const sourceBranch = git(repo, "symbolic-ref", "--short", "HEAD");
  const sourceHead = git(repo, "rev-parse", "HEAD");
  for (const agentId of ["codex", "claude", "codex"]) {
    const result = run(repo, agentId);
    assert.equal(result.status, 0, result.stderr);
    const target = agentWorktreePath(repo, agentId);
    assert.equal(result.stdout.trim(), target);
    assert.equal(git(target, "symbolic-ref", "--short", "HEAD"), `agent/${agentId}`);
    assert.equal(git(target, "rev-parse", "HEAD"), sourceHead);
  }
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), sourceBranch);
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("quotes shell metacharacters in a workspace path", (t) => {
  const { repo } = fixture(t, "agentcloud-'$(false)'-");
  const result = run(repo, "agent_1");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), agentWorktreePath(repo, "agent_1"));
});

test("rejects an existing tree on the wrong branch", (t) => {
  const { repo } = fixture(t);
  assert.equal(run(repo, "codex").status, 0);
  const target = agentWorktreePath(repo, "codex");
  git(target, "branch", "wrong");
  git(target, "switch", "-q", "wrong");
  const result = run(repo, "codex");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /wrong branch/);
  assert.equal(git(target, "symbolic-ref", "--short", "HEAD"), "wrong");
});

test("rejects an unrelated repository and a symlink at the agent path", (t) => {
  const { base, repo } = fixture(t);
  const other = path.join(base, "other");
  mkdirSync(other);
  git(other, "init", "-q");
  const trees = path.dirname(agentWorktreePath(repo, "codex"));
  mkdirSync(trees);
  symlinkSync(other, agentWorktreePath(repo, "codex"));
  assert.notEqual(run(repo, "codex").status, 0);
  rmSync(agentWorktreePath(repo, "codex"));
  mkdirSync(agentWorktreePath(repo, "codex"));
  git(agentWorktreePath(repo, "codex"), "init", "-q");
  assert.notEqual(run(repo, "codex").status, 0);
});

test("rejects non-root workspaces and unsafe IDs or paths", (t) => {
  const { repo } = fixture(t);
  assert.notEqual(run(path.dirname(repo), "codex").status, 0);
  const subdir = path.join(repo, "subdir");
  mkdirSync(subdir);
  assert.notEqual(run(subdir, "codex").status, 0);
  for (const bad of ["", "../x", "a/b", ".hidden", "a; echo bad", "a\nnext", "x".repeat(81)]) {
    assert.throws(() => agentWorktreePath(repo, bad), /Invalid agent ID/);
  }
  for (const bad of ["relative/repo", "/", "/tmp/../repo", "/tmp//repo", "/tmp/./repo", "/tmp/repo\nnext", "/tmp/repo/"]) {
    assert.throws(() => remoteAgentWorktreeCommand(bad, "codex"), /Invalid remote workspace path/);
  }
});
