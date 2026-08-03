// Outcomes, the event stream, prompt-size accounting, the dashboard projection,
// and reading a finished run back after a restart.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, fakeExecutor, run, git, RUN, ROOT } from "./helpers.mjs";

const node = process.execPath.replace(/\\/g, "/");

test("outcome: every terminal outcome is reachable and is persisted", async () => {
  const cases = [
    ["VERIFIED", { write: [{ path: "src/a.js", content: "a\n" }] }, {}],
    ["RETRYABLE", { sleepMs: 60000 }, { timeoutMs: 2000 }],
    ["NEEDS_DECISION", { write: [{ path: "src/a.js", content: "a\n" }], git: [["add", "-A"], ["commit", "-m", "nope"]] }, {}],
    ["FAILED", { write: [{ path: "wandered.txt", content: "x\n" }] }, {}],
    ["CANCELLED", { selfCancel: true, sleepMs: 30000 }, { timeoutMs: 60000 }],
  ];
  for (const [want, behaviour, opts] of cases) {
    const fx = fixture("oc-" + want.toLowerCase()); initWorkspace(fx);
    const t = addTask(fx, { allow: "src/**" });
    const rec = await run(fx, t, fakeExecutor(fx, behaviour, opts));
    assert.equal(rec.outcome, want, `expected ${want}, got ${rec.outcome}: ${rec.failure?.message}`);
    assert.ok(RUN.OUTCOMES.includes(rec.outcome));
    assert.equal(rec.state, "finished", "no run is ever left active");
    const onDisk = JSON.parse(readFileSync(join(rec.run_dir, "run.json"), "utf8"));
    assert.equal(onDisk.outcome, want);
    assert.equal(fx.state().runs[0].outcome, want, "the run reference reaches SCH_HOME");
    fx.done();
  }
});

test("outcome: retryability is a policy table, never the worker's opinion", () => {
  assert.equal(RUN.isRetryable("AGENT_TIMEOUT"), true);
  assert.equal(RUN.isRetryable("PROCESS_TRANSIENT"), true);
  assert.equal(RUN.isRetryable("VERIFICATION_FAILURE"), false);
  assert.equal(RUN.isRetryable("PATH_SCOPE_VIOLATION"), false);
  assert.equal(RUN.isRetryable("FORBIDDEN_GIT_EFFECT"), false);
  assert.equal(RUN.outcomeFor("FORBIDDEN_GIT_EFFECT"), "NEEDS_DECISION");
  assert.equal(RUN.outcomeFor("SKILL_NOT_APPROVED"), "NEEDS_DECISION");
  assert.equal(RUN.outcomeFor("CANCELLED"), "CANCELLED");
  assert.equal(RUN.outcomeFor("something-nobody-classified"), "FAILED", "an unclassified failure fails closed");
});

test("outcome: a RETRYABLE run starts nothing else — no retry happens here", async () => {
  const fx = fixture("oc-noretry"); initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, { sleepMs: 60000 }, { timeoutMs: 2000 }));
  assert.equal(rec.outcome, "RETRYABLE");
  assert.equal(fx.state().runs.length, 1, "exactly one run, no second attempt");
  assert.equal(fx.state().tasks[0].status, "queued", "and the task is untouched");
  fx.done();
});

test("events: ordered, versioned, identity-stamped, and bounded", async () => {
  const fx = fixture("ev"); initWorkspace(fx);
  const t = addTask(fx);
  const streamed = [];
  const rec = await run(fx, t, fakeExecutor(fx, { stdoutBytes: 5000, write: [{ path: "src/e.js", content: "e\n" }] }),
    { onEvent: (e) => streamed.push(e.type) });
  const events = RUN.readEvents(rec.run_dir);
  const types = events.map((e) => e.type);

  assert.deepEqual(types.slice(0, 3), ["run.created", "run.preflight_started", "run.preflight_completed"]);
  assert.equal(types[types.length - 1], "run.outcome_recorded");
  for (const want of ["run.lease_acquired", "run.worker_started", "run.worker_exited", "run.handoff_parsed",
                      "run.effects_inspected", "run.verification_started", "run.verification_completed",
                      "run.lease_released", "run.outcome_recorded"])
    assert.ok(types.includes(want), `missing event ${want}`);
  for (const e of events) {
    assert.equal(e.schema_version, 1);
    assert.match(e.event_id, /^EVT-[0-9a-f]{12}$/);
    assert.ok(!Number.isNaN(Date.parse(e.timestamp)));
    assert.equal(e.project_id, fx.P);
    assert.equal(e.run_id, rec.run_id);
    assert.equal(e.task_id, String(t));
    assert.deepEqual(e.actor, { kind: "system", id: "sch-runner" });
    assert.ok(RUN.EVENTS.includes(e.type), `undeclared event type ${e.type}`);
    assert.ok(JSON.stringify(e.payload ?? {}).length < 2000, `event ${e.type} carries an unbounded payload`);
  }
  const raw = readFileSync(join(rec.run_dir, "events.jsonl"), "utf8");
  assert.ok(!raw.includes("xxxxxxxxxxxxxxxxxxxx"), "raw worker output must never be inlined into an event");
  assert.deepEqual(streamed.slice(0, 2), ["run.created", "run.preflight_started"], "events also stream to a caller");
  fx.done();
});

test("prompt: the manifest accounts for every section in characters, not invented tokens", async () => {
  const fx = fixture("pm"); initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/m.js", content: "m\n" }] }));
  const m = JSON.parse(readFileSync(join(rec.run_dir, "prompt-manifest.json"), "utf8"));
  assert.equal(m.unit, "characters");
  assert.match(m.note, /no tokenizer/);
  const prompt = readFileSync(join(rec.run_dir, "prompt.txt"), "utf8");
  assert.equal(m.total_characters, prompt.length);
  const included = m.sections.filter((s) => s.included);
  for (const want of ["safety-kernel", "task", "acceptance-criteria", "allowed-paths", "forbidden-paths", "verification"])
    assert.ok(included.some((s) => s.name === want && s.mandatory), `${want} must be present and mandatory`);
  for (const s of m.sections.filter((x) => !x.included)) assert.ok(s.reason, `${s.name} is excluded without a reason`);
  fx.done();
});

test("prompt: over the size limit, optional context is compacted and safety never is", () => {
  const identity = { run_id: "RUN-x", project_id: "p", task_id: "1" };
  const task = { title: "t", phase: 1, ac: ["works"], ng: [], notes: "" };
  const policy = { allowed: ["src/**"], forbidden: [], verify: [{ exe: "npm", args: ["test"] }] };
  const skills = [{ skill_id: "big", name: "big", bucket: "recommended", reason: "r", trust: "APPROVED", content_hash: "h", excerpt: "S".repeat(20000) }];
  const r = RUN.compilePrompt({
    identity, task, policy, skills,
    knowledge: ["K".repeat(3000)], previousHandoff: "P".repeat(3000), dependencies: ["D".repeat(3000)],
    maxChars: 6000,
  });
  assert.equal(r.ok, true);
  assert.ok(r.text.length <= 6000, `prompt is ${r.text.length}`);
  assert.match(r.text, /IMMUTABLE RULES/, "the safety kernel survives compaction");
  assert.match(r.text, /ALLOWED PATHS/);
  assert.match(r.text, /ACCEPTANCE CRITERIA/);
  assert.ok(r.manifest.compacted.length, "every compaction is recorded");
  const dropped = r.manifest.sections.filter((s) => !s.included).map((s) => s.name);
  assert.ok(dropped.includes("knowledge"), "the least load-bearing context goes first");
});

test("prompt: mandatory content alone over the limit fails closed", () => {
  const r = RUN.compilePrompt({
    identity: { run_id: "R", project_id: "p", task_id: "1" },
    task: { title: "T".repeat(5000), phase: 1, ac: ["a"], ng: [], notes: "N".repeat(5000) },
    policy: { allowed: ["src/**"], forbidden: [], verify: [] },
    skills: [], maxChars: 3000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failure.code, "POLICY_VIOLATION");
  assert.match(r.failure.message, /mandatory prompt content alone/);
});

test("prompt: only SELECTED skills are loaded, with their hashes and reasons", async () => {
  const fx = fixture("pm-skills"); initWorkspace(fx);
  // a skill the project never selected must not appear in the prompt
  const roots = join(fx.home, "fx-global");
  mkdirSync(join(roots, "unselected-skill"), { recursive: true });
  writeFileSync(join(roots, "unselected-skill", "SKILL.md"),
    "---\nname: unselected-skill\ndescription: help\n---\nUNIQUE-UNSELECTED-BODY-MARKER\n");
  process.env.SCH_SKILL_ROOTS = `builtin:${join(ROOT, "skills")}|global:${roots}`;
  const t = addTask(fx, { category: "planning" });
  fx.cli("profile-set", "--project", fx.P, "--task-type", "planning", "--recommended", "sch-plan");
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/s.js", content: "s\n" }] }));
  assert.equal(rec.outcome, "VERIFIED", JSON.stringify(rec.failure));
  const prompt = readFileSync(join(rec.run_dir, "prompt.txt"), "utf8");
  assert.ok(!prompt.includes("UNIQUE-UNSELECTED-BODY-MARKER"), "an unselected skill's body must never be concatenated in");
  const m = JSON.parse(readFileSync(join(rec.run_dir, "prompt-manifest.json"), "utf8"));
  assert.ok(m.skills.some((s) => s.skill_id === "sch-plan"), "the selected skill is recorded");
  for (const s of m.skills) {
    assert.ok(s.content_hash, "with the exact content hash it was selected at");
    assert.ok(s.reason, "and why it was selected");
    assert.ok(["BUILT_IN", "APPROVED"].includes(s.trust), "never an unreviewed skill");
  }
  const baseline = JSON.parse(readFileSync(join(rec.run_dir, "baseline.json"), "utf8"));
  assert.deepEqual(Object.keys(baseline.capability_profile.skill_hashes).sort(),
    m.skills.map((s) => s.skill_id).sort());
  fx.done();
});

test("projection: the dashboard sees the run, its skills, its outcome and whether it needs a person", async () => {
  const fx = fixture("proj"); initWorkspace(fx);
  const t = addTask(fx);
  const ok = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/p.js", content: "p\n" }] }));
  git(fx.repo, "add", "-A"); git(fx.repo, "commit", "-q", "-m", "accept");
  const bad = await run(fx, t, fakeExecutor(fx, { write: [{ path: "nope.txt", content: "x\n" }] }));

  const p = RUN.runProjection(fx.P);
  assert.equal(p.available, true);
  assert.equal(p.active, null, "nothing is left running");
  assert.equal(p.runs.length, 2);
  assert.equal(p.runs[0].run_id, bad.run_id, "newest first — run ids sort");
  assert.equal(p.runs[0].outcome, "FAILED");
  assert.match(p.runs[0].attention_required, /nope\.txt/);
  assert.equal(p.runs[1].outcome, "VERIFIED");
  assert.equal(p.runs[1].attention_required, null);
  for (const r of p.runs) {
    assert.equal(r.task_id, String(t));
    assert.ok(r.worker_state, "the worker state is shown");
    assert.ok(typeof r.duration_ms === "number");
    assert.ok(Array.isArray(r.selected_skills));
    assert.ok(r.prompt_characters > 0);
    assert.ok(r.events > 0);
    assert.ok(!JSON.stringify(r).includes("SCH_HANDOFF_JSON"), "the projection never inlines raw worker output");
  }
  // and the same view through the CLI
  const cli = JSON.parse(fx.cli("run-list", "--project", fx.P));
  assert.equal(cli.runs.length, 2);
  fx.done();
});

test("projection: an uninitialized workspace is reported, not crashed on", () => {
  const fx = fixture("proj-none");
  const p = RUN.runProjection(fx.P);
  assert.equal(p.available, false);
  assert.deepEqual(p.runs, []);
  assert.match(p.reason, /workspace-init/);
  fx.done();
});

test("restart: a finished run is fully readable from disk by a new process", async () => {
  const fx = fixture("restart"); initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/r.js", content: "r\n" }] }));
  assert.equal(rec.outcome, "VERIFIED");

  // a genuinely separate process, holding nothing in memory
  const out = execFileSync("node", [join(ROOT, "scripts", "state.mjs"), "run-get", "--project", fx.P, "--run", rec.run_id],
    { encoding: "utf8", env: { ...process.env, SCH_HOME: fx.home, NODE_NO_WARNINGS: "1" } });
  const back = JSON.parse(out);
  assert.equal(back.run.outcome, "VERIFIED");
  assert.equal(back.run.run_id, rec.run_id);
  assert.equal(back.baseline.repository.root, ".");
  assert.equal(back.handoff.worker_status, "COMPLETED");
  assert.equal(back.verification.all_passed, true);
  assert.equal(back.effects.counts.rejected, 0);
  assert.ok(back.events.length > 5);
  assert.match(back.stdout, /chars in .*stdout\.log/, "unbounded output stays on disk and is referenced");
  fx.done();
});

test("cancel: the operator CLI can request cancellation of a run directory", async () => {
  const fx = fixture("cancel-cli"); const ws = initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/c.js", content: "c\n" }] }));
  const r = JSON.parse(fx.cli("run-cancel", "--project", fx.P, "--run", rec.run_id, "--reason", "changed my mind"));
  assert.equal(r.ok, true);
  assert.ok(existsSync(join(ws, "runs", rec.run_id, "CANCEL")));
  assert.throws(() => fx.cli("run-cancel", "--project", fx.P, "--run", "RUN-does-not-exist"), /no run RUN-does-not-exist/);
  fx.done();
});

test("the runner never stages, commits or pushes the managed project", async () => {
  const fx = fixture("no-git-writes"); initWorkspace(fx);
  const t = addTask(fx);
  const head = git(fx.repo, "rev-parse", "HEAD").trim();
  const branch = git(fx.repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
  const config = git(fx.repo, "config", "--local", "--list");
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/n.js", content: "n\n" }] }));

  assert.equal(rec.outcome, "VERIFIED");
  assert.equal(git(fx.repo, "rev-parse", "HEAD").trim(), head, "HEAD is unchanged");
  assert.equal(git(fx.repo, "rev-parse", "--abbrev-ref", "HEAD").trim(), branch, "the branch is unchanged");
  assert.equal(git(fx.repo, "config", "--local", "--list"), config, "git config is unchanged");
  assert.equal(git(fx.repo, "diff", "--cached", "--name-only").trim(), "", "nothing is staged");
  assert.equal(git(fx.repo, "remote").trim(), "", "no remote was added");
  assert.match(git(fx.repo, "status", "--porcelain").trim(), /\?\? src\/n\.js/, "the change is left in the working tree");
  assert.match(rec.means, /NOT committed, NOT pushed, and the task is NOT done/);
  fx.done();
});

test("learning: a candidate lesson keeps its provenance and becomes no policy", async () => {
  const fx = fixture("learn"); initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, {
    write: [{ path: "src/l.js", content: "l\n" }],
    handoff: { candidate_lessons: ["this repository always uses tabs"] },
  }));
  assert.equal(rec.outcome, "VERIFIED");
  assert.deepEqual(rec.candidate_lessons, ["this repository always uses tabs"]);
  // it is a candidate: it is not written into LEARNING.md, a CLAUDE.md, or any
  // knowledge store — only into this run's evidence, with the run id attached.
  assert.equal(existsSync(join(fx.repo, ".sch-loop", "LEARNING.md")), false);
  assert.equal(existsSync(join(fx.repo, "CLAUDE.md")), false);
  const md = readFileSync(join(rec.run_dir, "handoff.md"), "utf8");
  assert.match(md, /Candidate lessons it proposed \(NOT policy/);
  assert.match(md, /always uses tabs/);
  fx.done();
});

test("run ids are sortable and collision-resistant", () => {
  const ids = Array.from({ length: 200 }, () => RUN.newRunId());
  assert.equal(new Set(ids).size, 200);
  for (const id of ids) assert.match(id, /^RUN-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  assert.deepEqual([...ids].sort().map((s) => s.slice(4, 20)), ids.map((s) => s.slice(4, 20)).sort());
});
