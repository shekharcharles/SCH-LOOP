#!/usr/bin/env node
// SCH Loop — the SQLite operational projection.
//
// WHY THIS EXISTS
// The dashboard answered "what is happening" by re-reading every state file and
// walking every run directory, five times a minute. That is fine for ten tasks
// and hopeless for a queue with attempts, phases and gate reports underneath
// each one — and it cannot answer a question like "which gate has failed most
// this week" at any size.
//
// WHAT THIS IS NOT
// It is not the authority. `projects/<id>/state.json`, the run records, the
// delivery transactions and the JSONL event logs remain the truth; this is a
// PROJECTION of them, rebuildable, and safe to delete. Nothing reads a decision
// out of here to act on it. That boundary is deliberate — a projection that
// quietly becomes authoritative is a projection you can never rebuild again.
//
// node:sqlite ships inside Node, so this adds no dependency. The file lives
// under SCH operational data (`SCH_HOME/projects/<id>/ops.db`), never inside the
// managed repository: SCH's bookkeeping is not the customer's source tree.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 3;

const root = () => process.env.SCH_HOME || join(dirname(fileURLToPath(import.meta.url)), "..");
export const dbPath = (projectId) => join(root(), "projects", projectId, "ops.db");

const now = () => new Date().toISOString();
// Bounded text everywhere. A projection row is for reading on a dashboard; the
// unbounded thing it describes stays on disk and is referenced, never inlined.
const clamp = (s, n = 2000) => (s === null || s === undefined ? null : (String(s).length > n ? String(s).slice(0, n) + "…" : String(s)));
const j = (v) => (v === undefined || v === null ? null : clamp(JSON.stringify(v), 8000));

// ------------------------------------------------------------------ schema

// Each migration is idempotent and additive. Nothing here drops a column: a
// projection that can lose data on upgrade is a projection you cannot trust to
// rebuild, which is the only reason it is allowed to exist.
const MIGRATIONS = [
  // 1 — the core graph + execution tables
  `
  CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY, name TEXT, domain TEXT, execution_mode TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS tasks (
    project_id TEXT NOT NULL, task_id INTEGER NOT NULL,
    title TEXT, phase INTEGER, priority INTEGER, category TEXT,
    state TEXT, legacy_status TEXT, state_version INTEGER,
    ready INTEGER, blockers TEXT, allowed_paths TEXT, forbidden_paths TEXT,
    attempts INTEGER, delivery_commit TEXT, updated_at TEXT,
    PRIMARY KEY (project_id, task_id)
  );
  CREATE TABLE IF NOT EXISTS task_dependencies (
    project_id TEXT NOT NULL, task_id INTEGER NOT NULL, depends_on INTEGER NOT NULL,
    type TEXT, consumes TEXT, note TEXT, hidden INTEGER DEFAULT 0,
    PRIMARY KEY (project_id, task_id, depends_on, hidden)
  );
  CREATE TABLE IF NOT EXISTS scheduler_runs (
    scheduler_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    state TEXT, stop_reason TEXT, tasks_delivered INTEGER DEFAULT 0,
    max_tasks INTEGER, max_duration_ms INTEGER, pid INTEGER,
    started_at TEXT, ended_at TEXT
  );
  CREATE TABLE IF NOT EXISTS task_attempts (
    project_id TEXT NOT NULL, task_id INTEGER NOT NULL, attempt INTEGER NOT NULL,
    scheduler_id TEXT, run_id TEXT, outcome TEXT, failure_code TEXT,
    failure_class TEXT, retryable INTEGER, prompt_characters INTEGER,
    started_at TEXT, ended_at TEXT, dir TEXT,
    PRIMARY KEY (project_id, task_id, attempt)
  );
  CREATE TABLE IF NOT EXISTS phases (
    project_id TEXT NOT NULL, task_id INTEGER NOT NULL, attempt INTEGER NOT NULL,
    phase_id TEXT NOT NULL, idx INTEGER, kind TEXT, role TEXT,
    state TEXT, outcome TEXT, failure_code TEXT, failure_message TEXT,
    envelope_type TEXT, envelope_hash TEXT,
    prompt_characters INTEGER, output_bytes INTEGER,
    duration_ms INTEGER, started_at TEXT, ended_at TEXT,
    PRIMARY KEY (project_id, task_id, attempt, phase_id)
  );
  CREATE TABLE IF NOT EXISTS envelopes (
    envelope_hash TEXT PRIMARY KEY, project_id TEXT, task_id INTEGER, attempt INTEGER,
    phase_id TEXT, envelope_type TEXT, status TEXT, summary TEXT, recorded_at TEXT
  );
  CREATE TABLE IF NOT EXISTS gate_reports (
    project_id TEXT NOT NULL, task_id INTEGER, attempt INTEGER, phase_id TEXT,
    gate_id TEXT NOT NULL, gate_version INTEGER, kind TEXT, outcome TEXT,
    overridable INTEGER, checks TEXT, evidence_hash TEXT, started_at TEXT, ended_at TEXT,
    PRIMARY KEY (project_id, task_id, attempt, phase_id, gate_id, evidence_hash)
  );
  CREATE TABLE IF NOT EXISTS human_gates (
    gate_id TEXT PRIMARY KEY, project_id TEXT, task_id INTEGER, run_id TEXT,
    attempt INTEGER, phase_id TEXT, gate_type TEXT, status TEXT, decision TEXT,
    approver TEXT, question TEXT, proposal_hash TEXT, diff_hash TEXT,
    created_at TEXT, decided_at TEXT, expires_at TEXT
  );
  CREATE TABLE IF NOT EXISTS run_references (
    run_id TEXT PRIMARY KEY, project_id TEXT, task_id INTEGER, attempt INTEGER,
    outcome TEXT, failure_code TEXT, dir TEXT, at TEXT
  );
  CREATE TABLE IF NOT EXISTS delivery_references (
    delivery_id TEXT PRIMARY KEY, project_id TEXT, task_id INTEGER, run_id TEXT,
    state TEXT, commit_hash TEXT, branch TEXT, remote TEXT, pushed_range TEXT,
    approval_status TEXT, failure_code TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY, project_id TEXT, scheduler_id TEXT,
    task_id INTEGER, attempt INTEGER, phase_id TEXT, type TEXT, actor TEXT,
    causation TEXT, correlation TEXT, payload TEXT, timestamp TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_project_state ON tasks(project_id, state);
  CREATE INDEX IF NOT EXISTS idx_attempts_project_task ON task_attempts(project_id, task_id);
  CREATE INDEX IF NOT EXISTS idx_phases_project_task ON phases(project_id, task_id, attempt);
  CREATE INDEX IF NOT EXISTS idx_gates_project_gate ON gate_reports(project_id, gate_id);
  CREATE INDEX IF NOT EXISTS idx_events_project_time ON events(project_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_scheduler ON events(scheduler_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_task ON events(project_id, task_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_scheduler_project ON scheduler_runs(project_id, started_at);
  `,
  // 2 — the scheduler's own current position, so the dashboard can answer
  //     "what is it doing right now" without walking directories
  `
  ALTER TABLE scheduler_runs ADD COLUMN current_task INTEGER;
  ALTER TABLE scheduler_runs ADD COLUMN current_phase TEXT;
  ALTER TABLE scheduler_runs ADD COLUMN current_attempt INTEGER;
  `,
  // 3 — project completion, evaluated deterministically and worth caching
  `
  ALTER TABLE projects ADD COLUMN complete INTEGER DEFAULT 0;
  ALTER TABLE projects ADD COLUMN completion TEXT;
  `,
];

// ------------------------------------------------------------------- open

export function open(projectId, { readonly = false } = {}) {
  const p = dbPath(projectId);
  mkdirSync(dirname(p), { recursive: true });
  const db = new DatabaseSync(p, { readOnly: readonly && existsSync(p) });
  if (!readonly) {
    // WAL: the dashboard reads while the scheduler writes. Without it the reader
    // takes a lock the writer then waits on, and a status page stalls a queue.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  }
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get();
  const at = Number(row?.value ?? 0);
  for (let i = at; i < MIGRATIONS.length; i++) {
    // Each migration runs in its own transaction: a half-applied schema is worse
    // than an old one, and ALTER TABLE on a column that already exists (a
    // half-finished earlier upgrade) must not abort the rest.
    db.exec("BEGIN");
    try {
      for (const stmt of MIGRATIONS[i].split(";").map((s) => s.trim()).filter(Boolean)) {
        try { db.exec(stmt); }
        catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
      }
      db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(i + 1));
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  return schemaVersion(db);
}

export const schemaVersion = (db) => Number(db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get()?.value ?? 0);

// ------------------------------------------------------------------ writes

// One transaction per call. A projection that is half-written when the process
// dies is a projection that lies, and lying is the one thing it must not do.
function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

export function upsertProject(db, p) {
  tx(db, () => db.prepare(`INSERT INTO projects (project_id, name, domain, execution_mode, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET
    name = excluded.name, domain = excluded.domain, execution_mode = excluded.execution_mode, updated_at = excluded.updated_at`)
    .run(p.project_id, clamp(p.name, 200), clamp(p.domain, 60), clamp(p.execution_mode, 60), now()));
}

export function upsertCompletion(db, projectId, completion) {
  tx(db, () => db.prepare("UPDATE projects SET complete = ?, completion = ?, updated_at = ? WHERE project_id = ?")
    .run(completion.complete ? 1 : 0, j(completion), now(), projectId));
}

// The whole graph in one transaction: a dashboard must never see half a queue.
export function upsertGraph(db, projectId, graph) {
  tx(db, () => {
    const t = db.prepare(`INSERT INTO tasks (project_id, task_id, title, phase, priority, category,
      state, legacy_status, state_version, ready, blockers, allowed_paths, forbidden_paths, attempts, delivery_commit, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id, task_id) DO UPDATE SET
      title=excluded.title, phase=excluded.phase, priority=excluded.priority, category=excluded.category,
      state=excluded.state, legacy_status=excluded.legacy_status, state_version=excluded.state_version,
      ready=excluded.ready, blockers=excluded.blockers, allowed_paths=excluded.allowed_paths,
      forbidden_paths=excluded.forbidden_paths, attempts=excluded.attempts,
      delivery_commit=excluded.delivery_commit, updated_at=excluded.updated_at`);
    for (const n of graph.nodes)
      t.run(projectId, n.id, clamp(n.title, 400), n.phase, n.priority, clamp(n.category, 60),
        n.state, n.legacy_status, n.state_version, n.ready ? 1 : 0, j(n.blockers),
        j(n.allowed_paths), j(n.forbidden_paths), n.attempts ?? 0, n.delivery?.commit ?? null, now());

    db.prepare("DELETE FROM task_dependencies WHERE project_id = ?").run(projectId);
    const d = db.prepare("INSERT OR REPLACE INTO task_dependencies (project_id, task_id, depends_on, type, consumes, note, hidden) VALUES (?,?,?,?,?,?,?)");
    for (const e of graph.edges) d.run(projectId, e.to, e.from, e.type, clamp(e.consumes, 300), clamp(e.note, 500), 0);
    for (const e of graph.hidden_edges ?? []) d.run(projectId, e.to, e.from, e.type, null, clamp(e.evidence, 500), 1);
  });
}

export function upsertScheduler(db, s) {
  tx(db, () => db.prepare(`INSERT INTO scheduler_runs (scheduler_id, project_id, state, stop_reason,
    tasks_delivered, max_tasks, max_duration_ms, pid, started_at, ended_at, current_task, current_phase, current_attempt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scheduler_id) DO UPDATE SET
    state=excluded.state, stop_reason=excluded.stop_reason, tasks_delivered=excluded.tasks_delivered,
    ended_at=excluded.ended_at, current_task=excluded.current_task, current_phase=excluded.current_phase,
    current_attempt=excluded.current_attempt`)
    .run(s.scheduler_id, s.project_id, s.state, clamp(s.stop_reason, 200), s.tasks_delivered ?? 0,
      s.max_tasks ?? null, s.max_duration_ms ?? null, s.pid ?? null, s.started_at, s.ended_at ?? null,
      s.current_task ?? null, clamp(s.current_phase, 80), s.current_attempt ?? null));
}

export function upsertAttempt(db, a) {
  tx(db, () => db.prepare(`INSERT INTO task_attempts (project_id, task_id, attempt, scheduler_id, run_id,
    outcome, failure_code, failure_class, retryable, prompt_characters, started_at, ended_at, dir)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id, task_id, attempt) DO UPDATE SET
    scheduler_id=excluded.scheduler_id, run_id=excluded.run_id, outcome=excluded.outcome,
    failure_code=excluded.failure_code, failure_class=excluded.failure_class, retryable=excluded.retryable,
    prompt_characters=excluded.prompt_characters, ended_at=excluded.ended_at, dir=excluded.dir`)
    .run(a.project_id, Number(a.task_id), Number(a.attempt), a.scheduler_id ?? null, a.run_id ?? null,
      a.outcome ?? null, a.failure?.code ?? a.failure_code ?? null, a.failure_class ?? null,
      a.retryable === undefined ? null : (a.retryable ? 1 : 0), a.prompt_characters ?? null,
      a.started_at ?? now(), a.ended_at ?? null, clamp(a.dir, 500)));
}

export function upsertPhase(db, projectId, p) {
  tx(db, () => {
    db.prepare(`INSERT INTO phases (project_id, task_id, attempt, phase_id, idx, kind, role, state, outcome,
      failure_code, failure_message, envelope_type, envelope_hash, prompt_characters, output_bytes,
      duration_ms, started_at, ended_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id, task_id, attempt, phase_id) DO UPDATE SET
      idx=excluded.idx, kind=excluded.kind, role=excluded.role, state=excluded.state, outcome=excluded.outcome,
      failure_code=excluded.failure_code, failure_message=excluded.failure_message,
      envelope_type=excluded.envelope_type, envelope_hash=excluded.envelope_hash,
      prompt_characters=excluded.prompt_characters, output_bytes=excluded.output_bytes,
      duration_ms=excluded.duration_ms, ended_at=excluded.ended_at`)
      .run(projectId, Number(p.task_id), Number(p.attempt ?? 1), p.phase_id, p.index ?? 0, p.kind, p.role ?? null,
        p.state, p.outcome ?? null, p.failure?.code ?? null, clamp(p.failure?.message, 1000),
        p.envelope_type ?? null, p.envelope_hash ?? null,
        p.accounting?.prompt_characters ?? null, p.accounting?.output_bytes ?? null,
        p.duration_ms ?? null, p.started_at ?? null, p.ended_at ?? null);

    // The envelope's SUMMARY only. Its claims live in the phase record on disk;
    // copying an agent's free text into a queryable table is how a projection
    // ends up holding something nobody bounded.
    if (p.envelope_hash && p.envelope)
      db.prepare(`INSERT OR IGNORE INTO envelopes (envelope_hash, project_id, task_id, attempt, phase_id, envelope_type, status, summary, recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(p.envelope_hash, projectId, Number(p.task_id), Number(p.attempt ?? 1), p.phase_id,
          p.envelope_type, clamp(p.envelope.status, 40), clamp(p.envelope.summary, 1000), now());

    const g = db.prepare(`INSERT OR IGNORE INTO gate_reports (project_id, task_id, attempt, phase_id, gate_id,
      gate_version, kind, outcome, overridable, checks, evidence_hash, started_at, ended_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of p.gate_reports ?? [])
      g.run(projectId, Number(p.task_id), Number(p.attempt ?? 1), p.phase_id, r.gate_id, r.gate_version,
        r.kind, r.outcome, r.overridable ? 1 : 0, j(r.checks), r.evidence_hash ?? "", r.started_at, r.ended_at);
  });
}

export function upsertHumanGates(db, projectId, gates) {
  tx(db, () => {
    const s = db.prepare(`INSERT INTO human_gates (gate_id, project_id, task_id, run_id, attempt, phase_id,
      gate_type, status, decision, approver, question, proposal_hash, diff_hash, created_at, decided_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(gate_id) DO UPDATE SET
      status=excluded.status, decision=excluded.decision, approver=excluded.approver, decided_at=excluded.decided_at`);
    for (const g of gates)
      s.run(g.id, projectId, g.task_id === null || g.task_id === undefined ? null : Number(g.task_id),
        g.run_id ?? null, g.attempt ?? null, g.phase_id ?? null, g.gate_type, g.status, g.decision ?? null,
        g.approver ?? null, clamp(g.question, 2000), g.proposal_hash, g.diff_hash ?? null,
        g.created_at, g.decided_at ?? null, g.expires_at ?? null);
  });
}

export function upsertRunReference(db, projectId, r) {
  tx(db, () => db.prepare(`INSERT INTO run_references (run_id, project_id, task_id, attempt, outcome, failure_code, dir, at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET outcome=excluded.outcome, failure_code=excluded.failure_code, at=excluded.at`)
    .run(r.run_id, projectId, Number(r.task_id), r.attempt ?? 1, r.outcome ?? null, r.failure ?? r.failure_code ?? null, clamp(r.dir, 500), r.at ?? now()));
}

export function upsertDeliveryReference(db, projectId, d) {
  tx(db, () => db.prepare(`INSERT INTO delivery_references (delivery_id, project_id, task_id, run_id, state,
    commit_hash, branch, remote, pushed_range, approval_status, failure_code, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(delivery_id) DO UPDATE SET
    state=excluded.state, commit_hash=excluded.commit_hash, pushed_range=excluded.pushed_range,
    approval_status=excluded.approval_status, failure_code=excluded.failure_code, updated_at=excluded.updated_at`)
    .run(d.delivery_id, projectId, Number(d.task_id), d.run_id, d.state, d.commit ?? d.commit_hash ?? null,
      d.branch ?? null, d.remote ?? null, d.push?.pushed_range ?? d.pushed_range ?? null,
      d.approval_status ?? null, d.failure?.code ?? null, now()));
}

// IDEMPOTENT BY EVENT ID. The scheduler may replay its own log after a crash,
// and a replayed event that increments something is a projection that drifts
// further from the truth every time it recovers.
export function projectEvent(db, ev) {
  const r = tx(db, () => db.prepare(`INSERT OR IGNORE INTO events (event_id, project_id, scheduler_id, task_id,
    attempt, phase_id, type, actor, causation, correlation, payload, timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ev.event_id, ev.project_id, ev.scheduler_id ?? null,
      ev.task_id === null || ev.task_id === undefined ? null : Number(ev.task_id),
      ev.attempt ?? null, ev.phase_id ?? null, ev.type, clamp(ev.actor, 80),
      ev.causation ?? null, ev.correlation ?? null, j(ev.payload), ev.timestamp ?? now()));
  return { inserted: r.changes === 1 };
}

// ------------------------------------------------------------------- reads

export const q = (db, sql, ...args) => db.prepare(sql).all(...args);

export function schedulerRow(db, schedulerId) {
  return db.prepare("SELECT * FROM scheduler_runs WHERE scheduler_id = ?").get(schedulerId) ?? null;
}
export function activeScheduler(db, projectId) {
  return db.prepare("SELECT * FROM scheduler_runs WHERE project_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get(projectId) ?? null;
}

// Everything the dashboard's new sections need, in one bounded call.
export function dashboardProjection(projectId, { limit = 20 } = {}) {
  let db;
  try { db = open(projectId); } catch (e) { return { project_id: projectId, available: false, reason: e.message }; }
  try {
    const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
    const tasks = q(db, "SELECT * FROM tasks WHERE project_id = ? ORDER BY phase, priority, task_id", projectId)
      .map((t) => ({ ...t, ready: Boolean(t.ready), blockers: parse(t.blockers) ?? [], allowed_paths: parse(t.allowed_paths) ?? [], forbidden_paths: parse(t.forbidden_paths) ?? [] }));
    const active = activeScheduler(db, projectId);
    const project = db.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId) ?? null;
    return {
      schema_version: SCHEMA_VERSION, db_schema: schemaVersion(db), project_id: projectId, available: true,
      project: project ? { ...project, complete: Boolean(project.complete), completion: parse(project.completion) } : null,
      tasks,
      ready_tasks: tasks.filter((t) => t.ready).map((t) => t.task_id),
      dependencies: q(db, "SELECT task_id, depends_on, type, consumes, note, hidden FROM task_dependencies WHERE project_id = ?", projectId)
        .map((d) => ({ ...d, hidden: Boolean(d.hidden) })),
      active_scheduler: active,
      schedulers: q(db, "SELECT * FROM scheduler_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?", projectId, limit),
      attempts: q(db, "SELECT * FROM task_attempts WHERE project_id = ? ORDER BY started_at DESC LIMIT ?", projectId, limit),
      phases: q(db, "SELECT * FROM phases WHERE project_id = ? ORDER BY started_at DESC LIMIT ?", projectId, limit * 3),
      gate_reports: q(db, "SELECT project_id, task_id, attempt, phase_id, gate_id, gate_version, kind, outcome, overridable, evidence_hash, ended_at FROM gate_reports WHERE project_id = ? ORDER BY ended_at DESC LIMIT ?", projectId, limit * 3),
      human_gates: q(db, "SELECT * FROM human_gates WHERE project_id = ? ORDER BY created_at DESC LIMIT ?", projectId, limit),
      deliveries: q(db, "SELECT * FROM delivery_references WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?", projectId, limit),
      retries: q(db, "SELECT task_id, COUNT(*) AS attempts, SUM(CASE WHEN retryable = 1 THEN 1 ELSE 0 END) AS retryable FROM task_attempts WHERE project_id = ? GROUP BY task_id", projectId),
      recent_events: q(db, "SELECT event_id, type, task_id, attempt, phase_id, actor, timestamp FROM events WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?", projectId, limit * 2),
      generated_at: now(),
    };
  } finally { try { db.close(); } catch {} }
}

// ---------------------------------------------------------------- rebuild

// The projection is disposable, and this proves it. Deleting the file and
// re-deriving from state + the scheduler's own event logs must produce the same
// answers — if it ever cannot, the projection has quietly become authoritative
// and that is a bug, not a feature.
export function reset(projectId) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath(projectId) + suffix;
    try { if (existsSync(p)) rmSync(p, { force: true }); } catch {}
  }
  return { reset: true, path: dbPath(projectId) };
}
