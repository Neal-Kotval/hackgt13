import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

const segment = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const gitTimeoutMs = 120_000;

export interface WorktreeInfo {
  agentId: string;
  branch: string;
  path: string;
  head: string;
  dirty: boolean;
}

export interface WorkspaceInfo {
  projectId: string;
  path: string;
  repoUrl: string;
  head: string;
  dirty: boolean;
  worktrees: WorktreeInfo[];
}

export interface ImportRepositoryInput {
  dataDir: string;
  projectId: string;
  repoUrl: string;
}

export interface CreateAgentWorktreeInput {
  dataDir: string;
  projectId: string;
  agentId: string;
}

export interface InspectWorkspaceInput {
  dataDir: string;
  projectId: string;
}

export class WorkspaceError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

function safeSegment(value: string, label: string): string {
  if (!segment.test(value))
    throw new WorkspaceError(`Invalid ${label}.`, "INVALID_ID");
  return value;
}

export function validateRepositoryUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WorkspaceError("Repository URL must be HTTPS.", "INVALID_REPO");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname ||
    url.pathname === "/"
  )
    throw new WorkspaceError(
      "Repository URL must be HTTPS without credentials, query, or fragment.",
      "INVALID_REPO",
    );
  return url.toString();
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function requireDirectory(target: string): Promise<string> {
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new WorkspaceError("Workspace path is not a directory.", "UNSAFE_PATH");
  return realpath(target);
}

function under(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_ASKPASS: process.platform === "win32" ? "" : "/bin/false",
      },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), gitTimeoutMs);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) child.kill("SIGKILL");
        else chunks.push(chunk);
      });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new WorkspaceError("Git could not be started.", "GIT_UNAVAILABLE"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8").trim());
      else reject(new WorkspaceError("Git operation failed. Check the repository and connection.", "GIT_FAILED"));
    });
  });
}

async function projectPaths(dataDir: string, projectId: string) {
  safeSegment(projectId, "project ID");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const base = await requireDirectory(dataDir);
  const root = path.join(base, "workspaces");
  if (!(await exists(root))) await mkdir(root, { mode: 0o700 });
  const realRoot = await requireDirectory(root);
  const project = path.join(realRoot, projectId);
  if (await exists(project)) {
    const realProject = await requireDirectory(project);
    if (!under(realRoot, realProject))
      throw new WorkspaceError("Workspace escaped data directory.", "UNSAFE_PATH");
  }
  return { root: realRoot, project, main: path.join(project, "main"), worktrees: path.join(project, "worktrees") };
}

async function inspectGitTree(target: string, expectedCommonDir?: string) {
  const real = await requireDirectory(target);
  const top = await git(["-C", real, "rev-parse", "--show-toplevel"]);
  if ((await realpath(top)) !== real)
    throw new WorkspaceError("Workspace path is not the Git root.", "UNSAFE_PATH");
  const common = await git(["-C", real, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const realCommon = await realpath(common);
  if (expectedCommonDir && realCommon !== expectedCommonDir)
    throw new WorkspaceError("Worktree belongs to another repository.", "UNSAFE_PATH");
  const head = await git(["-C", real, "rev-parse", "HEAD"]);
  const dirty = (await git(["-C", real, "status", "--porcelain=v1", "--untracked-files=normal"])) !== "";
  return { path: real, commonDir: realCommon, head, dirty };
}

export async function inspectWorkspace(input: InspectWorkspaceInput): Promise<WorkspaceInfo | null> {
  safeSegment(input.projectId, "project ID");
  if (!(await exists(input.dataDir))) return null;
  if (!(await exists(path.join(input.dataDir, "workspaces")))) return null;
  const paths = await projectPaths(input.dataDir, input.projectId);
  if (!(await exists(paths.main))) return null;
  const main = await inspectGitTree(paths.main);
  if (!under(paths.project, main.path) || !under(main.path, main.commonDir))
    throw new WorkspaceError("Main repository escaped workspace.", "UNSAFE_PATH");
  const repoUrl = await git(["-C", main.path, "config", "--get", "remote.origin.url"]);
  validateRepositoryUrl(repoUrl);
  const worktrees: WorktreeInfo[] = [];
  if (await exists(paths.worktrees)) {
    const realWorktrees = await requireDirectory(paths.worktrees);
    if (!under(paths.project, realWorktrees))
      throw new WorkspaceError("Worktree directory escaped workspace.", "UNSAFE_PATH");
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(realWorktrees, { withFileTypes: true })) {
      if (!entry.isDirectory() || !segment.test(entry.name))
        throw new WorkspaceError("Unexpected worktree entry.", "UNSAFE_PATH");
      const item = await inspectGitTree(path.join(realWorktrees, entry.name), main.commonDir);
      if (!under(realWorktrees, item.path))
        throw new WorkspaceError("Worktree escaped workspace.", "UNSAFE_PATH");
      const branch = await git(["-C", item.path, "symbolic-ref", "--short", "HEAD"]);
      if (branch !== `agent/${entry.name}`)
        throw new WorkspaceError("Worktree branch does not match agent.", "UNSAFE_PATH");
      worktrees.push({ agentId: entry.name, branch, path: item.path, head: item.head, dirty: item.dirty });
    }
  }
  return { projectId: input.projectId, path: main.path, repoUrl, head: main.head, dirty: main.dirty, worktrees };
}

export async function importRepository(input: ImportRepositoryInput): Promise<WorkspaceInfo> {
  const repoUrl = validateRepositoryUrl(input.repoUrl);
  const paths = await projectPaths(input.dataDir, input.projectId);
  if (await exists(paths.main)) {
    const current = await inspectWorkspace(input);
    if (current?.repoUrl !== repoUrl)
      throw new WorkspaceError("Project already has a different repository.", "REPO_CONFLICT");
    return current;
  }
  if (!(await exists(paths.project))) await mkdir(paths.project, { mode: 0o700 });
  const temporary = path.join(paths.project, `.clone-${randomUUID()}`);
  try {
    await git(["clone", "--quiet", "--", repoUrl, temporary]);
    const cloned = await inspectGitTree(temporary);
    if (!under(paths.project, cloned.path))
      throw new WorkspaceError("Clone escaped workspace.", "UNSAFE_PATH");
    if (await exists(paths.main))
      throw new WorkspaceError("Project repository was created concurrently.", "REPO_CONFLICT");
    await rename(temporary, paths.main);
    return (await inspectWorkspace(input))!;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function createAgentWorktree(input: CreateAgentWorktreeInput): Promise<WorktreeInfo> {
  safeSegment(input.agentId, "agent ID");
  const paths = await projectPaths(input.dataDir, input.projectId);
  const current = await inspectWorkspace(input);
  if (!current)
    throw new WorkspaceError("Import a repository before creating worktrees.", "NOT_IMPORTED");
  const existing = current.worktrees.find((item) => item.agentId === input.agentId);
  if (existing) return existing;
  if (!(await exists(paths.worktrees))) await mkdir(paths.worktrees, { mode: 0o700 });
  const target = path.join(paths.worktrees, input.agentId);
  if (await exists(target))
    throw new WorkspaceError("Agent worktree path already exists.", "WORKTREE_CONFLICT");
  const branch = `agent/${input.agentId}`;
  await git(["-C", current.path, "worktree", "add", "--quiet", "-b", branch, "--", target, "HEAD"]);
  const updated = await inspectWorkspace(input);
  const worktree = updated?.worktrees.find((item) => item.agentId === input.agentId);
  if (!worktree)
    throw new WorkspaceError("Git worktree was not verified.", "WORKTREE_FAILED");
  return worktree;
}
