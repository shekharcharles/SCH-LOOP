// One git worktree per ticket at <repo>/.worktrees/<id>, branch sch/<id>-<slug>. The project may be a
// subfolder of the repo (the lab is), so the executor's cwd is <worktree>/<project-relative-path>.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
// git announces CONFLICT on STDOUT and the reason on stderr. A merge failure reported from stderr
// alone looks like a mystery exit code, so both streams are kept.
const tryGit = (cwd, ...args) => {
  try {
    return { ok: true, out: git(cwd, ...args) };
  } catch (e) {
    const parts = [String(e.stdout || ""), String(e.stderr || "")].filter(Boolean);
    return { ok: false, out: (parts.length ? parts.join("\n") : String(e.message)).trim() };
  }
};

export function repoRoot(dir) { return git(dir, "rev-parse", "--show-toplevel"); }

// The commit this ticket branch forked from. Evidence is diffed against it, so work the executor
// COMMITTED (which TDD requires) counts as a change instead of vanishing.
function mergeBase(root, wt, branch) {
  const main = tryGit(root, "rev-parse", "--abbrev-ref", "HEAD");
  const mb = main.ok ? tryGit(wt, "merge-base", branch, main.out) : { ok: false };
  return mb.ok && mb.out ? mb.out : (tryGit(wt, "rev-parse", "HEAD").out || "HEAD");
}
export const branchFor = (id, slug) => `sch/${id}${slug ? "-" + slug : ""}`;

export function ensureTicketWorktree({ projectRoot, id, slug, base = "HEAD" }) {
  const root = repoRoot(projectRoot);
  const rel = path.relative(root, path.resolve(projectRoot)).replace(/\\/g, "/");
  const wt = path.join(root, ".worktrees", id);
  const branch = branchFor(id, slug);
  if (fs.existsSync(wt)) {
    const actual = tryGit(wt, "rev-parse", "--abbrev-ref", "HEAD");
    if (!actual.ok || actual.out !== branch) throw new Error(`${wt} exists on "${actual.out}", expected ${branch}; nothing reset`);
    return { path: wt, cwd: rel ? path.join(wt, rel) : wt, branch, created: false, repoRoot: root, rel, base: mergeBase(root, wt, branch) };
  }
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const exists = tryGit(root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).ok;
  const r = exists ? tryGit(root, "worktree", "add", wt, branch) : tryGit(root, "worktree", "add", wt, "-b", branch, base);
  if (!r.ok || !fs.existsSync(wt)) throw new Error(`git worktree add failed: ${r.out.split("\n")[0]}`);
  const cwd = rel ? path.join(wt, rel) : wt;
  // A worktree is built from a git ref, so an uncommitted project directory simply is not in it. Say
  // that plainly here; downstream it surfaces as a baffling "not a git worktree" fence failure.
  if (!fs.existsSync(cwd)) {
    tryGit(root, "worktree", "remove", "--force", wt);
    throw new Error(`the project directory "${rel}" does not exist in a worktree of ${base} — it is not committed yet. Commit it (or run the loop from a committed project) before dispatching tickets.`);
  }
  return { path: wt, cwd, branch, created: true, repoRoot: root, rel, base: mergeBase(root, wt, branch) };
}

export function removeTicketWorktree({ projectRoot, id, deleteBranch = false, slug }) {
  const root = repoRoot(projectRoot);
  const wt = path.join(root, ".worktrees", id);
  const r = tryGit(root, "worktree", "remove", "--force", wt);
  if (deleteBranch) tryGit(root, "branch", "-D", branchFor(id, slug));
  return r.ok;
}

// Fail-closed merge of the ticket branch into the branch the main checkout is on.
export function mergeTicket({ projectRoot, id, slug, message }) {
  const root = repoRoot(projectRoot);
  const branch = branchFor(id, slug);
  const before = git(root, "rev-parse", "HEAD");
  const r = tryGit(root, "merge", "--no-ff", "--no-edit", "-m", message || `merge(${id}): ${slug || ""}`.trim(), branch);
  if (!r.ok) {
    tryGit(root, "merge", "--abort");
    return { ok: false, conflict: /CONFLICT|Automatic merge failed/i.test(r.out), error: r.out.split("\n").slice(0, 3).join(" "), head: before };
  }
  return { ok: true, head: git(root, "rev-parse", "HEAD"), before };
}

// What this ticket changed inside its worktree: committed since the base ref, plus anything still
// unstaged. Paths are relative to the worktree root, which is what `git add --` expects.
export function changedInWorktree(cwd, baseRef) {
  const committed = tryGit(cwd, "diff", "--name-only", baseRef ? `${baseRef}..HEAD` : "HEAD");
  const dirty = tryGit(cwd, "status", "--short");
  return {
    committed: committed.ok ? committed.out.split("\n").filter(Boolean) : [],
    uncommitted: dirty.ok ? dirty.out.split("\n").filter(Boolean).map(statusPath).filter(Boolean) : [],
  };
}

// git's short status is two status columns then a space then the path (" M src/a", "?? src/b"), but
// this module trims command output, which eats a leading space and makes any fixed-width slice cut
// into the path itself. Match the columns instead of counting them.
function statusPath(line) {
  const m = line.match(/^\s*[A-Z?! ]{1,2}\s+(.*)$/);
  const body = (m ? m[1] : line).trim().replace(/^"|"$/g, "");
  return body.split(" -> ").pop();
}

// The loop's own paper trail: the queue, the ticket JSONs, the reports, the verification and release
// records. It is tracked, it changes on every ticket, and until it is committed the working tree is never
// clean — which meant `ship` could refuse a project whose only uncommitted change was the loop's own
// bookkeeping. Anything gitignored (runs/, evidence/, events.jsonl) simply does not appear.
// Returns `{ok:false, empty:true}` when there was nothing to record, which is not a failure.
export function commitBookkeeping({ cwd, message }) {
  const paths = ["task.md", ".sch-loop"];
  const staged = [];
  for (const p of paths) { const r = tryGit(cwd, "add", "--", p); if (r.ok) staged.push(p); }
  if (!staged.length) return { ok: false, error: "nothing could be staged" };
  const pending = git(cwd, "diff", "--cached", "--name-only", "--", ...staged).trim();
  if (!pending) return { ok: false, empty: true, error: "no bookkeeping changes to record" };
  const r = tryGit(cwd, "commit", "-m", message);
  return r.ok ? { ok: true, head: git(cwd, "rev-parse", "HEAD"), files: pending.split("\n") } : { ok: false, error: r.out };
}

// Stage exactly the given files in a worktree and commit. Never `git add -A`.
export function commitFiles({ cwd, files, message }) {
  if (!files.length) return { ok: false, error: "no files to commit" };
  for (const f of files) { const r = tryGit(cwd, "add", "--", f); if (!r.ok) return { ok: false, error: r.out }; }
  const r = tryGit(cwd, "commit", "-m", message);
  return r.ok ? { ok: true, head: git(cwd, "rev-parse", "HEAD") } : { ok: false, error: r.out };
}
