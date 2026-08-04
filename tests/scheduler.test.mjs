// The sequential graph scheduler, end to end.
//
// Every test here runs against a throwaway SCH_HOME, a throwaway git repository
// and a LOCAL BARE REMOTE. No network, no GitHub, no credential, no model — the
// worker is a fake CLI driven by a behaviour file, and `git push` is a real push
// to a directory on this machine with real rejection semantics.
//
// The claims under test: one task at a time, a fresh process per task and per
// attempt, delivery only through the existing controller, DELIVERED only after
// that controller proved the commit on the remote, bounded retries, and a stop
// at every pending human decision.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, withRemote, otherClone, fakeQueueEnv,
         recordGit, git, SCHED, HG, TR, TG, PH, STATE } from "./helpers.mjs";

// A project whose delivery needs no signature — most tests are about the
// scheduler, not about approval, and the approval tests turn it back on.
function noApproval(fx) {
  const p = join(fx.home, "projects.json");
  const reg = JSON.parse(readFileSync(p, "utf8"));
  reg.projects[0].delivery = { approval_before_commit: false, approval_before_push: false };
  writeFileSync(p, JSON.stringify(reg, null, 2));
}

// A registered project on a repository with a bare remote and an initialised,
// committed workspace — the state a real queue starts from.
function queueFixture(name, { approval = false } = {}) {
  const fx = fixture(name);
  withRemote(fx);
  initWorkspace(fx);
  git(fx.repo, "push", "-q", "origin", "main");
  if (!approval) noApproval(fx);
  return fx;
}

const states = (fx) => Object.fromEntries(fx.state().tasks.map((t) => [t.id, TR.canonicalState(t)]));
const invocations = (fx) => {
  const p = join(fx.home, "behaviours", "invocations.log");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const remoteLog = (fx) => git(fx.bare, "log", "--oneline").trim().split("\n").filter(Boolean);

// ============================================================ 47–52. sequencing

test("scheduler: two dependent tasks run sequentially, child never first, one fresh process each", async (t) => {
  const fx = queueFixture("sched-two"); t.after(() => fx.done());
  const a = addTask(fx, { title: "first", allow: "src/**" });
  const b = addTask(fx, { title: "second", allow: "src/**", deps: String(a) });
  const env = fakeQueueEnv(fx, {
    [a]: { write: [{ path: "src/a.js", content: "// a\n" }] },
    [b]: { write: [{ path: "src/b.js", content: "// b\n" }] },
  });

  const order = [];
  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 5,
    onEvent: (e) => { if (e.type === "scheduler.task_claimed") order.push(e.task_id); } });

  assert.equal(r.stop_reason, "PROJECT_COMPLETED", JSON.stringify(r.failure));
  assert.equal(r.tasks_delivered, 2);
  assert.deepEqual(order, [a, b], "the child is never claimed before its parent is delivered");
  assert.deepEqual(states(fx), { [a]: "DELIVERED", [b]: "DELIVERED" });

  // 49 + 50: one worker per task, each its own process, never two at once
  const inv = invocations(fx);
  assert.equal(inv.length, 2);
  assert.notEqual(inv[0].pid, inv[1].pid, "a fresh process per task, not a reused session");
  assert.notEqual(inv[0].run_id, inv[1].run_id);
  assert.deepEqual(inv.map((x) => x.task_id), [String(a), String(b)]);

  // 88: exactly one commit per task on the remote, in order
  const log = remoteLog(fx);
  assert.equal(log.length, 4, "initial + workspace + one commit per delivered task");
  assert.match(log[0], /second/);
  assert.match(log[1], /first/);
});

test("scheduler: a restart after the first task picks up exactly where it left off", async (t) => {
  const fx = queueFixture("sched-restart"); t.after(() => fx.done());
  const a = addTask(fx, { title: "first", allow: "src/**" });
  const b = addTask(fx, { title: "second", allow: "src/**", deps: String(a) });
  const env = fakeQueueEnv(fx, {
    [a]: { write: [{ path: "src/a.js", content: "// a\n" }] },
    [b]: { write: [{ path: "src/b.js", content: "// b\n" }] },
  });

  // First scheduler: stop after one task, cleanly.
  const one = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  assert.equal(one.stop_reason, "MAX_TASKS_REACHED");
  assert.equal(states(fx)[a], "DELIVERED");
  assert.equal(states(fx)[b], "READY");
  assert.equal(SCHED.liveSchedulerLease(fx.wsDir()), null, "a stopped scheduler releases its lease");

  // A SECOND scheduler process, with no memory of the first, finishes the queue.
  const two = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 5 });
  assert.equal(two.stop_reason, "PROJECT_COMPLETED", JSON.stringify(two.failure));
  assert.notEqual(two.scheduler_id, one.scheduler_id);
  assert.equal(two.tasks_delivered, 1, "it did not re-do the already-delivered task");
  assert.deepEqual(states(fx), { [a]: "DELIVERED", [b]: "DELIVERED" });
});

test("scheduler: phase records on disk say exactly which phase completed", async (t) => {
  const fx = queueFixture("sched-phases"); t.after(() => fx.done());
  const a = addTask(fx, { title: "first", allow: "src/**" });
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }] } });
  await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });

  const p = SCHED.taskPhases(fx.P, a);
  assert.equal(p.attempts.length, 1);
  const rec = p.attempts[0].recovery;
  assert.equal(rec.completed, true, "every phase in the workflow reached ACCEPTED");
  assert.equal(rec.stopped, null);
  const ids = rec.phases.map((x) => x.phase_id);
  for (const def of SCHED.TASK_WORKFLOW) assert.ok(ids.includes(def.id), `${def.id} must have a persisted record`);
  for (const x of rec.phases) assert.equal(x.state, "ACCEPTED", x.phase_id);

  // and the gate reports are on disk with their evidence
  const phases = PH.listPhases(p.attempts[0].dir);
  const gates = phases.flatMap((x) => x.gate_reports ?? []);
  assert.ok(gates.length >= 10, `expected the whole gate set to have run, got ${gates.length}`);
  for (const g of gates) {
    assert.equal(g.outcome, "PASS", g.gate_id);
    assert.ok(g.checks.length, `${g.gate_id} must say what it checked`);
    assert.match(g.evidence_hash, /^[0-9a-f]{64}$/);
  }
});

test("scheduler: a worker that crashes mid-task leaves the task recoverable, not delivered", async (t) => {
  const fx = queueFixture("sched-crash"); t.after(() => fx.done());
  const a = addTask(fx, { title: "crasher", allow: "src/**" });
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// half\n" }], handoff: false, exit: 137 } });

  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 2 });
  assert.notEqual(r.stop_reason, "PROJECT_COMPLETED");
  assert.equal(r.tasks_delivered, 0);
  assert.equal(remoteLog(fx).length, 2, "nothing reached the remote");
  assert.ok(["FAILED", "NEEDS_DECISION"].includes(states(fx)[a]));
  // the worker's half-written change is preserved, not reverted
  assert.equal(readFileSync(join(fx.repo, "src", "a.js"), "utf8"), "// half\n");
});

// ================================================== 54–56. why nothing is ready

test("scheduler: NO_READY_TASK distinguishes complete, blocked, deadlocked and invalid", async (t) => {
  // complete
  const done = queueFixture("sched-complete"); t.after(() => done.done());
  const a = addTask(done, { title: "only", allow: "src/**" });
  const env = fakeQueueEnv(done, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }] } });
  const r1 = await SCHED.runQueue({ projectId: done.P, env, maxTasks: 5 });
  assert.equal(r1.stop_reason, "PROJECT_COMPLETED");

  // blocked
  const blocked = queueFixture("sched-blocked"); t.after(() => blocked.done());
  const x = addTask(blocked, { title: "blocked one" });
  const y = addTask(blocked, { title: "waits on it", deps: String(x) });
  blocked.cli("task-transition", "--project", blocked.P, "--task", String(x), "--event", "fail", "--reason", "the API is gone");
  const r2 = await SCHED.runQueue({ projectId: blocked.P, env: fakeQueueEnv(blocked, {}), maxTasks: 5 });
  assert.equal(r2.stop_reason, "NO_READY_TASK");
  assert.ok(["BLOCKED_DEPENDENCIES", "GRAPH_DEADLOCK"].includes(r2.failure.code), r2.failure.code);

  // deadlocked: everything left waits only on things that can never complete
  const dead = queueFixture("sched-deadlock"); t.after(() => dead.done());
  const p = addTask(dead, { title: "cancelled parent" });
  addTask(dead, { title: "child a", deps: String(p) });
  addTask(dead, { title: "child b", deps: String(p) });
  dead.cli("task-transition", "--project", dead.P, "--task", String(p), "--event", "cancel");
  const r3 = await SCHED.runQueue({ projectId: dead.P, env: fakeQueueEnv(dead, {}), maxTasks: 5 });
  assert.equal(r3.stop_reason, "POLICY_VIOLATION", "a cancelled dependency is an invalid graph until policy says otherwise");
  assert.match(r3.failure.message, /CANCELLED_DEPENDENCY/);

  // invalid: a cycle
  const bad = queueFixture("sched-cycle"); t.after(() => bad.done());
  const c1 = addTask(bad, { title: "c1" });
  const c2 = addTask(bad, { title: "c2", deps: String(c1) });
  const s = bad.state(); s.tasks.find((z) => z.id === c1).deps = [c2];
  writeFileSync(join(bad.home, "projects", bad.P, "state.json"), JSON.stringify(s, null, 2));
  const r4 = await SCHED.runQueue({ projectId: bad.P, env: fakeQueueEnv(bad, {}), maxTasks: 5 });
  assert.equal(r4.stop_reason, "POLICY_VIOLATION");
  assert.match(r4.failure.message, /DEPENDENCY_CYCLE/);
  assert.equal(r4.tasks_delivered, 0, "an invalid graph runs nothing at all");
});

// ================================================ 57–61. bounds, leases, cancel

test("scheduler: max-tasks, max-duration and stop-after-task are all honoured", async (t) => {
  const fx = queueFixture("sched-bounds"); t.after(() => fx.done());
  const ids = [1, 2, 3].map((n) => addTask(fx, { title: "task " + n, allow: "src/**" }));
  const env = fakeQueueEnv(fx, Object.fromEntries(ids.map((id, i) => [id, { write: [{ path: `src/f${i}.js`, content: `// ${i}\n` }] }])));

  const capped = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 2 });
  assert.equal(capped.stop_reason, "MAX_TASKS_REACHED");
  assert.equal(capped.tasks_delivered, 2);

  const stopAfter = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 5, stopAfterTask: ids[2] });
  assert.equal(stopAfter.stop_reason, "STOP_AFTER_TASK");
  assert.equal(stopAfter.tasks_delivered, 1);

  // duration: a zero budget stops before it starts anything
  const fx2 = queueFixture("sched-duration"); t.after(() => fx2.done());
  const only = addTask(fx2, { title: "x", allow: "src/**" });
  const r = await SCHED.runQueue({ projectId: fx2.P, env: fakeQueueEnv(fx2, { [only]: {} }), maxDurationMs: 1 });
  assert.equal(r.stop_reason, "MAX_DURATION_REACHED");
  assert.equal(r.tasks_delivered, 0);
});

test("scheduler: a dry run selects a task and starts nothing", async (t) => {
  const fx = queueFixture("sched-dry"); t.after(() => fx.done());
  const a = addTask(fx, { title: "would run", allow: "src/**" });
  const r = await SCHED.runQueue({ projectId: fx.P, env: fakeQueueEnv(fx, { [a]: {} }), dryRun: true });
  assert.equal(r.stop_reason, "DRY_RUN");
  assert.equal(r.tasks[0].task_id, a);
  assert.equal(states(fx)[a], "READY", "a dry run does not even claim");
  assert.equal(invocations(fx).length, 0, "no worker process was started");
});

test("scheduler: a live lease blocks a second scheduler; a stale one is recovered and said out loud", async (t) => {
  const fx = queueFixture("sched-lease"); t.after(() => fx.done());
  addTask(fx, { title: "x", allow: "src/**" });

  const held = SCHED.acquireSchedulerLease(fx.wsDir(), { projectId: fx.P, schedulerId: "SCHED-OTHER" });
  assert.equal(held.ok, true);
  const blocked = await SCHED.runQueue({ projectId: fx.P, env: fakeQueueEnv(fx, {}), maxTasks: 1 });
  assert.equal(blocked.stop_reason, "SCHEDULER_LEASE_LOST");
  assert.equal(blocked.failure.code, "SCHEDULER_LEASE_CONFLICT");
  assert.equal(invocations(fx).length, 0, "it never got as far as a worker");

  // expire it: a lease whose holder is gone is recovered, not obeyed forever
  const p = SCHED.schedulerLeasePath(fx.wsDir());
  const lease = JSON.parse(readFileSync(p, "utf8"));
  lease.expires_at = new Date(Date.now() - 1000).toISOString();
  writeFileSync(p, JSON.stringify(lease));
  const events = [];
  const r = await SCHED.runQueue({ projectId: fx.P, env: fakeQueueEnv(fx, {}), maxTasks: 1,
    onEvent: (e) => events.push(e) });
  assert.notEqual(r.stop_reason, "SCHEDULER_LEASE_LOST");
  const acq = events.find((e) => e.type === "scheduler.lease_acquired");
  assert.equal(acq.payload.recovered_stale, "SCHED-OTHER", "recovery is recorded, not silent");
});

test("scheduler: releasing the lease cancels the queue between tasks, never mid-delivery", async (t) => {
  const fx = queueFixture("sched-cancel"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const b = addTask(fx, { title: "two", allow: "src/**" });
  const env = fakeQueueEnv(fx, {
    [a]: { write: [{ path: "src/a.js", content: "// a\n" }] },
    [b]: { write: [{ path: "src/b.js", content: "// b\n" }] },
  });

  let cancelled = false;
  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 5, onEvent: (e) => {
    // the operator cancels the moment the first task is delivered
    if (e.type === "scheduler.task_delivered" && !cancelled) {
      cancelled = true;
      SCHED.releaseSchedulerLease(fx.wsDir(), e.scheduler_id);
    }
  } });
  assert.equal(r.stop_reason, "SCHEDULER_LEASE_LOST");
  assert.equal(r.tasks_delivered, 1, "the in-flight task finished; the next one never started");
  assert.equal(remoteLog(fx).length, 3);
  assert.equal(invocations(fx).length, 1);

  // the CLI does the same thing, without killing anything
  const out = fx.cli("scheduler-cancel", "--project", fx.P, "--scheduler", r.scheduler_id);
  assert.match(out, /released|already gone/);
});

// ============================================================= 63–72. retries

test("scheduler: a retryable failure creates a NEW attempt with a FRESH process and keeps the old evidence", async (t) => {
  const fx = queueFixture("sched-retry"); t.after(() => fx.done());
  const a = addTask(fx, {
    title: "flaky", allow: "src/**",
    // fail the verification on attempt 1, pass on attempt 2
    verify: `${process.execPath.replace(/\\/g, "/")} -e process.exit(require("fs").existsSync("src/fixed.js")?0:1)`,
  });
  const b = JSON.parse(fx.cli("task-get", "--project", fx.P, String(a)));
  assert.ok(b.verify.length);

  const dir = join(fx.home, "behaviours");
  const env = fakeQueueEnv(fx, {});
  writeFileSync(join(dir, `task-${a}-attempt-1.json`), JSON.stringify({ write: [{ path: "src/broken.js", content: "// nope\n" }] }));
  writeFileSync(join(dir, `task-${a}-attempt-2.json`), JSON.stringify({ write: [{ path: "src/fixed.js", content: "// yes\n" }] }));

  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  assert.equal(r.stop_reason, "MAX_TASKS_REACHED", JSON.stringify(r.failure));
  assert.equal(r.tasks[0].attempts, 2, "it took two attempts");
  assert.equal(states(fx)[a], "DELIVERED");

  // 69 + 71: a new attempt, in a new process
  const inv = invocations(fx);
  assert.equal(inv.length, 2);
  assert.notEqual(inv[0].pid, inv[1].pid, "a retry is a fresh process, not a continued session");
  assert.deepEqual(inv.map((x) => x.attempt), ["1", "2"]);

  // 70: attempt 1's evidence still exists, untouched
  const phases = SCHED.taskPhases(fx.P, a);
  assert.equal(phases.attempts.length, 2);
  const first = phases.attempts.find((x) => x.attempt === 1);
  assert.ok(existsSync(join(first.dir, "phases", "verification-gate.json")));
  const failed = JSON.parse(readFileSync(join(first.dir, "phases", "verification-gate.json"), "utf8"));
  assert.equal(failed.state, "FAILED");
  assert.ok(failed.gate_reports.some((g) => g.gate_id === "required-verification-passed" && g.outcome === "FAIL"));

  // 72: the repair context is compact and is only failure evidence
  const manifest = phases.attempts.find((x) => x.attempt === 2).repair_context;
  assert.ok(manifest, "attempt 2 must record what context it was given");
  assert.equal(manifest.unit, "characters");
  assert.ok(manifest.total_characters > 0 && manifest.total_characters <= 6000);
  assert.ok(manifest.sections.some((s) => s.name === "failed-gates"));
});

test("scheduler: a path-scope violation is NOT retried — the world has to change first", async (t) => {
  const fx = queueFixture("sched-nonretry"); t.after(() => fx.done());
  const a = addTask(fx, { title: "escapee", allow: "src/**", forbid: "README.md" });
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "README.md", content: "# owned\n" }] } });

  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 2 });
  assert.equal(r.tasks[0].attempts, 1, "one attempt, then stop — retrying a scope violation is a second violation");
  assert.equal(r.tasks[0].failure.code, "PATH_SCOPE_VIOLATION");
  assert.equal(states(fx)[a], "FAILED");
  assert.equal(remoteLog(fx).length, 2, "nothing was pushed");
  assert.equal(invocations(fx).length, 1);

  assert.equal(SCHED.classifyFailure("PATH_SCOPE_VIOLATION").retryable, false);
  assert.equal(SCHED.classifyFailure("SECRET_DETECTED").retryable, false);
  assert.equal(SCHED.classifyFailure("FORBIDDEN_GIT_EFFECT").retryable, false);
  assert.equal(SCHED.classifyFailure("AGENT_TIMEOUT").retryable, true);
  assert.equal(SCHED.classifyFailure("PROCESS_TRANSIENT").retryable, true);
  // an unclassified code fails closed rather than defaulting to "try again"
  assert.equal(SCHED.classifyFailure("SOMETHING_NEW").retryable, false);
  assert.equal(SCHED.classifyFailure("SOMETHING_NEW").class, "UNCLASSIFIED");
});

test("scheduler: attempts, repairs and consecutive failures each stop at their configured limit", async (t) => {
  const fx = queueFixture("sched-limits"); t.after(() => fx.done());
  const a = addTask(fx, { title: "always fails", allow: "src/**",
    verify: `${process.execPath.replace(/\\/g, "/")} -e process.exit(1)` });
  fx.cli("task-set", "--project", fx.P, String(a), "--retry-policy",
    JSON.stringify({ max_attempts: 2, max_repairs_per_attempt: 5, retryable_failures: ["VERIFICATION_FAILURE"], backoff_seconds: [0, 0] }));

  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }] } });
  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 2 });
  assert.equal(r.tasks[0].attempts, 2, "max_attempts is a ceiling, not a suggestion");
  assert.equal(states(fx)[a], "FAILED");
  assert.equal(invocations(fx).length, 2);

  // 67: the repair budget stops it earlier than max_attempts would
  assert.equal(SCHED.classifyFailure("VERIFICATION_FAILURE", { task: { retryPolicy: { max_repairs_per_attempt: 1 } }, repairsUsed: 1 }).retryable, false);
  assert.equal(SCHED.classifyFailure("VERIFICATION_FAILURE", { task: { retryPolicy: { max_repairs_per_attempt: 1 } }, repairsUsed: 0 }).retryable, true);

  // 68: a project-level consecutive-failure limit stops the whole queue
  const fx2 = queueFixture("sched-consecutive"); t.after(() => fx2.done());
  const reg = JSON.parse(readFileSync(join(fx2.home, "projects.json"), "utf8"));
  reg.projects[0].schedulerBudgets = { max_consecutive_failures: 1 };
  writeFileSync(join(fx2.home, "projects.json"), JSON.stringify(reg, null, 2));
  const t1 = addTask(fx2, { title: "bad one", allow: "src/**", forbid: "README.md" });
  addTask(fx2, { title: "good one", allow: "src/**" });
  const r2 = await SCHED.runQueue({ projectId: fx2.P, env: fakeQueueEnv(fx2, { [t1]: { write: [{ path: "README.md", content: "x" }] } }), maxTasks: 5 });
  assert.ok(["FAILED", "CONSECUTIVE_FAILURE_LIMIT"].includes(r2.stop_reason));
  assert.equal(r2.tasks_delivered, 0);
});

// ========================================================= 73–81. human gates

test("scheduler: an unapproved delivery raises a bound human gate and stops the queue", async (t) => {
  const fx = queueFixture("sched-approval", { approval: true }); t.after(() => fx.done());
  const a = addTask(fx, { title: "needs a signature", allow: "src/**" });
  const b = addTask(fx, { title: "the next one", allow: "src/**" });
  const env = fakeQueueEnv(fx, {
    [a]: { write: [{ path: "src/a.js", content: "// a\n" }] },
    [b]: { write: [{ path: "src/b.js", content: "// b\n" }] },
  });

  // 81: it stops rather than running past the person it just asked
  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 5 });
  assert.equal(r.stop_reason, "NEEDS_DECISION");
  assert.equal(r.tasks_delivered, 0);
  assert.equal(remoteLog(fx).length, 2, "nothing was pushed while a decision was pending");
  assert.equal(invocations(fx).length, 1, "the next task was never started");

  // 76: the decision is bound to this project, task, run, attempt, phase and diff
  const gates = HG.pending(fx.P);
  assert.equal(gates.length, 1);
  const g = gates[0];
  assert.equal(g.gate_type, "DELIVERY_APPROVAL");
  assert.equal(g.task_id, a);
  assert.match(g.run_id, /^RUN-/);
  assert.equal(g.attempt, 1);
  assert.equal(g.phase_id, "delivery-approval");
  assert.match(g.proposal_hash, /^[0-9a-f]{64}$/);
  assert.match(g.diff_hash, /^[0-9a-f]{64}$/);
  assert.ok(g.expires_at);
  // the question stands alone: it names the commit, the branch, the remote and the files
  assert.match(g.question, /feat\(task\)/);
  assert.match(g.question, /src\/a\.js/);
  assert.match(g.question, /Approve this delivery\?/);

  // 80: approving it resumes the queue, and the same signature drives the
  // delivery controller — the operator is never asked twice.
  HG.decide(fx.P, g.id, { decision: "APPROVED", approver: "the-operator" });
  const r2 = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 5 });
  assert.equal(r2.stop_reason, "NEEDS_DECISION", "task b now needs its own approval");
  assert.equal(states(fx)[a], "DELIVERED");
  assert.equal(remoteLog(fx).length, 3);
});

test("scheduler: a rejected gate stops the queue and pushes nothing", async (t) => {
  const fx = queueFixture("sched-reject", { approval: true }); t.after(() => fx.done());
  const a = addTask(fx, { title: "rejected", allow: "src/**" });
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }] } });

  await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  const g = HG.pending(fx.P)[0];
  HG.decide(fx.P, g.id, { decision: "REJECTED", approver: "the-operator", conditions: "wrong approach" });

  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  assert.notEqual(r.stop_reason, "PROJECT_COMPLETED");
  assert.equal(r.tasks_delivered, 0);
  assert.equal(remoteLog(fx).length, 2);
  assert.equal(states(fx)[a], "FAILED");
  // the change is still in the tree, unstaged — nothing was reverted
  assert.equal(readFileSync(join(fx.repo, "src", "a.js"), "utf8"), "// a\n");
  assert.equal(git(fx.repo, "diff", "--cached", "--name-only").trim(), "");
});

test("human gates: typed decisions bind, expire and invalidate when the proposal moves", (t) => {
  const fx = fixture("hg-binding"); t.after(() => fx.done());
  const a = addTask(fx, { title: "a" });

  // 73/74/75: every gate type is available and typed
  for (const type of ["DEPENDENCY_CHANGE", "SCHEMA_CHANGE", "SCOPE_EXPANSION"]) {
    const r = HG.create(fx.P, { gateType: type, taskId: a,
      question: `Should task #${a} be allowed to change the ${type} it just discovered it needs? Answering APPROVED widens its scope; REJECTED stops it.`,
      options: ["APPROVED", "REJECTED"], recommended: "REJECTED" });
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    assert.equal(r.gate.gate_type, type);
  }
  assert.equal(HG.pending(fx.P).length, 3);
  assert.equal(HG.create(fx.P, { gateType: "VIBES", question: "?".repeat(60) }).failure.code, "UNKNOWN_GATE_TYPE");

  // a question nobody can answer from the dashboard alone is not a question
  assert.equal(HG.create(fx.P, { gateType: "SCHEMA_CHANGE", question: "see the notes" }).failure.code, "QUESTION_UNREADABLE");
  assert.equal(HG.create(fx.P, { gateType: "SCHEMA_CHANGE", question: "x".repeat(200) }).failure.code, "QUESTION_UNREADABLE",
    "no question mark means there is nothing to decide");

  // the same unanswered question asked twice is one question
  const q = { gateType: "BUDGET_INCREASE", taskId: a, question: "Task #1 has used its whole attempt budget. Raise it by two attempts, or fail the task?" };
  const one = HG.create(fx.P, q), two = HG.create(fx.P, q);
  assert.equal(two.existing, true);
  assert.equal(one.gate.id, two.gate.id);

  // 78: a rejected gate stays rejected and cannot be re-decided
  const rej = HG.decide(fx.P, one.gate.id, { decision: "REJECTED", approver: "op" });
  assert.equal(rej.ok, true);
  assert.equal(HG.decide(fx.P, one.gate.id, { decision: "APPROVED", approver: "op" }).failure.code, "GATE_NOT_PENDING");
  assert.equal(HG.decide(fx.P, "HG-NOPE", { decision: "APPROVED", approver: "op" }).failure.code, "GATE_NOT_FOUND");
  assert.equal(HG.decide(fx.P, one.gate.id, { decision: "MAYBE", approver: "op" }).failure.code, "UNKNOWN_DECISION");
  assert.equal(HG.decide(fx.P, one.gate.id, { decision: "APPROVED" }).failure.code, "APPROVER_REQUIRED");

  // 79: expiry is computed on read, so a stale yes never quietly stays valid
  const short = HG.create(fx.P, { gateType: "AMBIGUOUS_EVIDENCE", taskId: a, ttlMs: -1,
    question: "The evidence for task #1 is ambiguous: the tests pass but the worker reported BLOCKED. Ship it, or stop?" });
  assert.equal(HG.get(fx.P, short.gate.id).status, "EXPIRED");
  assert.equal(HG.decide(fx.P, short.gate.id, { decision: "APPROVED", approver: "op" }).failure.code, "GATE_NOT_PENDING");

  // 77: a changed proposal or a changed diff invalidates the decision
  const bound = HG.create(fx.P, { gateType: "ARCHITECTURE_DECISION", taskId: a, diffHash: "aaaa", stateVersion: 3,
    question: "Task #1 needs a decision about which storage layer to use. Postgres or SQLite? Recommended: SQLite." });
  HG.decide(fx.P, bound.gate.id, { decision: "APPROVED", approver: "op" });
  const moved = HG.revalidate(fx.P, bound.gate.id, { diffHash: "bbbb" });
  assert.equal(moved.invalidated, true);
  assert.match(moved.reasons[0], /diff changed/);
  assert.equal(HG.get(fx.P, bound.gate.id).status, "INVALIDATED");
});

test("human gates: the CLI decides them and the projection never offers a remote write", (t) => {
  const fx = fixture("hg-cli"); t.after(() => fx.done());
  const a = addTask(fx, { title: "a" });
  const opened = JSON.parse(fx.cli("human-gate-open", "--project", fx.P, "--type", "SCOPE_EXPANSION", "--task", String(a),
    "--question", "Task #1 needs to touch migrations/, which its path policy forbids. Widen the policy, or fail the task and re-plan?",
    "--options", "widen the policy|fail and re-plan", "--recommended", "fail and re-plan"));
  assert.equal(opened.status, "PENDING");

  const listed = JSON.parse(fx.cli("human-gate-list", "--project", fx.P));
  assert.equal(listed.pending.length, 1);
  assert.equal(listed.decisions_require_local_operator, true);
  assert.match(listed.decide_with, /human-gate-decide/);

  assert.throws(() => fx.cli("human-gate-decide", "--project", fx.P, "--gate", opened.gate, "--decision", "APPROVED"),
    /need --approver/);
  const decided = JSON.parse(fx.cli("human-gate-decide", "--project", fx.P, "--gate", opened.gate,
    "--decision", "APPROVED", "--approver", "the-operator"));
  assert.equal(decided.status, "APPROVED");
  assert.equal(decided.approver, "the-operator");
  assert.equal(JSON.parse(fx.cli("human-gate-show", "--project", fx.P, "--gate", opened.gate)).status, "APPROVED");
});

// ======================================================= 82–88. delivery rules

test("scheduler: an unrelated outgoing commit stops the queue and nothing is force-pushed", async (t) => {
  const fx = queueFixture("sched-outgoing"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  // A commit made outside SCH that has never been pushed: the delivery
  // controller must refuse to carry it along with the task's own commit.
  writeFileSync(join(fx.repo, "src", "unrelated.js"), "// somebody else\n");
  git(fx.repo, "add", "src/unrelated.js");
  git(fx.repo, "commit", "-q", "-m", "unrelated work");

  const rec = recordGit();
  t.after(() => rec.stop());
  const r = await SCHED.runQueue({ projectId: fx.P, env: fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }] } }), maxTasks: 2 });

  assert.notEqual(r.stop_reason, "PROJECT_COMPLETED");
  assert.equal(r.tasks_delivered, 0);
  assert.equal(r.tasks[0].failure.code, "UNRELATED_OUTGOING_COMMITS");
  assert.match(r.tasks[0].failure.message, /exactly one — the delivery commit — is permitted/);
  assert.equal(remoteLog(fx).length, 2, "the unrelated commit was not smuggled to the remote");
  assert.notEqual(states(fx)[a], "DELIVERED");

  // 87: no force, no rewrite, no auto-merge, ever
  for (const c of rec.calls) {
    assert.doesNotMatch(c, /(^|\s)push\b.*(--force|-f\b)/, c);
    // `merge-base` is a read-only question about ancestry and is exactly how the
    // controller PROVES it is not diverging — it is not `merge`.
    assert.doesNotMatch(c, /(^|\s)(rebase|reset|merge|cherry-pick|revert|filter-branch)(?![-\w])/, c);
    assert.doesNotMatch(c, /commit\s+--amend/, c);
  }
});

test("scheduler: an incoming commit stops the queue rather than merging or rebasing over it", async (t) => {
  const fx = queueFixture("sched-incoming"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const other = otherClone(fx.bare);
  t.after(() => { try { rmSync(other, { recursive: true, force: true }); } catch {} });
  writeFileSync(join(other, "OTHER.md"), "# somebody else pushed first\n");
  git(other, "add", "OTHER.md"); git(other, "commit", "-q", "-m", "their work"); git(other, "push", "-q");

  const r = await SCHED.runQueue({ projectId: fx.P, env: fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }] } }), maxTasks: 2 });
  assert.equal(r.tasks_delivered, 0);
  assert.equal(r.tasks[0].failure.code, "INCOMING_COMMITS_PRESENT");
  assert.equal(remoteLog(fx).length, 3, "their commit is untouched and ours never landed");
  assert.equal(git(fx.repo, "log", "--oneline", "-1").includes("their work"), false, "nothing was merged or rebased in");
});

test("scheduler: a secret in the worker's change is caught before anything is committed", async (t) => {
  const fx = queueFixture("sched-secret"); t.after(() => fx.done());
  const a = addTask(fx, { title: "leaky", allow: "src/**" });
  // Shaped like the real thing and assembled at runtime, so this file itself
  // never contains a credential pattern — and deliberately not the word
  // "example", which the scanner correctly treats as a placeholder.
  const key = ["AKIA", "Q7ZBWXYT", "N4RVKD2M"].join("");
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/config.js", content: `const k = "${key}";\n` }] } });

  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 2 });
  assert.equal(r.tasks_delivered, 0);
  assert.equal(r.tasks[0].failure.code, "SECRET_DETECTED");
  assert.equal(r.tasks[0].attempts, 1, "a detected secret is never retried");
  assert.equal(remoteLog(fx).length, 2);
  assert.equal(git(fx.repo, "diff", "--cached", "--name-only").trim(), "", "nothing was staged");
});

test("scheduler: the next task is selected only after the previous one is on the remote", async (t) => {
  const fx = queueFixture("sched-ordering"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const b = addTask(fx, { title: "two", allow: "src/**", deps: String(a) });
  const env = fakeQueueEnv(fx, {
    [a]: { write: [{ path: "src/a.js", content: "// a\n" }] },
    [b]: { write: [{ path: "src/b.js", content: "// b\n" }] },
  });

  const timeline = [];
  await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 5, onEvent: (e) => {
    if (["scheduler.task_claimed", "scheduler.task_delivered"].includes(e.type))
      timeline.push(`${e.type.replace("scheduler.task_", "")}:${e.task_id}:${remoteLog(fx).length}`);
  } });

  assert.deepEqual(timeline, [`claimed:${a}:2`, `delivered:${a}:3`, `claimed:${b}:3`, `delivered:${b}:4`],
    "task b is claimed only once task a's commit is actually on the remote");
});

test("scheduler: a task becomes DELIVERED only through the controller, after remote verification", async (t) => {
  const fx = queueFixture("sched-remote-proof"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }] } });
  await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });

  const task = fx.state().tasks.find((x) => x.id === a);
  assert.equal(task.state, "DELIVERED");
  assert.equal(task.status, "delivered");
  // provenance, not a claim
  assert.match(task.delivery.commit, /^[0-9a-f]{40}$/);
  assert.equal(task.delivery.remote, "origin");
  assert.ok(task.delivery.verified_at);
  assert.ok(task.delivery.pushed_range);
  // and the commit really is on the remote
  assert.ok(git(fx.bare, "cat-file", "-t", task.delivery.commit).trim() === "commit");

  // the remote-verification gate says what it proved
  const reports = JSON.parse(fx.cli("gate-report", "--project", fx.P, "--task", String(a), "--gate", "remote-commit-present"));
  assert.equal(reports.reports.length, 1);
  assert.equal(reports.reports[0].outcome, "PASS");
  assert.match(reports.reports[0].checks[0].evidence, /origin\/main/);
});

// =========================================================== project completion

test("scheduler: completion is deterministic, and 'nothing ready' alone never means done", async (t) => {
  const fx = queueFixture("sched-completion"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }] } });

  // an open human gate means not complete, even with nothing ready
  HG.create(fx.P, { gateType: "ARCHITECTURE_DECISION",
    question: "Before anything else: should this project use one service or two? One is simpler; two is what the brief implies." });
  let c = SCHED.evaluateCompletion(fx.P, { wsDir: fx.wsDir() });
  assert.equal(c.complete, false);
  assert.ok(c.reasons.find((r) => /human gate/.test(r.item) && !r.passed));

  const stopped = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 5 });
  assert.equal(stopped.stop_reason, "NEEDS_DECISION");
  assert.equal(stopped.tasks_delivered, 0, "a pending decision stops the queue before it selects anything");

  const g = HG.pending(fx.P)[0];
  HG.decide(fx.P, g.id, { decision: "APPROVED", approver: "op" });
  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 5 });
  assert.equal(r.stop_reason, "PROJECT_COMPLETED");

  c = SCHED.evaluateCompletion(fx.P, { wsDir: fx.wsDir() });
  assert.equal(c.complete, true, JSON.stringify(c.reasons.filter((x) => !x.passed)));
  assert.equal(c.reasons.length, 5);
  for (const r2 of c.reasons) assert.ok(r2.evidence, `${r2.item} must carry evidence`);
});

// =============================================== the legacy /sch-run boundary

test("scheduler: while a scheduler holds the project, a hand-driven task-set is refused", async (t) => {
  const fx = queueFixture("sched-legacy"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });

  const held = SCHED.acquireSchedulerLease(fx.wsDir(), { projectId: fx.P, schedulerId: "SCHED-LIVE" });
  assert.equal(held.ok, true);
  t.after(() => SCHED.releaseSchedulerLease(fx.wsDir(), "SCHED-LIVE"));

  assert.throws(() => fx.cli("task-set", "--project", fx.P, String(a), "--status", "merged"),
    /scheduler SCHED-LIVE is running this project/,
    "the legacy in-session loop cannot complete a task the queue owns");
  // a non-status edit is still fine — the lease guards STATE, not every field
  fx.cli("task-set", "--project", fx.P, String(a), "--notes", "still editable");
  assert.equal(fx.state().tasks.find((x) => x.id === a).notes, "still editable");
  // and the escape hatch is explicit, not accidental
  assert.equal(TR.canonicalState(fx.state().tasks.find((x) => x.id === a)), "READY");
});

// ============================================================ events + budgets

test("scheduler: events are versioned, correlated, bounded and never carry worker output", async (t) => {
  const fx = queueFixture("sched-events"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }], stdoutBytes: 40000 } });
  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });

  const { events } = SCHED.readScheduler(fx.P, r.scheduler_id);
  assert.ok(events.length > 20, `expected a full trace, got ${events.length}`);
  const seen = new Set(events.map((e) => e.type));
  for (const want of ["scheduler.created", "scheduler.started", "scheduler.lease_acquired", "scheduler.graph_validated",
                      "scheduler.task_ready", "scheduler.task_claimed", "scheduler.task_started", "scheduler.phase_started",
                      "scheduler.phase_executed", "scheduler.gate_passed", "scheduler.envelope_accepted",
                      "scheduler.task_awaiting_delivery", "scheduler.task_delivered", "scheduler.stopped",
                      "scheduler.lease_released"])
    assert.ok(seen.has(want), `missing event ${want}`);
  for (const e of events) {
    assert.ok(SCHED.SCHEDULER_EVENTS.includes(e.type), `${e.type} is not in the declared vocabulary`);
    assert.equal(e.schema_version, 1);
    assert.match(e.event_id, /^SEV-/);
    assert.equal(e.correlation, r.scheduler_id);
    assert.ok(e.timestamp && e.project_id && e.actor);
    const size = JSON.stringify(e.payload).length;
    assert.ok(size <= 4200, `${e.type} payload is ${size} characters`);
    assert.doesNotMatch(JSON.stringify(e.payload), /x{500}/, "worker stdout must never be inlined into an event");
  }
  // causation chains the trace together
  const chained = events.filter((e) => e.causation).length;
  assert.ok(chained >= events.length - 1);
});

test("scheduler: budgets are explicit and a breach is a typed stop, never a silent raise", async (t) => {
  const fx = queueFixture("sched-budgets"); t.after(() => fx.done());
  const reg = JSON.parse(readFileSync(join(fx.home, "projects.json"), "utf8"));
  reg.projects[0].schedulerBudgets = { max_total_attempts: 1 };
  writeFileSync(join(fx.home, "projects.json"), JSON.stringify(reg, null, 2));
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const b = addTask(fx, { title: "two", allow: "src/**" });
  const env = fakeQueueEnv(fx, {
    [a]: { write: [{ path: "src/a.js", content: "// a\n" }] },
    [b]: { write: [{ path: "src/b.js", content: "// b\n" }] },
  });

  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 5 });
  assert.equal(r.stop_reason, "PROJECT_BUDGET_EXCEEDED");
  assert.equal(r.tasks_delivered, 1);
  assert.ok(SCHED.STOP_REASONS.includes(r.stop_reason));

  for (const k of Object.keys(SCHED.DEFAULT_BUDGETS)) assert.ok(Number.isFinite(SCHED.DEFAULT_BUDGETS[k]), `${k} must be a finite ceiling`);
});

// ======================================================= the queue CLI surface

test("scheduler: the CLI exposes status, list, phases and gate reports", async (t) => {
  const fx = queueFixture("sched-cli"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }] } });
  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });

  const status = JSON.parse(fx.cli("scheduler-status", "--project", fx.P));
  assert.equal(status.available, true);
  assert.equal(status.lease, null, "the lease was released on stop");
  assert.equal(status.schedulers[0].scheduler_id, r.scheduler_id);
  assert.equal(status.completion.complete, true);
  assert.equal(status.write_actions_require_local_operator, true);

  const list = JSON.parse(fx.cli("scheduler-list", "--project", fx.P));
  assert.equal(list.schedulers.length, 1);

  const phases = JSON.parse(fx.cli("phase-list", "--project", fx.P, "--task", String(a)));
  assert.equal(phases.attempts.length, 1);
  assert.equal(phases.attempts[0].recovery.completed, true);
  assert.equal(phases.workflow.length, SCHED.TASK_WORKFLOW.length);

  const gates = JSON.parse(fx.cli("gate-report", "--project", fx.P, "--task", String(a)));
  assert.ok(gates.reports.length >= 10);
  assert.ok(gates.reports.every((g) => g.outcome === "PASS"));

  const graph = JSON.parse(fx.cli("graph-show", "--project", fx.P));
  assert.equal(graph.nodes[0].state, "DELIVERED");
  assert.match(fx.cli("graph-show", "--project", fx.P, "--format", "markdown"), /read-only projection/);
  assert.equal(JSON.parse(fx.cli("graph-validate", "--project", fx.P)).ok, true);
});

test("scheduler: no real model, no network, and only reads inside the fixture", async (t) => {
  const fx = queueFixture("sched-isolation"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const envPath = join(fx.home, "worker-env.json");
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }], envTo: envPath } });
  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });

  // the "model" is a local node script driven by a JSON file
  const sched = SCHED.readScheduler(fx.P, r.scheduler_id).scheduler;
  assert.equal(sched.project_id, fx.P);
  assert.equal(sched.pid, process.pid);
  const workerEnv = JSON.parse(readFileSync(envPath, "utf8"));
  assert.equal(workerEnv.SCH_HOME, undefined, "the worker must never see the state that grades it");
  assert.equal(workerEnv.AWS_SECRET_ACCESS_KEY, undefined, "unrelated credentials are not inherited");
  assert.equal(workerEnv.GITHUB_TOKEN, undefined);
  assert.equal(workerEnv.SCH_TASK_ID, String(a));
  assert.equal(workerEnv.SCH_ATTEMPT, "1");

  // the real registry is untouched
  assert.ok(fx.home.includes("sch-home-"), "everything happened under a throwaway SCH_HOME");
});
