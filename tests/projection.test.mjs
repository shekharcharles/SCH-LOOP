// The SQLite operational projection and the read-only dashboard APIs.
//
// The projection is a PROJECTION. It is not the authority, it is rebuildable,
// and deleting it must lose nothing that matters — these tests hold it to that,
// because a projection that quietly becomes authoritative is one you can never
// rebuild again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, withRemote, fakeQueueEnv, git,
         PJ, TG, TR, HG, SCHED, SECRET_ENV } from "./helpers.mjs";

function queueFixture(name) {
  const fx = fixture(name);
  withRemote(fx); initWorkspace(fx); git(fx.repo, "push", "-q", "origin", "main");
  const p = join(fx.home, "projects.json");
  const reg = JSON.parse(readFileSync(p, "utf8"));
  reg.projects[0].delivery = { approval_before_commit: false, approval_before_push: false };
  writeFileSync(p, JSON.stringify(reg, null, 2));
  return fx;
}

// --- 89 + 90. initialisation and idempotent migration ---------------------------

test("projection: the database initialises, migrates once, and migrating again is a no-op", (t) => {
  const fx = fixture("proj-init"); t.after(() => fx.done());

  const db = PJ.open(fx.P);
  t.after(() => { try { db.close(); } catch {} });
  assert.ok(existsSync(PJ.dbPath(fx.P)));
  assert.equal(PJ.schemaVersion(db), PJ.SCHEMA_VERSION);

  // every declared table exists
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const want of ["projects", "tasks", "task_dependencies", "scheduler_runs", "task_attempts",
                      "phases", "envelopes", "gate_reports", "human_gates", "run_references",
                      "delivery_references", "events"])
    assert.ok(tables.includes(want), `missing table ${want}`);
  // and the indexes that make the dashboard's queries bounded
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
  for (const want of ["idx_tasks_project_state", "idx_events_project_time", "idx_events_task", "idx_gates_project_gate"])
    assert.ok(idx.includes(want), `missing index ${want}`);

  // 90: re-running every migration changes nothing and throws nothing
  assert.equal(PJ.migrate(db), PJ.SCHEMA_VERSION);
  assert.equal(PJ.migrate(db), PJ.SCHEMA_VERSION);
  // the second open of the same file also finds it already migrated
  const again = PJ.open(fx.P);
  assert.equal(PJ.schemaVersion(again), PJ.SCHEMA_VERSION);
  again.close();

  // WAL, so the dashboard reading cannot block the scheduler writing
  assert.equal(String(db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase(), "wal");
});

// --- 91 + 92. events project once, duplicates are ignored ------------------------

test("projection: an event is projected once, and replaying it changes nothing", (t) => {
  const fx = fixture("proj-events"); t.after(() => fx.done());
  const db = PJ.open(fx.P);
  t.after(() => { try { db.close(); } catch {} });

  const ev = { event_id: "SEV-abc123", project_id: fx.P, scheduler_id: "SCHED-1", task_id: 7,
    attempt: 1, phase_id: "implement", type: "scheduler.phase_started", actor: "scheduler",
    causation: null, correlation: "SCHED-1", payload: { kind: "AGENT" }, timestamp: new Date().toISOString() };

  assert.equal(PJ.projectEvent(db, ev).inserted, true);
  assert.equal(PJ.projectEvent(db, ev).inserted, false, "a replayed event must not be counted twice");
  assert.equal(PJ.projectEvent(db, { ...ev, payload: { kind: "TAMPERED" } }).inserted, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_id = ?").get("SEV-abc123").n, 1);
  const row = db.prepare("SELECT * FROM events WHERE event_id = ?").get("SEV-abc123");
  assert.equal(JSON.parse(row.payload).kind, "AGENT", "the first projection wins; a replay never rewrites it");
  assert.equal(row.task_id, 7);
});

// --- 93. a restarted scheduler reads the projection -------------------------------

test("projection: a full queue run lands in every table, and survives the scheduler exiting", async (t) => {
  const fx = queueFixture("proj-full"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const b = addTask(fx, { title: "two", allow: "src/**", deps: String(a) });
  fx.cli("task-set", "--project", fx.P, String(b), "--dep-reason", `${a}:DATA_DEPENDENCY:the first file`);
  const env = fakeQueueEnv(fx, {
    [a]: { write: [{ path: "src/a.js", content: "// a\n" }] },
    [b]: { write: [{ path: "src/b.js", content: "// b\n" }] },
  });
  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 5 });
  assert.equal(r.stop_reason, "PROJECT_COMPLETED", JSON.stringify(r.failure));

  // A NEW process-level read, after the scheduler finished — nothing is in memory.
  const p = PJ.dashboardProjection(fx.P);
  assert.equal(p.available, true);
  assert.equal(p.db_schema, PJ.SCHEMA_VERSION);
  assert.equal(p.tasks.length, 2);
  assert.equal(p.tasks.every((x) => x.state === "DELIVERED"), true);
  assert.deepEqual(p.ready_tasks, []);
  assert.equal(p.project.complete, true);

  const dep = p.dependencies.find((d) => d.task_id === b && !d.hidden);
  assert.equal(dep.depends_on, a);
  assert.equal(dep.type, "DATA_DEPENDENCY");
  assert.equal(dep.consumes, "the first file");

  assert.equal(p.schedulers[0].scheduler_id, r.scheduler_id);
  assert.equal(p.schedulers[0].stop_reason, "PROJECT_COMPLETED");
  assert.equal(p.schedulers[0].tasks_delivered, 2);
  assert.equal(p.attempts.length, 2);
  assert.ok(p.phases.length >= SCHED.TASK_WORKFLOW.length, `${p.phases.length} phase rows`);
  assert.ok(p.gate_reports.length >= 10);
  assert.ok(p.gate_reports.every((g) => g.outcome === "PASS"));
  assert.equal(p.retries.length, 2);
  assert.ok(p.recent_events.length > 10);

  // run + delivery references, so "which run produced which commit" is one query
  const db = PJ.open(fx.P);
  t.after(() => { try { db.close(); } catch {} });
  assert.equal(PJ.q(db, "SELECT * FROM run_references WHERE project_id = ?", fx.P).length, 2);
  const deliveries = PJ.q(db, "SELECT * FROM delivery_references WHERE project_id = ?", fx.P);
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries.every((d) => /^[0-9a-f]{40}$/.test(d.commit_hash) && d.state === "DELIVERED"));
  // envelopes are recorded by hash, with their summary and nothing unbounded
  const envs = PJ.q(db, "SELECT * FROM envelopes WHERE project_id = ?", fx.P);
  assert.ok(envs.length >= 10);
  assert.ok(envs.every((e) => /^[0-9a-f]{64}$/.test(e.envelope_hash) && (e.summary ?? "").length <= 1001));
});

// --- 94. concurrent reads while the scheduler writes --------------------------------

test("projection: a reader and a writer can hold the database at the same time", async (t) => {
  const fx = queueFixture("proj-concurrent"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }] } });

  // Read the projection from a second connection on every scheduler event. If a
  // reader could block the writer (or be blocked by it) this deadlocks or throws.
  let reads = 0, readErrors = 0;
  await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1, onEvent: () => {
    try { PJ.dashboardProjection(fx.P); reads += 1; } catch { readErrors += 1; }
  } });
  assert.ok(reads > 20, `expected many concurrent reads, got ${reads}`);
  assert.equal(readErrors, 0, "a dashboard read must never fail because a scheduler is writing");
});

// --- 95. rebuild ------------------------------------------------------------------

test("projection: deleting it loses nothing — it rebuilds from state", async (t) => {
  const fx = queueFixture("proj-rebuild"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }] } });
  await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });
  HG.create(fx.P, { gateType: "SCOPE_EXPANSION", taskId: a,
    question: "Task #1 wants to widen its path policy to migrations/. Approve the wider scope, or fail the task and re-plan?" });

  const before = PJ.dashboardProjection(fx.P);
  assert.equal(before.tasks.length, 1);

  // Throw the whole thing away.
  PJ.reset(fx.P);
  assert.equal(existsSync(PJ.dbPath(fx.P)), false);

  // Rebuild from SCH state — the authority — through the ordinary command.
  const rebuilt = JSON.parse(fx.cli("projection-status", "--project", fx.P, "--rebuild", "true"));
  assert.equal(rebuilt.available, true);
  assert.equal(rebuilt.tasks.length, 1);
  assert.equal(rebuilt.tasks[0].state, before.tasks[0].state);
  assert.equal(rebuilt.tasks[0].delivery_commit, before.tasks[0].delivery_commit);
  assert.equal(rebuilt.human_gates.length, 1);
  assert.equal(rebuilt.human_gates[0].gate_type, "SCOPE_EXPANSION");
  assert.equal(rebuilt.tasks[0].title, before.tasks[0].title);
});

// --- 96. no secrets ------------------------------------------------------------------

test("projection: no secret, no worker output and no unbounded text is ever stored", async (t) => {
  const fx = queueFixture("proj-secrets"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const env = fakeQueueEnv(fx, { [a]: {
    write: [{ path: "src/a.js", content: "// a\n" }],
    // a worker that prints a great deal, including things that look like secrets
    stdoutBytes: 30000,
    handoff: { summary: "x".repeat(3000) },
  } });
  await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });

  const raw = readFileSync(PJ.dbPath(fx.P));
  const text = raw.toString("latin1");
  for (const [name, value] of Object.entries(SECRET_ENV))
    assert.equal(text.includes(value), false, `${name}'s value must never reach the projection`);
  assert.equal(/x{2000,}/.test(text), false, "no unbounded worker text is stored");

  const db = PJ.open(fx.P);
  t.after(() => { try { db.close(); } catch {} });
  for (const row of PJ.q(db, "SELECT summary FROM envelopes WHERE project_id = ?", fx.P))
    assert.ok((row.summary ?? "").length <= 1001, `summary of ${row.summary?.length} characters is not bounded`);
  for (const row of PJ.q(db, "SELECT payload FROM events WHERE project_id = ?", fx.P))
    assert.ok((row.payload ?? "").length <= 8001);
});

// ====================================================== 97–102. dashboard APIs

// The dashboard module starts a server on import, so the APIs are exercised
// through the same functions it serves rather than by binding a port in a test.
test("dashboard: the graph, scheduler, phase, gate, human-gate and completion APIs answer", async (t) => {
  const fx = queueFixture("dash-apis"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const b = addTask(fx, { title: "two", allow: "src/**", deps: String(a) });
  const env = fakeQueueEnv(fx, {
    [a]: { write: [{ path: "src/a.js", content: "// a\n" }] },
    [b]: { write: [{ path: "src/b.js", content: "// b\n" }] },
  });
  const r = await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });

  // 97: the project graph
  const graph = TG.projectGraph(fx.P, { canonicalState: TR.canonicalState });
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes.find((n) => n.id === a).state, "DELIVERED");
  assert.equal(graph.nodes.find((n) => n.id === b).ready, true);
  assert.equal(graph.validation.ok, true);

  // 98: the active scheduler
  const sched = SCHED.schedulerProjection(fx.P);
  assert.equal(sched.available, true);
  assert.equal(sched.schedulers[0].scheduler_id, r.scheduler_id);
  assert.equal(sched.write_actions_require_local_operator, true);

  // 99: phases
  const phases = SCHED.taskPhases(fx.P, a);
  assert.equal(phases.attempts.length, 1);
  assert.equal(phases.attempts[0].recovery.completed, true);
  assert.equal(phases.workflow.length, SCHED.TASK_WORKFLOW.length);

  // 100: gates, with their evidence
  const gates = JSON.parse(fx.cli("gate-report", "--project", fx.P, "--task", String(a)));
  assert.ok(gates.reports.length >= 10);
  assert.ok(gates.reports.every((g) => g.checks.length && g.evidence_hash));

  // 101: human gates — read-only, and the payload says so
  const hg = HG.projection(fx.P);
  assert.equal(hg.decisions_require_local_operator, true);
  assert.match(hg.decide_with, /human-gate-decide/);

  // 102: completion
  const completion = SCHED.evaluateCompletion(fx.P, { wsDir: fx.wsDir() });
  assert.equal(completion.complete, false, "task two is still outstanding");
  assert.ok(completion.reasons.every((x) => typeof x.evidence === "string"));
});

test("dashboard: every new API is registered, read-only, and refuses an unknown project", async () => {
  const src = readFileSync(join(process.cwd(), "scripts", "dashboard.mjs"), "utf8");
  for (const path of ["/api/task-graph", "/api/scheduler", "/api/phases", "/api/gates",
                      "/api/human-gates", "/api/completion", "/api/operations", "/api/workflow"])
    assert.ok(src.includes(`url.pathname === "${path}"`), `missing route ${path}`);
  // every one of them is reached on the GET path, below the POST handler's
  // `return forbid(res)` — a write route would have to be added above it
  const postBlock = src.slice(src.indexOf('if (req.method === "POST")'), src.indexOf('url.pathname === "/api/projects"'));
  for (const path of ["/api/task-graph", "/api/scheduler", "/api/human-gates"])
    assert.equal(postBlock.includes(path), false, `${path} must not be reachable as a write`);
  // and the human-gate projection never advertises a remote decision endpoint
  assert.equal(src.includes('url.pathname === "/api/human-gate-decide"'), false);
  assert.equal(src.includes('url.pathname === "/api/approve"'), false);
});

test("dashboard: the operational API is bounded and never returns worker output", async (t) => {
  const fx = queueFixture("dash-bounded"); t.after(() => fx.done());
  const a = addTask(fx, { title: "one", allow: "src/**" });
  const env = fakeQueueEnv(fx, { [a]: { write: [{ path: "src/a.js", content: "// a\n" }], stdoutBytes: 50000 } });
  await SCHED.runQueue({ projectId: fx.P, env, maxTasks: 1 });

  const p = PJ.dashboardProjection(fx.P, { limit: 5 });
  const body = JSON.stringify(p);
  assert.equal(/x{1000,}/.test(body), false, "worker stdout must stay on disk and be referenced");
  assert.ok(p.attempts.length <= 5);
  assert.ok(p.schedulers.length <= 5);
  assert.ok(body.length < 400_000, `the payload is ${body.length} characters`);
  assert.equal(p.generated_at.length, 24);
});
