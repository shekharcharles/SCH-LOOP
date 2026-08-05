// The disposable per-task worktree.
//
// A worker gets its own checkout on its own branch, so the operator's working
// tree is not reachable from the process that edits code. This is CONTAINMENT OF
// BLAST RADIUS, not a sandbox: a worker can still write elsewhere on disk, still
// make network calls, and still spawn a process that outlives the run. Nothing
// here claims otherwise.
//
// One worktree per TASK, not per attempt: a retry must inherit the previous
// attempt's uncommitted work, and the scheduler already promises that.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { git, repositoryRoot, contains } from "./workspace.mjs";
import { assertSafeGitArgs } from "./candidate.mjs";

export const SCHEMA_VERSION = 1;
export const BRANCH_PREFIX = "sch/task-";
export const DEFAULT_NAMESPACE = "sch/task-*";

const gt = (cwd, ...a) => (git(cwd, ...a) ?? "").trim();

// The only git calls that mutate the repository or its worktree list. Guarded
// on every call, same as candidate.mjs's own mutating calls — a worker's retry
// creating a worktree is exactly the kind of repository mutation that module
// exists to keep honest.
const gitGuarded = (cwd, ...args) => { assertSafeGitArgs(args); return git(cwd, ...args); };

// Outside the repository AND outside SCH_HOME. A worker that walks up must not
// land in the operational state that grades it.
export function worktreesRoot(env = process.env) {
  if (env.SCH_WORKTREE_ROOT && isAbsolute(env.SCH_WORKTREE_ROOT)) return resolve(env.SCH_WORKTREE_ROOT);
  if (process.platform === "win32")
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "sch-loop", "worktrees");
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "sch-loop", "worktrees");
}

const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);

export function worktreePathFor(projectId, taskId, { root = worktreesRoot() } = {}) {
  return join(resolve(root), slug(projectId), `task-${slug(taskId)}`);
}

export function branchNameFor(taskId) {
  return `${BRANCH_PREFIX}${taskId}`;
}

// Pure: takes the authorization record, not a project id. Delivery and state
// both need this, and neither should have to import the other to get it.
export function branchMatchesNamespace(ns, branch) {
  if (!ns || !ns.pattern) return false;
  const b = String(branch ?? "");
  // A ref name is not a path. Anything readable as traversal, a wildcard, or a
  // second ref is refused before the pattern is consulted.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b) || b.includes("..") || b.endsWith("/") || b.endsWith(".lock")) return false;
  const rx = new RegExp("^" + ns.pattern.split("*").map((s) => s.replace(/[.+^${}()|[\]\\?]/g, "\\$&")).join("[^/]*") + "$");
  return rx.test(b);
}

export function worktreeState({ projectId, taskId, repoRoot, root = worktreesRoot() }) {
  const path = worktreePathFor(projectId, taskId, { root });
  const branch = branchNameFor(taskId);
  if (!existsSync(path)) return { exists: false, path, branch, head: null, matchesBranch: false };
  const top = repositoryRoot(path);
  if (!top) return { exists: true, path, branch, head: null, matchesBranch: false, notARepo: true };
  const actual = gt(path, "rev-parse", "--abbrev-ref", "HEAD");
  return {
    exists: true, path, branch, head: gt(path, "rev-parse", "HEAD") || null,
    actualBranch: actual || null, matchesBranch: actual === branch,
  };
}

// Create it, or adopt the one that is already there. Never recreate: an existing
// worktree may hold a previous attempt's unapproved work, and throwing that away
// to manufacture a clean tree is exactly what SCH refuses to do.
export function ensureWorktree({ projectId, taskId, repoRoot, base, root = worktreesRoot() }) {
  const path = worktreePathFor(projectId, taskId, { root });
  const branch = branchNameFor(taskId);

  if (contains(repoRoot, path))
    return { ok: false, code: "WORKTREE_CREATE_FAILED",
      message: `the worktree root resolves inside the managed repository (${path}) — worker scratch space must not live in the repository it edits` };

  const state = worktreeState({ projectId, taskId, repoRoot, root });
  if (state.exists) {
    if (state.notARepo)
      return { ok: false, code: "WORKTREE_NOT_A_WORKTREE",
        message: `${path} exists but is not a git worktree — SCH will not delete it, resolve it yourself` };
    if (!state.matchesBranch)
      return { ok: false, code: "WORKTREE_BRANCH_MISMATCH",
        message: `${path} is on "${state.actualBranch}" but this task's branch is "${branch}" — nothing was reset` };
    return { ok: true, path, branch, created: false };
  }

  mkdirSync(resolve(root), { recursive: true });
  const existingBranch = gt(repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  const args = existingBranch
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", path, "-b", branch, base];
  const out = gitGuarded(repoRoot, ...args);
  if (out === null || !existsSync(path))
    return { ok: false, code: "WORKTREE_CREATE_FAILED", message: `git ${args.join(" ")} did not produce a worktree at ${path}` };

  return { ok: true, path, branch, created: true };
}

// Remove the CHECKOUT. The branch survives: it is the record of what was built,
// and after delivery it is what was pushed.
export function removeWorktree({ projectId, taskId, repoRoot, root = worktreesRoot() }) {
  const path = worktreePathFor(projectId, taskId, { root });
  if (!existsSync(path)) return { ok: true, removed: false };
  const out = gitGuarded(repoRoot, "worktree", "remove", "--force", path);
  if (out === null) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* reported below */ }
    gitGuarded(repoRoot, "worktree", "prune");
  }
  return { ok: !existsSync(path), removed: !existsSync(path), path };
}
