import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, git, ROOT, url } from "./helpers.mjs";

const WT = await import(url(join(ROOT, "scripts", "worktree.mjs")));

test("worktree root is outside the repository and outside SCH_HOME", () => {
  const fx = fixture("wt-root");
  try {
    const p = WT.worktreePathFor(fx.P, 1, { root: WT.worktreesRoot() });
    assert.ok(!p.startsWith(fx.repo), "worktree must not live inside the repository");
    assert.ok(!p.startsWith(fx.home), "worktree must not live inside SCH_HOME");
  } finally { fx.done(); }
});

test("branch name is derived from the task id", () => {
  assert.equal(WT.branchNameFor(7), "sch/task-7");
});

test("ensureWorktree creates a worktree on a task branch off the base", () => {
  const fx = fixture("wt-create");
  const root = join(fx.home, "wt");
  try {
    const base = git(fx.repo, "rev-parse", "HEAD").trim();
    const r = WT.ensureWorktree({ projectId: fx.P, taskId: 1, repoRoot: fx.repo, base, root });
    assert.equal(r.ok, true);
    assert.equal(r.created, true);
    assert.equal(r.branch, "sch/task-1");
    assert.ok(existsSync(join(r.path, "src", "app.js")), "worktree must be a real checkout");
    assert.equal(git(r.path, "rev-parse", "HEAD").trim(), base);
    assert.equal(git(r.path, "rev-parse", "--abbrev-ref", "HEAD").trim(), "sch/task-1");
  } finally { fx.done(); }
});

test("ensureWorktree is idempotent and preserves uncommitted work", () => {
  const fx = fixture("wt-reuse");
  const root = join(fx.home, "wt");
  try {
    const base = git(fx.repo, "rev-parse", "HEAD").trim();
    const a = WT.ensureWorktree({ projectId: fx.P, taskId: 1, repoRoot: fx.repo, base, root });
    writeFileSync(join(a.path, "src", "app.js"), "// attempt 1 work\n");

    const b = WT.ensureWorktree({ projectId: fx.P, taskId: 1, repoRoot: fx.repo, base, root });
    assert.equal(b.ok, true);
    assert.equal(b.created, false, "a second call must reuse, not recreate");
    assert.equal(b.path, a.path);
    assert.equal(readFileSync(join(b.path, "src", "app.js"), "utf8"), "// attempt 1 work\n",
      "attempt 2 must inherit attempt 1's uncommitted work");
  } finally { fx.done(); }
});

test("ensureWorktree refuses a directory that is on the wrong branch", () => {
  const fx = fixture("wt-mismatch");
  const root = join(fx.home, "wt");
  try {
    const base = git(fx.repo, "rev-parse", "HEAD").trim();
    const a = WT.ensureWorktree({ projectId: fx.P, taskId: 1, repoRoot: fx.repo, base, root });
    git(a.path, "checkout", "-q", "-b", "somebody-elses-branch");

    const b = WT.ensureWorktree({ projectId: fx.P, taskId: 1, repoRoot: fx.repo, base, root });
    assert.equal(b.ok, false);
    assert.equal(b.code, "WORKTREE_BRANCH_MISMATCH");
  } finally { fx.done(); }
});

test("removeWorktree removes the checkout and leaves the branch", () => {
  const fx = fixture("wt-remove");
  const root = join(fx.home, "wt");
  try {
    const base = git(fx.repo, "rev-parse", "HEAD").trim();
    const a = WT.ensureWorktree({ projectId: fx.P, taskId: 1, repoRoot: fx.repo, base, root });
    const r = WT.removeWorktree({ projectId: fx.P, taskId: 1, repoRoot: fx.repo, root });
    assert.equal(r.ok, true);
    assert.equal(existsSync(a.path), false);
    const branches = git(fx.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads");
    assert.ok(branches.includes("sch/task-1"), "the branch is evidence and must survive");
  } finally { fx.done(); }
});

test("worktreeState reports absence without throwing", () => {
  const fx = fixture("wt-state");
  const root = join(fx.home, "wt");
  try {
    const s = WT.worktreeState({ projectId: fx.P, taskId: 9, repoRoot: fx.repo, root });
    assert.equal(s.exists, false);
  } finally { fx.done(); }
});
