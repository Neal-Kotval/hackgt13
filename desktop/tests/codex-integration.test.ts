/**
 * Codex panel against a real sshd container (HAC-122). Skips when Docker is
 * unavailable (or AGENTCLOUD_SKIP_DOCKER_TESTS=1).
 *
 * The throwaway image has Node 22, OpenSSH, git and @openai/codex@0.157.1.
 * - status: the real Codex CLI reports "Not logged in".
 * - device auth: the real CLI prints a URL + code; we stop it and confirm the
 *   process is gone. A sign-in is never completed.
 * - run/stop: a FAKE `codex` placed first on PATH replays a JSONL fixture, so
 *   streaming and process-group kill are exercised without an OpenAI account.
 * - export: a patch of tracked + untracked changes that `git apply` accepts.
 * - local login copy: a fake auth file lands as 0600 via stdin.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { generateDeviceKey } from "../electron/device-key.ts";
import { CodexSessions } from "../electron/codex-session.ts";
import type { ExecTarget } from "../electron/codex-ssh.ts";
import type { CodexPanelEvent } from "../src/lib/codex-types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = "agentcloud-hac122-codex:test";
const DOCKERFILE = `FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server git procps ca-certificates \\
 && rm -rf /var/lib/apt/lists/* \\
 && npm install -g @openai/codex@0.157.1 \\
 && useradd -m -s /bin/bash agentcloud && usermod -p '*' agentcloud \\
 && mkdir -p /run/sshd /home/agentcloud/.ssh /opt/fake \\
 && chmod 700 /home/agentcloud/.ssh && chown agentcloud:agentcloud /home/agentcloud/.ssh
`;
const STARTUP = [
  'printf "%s\\n" "$PUBLIC_KEY" > /home/agentcloud/.ssh/authorized_keys',
  "chown agentcloud /home/agentcloud/.ssh/authorized_keys",
  "chmod 600 /home/agentcloud/.ssh/authorized_keys",
  "exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o PermitUserEnvironment=yes",
].join(" && ");

// Fake codex: records argv, replays the fixture, and for "hang" prompts keeps
// running with a child `sleep` so the process-group kill is observable.
const FAKE_CODEX = `#!/bin/bash
printf '%s\\0' "$@" > /tmp/agentcloud-fake-argv
prompt="\${@: -1}"
while IFS= read -r line; do printf '%s\\n' "$line"; sleep 0.05; done < /opt/fake/run.jsonl
if [[ "$prompt" == *hang* ]]; then
  sleep 300 &
  echo '{"type":"item.started","item":{"id":"item_9","type":"command_execution","command":"sleep 300","aggregated_output":"","exit_code":null,"status":"in_progress"}}'
  wait
fi
exit 0
`;

function dockerAvailable(): boolean {
  if (process.env.AGENTCLOUD_SKIP_DOCKER_TESTS === "1") return false;
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const docker = dockerAvailable();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor<T>(events: T[], predicate: (event: T) => boolean, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > ms) return reject(new Error("timed out waiting for event"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe("codex panel against a real sshd + codex container", { skip: !docker && "docker unavailable" }, () => {
  const key = generateDeviceKey();
  let containerId = "";
  let target: ExecTarget;
  const sh = (script: string, user = "agentcloud", input?: string) =>
    execFileSync("docker", ["exec", "-i", "-u", user, containerId, "bash", "-c", script], {
      encoding: "utf8",
      input,
    });

  const api = async (requestPath: string) => {
    if (requestPath.startsWith("/api/run-boxes?")) {
      return new Response(
        JSON.stringify({ jobs: [{ id: "rb-int", workspacePath: "/home/agentcloud/workspace/repo" }] }),
      );
    }
    return new Response("{}", { status: 404 }); // no agent-runs routes: "not recorded"
  };
  const sessions = () =>
    new CodexSessions({
      request: api,
      privateKey: () => key.privateKey,
      localAuthExists: () => true,
      readLocalAuth: async () => Buffer.from('{"fake":"integration-test-not-a-token"}'),
      resolveTarget: async () => target,
    });

  before(async () => {
    execFileSync("docker", ["build", "-q", "-t", IMAGE, "-"], {
      input: DOCKERFILE,
      stdio: ["pipe", "ignore", "inherit"],
      timeout: 600_000,
    });
    containerId = execFileSync(
      "docker",
      ["run", "-d", "--rm", "-p", "127.0.0.1::22", "-e", `PUBLIC_KEY=${key.publicKey}`, IMAGE, "sh", "-c", STARTUP],
      { encoding: "utf8" },
    ).trim();
    const mapping = execFileSync("docker", ["port", containerId, "22/tcp"], { encoding: "utf8" })
      .trim()
      .split("\n")[0];
    const hostPublicKey = execFileSync(
      "docker",
      ["exec", containerId, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"],
      { encoding: "utf8" },
    ).trim().split(/\s+/).slice(0, 2).join(" ");
    target = {
      host: "127.0.0.1",
      port: Number(mapping.split(":").pop()),
      username: "agentcloud",
      hostPublicKey,
      privateKey: key.privateKey,
    };
    sh(`cat > /opt/fake/codex && chmod 755 /opt/fake/codex`, "root", FAKE_CODEX);
    sh(`cat > /opt/fake/run.jsonl`, "root", readFileSync(path.join(here, "fixtures/codex/exec-success.jsonl"), "utf8"));
    sh(
      [
        "mkdir -p ~/workspace/repo && cd ~/workspace/repo",
        "git init -q && git config user.email t@example.com && git config user.name t",
        "printf 'hello\\n' > greet.txt && git add . && git commit -qm init",
      ].join(" && "),
    );
    await sleep(500);
  });

  after(() => {
    if (!containerId) return;
    try {
      execFileSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
    } catch {
      // already gone
    }
  });

  it("status reports signed out with the real Codex CLI", async () => {
    const status = await sessions().status("rb-int");
    assert.equal(status.signedIn, false);
    assert.equal(status.detail, "Not logged in");
  });

  it("device auth streams a URL and code, and stop kills it", async () => {
    const s = sessions();
    const events: CodexPanelEvent[] = [];
    const { sessionId } = await s.login(1, (event) => events.push(event), "rb-int");
    const code = (await waitFor(
      events,
      (event) => "type" in event && event.type === "device-code",
      30_000,
    )) as { url: string; code: string };
    assert.equal(code.url, "https://auth.openai.com/codex/device");
    assert.match(code.code, /^[A-Z0-9]{3,12}(-[A-Z0-9]{3,12})+$/);
    assert.match(sh("cat ~/.codex/config.toml"), /^cli_auth_credentials_store = "file"$/m);
    const stopped = await s.stop(1, sessionId);
    assert.deepEqual(stopped, { stopped: true, verified: true });
    await waitFor(events, (event) => "type" in event && event.type === "error", 10_000);
    assert.equal(sh("pgrep -u agentcloud -f '[c]odex login' || true").trim(), "");
    assert.equal(sh("test -e ~/.codex/auth.json && echo present || echo absent").trim(), "absent");
  });

  describe("with a fake codex first on PATH", () => {
    before(() => {
      sh("printf 'PATH=/opt/fake:/usr/local/bin:/usr/bin:/bin\\n' > ~/.ssh/environment && chmod 600 ~/.ssh/environment");
    });
    after(() => {
      sh("rm -f ~/.ssh/environment");
    });

    it("streams a completed run and passes the prompt literally", async () => {
      const prompt = `it's "$(touch /tmp/pwned)"; echo \`id\`\nline two`;
      const events: CodexPanelEvent[] = [];
      const start = await sessions().run(1, (event) => events.push(event), "rb-int", prompt, { projectId: "p1" });
      assert.equal(start.recorded, false);
      assert.equal(start.workspacePath, "/home/agentcloud/workspace/repo");
      const finished = (await waitFor(
        events,
        (event) => "type" in event && event.type === "run-finished",
        20_000,
      )) as { status: string; exitCode: number };
      assert.deepEqual([finished.status, finished.exitCode], ["succeeded", 0]);
      const kinds = events.filter((event) => "kind" in event).map((event) => (event as { kind: string }).kind);
      for (const kind of ["reasoning", "command.start", "command.exit", "file.change", "message"]) {
        assert.ok(kinds.includes(kind), `saw ${kind}`);
      }
      const argv = sh("tr '\\0' '\\n' < /tmp/agentcloud-fake-argv | tail -n +1").split("\n");
      assert.deepEqual(argv.slice(0, 9), [
        "exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "danger-full-access",
        "-C", "/home/agentcloud/workspace/repo", "--",
      ]);
      assert.equal(sh("tr '\\0' '\\n' < /tmp/agentcloud-fake-argv | tail -n 2 | head -c -1"), prompt.split("\n").join("\n"));
      assert.equal(sh("test -e /tmp/pwned && echo yes || echo no").trim(), "no");
    });

    it("stop kills the remote process group, including child commands", async () => {
      const s = sessions();
      const events: CodexPanelEvent[] = [];
      const start = await s.run(1, (event) => events.push(event), "rb-int", "please hang", { projectId: "p1" });
      await waitFor(
        events,
        (event) => "kind" in event && event.kind === "command.start" && event.command === "sleep 300",
        20_000,
      );
      assert.notEqual(sh("pgrep -u agentcloud -x sleep || true").trim(), "", "child is running before stop");
      const stopped = await s.stop(1, start.sessionId);
      assert.deepEqual(stopped, { stopped: true, verified: true });
      const finished = (await waitFor(
        events,
        (event) => "type" in event && event.type === "run-finished",
        10_000,
      )) as { status: string; stopVerified: boolean };
      assert.deepEqual([finished.status, finished.stopVerified], ["cancelled", true]);
      assert.equal(sh("pgrep -u agentcloud -f '/opt/fake/[c]odex' || true").trim(), "");
      assert.equal(sh("pgrep -u agentcloud -x sleep || true").trim(), "");
    });
  });

  it("export produces a patch that git apply accepts", async () => {
    sh("cd ~/workspace/repo && printf 'hello world\\n' > greet.txt && printf 'new\\n' > added.txt");
    const result = await sessions().exportPatch("rb-int", "p1");
    assert.equal(result.files, 2);
    assert.match(result.patch, /^# {1,2}M greet\.txt$/m);
    assert.match(result.patch, /^\+hello world$/m);
    assert.match(result.patch, /new file mode/);
    const check = sh(
      "rm -rf /tmp/clone && git clone -q ~/workspace/repo /tmp/clone && cd /tmp/clone && git apply --check - && echo APPLIES",
      "agentcloud",
      result.patch,
    );
    assert.match(check, /APPLIES/);
    sh("cd ~/workspace/repo && git checkout -q -- . && rm -f added.txt");
    const clean = await sessions().exportPatch("rb-int", "p1");
    assert.equal(clean.files, 0);
  });

  it("copies a local login file as 0600 without it appearing in the result", async () => {
    const status = await sessions().useLocalLogin("rb-int");
    assert.doesNotMatch(JSON.stringify(status), /integration-test-not-a-token/);
    assert.equal(sh("stat -c %a ~/.codex/auth.json").trim(), "600");
    assert.equal(sh("stat -c %a ~/.codex").trim(), "700");
    assert.equal(sh("cat ~/.codex/auth.json"), '{"fake":"integration-test-not-a-token"}');
    sh("rm -f ~/.codex/auth.json");
  });
});
