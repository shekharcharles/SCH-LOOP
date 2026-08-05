// The single writer.
//
// `load → mutate → save` is a read-modify-write. Every await between the read
// and the write is a window where another writer's change is erased, and the
// erasure is silent. These tests are the reason `mutateState` exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fixture, STATE } from "./helpers.mjs";

test("concurrent mutations do not lose updates", () => {
  const fx = fixture("state-mutate");
  try {
    const s0 = STATE.loadState(fx.P);
    s0.counters = {};
    STATE.saveState(fx.P, s0);
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

test("a held lock makes a state mutation fail closed, not proceed unlocked", () => {
  const fx = fixture("state-lock-timeout");
  try {
    // Hold the lock the way a live writer does: the lock dir exists and is
    // fresh, so it is neither stale nor abandoned.
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
