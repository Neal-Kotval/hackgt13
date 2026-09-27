import path from "node:path";

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

function checkedInputs(workspacePath, agentId) {
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId))
    throw new Error("Invalid agent ID.");
  if (typeof workspacePath !== "string" || workspacePath.length > 512 ||
      !path.posix.isAbsolute(workspacePath) || workspacePath === "/" ||
      workspacePath.split("/").some((part, index) => index > 0 && (part === "" || part === "." || part === "..")) ||
      /[\0-\x1f\x7f]/.test(workspacePath) || path.posix.normalize(workspacePath) !== workspacePath)
    throw new Error("Invalid remote workspace path.");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The agent tree is a sibling of the checked-out repository on the run box. */
export function agentWorktreePath(workspacePath, agentId) {
  checkedInputs(workspacePath, agentId);
  return path.posix.join(path.posix.dirname(workspacePath), "worktrees", agentId);
}

/**
 * Prefix for a remote POSIX shell command. Append `exec codex app-server` (or
 * another command); the trailing `&&` leaves the shell in the verified tree.
 * Existing trees are never reset, pruned, or silently switched to a branch.
 */
export function remoteAgentWorktreeCommand(workspacePath, agentId) {
  const target = agentWorktreePath(workspacePath, agentId);
  const trees = path.posix.dirname(target);
  const branch = `agent/${agentId}`;
  return `set -eu
workspace=${shellQuote(workspacePath)}
trees=${shellQuote(trees)}
target=${shellQuote(target)}
branch=${shellQuote(branch)}
test -d "$workspace" && test ! -L "$workspace" || { echo 'Workspace is missing or unsafe.' >&2; exit 1; }
workspace_root=$(cd -P "$workspace" && pwd -P)
git_root=$(git -C "$workspace" rev-parse --show-toplevel)
test "$workspace_root" = "$git_root" || { echo 'Workspace is not a Git root.' >&2; exit 1; }
common=$(git -C "$workspace" rev-parse --path-format=absolute --git-common-dir)
common=$(cd -P "$common" && pwd -P)
if test -e "$trees" || test -L "$trees"; then
  test -d "$trees" && test ! -L "$trees" || { echo 'Worktree parent is unsafe.' >&2; exit 1; }
else
  mkdir "$trees"
fi
if test -e "$target" || test -L "$target"; then
  test -d "$target" && test ! -L "$target" || { echo 'Agent worktree path is unsafe.' >&2; exit 1; }
else
  git -C "$workspace" worktree add --quiet -b "$branch" -- "$target" HEAD
fi
target_root=$(cd -P "$target" && pwd -P)
test "$target_root" = "$target" || { echo 'Agent worktree escaped its path.' >&2; exit 1; }
tree_root=$(git -C "$target" rev-parse --show-toplevel)
test "$tree_root" = "$target" || { echo 'Agent worktree is not a Git root.' >&2; exit 1; }
tree_common=$(git -C "$target" rev-parse --path-format=absolute --git-common-dir)
tree_common=$(cd -P "$tree_common" && pwd -P)
test "$tree_common" = "$common" || { echo 'Agent worktree belongs to another repository.' >&2; exit 1; }
tree_branch=$(git -C "$target" symbolic-ref --quiet --short HEAD)
test "$tree_branch" = "$branch" || { echo 'Agent worktree is on the wrong branch.' >&2; exit 1; }
cd "$target" && `;
}
