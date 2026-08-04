# Contained Worker Execution (M6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run every SCH worker in a disposable per-task git worktree with no git credentials, so the operator's working tree and credential vault are unreachable and the delivery controller still works unchanged.

**Architecture:** A new `scripts/worktree.mjs` owns worktree lifecycle. `repoRoot` (where work happens) is decoupled from `wsDir` (where control state and evidence live): `repoRoot` becomes the worktree, `wsDir` stays in the main repository. The delivery controller runs inside the worktree with no code change to its staging, approval, secret or remote-verification logic — only the `UPSTREAM_CHANGED` stop at `delivery.mjs:721` becomes conditional on a per-project branch namespace, so a task branch's first push may create its remote branch.

**Tech Stack:** Node >= 20, ESM, zero runtime dependencies. `node --test`. Real `git` subprocesses via `scripts/candidate.mjs` `gitRun`/`gitOut` and `scripts/workspace.mjs` `git`.

## Global Constraints

- **Node >= 20. No new dependencies.** `package.json` has none and must keep none.
- **No shell strings.** Every subprocess is argv-only, through the existing helpers.
- **`assertSafeGitArgs` applies to every git call.** `worktree add` / `worktree remove` / `worktree list` must be permitted by it; no history-moving verb may be introduced.
- **Never claim isolation this does not provide.** Comments and messages say "worktree", never "sandbox" or "isolated".
- **`SCH_HOME` stays absent from worker environment.**
- **Worktree root path:** `%LOCALAPPDATA%\sch-loop\worktrees` on Windows, `${XDG_STATE_HOME:-$HOME/.local/state}/sch-loop/worktrees` on POSIX. Overridable per project by an operator-set absolute path. Never inside the managed repository, never inside `SCH_HOME`.
- **Branch naming:** `sch/task-<n>`. Default namespace: `sch/task-*`.
- **Tests run:** `npm test` (`node --test test.mjs "tests/*.test.mjs"`). New test files go in `tests/` and are picked up by that glob.
- **Every test uses `tests/helpers.mjs` `fixture()`** — throwaway `SCH_HOME`, throwaway repo, local bare remote via `withRemote()`. Never the operator's real registry or the network.
- **Commit style:** the repo's existing convention — `type(scope): lowercase sentence saying what changed and why`.

---

### Task 1: Worktree lifecycle module

**Files:**
- Create: `scripts/worktree.mjs`
- Test: `tests/worktree.test.mjs`

**Interfaces:**
- Consumes: `scripts/workspace.mjs` (`git`, `repositoryRoot`), `scripts/candidate.mjs` (`assertSafeGitArgs`)
- Produces:
  - `worktreesRoot()` → absolute path string
  - `worktreePathFor(projectId, taskId, { root })` → absolute path string
  - `branchNameFor(taskId)` → `"sch/task-<n>"`
  - `ensureWorktree({ projectId, taskId, repoRoot, base, root })` → `{ ok: true, path, branch, created }` | `{ ok: false, code, message }`
  - `removeWorktree({ projectId, taskId, repoRoot, root })` → `{ ok, removed }`
  - `worktreeState({ projectId, taskId, repoRoot, root })` → `{ exists, path, branch, head, matchesBranch }`

Failure codes produced here, all consumed by Task 4: `WORKTREE_CREATE_FAILED`, `WORKTREE_BRANCH_MISMATCH`, `WORKTREE_NOT_A_WORKTREE`.

- [ ] **Step 1: Write the failing tests**

Create `tests/worktree.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/worktree.test.mjs`
Expected: FAIL — `Cannot find module .../scripts/worktree.mjs`

- [ ] **Step 3: Write the implementation**

Create `scripts/worktree.mjs`:

```javascript
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
import { isAbsolute, join, resolve, sep } from "node:path";
import { git, repositoryRoot } from "./workspace.mjs";

export const SCHEMA_VERSION = 1;
export const BRANCH_PREFIX = "sch/task-";
export const DEFAULT_NAMESPACE = "sch/task-*";

const gt = (cwd, ...a) => (git(cwd, ...a) ?? "").trim();

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

// Is `p` inside `parent`? Used to refuse a worktree root inside the repository.
function within(parent, p) {
  const a = resolve(parent).replace(/[\\/]+$/, "") + sep;
  return resolve(p).startsWith(a);
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

  if (within(repoRoot, path))
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
  const out = git(repoRoot, ...args);
  if (out === null || !existsSync(path))
    return { ok: false, code: "WORKTREE_CREATE_FAILED", message: `git ${args.join(" ")} did not produce a worktree at ${path}` };

  return { ok: true, path, branch, created: true };
}

// Remove the CHECKOUT. The branch survives: it is the record of what was built,
// and after delivery it is what was pushed.
export function removeWorktree({ projectId, taskId, repoRoot, root = worktreesRoot() }) {
  const path = worktreePathFor(projectId, taskId, { root });
  if (!existsSync(path)) return { ok: true, removed: false };
  const out = git(repoRoot, "worktree", "remove", "--force", path);
  if (out === null) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* reported below */ }
    git(repoRoot, "worktree", "prune");
  }
  return { ok: !existsSync(path), removed: !existsSync(path), path };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/worktree.test.mjs`
Expected: PASS, 7 tests.

If `git worktree add` is rejected, `assertSafeGitArgs` in `scripts/candidate.mjs:51` needs `worktree` on its permitted-verb path. Read that function, add `worktree` only for the `add`, `remove`, `list` and `prune` subcommands, and add a test asserting `worktree` with any other subcommand is still refused.

- [ ] **Step 5: Commit**

```bash
git add scripts/worktree.mjs tests/worktree.test.mjs
git commit -m "feat(worktree): a disposable checkout per task, and it never deletes unapproved work"
```

---

### Task 2: Strip git credentials from the worker environment

**Files:**
- Modify: `scripts/executor.mjs:32` (`ENV_ALLOW`), `scripts/executor.mjs:212` (the `buildEnv` call in the run path)
- Test: `tests/worker.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new
- Produces: worker environments that contain `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=credential.helper`, `GIT_CONFIG_VALUE_0=""` and none of `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_ASKPASS`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`

- [ ] **Step 1: Write the failing tests**

Append to `tests/worker.test.mjs`:

```javascript
test("the worker environment carries no git credential helper", () => {
  const env = EXEC.buildEnv(
    { ...process.env, GH_TOKEN: "ghp_x", GITHUB_TOKEN: "ghp_y", GIT_ASKPASS: "C:\\askpass.exe",
      SSH_AUTH_SOCK: "/tmp/agent.sock", SSH_AGENT_PID: "1234" },
    {},
  );
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GIT_ASKPASS", "SSH_AUTH_SOCK", "SSH_AGENT_PID"])
    assert.equal(env[k], undefined, `${k} must never reach a worker`);
});

test("the worker environment disables the configured credential helper", () => {
  const env = EXEC.buildEnv(process.env, EXEC.GIT_CREDENTIAL_STRIP);
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "credential.helper");
  assert.equal(env.GIT_CONFIG_VALUE_0, "");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/worker.test.mjs`
Expected: FAIL — `EXEC.GIT_CREDENTIAL_STRIP` is undefined; `GIT_CONFIG_COUNT` is undefined.

- [ ] **Step 3: Write the implementation**

In `scripts/executor.mjs`, immediately after the `ENV_ALLOW` array (line 32 onward), add:

```javascript
// A worker must not be able to authenticate to a remote. `credential.helper` is
// `manager` on this operator's machine, which means the Windows Credential
// Manager vault is one `git push` away from any process running as them.
//
// This is set on the ENVIRONMENT, never in the worktree's git config: the
// delivery controller runs in that same worktree and still has to push.
export const GIT_CREDENTIAL_STRIP = Object.freeze({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
});
```

Then verify `ENV_ALLOW` (line 32) contains none of `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_ASKPASS`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`. Read the full array first. If any is present, delete that entry — do not add an allowlist exception mechanism.

At the `buildEnv` call in the run path (`scripts/executor.mjs:212`), merge the strip into the `extra` object:

```javascript
    const env = buildEnv(this.parentEnv, {
      ...GIT_CREDENTIAL_STRIP,
      SCH_RUN_ID: identity.run_id, SCH_PROJECT_ID: identity.project_id, SCH_TASK_ID: identity.task_id,
```

Leave the rest of that object exactly as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/worker.test.mjs`
Expected: PASS. Then `npm test` — the existing worker and preflight suites must stay green.

- [ ] **Step 5: Commit**

```bash
git add scripts/executor.mjs tests/worker.test.mjs
git commit -m "feat(executor): a worker gets no credential helper and no token to push with"
```

---

### Task 3: Decouple `repoRoot` from `wsDir` in the runner

This task changes no behavior. It introduces the seam Task 4 uses, with the default preserving today's semantics exactly.

**Files:**
- Modify: `scripts/runner.mjs:753-755`, `scripts/runner.mjs:981-984`, `scripts/runner.mjs:1042`
- Test: `tests/worker.test.mjs` (append)

**Interfaces:**
- Consumes: `WS.validateWorkspace({ projectId, repoPath })` → `{ root, dir }` (unchanged)
- Produces: `RUN.runTask({ ..., workRoot })` — an optional absolute path. When absent, `workRoot` defaults to `ws.root` and everything behaves as before. When present, it becomes `ctx.repoRoot`; `ctx.wsDir` still comes from `ws.dir`.

- [ ] **Step 1: Write the failing test**

Append to `tests/worker.test.mjs`:

```javascript
test("a run writes evidence to the main workspace while working in workRoot", async () => {
  const fx = fixture("split-root");
  try {
    initWorkspace(fx);
    const t = addTask(fx);
    const alt = join(fx.home, "alt-checkout");
    git(fx.repo, "worktree", "add", alt, "-b", "sch/task-" + t, "HEAD");

    const rec = await run(fx, t, fakeExecutor(fx, {
      edits: [{ path: "src/app.js", content: "// edited in the alternate checkout\n" }],
      handoff: { status: "COMPLETE", summary: "done", files_changed: ["src/app.js"] },
    }), { workRoot: alt });

    assert.equal(rec.outcome, "VERIFIED");
    assert.ok(existsSync(join(fx.repo, ".sch-loop", "runs", rec.run_id)),
      "evidence must land in the MAIN repository workspace, not the alternate checkout");
    assert.equal(readFileSync(join(alt, "src", "app.js"), "utf8"), "// edited in the alternate checkout\n");
    assert.equal(readFileSync(join(fx.repo, "src", "app.js"), "utf8"), "// app\n",
      "the main working tree must be untouched");
  } finally { fx.done(); }
});
```

Add `existsSync` and `readFileSync` to the `node:fs` import at the top of `tests/worker.test.mjs` if they are not already imported, and `join` from `node:path`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/worker.test.mjs`
Expected: FAIL — the edit is applied in `fx.repo`, not `alt`, because `workRoot` is ignored.

- [ ] **Step 3: Write the implementation**

At `scripts/runner.mjs:753-755`, replace:

```javascript
  const ws = WS.validateWorkspace({ projectId, repoPath: project.path });
```
...
```javascript
  ctx.repoRoot = ws.root; ctx.wsDir = ws.dir;
```

with a form that accepts the override. The enclosing function must take `workRoot = null` as a named option and then:

```javascript
  const ws = WS.validateWorkspace({ projectId, repoPath: project.path });
  // wsDir is the DURABLE record and stays in the main repository: run evidence
  // must outlive the disposable checkout that produced it. repoRoot is where
  // work happens, and may be a worktree.
  ctx.wsDir = ws.dir;
  ctx.repoRoot = workRoot ? WS.repositoryRoot(workRoot) : ws.root;
  if (workRoot && !ctx.repoRoot)
    return fail("WORKSPACE_INVALID", `workRoot ${workRoot} is not a git repository`);
```

Apply the same substitution at `scripts/runner.mjs:981-984`:

```javascript
    wsDir = ws.dir;
    repoRoot = workRoot ? WS.repositoryRoot(workRoot) : ws.root;
```

`scripts/runner.mjs:1042` (`wsDir = pre.ctx.wsDir; repoRoot = pre.ctx.repoRoot;`) needs no change — it already reads both from the preflight context.

Thread `workRoot` through `runTask`'s options object down to both call sites. Do not change any other use of `repoRoot`: every git call, the baseline, the effect inspection and the candidate all follow it automatically.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/worker.test.mjs`
Expected: PASS. Then `npm test` — all existing suites must stay green, because `workRoot` defaults to `ws.root`.

- [ ] **Step 5: Commit**

```bash
git add scripts/runner.mjs tests/worker.test.mjs
git commit -m "refactor(runner): where work happens and where evidence lives are two different directories"
```

---

### Task 4: The scheduler creates and passes the worktree

**Files:**
- Modify: `scripts/scheduler.mjs:352-357` (workspace resolution), `scripts/scheduler.mjs:520-532` (claim → `executeTask`), `scripts/scheduler.mjs:636` and `:679` and `:784` (thread `workRoot`), `scripts/scheduler.mjs:958` (the `RUN.runTask` call)
- Test: `tests/scheduler.test.mjs` (append)

**Interfaces:**
- Consumes: `WT.ensureWorktree`, `WT.removeWorktree`, `WT.worktreeState` from Task 1; `RUN.runTask({ workRoot })` from Task 3
- Produces: `executeTask({ ..., workRoot })` and `runAttempt({ ..., workRoot })`; scheduler events `scheduler.worktree_created` and `scheduler.worktree_removed`

- [ ] **Step 1: Write the failing tests**

Append to `tests/scheduler.test.mjs`:

```javascript
test("the queue works in a worktree and leaves the main tree untouched", async () => {
  const fx = fixture("sched-wt");
  try {
    initWorkspace(fx);
    const t = addTask(fx);
    const before = readFileSync(join(fx.repo, "src", "app.js"), "utf8");

    await runQueue(fx, {
      env: fakeQueueEnv(fx, { [t]: {
        edits: [{ path: "src/app.js", content: "// built by the queue\n" }],
        handoff: { status: "COMPLETE", summary: "done", files_changed: ["src/app.js"] },
      } }),
      maxTasks: 1,
    });

    assert.equal(readFileSync(join(fx.repo, "src", "app.js"), "utf8"), before,
      "the operator's working tree must be byte-identical after a queue run");
    const branches = git(fx.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads");
    assert.ok(branches.includes(`sch/task-${t}`), "the task branch must exist");
  } finally { fx.done(); }
});

test("a worktree missing mid-attempt is NEEDS_DECISION and is not recreated", async () => {
  const fx = fixture("sched-wt-missing");
  try {
    initWorkspace(fx);
    const t = addTask(fx);
    // Simulate an interrupted attempt: the task is mid-flight, the worktree is gone.
    fx.cli("task-set", "--project", fx.P, String(t), "--status", "building");

    const res = await runQueue(fx, { env: fakeQueueEnv(fx, {}), maxTasks: 1 });
    assert.match(JSON.stringify(res), /NEEDS_DECISION|WORKTREE_MISSING/);
  } finally { fx.done(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/scheduler.test.mjs`
Expected: FAIL — the first test finds `src/app.js` modified in the main tree.

- [ ] **Step 3: Write the implementation**

Import the module at the top of `scripts/scheduler.mjs`, alongside the existing `RUN` / `WS` imports:

```javascript
import * as WT from "./worktree.mjs";
```

Add the two event names to the vocabulary at `scripts/scheduler.mjs:105`:

```javascript
  "scheduler.worktree_created", "scheduler.worktree_removed",
```

Immediately after the successful claim at `scripts/scheduler.mjs:529` (`emit("scheduler.task_claimed", ...)`), before `executeTask` is called at `:532`:

```javascript
      // A worker never runs in the operator's working tree. One worktree per
      // TASK — every attempt reuses it, so a retry inherits the previous
      // attempt's uncommitted work exactly as it did before.
      const base = (WS.git(repoRoot, "rev-parse", "HEAD") ?? "").trim();
      const wt = WT.ensureWorktree({ projectId, taskId: task.id, repoRoot, base });
      if (!wt.ok) {
        emit("scheduler.task_blocked", { failure: wt.code, message: clamp(wt.message, 300) }, { taskId: task.id });
        TR.transition(projectId, task.id, { to: "NEEDS_DECISION", actor: "scheduler", reason: wt.message });
        return finish("NEEDS_DECISION", { code: wt.code, message: wt.message });
      }
      if (wt.created) emit("scheduler.worktree_created", { path: wt.path, branch: wt.branch, base }, { taskId: task.id });
```

Change the `executeTask` call at `:532` to pass it:

```javascript
        projectId, taskId: task.id, wsDir, repoRoot, workRoot: wt.path, project, schedulerId: id, dir,
```

Add `workRoot` to the destructured parameters of `executeTask` (`:636`), pass it to `runAttempt` (`:679`), add it to `runAttempt`'s destructured parameters (`:784`), and pass it to `RUN.runTask` (`:958`):

```javascript
      const rec = await RUN.runTask({
        workRoot,
```

At `:786`, the phase context must report the worktree so `workflow-trace` and the projection show where work happened:

```javascript
  const ctx = { project_id: projectId, task_id: taskId, repo_root: repoRoot, work_root: workRoot, ws_dir: wsDir };
```

For the missing-worktree recovery: in `runAttempt`, before the worker starts, assert the worktree is still there:

```javascript
  const wtNow = WT.worktreeState({ projectId, taskId, repoRoot });
  if (!wtNow.exists && attempt > 1)
    return { state: "NEEDS_DECISION", failure: { code: "WORKTREE_MISSING",
      message: `the worktree for task ${taskId} is gone but attempt ${attempt} is in flight — the previous attempt's carried-forward work cannot be reconstructed, and SCH will not fabricate a baseline by recreating it` } };
```

After a task reaches `DELIVERED` or `CANCELLED` in `executeTask`, remove the checkout:

```javascript
  if (result.state === "DELIVERED" || result.state === "CANCELLED") {
    const rm = WT.removeWorktree({ projectId, taskId, repoRoot });
    emit("scheduler.worktree_removed", { removed: rm.removed, path: rm.path }, { taskId });
  }
```

Do **not** remove it on `FAILED` — the worktree is the evidence.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/scheduler.test.mjs`
Expected: PASS. Then `npm test`.

The `worktrees_changed` effect check at `scripts/runner.mjs:291` compares baseline to after **within `repoRoot`**, which is now the worktree. SCH's worktree exists before the baseline is taken, so it is invisible; a worker creating its own still trips it. If that test now fails, the baseline is being taken in the wrong directory — fix the directory, not the check.

- [ ] **Step 5: Commit**

```bash
git add scripts/scheduler.mjs tests/scheduler.test.mjs
git commit -m "feat(scheduler): the worker gets its own checkout, and the operator's tree is never touched"
```

---

### Task 5: Per-project branch namespace authorization

**Files:**
- Modify: `scripts/state.mjs` (add `delivery-branch-namespace` get/set commands and the stored field)
- Test: `tests/delivery-remote.test.mjs` (append)

**Interfaces:**
- Consumes: the project record in `$SCH_HOME/projects/<id>/state.json`
- Produces:
  - CLI: `state.mjs delivery-branch-namespace --project <id> [--set "sch/task-*"] [--revoke true]`
  - Exported: `branchNamespace(projectId)` → `{ pattern, authorized_by, authorized_at, id } | null`
  - Exported: `branchInNamespace(projectId, branch)` → boolean

- [ ] **Step 1: Write the failing tests**

Append to `tests/delivery-remote.test.mjs`:

```javascript
test("a project has no branch namespace until an operator sets one", () => {
  const fx = fixture("ns-default");
  try {
    assert.equal(STATE.branchNamespace(fx.P), null);
    assert.equal(STATE.branchInNamespace(fx.P, "sch/task-1"), false);
  } finally { fx.done(); }
});

test("an authorized namespace admits only branches that match it", () => {
  const fx = fixture("ns-set");
  try {
    fx.cli("delivery-branch-namespace", "--project", fx.P, "--set", "sch/task-*", "--approver", "test-operator");
    const ns = STATE.branchNamespace(fx.P);
    assert.equal(ns.pattern, "sch/task-*");
    assert.equal(ns.authorized_by, "test-operator");
    assert.ok(ns.id, "an authorization must have an id so a delivery can cite it");
    assert.equal(STATE.branchInNamespace(fx.P, "sch/task-12"), true);
    assert.equal(STATE.branchInNamespace(fx.P, "main"), false);
    assert.equal(STATE.branchInNamespace(fx.P, "release/1.0"), false);
    assert.equal(STATE.branchInNamespace(fx.P, "sch/task-1/../../main"), false);
  } finally { fx.done(); }
});

test("revoking the namespace closes it again", () => {
  const fx = fixture("ns-revoke");
  try {
    fx.cli("delivery-branch-namespace", "--project", fx.P, "--set", "sch/task-*", "--approver", "test-operator");
    fx.cli("delivery-branch-namespace", "--project", fx.P, "--revoke", "true");
    assert.equal(STATE.branchNamespace(fx.P), null);
    assert.equal(STATE.branchInNamespace(fx.P, "sch/task-1"), false);
  } finally { fx.done(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/delivery-remote.test.mjs`
Expected: FAIL — `STATE.branchNamespace is not a function`.

- [ ] **Step 3: Write the implementation**

In `scripts/state.mjs`, add near the other delivery helpers:

```javascript
// Creating a remote branch is an explicit decision. It stays explicit — but the
// decision is made ONCE PER PROJECT over a namespace, not once per task. A gate
// per task would make the queue stop on every single first push, which is the
// autonomy this milestone exists to enable.
export function branchNamespace(projectId) {
  const st = readProjectState(projectId);
  const ns = st?.delivery?.branch_namespace ?? null;
  return ns && ns.pattern ? ns : null;
}

export function branchInNamespace(projectId, branch) {
  return WT.branchMatchesNamespace(branchNamespace(projectId), branch);
}
```

`state.mjs` already imports `worktree.mjs`-adjacent leaf modules; add `import * as WT from "./worktree.mjs";` to its imports.

The matcher itself goes in `scripts/worktree.mjs` as a **pure function taking the namespace record**, not the project id. This matters: `delivery.mjs` needs it too, and `state.mjs` is a 132KB module that other things import — a `delivery.mjs → state.mjs` edge risks a cycle. A leaf module with no state access cannot create one.

Add to `scripts/worktree.mjs`:

```javascript
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
```

Replace `readProjectState` / `mutateProjectState` with whatever the surrounding code already uses to read and write `projects/<id>/state.json` — read the file first and follow its existing accessors rather than introducing a second pair.

Add the CLI command to the dispatch table in `scripts/state.mjs`, following the shape of the neighbouring `delivery-approve` command:

```javascript
  "delivery-branch-namespace": (a) => {
    const projectId = req(a, "project");
    if (a.revoke === "true") {
      mutateProjectState(projectId, (st) => { delete (st.delivery ??= {}).branch_namespace; });
      return "revoked";
    }
    if (!a.set) return JSON.stringify(branchNamespace(projectId), null, 2);
    const pattern = String(a.set);
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*\*?$/.test(pattern) || (pattern.match(/\*/g) ?? []).length > 1)
      throw new Error(`"${pattern}" is not a usable branch namespace — one trailing "*" at most`);
    const rec = {
      id: "BNS-" + randomUUID().slice(0, 8), pattern,
      authorized_by: String(a.approver ?? "unknown"), authorized_at: new Date().toISOString(),
    };
    mutateProjectState(projectId, (st) => { (st.delivery ??= {}).branch_namespace = rec; });
    audit(projectId, "delivery.branch_namespace_authorized", rec);
    return rec.id;
  },
```

Use the file's existing `req`, `mutateProjectState`, `audit` and `randomUUID` equivalents — read them before writing, do not invent names.

Register the command in `sch-commands` so the `/SCH` router and the dashboard cannot drift from it, matching how the neighbouring delivery commands are registered.

- [ ] **Step 4: Document the command so `validate` stays green**

`scripts/validate.mjs` checks the README's CLI reference against the real command table, so a new command with no README line fails the build. Add the line in this task, beside the other `delivery-*` entries in the README's "Full CLI reference" block:

```
delivery-branch-namespace --project <id> [--set "sch/task-*" --approver <you>] [--revoke true]
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/delivery-remote.test.mjs`
Expected: PASS.

Run: `npm run validate`
Expected: PASS. If it still fails on the command table, the command is registered under a different name than the README line — make them match rather than loosening the check.

- [ ] **Step 6: Commit**

```bash
git add scripts/state.mjs scripts/worktree.mjs tests/delivery-remote.test.mjs README.md
git commit -m "feat(delivery): authorize a branch namespace once per project, not one gate per task"
```

---

### Task 6: Delivery creates the remote branch inside the namespace

**Files:**
- Modify: `scripts/delivery.mjs:288-290` (accept `workRoot`), `scripts/delivery.mjs:721-724` (the conditional stop), `scripts/delivery.mjs:753-756` (first-push refspec)
- Test: `tests/delivery-remote.test.mjs` (append)

**Interfaces:**
- Consumes: `WT.branchMatchesNamespace(ns, branch)` from Task 5 (the pure matcher in `scripts/worktree.mjs`). `delivery.mjs` reads the namespace record from the project state it **already loads** at `:288` — `project.delivery?.branch_namespace` — so no new import of `state.mjs` and no import cycle.
- Produces: `DEL.deliverRun({ projectId, runId, workRoot })`; delivery event `delivery.remote_branch_created` carrying `{ branch, namespace_id }`

- [ ] **Step 1: Write the failing tests**

Append to `tests/delivery-remote.test.mjs`:

```javascript
test("a first push inside the namespace creates the remote branch and sets upstream", async () => {
  const fx = fixture("ns-first-push");
  try {
    initWorkspace(fx);
    const bare = withRemote(fx);
    fx.cli("delivery-branch-namespace", "--project", fx.P, "--set", "sch/task-*", "--approver", "test-operator");
    const t = addTask(fx);
    const alt = join(fx.home, "wt-" + t);
    git(fx.repo, "worktree", "add", alt, "-b", `sch/task-${t}`, "HEAD");

    const rec = await verifiedRun(fx, t, {
      edits: [{ path: "src/app.js", content: "// delivered from a worktree\n" }],
      handoff: { status: "COMPLETE", summary: "done", files_changed: ["src/app.js"] },
    });
    approve(fx, rec.run_id);
    const d = deliver(fx, rec.run_id, { workRoot: alt });

    assert.equal(d.state, "DELIVERED", JSON.stringify(d.failure ?? d));
    const remoteRefs = execFileSync("git", ["ls-remote", "--heads", bare], { encoding: "utf8" });
    assert.ok(remoteRefs.includes(`refs/heads/sch/task-${t}`), "the task branch must exist on the remote");
  } finally { fx.done(); }
});

test("a first push outside the namespace still stops with UPSTREAM_CHANGED", async () => {
  const fx = fixture("ns-outside");
  try {
    initWorkspace(fx);
    withRemote(fx);
    fx.cli("delivery-branch-namespace", "--project", fx.P, "--set", "sch/task-*", "--approver", "test-operator");
    const t = addTask(fx);
    const alt = join(fx.home, "wt-" + t);
    git(fx.repo, "worktree", "add", alt, "-b", "hotfix/not-ours", "HEAD");

    const rec = await verifiedRun(fx, t, {
      edits: [{ path: "src/app.js", content: "// off-namespace\n" }],
      handoff: { status: "COMPLETE", summary: "done", files_changed: ["src/app.js"] },
    });
    approve(fx, rec.run_id);
    const d = deliver(fx, rec.run_id, { workRoot: alt });

    assert.notEqual(d.state, "DELIVERED");
    assert.equal(d.failure?.code ?? d.stop_reason, "UPSTREAM_CHANGED");
  } finally { fx.done(); }
});
```

Add `execFileSync` from `node:child_process` and `withRemote`, `verifiedRun`, `approve`, `deliver` from `./helpers.mjs` to the imports if not already present.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/delivery-remote.test.mjs`
Expected: FAIL — the first test stops with `UPSTREAM_CHANGED` because the namespace is not consulted.

- [ ] **Step 3: Write the implementation**

At `scripts/delivery.mjs:288-290`, accept the override the same way the runner does:

```javascript
  const ws = WS.validateWorkspace({ projectId, repoPath: project.path });
  const root = workRoot ? WS.repositoryRoot(workRoot) : ws.root;
  if (workRoot && !root) return { ok: false, failure: { code: "WORKSPACE_INVALID", message: `workRoot ${workRoot} is not a git repository` } };
  return { ok: true, project, repoRoot: root, wsDir: ws.dir };
```

Thread `workRoot` from `deliverRun`'s options into that resolver. Every other `repoRoot` use in the file follows automatically.

At `scripts/delivery.mjs:721-724`, make the stop conditional:

```javascript
    const ns = project.delivery?.branch_namespace ?? null;
    const nsOk = !remoteHead && WT.branchMatchesNamespace(ns, tx.remote_branch);
    if (!remoteHead && !nsOk)
      return stop("UPSTREAM_CHANGED",
        `"${tx.remote_branch}" does not exist on "${tx.remote}". Commit ${hash} is created locally and NOT pushed — creating a remote branch is an explicit decision, not something SCH does on your behalf.\n` +
        `  authorize a namespace: node scripts/state.mjs delivery-branch-namespace --project ${projectId} --set "sch/task-*" --approver <you>`,
        { commit: tx.commit });
```

Two checks that follow assume a remote branch exists. Wrap **only** those two in `if (remoteHead)`, leaving both message strings exactly as they are in the file today — copy them verbatim, do not rewrite them:

```javascript
    if (remoteHead) {
      if (incoming.length)
        return stop("INCOMING_COMMITS_PRESENT", <the existing message, unchanged>, { commit: tx.commit });
      if (mergeBase !== remoteHead)
        return stop("NON_FAST_FORWARD", <the existing message, unchanged>, { commit: tx.commit });
    }
```

The two `UNRELATED_OUTGOING_COMMITS` checks at `:731` and `:735` stay **outside** that guard and stay unchanged: exactly one outgoing commit is required on a first push too.

But on a first push `outgoing` came from `rev-list HEAD` at `:710` — every commit on the branch — so `outgoing.length !== 1` would reject a legitimate first push of a branch with any history. Fix it at the source. Replace the `else` branch at `:709-712`:

```javascript
    } else {
      // No remote branch. What counts as "outgoing" is what this branch adds on
      // top of the base it forked from — not its entire history.
      const baseRef = `${tx.remote}/${tx.base_remote_branch}`;
      const forkPoint = C.gitOut(repoRoot, "merge-base", "HEAD", baseRef);
      outgoing = forkPoint
        ? (C.gitOut(repoRoot, "rev-list", `${forkPoint}..HEAD`) ?? "").split("\n").filter(Boolean)
        : (C.gitOut(repoRoot, "rev-list", "HEAD") ?? "").split("\n").filter(Boolean);
      ahead = outgoing.length;
    }
```

`tx.base_remote_branch` is new and is recorded at preflight, in the same block that pins `remote` and `remote_branch` at `:466-490`. It is the branch the task worktree forked from — the project's own branch, which is what `WS.git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD")` returned in the **main** repository when the scheduler created the worktree (Task 4 already computes `base` there). Pass it into the delivery transaction alongside `remote_branch`, defaulting to the remote's default branch via `git symbolic-ref --short refs/remotes/<remote>/HEAD` with the leading `<remote>/` stripped, and to `remote_branch` if that is also absent.

If `forkPoint` is null the fallback above preserves today's behavior exactly, so a repository with no shared history still fails closed on the outgoing-count check rather than pushing something unexamined.

Record the creation, immediately before the push at `:752`:

```javascript
    if (nsOk) {
      const ns = ST.branchNamespace(projectId);
      ev("delivery.remote_branch_created", { branch: tx.remote_branch, namespace_id: ns?.id ?? null, namespace: ns?.pattern ?? null });
    }
```

Add `delivery.remote_branch_created` to the delivery event vocabulary alongside the existing `delivery.*` names.

Set upstream on a first push by extending the refspec call at `:756`:

```javascript
    const push = C.gitRun(repoRoot, nsOk
      ? ["push", "--set-upstream", tx.remote, refspec]
      : ["push", tx.remote, refspec]);
```

Confirm `assertSafeGitArgs` permits `--set-upstream`. If it does not, add it to the permitted push flags and add a test asserting `--force` and `--force-with-lease` are still refused.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/delivery-remote.test.mjs`
Expected: PASS. Then `npm test` — `delivery-binding.test.mjs` and `hardening.test.mjs` must stay green, especially any test asserting which git argv shapes are refused.

- [ ] **Step 5: Commit**

```bash
git add scripts/delivery.mjs tests/delivery-remote.test.mjs
git commit -m "feat(delivery): a task branch may create its own remote ref, inside an authorized namespace only"
```

---

### Task 7: The honest boundary — known-gap test and documentation

**Files:**
- Create: `tests/containment.test.mjs`
- Modify: `README.md` (the "Worker containment: what is not true yet" section, and the CLI reference), `SCH-LOOP.md`, `docs/adr/0004-contained-worker-execution.md` (create)
- Test: `tests/containment.test.mjs`

**Interfaces:**
- Consumes: everything above
- Produces: nothing new — this task proves the claims and narrows the documented caveats to exactly what remains true

- [ ] **Step 1: Write the tests**

Create `tests/containment.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, fakeQueueEnv, runQueue, git, EXEC } from "./helpers.mjs";

test("KNOWN GAP: a write outside the worktree is neither prevented nor detected", async () => {
  const fx = fixture("gap-outside");
  const outside = mkdtempSync(join(tmpdir(), "sch-outside-"));
  const victim = join(outside, "evidence.txt");
  try {
    initWorkspace(fx);
    const t = addTask(fx);
    await runQueue(fx, {
      env: fakeQueueEnv(fx, { [t]: {
        writeAbsolute: [{ path: victim, content: "a worker wrote here\n" }],
        edits: [{ path: "src/app.js", content: "// in scope\n" }],
        handoff: { status: "COMPLETE", summary: "done", files_changed: ["src/app.js"] },
      } }),
      maxTasks: 1,
    });
    // This assertion documents a LIMITATION, not a feature. If it ever starts
    // failing because the write was blocked, that is real containment arriving —
    // delete this test and say so in the README.
    assert.equal(existsSync(victim), true,
      "post-run inspection compares the repository only; a write outside it is invisible");
  } finally { fx.done(); }
});

test("a worker cannot push: no credential helper is available to it", () => {
  const env = EXEC.buildEnv(process.env, EXEC.GIT_CREDENTIAL_STRIP);
  assert.equal(env.GIT_CONFIG_VALUE_0, "");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
});

test("a worker that creates its own worktree trips worktrees_changed", async () => {
  const fx = fixture("worker-made-worktree");
  try {
    initWorkspace(fx);
    const t = addTask(fx);
    const res = await runQueue(fx, {
      env: fakeQueueEnv(fx, { [t]: {
        gitCommands: [["worktree", "add", join(fx.home, "worker-own-wt"), "-b", "worker-branch", "HEAD"]],
        edits: [{ path: "src/app.js", content: "// and a worktree of my own\n" }],
        handoff: { status: "COMPLETE", summary: "done", files_changed: ["src/app.js"] },
      } }),
      maxTasks: 1,
    });
    assert.match(JSON.stringify(res), /worktrees_changed|FORBIDDEN_GIT_EFFECT/,
      "SCH's own worktree is in the baseline; one the worker creates is not");
  } finally { fx.done(); }
});

test("a full queue run leaves the main working tree byte-identical", async () => {
  const fx = fixture("main-tree-intact");
  try {
    initWorkspace(fx);
    const t = addTask(fx);
    const before = execFileSync("git", ["-C", fx.repo, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
    const appBefore = readFileSync(join(fx.repo, "src", "app.js"), "utf8");

    await runQueue(fx, {
      env: fakeQueueEnv(fx, { [t]: {
        edits: [{ path: "src/app.js", content: "// queue built this\n" }],
        handoff: { status: "COMPLETE", summary: "done", files_changed: ["src/app.js"] },
      } }),
      maxTasks: 1,
    });

    assert.equal(readFileSync(join(fx.repo, "src", "app.js"), "utf8"), appBefore);
    assert.equal(execFileSync("git", ["-C", fx.repo, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), before);
  } finally { fx.done(); }
});
```

Two behaviour keys must be supported by `tests/fixtures/fake-claude.mjs`. Read that file; if either is absent, add it mirroring how the existing `edits` key is handled:

- `writeAbsolute: [{ path, content }]` — writes to that absolute path, outside the worktree.
- `gitCommands: [[...argv]]` — runs `git -C <cwd> ...argv` in the worker's own working directory, so a test can make the worker attempt a git operation SCH must catch.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/containment.test.mjs`
Expected: FAIL on the third test if Tasks 3–4 are incomplete, and on the first if `writeAbsolute` is unsupported.

- [ ] **Step 3: Make them pass, then write the documentation**

The tests should pass once Tasks 1–6 are done and `writeAbsolute` exists in the fake worker.

Then rewrite the README's **"Worker containment: what is not true yet"** section. It currently says workers "run as your user, in your repository". The first clause stays true, the second no longer is. Replace with:

```markdown
### Worker containment: what is and is not true

True now:

- **A worker never runs in your working tree.** Every task gets a disposable git
  worktree on `sch/task-<n>`, outside the repository and outside `SCH_HOME`. Your
  working tree is byte-identical after a queue run, and a test asserts it.
- **A worker has no git credentials.** `credential.helper` is disabled in its
  environment and `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_ASKPASS`, `SSH_AUTH_SOCK` and
  `SSH_AGENT_PID` never reach it. It cannot push.
- **Only the delivery controller pushes**, and only to a branch inside a
  namespace an operator authorized for that project.

Still NOT true, and each is asserted as a known gap in `tests/containment.test.mjs`:

- **Workers are not OS-sandboxed.** They run as your user with your PATH.
- **A write outside the worktree is neither prevented nor detected.** Effect
  inspection compares the worktree before and after; anything else is invisible.
- **Network access is unrestricted.**
- **A process that detaches into a new session survives the tree-kill.**
- **Therefore fully unattended operation is still not supported.** This milestone
  narrows the blast radius. It is not isolation, and the authenticated control
  plane and supervisor daemon inherit these caveats.
```

Update `SCH-LOOP.md`'s corresponding paragraph — currently "**Workers are still not OS-sandboxed**, post-run inspection cannot see writes outside the repository..." — to match, and add the worktree and namespace facts.

The README's CLI reference line for `delivery-branch-namespace` was already added in Task 5 — do not add it twice.

Create `docs/adr/0004-contained-worker-execution.md` following the shape of the three existing ADRs: the decision (disposable worktree, credentials stripped, namespace authorization), the alternatives rejected (Docker, a second Windows user, WSL2 — with the reason each was deferred, copied from the spec's section 1), and the consequences (commits land on task branches, `main` no longer advances on its own, integration is a later milestone).

- [ ] **Step 4: Run the full check**

Run: `npm run check`
Expected: PASS. `validate.mjs` verifies README accuracy against the command table, so the CLI reference addition from Task 5 is confirmed here.

- [ ] **Step 5: Commit**

```bash
git add tests/containment.test.mjs tests/fixtures/fake-claude.mjs README.md SCH-LOOP.md docs/adr/0004-contained-worker-execution.md
git commit -m "docs(containment): narrow the caveat to what is still true, and test the gap that remains"
```

---

## Out of scope for this plan

Network restriction. Prevention of writes outside the worktree. Docker or second-user containment providers. Integration of task branches back to the mainline. Parallel execution — the queue still runs one task at a time.
