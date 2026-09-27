/**
 * Remote command construction for the Codex panel (HAC-122). Pure, testable.
 *
 * sshd runs an exec request through the account's login shell (`bash -c`).
 * Every value that is not a constant (prompt, workspace path) goes through
 * `shQuote`, which wraps it in single quotes and rewrites embedded single
 * quotes as '\''. Inside single quotes the shell performs no expansion at all,
 * so `$(…)`, backticks, `;`, newlines and globbing in a prompt stay literal.
 * Values are then passed to a fixed `sh -c` script as positional parameters
 * ("$1", "$2"), never spliced into the script text.
 */

const NUL = /\u0000/;

export function shQuote(value: string): string {
  if (NUL.test(value)) throw new Error("Value contains a NUL byte and cannot be sent.");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const CODEX_EXEC_ARGS = [
  "exec",
  "--json",
  "--ephemeral",
  "--skip-git-repo-check",
  "-s",
  "danger-full-access",
] as const;

/** Stderr marker line carrying the remote pid and process group. */
export const PID_MARKER = /^AGENTCLOUD_PID=(\d+) AGENTCLOUD_PGID=(\d+)$/m;

/**
 * Prints the pid/process group, then `exec`s so the printed pid *is* the
 * Codex process. sshd starts exec sessions with setsid(), so the group
 * contains Codex and every command it spawns. stdin is /dev/null because
 * `codex exec` appends piped stdin to the prompt.
 */
const PREAMBLE =
  'read -r _ _ _ _ pgid _ < /proc/$$/stat 2>/dev/null || pgid=$$; ' +
  'printf "AGENTCLOUD_PID=%s AGENTCLOUD_PGID=%s\\n" "$$" "$pgid" >&2; ';

const RUN_SCRIPT =
  'ws="${1:-$HOME}"; ' +
  PREAMBLE +
  `exec codex ${CODEX_EXEC_ARGS.join(" ")} -C "$ws" -- "$2" </dev/null`;

/**
 * `codex exec --json --ephemeral --skip-git-repo-check -s danger-full-access
 *  -C <workspacePath> -- <prompt>` (contract). An empty workspacePath falls
 * back to the account home directory.
 */
export function buildRunCommand(workspacePath: string | null, prompt: string): string {
  return `exec sh -c ${shQuote(RUN_SCRIPT)} agentcloud-codex ${shQuote(
    workspacePath ?? "",
  )} ${shQuote(prompt)}`;
}

export const STATUS_COMMAND = "codex login status </dev/null 2>&1";

const LOGIN_SCRIPT = PREAMBLE + "exec codex login --device-auth </dev/null";
export const LOGIN_COMMAND = `exec sh -c ${shQuote(LOGIN_SCRIPT)} agentcloud-codex-login`;

/**
 * Make Codex store credentials in `~/.codex/auth.json` (not an OS keyring) so
 * the Stage 2 teardown cleanup removes them. Idempotent: rewrites an existing
 * top-level `cli_auth_credentials_store` line, otherwise prepends one (keys
 * before the first [table] header are top-level TOML keys).
 */
export const ENSURE_FILE_STORE_COMMAND = [
  'umask 077',
  'mkdir -p "$HOME/.codex"',
  'f="$HOME/.codex/config.toml"',
  't="$f.agentcloud-tmp"',
  'touch "$f"',
  "if grep -Eq '^[[:space:]]*cli_auth_credentials_store[[:space:]]*=' \"$f\"; then " +
    "sed -E 's/^[[:space:]]*cli_auth_credentials_store[[:space:]]*=.*/cli_auth_credentials_store = \"file\"/' \"$f\" > \"$t\"; " +
    "else { printf '%s\\n' 'cli_auth_credentials_store = \"file\"'; cat \"$f\"; } > \"$t\"; fi",
  'mv -f "$t" "$f"',
].join(" && ");

/**
 * Write the Codex auth file from stdin with owner-only permissions. The file
 * content arrives on the channel's stdin; it never appears in a command line.
 */
export const INSTALL_AUTH_COMMAND =
  'umask 077 && mkdir -p "$HOME/.codex" && chmod 700 "$HOME/.codex" && ' +
  'cat > "$HOME/.codex/auth.json.agentcloud-tmp" && ' +
  'chmod 600 "$HOME/.codex/auth.json.agentcloud-tmp" && ' +
  'mv -f "$HOME/.codex/auth.json.agentcloud-tmp" "$HOME/.codex/auth.json"';

export function assertPgid(value: number): number {
  if (!Number.isInteger(value) || value <= 1 || value > 4_194_304) {
    throw new Error("Invalid remote process group.");
  }
  return value;
}

/**
 * TERM the whole process group, wait up to ~5 s, then KILL, and report whether
 * anything in the group is still alive. Prints GONE or ALIVE.
 */
export function buildStopCommand(pgid: number): string {
  const group = `-${assertPgid(pgid)}`;
  return [
    `kill -TERM -- ${group} 2>/dev/null`,
    `i=0; while [ $i -lt 20 ] && kill -0 -- ${group} 2>/dev/null; do sleep 0.25; i=$((i+1)); done`,
    `if kill -0 -- ${group} 2>/dev/null; then kill -KILL -- ${group} 2>/dev/null; sleep 0.5; fi`,
    `if kill -0 -- ${group} 2>/dev/null; then echo ALIVE; else echo GONE; fi`,
  ].join("; ");
}

/**
 * Patch export: `git status --short` as leading `#` comments (ignored by
 * `git apply`), tracked changes against HEAD, then untracked files as new-file
 * diffs. Nothing in the workspace or index is modified.
 */
const EXPORT_SCRIPT = [
  'ws="${1:-$HOME}"',
  'cd -- "$ws" || { echo "AGENTCLOUD_EXPORT_ERROR=workspace" >&2; exit 3; }',
  'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "AGENTCLOUD_EXPORT_ERROR=not-git" >&2; exit 4; }',
  'git status --short --untracked-files=all | sed "s/^/# /"',
  'if git rev-parse --verify -q HEAD >/dev/null; then git diff --binary HEAD; else git diff --binary; git diff --binary --cached; fi',
  "git ls-files --others --exclude-standard -z | while IFS= read -r -d '' f; do git diff --binary --no-index -- /dev/null \"$f\"; done",
  "exit 0",
].join("; ");

export function buildExportCommand(workspacePath: string | null): string {
  return `exec bash -c ${shQuote(EXPORT_SCRIPT)} agentcloud-export ${shQuote(workspacePath ?? "")}`;
}

/** Count files in an exported patch (diff headers). */
export function countPatchFiles(patch: string): number {
  return (patch.match(/^diff --git /gm) ?? []).length;
}
