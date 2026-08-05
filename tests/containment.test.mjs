// The honest boundary.
//
// Every other test file asserts that something WORKS. This one exists to keep
// the README truthful in both directions: what containment now provides, and —
// deliberately, in an executable form — what it still does not. A limitation
// nobody tests is a limitation that quietly becomes a claim.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, fakeQueueEnv, runQueue, EXEC, RUN } from "./helpers.mjs";
import { ROOT as _R, url as _u } from "./helpers.mjs";
const PACK = await import(_u(_R + "/scripts/pack.mjs"));
const WT = await import(_u(_R + "/scripts/worktree.mjs"));

test("KNOWN GAP: a write outside the worktree is neither prevented nor detected", async () => {
  const fx = fixture("gap-outside");
  const outside = mkdtempSync(join(tmpdir(), "sch-outside-"));
  const victim = join(outside, "outside-the-worktree.canary");
  try {
    initWorkspace(fx);
    const t = addTask(fx);
    const res = await runQueue(fx, {
      env: fakeQueueEnv(fx, { [t]: {
        writeAbsolute: [{ path: victim, content: "a worker wrote here\n" }],
        write: [{ path: "src/app.js", content: "// in scope\n" }],
      } }),
      maxTasks: 1,
    });
    // These two assertions document a LIMITATION, not a feature. If either ever
    // starts failing because the write was blocked or reported, that is real
    // containment arriving — delete this test and say so in the README.
    assert.equal(existsSync(victim), true,
      "nothing prevents a worker from writing outside its worktree");
    // "Not detected" is asserted against `git-effects.json` — the artifact effect
    // inspection actually writes — and NOT against the scheduler's return value,
    // whose contents depend on which path the run stopped on and which would go
    // vacuous the moment that changed. The in-scope write is the POSITIVE
    // CONTROL, read from the same file in the same breath: it proves this is
    // reading the artifact, so "the canary is absent" means undetected rather
    // than unread.
    const runId = res.tasks[0].attempt_records[0].run_id;
    const effects = JSON.stringify(RUN.readRun(fx.P, runId).effects);
    assert.ok(effects.includes("src/app.js"),
      "positive control: the in-worktree write IS in git-effects.json");
    assert.ok(!effects.includes("outside-the-worktree.canary"),
      "effect inspection compares the worktree only; a write outside it is invisible");
  } finally { fx.done(); rmSync(outside, { recursive: true, force: true }); }
});

// Not "a worker cannot push" — this proves no AMBIENT helper or token is
// constructed for a bounded child, which is a different and smaller claim. A
// worker that re-adds one with `git -c credential.helper=…` is not stopped, and
// the README says so.
test("no ambient credential helper or token reaches a bounded child", () => {
  const env = EXEC.buildEnv(process.env, EXEC.GIT_CREDENTIAL_STRIP);
  assert.equal(env.GIT_CONFIG_VALUE_0, "");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GIT_ASKPASS, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.SSH_AGENT_PID, undefined);
});

// An auditor asking "did this worker have GH_TOKEN?" must get an answer about
// the environment that existed. The record used to be RECOMPUTED from a
// different extra object than the executor passed the child, so it silently
// omitted the credential strip and the SCH identity vars — a wrong answer, on
// the exact surface this milestone hardened.
test("worker.json lists the environment the child actually received", async () => {
  const fx = fixture("worker-env-record");
  try {
    initWorkspace(fx);
    const t = addTask(fx);
    const res = await runQueue(fx, {
      env: fakeQueueEnv(fx, { [t]: { write: [{ path: "src/app.js", content: "// in scope\n" }] } }),
      maxTasks: 1,
    });
    const runId = res.tasks[0].attempt_records[0].run_id;
    const names = JSON.parse(readFileSync(join(RUN.readRun(fx.P, runId).dir, "worker.json"), "utf8")).environment_names;
    for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "SCH_RUN_ID", "SCH_PROJECT_ID", "SCH_TASK_ID", "SCH_ATTEMPT"])
      assert.ok(names.includes(k), `${k} reached the child and must be in the record — got ${names.join(",")}`);
    assert.ok(!names.includes("SCH_HOME"), "and nothing that did not reach it");
    assert.ok(!names.includes("GH_TOKEN"));
  } finally { fx.done(); }
});

test("a worker that creates its own worktree trips worktrees_changed", async () => {
  const fx = fixture("worker-made-worktree");
  try {
    initWorkspace(fx);
    const t = addTask(fx);
    const res = await runQueue(fx, {
      env: fakeQueueEnv(fx, { [t]: {
        git: [["worktree", "add", join(fx.home, "worker-own-wt"), "-b", "worker-branch", "HEAD"]],
        write: [{ path: "src/app.js", content: "// and a worktree of my own\n" }],
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
        write: [{ path: "src/app.js", content: "// queue built this\n" }],
      } }),
      maxTasks: 1,
    });

    assert.equal(readFileSync(join(fx.repo, "src", "app.js"), "utf8"), appBefore);
    assert.equal(execFileSync("git", ["-C", fx.repo, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), before);
  } finally { fx.done(); }
});

test("the argv SCH launches a worker with suppresses the operator's catalogue", () => {
  const args = PACK.workerArgs({ packPath: "X" });
  assert.equal(args[args.indexOf("--setting-sources") + 1], "project");
  assert.ok(args.includes("Skill(schedule)"));
  assert.ok(!args.includes("--bare"));
});

test("KNOWN GAP: denying a built-in blocks invocation but not listing", () => {
  // Probed against the real CLI: `--disallowed-tools "Skill(init)"` returns
  // "Skill execution blocked by permission rules" on invocation, while the name
  // still appears in the worker's skill list. So a denied built-in still costs
  // context. There is no flag that removes it without removing the pack too.
  //
  // This asserts the SHAPE of the mitigation, not the CLI's behaviour — the
  // suite is hermetic and never invokes a real model. If a future CLI stops
  // listing denied skills, this comment is what tells you the README's residual
  // can be deleted.
  assert.ok(PACK.deniedBuiltins().length > 0,
    "denial is by name, so the names are known and still listed");
});
