/**
 * Real sshd integration (HAC-90). Skips when Docker is unavailable.
 * Builds a throwaway alpine+openssh image, authorizes a freshly generated
 * device key, pins the container's actual ed25519 host key, runs `whoami`,
 * and asserts a wrong pinned key is refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { encodeOpenSshPublicKey, generateDeviceKey } from "../electron/device-key.ts";
import { HOST_KEY_MISMATCH_MESSAGE, openShell } from "../electron/ssh-terminal.ts";

const IMAGE = "agentcloud-hac90-sshd:test";
const DOCKERFILE = `FROM alpine:3.20
RUN apk add --no-cache openssh-server \\
 && ssh-keygen -A \\
 && adduser -D -s /bin/sh agentcloud \\
 && echo 'agentcloud:*' | chpasswd -e \\
 && mkdir -p /home/agentcloud/.ssh \\
 && chmod 700 /home/agentcloud/.ssh \\
 && chown agentcloud:agentcloud /home/agentcloud/.ssh
`;

const STARTUP = [
  'printf "%s\\n" "$PUBLIC_KEY" > /home/agentcloud/.ssh/authorized_keys',
  "chown agentcloud /home/agentcloud/.ssh/authorized_keys",
  "chmod 600 /home/agentcloud/.ssh/authorized_keys",
  "exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no",
].join(" && ");

function dockerAvailable(): boolean {
  if (process.env.AGENTCLOUD_SKIP_DOCKER_TESTS === "1") return false;
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

const docker = dockerAvailable();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ssh terminal against a real sshd container", { skip: !docker && "docker unavailable" }, () => {
  const key = generateDeviceKey();
  let containerId = "";
  let port = 0;
  let hostPublicKey = "";

  before(async () => {
    execFileSync("docker", ["build", "-q", "-t", IMAGE, "-"], {
      input: DOCKERFILE,
      stdio: ["pipe", "ignore", "inherit"],
      timeout: 300_000,
    });
    containerId = execFileSync(
      "docker",
      [
        "run", "-d", "--rm", "-p", "127.0.0.1::22", "-e", `PUBLIC_KEY=${key.publicKey}`, IMAGE,
        "sh", "-c", STARTUP,
      ],
      { encoding: "utf8" },
    ).trim();
    const mapping = execFileSync("docker", ["port", containerId, "22/tcp"], {
      encoding: "utf8",
    }).trim().split("\n")[0];
    port = Number(mapping.split(":").pop());
    hostPublicKey = execFileSync(
      "docker",
      ["exec", containerId, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"],
      { encoding: "utf8" },
    ).trim().split(/\s+/).slice(0, 2).join(" ");
    await sleep(500);
  });

  after(() => {
    if (containerId) {
      try {
        execFileSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
  });

  it("connects with the pinned host key and runs whoami", async () => {
    let output = "";
    let closedWith: { error?: string } | null = null;
    const session = await openShell(
      {
        host: "127.0.0.1",
        port,
        username: "agentcloud",
        hostPublicKey,
        privateKey: key.privateKey,
        cols: 80,
        rows: 24,
      },
      {
        onData: (text) => {
          output += text;
        },
        onClose: (info) => {
          closedWith = info;
        },
      },
    );
    session.write("echo AC_USER=$(whoami)\n");
    const deadline = Date.now() + 10_000;
    while (!/AC_USER=agentcloud/.test(output) && Date.now() < deadline) {
      await sleep(100);
    }
    assert.match(output, /AC_USER=agentcloud/);
    session.resize(100, 30);
    session.write("exit\n");
    const closeDeadline = Date.now() + 5_000;
    while (!closedWith && Date.now() < closeDeadline) await sleep(50);
    assert.deepEqual(closedWith, {});
  });

  it("rejects a wrong pinned host key", async () => {
    const wrong = encodeOpenSshPublicKey(Buffer.alloc(32, 9));
    await assert.rejects(
      openShell(
        {
          host: "127.0.0.1",
          port,
          username: "agentcloud",
          hostPublicKey: wrong,
          privateKey: key.privateKey,
          cols: 80,
          rows: 24,
        },
        { onData: () => {}, onClose: () => {} },
      ),
      (error: Error) => error.message === HOST_KEY_MISMATCH_MESSAGE,
    );
  });

  it("rejects an unauthorized device key", async () => {
    const stranger = generateDeviceKey();
    await assert.rejects(
      openShell(
        {
          host: "127.0.0.1",
          port,
          username: "agentcloud",
          hostPublicKey,
          privateKey: stranger.privateKey,
          cols: 80,
          rows: 24,
        },
        { onData: () => {}, onClose: () => {} },
      ),
      /authentication/i,
    );
  });
});
