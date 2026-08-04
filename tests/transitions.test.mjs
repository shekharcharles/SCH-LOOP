// The closed task-state machine: legal edges, illegal edges, who may authorise
// each one, optimistic concurrency, legacy compatibility, and the refusal of
// every path that would let a model or an operator type its way to a state that
// asserts something only a controller can assert.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, addTask, TR, STATE } from "./helpers.mjs";

const put = (fx, s) => writeFileSync(join(fx.home, "projects", fx.P, "state.json"), JSON.stringify(s, null, 2));
const setState = (fx, id, st) => { const s = fx.state(); s.tasks.find((x) => x.id === id).state = st; put(fx, s); };
const taskOf = (fx, id) => fx.state().tasks.find((x) => x.id === id);

// --- 13. every allowed transition ----------------------------------------------

test("transitions: the happy path runs end to end, one authorised actor per edge", (t) => {
  const fx = fixture("tr-happy"); t.after(() => fx.done());
  const id = addTask(fx, { title: "a task" });
  setState(fx, id, "BACKLOG");

  const steps = [
    ["READY", "scheduler"], ["CLAIMED", "scheduler"], ["RUNNING", "runner"],
    ["VERIFYING", "runner"], ["AWAITING_DELIVERY", "verifier"],
    ["DELIVERING", "delivery"], ["DELIVERED", "delivery"],
  ];
  for (const [to, actor] of steps) {
    const r = TR.transition(fx.P, id, { to, actor, reason: "test" });
    assert.equal(r.ok, true, `${to} via ${actor}: ${r.failure?.message}`);
    assert.equal(r.state, to);
  }
  const t2 = taskOf(fx, id);
  assert.equal(t2.state, "DELIVERED");
  assert.equal(t2.status, "delivered", "the legacy mirror follows the canonical state");
  assert.equal(t2.stateVersion, steps.length);
  assert.equal(t2.stateHistory.length, steps.length);
  assert.equal(t2.stateHistory[0].to, "DELIVERED");
  assert.equal(t2.stateHistory[0].from, "DELIVERING");
});

test("transitions: the retry loop and the human-gate loop are both legal", (t) => {
  const fx = fixture("tr-loops"); t.after(() => fx.done());
  const id = addTask(fx, { title: "a task" });

  assert.equal(TR.transition(fx.P, id, { to: "CLAIMED", actor: "scheduler" }).ok, true);
  assert.equal(TR.transition(fx.P, id, { to: "RUNNING", actor: "runner" }).ok, true);
  assert.equal(TR.transition(fx.P, id, { to: "RETRYABLE", actor: "runner" }).ok, true);
  assert.equal(TR.transition(fx.P, id, { to: "READY", actor: "retry" }).ok, true);
  assert.equal(TR.transition(fx.P, id, { to: "NEEDS_DECISION", actor: "scheduler" }).ok, true);
  assert.equal(TR.transition(fx.P, id, { to: "READY", actor: "human-gate" }).ok, true);
  assert.equal(TR.transition(fx.P, id, { to: "NEEDS_DECISION", actor: "scheduler" }).ok, true);
  assert.equal(TR.transition(fx.P, id, { to: "CANCELLED", actor: "human-gate" }).ok, true);
  assert.equal(taskOf(fx, id).state, "CANCELLED");
});

// --- 14. every forbidden transition --------------------------------------------

test("transitions: skipping, reversing and leaving a terminal state are all refused", (t) => {
  const fx = fixture("tr-illegal"); t.after(() => fx.done());
  const id = addTask(fx, { title: "a task" });

  // skip forward
  let r = TR.transition(fx.P, id, { to: "DELIVERED", actor: "delivery" });
  assert.equal(r.ok, false);
  assert.equal(r.failure.code, "ILLEGAL_TRANSITION");
  // straight past the runner
  assert.equal(TR.transition(fx.P, id, { to: "AWAITING_DELIVERY", actor: "verifier" }).ok, false);
  // backwards
  TR.transition(fx.P, id, { to: "CLAIMED", actor: "scheduler" });
  TR.transition(fx.P, id, { to: "RUNNING", actor: "runner" });
  assert.equal(TR.transition(fx.P, id, { to: "CLAIMED", actor: "scheduler" }).ok, false);
  // out of terminal
  TR.transition(fx.P, id, { to: "FAILED", actor: "scheduler" });
  r = TR.transition(fx.P, id, { to: "READY", actor: "operator" });
  assert.equal(r.ok, false);

  // FAILED is terminal-ish for the machine's purposes: the task is not
  // resurrected in place, which is the point — a failed task gets a decision.
  assert.match(r.failure.message, /illegal transition|already terminal/);
});

test("transitions: the wrong actor is refused even on a legal edge", (t) => {
  const fx = fixture("tr-actor"); t.after(() => fx.done());
  const id = addTask(fx, { title: "a task" });
  // claiming is the scheduler's job, not the runner's
  assert.equal(TR.transition(fx.P, id, { to: "CLAIMED", actor: "runner" }).ok, false);
  TR.transition(fx.P, id, { to: "CLAIMED", actor: "scheduler" });
  // starting is the runner's, not the delivery controller's
  assert.equal(TR.transition(fx.P, id, { to: "RUNNING", actor: "delivery" }).ok, false);
  // delivering is nobody's but the delivery controller's
  TR.transition(fx.P, id, { to: "RUNNING", actor: "runner" });
  TR.transition(fx.P, id, { to: "VERIFYING", actor: "runner" });
  TR.transition(fx.P, id, { to: "AWAITING_DELIVERY", actor: "verifier" });
  assert.equal(TR.transition(fx.P, id, { to: "DELIVERING", actor: "scheduler" }).ok, false);
  assert.equal(TR.transition(fx.P, id, { to: "DELIVERING", actor: "delivery" }).ok, true);
});

// --- 15. a model never transitions ----------------------------------------------

test("transitions: a model, a worker and an agent are not actors at all", () => {
  for (const actor of ["model", "worker", "agent"]) {
    const r = TR.canTransition("READY", "CLAIMED", actor);
    assert.equal(r.ok, false);
    assert.match(r.why, /model never moves a task|not an actor/);
  }
  assert.equal(TR.canTransition("READY", "CLAIMED", "scheduler").ok, true);
});

// --- 16. stale version rejected --------------------------------------------------

test("transitions: a stale state version cannot overwrite a newer one", (t) => {
  const fx = fixture("tr-version"); t.after(() => fx.done());
  const id = addTask(fx, { title: "a task" });
  const v0 = taskOf(fx, id).stateVersion ?? 0;

  // A second process moves it first.
  assert.equal(TR.transition(fx.P, id, { to: "CLAIMED", actor: "scheduler", expectVersion: v0 }).ok, true);

  // The first process, still holding v0, is refused — not merged, not retried.
  const stale = TR.transition(fx.P, id, { to: "CLAIMED", actor: "scheduler", expectVersion: v0 });
  assert.equal(stale.ok, false);
  assert.equal(stale.failure.code, "STATE_VERSION_CONFLICT");
  assert.match(stale.failure.message, /state version 1, not 0/);
  assert.equal(taskOf(fx, id).state, "CLAIMED", "the newer state survives untouched");
});

// --- 17. controller-only delivered -----------------------------------------------

test("transitions: `delivered` is unreachable from the CLI, by any spelling", (t) => {
  const fx = fixture("tr-delivered"); t.after(() => fx.done());
  const id = addTask(fx, { title: "a task" });

  assert.throws(() => fx.cli("task-set", "--project", fx.P, String(id), "--status", "delivered"),
    /delivery controller only/);
  assert.throws(() => fx.cli("task-set", "--project", fx.P, String(id), "--status", "DELIVERED"),
    /delivery controller only|not a task status/);
  assert.throws(() => fx.cli("task-transition", "--project", fx.P, "--task", String(id), "--event", "deliver"),
    /no such transition event/);
  assert.equal(taskOf(fx, id).status, "queued");

  // markDelivered still refuses provenance-free completion, as it always has.
  const r = STATE.markDelivered(fx.P, id, { run_id: "RUN-x" });
  assert.equal(r.ok, false);
  assert.match(r.message, /without delivery_id/);
});

// --- 18. historical status compatibility ------------------------------------------

test("transitions: a task that predates the state machine is read through the legacy map", (t) => {
  const fx = fixture("tr-legacy"); t.after(() => fx.done());
  const id = addTask(fx, { title: "old task" });
  const s = fx.state();
  const old = s.tasks.find((x) => x.id === id);
  delete old.state; delete old.stateVersion; delete old.stateHistory;
  old.status = "merged";
  put(fx, s);

  const task = taskOf(fx, id);
  assert.equal(task.state, undefined, "reading must not write");
  assert.equal(TR.canonicalState(task), "AWAITING_DELIVERY",
    "`merged` meant finished LOCALLY and never pushed — mapping it to DELIVERED would claim a remote it never reached");

  for (const [legacy, canonical] of Object.entries(TR.LEGACY_TO_STATE))
    assert.equal(TR.canonicalState({ status: legacy }), canonical, legacy);
  // and every canonical state maps back to a real legacy status
  for (const st of TR.STATES)
    assert.ok(STATE.STATUSES.includes(TR.STATE_TO_LEGACY[st]), `${st} must mirror to a real legacy status`);
});

// --- 19. direct task-set bypass refused --------------------------------------------

test("transitions: task-set speaks the legacy vocabulary only, and records what it did", (t) => {
  const fx = fixture("tr-taskset"); t.after(() => fx.done());
  const id = addTask(fx, { title: "a task" });

  for (const canonical of ["READY", "CLAIMED", "RUNNING", "AWAITING_DELIVERY", "NEEDS_DECISION"])
    assert.throws(() => fx.cli("task-set", "--project", fx.P, String(id), "--status", canonical),
      /not a task status/, canonical);

  // The legacy word still works — and now leaves a transition record behind.
  fx.cli("task-set", "--project", fx.P, String(id), "--status", "building", "--note", "claimed by hand");
  const task = taskOf(fx, id);
  assert.equal(task.status, "building");
  assert.equal(task.state, "RUNNING");
  assert.equal(task.stateVersion, 1);
  assert.equal(task.stateHistory[0].from, "READY");
  assert.equal(task.stateHistory[0].to, "RUNNING");
  assert.equal(task.stateHistory[0].actor, "operator");
});

test("transitions: a hand-driven move the closed machine would refuse is recorded as such", (t) => {
  const fx = fixture("tr-override"); t.after(() => fx.done());
  const id = addTask(fx, { title: "a task" });
  // queued -> review is READY -> VERIFYING: not a legal edge for anyone.
  fx.cli("task-set", "--project", fx.P, String(id), "--status", "review");
  const task = taskOf(fx, id);
  assert.equal(task.state, "VERIFYING");
  assert.ok(task.stateHistory[0].legacy_override, "the refusal is written down beside the write");
  assert.match(task.stateHistory[0].legacy_override, /illegal transition READY → VERIFYING/);
});

// --- 20. transition audit event ------------------------------------------------------

test("transitions: every move appends an audit line and a project event", (t) => {
  const fx = fixture("tr-audit"); t.after(() => fx.done());
  const id = addTask(fx, { title: "a task" });
  TR.transition(fx.P, id, { to: "CLAIMED", actor: "scheduler", reason: "for the audit", runId: "RUN-1", attempt: 1 });

  const rec = taskOf(fx, id).stateHistory[0];
  for (const k of ["from", "to", "actor", "reason", "project_id", "task_id", "run_id", "attempt", "phase_id", "state_version", "causation_event", "at"])
    assert.ok(k in rec, `a transition record must carry ${k}`);
  assert.equal(rec.run_id, "RUN-1");
  assert.equal(rec.attempt, 1);
  assert.ok(fx.state().events.some((e) => /READY → CLAIMED/.test(e.msg)));
});

// --- named events -----------------------------------------------------------------

test("transitions: task-transition takes an EVENT, and refuses one the state cannot serve", (t) => {
  const fx = fixture("tr-events"); t.after(() => fx.done());
  const id = addTask(fx, { title: "a task" });

  assert.throws(() => fx.cli("task-transition", "--project", fx.P, "--task", String(id), "--event", "release"),
    /ILLEGAL_TRANSITION|already/, "already READY: there is nothing to release");

  fx.cli("task-transition", "--project", fx.P, "--task", String(id), "--event", "block", "--reason", "the API is down");
  assert.equal(taskOf(fx, id).state, "BLOCKED");
  assert.equal(taskOf(fx, id).status, "blocked", "BLOCKED mirrors to `blocked`; `stuck` is what FAILED mirrors to");

  assert.throws(() => fx.cli("task-transition", "--project", fx.P, "--task", String(id), "--event", "vibes"),
    /UNKNOWN_EVENT/);

  // expected-version enforcement reaches the CLI too
  const v = taskOf(fx, id).stateVersion;
  assert.throws(() => fx.cli("task-transition", "--project", fx.P, "--task", String(id),
    "--event", "cancel", "--expect-version", String(v + 5)), /STATE_VERSION_CONFLICT/);
  fx.cli("task-transition", "--project", fx.P, "--task", String(id), "--event", "cancel", "--expect-version", String(v));
  assert.equal(taskOf(fx, id).state, "CANCELLED");
});

test("transitions: the project-wide state projection reports migration honestly", (t) => {
  const fx = fixture("tr-projection"); t.after(() => fx.done());
  const a = addTask(fx, { title: "never moved" });
  const b = addTask(fx, { title: "moved" });
  TR.transition(fx.P, b, { to: "CLAIMED", actor: "scheduler" });

  const rows = TR.projectStates(fx.P);
  assert.equal(rows.find((r) => r.id === a).migrated, false);
  assert.equal(rows.find((r) => r.id === a).state, "READY");
  assert.equal(rows.find((r) => r.id === b).migrated, true);
  assert.equal(rows.find((r) => r.id === b).last_transition.actor, "scheduler");
});
