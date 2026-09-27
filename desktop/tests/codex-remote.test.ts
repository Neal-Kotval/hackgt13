/**
 * Remote command construction (HAC-122): prompts and paths must reach Codex
 * byte-for-byte without shell interpretation. Runs the generated command
 * through a real local bash with a fake `codex` that prints its argv.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  ENSURE_FILE_STORE_COMMAND,
  PID_MARKER,
  buildRunCommand,
  buildStopCommand,
  countPatchFiles,
  shQuote,
} from "../electron/codex-remote.ts";

const dir = mkdtempSync(path.join(tmpdir(), "codex-remote-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// Fake codex: one argument per line, NUL-free, so we can compare exactly.
const fakeCodex = path.join(dir, "codex");
writeFileSync(
  fakeCodex,
  '#!/bin/sh\nfor a in "$@"; do printf "%s\\0" "$a"; done\n',
);
chmodSync(fakeCodex, 0o755);
const canary = path.join(dir, "pwned");

function runThroughBash(command: string, home = dir): { argv: string[]; stderr: string } {
  const result = execFileSync("bash", ["-c", command], {
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: home },
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const argv = result.toString("utf8").split("\0");
  argv.pop();
  return { argv, stderr: "" };
}

const HOSTILE = [
  "fix the bug",
  "it's got 'single' quotes",
  `$(touch ${canary}) and \`touch ${canary}\``,
  `"; touch ${canary}; echo "`,
  `'; touch ${canary}; '`,
  "multi\nline\n\tprompt with * globs ? [a-z] ~ $HOME ${HOME} \\ backslash",
  "-- --dangerously-bypass-approvals-and-sandbox",
  "emoji ✓ and ünïcode",
];

describe("shQuote and buildRunCommand", () => {
  for (const prompt of HOSTILE) {
    it(`passes the prompt literally: ${JSON.stringify(prompt).slice(0, 40)}`, () => {
      const workspace = "/home/agentcloud/work space/it's $HOME";
      const { argv } = runThroughBash(buildRunCommand(workspace, prompt));
      assert.deepEqual(argv, [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "danger-full-access",
        "-C",
        workspace,
        "--",
        prompt,
      ]);
      assert.throws(() => readFileSync(canary), "no injected command ran");
    });
  }

  it("falls back to $HOME when workspacePath is missing", () => {
    const { argv } = runThroughBash(buildRunCommand(null, "hi"), "/tmp/fake-home");
    assert.equal(argv[argv.indexOf("-C") + 1], "/tmp/fake-home");
  });

  it("prints a pid/pgid marker on stderr before exec", () => {
    const stderr = execFileSync("bash", ["-c", `${buildRunCommand(null, "hi")} 2>&1 >/dev/null`], {
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
      encoding: "utf8",
    });
    assert.match(stderr, PID_MARKER);
  });

  it("rejects NUL bytes", () => {
    assert.throws(() => shQuote("a\u0000b"), /NUL/);
  });
});

describe("stop and export helpers", () => {
  it("only accepts a sane process group", () => {
    assert.match(buildStopCommand(4242), /kill -TERM -- -4242/);
    for (const bad of [0, 1, -5, 1.5, Number.NaN, 10_000_000]) {
      assert.throws(() => buildStopCommand(bad));
    }
  });

  it("counts files in a patch", () => {
    assert.equal(
      countPatchFiles("# M a\ndiff --git a/a b/a\n+x\ndiff --git a/b b/b\n"),
      2,
    );
    assert.equal(countPatchFiles("# nothing\n"), 0);
  });
});

describe("ENSURE_FILE_STORE_COMMAND", () => {
  const run = (home: string) =>
    execFileSync("bash", ["-c", ENSURE_FILE_STORE_COMMAND], { env: { PATH: "/usr/bin:/bin", HOME: home } });

  it("creates config.toml with the file store", () => {
    const home = mkdtempSync(path.join(dir, "h1-"));
    run(home);
    assert.equal(
      readFileSync(path.join(home, ".codex/config.toml"), "utf8"),
      'cli_auth_credentials_store = "file"\n',
    );
  });

  it("prepends to an existing config and keeps its tables", () => {
    const home = mkdtempSync(path.join(dir, "h2-"));
    execFileSync("mkdir", ["-p", path.join(home, ".codex")]);
    writeFileSync(path.join(home, ".codex/config.toml"), 'model = "o3"\n[profiles.x]\nmodel = "y"\n');
    run(home);
    run(home);
    assert.equal(
      readFileSync(path.join(home, ".codex/config.toml"), "utf8"),
      'cli_auth_credentials_store = "file"\nmodel = "o3"\n[profiles.x]\nmodel = "y"\n',
    );
  });

  it("rewrites a keyring setting to file", () => {
    const home = mkdtempSync(path.join(dir, "h3-"));
    execFileSync("mkdir", ["-p", path.join(home, ".codex")]);
    writeFileSync(path.join(home, ".codex/config.toml"), 'cli_auth_credentials_store = "keyring"\nmodel = "o3"\n');
    run(home);
    assert.equal(
      readFileSync(path.join(home, ".codex/config.toml"), "utf8"),
      'cli_auth_credentials_store = "file"\nmodel = "o3"\n',
    );
  });
});
