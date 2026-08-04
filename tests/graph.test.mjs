// The task graph: typed dependency reasons, the false-edge audit, hidden
// dependencies, structural validation and readiness.
//
// Nothing here starts a worker or touches a remote — a graph is a data structure
// and its rules must be provable without either.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, addTask, TG, TR } from "./helpers.mjs";

const cs = TR.canonicalState;
const state = (fx) => fx.state();

// Put a task into a state the CLI deliberately will not type its way into
// (CLAIMED, RUNNING, …). A graph test needs to observe those states without
// standing up a scheduler to produce them.
const writeState = (fx, s) =>
  writeFileSync(join(fx.home, "projects", fx.P, "state.json"), JSON.stringify(s, null, 2));

// --- 1. valid linear graph -----------------------------------------------------

test("graph: a valid linear graph validates and only its root is ready", (t) => {
  const fx = fixture("graph-linear"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one" });
  const b = addTask(fx, { title: "two", deps: String(a) });
  const c = addTask(fx, { title: "three", deps: String(b) });

  const v = TG.validateGraph(fx.P, { canonicalState: cs });
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.equal(v.tasks, 3);
  assert.equal(v.edges, 2);

  const pick = TG.selectReady(state(fx), { canonicalState: cs });
  assert.equal(pick.selected.id, a);
  assert.equal(pick.ready.length, 1, "only the root of a chain is ready");
  assert.ok(TG.readiness(state(fx), state(fx).tasks.find((x) => x.id === c), { canonicalState: cs })
    .blockers.some((x) => x.code === "DEPENDENCY_INCOMPLETE"));
});

// --- 2. valid diamond ----------------------------------------------------------

test("graph: a diamond validates, and the join waits for both arms", (t) => {
  const fx = fixture("graph-diamond"); t.after(() => fx.done());
  const root = addTask(fx, { title: "root" });
  const left = addTask(fx, { title: "left", deps: String(root) });
  const right = addTask(fx, { title: "right", deps: String(root) });
  const joinTask = addTask(fx, { title: "join", deps: `${left}|${right}` });

  assert.equal(TG.validateGraph(fx.P, { canonicalState: cs }).ok, true);
  const j = state(fx).tasks.find((x) => x.id === joinTask);
  const r = TG.readiness(state(fx), j, { canonicalState: cs });
  assert.equal(r.ready, false);
  assert.equal(r.blockers.filter((b) => b.code === "DEPENDENCY_INCOMPLETE").length, 2);
});

// --- 3. missing dependency -----------------------------------------------------

test("graph: a dependency on a task that does not exist is a structural problem", (t) => {
  const fx = fixture("graph-missing"); t.after(() => fx.done());
  addTask(fx, { title: "orphan", deps: "999" });
  const v = TG.validateGraph(fx.P, { canonicalState: cs });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.code === "MISSING_DEPENDENCY" && /#999/.test(p.message)));
});

// --- 4. self-dependency --------------------------------------------------------

test("graph: a task that depends on itself is refused", (t) => {
  const fx = fixture("graph-self"); t.after(() => fx.done());
  const a = addTask(fx, { title: "narcissus" });
  fx.cli("task-set", "--project", fx.P, String(a), "--notes", "x");
  const s = state(fx); s.tasks[0].deps = [a];
  writeState(fx, s);
  const v = TG.validateGraph(fx.P, { canonicalState: cs });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.code === "SELF_DEPENDENCY"));
});

// --- 5. cycle ------------------------------------------------------------------

test("graph: a cycle is detected and named, and a long chain does not blow the stack", (t) => {
  const fx = fixture("graph-cycle"); t.after(() => fx.done());
  const a = addTask(fx, { title: "a" });
  const b = addTask(fx, { title: "b", deps: String(a) });
  const c = addTask(fx, { title: "c", deps: String(b) });
  const s = state(fx);
  s.tasks.find((x) => x.id === a).deps = [c];        // close the ring
  writeState(fx, s);

  const v = TG.validateGraph(fx.P, { canonicalState: cs });
  assert.equal(v.ok, false);
  const cyc = v.problems.find((p) => p.code === "DEPENDENCY_CYCLE");
  assert.ok(cyc, "the cycle must be reported");
  for (const n of [a, b, c]) assert.ok(cyc.cycle.includes(n), `cycle should name #${n}`);

  // 500 tasks in a chain: iterative traversal, no recursion limit
  const big = fixture("graph-deep"); t.after(() => big.done());
  let prev = addTask(big, { title: "t1" });
  const bs = big.state();
  for (let i = 2; i <= 500; i++) {
    bs.tasks.push({ ...bs.tasks[0], id: i, title: "t" + i, deps: [prev] });
    prev = i;
  }
  bs.seq.task = 500;
  writeState(big, bs);
  assert.equal(TG.findCycles(big.state()).length, 0);
});

// --- 6. duplicate edge ---------------------------------------------------------

test("graph: the same dependency listed twice is a problem, not a shrug", (t) => {
  const fx = fixture("graph-dup"); t.after(() => fx.done());
  const a = addTask(fx, { title: "a" });
  const b = addTask(fx, { title: "b" });
  const s = state(fx);
  s.tasks.find((x) => x.id === b).deps = [a, a];
  writeState(fx, s);
  const v = TG.validateGraph(fx.P, { canonicalState: cs });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.code === "DUPLICATE_DEPENDENCY"));
});

// --- 7. the false-edge audit ---------------------------------------------------

test("graph: an edge with no defensible reason is WARNED about and never deleted", (t) => {
  const fx = fixture("graph-false-edge"); t.after(() => fx.done());
  const a = addTask(fx, { title: "a", allow: "src/a/**" });
  const b = addTask(fx, { title: "b", deps: String(a), allow: "src/b/**" });

  const v = TG.validateGraph(fx.P, { canonicalState: cs });
  assert.equal(v.ok, true, "a missing reason is an audit finding, not a structural failure");
  assert.ok(v.warnings.some((w) => w.code === "FALSE_EDGE_SUSPECTED" && w.task === b && w.dep === a));
  // and it is still there
  assert.deepEqual(state(fx).tasks.find((x) => x.id === b).deps, [a]);

  // A typed edge that names nothing consumed is equally undefended.
  let s = state(fx);
  s.tasks.find((x) => x.id === b).depMeta = [{ from: a, type: "DATA_DEPENDENCY", consumes: "", note: "" }];
  writeState(fx, s);
  assert.ok(TG.validateGraph(fx.P, { canonicalState: cs }).warnings.some((w) => w.code === "FALSE_EDGE_SUSPECTED"));

  // A declared FILE_CONFLICT between two tasks whose paths do not overlap is a
  // claim the graph itself can check — and it is false.
  s = state(fx);
  s.tasks.find((x) => x.id === b).depMeta = [{ from: a, type: "FILE_CONFLICT", consumes: "the same files", note: "" }];
  writeState(fx, s);
  const v3 = TG.validateGraph(fx.P, { canonicalState: cs });
  assert.ok(v3.warnings.some((w) => w.code === "FALSE_EDGE_SUSPECTED" && /do not overlap/.test(w.message)));
});

// --- 8. typed dependency -------------------------------------------------------

test("graph: a typed, defended edge produces no audit warning; an unknown type is refused", (t) => {
  const fx = fixture("graph-typed"); t.after(() => fx.done());
  const a = addTask(fx, { title: "produce the contract" });
  const b = addTask(fx, { title: "consume it", deps: String(a) });
  fx.cli("task-set", "--project", fx.P, String(b), "--dep-reason", `${a}:DATA_DEPENDENCY:api_contract`);

  const v = TG.validateGraph(fx.P, { canonicalState: cs });
  assert.equal(v.ok, true);
  assert.equal(v.warnings.length, 0, JSON.stringify(v.warnings));
  const edge = TG.edges(state(fx)).find((e) => e.to === b);
  assert.equal(edge.type, "DATA_DEPENDENCY");
  assert.equal(edge.consumes, "api_contract");

  // the CLI refuses a type that is not in the vocabulary
  assert.throws(() => fx.cli("task-set", "--project", fx.P, String(b), "--dep-reason", `${a}:VIBES:whatever`), /not a dependency type/);
  // …and a reason for an edge that does not exist
  assert.throws(() => fx.cli("task-set", "--project", fx.P, String(b), "--dep-reason", `999:DATA_DEPENDENCY:x`), /does not depend on/);
});

// --- 9. hidden file conflict ---------------------------------------------------

test("graph: two tasks owning the same paths are ordered even when nobody wrote the edge", (t) => {
  const fx = fixture("graph-hidden"); t.after(() => fx.done());
  const a = addTask(fx, { title: "auth service", allow: "src/auth/**" });
  const b = addTask(fx, { title: "auth policy", allow: "src/auth/policy.ts" });

  // Nothing hidden while both are merely queued: sequential execution means only
  // one runs, and a conflict with a task nobody is working on is not a conflict.
  assert.equal(TG.readiness(state(fx), state(fx).tasks.find((x) => x.id === b), { canonicalState: cs }).ready, true);

  // Now A is actually in flight and owns those files.
  const s = state(fx);
  s.tasks.find((x) => x.id === a).state = "RUNNING";
  writeState(fx, s);

  const r = TG.readiness(state(fx), state(fx).tasks.find((x) => x.id === b), { canonicalState: cs });
  assert.equal(r.ready, false);
  const hidden = r.blockers.find((x) => x.code === "HIDDEN_FILE_CONFLICT");
  assert.ok(hidden, JSON.stringify(r.blockers));
  assert.match(hidden.detail, /overlaps/);
  assert.equal(hidden.hidden, true);

  // A hidden edge is NEVER written into the graph the operator authored.
  assert.deepEqual(state(fx).tasks.find((x) => x.id === b).deps, []);
  assert.equal(TG.validateGraph(fx.P, { canonicalState: cs }).ok, true);
});

test("graph: a shared control file and a shared schema path are hidden dependencies too", (t) => {
  const fx = fixture("graph-hidden-2"); t.after(() => fx.done());
  const a = addTask(fx, { title: "bump deps", allow: "package.json" });
  const b = addTask(fx, { title: "add a script", allow: "package.json" });
  const c = addTask(fx, { title: "migration one", allow: "migrations/**" });
  const d = addTask(fx, { title: "migration two", allow: "migrations/002.sql" });

  const s = state(fx);
  s.tasks.find((x) => x.id === a).state = "VERIFYING";
  s.tasks.find((x) => x.id === c).state = "AWAITING_DELIVERY";
  writeState(fx, s);

  const rb = TG.readiness(state(fx), state(fx).tasks.find((x) => x.id === b), { canonicalState: cs });
  assert.ok(rb.blockers.some((x) => x.hidden), JSON.stringify(rb.blockers));
  const rd = TG.readiness(state(fx), state(fx).tasks.find((x) => x.id === d), { canonicalState: cs });
  assert.ok(rd.blockers.some((x) => x.hidden), JSON.stringify(rd.blockers));
});

// --- 10 + 11. blocked and cancelled dependencies -------------------------------

test("graph: a blocked dependency blocks its child, distinctly from merely incomplete", (t) => {
  const fx = fixture("graph-blocked"); t.after(() => fx.done());
  const a = addTask(fx, { title: "a" });
  const b = addTask(fx, { title: "b", deps: String(a) });
  const s = state(fx);
  s.tasks.find((x) => x.id === a).state = "BLOCKED";
  writeState(fx, s);
  const r = TG.readiness(state(fx), state(fx).tasks.find((x) => x.id === b), { canonicalState: cs });
  assert.equal(r.ready, false);
  assert.ok(r.blockers.some((x) => x.code === "BLOCKED_DEPENDENCY" && x.dep_state === "BLOCKED"));
});

test("graph: a cancelled dependency is refused unless policy explicitly allows it", (t) => {
  const fx = fixture("graph-cancelled"); t.after(() => fx.done());
  const a = addTask(fx, { title: "a" });
  const b = addTask(fx, { title: "b", deps: String(a) });
  let s = state(fx);
  s.tasks.find((x) => x.id === a).state = "CANCELLED";
  writeState(fx, s);

  const v = TG.validateGraph(fx.P, { canonicalState: cs });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.code === "CANCELLED_DEPENDENCY"));

  s = state(fx);
  s.tasks.find((x) => x.id === b).dependencyPolicy = { allow_cancelled: true };
  writeState(fx, s);
  assert.equal(TG.validateGraph(fx.P, { canonicalState: cs }).ok, true, "an explicit policy makes it deliberate");
  assert.equal(TG.readiness(state(fx), state(fx).tasks.find((x) => x.id === b), { canonicalState: cs }).ready, true);
});

// --- 12. a delivered dependency makes its child ready ---------------------------

test("graph: DELIVERED satisfies a dependency; AWAITING_DELIVERY does not", (t) => {
  const fx = fixture("graph-delivered"); t.after(() => fx.done());
  const a = addTask(fx, { title: "a" });
  const b = addTask(fx, { title: "b", deps: String(a) });

  const setA = (st, legacy) => {
    const s = state(fx);
    const ta = s.tasks.find((x) => x.id === a);
    ta.state = st; ta.status = legacy;
    writeState(fx, s);
    return TG.readiness(state(fx), state(fx).tasks.find((x) => x.id === b), { canonicalState: cs });
  };

  // Locally verified is NOT delivered. The child must not start on a promise.
  assert.equal(setA("AWAITING_DELIVERY", "review").ready, false);
  // On the remote: now it is real.
  assert.equal(setA("DELIVERED", "delivered").ready, true);
  // And the historical local-completion word still counts, because it is history.
  assert.equal(setA("AWAITING_DELIVERY", "merged").ready, true);
});

// --- path overlap, the primitive underneath hidden dependencies -----------------

test("graph: path overlap is direction-independent and does not fire on siblings", () => {
  assert.equal(TG.pathsOverlap(["src/**"], ["src/auth/service.ts"]).overlap, true);
  assert.equal(TG.pathsOverlap(["src/auth/**"], ["src/**"]).overlap, true);
  assert.equal(TG.pathsOverlap(["src/auth/**"], ["src/billing/**"]).overlap, false);
  assert.equal(TG.pathsOverlap(["tests/auth/**"], ["src/auth/**"]).overlap, false);
});

// --- the read-only projection ---------------------------------------------------

test("graph: the projection carries state, readiness, reasons and hidden edges", (t) => {
  const fx = fixture("graph-projection"); t.after(() => fx.done());
  const a = addTask(fx, { title: "a", allow: "src/x/**" });
  const b = addTask(fx, { title: "b", deps: String(a), allow: "src/x/**" });
  fx.cli("task-set", "--project", fx.P, String(b), "--dep-reason", `${a}:DATA_DEPENDENCY:x`);

  const g = TG.projectGraph(fx.P, { canonicalState: cs });
  assert.equal(g.nodes.length, 2);
  assert.deepEqual(g.nodes.find((n) => n.id === b).depends_on, [a]);
  assert.deepEqual(g.nodes.find((n) => n.id === a).blocks, [b]);
  assert.equal(g.edges[0].type, "DATA_DEPENDENCY");
  assert.equal(g.validation.ok, true);

  const md = TG.renderTaskQueueMarkdown(g);
  assert.match(md, /read-only projection/);
  assert.match(md, /Editing it changes nothing/);
});
