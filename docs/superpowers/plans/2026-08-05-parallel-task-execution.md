# Parallel Task Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the scheduler run the ready set it already computes, with safe shared state and real fan-in.

**Architecture:** Three of the four advertised features already exist — path ownership (`hiddenDependencies`), fan-out (`selectReady` returns `ready`), and isolation (per-task worktrees). This plan adds the single-writer state discipline that makes concurrency safe, fixes fan-in (which has never worked), then lets the scheduler claim and run N tasks.

**Tech Stack:** Node ESM, Node ≥ 20, **zero dependencies**, `node:test`, `node:sqlite` for projections only.

## Global Constraints

- Node ≥ 20. **No new dependencies**, ever.
- Default behaviour must be byte-identical at `--max-parallel 1`. This is the safety argument for the milestone and is asserted by test, not claimed.
- Hermetic suite: temporary `SCH_HOME`, temporary repos, local bare remotes, fake executables. **No real model, no network, no credentials.**
- Never `git add -A`, never `commit -a`, never force-push, never rewrite published history.
- Run staged secret scan before every commit; stage exact paths only.
- Concurrency tests use **barriers**, never sleeps.
- A mutation function passed to `mutateState` must be synchronous. An `await` inside it defeats the lock.
- Do not run overlapping full test suites; use `node scripts/sch-test.mjs`.

---

### Task 1: Single-writer state mutation

`withFileLock` exists at `state.mjs:131` but is applied once (`state.mjs:2277`), on the *registry* path, wrapping only the CLI dispatcher. Project state has no lock at all.

**Files:**
- Modify: `scripts/state.mjs` (export a new function; do not change `saveState`)
- Test: `tests/state-concurrency.test.mjs` (create)

**Interfaces:**
- Produces: `mutateState(projectId, fn)` → whatever `fn` returns. `fn` receives the loaded state object, mutates it in place, and returns synchronously. Throws `Error` with `code = "STATE_LOCK_TIMEOUT"` if the lock cannot be taken.

- [ ] **Step 1: Write the failing test**

Create `tests/state-concurrency.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, STATE } from "./helpers.mjs";

test("concurrent mutations do not lose updates", () => {
  const fx = fixture("state-mutate");
  try {
    const s0 = STATE.loadState(fx.P);
    s0.counters = {};
    STATE.saveState(fx.P, s0);

    // Interleave the way a lost update actually happens: read, read, write, write.
    for (let i = 0; i < 50; i++)
      STATE.mutateState(fx.P, (s) => { s.counters.n = (s.counters.n ?? 0) + 1; });

    assert.equal(STATE.loadState(fx.P).counters.n, 50);
  } finally { fx.done(); }
});

test("mutateState returns what the mutation returns", () => {
  const fx = fixture("state-mutate-ret");
  try {
    const got = STATE.mutateState(fx.P, (s) => { s.marker = "x"; return 42; });
    assert.equal(got, 42);
    assert.equal(STATE.loadState(fx.P).marker, "x");
  } finally { fx.done(); }
});

test("a mutation that throws leaves the state untouched and releases the lock", () => {
  const fx = fixture("state-mutate-throw");
  try {
    const before = JSON.stringify(STATE.loadState(fx.P));
    assert.throws(() => STATE.mutateState(fx.P, () => { throw new Error("boom"); }), /boom/);
    assert.equal(JSON.stringify(STATE.loadState(fx.P)), before,
      "a failed mutation must not be half-written");
    // The lock must be free: a second mutation succeeds immediately.
    STATE.mutateState(fx.P, (s) => { s.after = true; });
    assert.equal(STATE.loadState(fx.P).after, true);
  } finally { fx.done(); }
});

test("an async mutation is refused rather than silently unlocked", () => {
  const fx = fixture("state-mutate-async");
  try {
    assert.throws(() => STATE.mutateState(fx.P, async (s) => { s.x = 1; }),
      /synchronous/i,
      "a promise-returning mutation would release the lock before the write");
  } finally { fx.done(); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/state-concurrency.test.mjs`
Expected: FAIL — `STATE.mutateState is not a function`

- [ ] **Step 3: Write the implementation**

In `scripts/state.mjs`, immediately after the `saveState` export:

```javascript
// The ONLY safe way to change project state. load → mutate → save is a
// read-modify-write, and every `await` between the read and the write is a
// window where another writer's change is silently erased. `withFileLock`
// already existed for exactly this reason but was applied to one call site on
// the registry path; project state — the thing parallel workers actually
// mutate — had no lock at all.
//
// `fn` MUST be synchronous. An async fn would return a promise, the lock would
// be released before the mutation finished, and the mutual exclusion this
// function exists to provide would be gone.
export function mutateState(projectId, fn) {
  return withFileLock(statePath(projectId), () => {
    const s = loadState(projectId);
    const result = fn(s);
    if (result && typeof result.then === "function")
      throw Object.assign(new Error("mutateState requires a synchronous mutation — an async one releases the lock before the write lands"), { code: "STATE_MUTATION_ASYNC" });
    saveState(projectId, s);
    return result;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/state-concurrency.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/state.mjs tests/state-concurrency.test.mjs
git commit -m "feat(state): one writer at a time, on the file that actually gets written"
```

---

### Task 2: The lock fails closed under contention

`withFileLock` gives up after `LOCK_WAIT` (5s) and **proceeds without the lock**, commented "availability > perfection". For a CLI command that is defensible. For N workers mutating task state it silently restores last-write-wins under exactly the contention that makes the lock necessary.

**Files:**
- Modify: `scripts/state.mjs` (`withFileLock`)
- Test: `tests/state-concurrency.test.mjs` (append)

**Interfaces:**
- Consumes: `mutateState` from Task 1
- Produces: `withFileLock(path, fn, { failClosed = false })`. When `failClosed` is true, a wait timeout throws `Error` with `code = "STATE_LOCK_TIMEOUT"` instead of proceeding. `mutateState` passes `failClosed: true`; the CLI dispatcher keeps today's behaviour.

- [ ] **Step 1: Write the failing test**

Append to `tests/state-concurrency.test.mjs`:

```javascript
import { mkdirSync } from "node:fs";
import { join } from "node:path";

test("a held lock makes a state mutation fail closed, not proceed unlocked", () => {
  const fx = fixture("state-lock-timeout");
  try {
    // Hold the lock the way a live writer does: the lock dir simply exists and
    // is fresh, so it is neither stale nor abandoned.
    const lock = join(fx.home, "projects", fx.P, "state.json.lock");
    mkdirSync(lock, { recursive: true });
    const started = Date.now();
    assert.throws(() => STATE.mutateState(fx.P, (s) => { s.stolen = true; }),
      (e) => e.code === "STATE_LOCK_TIMEOUT",
      "proceeding without the lock is how a concurrent update gets erased");
    assert.ok(Date.now() - started < 30000, "it must give up, not hang");
    assert.notEqual(STATE.loadState(fx.P).stolen, true,
      "nothing may be written when the lock was never held");
  } finally { fx.done(); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/state-concurrency.test.mjs`
Expected: FAIL — the mutation proceeds and `stolen` is `true`.

- [ ] **Step 3: Write the implementation**

In `scripts/state.mjs`, change the `withFileLock` signature and the give-up branch:

```javascript
function withFileLock(path, fn, { failClosed = false } = {}) {
```

Replace the give-up line:

```javascript
      if (Date.now() - start > LOCK_WAIT) break;           // give up waiting; proceed (availability > perfection)
```

with:

```javascript
      if (Date.now() - start > LOCK_WAIT) {
        // A CLI command prefers availability: proceed and accept last-write-wins.
        // A state mutation must not — that is precisely the erased-update this
        // lock exists to prevent, and it appears only under the contention that
        // makes it likely.
        if (failClosed)
          throw Object.assign(new Error(`could not lock ${path} within ${LOCK_WAIT}ms — another writer is holding it`), { code: "STATE_LOCK_TIMEOUT" });
        break;
      }
```

And in `mutateState`, pass the flag:

```javascript
  return withFileLock(statePath(projectId), () => {
```

becomes:

```javascript
  return withFileLock(statePath(projectId), () => {
```
…with the options argument added at the end of the call:
```javascript
  }, { failClosed: true });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/state-concurrency.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/state.mjs tests/state-concurrency.test.mjs
git commit -m "fix(state): a lock that gives up under contention is not a lock"
```

---

### Task 3: Every mutator goes through the one writer

**Files:**
- Modify: `scripts/transitions.mjs` (3 sites), `scripts/humangates.mjs` (3 sites), `scripts/runner.mjs:1099-1102`, `scripts/scheduler.mjs:671-691`, `scripts/dashboard.mjs` (5 sites)
- Test: `tests/state-concurrency.test.mjs` (append)

**Interfaces:**
- Consumes: `mutateState` from Task 1

Each site currently reads:

```javascript
const s = loadState(projectId);
/* ...mutate s... */
saveState(projectId, s);
```

and becomes:

```javascript
mutateState(projectId, (s) => {
  /* ...mutate s... */
});
```

**Read the surrounding function before converting each one.** Some sites return a value computed from the mutated state — return it from the callback, `mutateState` passes it through. Some sites early-`return` before saving; those become early `return` inside the callback, which correctly still writes the unchanged state. **No `await` may appear inside any callback**; if one does, restructure so the async work happens before or after the mutation, never inside it.

- [ ] **Step 1: Write the failing test**

Append to `tests/state-concurrency.test.mjs`:

```javascript
import { readFileSync } from "node:fs";
import { ROOT } from "./helpers.mjs";

test("no module mutates project state outside the single writer", () => {
  // A grep test, deliberately. The invariant is "saveState is called in exactly
  // one place", and only reading the source can assert that.
  const offenders = [];
  for (const f of ["transitions.mjs", "humangates.mjs", "runner.mjs", "scheduler.mjs", "dashboard.mjs"]) {
    const src = readFileSync(join(ROOT, "scripts", f), "utf8");
    if (/\bsaveState\s*\(/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    `these mutate state without the lock: ${offenders.join(", ")} — use mutateState`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/state-concurrency.test.mjs`
Expected: FAIL — all five files listed.

- [ ] **Step 3: Convert the call sites**

Work one file at a time. After each file, run that file's own tests before moving on:

```bash
node --test tests/transitions.test.mjs
node --test tests/phases.test.mjs
node --test tests/worker.test.mjs
node --test tests/scheduler.test.mjs
```

Remove `saveState` from each file's import list once its last use is gone. Leave `loadState` imported — reads are still fine unlocked.

- [ ] **Step 4: Run the full suite**

Run: `node scripts/sch-test.mjs --timeout-ms 900000`
Expected: PASS, 445 + new tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add scripts/transitions.mjs scripts/humangates.mjs scripts/runner.mjs \
        scripts/scheduler.mjs scripts/dashboard.mjs tests/state-concurrency.test.mjs
git commit -m "refactor(state): every writer takes the lock, or it is not a writer"
```

---

### Task 4: Fan-in — a task starts from its dependencies' work

This fixes a live bug at `--max-parallel 1`. `deps` gate readiness and nothing else; a task worktree is branched from `main` HEAD (`scheduler.mjs:570`), so a task whose dependency already delivered starts from a tree without that dependency's change.

**Files:**
- Modify: `scripts/worktree.mjs` (add one export)
- Modify: `scripts/scheduler.mjs` (call it after `ensureWorktree`, add failure code + event)
- Test: `tests/worktree.test.mjs` (append), `tests/scheduler.test.mjs` (append)

**Interfaces:**
- Consumes: `WT.branchNameFor(taskId)` (exists), `WT.ensureWorktree` (exists)
- Produces: `mergeDependencies({ worktreePath, repoRoot, deps })` → `{ ok: true, merged: [{ task_id, branch, commit }] }` or `{ ok: false, code: "DEPENDENCY_MERGE_CONFLICT" | "DEPENDENCY_BRANCH_MISSING", message, task_id, branch }`. `deps` is an array of task ids, merged in ascending id order.

- [ ] **Step 1: Write the failing test**

Append to `tests/worktree.test.mjs`:

```javascript
test("a dependent worktree contains its delivered dependency's work", () => {
  const fx = fixture("wt-fanin");
  try {
    // Task 1's work, on task 1's branch, exactly where delivery leaves it.
    git(fx.repo, "checkout", "-q", "-b", WT.branchNameFor(1));
    writeFileSync(join(fx.repo, "src", "from-dep.js"), "// dep\n");
    git(fx.repo, "add", "src/from-dep.js");
    git(fx.repo, "commit", "-q", "-m", "task 1 work");
    git(fx.repo, "checkout", "-q", "main");

    const base = git(fx.repo, "rev-parse", "HEAD").trim();
    const wt = WT.ensureWorktree({ projectId: fx.P, taskId: 2, repoRoot: fx.repo, base });
    assert.equal(wt.ok, true, wt.message);

    const r = WT.mergeDependencies({ worktreePath: wt.path, repoRoot: fx.repo, deps: [1] });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.merged.length, 1);
    assert.equal(r.merged[0].task_id, 1);
    assert.ok(existsSync(join(wt.path, "src", "from-dep.js")),
      "a task that depends on task 1 must start from a tree containing task 1's change");
  } finally { fx.done(); }
});

test("a conflicting dependency merge is refused before any worker starts", () => {
  const fx = fixture("wt-fanin-conflict");
  try {
    git(fx.repo, "checkout", "-q", "-b", WT.branchNameFor(1));
    writeFileSync(join(fx.repo, "src", "app.js"), "// dependency version\n");
    git(fx.repo, "add", "src/app.js");
    git(fx.repo, "commit", "-q", "-m", "task 1 rewrites app.js");
    git(fx.repo, "checkout", "-q", "main");
    writeFileSync(join(fx.repo, "src", "app.js"), "// main version\n");
    git(fx.repo, "add", "src/app.js");
    git(fx.repo, "commit", "-q", "-m", "main rewrites app.js");

    const base = git(fx.repo, "rev-parse", "HEAD").trim();
    const wt = WT.ensureWorktree({ projectId: fx.P, taskId: 2, repoRoot: fx.repo, base });
    const r = WT.mergeDependencies({ worktreePath: wt.path, repoRoot: fx.repo, deps: [1] });
    assert.equal(r.ok, false);
    assert.equal(r.code, "DEPENDENCY_MERGE_CONFLICT");
    assert.equal(r.task_id, 1);
    // The tree must not be left mid-merge.
    assert.equal(existsSync(join(wt.path, ".git")), true);
    assert.ok(!git(wt.path, "status", "--porcelain").includes("UU"),
      "a refused merge must be aborted, not left conflicted");
  } finally { fx.done(); }
});

test("two dependencies merge in task-id order, deterministically", () => {
  const fx = fixture("wt-fanin-order");
  try {
    for (const id of [2, 1]) {                    // created out of order on purpose
      git(fx.repo, "checkout", "-q", "-b", WT.branchNameFor(id), "main");
      writeFileSync(join(fx.repo, "src", `dep-${id}.js`), `// ${id}\n`);
      git(fx.repo, "add", `src/dep-${id}.js`);
      git(fx.repo, "commit", "-q", "-m", `task ${id}`);
      git(fx.repo, "checkout", "-q", "main");
    }
    const base = git(fx.repo, "rev-parse", "HEAD").trim();
    const wt = WT.ensureWorktree({ projectId: fx.P, taskId: 3, repoRoot: fx.repo, base });
    const r = WT.mergeDependencies({ worktreePath: wt.path, repoRoot: fx.repo, deps: [2, 1] });
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(r.merged.map((m) => m.task_id), [1, 2], "ascending id, not argument order");
    assert.ok(existsSync(join(wt.path, "src", "dep-1.js")));
    assert.ok(existsSync(join(wt.path, "src", "dep-2.js")));
  } finally { fx.done(); }
});

test("a dependency whose branch is gone is a typed failure, not a silent skip", () => {
  const fx = fixture("wt-fanin-missing");
  try {
    const base = git(fx.repo, "rev-parse", "HEAD").trim();
    const wt = WT.ensureWorktree({ projectId: fx.P, taskId: 2, repoRoot: fx.repo, base });
    const r = WT.mergeDependencies({ worktreePath: wt.path, repoRoot: fx.repo, deps: [1] });
    assert.equal(r.ok, false);
    assert.equal(r.code, "DEPENDENCY_BRANCH_MISSING",
      "carrying on without a dependency's work is how a task silently builds on nothing");
  } finally { fx.done(); }
});
```

Ensure `tests/worktree.test.mjs` imports `writeFileSync` and `existsSync` from `node:fs` and `join` from `node:path`; add whichever are missing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/worktree.test.mjs`
Expected: FAIL — `WT.mergeDependencies is not a function`

- [ ] **Step 3: Write the implementation**

In `scripts/worktree.mjs`:

```javascript
// A task's dependencies are not just a scheduling order — they are code the
// task is expected to build on. `deps` gated readiness and nothing else, so a
// task whose dependency had already delivered started from a tree that did not
// contain that dependency's work. Merging happens HERE, at creation, before any
// worker starts: a conflict then costs no model time and no partial work.
//
// Ascending task id, always. Merge order changes the resulting tree, and a base
// that depends on argument order is not reproducible.
export function mergeDependencies({ worktreePath, repoRoot, deps = [] }) {
  const merged = [];
  for (const id of [...deps].map(Number).sort((a, b) => a - b)) {
    const branch = branchNameFor(id);
    const commit = (git(repoRoot, "rev-parse", "--verify", "--quiet", branch) ?? "").trim();
    if (!commit)
      return { ok: false, code: "DEPENDENCY_BRANCH_MISSING", task_id: id, branch,
        message: `task #${id} is complete but its branch "${branch}" does not exist — its work cannot be merged, and continuing would build on a tree that never contained it` };

    const r = gitRun(worktreePath, ["merge", "--no-ff", "-m", `sch: integrate task #${id}`, branch]);
    if (r.status !== 0) {
      // Leave nothing half-merged: the worktree is evidence, not a workspace.
      gitRun(worktreePath, ["merge", "--abort"]);
      return { ok: false, code: "DEPENDENCY_MERGE_CONFLICT", task_id: id, branch,
        message: `task #${id}'s branch "${branch}" does not merge cleanly into this task's base — resolve it and re-queue; retrying produces the same conflict` };
    }
    merged.push({ task_id: id, branch, commit });
  }
  return { ok: true, merged };
}
```

Use whatever this module already has for running git — read the top of `worktree.mjs` and reuse its existing helper rather than importing a new one. If it exposes only a throwing helper, add a non-throwing `gitRun` beside it that returns `{ status, stdout, stderr }`.

- [ ] **Step 4: Wire it into the scheduler**

In `scripts/scheduler.mjs`, add `"scheduler.dependencies_merged"` to the event vocabulary array (near `"scheduler.worktree_created"`), add `DEPENDENCY_MERGE_CONFLICT` and `DEPENDENCY_BRANCH_MISSING` to the failure taxonomy with outcome `NEEDS_DECISION`, and immediately after the `if (wt.created) emit(...)` line:

```javascript
      // Only on creation. A resumed worktree already carries its dependencies'
      // work, and merging again would create an empty merge on every retry.
      if (wt.created && (task.deps ?? []).length) {
        const fan = WT.mergeDependencies({ worktreePath: wt.path, repoRoot, deps: task.deps });
        if (!fan.ok) return noWorktree(fan.code, fan.message);
        if (fan.merged.length)
          emit("scheduler.dependencies_merged", { merged: fan.merged }, { taskId: task.id });
      }
```

- [ ] **Step 5: Write the scheduler-level test**

Append to `tests/scheduler.test.mjs`:

```javascript
test("a queued task builds on its delivered dependency's code", async () => {
  const fx = queueFixture("queue-fanin");
  try {
    const a = addTask(fx, { title: "writes the module", allow: "src/dep.js" });
    const b = addTask(fx, { title: "uses the module", allow: "src/uses.js", deps: [a] });
    await runQueue(fx, {
      env: fakeQueueEnv(fx, {
        [a]: { write: [{ path: "src/dep.js", content: "// dep\n" }] },
        // This worker asserts, from inside its own worktree, that the
        // dependency's file is present before it writes anything.
        [b]: { requireFile: "src/dep.js", write: [{ path: "src/uses.js", content: "// uses\n" }] },
      }),
      maxTasks: 2,
    });
    const st = states(fx);
    assert.equal(st[a], "DELIVERED", JSON.stringify(st));
    assert.equal(st[b], "DELIVERED", JSON.stringify(st));
  } finally { fx.done(); }
});
```

Add a `requireFile` behaviour to `tests/fixtures/fake-claude.mjs` beside the existing `write` handler: if the named path does not exist relative to `cwd`, print a message naming it and exit non-zero. Mirror the shape of the handlers already there.

Check `addTask`'s real signature in `tests/helpers.mjs` before using `allow` and `deps`; use whatever names it actually takes.

- [ ] **Step 6: Run the tests**

Run: `node --test tests/worktree.test.mjs` then `node --test tests/scheduler.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/worktree.mjs scripts/scheduler.mjs tests/worktree.test.mjs \
        tests/scheduler.test.mjs tests/fixtures/fake-claude.mjs
git commit -m "fix(scheduler): a dependency is code to build on, not just an ordering"
```

---

### Task 5: Claim one at a time, run N

**Files:**
- Modify: `scripts/scheduler.mjs` (claim loop + wave execution), `scripts/sch-run-queue.mjs` (flag)
- Test: `tests/scheduler.test.mjs` (append)

**Interfaces:**
- Consumes: `TG.selectReady(state, { canonicalState })` → `{ selected, ready, rows }`; `mutateState` from Task 1; `mergeDependencies` from Task 4
- Produces: `runQueue({ ..., maxParallel = 1 })`. `--max-parallel N` on the CLI. A `parallel` field on the queue record recording the bound actually used.

- [ ] **Step 1: Write the failing test**

Append to `tests/scheduler.test.mjs`:

```javascript
test("two independent tasks run concurrently under --max-parallel 2", async () => {
  const fx = queueFixture("queue-parallel");
  try {
    const a = addTask(fx, { title: "a", allow: "src/a.js" });
    const b = addTask(fx, { title: "b", allow: "src/b.js" });
    // Each worker records when it started and when it ended; overlap is proven
    // from those timestamps, not from a sleep.
    const rec = await runQueue(fx, {
      env: fakeQueueEnv(fx, {
        [a]: { markSpan: true, write: [{ path: "src/a.js", content: "// a\n" }] },
        [b]: { markSpan: true, write: [{ path: "src/b.js", content: "// b\n" }] },
      }),
      maxTasks: 2, maxParallel: 2,
    });
    const spans = invocations(fx).filter((i) => i.start && i.end);
    assert.equal(spans.length, 2, JSON.stringify(rec));
    const [x, y] = spans.sort((p, q) => p.start - q.start);
    assert.ok(x.end > y.start, "the two workers must actually overlap in time");
  } finally { fx.done(); }
});

test("path-overlapping tasks never run concurrently, whatever the bound", async () => {
  const fx = queueFixture("queue-overlap");
  try {
    // Same allowed paths: the graph must serialise these even at max-parallel 4.
    const a = addTask(fx, { title: "a", allow: "src/shared.js" });
    const b = addTask(fx, { title: "b", allow: "src/shared.js" });
    await runQueue(fx, {
      env: fakeQueueEnv(fx, {
        [a]: { markSpan: true, write: [{ path: "src/shared.js", content: "// a\n" }] },
        [b]: { markSpan: true, write: [{ path: "src/shared.js", content: "// b\n" }] },
      }),
      maxTasks: 2, maxParallel: 4,
    });
    const spans = invocations(fx).filter((i) => i.start && i.end)
      .sort((p, q) => p.start - q.start);
    if (spans.length === 2)
      assert.ok(spans[0].end <= spans[1].start,
        "two tasks owning the same path overlapped — that is data loss, not throughput");
  } finally { fx.done(); }
});

test("--max-parallel 1 runs tasks strictly one at a time", async () => {
  const fx = queueFixture("queue-serial");
  try {
    const a = addTask(fx, { title: "a", allow: "src/a.js" });
    const b = addTask(fx, { title: "b", allow: "src/b.js" });
    await runQueue(fx, {
      env: fakeQueueEnv(fx, {
        [a]: { markSpan: true, write: [{ path: "src/a.js", content: "// a\n" }] },
        [b]: { markSpan: true, write: [{ path: "src/b.js", content: "// b\n" }] },
      }),
      maxTasks: 2, maxParallel: 1,
    });
    const spans = invocations(fx).filter((i) => i.start && i.end)
      .sort((p, q) => p.start - q.start);
    assert.equal(spans.length, 2);
    assert.ok(spans[0].end <= spans[1].start, "the default must remain sequential");
  } finally { fx.done(); }
});
```

Add a `markSpan` behaviour to `tests/fixtures/fake-claude.mjs`: append one JSON line to `$SCH_HOME/behaviours/invocations.log` containing `{ task, start, end }` with `Date.now()` values taken at entry and just before exit. The `invocations()` helper in `tests/scheduler.test.mjs` already reads that file — check its shape and match it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/scheduler.test.mjs`
Expected: FAIL — `maxParallel` is ignored, so no two spans overlap.

- [ ] **Step 3: Write the implementation**

Read the existing queue loop in `scripts/scheduler.mjs` before changing it — it owns budgets, stop conditions and the record. Convert the body from "pick `selected`, run it, repeat" to:

```javascript
  // Claim ONE AT A TIME, recomputing readiness after each claim. Claiming a task
  // moves it to CLAIMED, which is an OWNING state, which makes every
  // path-overlapping task immediately un-ready — so path ownership falls out of
  // the graph rules and needs no second lock. Claiming a whole batch from one
  // readiness snapshot would defeat exactly that.
  const claim = () => {
    if (inFlight.size >= maxParallel) return null;
    const { selected } = TG.selectReady(loadState(projectId), { canonicalState: TR.canonicalState });
    if (!selected) return null;
    const t = TR.transition(projectId, selected.id, { to: "CLAIMED", actor: "scheduler", reason: "claimed by the queue" });
    return t.ok ? selected : null;
  };
```

and drive it with a drain loop that starts tasks while `claim()` yields one, awaits `Promise.race` over the in-flight set, applies each finished outcome, then tries to claim again. Keep every existing budget and stop-condition check; evaluate them on completion order, not start order.

`maxParallel` comes from the options with `= 1` as the default, and is clamped to at least 1.

- [ ] **Step 4: Add the CLI flag**

In `scripts/sch-run-queue.mjs`, beside `maxTasks: int("max-tasks", flag("max-tasks"))`:

```javascript
  maxParallel: int("max-parallel", flag("max-parallel")) ?? 1,
```

and add `--max-parallel <n>` to the usage comment at the top of that file.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/scheduler.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `node scripts/sch-test.mjs --timeout-ms 900000`
Expected: PASS, 0 failures. Any pre-existing test that assumed strict sequencing must be examined, not edited to fit — if a real behaviour changed at the default, the implementation is wrong.

- [ ] **Step 7: Commit**

```bash
git add scripts/scheduler.mjs scripts/sch-run-queue.mjs tests/scheduler.test.mjs \
        tests/fixtures/fake-claude.mjs
git commit -m "feat(scheduler): run the ready set it already computed"
```

---

### Task 6: Cancellation and failure isolation reach every worker

**Files:**
- Modify: `scripts/scheduler.mjs`
- Test: `tests/scheduler.test.mjs` (append)

**Interfaces:**
- Consumes: the in-flight set from Task 5

- [ ] **Step 1: Write the failing test**

Append to `tests/scheduler.test.mjs`:

```javascript
test("one task failing does not cancel its in-flight siblings", async () => {
  const fx = queueFixture("queue-isolation");
  try {
    const a = addTask(fx, { title: "fails", allow: "src/a.js" });
    const b = addTask(fx, { title: "succeeds", allow: "src/b.js" });
    await runQueue(fx, {
      env: fakeQueueEnv(fx, {
        [a]: {},                                                   // writes nothing → fails verification
        [b]: { write: [{ path: "src/b.js", content: "// b\n" }] },
      }),
      maxTasks: 2, maxParallel: 2,
    });
    const st = states(fx);
    assert.notEqual(st[a], "DELIVERED", JSON.stringify(st));
    assert.equal(st[b], "DELIVERED",
      "a sibling's failure must not take down a task that did its job");
  } finally { fx.done(); }
});

test("HALT stops every in-flight run, not only the first", async () => {
  const fx = queueFixture("queue-halt");
  try {
    const a = addTask(fx, { title: "a", allow: "src/a.js" });
    const b = addTask(fx, { title: "b", allow: "src/b.js" });
    // Both workers ask to be cancelled the way an operator pressing HALT looks
    // from the worker's side.
    await runQueue(fx, {
      env: fakeQueueEnv(fx, { [a]: { selfCancel: true }, [b]: { selfCancel: true } }),
      maxTasks: 2, maxParallel: 2,
    });
    for (const id of [a, b])
      assert.notEqual(states(fx)[id], "RUNNING",
        `task #${id} was left RUNNING — a cancel that reaches one worker is not a cancel`);
  } finally { fx.done(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/scheduler.test.mjs`
Expected: FAIL if cancellation or budget evaluation short-circuits the wave.

- [ ] **Step 3: Write the implementation**

Make the stop path signal **every** in-flight run before awaiting them, then drain and record outcomes. A stop condition must never abandon an in-flight run without a terminal state — an abandoned run leaves a task `RUNNING` with no process, which the next queue pass has to recover from as a stale lease.

- [ ] **Step 4: Run the full suite**

Run: `node scripts/sch-test.mjs --timeout-ms 900000`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add scripts/scheduler.mjs tests/scheduler.test.mjs
git commit -m "feat(scheduler): a stop reaches every worker or it is not a stop"
```

---

### Task 7: Documentation and the ADR

**Files:**
- Modify: `README.md`, `SCH-LOOP.md`, `skills/SCH/SKILL.md`
- Create: `docs/adr/0006-parallel-task-execution.md`

- [ ] **Step 1: Update the README**

Remove "Parallel execution in Git worktrees", "fan-out / fan-in and integration joins" and "path-ownership leases" from **Planned, and NOT implemented**. Add to the containment section's **True now**:

```markdown
- **Independent tasks can run concurrently, and dependent ones cannot.** With
  `--max-parallel N` the scheduler runs up to N ready tasks at once. Two tasks
  whose `allowedPaths` overlap are never in flight together — path ownership is
  enforced by the graph, not by hope. The default is 1.
- **A task starts from its dependencies' work.** A dependent task's worktree is
  branched from `main` and then merged with each delivered dependency's branch,
  in task-id order, before any worker starts.
```

Add to **Still NOT true**:

```markdown
- **Parallelism multiplies uncontained workers.** N workers means N processes
  with your PATH and your network. Every containment caveat above applies N
  times over.
```

- [ ] **Step 2: Mirror into `SCH-LOOP.md` and `skills/SCH/SKILL.md`**

Both currently state that parallel execution "does not exist" and name it as the next milestone. Both must now describe it as implemented, with the same two limits. These two files drifted from the README in an earlier milestone and the drift was a review finding — read the surrounding paragraph in each and match its voice.

- [ ] **Step 3: Write ADR 0006**

Create `docs/adr/0006-parallel-task-execution.md` following ADR 0005's shape. It must record:

- **The decision:** claiming is the lease; single-writer state; fan-in at worktree creation; bounded wave defaulting to 1.
- **What was already built** and how reading the code changed the milestone's shape — three of four advertised features existed.
- **Two bugs this found that predate parallelism:** project state had no lock at all (the lock existed but guarded the registry for the CLI only), and `deps` never merged anything, so a dependent task built on a tree without its dependency's work.
- **Alternatives rejected:** a separate path-lease system (the graph already does it); an `INTEGRATION` node type (a task with N deps is the join); rebasing instead of merging (rewrites the task branch, which is the durable record); SQLite state authority (a later milestone with its own migration risk).
- **Consequences:** N uncontained workers; merge commits now appear in task branches; a conflicting dependency stops the task at `DEPENDENCY_MERGE_CONFLICT` and needs a person.

- [ ] **Step 4: Validate and run the suite**

Run: `npm run validate` then `node scripts/sch-test.mjs --timeout-ms 900000`
Expected: both PASS. `validate.mjs` requires every `scripts/*.mjs` to appear in the README file map.

- [ ] **Step 5: Commit**

```bash
git add README.md SCH-LOOP.md skills/SCH/SKILL.md docs/adr/0006-parallel-task-execution.md
git commit -m "docs(parallel): say what runs at once, and what still cannot"
```

---

## Out of scope

- An `INTEGRATION` node kind. A task with N dependencies is the join.
- SQLite as state authority. `mutateState` is the narrowest fix that makes concurrency safe.
- OS-level sandboxing and network restriction. Parallelism multiplies workers; it does not change their containment.
- Cross-project parallelism. One scheduler per project remains the rule.
