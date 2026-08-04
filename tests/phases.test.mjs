// The phase engine, the typed envelope registry and the named gate registry.
//
// The claim under test throughout: a process exiting 0 gets you to EXECUTED and
// nowhere else. REPORTED needs a valid, identity-checked envelope; GATED needs
// every required gate to have run; ACCEPTED needs every one of them to have
// passed. An agent saying "done" is not any of those things.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, addTask, ENV, GATE, PH, SCHED } from "./helpers.mjs";

const dir = (t) => { const d = mkdtempSync(join(tmpdir(), "sch-phase-")); t.after(() => { try { rmSync(d, { recursive: true, force: true }); } catch {} }); return d; };
const ID = { project_id: "proj", task_id: "7", run_id: "RUN-1", attempt: 1 };
const env = (over = {}) => ({
  schema_version: 1, envelope_type: "BuilderEnvelopeV1", project_id: "proj", task_id: "7",
  run_id: "RUN-1", phase_id: "implement", status: "SUCCESS", summary: "did the thing",
  artifacts: [], claims: {}, notes_for_next_phase: "", candidate_learnings: [], ...over,
});

// ================================================================ envelopes

// --- 33. every envelope type is constructible and valid -------------------------

test("envelopes: every registered type validates in its own phase", () => {
  const cases = {
    PlannerEnvelopeV1: { plan_steps: ["one", "two"], open_questions: [] },
    // The roles added by the software-factory milestone each produce their own
    // type: a scout cannot report changed files, and a repairer answers a
    // different question from a builder.
    ScoutEnvelopeV1: { locations: ["src/auth"], entry_points: [], observations: [], open_questions: [] },
    RepairEnvelopeV1: { addressed_checks: ["unit"], files_reported_changed: ["src/a.js"], root_cause: "off-by-one", remaining_concerns: [] },
    DocumentationEnvelopeV1: { files_reported_changed: ["README.md"], sections_written: ["Usage"], claims_verified: [] },
    BuilderEnvelopeV1: { files_reported_changed: ["src/a.js"], commands_reported: [] },
    ReviewerEnvelopeV1: { outcome: "APPROVE", findings: [], must_fix: [] },
    DecisionRequestEnvelopeV1: { gate_type: "SCHEMA_CHANGE", question: "which?", options: ["a", "b"], recommended: "a" },
    CodeResultEnvelopeV1: { result: { ok: true }, failure_code: "" },
    GateReportEnvelopeV1: { gates: [], outcome: "PASS" },
    DeliveryEnvelopeV1: { delivery_id: "DEL-1", commit: "abc", branch: "main", remote: "origin", state: "DELIVERED" },
  };
  for (const [type, extra] of Object.entries(cases)) {
    const status = type === "DecisionRequestEnvelopeV1" ? "NEEDS_DECISION" : "SUCCESS";
    const e = env({ envelope_type: type, status, phase_id: "p", ...extra });
    const r = ENV.validate(e, { ...ID, phase_id: "p" }, { type });
    assert.equal(r.ok, true, `${type}: ${r.failure?.message}`);
    assert.equal(r.envelope_type, type);
    assert.match(r.hash, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(ENV.ENVELOPE_TYPES.sort(), Object.keys(cases).sort());
});

// --- 34. unknown type ------------------------------------------------------------

test("envelopes: an unknown type, an unknown schema and a stray field are all refused", () => {
  assert.equal(ENV.validate(env({ envelope_type: "VibesEnvelopeV9" }), ID).failure.code, "ENVELOPE_TYPE_UNKNOWN");
  assert.equal(ENV.validate(env({ schema_version: 99 }), ID).failure.code, "ENVELOPE_SCHEMA_UNKNOWN");
  const stray = ENV.validate(env({ run_shell: "rm -rf /" }), ID);
  assert.equal(stray.failure.code, "ENVELOPE_UNKNOWN_FIELD");
  assert.match(stray.failure.message, /where an instruction hides/);
});

// --- 35 + 36. wrong phase, wrong attempt -----------------------------------------

test("envelopes: an envelope naming another phase, run, task or attempt is refused", () => {
  for (const over of [{ phase_id: "somewhere-else" }, { run_id: "RUN-999" }, { task_id: "8" }, { project_id: "other" }]) {
    const r = ENV.validate(env(over), { ...ID, phase_id: "implement" });
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.failure.code, "ENVELOPE_IDENTITY_MISMATCH");
  }
  const wrongAttempt = ENV.validate(env({ claims: { attempt: 3 } }), { ...ID, phase_id: "implement", attempt: 1 });
  assert.equal(wrongAttempt.failure.code, "ENVELOPE_IDENTITY_MISMATCH");
});

// --- 37. oversized ----------------------------------------------------------------

test("envelopes: size and array limits are enforced, and exactly one block is required", () => {
  const big = ENV.validate(env({ summary: "x".repeat(ENV.LIMITS.summary + 1) }), { ...ID, phase_id: "implement" });
  assert.equal(big.failure.code, "ENVELOPE_FIELD_TOO_LONG");
  const many = ENV.validate(env({ files_reported_changed: Array.from({ length: 200 }, (_, i) => "f" + i) }), { ...ID, phase_id: "implement" });
  assert.equal(many.failure.code, "ENVELOPE_FIELD_TOO_LONG");

  const one = `${ENV.ENVELOPE_OPEN}\n${JSON.stringify(env())}\n${ENV.ENVELOPE_CLOSE}`;
  assert.equal(ENV.extract("noise\n" + one + "\nmore noise").ok, true);
  assert.equal(ENV.extract("nothing here").failure.code, "ENVELOPE_MISSING");
  assert.equal(ENV.extract(one + "\n" + one).failure.code, "ENVELOPE_AMBIGUOUS");
  assert.equal(ENV.extract(ENV.ENVELOPE_OPEN + "\n{}\n").failure.code, "ENVELOPE_MALFORMED");
  assert.equal(ENV.extract(`${ENV.ENVELOPE_OPEN}\n{not json}\n${ENV.ENVELOPE_CLOSE}`).failure.code, "ENVELOPE_MALFORMED");
  const huge = `${ENV.ENVELOPE_OPEN}\n${"x".repeat(ENV.LIMITS.envelope_bytes + 10)}\n${ENV.ENVELOPE_CLOSE}`;
  assert.equal(ENV.extract(huge).failure.code, "ENVELOPE_TOO_LARGE");
});

// --- 38. claim versus evidence ------------------------------------------------------

test("envelopes: a claim is stored as a claim and never as evidence", () => {
  const e = env({ status: "SUCCESS", claims: { tests_passed: true }, files_reported_changed: ["src/a.js"] });
  const r = ENV.validate(e, { ...ID, phase_id: "implement" });
  assert.equal(r.ok, true);
  // The gate that reads this looks at ctx.effects and ctx.verification, NOT the
  // envelope — so a lying envelope changes nothing about the verdict.
  const lying = GATE.evaluate(["changed-paths-allowed", "required-verification-passed"], {
    envelope_result: r,
    effects: { paths: [{ path: "src/evil.js", kind: "modified" }], rejected_paths: [{ path: "src/evil.js", why: "not allowed" }], git_effects: [] },
    verification: { results: [{ id: "unit", display: "npm test", result: "FAILED", exit_code: 1 }], passed: 0, failed: 1, all_passed: false },
  });
  assert.equal(lying.outcome, "FAIL");
  assert.deepEqual(lying.failed.sort(), ["changed-paths-allowed", "required-verification-passed"]);
});

// --- 39. legacy handoff adapter -------------------------------------------------------

test("envelopes: the previous milestone's worker handoff is adapted, not guessed at", () => {
  const legacy = {
    schema_version: 1, run_id: "RUN-1", project_id: "proj", task_id: "7",
    worker_status: "COMPLETED", summary: "did the task",
    files_reported_changed: ["src/a.js"], commands_reported: [], tests_reported: [],
    decisions: [], issues: [], candidate_lessons: ["a lesson"], recommended_next_action: "verify",
  };
  assert.equal(ENV.isLegacyHandoff(legacy), true);
  const r = ENV.adaptLegacyHandoff(legacy, { ...ID, phase_id: "parse-builder-envelope" });
  assert.equal(r.ok, true, r.failure?.message);
  assert.equal(r.adapted, true);
  assert.equal(r.envelope.envelope_type, "BuilderEnvelopeV1");
  assert.equal(r.envelope.status, "SUCCESS");
  assert.deepEqual(r.envelope.candidate_learnings, ["a lesson"]);
  assert.equal(r.envelope.claims.adapted_from, "legacy-worker-handoff");

  assert.equal(ENV.adaptLegacyHandoff({ ...legacy, worker_status: "BLOCKED" }, { ...ID, phase_id: "p" }).envelope.status, "BLOCKED");
  assert.equal(ENV.adaptLegacyHandoff({ ...legacy, worker_status: "WHATEVER" }, { ...ID, phase_id: "p" }).failure.code, "ENVELOPE_STATUS_INVALID");
});

// --- 40. artifact reference validation -------------------------------------------------

test("envelopes: an artifact reference may not escape, absolutise or name a fetchable scheme", () => {
  const bad = ["/etc/passwd", "C:\\Windows\\system32", "artifact://../../secrets", "https://example.com/x", "x.json"];
  for (const ref of bad) {
    const r = ENV.validate(env({ artifacts: [ref] }), { ...ID, phase_id: "implement" });
    assert.equal(r.ok, false, ref);
    assert.equal(r.failure.code, "ENVELOPE_ARTIFACT_INVALID");
  }
  assert.equal(ENV.validate(env({ artifacts: ["artifact://verification/unit.json"] }), { ...ID, phase_id: "implement" }).ok, true);
});

// =================================================================== gates

// --- 41. a gate report carries evidence, never a bare boolean ----------------------

test("gates: every report names what was checked, with evidence and a stable hash", () => {
  const ctx = { effects: { paths: [{ path: "src/a.js", kind: "modified" }], rejected_paths: [], git_effects: [], counts: { modified: 1 } } };
  const r = GATE.evaluate(["changed-paths-allowed"], ctx);
  const rep = r.reports[0];
  assert.equal(rep.outcome, "PASS");
  assert.equal(typeof rep.checks[0].item, "string");
  assert.equal(rep.checks[0].passed, true);
  assert.ok(rep.checks[0].evidence.length, "a check without evidence is a boolean in disguise");
  assert.match(rep.evidence_hash, /^[0-9a-f]{64}$/);
  assert.ok(rep.started_at && rep.ended_at);
  assert.equal(rep.gate_version, 1);

  // 44. the same evidence hashes the same; different evidence does not
  const again = GATE.evaluate(["changed-paths-allowed"], ctx).reports[0];
  assert.equal(again.evidence_hash, rep.evidence_hash);
  const changed = GATE.evaluate(["changed-paths-allowed"], {
    effects: { paths: [{ path: "src/b.js", kind: "modified" }], rejected_paths: [], git_effects: [] },
  }).reports[0];
  assert.notEqual(changed.evidence_hash, rep.evidence_hash);
});

test("gates: a gate whose evidence is absent FAILS — it never quietly passes or skips", () => {
  for (const id of GATE.GATE_IDS) {
    const r = GATE.evaluate([id], {});
    assert.equal(r.reports[0].outcome, "FAIL", `${id} must fail closed with no evidence`);
  }
  const unknown = GATE.evaluate(["no-such-gate"], {});
  assert.equal(unknown.outcome, "FAIL");
  assert.match(unknown.reports[0].note, /no gate named/);
});

// --- 42 + 43. overridable policy, non-overridable fact -----------------------------

test("gates: a factual gate cannot be overridden by anyone; a policy gate can, on the record", () => {
  const factual = ["worker-effects-contained", "changed-paths-allowed", "forbidden-git-effects-absent",
    "required-verification-passed", "secret-scan-passed", "verified-diff-unchanged",
    "outgoing-commit-safe", "remote-commit-present", "task-completion-valid", "task-ready"];
  for (const id of factual) {
    assert.equal(GATE.isFactual(id), true, id);
    const r = GATE.override(id, { approver: "boss", reason: "I said so" });
    assert.equal(r.ok, false, id);
    assert.equal(r.failure.code, "FACTUAL_GATE_NOT_OVERRIDABLE");
    assert.match(r.failure.message, /change the world, then run it again/);
  }
  const policy = GATE.override("delivery-approval-valid", { approver: "operator", reason: "trusted diff" });
  assert.equal(policy.ok, true);
  assert.equal(policy.override.approver, "operator");
  assert.equal(GATE.override("delivery-approval-valid", { approver: "", reason: "" }).failure.code, "OVERRIDE_INCOMPLETE");

  // A failing factual gate is reported separately from a failing policy one, so
  // no caller has to re-derive which of its failures were negotiable.
  const mixed = GATE.evaluate(["forbidden-git-effects-absent", "delivery-approval-valid"], {
    effects: { git_effects: [{ kind: "staged", detail: "the worker staged src/a.js" }], paths: [], rejected_paths: [] },
    approval: { state: "PENDING", why: "nobody signed it" },
  });
  assert.deepEqual(mixed.factual_failures, ["forbidden-git-effects-absent"]);
  assert.deepEqual(mixed.policy_failures, ["delivery-approval-valid"]);
});

// --- 45. re-running a gate on changed evidence ------------------------------------

test("gates: a gate re-run after the evidence changes gives the new answer", () => {
  const fail = GATE.evaluate(["required-verification-passed"], {
    verification: { results: [{ id: "unit", display: "npm test", result: "FAILED", exit_code: 1 }], passed: 0, failed: 1 },
  });
  assert.equal(fail.outcome, "FAIL");
  const pass = GATE.evaluate(["required-verification-passed"], {
    verification: { results: [{ id: "unit", display: "npm test", result: "PASSED", exit_code: 0 }], passed: 1, failed: 0 },
  });
  assert.equal(pass.outcome, "PASS");
  assert.notEqual(fail.reports[0].evidence_hash, pass.reports[0].evidence_hash);
});

// --- 46. the project-completion gate ------------------------------------------------

test("gates: project completion is deterministic and every clause is reported", (t) => {
  const fx = fixture("gate-completion"); t.after(() => fx.done());
  const a = addTask(fx, { title: "outstanding" });

  let c = SCHED.evaluateCompletion(fx.P);
  assert.equal(c.complete, false);
  assert.equal(c.reasons.length, 5);
  assert.ok(c.reasons.some((r) => !r.passed && /required task/.test(r.item)));
  assert.equal(GATE.evaluate(["project-completion-valid"], { completion: c }).outcome, "FAIL");

  const s = fx.state();
  s.tasks.find((x) => x.id === a).state = "DELIVERED";
  s.tasks.find((x) => x.id === a).status = "delivered";
  writeFileSync(join(fx.home, "projects", fx.P, "state.json"), JSON.stringify(s, null, 2));

  c = SCHED.evaluateCompletion(fx.P);
  assert.equal(c.complete, true, JSON.stringify(c.reasons.filter((r) => !r.passed)));
  assert.equal(GATE.evaluate(["project-completion-valid"], { completion: c }).outcome, "PASS");
});

// ============================================================== phase engine

const noop = async () => ({ ok: true });

// --- 21. HUMAN phase -----------------------------------------------------------------

test("phases: a HUMAN phase starts no agent and stops for a decision", async (t) => {
  const d = dir(t);
  const def = { id: "delivery-approval", kind: "HUMAN", output_schema: null, gates: ["delivery-approval-valid"] };

  const pending = await PH.runPhase(def, { attemptDir: d, identity: { ...ID, phase_id: def.id },
    ctx: { approval: { state: "PENDING", why: "nobody has signed it" } },
    work: async () => ({ ok: false, state: "NEEDS_DECISION", failure: { code: "APPROVAL_REQUIRED", message: "a person must approve" } }) });
  assert.equal(pending.state, "NEEDS_DECISION");
  assert.equal(pending.kind, "HUMAN");

  const approved = await PH.runPhase(def, { attemptDir: join(d, "b"), identity: { ...ID, phase_id: def.id },
    ctx: { approval: { state: "APPROVED", approver: "operator", at: "now" } }, work: noop });
  assert.equal(approved.state, "ACCEPTED");
});

// --- 22 + 23 + 24. AGENT, CODE and GATE phases -----------------------------------------

test("phases: AGENT, CODE and GATE phases each reach ACCEPTED through the same checkpoints", async (t) => {
  const d = dir(t);
  const stdout = `narrative\n${ENV.ENVELOPE_OPEN}\n${JSON.stringify(env({ phase_id: "implement" }))}\n${ENV.ENVELOPE_CLOSE}`;

  const agent = await PH.runPhase({ id: "implement", kind: "AGENT", role: "builder", output_schema: "BuilderEnvelopeV1", gates: [] },
    { attemptDir: join(d, "agent"), identity: { ...ID, phase_id: "implement" }, work: async () => ({ ok: true, stdout }) });
  assert.equal(agent.state, "ACCEPTED");
  assert.equal(agent.envelope_type, "BuilderEnvelopeV1");
  assert.match(agent.envelope_hash, /^[0-9a-f]{64}$/);
  assert.equal(agent.role, "builder");

  const code = await PH.runPhase({ id: "verify", kind: "CODE", output_schema: "CodeResultEnvelopeV1", gates: [] },
    { attemptDir: join(d, "code"), identity: { ...ID, phase_id: "verify" },
      work: async () => ({ ok: true, envelope: ENV.build("CodeResultEnvelopeV1", { ...ID, phase_id: "verify" }, { status: "SUCCESS", summary: "ran", result: { passed: 1 } }) }) });
  assert.equal(code.state, "ACCEPTED");

  const gate = await PH.runPhase({ id: "effects-gate", kind: "GATE", output_schema: "GateReportEnvelopeV1", gates: ["forbidden-git-effects-absent"] },
    { attemptDir: join(d, "gate"), identity: { ...ID, phase_id: "effects-gate" },
      ctx: { effects: { git_effects: [], paths: [], rejected_paths: [] } },
      work: async () => ({ ok: true, envelope: ENV.build("GateReportEnvelopeV1", { ...ID, phase_id: "effects-gate" }, { status: "SUCCESS", summary: "clean", outcome: "PASS", gates: [] }) }) });
  assert.equal(gate.state, "ACCEPTED");
  assert.equal(gate.gate_reports.length, 1);
  assert.equal(gate.gate_summary.outcome, "PASS");
});

// --- 25. zero exit but an invalid envelope ---------------------------------------------

test("phases: exit 0 with an unusable envelope stops at EXECUTED and fails", async (t) => {
  const d = dir(t);
  const def = { id: "implement", kind: "AGENT", role: "builder", output_schema: "BuilderEnvelopeV1", gates: [] };

  const none = await PH.runPhase(def, { attemptDir: join(d, "1"), identity: { ...ID, phase_id: "implement" },
    work: async () => ({ ok: true, stdout: "I finished the task! Everything works." }) });
  assert.equal(none.state, "FAILED");
  assert.equal(none.failure.code, "ENVELOPE_MISSING");
  assert.equal(none.outcome, "FAILED");

  const wrong = await PH.runPhase(def, { attemptDir: join(d, "2"), identity: { ...ID, phase_id: "implement" },
    work: async () => ({ ok: true, stdout: `${ENV.ENVELOPE_OPEN}\n${JSON.stringify(env({ task_id: "999", phase_id: "implement" }))}\n${ENV.ENVELOPE_CLOSE}` }) });
  assert.equal(wrong.state, "FAILED");
  assert.equal(wrong.failure.code, "ENVELOPE_IDENTITY_MISMATCH");
});

// --- 26. a valid envelope but a failed gate --------------------------------------------

test("phases: a perfect envelope does not survive a failed gate", async (t) => {
  const d = dir(t);
  const rec = await PH.runPhase({ id: "effects-gate", kind: "GATE", output_schema: "GateReportEnvelopeV1", gates: ["changed-paths-allowed"] },
    { attemptDir: d, identity: { ...ID, phase_id: "effects-gate" },
      ctx: { effects: { paths: [{ path: "package.json", kind: "modified" }], rejected_paths: [{ path: "package.json", why: "forbidden by the task policy" }], git_effects: [] } },
      work: async () => ({ ok: true, envelope: ENV.build("GateReportEnvelopeV1", { ...ID, phase_id: "effects-gate" }, { status: "SUCCESS", summary: "all good!", outcome: "PASS", gates: [] }) }) });
  assert.equal(rec.state, "FAILED", "a factual gate failure is not retryable by repeating it");
  assert.equal(rec.failure.code, "GATE_FAILED");
  assert.match(rec.failure.message, /cannot be overridden/);
  assert.equal(rec.envelope.summary, "all good!", "the claim is kept — as a claim");
  assert.equal(rec.gate_summary.factual_failures[0], "changed-paths-allowed");
});

test("phases: a failed POLICY gate is RETRYABLE, a failed FACTUAL gate is not", async (t) => {
  const d = dir(t);
  const policy = await PH.runPhase({ id: "verification-gate", kind: "GATE", output_schema: null, gates: ["prompt-budget-valid"] },
    { attemptDir: d, identity: { ...ID, phase_id: "verification-gate" },
      ctx: { prompt_manifest: { total_characters: 90000, limit_characters: 60000, sections: [], compacted: [], unit: "characters" }, prompt_limit: 60000 },
      work: noop });
  assert.equal(policy.state, "RETRYABLE");
});

// --- 27. all gates pass -> ACCEPTED ------------------------------------------------------

test("phases: ACCEPTED requires every required gate to have run AND passed", async (t) => {
  const d = dir(t);
  const rec = await PH.runPhase({ id: "effects-gate", kind: "GATE", output_schema: null,
      gates: ["worker-effects-contained", "changed-paths-allowed", "forbidden-git-effects-absent"] },
    { attemptDir: d, identity: { ...ID, phase_id: "effects-gate" },
      ctx: { effects: { paths: [{ path: "src/a.js", kind: "modified" }], rejected_paths: [], git_effects: [], counts: {} } },
      work: noop });
  assert.equal(rec.state, "ACCEPTED");
  assert.equal(rec.gate_reports.length, 3, "every required gate must have actually run");
  assert.deepEqual(rec.gate_summary.passed.sort(), ["changed-paths-allowed", "forbidden-git-effects-absent", "worker-effects-contained"]);
});

// --- 28 + 29. persistence and restart recovery ---------------------------------------------

test("phases: state is persisted, and a restart can say exactly where it was", async (t) => {
  const d = dir(t);
  const wf = SCHED.TASK_WORKFLOW;
  for (const id of ["prepare", "task-readiness"])
    await PH.runPhase(wf.find((p) => p.id === id), { attemptDir: d, identity: { ...ID, phase_id: id },
      index: wf.findIndex((p) => p.id === id),
      work: async () => ({ ok: true, envelope: ENV.build(wf.find((p) => p.id === id).output_schema, { ...ID, phase_id: id },
        { status: "SUCCESS", summary: "ok", ...(id === "task-readiness" ? { outcome: "PASS", gates: [] } : { result: {} }) }) }),
      ctx: { workspace: { problems: [], dir: "d", root: "r" }, graph_validation: { problems: [], warnings: [], tasks: 1, edges: 0 },
             readiness: { task_id: 7, state: "READY", ready: true, blockers: [] } } });

  assert.ok(existsSync(join(d, "phases", "prepare.json")));
  const onDisk = JSON.parse(readFileSync(join(d, "phases", "task-readiness.json"), "utf8"));
  assert.equal(onDisk.state, "ACCEPTED");
  assert.equal(onDisk.schema_version, 1);

  const rp = PH.recoveryPoint(d, wf);
  assert.equal(rp.last_accepted, "task-readiness");
  assert.equal(rp.resume_at, "compile-context", "a restart resumes at the next phase, not at the beginning");
  assert.equal(rp.stopped, null);
  assert.equal(rp.completed, false);

  // A stopped phase is where recovery points, not past it.
  await PH.runPhase(wf.find((p) => p.id === "compile-context"), { attemptDir: d, identity: { ...ID, phase_id: "compile-context" },
    index: 2, work: async () => ({ ok: false, failure: { code: "POLICY_VIOLATION", message: "nope" } }) });
  const rp2 = PH.recoveryPoint(d, wf);
  assert.equal(rp2.resume_at, "compile-context");
  assert.equal(rp2.stopped.state, "FAILED");
});

// --- 30 + 31. no skipping, no going backwards -----------------------------------------------

test("phases: the lifecycle refuses a skip and refuses a reversal", () => {
  assert.equal(PH.canAdvance("PENDING", "RUNNING").ok, true);
  assert.equal(PH.canAdvance("PENDING", "ACCEPTED").ok, false);
  assert.match(PH.canAdvance("RUNNING", "ACCEPTED").why, /never skips a checkpoint/);
  assert.match(PH.canAdvance("EXECUTED", "RUNNING").why, /never moves backwards/);
  assert.match(PH.canAdvance("ACCEPTED", "RUNNING").why, /already ACCEPTED/);
  assert.match(PH.canAdvance("FAILED", "RUNNING").why, /already stopped/);
  // stopping is always available from anywhere still moving
  for (const from of ["PENDING", "RUNNING", "EXECUTED", "REPORTED", "GATED"])
    assert.equal(PH.canAdvance(from, "FAILED").ok, true, from);
  assert.deepEqual(PH.PHASE_KINDS, ["HUMAN", "AGENT", "CODE", "GATE"]);
});

// --- 32. protected orchestration files ------------------------------------------------------

test("phases: the whole workspace, .git and the scheduler's own record are denied to a worker", async () => {
  const WSx = await import("../scripts/workspace.mjs");
  assert.ok(WSx.WORKER_FORBIDDEN.includes(".sch-loop/"), "a worker may not write SCH control state at all");
  assert.ok(WSx.WORKER_FORBIDDEN.includes(".git/"));
  assert.ok(WSx.RUNTIME_DIRS.includes("scheduler"), "the scheduler's records are runtime state, ignored and worker-denied");
  assert.ok(WSx.WORKSPACE_ALWAYS_DENY.includes(".sch-loop/scheduler/"));
  // and the durable planning record is still trackable, which is the whole point
  // of the narrow ignore rules
  for (const p of WSx.TRACKED_PATHS)
    assert.ok(!WSx.RUNTIME_DIRS.some((d) => p.startsWith(d + "/")), `${p} must not fall under a runtime ignore rule`);
});

// --- the agent role roster ---------------------------------------------------------------------

test("phases: roles separate what an agent is for from how it is started and what it may write", () => {
  assert.deepEqual(Object.keys(PH.ROLES).sort(), ["builder", "planner", "reviewer"]);
  const r = PH.ROLES.reviewer;
  assert.deepEqual(r.tools, ["read"], "a reviewer reads; it does not edit and it does not shell out");
  assert.deepEqual(r.writes, [], "a reviewer writes nothing at all");
  assert.equal(r.output_envelope, "ReviewerEnvelopeV1");
  assert.notEqual(r.role, r.executor, "the role is not the executor");
  assert.equal(PH.ROLES.builder.writes_from_task_policy, true, "the builder's write scope comes from the TASK, never from the role");
  assert.equal(PH.ROLES.planner.skills_from_task_profile, undefined);
  assert.ok(PH.ROLES.planner.capabilities.length, "roles name capabilities; the trusted registry resolves them to skills");
  assert.equal(PH.resolveRole("nope").failure.code, "UNKNOWN_ROLE");
});

// --- the phase-level accounting ------------------------------------------------------------------

test("phases: accounting is in characters and bytes, and says so", async (t) => {
  const d = dir(t);
  const rec = await PH.runPhase({ id: "implement", kind: "AGENT", role: "builder", output_schema: null, gates: [] },
    { attemptDir: d, identity: { ...ID, phase_id: "implement" },
      work: async () => ({ ok: true, accounting: { prompt_characters: 1234, output_bytes: 99, executor: "fake" } }) });
  assert.equal(rec.accounting.prompt_characters, 1234);
  assert.equal(rec.accounting.output_bytes, 99);
  assert.equal(rec.accounting.unit, "characters");
  assert.match(rec.accounting.note, /not tokens/);
});

// --- the repair context, which is a token-control feature -------------------------------------------

test("phases: a repair attempt receives failure evidence only, inside a hard budget", () => {
  const r = SCHED.repairContext({
    task: { id: 7, title: "t" },
    previousAttempt: { attempt: 1, outcome: "FAILED", failure: { code: "VERIFICATION_FAILURE", message: "npm test exited 1" } },
    gateReports: [{ gate_id: "required-verification-passed", outcome: "FAIL", checks: [{ item: "unit", passed: false, evidence: "exit 1" }] }],
    verification: { all_passed: false, results: [{ display: "npm test", result: "FAILED", exit_code: 1, stderr: "AssertionError: expected 2 got 3" }] },
    effects: { paths: [{ path: "src/a.js", kind: "modified" }], rejected_paths: [] },
  });
  assert.match(r.text, /VERIFICATION_FAILURE/);
  assert.match(r.text, /AssertionError/);
  assert.match(r.text, /src\/a\.js/);
  assert.equal(r.manifest.unit, "characters");
  assert.ok(r.manifest.total_characters < 6000);
  // nothing resembling a transcript, a full log or a project history
  assert.ok(!/transcript|LEARNING\.md|previous run log/i.test(r.text));

  // over budget, WHOLE sections go — never half a stack trace
  const big = SCHED.repairContext({
    task: { id: 7 }, previousAttempt: { attempt: 1, outcome: "FAILED", failure: { code: "VERIFICATION_FAILURE", message: "x".repeat(3000) } },
    verification: { all_passed: false, results: [{ display: "npm test", result: "FAILED", exit_code: 1, stderr: "y".repeat(5000) }] },
    effects: { paths: Array.from({ length: 200 }, (_, i) => ({ path: `src/f${i}.js`, kind: "modified" })), rejected_paths: [] },
    maxChars: 1500,
  });
  assert.ok(big.manifest.total_characters <= 1500);
  assert.ok(big.manifest.omitted.length, "dropping is recorded, not silent");
  assert.equal(big.manifest.omitted[0].reason, "dropped to fit the repair-context budget");
});
