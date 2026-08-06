// The honest boundary.
//
// Every other test file asserts that something WORKS. This one exists to keep
// the README truthful in both directions: what containment now provides, and —
// deliberately, in an executable form — what it still does not. A limitation
// nobody tests is a limitation that quietly becomes a claim.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, delimiter, isAbsolute } from "node:path";
import { fixture, initWorkspace, addTask, fakeQueueEnv, runQueue, EXEC, RUN } from "./helpers.mjs";
import { ROOT as _R, url as _u } from "./helpers.mjs";
const PACK = await import(_u(_R + "/scripts/pack.mjs"));
const WT = await import(_u(_R + "/scripts/worktree.mjs"));

// Narrower than it once was. A write into SCH's own territory — the main
// repository, a sibling task's checkout — IS detected now and fails the run as
// OUTSIDE_WORKTREE_WRITE (tests/worker.test.mjs). What remains uncovered is
// everywhere else on the disk, which is what this canary sits in.
test("KNOWN GAP: a write outside SCH's territory is neither prevented nor detected", async () => {
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

// ---------------------------------------------------------------- the PATH

// The operator's PATH is the only allowlisted value that names places to load
// EXECUTABLE CODE from, and it is handed to the child verbatim. A relative
// entry there resolves against the CHILD'S working directory — which for a
// verification command is the worktree the worker just finished writing. So
// `PATH=node_modules/.bin:...` plus a worker that writes `node_modules/.bin/npm`
// decides what SCH's own `npm test` means.
//
// Measured, not assumed (Windows, Node 24 / libuv): a bare executable name is
// NOT looked up in the child's cwd, and an EMPTY PATH entry is ignored — but a
// literal "." IS honoured and resolves against the child's cwd.
test("a relative PATH entry never reaches a bounded child", () => {
  const parent = { PATH: [".", "node_modules/.bin", "", "relative/bin"].join(delimiter) };
  const entries = EXEC.buildEnv(parent).PATH.split(delimiter);
  assert.deepEqual(entries.filter(Boolean), [],
    "a child's cwd is worker-controlled, so a PATH entry relative to it is worker-controlled too");
});

test("absolute PATH entries are preserved exactly, in order", () => {
  const abs = process.platform === "win32"
    ? ["C:\\Windows\\System32", "C:\\Program Files\\Git\\cmd", "\\\\server\\share\\bin"]
    : ["/usr/local/bin", "/usr/bin", "/bin"];
  const parent = { PATH: [abs[0], ".", abs[1], "", abs[2]].join(delimiter) };
  assert.deepEqual(EXEC.buildEnv(parent).PATH.split(delimiter), abs,
    "narrowing PATH must remove only what cannot legitimately be there");
});

test("SCH resolves its own executables from absolute PATH entries only", () => {
  // Same hazard one level up: `resolveExecutable` joins each PATH entry with the
  // command name and stats it, so a relative entry is resolved against SCH's own
  // cwd — the managed repository.
  //
  // The canary lives UNDER the current directory, not in the system temp
  // directory: `path.relative` across Windows drive letters returns an absolute
  // path, so a tmpdir-based relative entry silently stops being relative and the
  // test passes without exercising anything. The absolute lookup below is the
  // positive control — it proves the canary is findable, so `null` from the
  // relative form means REFUSED rather than "not there".
  const rel = "sch-relpath.tmp";                 // gitignored by `*.tmp`
  const d = join(process.cwd(), rel);
  try {
    mkdirSync(d, { recursive: true });
    const canary = join(d, "sch-canary");
    writeFileSync(canary, "");
    assert.equal(isAbsolute(rel), false, "precondition: the entry under test is relative");
    assert.equal(EXEC.resolveExecutable("sch-canary", { PATH: d, PATHEXT: ".EXE" }), canary,
      "positive control: an absolute entry finds the canary");
    assert.equal(EXEC.resolveExecutable("sch-canary", { PATH: rel, PATHEXT: ".EXE" }), null,
      "the same directory, named relatively, must be refused");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ------------------------------------------------- what the OS already gives

// The one OS-level containment property SCH actually has, and it is inherited
// rather than built: on Windows every process libuv spawns is assigned to a
// global Job Object created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so when the
// SCH process dies the bounded children die with it — no tree walk, no
// cooperation, no chance for SCH to run cleanup code first.
//
// It hangs entirely on `detached` being FALSE on win32 in the spawn options, and
// nothing else asserts that. Flip that one boolean "for symmetry with POSIX" and
// orphan cleanup disappears silently. Hence this test, which kills the SCH-side
// process with NO tree walk and asks the OS what happened.
test("win32: killing SCH kills its bounded children, with no tree walk", { skip: process.platform !== "win32" }, async () => {
  const d = mkdtempSync(join(tmpdir(), "sch-joblimit-"));
  const pidFile = join(d, "pids.json");
  const alive = (pid) => {
    try { return execFileSync("tasklist", ["/FI", `PID eq ${pid}`], { encoding: "utf8" }).includes(String(pid)); }
    catch { return false; }
  };
  let pids = null;
  try {
    // A stand-in for SCH: it starts one child through the REAL bounded
    // subprocess implementation, and one that deliberately detaches.
    writeFileSync(join(d, "host.mjs"), `
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const SUB = await import(${JSON.stringify(_u(_R + "/scripts/subprocess.mjs"))});
const idle = ["-e", "setTimeout(() => {}, 600000)"];
let bounded = null;
SUB.runProcess({ exe: process.execPath, args: idle, timeoutMs: 600000,
                 onStart: (c) => { bounded = c.pid; tryWrite(); } });
// A worker that leaves the job on purpose. DETACHED_PROCESS + the job's
// SILENT_BREAKAWAY_OK is all it takes.
const escapee = spawn(process.execPath, idle, { stdio: "ignore", detached: true, windowsHide: true });
escapee.unref();
function tryWrite() {
  if (bounded && escapee.pid) writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ bounded, escapee: escapee.pid }));
}
escapee.on("spawn", tryWrite);
setTimeout(() => {}, 600000);
`);
    const host = spawn(process.execPath, [join(d, "host.mjs")], { stdio: "ignore", windowsHide: true });
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    pids = JSON.parse(readFileSync(pidFile, "utf8"));
    assert.ok(alive(pids.bounded), "precondition: the bounded child is running");

    // No /T. Nothing walks the tree. Only the OS can kill the children now.
    execFileSync("taskkill", ["/PID", String(host.pid), "/F"], { stdio: "pipe" });
    for (let i = 0; i < 60 && alive(pids.bounded); i++) await new Promise((r) => setTimeout(r, 100));

    assert.equal(alive(pids.bounded), false,
      "the bounded child must not outlive SCH — libuv's job object is kill-on-close, and `detached` must stay false on win32");
    // The limitation, in the same breath: this is not a boundary a worker
    // cannot cross. It is cleanup a cooperative worker cannot avoid.
    assert.equal(alive(pids.escapee), true,
      "KNOWN GAP: a child that spawns detached breaks out of the job and survives SCH");
  } finally {
    for (const pid of Object.values(pids ?? {}))
      try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "pipe" }); } catch {}
    rmSync(d, { recursive: true, force: true });
  }
});
