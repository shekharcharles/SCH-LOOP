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

export const SCHEMA_VERSION = 4;

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
  // 4 — the software-factory runtime: workflows, roles, models, prompts, usage,
  //     procedures and external skill governance. Additive only: every existing
  //     row stays readable, and nothing here drops a column.
  `
  CREATE TABLE IF NOT EXISTS workflow_templates (
    template_id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT, description TEXT,
    supported_task_types TEXT, high_risk INTEGER DEFAULT 0, phase_count INTEGER,
    delivers INTEGER DEFAULT 0, phases TEXT, recorded_at TEXT,
    PRIMARY KEY (template_id, version)
  );
  CREATE TABLE IF NOT EXISTS workflow_executions (
    workflow_id TEXT PRIMARY KEY, project_id TEXT, task_id INTEGER,
    template_id TEXT, template_version INTEGER, template_hash TEXT, selected_by TEXT,
    high_risk INTEGER DEFAULT 0, outcome TEXT, scheduler_id TEXT,
    started_at TEXT, ended_at TEXT
  );
  CREATE TABLE IF NOT EXISTS role_profiles (
    role_id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT, purpose TEXT,
    model_profile TEXT, tools TEXT, write_scope TEXT, read_only INTEGER DEFAULT 0,
    output_envelope TEXT, recorded_at TEXT,
    PRIMARY KEY (role_id, version)
  );
  CREATE TABLE IF NOT EXISTS model_profiles (
    profile_id TEXT NOT NULL, version INTEGER NOT NULL, executor TEXT, provider TEXT,
    reasoning TEXT, available INTEGER DEFAULT 1, unavailable_reason TEXT,
    fallback_profiles TEXT, max_prompt_characters INTEGER, recorded_at TEXT,
    PRIMARY KEY (profile_id, version)
  );
  CREATE TABLE IF NOT EXISTS phase_agent_config (
    project_id TEXT NOT NULL, task_id INTEGER NOT NULL, attempt INTEGER NOT NULL, phase_id TEXT NOT NULL,
    phase_execution_id TEXT, actor_kind TEXT, role_id TEXT, role_version INTEGER,
    executor_id TEXT, provider TEXT, model_profile TEXT, resolved_model TEXT, reasoning TEXT,
    tools TEXT, write_scope_summary TEXT, selected_skills TEXT, fallback_used INTEGER DEFAULT 0,
    recorded_at TEXT,
    PRIMARY KEY (project_id, task_id, attempt, phase_id)
  );
  CREATE TABLE IF NOT EXISTS prompt_manifests (
    prompt_hash TEXT PRIMARY KEY, project_id TEXT, task_id INTEGER, attempt INTEGER, phase_id TEXT,
    system_prompt_hash TEXT, user_prompt_hash TEXT, prompt_template TEXT,
    total_characters INTEGER, system_characters INTEGER, user_characters INTEGER,
    sections TEXT, compacted TEXT, omitted TEXT, skills TEXT, procedures TEXT,
    redacted INTEGER DEFAULT 0, task_state_version INTEGER, generated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS context_manifests (
    project_id TEXT NOT NULL, task_id INTEGER NOT NULL, attempt INTEGER NOT NULL, phase_id TEXT NOT NULL,
    inputs TEXT, omitted TEXT, compacted TEXT, skills TEXT, procedures TEXT, generated_at TEXT,
    PRIMARY KEY (project_id, task_id, attempt, phase_id)
  );
  CREATE TABLE IF NOT EXISTS usage_records (
    project_id TEXT NOT NULL, task_id INTEGER NOT NULL, attempt INTEGER NOT NULL, phase_id TEXT NOT NULL,
    role_id TEXT, workflow_id TEXT, usage_status TEXT, cost_status TEXT,
    provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER,
    duration_ms INTEGER, process_duration_ms INTEGER, output_bytes INTEGER,
    prompt_characters INTEGER, phase_outcome TEXT, unknown_reason TEXT, recorded_at TEXT,
    PRIMARY KEY (project_id, task_id, attempt, phase_id)
  );
  CREATE TABLE IF NOT EXISTS cost_records (
    project_id TEXT NOT NULL, task_id INTEGER NOT NULL, attempt INTEGER NOT NULL, phase_id TEXT NOT NULL,
    cost_status TEXT, estimated_cost_usd REAL, reported_cost_usd REAL,
    pricing_table_version TEXT, recorded_at TEXT,
    PRIMARY KEY (project_id, task_id, attempt, phase_id)
  );
  CREATE TABLE IF NOT EXISTS procedure_versions (
    procedure_id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT,
    capabilities TEXT, characters INTEGER, recorded_at TEXT,
    PRIMARY KEY (procedure_id, version)
  );
  CREATE TABLE IF NOT EXISTS external_skill_sources (
    source_id TEXT PRIMARY KEY, repository TEXT, pinned_commit TEXT, synced_commit TEXT,
    license TEXT, license_status TEXT, enabled INTEGER DEFAULT 1, auto_update INTEGER DEFAULT 0,
    source_hash TEXT, synced_at TEXT, recorded_at TEXT
  );
  CREATE TABLE IF NOT EXISTS external_skills (
    source_id TEXT NOT NULL, skill_id TEXT NOT NULL, path TEXT, content_hash TEXT,
    source_commit TEXT, trust TEXT, risk_level TEXT, quality TEXT,
    capabilities TEXT, scripts INTEGER, hooks INTEGER, executables INTEGER,
    network_references INTEGER, git_capabilities TEXT, changed_since_review INTEGER DEFAULT 0,
    reviewed_at TEXT, recorded_at TEXT,
    PRIMARY KEY (source_id, skill_id)
  );
  CREATE TABLE IF NOT EXISTS skill_reviews (
    source_id TEXT NOT NULL, skill_id TEXT NOT NULL, reviewer TEXT, content_hash TEXT,
    source_commit TEXT, risk_level TEXT, quality TEXT, notes TEXT, at TEXT,
    PRIMARY KEY (source_id, skill_id, content_hash)
  );
  CREATE TABLE IF NOT EXISTS skill_approvals (
    source_id TEXT NOT NULL, skill_id TEXT NOT NULL, content_hash TEXT, source_commit TEXT,
    eligible_roles TEXT, forbidden_roles TEXT, approver TEXT, why TEXT, at TEXT,
    PRIMARY KEY (source_id, skill_id)
  );
  CREATE TABLE IF NOT EXISTS skill_conflicts (
    source_id TEXT NOT NULL, skill_id TEXT NOT NULL, kind TEXT NOT NULL, conflicts_with TEXT,
    detail TEXT, severity TEXT, recorded_at TEXT,
    PRIMARY KEY (source_id, skill_id, kind, conflicts_with)
  );
  CREATE TABLE IF NOT EXISTS verification_processes (
    project_id TEXT NOT NULL, task_id INTEGER NOT NULL, attempt INTEGER NOT NULL, check_id TEXT NOT NULL,
    executable TEXT, args TEXT, outcome TEXT, exit_code INTEGER, timed_out INTEGER DEFAULT 0,
    duration_ms INTEGER, timeout_ms INTEGER, timeout_decided_by TEXT,
    cleanup_method TEXT, cleanup_ok INTEGER, output_bytes INTEGER, evidence_hash TEXT, recorded_at TEXT,
    PRIMARY KEY (project_id, task_id, attempt, check_id)
  );
  CREATE INDEX IF NOT EXISTS idx_wfexec_project_task ON workflow_executions(project_id, task_id);
  CREATE INDEX IF NOT EXISTS idx_wfexec_template ON workflow_executions(template_id, template_version);
  CREATE INDEX IF NOT EXISTS idx_usage_project_role ON usage_records(project_id, role_id);
  CREATE INDEX IF NOT EXISTS idx_usage_workflow ON usage_records(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_agentcfg_role ON phase_agent_config(project_id, role_id);
  CREATE INDEX IF NOT EXISTS idx_agentcfg_model ON phase_agent_config(model_profile);
  CREATE INDEX IF NOT EXISTS idx_extskill_source ON external_skills(source_id, trust);
  CREATE INDEX IF NOT EXISTS idx_extskill_risk ON external_skills(risk_level);
  CREATE INDEX IF NOT EXISTS idx_vproc_project_task ON verification_processes(project_id, task_id);
  CREATE INDEX IF NOT EXISTS idx_prompt_task ON prompt_manifests(project_id, task_id, attempt);
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

// ----------------------------------------------- the software-factory runtime

// The registries themselves, so a HISTORICAL execution stays readable after a
// template or role is revised. Without this, "task 12 ran FULL_SDLC@1" becomes
// unanswerable the moment version 2 exists.
export function seedRegistries(db, { templates = null, roles = null, procedures = null } = {}) {
  tx(db, () => {
    if (templates) {
      const s = db.prepare(`INSERT INTO workflow_templates (template_id, version, hash, description, supported_task_types,
        high_risk, phase_count, delivers, phases, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(template_id, version) DO UPDATE SET hash=excluded.hash, phases=excluded.phases, recorded_at=excluded.recorded_at`);
      for (const t of templates.templates)
        s.run(t.template_id, t.version, t.hash, clamp(t.description, 500), j(t.supported_task_types),
          t.high_risk ? 1 : 0, t.phase_count, t.delivers ? 1 : 0, j(t.phases), now());
    }
    if (roles) {
      const r = db.prepare(`INSERT INTO role_profiles (role_id, version, hash, purpose, model_profile, tools,
        write_scope, read_only, output_envelope, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(role_id, version) DO UPDATE SET hash=excluded.hash, recorded_at=excluded.recorded_at`);
      for (const x of roles.roles)
        r.run(x.role_id, x.version, x.hash, clamp(x.purpose, 500), x.model_profile, j(x.tools),
          clamp(x.write_scope, 500), x.read_only ? 1 : 0, x.output_envelope, now());
      const m = db.prepare(`INSERT INTO model_profiles (profile_id, version, executor, provider, reasoning,
        available, unavailable_reason, fallback_profiles, max_prompt_characters, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(profile_id, version) DO UPDATE SET available=excluded.available, recorded_at=excluded.recorded_at`);
      for (const x of roles.model_profiles)
        m.run(x.id, x.version, x.executor, x.provider, x.reasoning, x.available ? 1 : 0,
          clamp(x.unavailable_reason, 400), j(x.fallback_profiles), x.max_prompt_characters, now());
    }
    if (procedures) {
      const p = db.prepare(`INSERT INTO procedure_versions (procedure_id, version, hash, capabilities, characters, recorded_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(procedure_id, version) DO UPDATE SET hash=excluded.hash, recorded_at=excluded.recorded_at`);
      for (const x of procedures.procedures) p.run(x.id, x.version, x.hash, j(x.capabilities), x.characters, now());
    }
  });
}

export function upsertWorkflowExecution(db, w) {
  tx(db, () => db.prepare(`INSERT INTO workflow_executions (workflow_id, project_id, task_id, template_id,
    template_version, template_hash, selected_by, high_risk, outcome, scheduler_id, started_at, ended_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET
    outcome=excluded.outcome, ended_at=excluded.ended_at`)
    .run(w.workflow_id, w.project_id, Number(w.task_id), w.template_id, w.template_version, w.template_hash,
      clamp(w.selected_by, 120), w.high_risk ? 1 : 0, w.outcome ?? null, w.scheduler_id ?? null,
      w.started_at ?? now(), w.ended_at ?? null));
}

// The resolved agent configuration for one phase. NO SECRETS: every field comes
// from the role/profile registries, never from the environment.
export function upsertAgentConfig(db, projectId, { taskId, attempt, phaseId, phaseExecutionId, config }) {
  tx(db, () => db.prepare(`INSERT INTO phase_agent_config (project_id, task_id, attempt, phase_id, phase_execution_id,
    actor_kind, role_id, role_version, executor_id, provider, model_profile, resolved_model, reasoning,
    tools, write_scope_summary, selected_skills, fallback_used, recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id, task_id, attempt, phase_id) DO UPDATE SET
    resolved_model=excluded.resolved_model, recorded_at=excluded.recorded_at`)
    .run(projectId, Number(taskId), Number(attempt), phaseId, phaseExecutionId ?? null,
      config.actor_kind ?? "AGENT", config.role_id, config.role_version, config.executor_id, config.provider,
      config.model_profile, config.resolved_model ?? null, config.reasoning,
      j(config.tools), clamp(config.write_scope_summary, 500), j(config.selected_skills),
      config.fallback_used ? 1 : 0, now()));
}

// HASHES AND SIZES ONLY. The prompt bodies stay on disk, local to the machine
// that ran them — an unauthenticated dashboard must never be able to read one.
export function upsertPromptManifest(db, projectId, { taskId, attempt, phaseId, manifest, contextManifest = null }) {
  tx(db, () => {
    db.prepare(`INSERT INTO prompt_manifests (prompt_hash, project_id, task_id, attempt, phase_id,
      system_prompt_hash, user_prompt_hash, prompt_template, total_characters, system_characters, user_characters,
      sections, compacted, omitted, skills, procedures, redacted, task_state_version, generated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(prompt_hash) DO NOTHING`)
      .run(manifest.prompt_hash, projectId, Number(taskId), Number(attempt), phaseId,
        manifest.system_prompt_hash ?? null, manifest.user_prompt_hash ?? null, manifest.prompt_template ?? null,
        manifest.total_characters ?? null, manifest.system_characters ?? null, manifest.user_characters ?? null,
        j(manifest.sections), j(manifest.compacted), j((manifest.sections ?? []).filter((s) => !s.included).map((s) => s.name)),
        j(manifest.skills), j(manifest.procedures), manifest.redacted ? 1 : 0,
        manifest.task_state_version ?? null, manifest.generated_at ?? now());
    if (contextManifest)
      db.prepare(`INSERT INTO context_manifests (project_id, task_id, attempt, phase_id, inputs, omitted, compacted, skills, procedures, generated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id, task_id, attempt, phase_id) DO UPDATE SET inputs=excluded.inputs, generated_at=excluded.generated_at`)
        .run(projectId, Number(taskId), Number(attempt), phaseId, j(contextManifest.inputs), j(contextManifest.omitted),
          j(contextManifest.compacted), j(contextManifest.skills), j(contextManifest.procedures), contextManifest.generated_at ?? now());
  });
}

export function upsertUsage(db, projectId, { taskId, attempt, phaseId, roleId = null, workflowId = null, phaseOutcome = null, usage }) {
  tx(db, () => {
    db.prepare(`INSERT INTO usage_records (project_id, task_id, attempt, phase_id, role_id, workflow_id,
      usage_status, cost_status, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      duration_ms, process_duration_ms, output_bytes, prompt_characters, phase_outcome, unknown_reason, recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id, task_id, attempt, phase_id) DO UPDATE SET
      usage_status=excluded.usage_status, cost_status=excluded.cost_status, phase_outcome=excluded.phase_outcome, recorded_at=excluded.recorded_at`)
      .run(projectId, Number(taskId), Number(attempt), phaseId, roleId, workflowId,
        usage.usage_status, usage.cost_status, usage.provider, usage.model,
        usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens,
        usage.duration_ms ?? 0, usage.process_duration_ms, usage.output_bytes ?? 0,
        usage.characters?.prompt ?? null, phaseOutcome, clamp(usage.unknown_reason, 400), now());
    db.prepare(`INSERT INTO cost_records (project_id, task_id, attempt, phase_id, cost_status,
      estimated_cost_usd, reported_cost_usd, pricing_table_version, recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id, task_id, attempt, phase_id) DO UPDATE SET
      cost_status=excluded.cost_status, recorded_at=excluded.recorded_at`)
      .run(projectId, Number(taskId), Number(attempt), phaseId, usage.cost_status,
        usage.estimated_cost_usd, usage.reported_cost_usd, usage.pricing_table_version, now());
  });
}

export function upsertVerificationProcess(db, projectId, { taskId, attempt, result }) {
  tx(db, () => db.prepare(`INSERT INTO verification_processes (project_id, task_id, attempt, check_id,
    executable, args, outcome, exit_code, timed_out, duration_ms, timeout_ms, timeout_decided_by,
    cleanup_method, cleanup_ok, output_bytes, evidence_hash, recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id, task_id, attempt, check_id) DO UPDATE SET
    outcome=excluded.outcome, exit_code=excluded.exit_code, recorded_at=excluded.recorded_at`)
    .run(projectId, Number(taskId), Number(attempt), result.id ?? "(unnamed)",
      result.executable ?? null, j(result.args), result.result ?? result.outcome ?? null, result.exit_code ?? null,
      result.timed_out ? 1 : 0, result.duration_ms ?? null, result.timeout_ms ?? null, result.timeout_decided_by ?? null,
      result.cleanup?.method ?? null, result.cleanup ? (result.cleanup.ok ? 1 : 0) : null,
      result.output_bytes ?? null, result.evidence_hash ?? null, now()));
}

export function upsertExternalSkills(db, proj) {
  tx(db, () => {
    const s = db.prepare(`INSERT INTO external_skill_sources (source_id, repository, pinned_commit, synced_commit,
      license, license_status, enabled, auto_update, source_hash, synced_at, recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET
      pinned_commit=excluded.pinned_commit, synced_commit=excluded.synced_commit, enabled=excluded.enabled, recorded_at=excluded.recorded_at`);
    for (const x of proj.sources)
      s.run(x.id, clamp(x.repository, 500), x.pinned_commit, x.synced_commit, x.license, x.license_status,
        x.enabled ? 1 : 0, x.auto_update ? 1 : 0, x.source_hash, x.synced_at, now());
    const k = db.prepare(`INSERT INTO external_skills (source_id, skill_id, path, content_hash, source_commit,
      trust, risk_level, quality, capabilities, scripts, hooks, executables, network_references,
      git_capabilities, changed_since_review, reviewed_at, recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id, skill_id) DO UPDATE SET
      trust=excluded.trust, content_hash=excluded.content_hash, risk_level=excluded.risk_level, recorded_at=excluded.recorded_at`);
    for (const x of proj.skills)
      k.run(x.source_id, x.skill_id, clamp(x.path, 400), x.content_hash, x.source_commit, x.trust,
        x.risk_level, x.quality, j(x.capabilities), x.scripts ?? 0, x.hooks ?? 0, 0, 0,
        j(x.git_capabilities ?? []), x.changed_since_review ? 1 : 0, null, now());
  });
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
