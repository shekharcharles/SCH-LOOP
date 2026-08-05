import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

test("ensureWorktree refuses a worktree root that resolves inside the managed repository", () => {
  const fx = fixture("wt-contains");
  try {
    const base = git(fx.repo, "rev-parse", "HEAD").trim();
    const r = WT.ensureWorktree({ projectId: fx.P, taskId: 1, repoRoot: fx.repo, base, root: join(fx.repo, "wt") });
    assert.equal(r.ok, false);
    assert.equal(r.code, "WORKTREE_CREATE_FAILED");

    if (process.platform === "win32") {
      // Same containment, differing only in the case of repoRoot's drive/segments —
      // pins the fix that reuses workspace.mjs's case-folded contains() instead of
      // a case-sensitive comparison.
      const caseFolded = WT.ensureWorktree({ projectId: fx.P, taskId: 1, repoRoot: fx.repo, base, root: join(fx.repo.toUpperCase(), "wt") });
      assert.equal(caseFolded.ok, false, "a root that differs from repoRoot only in case must still be refused");
      assert.equal(caseFolded.code, "WORKTREE_CREATE_FAILED");
    }
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

// The branch's primary new stop. Every failure used to read `git worktree add …
// did not produce a worktree at <path>` and nothing else, so a stale admin
// entry, a locked checkout, a full disk and a MAX_PATH failure were one message.
test("a checkout deleted by hand fails with git's own reason and the prune remedy", () => {
  const fx = fixture("wt-stale-admin");
  const root = join(fx.home, "wt");
  try {
    const base = git(fx.repo, "rev-parse", "HEAD").trim();
    const a = WT.ensureWorktree({ projectId: fx.P, taskId: 1, repoRoot: fx.repo, base, root });
    // Deleted with the file manager: the directory is gone, git's administrative
    // entry is not, and `worktree add` refuses the branch it still believes is out.
    rmSync(a.path, { recursive: true, force: true });

    const b = WT.ensureWorktree({ projectId: fx.P, taskId: 1, repoRoot: fx.repo, base, root });
    assert.equal(b.ok, false);
    assert.equal(b.code, "WORKTREE_CREATE_FAILED");
    assert.match(b.message, /already registered|already used by|already checked out/i,
      `the message must name git's cause, not just the path: ${b.message}`);
    assert.match(b.message, /worktree prune/, `and the remedy for it: ${b.message}`);
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

// --------------------------------------------- branch namespace matching

// Direct calls, not through state.mjs: a rename of branchMatchesNamespace
// must fail HERE, not just break Task 6 silently. Each row is picked so that
// disabling the ONE guard it targets (and only that one) flips it from false
// to true — verified by hand, see task-5-report.md. A row rejected for a
// reason unrelated to its target guard (e.g. by a simple prefix mismatch)
// proves nothing about that guard, so it is not used as evidence here.
test("branchMatchesNamespace: every refusal guard is independently load-bearing", () => {
  const ns = { pattern: "sch/task-*" };
  for (const [b, want] of [
    ["sch/task-12", true],
    ["sch/task-1/x", false],     // "*" must never match across "/" ([^/]* vs .*)
    ["sch/task-..x", false],     // traversal — [^/]* alone WOULD match "..x"
    ["sch/task-1.lock", false],  // a git lockfile name
    ["main", false],             // sanity: an unrelated branch, not a guard pin
  ]) assert.equal(WT.branchMatchesNamespace(ns, b), want, b);

  // "sch/task-*"'s own wildcard shape already forbids a trailing "/" and
  // already requires an alnum-starting match, so no branch reaches THOSE two
  // guards through it — a pattern shaped so the guard, not the wildcard, is
  // what's left standing is required for each.
  assert.equal(WT.branchMatchesNamespace({ pattern: "sch/task-1/" }, "sch/task-1/"), false,
    "endsWith('/') — a literal (non-wildcard) pattern ending in '/' would otherwise match its own trailing slash");
  assert.equal(WT.branchMatchesNamespace({ pattern: "*" }, "-x"), false,
    "the leading-alnum/charset regex — a bare '*' pattern would otherwise accept any non-slash string");

  assert.equal(WT.branchMatchesNamespace(null, "sch/task-1"), false, "no record at all");
  assert.equal(WT.branchMatchesNamespace({ pattern: "" }, "sch/task-1"), false, "empty pattern");
});

test("delivery-branch-namespace --set rejects a pattern with no usable shape", () => {
  const fx = fixture("wt-ns-pattern");
  try {
    for (const bad of ["*", "a*b*", "-x"])
      assert.throws(() => fx.cli("delivery-branch-namespace", "--project", fx.P, "--set", bad, "--approver", "t"),
        /not a usable branch namespace/, bad);
  } finally { fx.done(); }
});
