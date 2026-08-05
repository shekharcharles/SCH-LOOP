// Executable semantic phases: every declared AGENT phase runs a real fresh
// worker, read-only roles are caught if they write, the plan crosses to the
// builder as typed artifact-backed fields, and no read-only workflow ever
// claims delivery.
//
// Local bare remotes, a fake Claude executable, temporary SCH_HOME. No real
// model, no internet, no GitHub credential.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, withRemote, fakeQueueEnv, git,
         SCHED, PH, ROOT } from "./helpers.mjs";

const url = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:");
const SEM = await import(url(join(ROOT, "scripts", "semantic.mjs")));
const WF = await import(url(join(ROOT, "scripts", "workflows.mjs")));

// A project on a bare remote, with delivery approval switched off so the tests
// are about the workflow rather than about signing.
function proj(name, { approval = false } = {}) {
  const fx = fixture(name);
  withRemote(fx); initWorkspace(fx); git(fx.repo, "push", "-q", "origin", "main");
  if (!approval) {
    const p = join(fx.home, "projects.json");
    const reg = JSON.parse(readFileSync(p, "utf8"));
    reg.projects[0].delivery = { approval_before_commit: false, approval_before_push: false };
    writeFileSync(p, JSON.stringify(reg, null, 2));
  }
  return fx;
}
const enableReview = (fx) => {
  const p = join(fx.home, "projects.json");
  const reg = JSON.parse(readFileSync(p, "utf8"));
  reg.projects[0].semanticReview = true;
  writeFileSync(p, JSON.stringify(reg, null, 2));
};
const setWorkflow = (fx, id, tpl) => fx.cli("task-set", "--project", fx.P, String(id), "--workflow", tpl);
// `--all`: a delivered commit lands on that task's own branch, not on the
// remote's default branch, and the question here is what reached the remote.
const remoteCommits = (fx) => git(fx.bare, "log", "--oneline", "--all").trim().split("\n").filter(Boolean).length;
const phases = (fx, id) => {
  const at = SCHED.taskPhases(fx.P, id).attempts[0];
  return at ? PH.listPhases(at.dir) : [];
};
const invocations = (fx) => {
  const p = join(fx.home, "behaviours", "invocations.log");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const runDirOf = (fx, id) => {
  const at = SCHED.taskPhases(fx.P, id).attempts[0];
  try { return JSON.parse(readFileSync(join(at.dir, "attempt.json"), "utf8")).run_dir; } catch { return null; }
};

// ==================================================== template executability

test("templates: every built-in AGENT phase is backed by a registered executable handler", () => {
  assert.equal(SEM.validateRegistry().ok, true);
  for (const id of WF.TEMPLATE_IDS) {
    for (const ph of WF.TEMPLATES[id].phases.filter((p) => p.kind === "AGENT")) {
      assert.ok(ph.semantic, `${id}/${ph.id} declares no semantic handler`);
      const h = SEM.SEMANTIC_HANDLERS[ph.semantic];
      assert.ok(h, `${id}/${ph.id}: handler "${ph.semantic}" is not registered`);
      assert.equal(ph.role, h.role, `${id}/${ph.id} role`);
      assert.equal(ph.output_envelope ?? null, h.output_envelope, `${id}/${ph.id} envelope`);
    }
  }
  // and the whole set still validates
  assert.equal(WF.validateAll().ok, true);
});

test("templates: an AGENT phase with no handler, or a mismatched one, is REJECTED not skipped", () => {
  const t = (ph) => WF.validateTemplate({ schema_version: 1, id: "X_T", version: 1, supported_task_types: ["*"], phases: [ph] });
  const codes = (ph) => t(ph).problems.map((p) => p.code);
  assert.deepEqual(codes({ id: "a", kind: "AGENT", handler: "agent-run", role: "builder" }), ["SEMANTIC_HANDLER_MISSING"]);
  assert.match(t({ id: "a", kind: "AGENT", handler: "agent-run", role: "builder" }).problems[0].message,
    /may not declare work it cannot do/);
  assert.ok(codes({ id: "a", kind: "AGENT", handler: "agent-run", semantic: "nope", role: "scout" }).includes("UNKNOWN_SEMANTIC_HANDLER"));
  assert.ok(codes({ id: "a", kind: "AGENT", handler: "agent-run", semantic: "scout", role: "builder" }).includes("SEMANTIC_ROLE_MISMATCH"));
  assert.ok(codes({ id: "a", kind: "AGENT", handler: "agent-run", semantic: "scout", role: "scout", output_envelope: "BuilderEnvelopeV1" }).includes("SEMANTIC_ENVELOPE_MISMATCH"));
  assert.ok(codes({ id: "a", kind: "CODE", handler: "no-op", semantic: "scout" }).includes("SEMANTIC_KIND_MISMATCH"));
});

test("templates: read-only handlers get an empty write policy; the task policy is the upper bound", () => {
  const task = { allowedPaths: ["src/**", "docs/**", "README.md"], forbiddenPaths: ["src/secret.js"], verify: [{ id: "u" }] };
  for (const id of ["scout", "plan", "review"]) {
    const e = SEM.effectivePolicy(id, task);
    assert.deepEqual(e.policy.allowed, [], `${id} must have no write authorization`);
    assert.equal(e.policy.read_only, true);
  }
  assert.deepEqual(SEM.effectivePolicy("implement", task).policy.allowed, ["src/**", "docs/**", "README.md"]);
  // documentation is an INTERSECTION — a doc path the task did not allow is not granted
  assert.deepEqual(SEM.effectivePolicy("document", task).policy.allowed, ["docs/**", "README.md"]);
  assert.deepEqual(SEM.effectivePolicy("document", { allowedPaths: ["src/**"] }).policy.allowed, []);
  // and a documenter can never touch these, whatever the task says
  const forb = SEM.effectivePolicy("document", { allowedPaths: ["**"] }).policy.forbidden;
  for (const p of ["package.json", "src/**", "tests/**", ".sch-loop/**"]) assert.ok(forb.includes(p), p);
});

// ================================================================= SCOUT

test("SCOUT: runs a real read-only worker, produces an envelope, delivers nothing", async (t) => {
  const fx = proj("sem-scout"); t.after(() => fx.done());
  const a = addTask(fx, { title: "find the auth code", allow: "src/**" });
  setWorkflow(fx, a, "SCOUT");
  const env = fakeQueueEnv(fx, { [a]: { handoff: { summary: "auth lives in src/auth" } } });

  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  const ph = phases(fx, a);
  const scout = ph.find((x) => x.phase_id === "scout");

  assert.ok(scout, "the scout phase must be RECORDED, not absent");
  assert.equal(scout.state, "ACCEPTED");
  assert.equal(scout.kind, "AGENT");
  assert.equal(scout.envelope_type, "ScoutEnvelopeV1");
  assert.match(scout.envelope_hash, /^[0-9a-f]{64}$/);
  // a real fresh process ran
  assert.equal(invocations(fx).length, 1);
  // read-only: the gate that proves it actually ran and passed
  assert.ok((scout.gate_reports ?? []).some((g) => g.gate_id === "no-repository-effects" && g.outcome === "PASS"));
  // nothing delivered, nothing pushed
  assert.equal(remoteCommits(fx), 2);
  assert.equal(r.tasks[0].state, "READ_ONLY_COMPLETED");
  assert.notEqual(r.tasks[0].state, "DELIVERED");
  assert.equal(r.tasks[0].commit, null);
});

test("SCOUT: a scout that modifies the repository FAILS as a role-policy violation", async (t) => {
  const fx = proj("sem-scout-writes"); t.after(() => fx.done());
  const a = addTask(fx, { title: "find things", allow: "src/**" });
  setWorkflow(fx, a, "SCOUT");
  // the scout writes a file it was never authorized to write
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/scout-was-here.js", content: "// oops\n" }] } });

  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  assert.notEqual(r.stop_reason, "PROJECT_COMPLETED");
  assert.equal(r.tasks[0].failure.code, "ROLE_POLICY_VIOLATION");
  assert.match(r.tasks[0].failure.message, /read-only and has no write authorization/);
  // evidence preserved: the file is STILL THERE. Nothing was reverted — and it
  // is in the task's own checkout, which is where the scout was running.
  assert.equal(readFileSync(join(fx.wt, fx.P, `task-${a}`, "src", "scout-was-here.js"), "utf8"), "// oops\n");
  assert.equal(existsSync(join(fx.repo, "src", "scout-was-here.js")), false,
    "an unauthorized write never reaches the operator's working tree");
  assert.equal(remoteCommits(fx), 2, "nothing reached the remote");
  const scout = phases(fx, a).find((x) => x.phase_id === "scout");
  assert.equal(scout.state, "FAILED");
});

// ================================================================ PLAN_ONLY

test("PLAN_ONLY: runs a real planner, produces a plan artifact, delivers nothing", async (t) => {
  const fx = proj("sem-plan"); t.after(() => fx.done());
  const a = addTask(fx, { title: "plan the auth work", allow: "src/**" });
  setWorkflow(fx, a, "PLAN_ONLY");
  const env = fakeQueueEnv(fx, { [a]: { handoff: {
    summary: "a bounded plan", decisions: ["use the existing session store"],
  } } });

  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  const plan = phases(fx, a).find((x) => x.phase_id === "plan");
  assert.ok(plan, "the plan phase must be RECORDED");
  assert.equal(plan.state, "ACCEPTED");
  assert.equal(plan.envelope_type, "PlannerEnvelopeV1");
  assert.ok((plan.gate_reports ?? []).some((g) => g.gate_id === "plan-envelope-valid" && g.outcome === "PASS"));
  assert.ok((plan.gate_reports ?? []).some((g) => g.gate_id === "no-repository-effects" && g.outcome === "PASS"));

  // the plan is persisted as an immutable artifact beside the attempt
  const at = SCHED.taskPhases(fx.P, a).attempts[0];
  assert.ok(existsSync(join(at.dir, "plan-envelope.json")), "the plan must be an artifact, not only a memory");
  const artifact = JSON.parse(readFileSync(join(at.dir, "plan-envelope.json"), "utf8"));
  assert.match(artifact.hash, /^[0-9a-f]{64}$/);

  assert.equal(r.tasks[0].state, "PLAN_COMPLETED");
  assert.notEqual(r.tasks[0].state, "DELIVERED");
  assert.equal(remoteCommits(fx), 2);
});

test("PLAN_ONLY: a planner that writes to the repository FAILS", async (t) => {
  const fx = proj("sem-plan-writes"); t.after(() => fx.done());
  const a = addTask(fx, { title: "plan", allow: "src/**" });
  setWorkflow(fx, a, "PLAN_ONLY");
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/plan.md", content: "# plan\n" }] } });
  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  assert.equal(r.tasks[0].failure.code, "ROLE_POLICY_VIOLATION");
});

// ======================================================= typed plan handoff

test("PLAN_BUILD: the plan reaches the builder as typed fields in a separate process", async (t) => {
  const fx = proj("sem-plan-build"); t.after(() => fx.done());
  const a = addTask(fx, { title: "build with a plan", allow: "src/**" });
  setWorkflow(fx, a, "PLAN_BUILD");
  const dir = join(fx.home, "behaviours");
  const env = fakeQueueEnv(fx, {});
  // The planner and the builder are DIFFERENT processes with different
  // behaviour; the only thing that crosses between them is the envelope.
  // Distinct behaviour PER SEMANTIC PHASE. A single fixture would make the
  // planner write too — and the planner is read-only, so that would (correctly)
  // fail. Separate files are how a test exercises the real division of labour.
  writeFileSync(join(dir, `task-${a}-plan.json`), JSON.stringify({
    handoff: { summary: "the plan", decisions: ["edit src/built.js", "verify with the unit check"] } }));
  writeFileSync(join(dir, `task-${a}-implement.json`), JSON.stringify({
    promptTo: join(fx.home, "prompt-capture.txt"),
    write: [{ path: "src/built.js", content: "// built\n" }],
    handoff: { summary: "built to the plan" },
  }));

  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  const ph = phases(fx, a);
  assert.equal(ph.find((x) => x.phase_id === "plan").state, "ACCEPTED");
  assert.equal(ph.find((x) => x.phase_id === "implement").state, "ACCEPTED");

  // two DISTINCT processes — no shared session between planner and builder
  const inv = invocations(fx);
  assert.equal(inv.length, 2, "the planner and the builder are separate processes");
  assert.notEqual(inv[0].pid, inv[1].pid);
  assert.notEqual(inv[0].run_id, inv[1].run_id);

  // the builder's prompt carries the PLAN, and the manifest carries its hash
  const at = SCHED.taskPhases(fx.P, a).attempts[0];
  const artifact = JSON.parse(readFileSync(join(at.dir, "plan-envelope.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(runDirOf(fx, a), "prompt-manifest.json"), "utf8"));
  assert.equal(manifest.plan_envelope_hash, artifact.hash, "the builder's manifest must name the plan it was given");
  assert.equal(manifest.semantic_handler, "implement");
  const captured = readFileSync(join(fx.home, "prompt-capture.txt"), "utf8");
  assert.match(captured, /THE APPROVED PLAN/);
  // the plan is guidance, not authority, and the prompt says so
  assert.match(captured, /cannot widen your allowed paths/);
  // and the planner's raw transcript is NOT injected
  assert.equal(/PREVIOUS ATTEMPT|transcript/i.test(captured), false);

  assert.equal(r.tasks[0].state, "AWAITING_DELIVERY");
  assert.equal(remoteCommits(fx), 2, "PLAN_BUILD has no delivery phase");
});

// ============================================================== BUILD_REVIEW

test("BUILD_REVIEW: a real read-only reviewer receives the diff and the deterministic evidence", async (t) => {
  const fx = proj("sem-review"); t.after(() => fx.done());
  enableReview(fx);
  const a = addTask(fx, { title: "build and review", allow: "src/**" });
  setWorkflow(fx, a, "BUILD_REVIEW");
  const dir = join(fx.home, "behaviours");
  const env = fakeQueueEnv(fx, {});
  writeFileSync(join(dir, `task-${a}.json`), JSON.stringify({
    promptTo: join(fx.home, "review-prompt.txt"),
    write: [{ path: "src/a.js", content: "// a\n" }],
    handoff: { summary: "did it" },
  }));

  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  const rev = phases(fx, a).find((x) => x.phase_id === "semantic-review");
  assert.ok(rev, "the reviewer phase must be recorded");
  assert.equal(rev.state, "ACCEPTED");
  assert.equal(rev.envelope_type, "ReviewerEnvelopeV1");
  assert.equal(rev.role, "reviewer");
  // read-only, and proved by the gate rather than asserted
  assert.ok((rev.gate_reports ?? []).some((g) => g.gate_id === "no-repository-effects" && g.outcome === "PASS"));
  // a fresh process of its own
  assert.equal(invocations(fx).length, 2);
  // the reviewer's prompt carried the acceptance criteria and the real change
  const prompt = readFileSync(join(fx.home, "review-prompt.txt"), "utf8");
  assert.match(prompt, /ACCEPTANCE CRITERIA/);
  assert.match(prompt, /AC-1/);
  assert.equal(r.tasks[0].state, "AWAITING_DELIVERY");
});

test("BUILD_REVIEW: a reviewer that writes is a role-policy failure", async (t) => {
  const fx = proj("sem-review-writes"); t.after(() => fx.done());
  enableReview(fx);
  const a = addTask(fx, { title: "review", allow: "src/**" });
  setWorkflow(fx, a, "BUILD_REVIEW");
  const dir = join(fx.home, "behaviours");
  const env = fakeQueueEnv(fx, {});
  writeFileSync(join(dir, "implement.json"), JSON.stringify({ write: [{ path: "src/a.js", content: "// a\n" }], handoff: { summary: "built" } }));
  // the REVIEWER writes — which it must never do
  writeFileSync(join(dir, "review.json"), JSON.stringify({ write: [{ path: "src/reviewer-edit.js", content: "// nope\n" }], handoff: { summary: "reviewed" } }));

  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  // the reviewer ran second, so its write is what fails
  assert.notEqual(r.stop_reason, "PROJECT_COMPLETED");
  const rev = phases(fx, a).find((x) => x.phase_id === "semantic-review");
  assert.equal(rev.state, "FAILED");
  assert.equal(rev.failure.code, "ROLE_POLICY_VIOLATION");
  assert.equal(remoteCommits(fx), 2);
});

// ========================================================= DOCUMENTATION_ONLY

test("DOCUMENTATION_ONLY: the documenter runs and may write only approved documentation", async (t) => {
  const fx = proj("sem-doc"); t.after(() => fx.done());
  const a = addTask(fx, { title: "write the docs", allow: "docs/**|README.md", category: "docs" });
  setWorkflow(fx, a, "DOCUMENTATION_ONLY");
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "docs/guide.md", content: "# guide\n" }], handoff: { summary: "documented" } } });

  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  const doc = phases(fx, a).find((x) => x.phase_id === "document");
  assert.ok(doc, "the documenter phase must be recorded");
  assert.equal(doc.state, "ACCEPTED");
  assert.equal(doc.envelope_type, "DocumentationEnvelopeV1");
  assert.equal(doc.role, "documenter");
  assert.ok((doc.gate_reports ?? []).some((g) => g.gate_id === "documentation-scope-valid" && g.outcome === "PASS"));
  assert.equal(invocations(fx).length, 1);
  assert.equal(r.tasks[0].state, "AWAITING_DELIVERY");
  assert.equal(remoteCommits(fx), 2, "DOCUMENTATION_ONLY does not deliver");
});

test("DOCUMENTATION_ONLY: source, test and control-state writes are all rejected", async (t) => {
  for (const [label, path] of [["source", "src/evil.js"], ["tests", "tests/evil.test.mjs"], ["control state", ".sch-loop/SPEC.md"]]) {
    const fx = proj("sem-doc-" + label.replace(/\s/g, ""));
    try {
      // the task allows everything, so ONLY the documenter's own scope stops it
      const a = addTask(fx, { title: "docs", allow: "**", category: "docs" });
      setWorkflow(fx, a, "DOCUMENTATION_ONLY");
      const env = fakeQueueEnv(fx, { [a]: { write: [{ path, content: "// nope\n" }], handoff: { summary: "wrote" } } });
      const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
      assert.notEqual(r.stop_reason, "PROJECT_COMPLETED", label);
      assert.ok(["PATH_SCOPE_VIOLATION", "UNEXPECTED_FILE_CHANGE", "GATE_FAILED"].includes(r.tasks[0].failure.code),
        `${label}: got ${r.tasks[0].failure.code}`);
      assert.equal(remoteCommits(fx), 2, label);
    } finally { fx.done(); }
  }
});

// ============================================================ SECURITY_REVIEW

test("SECURITY_REVIEW: runs a bounded read-only review and grants no extra authority", async (t) => {
  const fx = proj("sem-sec"); t.after(() => fx.done());
  enableReview(fx);
  const a = addTask(fx, { title: "review the change", allow: "src/**", category: "security" });
  setWorkflow(fx, a, "SECURITY_REVIEW");
  const env = fakeQueueEnv(fx, { [a]: { handoff: { summary: "no issues found" } } });

  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  const rev = phases(fx, a).find((x) => x.phase_id === "semantic-review");
  assert.equal(rev.state, "ACCEPTED");
  assert.equal(rev.role, "reviewer", "the name SECURITY_REVIEW grants no special role");
  assert.ok((rev.gate_reports ?? []).some((g) => g.gate_id === "no-repository-effects" && g.outcome === "PASS"));
  assert.equal(r.tasks[0].state, "READ_ONLY_COMPLETED");
  assert.equal(remoteCommits(fx), 2);
});

// ================================================== BUILD_ONLY + regressions

test("BUILD_ONLY: implements and stops, without delivering", async (t) => {
  const fx = proj("sem-build-only"); t.after(() => fx.done());
  const a = addTask(fx, { title: "just build", allow: "src/**" });
  setWorkflow(fx, a, "BUILD_ONLY");
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }] } });
  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  assert.equal(phases(fx, a).find((x) => x.phase_id === "implement").state, "ACCEPTED");
  assert.equal(r.tasks[0].state, "AWAITING_DELIVERY");
  assert.equal(remoteCommits(fx), 2);
});

test("FULL_SDLC still delivers, and PLAN_BUILD_TEST still verifies without delivering", async (t) => {
  const full = proj("sem-full"); t.after(() => full.done());
  const a = addTask(full, { title: "deliver me", allow: "src/**" });
  const env1 = fakeQueueEnv(full, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }] } });
  const r1 = await SCHED.runQueue({ projectId: full.P, env: env1, maxTasks: 1 });
  assert.equal(r1.tasks[0].state, "DELIVERED");
  assert.match(r1.tasks[0].commit, /^[0-9a-f]{40}$/);
  assert.equal(remoteCommits(full), 3);

  const pbt = proj("sem-pbt"); t.after(() => pbt.done());
  const b = addTask(pbt, { title: "verify only", allow: "src/**" });
  setWorkflow(pbt, b, "PLAN_BUILD_TEST");
  // per-phase behaviour: the planner writes nothing, the builder does
  const env2 = fakeQueueEnv(pbt, {});
  const dir2 = join(pbt.home, "behaviours");
  writeFileSync(join(dir2, "plan.json"), JSON.stringify({ handoff: { summary: "plan", decisions: ["write src/b.js", "verify"] } }));
  writeFileSync(join(dir2, "implement.json"), JSON.stringify({ write: [{ path: "src/b.js", content: "// b\n" }], handoff: { summary: "built" } }));
  const r2 = await SCHED.runQueue({ projectId: pbt.P, env: env2, maxTasks: 1 });
  assert.equal(r2.tasks[0].state, "AWAITING_DELIVERY");
  assert.notEqual(r2.tasks[0].state, "DELIVERED");
  assert.equal(remoteCommits(pbt), 2);
});

// ================================================= role governs execution

test("roles: the resolved role governs prompt, envelope and write policy at execution", async (t) => {
  const fx = proj("sem-role-authority"); t.after(() => fx.done());
  const a = addTask(fx, { title: "scout it", allow: "src/**" });
  setWorkflow(fx, a, "SCOUT");
  const env = fakeQueueEnv(fx, { [a]: { promptTo: join(fx.home, "scout-prompt.txt"), handoff: { summary: "found it" } } });
  await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });

  // the resolved configuration is persisted with the run
  const cfg = JSON.parse(readFileSync(join(runDirOf(fx, a), "agent-config.json"), "utf8"));
  assert.equal(cfg.role_id, "scout");
  assert.equal(cfg.actor_kind, "AGENT");
  assert.deepEqual(cfg.writes, [], "a read-only role resolves to no write scope");
  assert.equal(cfg.output_envelope, "ScoutEnvelopeV1");
  assert.equal(cfg.semantic_handler, "scout");
  assert.match(cfg.phase_execution_id, /^PEX-/);
  assert.ok(cfg.model_profile && cfg.executor_id && cfg.provider);

  // and the role's prompt template is what the manifest recorded
  const man = JSON.parse(readFileSync(join(runDirOf(fx, a), "prompt-manifest.json"), "utf8"));
  assert.equal(man.prompt_template, "scout@1");
  assert.equal(man.semantic_handler, "scout");
  assert.equal(man.role.id, "scout");

  // the prompt itself tells the worker it has no write authorization
  const prompt = readFileSync(join(fx.home, "scout-prompt.txt"), "utf8");
  assert.match(prompt, /YOU HAVE NO WRITE AUTHORIZATION/);
  assert.match(prompt, /READ-ONLY/);
  // …and is honest that the enforcement is inspection, not sandboxing
  assert.match(prompt, /inspects the repository after you exit/);
});

test("no template reports DELIVERED unless a commit was actually pushed and verified", async (t) => {
  const cases = [["SCOUT", "READ_ONLY_COMPLETED"], ["PLAN_ONLY", "PLAN_COMPLETED"],
                 ["BUILD_ONLY", "AWAITING_DELIVERY"], ["PLAN_BUILD", "AWAITING_DELIVERY"]];
  for (const [tpl, expected] of cases) {
    const fx = proj("sem-completion-" + tpl.toLowerCase());
    try {
      const a = addTask(fx, { title: tpl, allow: "src/**" });
      setWorkflow(fx, a, tpl);
      // read-only phases get a NO-WRITE fixture; only the builder writes
      const env = fakeQueueEnv(fx, {});
      const d = join(fx.home, "behaviours");
      writeFileSync(join(d, "default.json"), JSON.stringify({ handoff: { summary: "done", decisions: ["a step", "verify it"] } }));
      writeFileSync(join(d, "implement.json"), JSON.stringify({ write: [{ path: "src/a.js", content: "// a\n" }], handoff: { summary: "built" } }));
      const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
      assert.equal(r.tasks[0].state, expected, `${tpl} completion state`);
      assert.notEqual(r.tasks[0].state, "DELIVERED", `${tpl} must never claim delivery`);
      assert.equal(r.tasks[0].commit, null, `${tpl} must record no commit`);
      assert.equal(remoteCommits(fx), 2, `${tpl} must push nothing`);
    } finally { fx.done(); }
  }
});
