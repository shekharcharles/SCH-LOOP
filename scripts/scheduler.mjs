#!/usr/bin/env node
// SCH Loop — the sequential graph scheduler.
//
// WHY THIS EXISTS
// Everything before this was one task, one attempt, then stop. A person picked
// the task, a person delivered it, a person picked the next one. That is safe
// and it is also the entire bottleneck: the machinery to run a queue existed —
// supervised runner, effect inspection, deterministic verification, a
// fail-closed Git controller — and nothing joined it up.
//
// This joins it up, and the joining is CODE. The model does not choose what runs
// next, does not decide whether a phase passed, does not count its own retries
// and cannot authorise its own delivery. It does one bounded thing inside one
// named phase and hands back an envelope, which is then graded against evidence
// SCH gathered itself.
//
//     Code owns the graph.
//     Agents own bounded semantic phases.
//     Typed envelopes cross phase boundaries.
//     Named gates define acceptance.
//
// ONE TASK AT A TIME. No parallelism, no fan-out — the worktree a task gets is
// where its worker runs, not a second task running beside the first. Every task
// gets a fresh worker process, is verified independently, is committed and pushed by
// the existing delivery controller, and becomes DELIVERED only after that
// controller has proved the commit on the remote with its own fetch.

import { mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import * as WS from "./workspace.mjs";
import * as RUN from "./runner.mjs";
import * as DEL from "./delivery.mjs";
import * as CAND from "./candidate.mjs";
import * as GRAPH from "./taskgraph.mjs";
import * as PACK from "./pack.mjs";
import * as TR from "./transitions.mjs";
import * as PH from "./phases.mjs";
import * as ENV from "./envelopes.mjs";
import * as HG from "./humangates.mjs";
import * as PROJ from "./projection.mjs";
import * as WF from "./workflows.mjs";
import * as ROLES from "./roles.mjs";
import * as USAGE from "./usage.mjs";
import * as EV from "./evidence.mjs";
import * as SEM from "./semantic.mjs";
import * as WT from "./worktree.mjs";
import { loadState, mutateState, getProject, auditLog, event as stateEvent } from "./state.mjs";

export const SCHEMA_VERSION = 1;

// ------------------------------------------------------------- stop reasons

// Why a scheduler stopped, as a closed set. "It finished" and "it gave up" and
// "it is waiting for you" are three different things and an operator must never
// have to infer which one happened from a log tail.
export const STOP_REASONS = [
  "PROJECT_COMPLETED", "PHASE_COMPLETED", "NO_READY_TASK", "NEEDS_DECISION",
  "BLOCKED", "FAILED", "CANCELLED", "MAX_TASKS_REACHED", "MAX_DURATION_REACHED",
  "PROJECT_BUDGET_EXCEEDED", "CONSECUTIVE_FAILURE_LIMIT", "SCHEDULER_LEASE_LOST",
  "POLICY_VIOLATION", "STOP_AFTER_TASK", "DRY_RUN",
];

// "No ready task" is four different situations and only one of them is good.
export const NO_READY_KINDS = ["PROJECT_COMPLETE", "GRAPH_DEADLOCK", "BLOCKED_DEPENDENCIES", "AWAITING_APPROVAL", "INVALID_GRAPH"];

// ------------------------------------------------------------ failure classes

// Retryable means: run the same thing again and it might work. Non-retryable
// means: the world has to change first, and re-running is at best a waste of a
// worker and at worst a second violation.
export const RETRYABLE_FAILURES = new Set([
  "AGENT_TIMEOUT", "PROCESS_TRANSIENT", "AGENT_PROCESS_FAILURE", "AGENT_PROTOCOL_ERROR",
  "VERIFICATION_FAILURE", "VERIFICATION_TIMEOUT", "FORMAT_FAILURE", "LINT_FAILURE",
]);
export const NON_RETRYABLE_FAILURES = new Set([
  "PATH_SCOPE_VIOLATION", "UNEXPECTED_FILE_CHANGE", "SECRET_DETECTED", "FORBIDDEN_GIT_EFFECT",
  "VERIFIED_DIFF_CHANGED", "UNRELATED_OUTGOING_COMMITS", "REMOTE_CHANGED", "INCOMING_COMMITS_PRESENT",
  "POLICY_VIOLATION", "SCHEMA_DECISION_REQUIRED", "DEPENDENCY_CHANGE_REQUIRED",
  "PUBLIC_API_BREAK_REQUIRES_APPROVAL", "TASK_INELIGIBLE", "WORKSPACE_INVALID",
  "PATH_POLICY_MISSING", "SKILL_NOT_APPROVED", "SKILL_HASH_STALE", "AMBIGUOUS_EVIDENCE",
  "ENVIRONMENT_MISSING", "UNSAFE_VERIFICATION_COMMAND", "BUDGET_EXCEEDED", "GATE_FAILED",
]);

// A VERIFICATION_FAILURE is retryable only while the task's repair budget lasts —
// "the tests fail" is worth one more shot, not five.
export function classifyFailure(code, { task = null, attempt = 1, repairsUsed = 0 } = {}) {
  const policy = task?.retryPolicy ?? {};
  const allowed = Array.isArray(policy.retryable_failures) ? new Set(policy.retryable_failures) : null;
  const maxRepairs = Number(policy.max_repairs_per_attempt ?? 1);

  if (!code) return { class: "NONE", retryable: false, why: "no failure" };
  if (NON_RETRYABLE_FAILURES.has(code) && !(allowed?.has(code)))
    return { class: "NON_RETRYABLE", retryable: false, why: `${code} is resolved by changing the world, not by trying again` };
  if (allowed && !allowed.has(code))
    return { class: "NON_RETRYABLE", retryable: false, why: `${code} is not in this task's retryable_failures policy` };
  if (!RETRYABLE_FAILURES.has(code) && !(allowed?.has(code)))
    return { class: "UNCLASSIFIED", retryable: false, why: `${code} has no retry classification — failing closed` };
  if ((code === "VERIFICATION_FAILURE" || code === "LINT_FAILURE" || code === "FORMAT_FAILURE") && repairsUsed >= maxRepairs)
    return { class: "REPAIR_BUDGET_EXHAUSTED", retryable: false, why: `${repairsUsed}/${maxRepairs} repair attempts already used for this task` };
  return { class: "RETRYABLE", retryable: true, why: `${code} may succeed on a fresh attempt` };
}

// ------------------------------------------------------------------ events

export const SCHEDULER_EVENTS = [
  "scheduler.created", "scheduler.started", "scheduler.graph_validated", "scheduler.task_ready",
  "scheduler.task_claimed", "scheduler.task_started", "scheduler.phase_started",
  "scheduler.phase_executed", "scheduler.envelope_accepted", "scheduler.gate_started",
  "scheduler.gate_passed", "scheduler.gate_failed", "scheduler.retry_scheduled",
  "scheduler.human_gate_created", "scheduler.task_awaiting_delivery", "scheduler.task_delivered",
  "scheduler.task_failed", "scheduler.task_blocked", "scheduler.project_completed",
  "scheduler.stopped", "scheduler.cancelled", "scheduler.lease_acquired", "scheduler.lease_released",
  "scheduler.worktree_created", "scheduler.worktree_removed",
  "scheduler.dependencies_merged",
  "scheduler.pack_removed",
];

const now = () => new Date().toISOString();
const clamp = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));
export const newSchedulerId = () => "SCHED-" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + randomBytes(3).toString("hex").toUpperCase();

// --------------------------------------------------------------- directories

export const schedulerRoot = (wsDir) => join(wsDir, "scheduler");
export const schedulerDir = (wsDir, id) => join(schedulerRoot(wsDir), "runs", id);
// ATTEMPTS BELONG TO THE TASK, NOT TO THE SCHEDULER THAT STARTED THEM.
// Filing them under the scheduler id meant a restarted scheduler could not see
// the attempt it was resuming, so "recover from where you were" degraded into
// "start again" — and starting again means running a worker a second time over
// a change that is already in the tree.
export const taskDir = (wsDir, taskId) => join(schedulerRoot(wsDir), "tasks", String(taskId));
export const attemptDir = (wsDir, taskId, attempt) => join(taskDir(wsDir, taskId), `attempt-${attempt}`);

const attemptNumbers = (wsDir, taskId) => {
  const d = taskDir(wsDir, taskId);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((x) => /^attempt-\d+$/.test(x)).map((x) => Number(x.slice(8))).sort((a, b) => a - b);
};

// Which attempt directory this task should use now. An attempt whose workflow
// stopped somewhere RESUMABLE — waiting on a person, or interrupted mid-flight —
// is continued in place; anything else starts a fresh attempt.
export function openAttempt(wsDir, taskId) {
  const nums = attemptNumbers(wsDir, taskId);
  const last = nums[nums.length - 1];
  if (last !== undefined) {
    const dir = attemptDir(wsDir, taskId, last);
    const rp = PH.recoveryPoint(dir, TASK_WORKFLOW);
    const resumable = !rp.completed && (rp.stopped === null || rp.stopped.state === "NEEDS_DECISION");
    if (resumable) return { attempt: last, dir, resume: true, recovery: rp };
  }
  const attempt = (last ?? 0) + 1;
  return { attempt, dir: attemptDir(wsDir, taskId, attempt), resume: false, recovery: null };
}

// ------------------------------------------------------------------- lease

export const schedulerLeasePath = (wsDir) => join(WS.locksDir(wsDir), "scheduler.json");
const LEASE_TTL_MS = 30 * 60 * 1000;
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// One scheduler per project. Never steals a live lease; a stale one (expired, or
// its owner is gone) is recovered and the recovery is recorded rather than
// silently overwritten — "the previous scheduler vanished" is information.
export function acquireSchedulerLease(wsDir, { projectId, schedulerId, ttlMs = LEASE_TTL_MS }) {
  mkdirSync(WS.locksDir(wsDir), { recursive: true });
  const p = schedulerLeasePath(wsDir);
  let recovered = null;
  if (existsSync(p)) {
    let held = null;
    try { held = JSON.parse(readFileSync(p, "utf8")); } catch { held = null; }
    const expired = !held?.expires_at || new Date(held.expires_at).getTime() < Date.now();
    const ownerGone = !held?.pid || !pidAlive(Number(held.pid));
    if (!expired && !ownerGone)
      return { ok: false, failure: { code: "SCHEDULER_LEASE_CONFLICT", message: `project ${projectId} already has scheduler ${held.scheduler_id} running (pid ${held.pid}, expires ${held.expires_at})` }, held };
    try { unlinkSync(p); } catch {}
    recovered = held;
  }
  const lease = { schema_version: SCHEMA_VERSION, project_id: projectId, scheduler_id: schedulerId,
    pid: process.pid, acquired_at: now(), expires_at: new Date(Date.now() + ttlMs).toISOString() };
  WS.writeAtomic(p, JSON.stringify(lease, null, 2));
  return { ok: true, lease, recovered };
}

export function releaseSchedulerLease(wsDir, schedulerId) {
  const p = schedulerLeasePath(wsDir);
  try {
    const held = JSON.parse(readFileSync(p, "utf8"));
    if (held.scheduler_id !== schedulerId) return { released: false, reason: "SCHEDULER_LEASE_LOST" };
  } catch { return { released: false, reason: "already gone" }; }
  try { unlinkSync(p); return { released: true }; } catch (e) { return { released: false, reason: e.message }; }
}

export function liveSchedulerLease(wsDir) {
  const p = schedulerLeasePath(wsDir);
  if (!existsSync(p)) return null;
  let held = null;
  try { held = JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
  const expired = !held?.expires_at || new Date(held.expires_at).getTime() < Date.now();
  if (expired || !pidAlive(Number(held.pid))) return null;
  return held;
}

// -------------------------------------------------------------- the workflow

// The sequential task workflow. Each entry is a PHASE — what kind it is, what
// envelope it must produce, and which named gates decide whether the graph may
// move past it. Nothing here re-implements the runner or the delivery
// controller; the CODE phases call them and then read what they wrote.
export const TASK_WORKFLOW = [
  { id: "prepare", kind: "CODE", output_schema: "CodeResultEnvelopeV1", gates: [] },
  { id: "task-readiness", kind: "GATE", output_schema: "GateReportEnvelopeV1",
    gates: ["project-workspace-valid", "dependency-graph-valid", "task-ready"] },
  { id: "compile-context", kind: "CODE", output_schema: "CodeResultEnvelopeV1", gates: [] },
  // The AGENT phase IS the existing supervised runner: fresh external process,
  // one task, one attempt. It parses its own worker handoff and writes it to the
  // run directory; the next phase re-reads that file as a typed envelope rather
  // than parsing the same stdout twice.
  { id: "implement", kind: "AGENT", role: "builder", output_schema: null,
    gates: ["skills-approved", "executor-ready"] },
  { id: "parse-builder-envelope", kind: "CODE", output_schema: "BuilderEnvelopeV1", gates: ["handoff-valid"] },
  { id: "inspect-effects", kind: "CODE", output_schema: "CodeResultEnvelopeV1", gates: [] },
  { id: "effects-gate", kind: "GATE", output_schema: "GateReportEnvelopeV1",
    gates: ["worker-effects-contained", "changed-paths-allowed", "forbidden-git-effects-absent"] },
  { id: "verify", kind: "CODE", output_schema: "CodeResultEnvelopeV1", gates: [] },
  { id: "verification-gate", kind: "GATE", output_schema: "GateReportEnvelopeV1",
    gates: ["required-verification-passed", "prompt-budget-valid", "secret-scan-passed"] },
  { id: "semantic-review", kind: "AGENT", role: "reviewer", output_schema: null, gates: [] },
  { id: "review-gate", kind: "GATE", output_schema: "GateReportEnvelopeV1", gates: [] },
  { id: "prepare-delivery", kind: "CODE", output_schema: "CodeResultEnvelopeV1", gates: ["verified-diff-unchanged"] },
  { id: "delivery-approval", kind: "HUMAN", output_schema: null, gates: ["delivery-approval-valid"] },
  { id: "deliver", kind: "CODE", output_schema: "DeliveryEnvelopeV1", gates: [] },
  { id: "remote-verification", kind: "GATE", output_schema: "GateReportEnvelopeV1",
    gates: ["outgoing-commit-safe", "remote-commit-present"] },
  { id: "complete-task", kind: "CODE", output_schema: "CodeResultEnvelopeV1", gates: ["task-completion-valid"] },
];

// --------------------------------------------------------------- budgets

export const DEFAULT_BUDGETS = {
  max_tasks_per_scheduler_run: 10,
  max_scheduler_duration_ms: 4 * 60 * 60 * 1000,
  max_consecutive_failures: 3,
  max_total_attempts: 30,
  max_prompt_characters_per_attempt: 60000,
  max_output_bytes_per_attempt: 1024 * 1024,
};

export const budgetsFor = (project) => ({ ...DEFAULT_BUDGETS, ...(project?.schedulerBudgets ?? {}) });

// ------------------------------------------------------------- repair context

// WHAT A SECOND ATTEMPT IS ALLOWED TO SEE.
//
// Not the transcript. Not every previous run. Not the whole learning file. A
// repair needs the task, its acceptance criteria, its path policy, what failed
// and the evidence of the failure — and every character beyond that is money
// spent to make the worker's job harder.
export function repairContext({ task, previousAttempt, gateReports = [], verification = null, effects = null, maxChars = 6000 }) {
  const parts = [];
  const add = (name, text) => { if (text && text.trim()) parts.push({ name, text: text.trim() }); };

  add("previous-attempt", previousAttempt
    ? `Attempt ${previousAttempt.attempt} ended ${previousAttempt.outcome}${previousAttempt.failure ? ` (${previousAttempt.failure.code})` : ""}: ${clamp(previousAttempt.failure?.message ?? previousAttempt.summary ?? "", 800)}`
    : "");

  const failed = gateReports.filter((r) => r.outcome === "FAIL");
  add("failed-gates", failed.map((r) =>
    `${r.gate_id} FAILED:\n` + r.checks.filter((c) => !c.passed).map((c) => `  - ${c.item}: ${c.evidence}`).join("\n")
  ).join("\n\n"));

  if (verification && !verification.all_passed)
    add("command-output", (verification.results ?? []).filter((r) => r.result !== "PASSED").map((r) =>
      `${r.display} -> ${r.result} (exit ${r.exit_code})\n${clamp((r.stderr || r.stdout || "").trim(), 1200)}`
    ).join("\n\n"));

  if (effects)
    add("current-diff", `Paths currently changed in the working tree (${(effects.paths ?? []).length}): ` +
      (effects.paths ?? []).map((p) => `${p.path} (${p.kind})`).join(", ") +
      ((effects.rejected_paths ?? []).length ? `\nOUT OF POLICY: ${effects.rejected_paths.map((r) => `${r.path} — ${r.why}`).join("; ")}` : ""));

  // The budget is enforced by dropping WHOLE sections from the least
  // load-bearing end, not by truncating mid-sentence: half a stack trace is
  // worse than no stack trace, because it reads like a complete one.
  const order = ["current-diff", "command-output", "failed-gates", "previous-attempt"];
  const omitted = [];
  const size = () => parts.reduce((n, p) => n + p.name.length + p.text.length + 4, 0);
  while (size() > maxChars && parts.length > 1) {
    const drop = order.find((n) => parts.some((p) => p.name === n && parts.length > 1));
    const i = parts.findIndex((p) => p.name === drop);
    if (i === -1) break;
    omitted.push({ name: parts[i].name, characters: parts[i].text.length, reason: "dropped to fit the repair-context budget" });
    parts.splice(i, 1);
  }

  const text = parts.map((p) => `## ${p.name}\n${p.text}`).join("\n\n");
  return {
    text: clamp(text, maxChars),
    manifest: {
      unit: "characters", note: "character counts, not tokens — no tokenizer is used",
      limit_characters: maxChars, total_characters: Math.min(text.length, maxChars),
      sections: parts.map((p) => ({ name: p.name, characters: p.text.length, included: true })),
      omitted,
    },
  };
}

// ------------------------------------------------------- project completion

// A project is complete when the graph says so, not when the scheduler runs out
// of things it feels like doing. Every clause is checked and reported, so
// "not complete" always comes with the reason.
export function evaluateCompletion(projectId, { state = null, wsDir = null } = {}) {
  const s = state ?? loadState(projectId);
  const cs = TR.canonicalState;
  const reasons = [];
  const required = (s.tasks ?? []).filter((t) => !["CANCELLED", "SUPERSEDED"].includes(cs(t)));
  const undelivered = required.filter((t) => !GRAPH.dependencySatisfied(t, cs(t)));
  reasons.push({ item: "every required task is DELIVERED, CANCELLED or SUPERSEDED", passed: undelivered.length === 0,
    evidence: undelivered.length ? `${undelivered.length} outstanding: ${undelivered.slice(0, 10).map((t) => `#${t.id} (${cs(t)})`).join(", ")}` : `${required.length} required task(s) all accounted for` });

  const openGates = HG.pending(projectId, { state: s });
  reasons.push({ item: "no unresolved human gate", passed: openGates.length === 0,
    evidence: openGates.length ? openGates.map((g) => `${g.id} ${g.gate_type}`).join(", ") : "none pending" });

  const blocked = required.filter((t) => ["BLOCKED", "FAILED", "NEEDS_DECISION"].includes(cs(t)));
  reasons.push({ item: "no blocked or failed required task", passed: blocked.length === 0,
    evidence: blocked.length ? blocked.map((t) => `#${t.id} ${cs(t)}`).join(", ") : "none" });

  const activeTasks = required.filter((t) => TR.ACTIVE.has(cs(t)));
  const lease = wsDir ? liveSchedulerLease(wsDir) : null;
  const repoLease = wsDir ? DEL.liveRepoLease(wsDir) : null;
  reasons.push({ item: "no active run, delivery or scheduler lease", passed: activeTasks.length === 0 && !repoLease,
    evidence: [activeTasks.length ? `${activeTasks.length} task(s) still active` : null,
      repoLease ? `repository lease held by delivery ${repoLease.delivery_id}` : null,
      lease ? `(scheduler ${lease.scheduler_id} is the one asking)` : null].filter(Boolean).join("; ") || "nothing in flight" });

  const validation = GRAPH.validateGraph(projectId, { state: s, canonicalState: cs });
  reasons.push({ item: "graph validation passes", passed: validation.ok,
    evidence: validation.ok ? `${validation.tasks} task(s), ${validation.edges} edge(s)` : validation.problems.map((p) => p.code).join(", ") });

  return { schema_version: SCHEMA_VERSION, project_id: projectId, complete: reasons.every((r) => r.passed), reasons, evaluated_at: now() };
}

// ------------------------------------------------------------ the scheduler

// One project, one scheduler, one task at a time, until a defined stop.
export async function runQueue({
  projectId, maxTasks = null, maxDurationMs = null, phase = null, stopAfterTask = null,
  dryRun = false, env = process.env, executor = null, onEvent = null, schedulerId = null,
}) {
  const started = Date.now();
  const id = schedulerId ?? newSchedulerId();
  const project = getProject(projectId);
  if (!project) return { ok: false, scheduler_id: id, stop_reason: "POLICY_VIOLATION", failure: { code: "TASK_INELIGIBLE", message: `no registered project "${projectId}"` }, tasks: [] };

  let wsDir, repoRoot;
  try {
    const ws = WS.validateWorkspace({ projectId, repoPath: project.path });
    if (ws.problems.length)
      return { ok: false, scheduler_id: id, stop_reason: "POLICY_VIOLATION", failure: { code: ws.problems[0].code, message: ws.problems[0].message }, tasks: [] };
    wsDir = ws.dir; repoRoot = ws.root;
  } catch (e) {
    return { ok: false, scheduler_id: id, stop_reason: "POLICY_VIOLATION", failure: { code: "WORKSPACE_INVALID", message: e.message }, tasks: [] };
  }

  const budgets = budgetsFor(project);
  const limitTasks = maxTasks === null ? budgets.max_tasks_per_scheduler_run : Number(maxTasks);
  const limitMs = maxDurationMs === null ? budgets.max_scheduler_duration_ms : Number(maxDurationMs);

  const dir = schedulerDir(wsDir, id);
  mkdirSync(dir, { recursive: true });

  let db = null;
  try { db = PROJ.open(projectId); } catch { db = null; }

  // Events: append-only, one JSONL line each, bounded payloads. Worker output is
  // never in here — it is referenced by run directory and stays on disk.
  const eventsFile = join(dir, "events.jsonl");
  let lastEventId = null;
  // A payload that would not fit is REPLACED by a note saying so, never
  // truncated into invalid JSON that the projection then silently drops.
  const boundPayload = (p) => {
    const s = JSON.stringify(p ?? {});
    return s.length <= 4000 ? (p ?? {}) : { truncated: true, characters: s.length, note: "payload exceeded the 4000-character event limit and is on disk in the run/attempt directory" };
  };
  const emit = (type, payload = {}, { taskId = null, attempt = null, phaseId = null, actor = "scheduler" } = {}) => {
    const rec = {
      schema_version: SCHEMA_VERSION, event_id: "SEV-" + randomBytes(6).toString("hex"),
      timestamp: now(), project_id: projectId, scheduler_id: id,
      task_id: taskId, attempt, phase_id: phaseId, actor,
      causation: lastEventId, correlation: id, type,
      payload: boundPayload(payload),
    };
    lastEventId = rec.event_id;
    try { appendFileSync(eventsFile, JSON.stringify(rec) + "\n"); } catch {}
    try { if (db) PROJ.projectEvent(db, rec); } catch {}
    if (onEvent) { try { onEvent(rec); } catch {} }
    return rec;
  };

  const project_ = { project_id: projectId, name: project.name, domain: project.domain, execution_mode: project.executionMode ?? null };
  try { if (db) PROJ.upsertProject(db, project_); } catch {}

  const record = {
    schema_version: SCHEMA_VERSION, scheduler_id: id, project_id: projectId,
    state: "RUNNING", stop_reason: null, failure: null, pid: process.pid,
    max_tasks: limitTasks, max_duration_ms: limitMs, phase_filter: phase,
    stop_after_task: stopAfterTask, dry_run: dryRun,
    tasks: [], tasks_delivered: 0, consecutive_failures: 0, total_attempts: 0,
    started_at: now(), ended_at: null, duration_ms: 0,
    current_task: null, current_phase: null, current_attempt: null,
  };
  const save = () => { try { WS.writeAtomic(join(dir, "scheduler.json"), JSON.stringify(record, null, 2)); } catch {}
    try { if (db) PROJ.upsertScheduler(db, record); } catch {} };
  save();
  emit("scheduler.created", { max_tasks: limitTasks, max_duration_ms: limitMs, dry_run: dryRun });
  auditLog({ kind: "scheduler", project: projectId, scheduler: id, event: "created" });

  // ---- lease
  const lease = acquireSchedulerLease(wsDir, { projectId, schedulerId: id });
  if (!lease.ok) {
    record.state = "STOPPED"; record.stop_reason = "SCHEDULER_LEASE_LOST"; record.failure = lease.failure;
    record.ended_at = now(); record.duration_ms = Date.now() - started; save();
    emit("scheduler.stopped", { stop_reason: record.stop_reason, failure: lease.failure.code });
    try { db?.close(); } catch {}
    return { ok: false, ...summary(record) };
  }
  emit("scheduler.lease_acquired", { expires_at: lease.lease.expires_at, recovered_stale: lease.recovered?.scheduler_id ?? null });
  if (lease.recovered) emit("scheduler.started", { recovered_from: lease.recovered.scheduler_id, note: "a previous scheduler's lease was stale and has been recovered" });
  else emit("scheduler.started", {});

  const finish = (reason, failure = null) => {
    record.state = "STOPPED"; record.stop_reason = reason; record.failure = failure;
    record.current_task = null; record.current_phase = null; record.current_attempt = null;
    record.ended_at = now(); record.duration_ms = Date.now() - started;
    save();
    emit("scheduler.stopped", { stop_reason: reason, failure: failure?.code ?? null, tasks_delivered: record.tasks_delivered });
    const rel = releaseSchedulerLease(wsDir, id);
    emit("scheduler.lease_released", rel);
    auditLog({ kind: "scheduler", project: projectId, scheduler: id, event: "stopped", stop_reason: reason });
    // Refresh the projection ON THE WAY OUT. It is written at the top of each
    // loop, so a scheduler that stops right after delivering a task would
    // otherwise leave the dashboard showing that task as still ready.
    try { if (db) PROJ.upsertGraph(db, projectId, GRAPH.projectGraph(projectId, { canonicalState: TR.canonicalState })); } catch {}
    try { if (db) PROJ.upsertHumanGates(db, projectId, HG.list(projectId)); } catch {}
    try { if (db) PROJ.upsertCompletion(db, projectId, evaluateCompletion(projectId, { wsDir })); } catch {}
    try { db?.close(); } catch {}
    return { ok: ["PROJECT_COMPLETED", "PHASE_COMPLETED", "MAX_TASKS_REACHED", "STOP_AFTER_TASK", "DRY_RUN"].includes(reason), ...summary(record) };
  };

  try {
    for (;;) {
      // ---- budget checks BEFORE selecting anything: a scheduler that starts a
      // task it has no time to finish leaves a worker's change in the tree.
      if (Date.now() - started > limitMs) return finish("MAX_DURATION_REACHED");
      if (record.tasks_delivered >= limitTasks) return finish("MAX_TASKS_REACHED");
      if (record.consecutive_failures >= budgets.max_consecutive_failures) return finish("CONSECUTIVE_FAILURE_LIMIT");
      if (record.total_attempts >= budgets.max_total_attempts) return finish("PROJECT_BUDGET_EXCEEDED");
      if (!liveSchedulerLease(wsDir) || liveSchedulerLease(wsDir)?.scheduler_id !== id) return finish("SCHEDULER_LEASE_LOST");

      // ---- validate the graph, every pass. It is cheap, and a queue edited by
      // a person between two tasks is the normal case, not the exotic one.
      const state = loadState(projectId);
      const validation = GRAPH.validateGraph(projectId, { state, canonicalState: TR.canonicalState });
      emit("scheduler.graph_validated", { ok: validation.ok, problems: validation.problems.map((p) => p.code), warnings: validation.warnings.map((w) => w.code) });
      try { if (db) PROJ.upsertGraph(db, projectId, GRAPH.projectGraph(projectId, { canonicalState: TR.canonicalState, state })); } catch {}
      if (!validation.ok)
        return finish("POLICY_VIOLATION", { code: "GRAPH_INVALID", message: validation.problems.map((p) => `${p.code}: ${p.message}`).join(" | ") });

      // ---- a pending human gate stops the queue. It does not skip the task and
      // move on: the operator asked to be asked, and running past them is how a
      // scheduler makes a decision it was explicitly told not to make.
      const open = HG.pending(projectId, { state });
      if (open.length) {
        emit("scheduler.task_blocked", { human_gates: open.map((g) => ({ id: g.id, type: g.gate_type, task: g.task_id })) });
        return finish("NEEDS_DECISION", { code: "HUMAN_GATE_PENDING", message: `${open.length} human gate(s) awaiting a decision: ${open.map((g) => `${g.id} (${g.gate_type})`).join(", ")}` });
      }

      // ---- an ANSWERED gate puts its task back in the queue. The operator
      // answering on the dashboard is the whole resume mechanism: they never
      // have to also remember to move the task by hand.
      for (const g of HG.list(projectId, { state })) {
        if (g.task_id === null || !["APPROVED", "REJECTED"].includes(g.status)) continue;
        const t = (state.tasks ?? []).find((x) => x.id === Number(g.task_id));
        if (!t || TR.canonicalState(t) !== "NEEDS_DECISION") continue;
        const back = TR.transition(projectId, t.id, {
          to: g.status === "APPROVED" ? "READY" : "FAILED", actor: "human-gate",
          reason: `human gate ${g.id} ${g.status} by ${g.approver}`, causation: lastEventId,
        });
        if (back.ok) emit("scheduler.task_ready", { resumed_from: g.id, decision: g.status }, { taskId: t.id });
      }
      const refreshed = loadState(projectId);

      // ---- select exactly one
      const pick = GRAPH.selectReady(refreshed, { canonicalState: TR.canonicalState, phase });
      if (!pick.selected) {
        const why = diagnoseNoReady(refreshed, pick, validation);
        emit("scheduler.stopped", { no_ready_kind: why.kind, detail: why.detail });
        if (why.kind === "PROJECT_COMPLETE") {
          const completion = evaluateCompletion(projectId, { state: refreshed, wsDir });
          emit("scheduler.project_completed", { complete: completion.complete, reasons: completion.reasons.map((r) => ({ item: r.item, passed: r.passed })) });
          return finish(completion.complete ? "PROJECT_COMPLETED" : "NO_READY_TASK",
            completion.complete ? null : { code: "PROJECT_NOT_COMPLETE", message: completion.reasons.filter((r) => !r.passed).map((r) => `${r.item}: ${r.evidence}`).join(" | ") });
        }
        if (phase !== null && why.kind === "PHASE_COMPLETE") return finish("PHASE_COMPLETED");
        return finish("NO_READY_TASK", { code: why.kind, message: why.detail });
      }

      const task = pick.selected;
      emit("scheduler.task_ready", { title: clamp(task.title, 120), priority: task.priority, phase: task.phase }, { taskId: task.id });

      if (dryRun) {
        record.tasks.push({ task_id: task.id, title: task.title, outcome: "DRY_RUN", would_run: true });
        return finish("DRY_RUN");
      }

      // ---- claim it, against the version we just read. Another process that
      // moved this task between the read and the claim wins, and we go round again.
      // A task whose attempt is only PARKED (waiting on a person, or interrupted)
      // is re-claimed to continue that attempt, not to start a new one. The
      // difference matters: continuing skips the worker, restarting runs a second
      // one over a working tree that already holds the first one's change.
      const att = openAttempt(wsDir, task.id);
      const parked = att.resume;
      // Has this task ever run before? `resume` only answers "is the last attempt
      // still open"; an attempt that COMPLETED and failed leaves a record and a
      // checkout full of uncommitted work, and answers `false`. A first claim has
      // no attempt directory at all, so `attempt` is 1 and this stays false.
      const ranBefore = att.resume || att.attempt > 1;
      const claim = TR.transition(projectId, task.id, {
        to: "CLAIMED", actor: "scheduler", reason: `scheduler ${id} ${parked ? "re-claimed to continue its open attempt" : "claimed this task"}`,
        expectVersion: task.stateVersion ?? 0, causation: lastEventId,
      });
      if (!claim.ok) {
        emit("scheduler.task_blocked", { failure: claim.failure.code, message: clamp(claim.failure.message, 300) }, { taskId: task.id });
        if (claim.failure.code === "STATE_VERSION_CONFLICT") continue;   // someone else moved it; re-select
        return finish("POLICY_VIOLATION", claim.failure);
      }
      emit("scheduler.task_claimed", { state_version: claim.state_version }, { taskId: task.id });

      // A worker never runs in the operator's working tree. One worktree per
      // TASK — every attempt reuses it, so a retry inherits the previous
      // attempt's uncommitted work exactly as it did before.
      //
      // Three ways a task can fail to get a contained place to run. Every one of
      // them is a question for a person: there is no second-best directory to
      // run the worker in, and running it somewhere else is the whole thing this
      // refuses to do.
      const noWorktree = (code, message) => {
        emit("scheduler.task_blocked", { failure: code, message: clamp(message, 300) }, { taskId: task.id });
        TR.transition(projectId, task.id, { to: "NEEDS_DECISION", actor: "scheduler", reason: clamp(message, 400) });
        return finish("NEEDS_DECISION", { code, message });
      };

      // ANY earlier attempt left its change in that checkout, uncommitted. If the
      // checkout is gone — a reboot, a temp reaper, someone tidying scratch space
      // — `ensureWorktree` would find the branch and check it out AT ITS LAST
      // COMMIT, and every phase downstream would then grade a change that no
      // longer exists and report the work as absent rather than lost.
      //
      // Not just PARKED attempts: an attempt that ran to a failure is closed, so
      // `resume` is false, and before M6 that work sat in the main tree and
      // survived. Requeueing such a task with the checkout cleared in between is
      // the same silent loss, reached by a shorter path.
      if (ranBefore && !WT.worktreeState({ projectId, taskId: task.id, repoRoot }).exists)
        return noWorktree("WORKTREE_MISSING",
          `the worktree for task #${task.id} is gone but attempt ${att.resume ? att.attempt : att.attempt - 1} already ran in it — that attempt's uncommitted work cannot be reconstructed, and SCH will not fabricate a baseline by checking the branch out again`);

      const base = (WS.git(repoRoot, "rev-parse", "HEAD") ?? "").trim();
      if (!base)
        return noWorktree("WORKTREE_CREATE_FAILED",
          `${repoRoot} has no commit at HEAD — an unborn branch, or git could not be run there. A task worktree is branched from HEAD, so there is nothing to branch from.`);

      const wt = WT.ensureWorktree({ projectId, taskId: task.id, repoRoot, base });
      if (!wt.ok) return noWorktree(wt.code, wt.message);
      if (wt.created) emit("scheduler.worktree_created", { path: wt.path, branch: wt.branch, base }, { taskId: task.id });
      // Only on creation. A resumed worktree already carries its dependencies'
      // work, and merging again would add an empty merge on every retry.
      if (wt.created && (task.deps ?? []).length) {
        const fan = WT.mergeDependencies({ worktreePath: wt.path, repoRoot, deps: task.deps });
        if (!fan.ok) return noWorktree(fan.code, fan.message);
        if (fan.merged.length)
          emit("scheduler.dependencies_merged", { merged: fan.merged }, { taskId: task.id });
      }

      const outcome = await executeTask({
        projectId, taskId: task.id, wsDir, repoRoot, workRoot: wt.path, project, schedulerId: id, dir,
        env, executor, emit, db, budgets, record,
      });

      // The checkout is disposable; the BRANCH is the record and survives it. It
      // is kept on FAILED on purpose — a failed task's tree is the evidence
      // someone has to look at.
      if (outcome.state === "DELIVERED" || outcome.state === "CANCELLED") {
        const rm = WT.removeWorktree({ projectId, taskId: task.id, repoRoot });
        emit("scheduler.worktree_removed", { removed: rm.removed, path: rm.path ?? wt.path }, { taskId: task.id });
        // The pack is disposable in exactly the same way, and kept on FAILED
        // for the same reason the worktree is: it is part of what a person
        // examines to see what the worker was actually given.
        const rmp = PACK.removePack({ projectId, taskId: task.id });
        emit("scheduler.pack_removed", { removed: rmp.removed, path: rmp.path }, { taskId: task.id });
      }

      record.tasks.push(outcome);
      record.total_attempts += outcome.attempts;
      save();

      if (outcome.state === "DELIVERED") {
        record.tasks_delivered += 1; record.consecutive_failures = 0; save();
        emit("scheduler.task_delivered", { commit: outcome.commit, attempts: outcome.attempts }, { taskId: task.id });
        if (stopAfterTask !== null && Number(stopAfterTask) === Number(task.id)) return finish("STOP_AFTER_TASK");
        continue;                                    // and only now is the next task selectable
      }

      // A workflow that never intended to deliver finished successfully. It is
      // not a failure and it does not reset the queue — the task is parked at
      // AWAITING_DELIVERY and the scheduler moves on to the next ready task.
      if (["VERIFIED","COMPLETED","AWAITING_DELIVERY","READ_ONLY_COMPLETED","PLAN_COMPLETED"].includes(outcome.state)) {
        record.consecutive_failures = 0;
        record.tasks_completed_without_delivery = (record.tasks_completed_without_delivery ?? 0) + 1;
        save();
        if (stopAfterTask !== null && Number(stopAfterTask) === Number(task.id)) return finish("STOP_AFTER_TASK");
        continue;
      }

      record.consecutive_failures += 1; save();
      if (outcome.state === "NEEDS_DECISION") return finish("NEEDS_DECISION", outcome.failure);
      if (outcome.state === "BLOCKED") return finish("BLOCKED", outcome.failure);
      if (outcome.state === "CANCELLED") return finish("CANCELLED", outcome.failure);
      return finish("FAILED", outcome.failure);
    }
  } catch (e) {
    return finish("FAILED", { code: "POLICY_VIOLATION", message: `unexpected scheduler failure: ${e.message}` });
  }
}

const summary = (r) => ({
  scheduler_id: r.scheduler_id, project_id: r.project_id, state: r.state,
  stop_reason: r.stop_reason, failure: r.failure, tasks: r.tasks,
  tasks_delivered: r.tasks_delivered, total_attempts: r.total_attempts,
  started_at: r.started_at, ended_at: r.ended_at, duration_ms: r.duration_ms,
});

// "Nothing is ready" is not one situation. Telling them apart is the difference
// between "you are done" and "you have a deadlock nobody noticed".
export function diagnoseNoReady(state, pick, validation) {
  if (!validation.ok) return { kind: "INVALID_GRAPH", detail: validation.problems.map((p) => p.code).join(", ") };
  const cs = TR.canonicalState;
  const tasks = state.tasks ?? [];
  const outstanding = tasks.filter((t) => !GRAPH.dependencySatisfied(t, cs(t)) && !["CANCELLED", "SUPERSEDED"].includes(cs(t)));
  if (!outstanding.length) return { kind: "PROJECT_COMPLETE", detail: "every task is delivered, cancelled or superseded" };
  if (outstanding.every((t) => ["DELIVERED"].includes(cs(t)))) return { kind: "PHASE_COMPLETE", detail: "nothing left in the selected phase" };

  const awaiting = outstanding.filter((t) => cs(t) === "NEEDS_DECISION");
  if (awaiting.length && awaiting.length === outstanding.length)
    return { kind: "AWAITING_APPROVAL", detail: `${awaiting.length} task(s) waiting on a human decision: ${awaiting.map((t) => "#" + t.id).join(", ")}` };

  const blocked = outstanding.filter((t) => ["BLOCKED", "FAILED"].includes(cs(t)));
  const waiting = outstanding.filter((t) => ["READY", "BACKLOG", "RETRYABLE"].includes(cs(t)));
  // Everything left is waiting, and nothing it waits for can ever arrive.
  if (waiting.length && !waiting.some((t) => (t.deps ?? []).every((d) => {
    const dep = tasks.find((x) => x.id === Number(d));
    return dep && !["BLOCKED", "FAILED", "CANCELLED"].includes(cs(dep));
  })))
    return { kind: "GRAPH_DEADLOCK", detail: `${waiting.length} task(s) depend only on tasks that can never complete` };
  if (blocked.length)
    return { kind: "BLOCKED_DEPENDENCIES", detail: `${blocked.length} task(s) are blocked or failed: ${blocked.map((t) => "#" + t.id).join(", ")}` };
  const first = (pick.rows ?? []).find((r) => !r.r.ready);
  return { kind: "BLOCKED_DEPENDENCIES", detail: first ? `#${first.task.id}: ${first.r.blockers.map((b) => b.detail).join("; ")}` : "no task satisfies its dependencies" };
}

// The exact template a task ran under, written onto the task itself. Two
// reasons it lives here and not only in the attempt record: a historical task
// must stay readable after a template is revised, and an approval bound to a
// template version has to be invalidatable when that version moves.
function recordWorkflowOnTask(projectId, taskId, { workflowId, wf }) {
  try {
    mutateState(projectId, (s) => {
      const t = (s.tasks ?? []).find((x) => x.id === Number(taskId));
      if (!t) return;
      const prev = t.workflow_binding ?? null;
      // A template that CHANGED under an unfinished task invalidates any approval
      // that was given against the old one. Silently continuing on the new version
      // would mean the operator approved a workflow that no longer exists.
      const changed = prev && (prev.template_id !== wf.template_id || prev.template_version !== wf.template_version || prev.template_hash !== wf.template_hash);
      t.workflow_id = workflowId;
      t.workflow_binding = {
        workflow_id: workflowId, template_id: wf.template_id, template_version: wf.template_version,
        template_hash: wf.template_hash, selected_by: wf.selected_by, high_risk: wf.high_risk, bound_at: now(),
        previous: changed ? prev : (prev ?? null),
        invalidated_approvals: changed || undefined,
      };
      if (changed) {
        t.workflowApprovals = [];
        stateEvent(s, `task #${taskId} workflow changed ${prev.template_id}@${prev.template_version} → ${wf.template_id}@${wf.template_version}; template-bound approvals invalidated`);
      }
      t.updatedAt = now();
    });
  } catch { /* the attempt record carries the binding too */ }
}

// -------------------------------------------------------- one task, one graph

async function executeTask({ projectId, taskId, wsDir, repoRoot, workRoot, project, schedulerId, dir, env, executor, emit, db, budgets, record }) {
  const state0 = loadState(projectId);
  const task0 = (state0.tasks ?? []).find((t) => t.id === Number(taskId));
  const retryPolicy = task0?.retryPolicy ?? {};
  const maxAttempts = Math.max(1, Number(retryPolicy.max_attempts ?? task0?.budgets?.max_attempts ?? 3));
  const backoff = Array.isArray(retryPolicy.backoff_seconds) ? retryPolicy.backoff_seconds : [0, 0, 0];

  // WHICH WORKFLOW, decided once per task and recorded on it. Selection happens
  // BEFORE any phase runs, so an unknown template or an unsupported task type
  // stops the task instead of half-running it.
  const wf = WF.selectTemplate({ task: task0, project });
  if (!wf.ok) {
    emit("scheduler.task_failed", { failure: wf.failure.code, message: clamp(wf.failure.message, 300), selected_by: wf.selected_by }, { taskId });
    TR.transition(projectId, taskId, { to: "FAILED", actor: "scheduler", reason: clamp(`workflow selection: ${wf.failure.message}`, 400) });
    return { task_id: taskId, state: "FAILED", attempts: 0, failure: wf.failure, attempt_records: [] };
  }
  // WORKFLOW IDENTITY. Stable across restarts and retries: the attempt changes,
  // the workflow does not, which is what makes a resumed run the same run.
  const workflowId = task0?.workflow_id ?? ("WF-" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + randomBytes(4).toString("hex").toUpperCase());
  recordWorkflowOnTask(projectId, taskId, { workflowId, wf });
  emit("scheduler.task_started", { workflow_id: workflowId, template: wf.template_id, template_version: wf.template_version,
    selected_by: wf.selected_by, high_risk: wf.high_risk, phases: wf.template.phases.length }, { taskId });

  const attempts = [];
  let repairsUsed = 0;

  for (let round = 1; round <= maxAttempts; round++) {
    // The attempt NUMBER comes from what is on disk, not from this loop's
    // counter: a scheduler that restarted, or one resuming after an operator
    // answered a question, must continue the attempt that is already open.
    const open = openAttempt(wsDir, taskId);
    const attempt = open.attempt;
    if (attempt > maxAttempts && !open.resume)
      return { task_id: taskId, state: "FAILED", attempts: attempts.length,
        failure: { code: "BUDGET_EXCEEDED", message: `task #${taskId} has already used its ${maxAttempts} attempt(s)` }, attempt_records: attempts };
    record.current_task = taskId; record.current_attempt = attempt; record.current_phase = null;
    emit("scheduler.task_started", { attempt, max_attempts: maxAttempts, resumed: open.resume,
      resume_at: open.recovery?.resume_at ?? null }, { taskId, attempt });

    const aDir = open.dir;
    mkdirSync(aDir, { recursive: true });

    const result = await runAttempt({
      projectId, taskId, attempt, wsDir, repoRoot, workRoot, project, schedulerId, aDir,
      env, executor, emit, db, budgets, record, resume: open.resume,
      previousAttempt: attempts[attempts.length - 1] ?? lastAttemptRecord(wsDir, taskId, attempt), repairsUsed,
      workflowSelection: wf, workflowId,
    });
    attempts.push(result);
    try { if (db) PROJ.upsertAttempt(db, { project_id: projectId, task_id: taskId, attempt, scheduler_id: schedulerId,
      run_id: result.run_id, outcome: result.outcome, failure_code: result.failure?.code ?? null,
      failure_class: result.classification?.class ?? null, retryable: result.classification?.retryable,
      prompt_characters: result.prompt_characters ?? null, started_at: result.started_at, ended_at: result.ended_at, dir: aDir }); } catch {}

    if (result.outcome === "DELIVERED")
      return { task_id: taskId, state: "DELIVERED", attempts: attempts.length, commit: result.commit, run_id: result.run_id, failure: null, workflow: result.workflow ?? null, attempt_records: attempts };

    // A non-delivering template finished its work. The task is NOT delivered and
    // must not be treated as such — it stops at AWAITING_DELIVERY (or wherever
    // its workflow ended) and the operator decides what happens next.
    if (["VERIFIED","COMPLETED","AWAITING_DELIVERY","READ_ONLY_COMPLETED","PLAN_COMPLETED"].includes(result.outcome)) {
      // Park it honestly, and the two cases are genuinely different.
      //
      // A workflow that WROTE something is awaiting delivery: there is a change,
      // and a person or a later workflow decides whether it ships.
      //
      // A READ-ONLY workflow produced information and changed nothing. Calling
      // that "awaiting delivery" would imply a diff that does not exist, and
      // leaving it READY would make the scheduler pick it forever. It is a
      // decision point — the operator chooses what to do with the findings.
      const readOnly = ["READ_ONLY_COMPLETED", "PLAN_COMPLETED"].includes(result.outcome);
      const cur = TR.canonicalState(loadState(projectId).tasks.find((t) => t.id === Number(taskId)));
      if (readOnly) {
        TR.transition(projectId, taskId, { to: "NEEDS_DECISION", actor: "scheduler", runId: result.run_id, attempt,
          reason: `workflow ${result.workflow?.template_id ?? "(unknown)"} completed READ-ONLY: it produced findings and changed nothing. Choose the next workflow for this task.` });
      } else {
        if (cur === "RUNNING") TR.transition(projectId, taskId, { to: "VERIFYING", actor: "runner", reason: `workflow ${result.workflow?.template_id} completed`, runId: result.run_id, attempt });
        TR.transition(projectId, taskId, { to: "AWAITING_DELIVERY", actor: "verifier", runId: result.run_id, attempt,
          reason: `workflow ${result.workflow?.template_id ?? "(unknown)"} has no delivery phase — the change is verified, not pushed` });
      }
      emit("scheduler.task_awaiting_delivery", { workflow: result.workflow, outcome: result.outcome,
        note: "the selected workflow contains no delivery phase; nothing was pushed" }, { taskId, attempt });
      return { task_id: taskId, state: result.outcome, attempts: attempts.length, commit: null,
        run_id: result.run_id, failure: null, workflow: result.workflow ?? null, attempt_records: attempts };
    }

    const cls = result.classification ?? classifyFailure(result.failure?.code, { task: task0, attempt, repairsUsed });
    if (["VERIFICATION_FAILURE", "LINT_FAILURE", "FORMAT_FAILURE"].includes(result.failure?.code)) repairsUsed += 1;

    if (result.outcome === "NEEDS_DECISION" || result.outcome === "CANCELLED" || result.outcome === "BLOCKED") {
      const to = result.outcome === "CANCELLED" ? "CANCELLED" : result.outcome === "BLOCKED" ? "BLOCKED" : "NEEDS_DECISION";
      TR.transition(projectId, taskId, { to, actor: "scheduler", reason: clamp(result.failure?.message ?? to, 400), runId: result.run_id, attempt });
      emit(to === "CANCELLED" ? "scheduler.cancelled" : "scheduler.task_blocked", { failure: result.failure?.code ?? null }, { taskId, attempt });
      return { task_id: taskId, state: to, attempts: attempts.length, failure: result.failure, attempt_records: attempts };
    }

    if (!cls.retryable || attempt >= maxAttempts) {
      TR.transition(projectId, taskId, { to: "FAILED", actor: "scheduler",
        reason: clamp(`${result.failure?.code ?? "unknown"}: ${cls.why}`, 400), runId: result.run_id, attempt });
      emit("scheduler.task_failed", { failure: result.failure?.code ?? null, class: cls.class, why: clamp(cls.why, 200), attempts: attempts.length }, { taskId, attempt });
      return { task_id: taskId, state: "FAILED", attempts: attempts.length, failure: result.failure ?? { code: "GATE_FAILED", message: cls.why }, attempt_records: attempts };
    }

    // ---- a retry is a NEW attempt with a FRESH process. Nothing from the last
    // one is reused except the evidence of why it failed, and that evidence is
    // never overwritten: attempt-1's directory stays exactly as it was.
    const cur = TR.canonicalState((loadState(projectId).tasks ?? []).find((t) => t.id === Number(taskId)));
    if (cur !== "RETRYABLE")
      TR.transition(projectId, taskId, { to: "RETRYABLE", actor: "retry", reason: `attempt ${attempt} failed: ${result.failure?.code}`, runId: result.run_id, attempt });
    const back = TR.transition(projectId, taskId, { to: "READY", actor: "retry", reason: `retrying (attempt ${attempt + 1} of ${maxAttempts})`, attempt });
    if (!back.ok)
      return { task_id: taskId, state: "FAILED", attempts: attempts.length, failure: back.failure, attempt_records: attempts };
    const claim = TR.transition(projectId, taskId, { to: "CLAIMED", actor: "scheduler", reason: `scheduler ${schedulerId} re-claimed for attempt ${attempt + 1}` });
    if (!claim.ok)
      return { task_id: taskId, state: "FAILED", attempts: attempts.length, failure: claim.failure, attempt_records: attempts };

    emit("scheduler.retry_scheduled", { next_attempt: attempt + 1, class: cls.class, failure: result.failure?.code ?? null,
      backoff_seconds: backoff[Math.min(attempt, backoff.length - 1)] ?? 0 }, { taskId, attempt });
    const waitMs = (Number(backoff[Math.min(attempt, backoff.length - 1)]) || 0) * 1000;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, Math.min(waitMs, 120000)));
    if (attempt >= maxAttempts) break;
  }

  return { task_id: taskId, state: "FAILED", attempts: attempts.length,
    failure: { code: "BUDGET_EXCEEDED", message: `task #${taskId} exhausted its ${maxAttempts} attempt(s)` }, attempt_records: attempts };
}

// What the previous attempt on disk recorded, for a scheduler that did not run
// it. Bounded to the failure evidence a repair is allowed to see.
function lastAttemptRecord(wsDir, taskId, currentAttempt) {
  const prev = attemptNumbers(wsDir, taskId).filter((n) => n < currentAttempt).pop();
  if (prev === undefined) return null;
  const dir = attemptDir(wsDir, taskId, prev);
  const phases = PH.listPhases(dir);
  const stopped = phases.find((p) => PH.STOPS.has(p.state));
  const load = (f) => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; } };
  const meta = load("attempt.json");
  return {
    attempt: prev, outcome: stopped?.state ?? null, failure: stopped?.failure ?? null,
    gate_reports: phases.flatMap((p) => p.gate_reports ?? []),
    effects: meta?.effects ?? null, verification: meta?.verification ?? null,
  };
}

// ------------------------------------------------------------- one attempt

const SEM_REVIEW_REQUIRED = new Set(["BUILD_REVIEW", "SECURITY_REVIEW"]);

async function runAttempt({ projectId, taskId, attempt, wsDir, repoRoot, workRoot, project, schedulerId, aDir, env, executor, emit, db, budgets, record, previousAttempt, repairsUsed, resume = false, workflowSelection = null, workflowId = null }) {
  const startedAt = now();
  const ctx = { project_id: projectId, task_id: taskId, repo_root: repoRoot, work_root: workRoot, ws_dir: wsDir };

  // A LATER attempt whose checkout has gone is not a fresh start. Attempt 1's
  // change was carried forward in that tree, so recreating it would hand the
  // worker a baseline that was never true and call the missing work absent.
  // In-loop cover only — `runQueue` catches the case where the checkout vanished
  // between two scheduler runs, which is where `ensureWorktree` would rebuild it.
  // WORKTREE_MISSING is deliberately absent from both failure classes:
  // `executeTask` routes NEEDS_DECISION before `classifyFailure` is consulted, so
  // adding it would be dead data — but an edit to that branch would silently turn
  // this into UNCLASSIFIED, so classify it here if this ever stops short-circuiting.
  const wtNow = WT.worktreeState({ projectId, taskId, repoRoot });
  if (!wtNow.exists && attempt > 1)
    return { outcome: "NEEDS_DECISION", run_id: null, attempt, started_at: startedAt, ended_at: now(),
      failure: { code: "WORKTREE_MISSING",
        message: `the worktree for task ${taskId} is gone but attempt ${attempt} is in flight — the previous attempt's carried-forward work cannot be reconstructed, and SCH will not fabricate a baseline by recreating it` } };
  let runId = null, runRec = null, commit = null, planArtifact = null;

  // A RESUMED attempt does not run its worker again. The change it produced is
  // already in the working tree and its evidence is already on disk; re-running
  // would start a second process over a tree it has not seen, which is how a
  // repair turns into a collision. Everything downstream of `implement` is a
  // deterministic read of that evidence, so it simply runs again.
  const resumedImplement = resume ? PH.readPhase(aDir, "implement") : null;
  const resumedRunId = resumedImplement?.state === "ACCEPTED"
    ? (() => { try { return JSON.parse(readFileSync(join(aDir, "attempt.json"), "utf8")).run_id; } catch { return null; } })()
    : null;

  // The run that the CURRENT phase is executing. It is not always `runId`: a
  // read-only phase (a reviewer) has its own run, while `runId` stays bound to
  // the writing run the delivery pipeline will use. The phase engine validates
  // the envelope AFTER the work returns, so this is a getter — reading it at
  // call time would validate the reviewer's envelope against the builder's run
  // and reject it as an identity mismatch.
  let phaseRunId = null;
  const identity = () => ({
    project_id: projectId, task_id: String(taskId), attempt,
    get run_id() { return phaseRunId ?? runId; },
  });

  // Everything downstream reads the run's own artifacts, never the runner's
  // return value: the artifacts survive a restart and the return value does not.
  // Recorded in `attempt.json` so a later scheduler can find the run again.
  const adoptRun = (read) => {
    ctx.effects = read.effects; ctx.verification = read.verification;
    ctx.prompt_manifest = read.prompt_manifest; ctx.handoff = read.handoff;
    ctx.baseline = read.baseline; ctx.candidate = read.candidate;
    ctx.preflight_failures = read.preflight?.failures ?? [];
    ctx.effects_artifact = join(read.dir, "git-effects.json");
    ctx.skills = null; ctx.executor_id = read.worker?.executable ?? null;
    ctx.prompt_limit = budgets.max_prompt_characters_per_attempt;
    try {
      WS.writeAtomic(join(aDir, "attempt.json"), JSON.stringify({
        schema_version: SCHEMA_VERSION, project_id: projectId, task_id: taskId, attempt,
        run_id: runId, run_dir: read.dir, scheduler_id: schedulerId,
        effects: read.effects ? { paths: read.effects.paths, rejected_paths: read.effects.rejected_paths, counts: read.effects.counts } : null,
        verification: read.verification ? { all_passed: read.verification.all_passed, passed: read.verification.passed, failed: read.verification.failed,
          results: (read.verification.results ?? []).map((r) => ({ id: r.id, display: r.display, result: r.result, exit_code: r.exit_code, stderr: clamp(r.stderr, 1500), stdout: clamp(r.stdout, 500) })) } : null,
        at: now(),
      }, null, 2));
    } catch { /* the run directory is the durable record */ }
  };

  // THE SELECTED WORKFLOW decides which phases exist for this task. A template
  // that omits `semantic-review` genuinely does not run it — the phase is not
  // skipped at runtime, it is absent from the plan, and `skipped()` records that
  // it was never part of this workflow rather than leaving a silent hole.
  const wf = workflowSelection ?? WF.selectTemplate({ task: ctx.taskForSelection ?? null, project });
  const phaseIds = new Set((wf.ok ? wf.template.phases : TASK_WORKFLOW).map((x) => x.id));
  const inWorkflow = (id) => phaseIds.has(id);

  // Every phase result goes through the engine, which owns the lifecycle and the
  // persistence. The scheduler only says WHAT the phase does.
  const activePhases = wf.ok ? wf.template.phases : TASK_WORKFLOW;
  // A template says `output_envelope` (the envelope registry's word); the phase
  // engine says `output_schema` (its own). One vocabulary crosses that boundary
  // and it is normalized HERE rather than by making one of the two lie.
  const phaseOf = (defId) => {
    const raw = activePhases.find((p) => p.id === defId) ?? TASK_WORKFLOW.find((p) => p.id === defId);
    if (!raw) return raw;
    return { ...raw, output_schema: raw.output_schema ?? raw.output_envelope ?? null };
  };
  const done = [];
  const skipped = [];
  // `defOverride` exists for exactly one case: a semantic phase the PROJECT has
  // switched off. It is still recorded — it is not absent — but it must not be
  // held to the agent's envelope and gates, because no agent ran. Overriding the
  // definition for that call is honest; faking a reviewer envelope would not be.
  const runOne = async (defId, work, defOverride = null) => {
    const def = defOverride ?? phaseOf(defId);
    record.current_phase = defId;
    emit("scheduler.phase_started", { kind: def.kind, role: def.role ?? null,
      workflow_template: wf.ok ? wf.template_id : null, workflow_template_version: wf.ok ? wf.template_version : null },
      { taskId, attempt, phaseId: defId });
    const rec = await PH.runPhase(def, { attemptDir: aDir, identity: identity(), ctx, index: activePhases.indexOf(def), work });
    done.push(rec);
    try { if (db) PROJ.upsertPhase(db, projectId, { ...rec, task_id: taskId, attempt }); } catch {}
    emit("scheduler.phase_executed", { state: rec.state, outcome: rec.outcome, failure: rec.failure?.code ?? null, duration_ms: rec.duration_ms }, { taskId, attempt, phaseId: defId });
    if (rec.envelope_hash) emit("scheduler.envelope_accepted", { type: rec.envelope_type, hash: rec.envelope_hash }, { taskId, attempt, phaseId: defId });
    for (const g of rec.gate_reports ?? [])
      emit(g.outcome === "PASS" ? "scheduler.gate_passed" : "scheduler.gate_failed",
        { gate_id: g.gate_id, gate_version: g.gate_version, kind: g.kind, outcome: g.outcome, evidence_hash: g.evidence_hash },
        { taskId, attempt, phaseId: defId });
    return rec;
  };

  // ONE PATH FOR EVERY SEMANTIC PHASE.
  //
  // scout, plan, implement, repair, review and document all run through here.
  // The differences between them are DATA in semantic.mjs — role, effect policy,
  // envelope, gates — not six divergent code paths that drift apart.
  //
  // The resolved role is the execution authority: it decides the prompt
  // template, the context policy, the expected envelope, the write scope and
  // the budgets, and the worker cannot widen any of them. Where the Claude CLI
  // offers no technical enforcement (there is no tool sandbox), authority is
  // enforced by an empty write policy plus post-run effect inspection plus a
  // factual gate — never by claiming an isolation that does not exist.
  const runSemantic = async (defId, semanticId, { planEnvelope = null, extraCtx = {} } = {}) => {
    const handler = SEM.SEMANTIC_HANDLERS[semanticId];
    // READ THE PRIOR RECORD BEFORE DISPATCHING. `runPhase` persists a fresh
    // PENDING record the moment it starts, so asking inside the work function
    // reads the record it just overwrote — which silently defeated this whole
    // short-circuit and started a second worker over a dirty tree.
    const already = resume ? PH.readPhase(aDir, defId) : null;
    return runOne(defId, async () => {
      const task = ctx.task;

      // CLAIMED → RUNNING happens whether or not a worker is about to start: a
      // resumed attempt is running again, and leaving the task CLAIMED makes
      // every later transition illegal as a skip.
      if (TR.canonicalState(loadState(projectId).tasks.find((t) => t.id === Number(taskId))) === "CLAIMED")
        TR.transition(projectId, taskId, { to: "RUNNING", actor: "runner", attempt,
          reason: already?.state === "ACCEPTED" ? `attempt ${attempt} resumed at ${defId}` : `${semanticId} phase starting a fresh worker` });

      // RESUMING DOES NOT RE-RUN A WORKER.
      //
      // An attempt parked for a human decision is continued, not restarted: its
      // change is already in the working tree and its evidence is already on
      // disk. Starting a second process over that tree is how a resume turns
      // into a collision.
      if (already?.state === "ACCEPTED") {
        const meta = (() => { try { return JSON.parse(readFileSync(join(aDir, "attempt.json"), "utf8")); } catch { return null; } })();
        if (meta?.run_id && handler.writes_allowed) {
          runId = meta.run_id;
          const read = RUN.readRun(projectId, runId);
          adoptRun(read); ctx.run = read.run;
          ctx.effects = read.effects;
          ctx.effects_artifact = join(read.dir, "git-effects.json");
          ctx.preflight_switch = true;
        }
        // Restore the envelope this phase already produced, so a downstream
        // phase that depends on it (the builder's plan) still has it.
        if (already.envelope) {
          const restored = { ok: true, envelope: already.envelope, envelope_type: already.envelope_type, hash: already.envelope_hash };
          ctx.semantic_envelope = restored;
          ctx[`${semanticId}_envelope`] = restored;
        }
        return { ok: true, notes: `resumed ${semanticId} — the worker was not started again` };
      }
      // 1. Resolve the ROLE. An unavailable executor or model profile fails the
      //    phase here, before a process is started.
      const resolved = ROLES.resolve(handler.role, { task, project, skills: [] });
      if (!resolved.ok) return { ok: false, state: "FAILED", failure: resolved.failure };
      const roleConfig = { ...resolved.config, semantic_handler: semanticId, phase_execution_id: `PEX-${randomBytes(6).toString("hex").toUpperCase()}` };

      // 2. Narrow the write policy to what this handler may touch. A read-only
      //    handler gets an EMPTY allow-list — no authorization whatsoever.
      const eff = SEM.effectivePolicy(semanticId, task);
      if (!eff.ok) return { ok: false, state: "FAILED", failure: eff.failure };
      ctx.effective_policy = eff.policy;
      ctx.role_config = roleConfig;
      ctx.semantic_handler = semanticId;
      Object.assign(ctx, extraCtx);

      // 3. Run a FRESH external process. Every semantic phase gets its own
      //    worker; none of them share a session.
      // What is ALREADY in the working tree when this phase starts.
      //   * a retry carries the previous attempt's change forward;
      //   * a phase that runs AFTER a writer in the same attempt — a reviewer, a
      //     documenter — must run against that change, because reading the diff
      //     is the entire job. Demanding a clean tree there would make a
      //     reviewer impossible.
      const carried = [...new Set([
        ...(attempt > 1 ? (previousAttempt?.effects?.paths ?? []).map((x) => x.path) : []),
        ...((ctx.effects?.paths ?? []).map((x) => x.path)),
      ])];
      const rec = await RUN.runTask({
        workRoot,
        projectId, taskId, env, executor, attempt,
        allowDirtyPaths: carried.length ? carried : null,
        roleConfig, policyOverride: eff.policy, planEnvelope, semanticHandler: semanticId,
        expectEnvelope: handler.output_envelope,
        workflow: wf.ok ? { template_id: wf.template_id, template_version: wf.template_version } : null,
      });
      phaseRunId = rec.run_id;
      const read = RUN.readRun(projectId, rec.run_id);
      // The last semantic phase to run owns the run-derived context. `implement`
      // additionally becomes the run the delivery pipeline binds to.
      if (handler.writes_allowed || !runId) { runId = rec.run_id; adoptRun(read); ctx.run = rec; }
      ctx.effects = read.effects;
      ctx.effects_artifact = join(read.dir, "git-effects.json");
      ctx.preflight_failures = read.preflight?.failures ?? [];
      try { if (db) PROJ.upsertRunReference(db, projectId, { run_id: rec.run_id, task_id: taskId, attempt, outcome: rec.outcome, failure_code: rec.failure?.code ?? null, dir: rec.run_dir, at: rec.ended_at }); } catch {}

      const accounting = {
        prompt_characters: read.prompt_manifest?.total_characters ?? 0,
        output_bytes: (read.worker?.stdout?.bytes_total ?? 0) + (read.worker?.stderr?.bytes_total ?? 0),
        executor: read.worker?.executable ?? null, model: roleConfig.model_profile,
      };

      // 4. Did the process even run? A preflight or executor failure is this
      //    phase's failure, not something for a downstream gate to discover.
      const preWorker = !read.worker || (read.preflight?.failures ?? []).length > 0;
      if (rec.outcome !== "VERIFIED" && preWorker)
        return { ok: false, accounting, state: rec.outcome === "NEEDS_DECISION" ? "NEEDS_DECISION" : "FAILED",
          failure: rec.failure ?? { code: "AGENT_PROCESS_FAILURE", message: `the ${semanticId} worker never started` } };
      if (rec.outcome === "CANCELLED") return { ok: false, accounting, state: "CANCELLED", failure: rec.failure };

      // 5. THE ROLE-POLICY CHECK. A read-only role that changed anything has
      //    violated its role, and that is a distinct failure from a path-scope
      //    violation: nothing was authorized at all. Evidence is preserved and
      //    NOTHING is reverted — discarding a worker's unapproved work to make
      //    the tree look clean is the one thing this engine must never do.
      if (!handler.writes_allowed) {
        const changed = (read.effects?.paths ?? []).length;
        const gitFx = (read.effects?.git_effects ?? []).length;
        if (changed || gitFx)
          return { ok: false, accounting, state: "FAILED", failure: { code: "ROLE_POLICY_VIOLATION",
            message: `role "${handler.role}" is read-only and has no write authorization, but the ${semanticId} phase changed ${changed} path(s)` +
              (gitFx ? ` and produced ${gitFx} git effect(s)` : "") +
              `. The evidence is preserved and nothing was reverted — inspect ${read.dir} and decide.` } };
      }

      // 6. The envelope. Handlers that declare one must produce a valid one; the
      //    builder's is parsed by the following CODE phase, as it always was.
      if (handler.output_envelope) {
        if (!read.handoff)
          return { ok: false, accounting, state: "FAILED", failure: { code: "AGENT_PROTOCOL_ERROR", message: `the ${semanticId} worker produced no handoff to read as ${handler.output_envelope}` } };
        // The worker speaks one handoff protocol; the REGISTRY decides what it
        // means in this phase. Builder-shaped fields do not travel into a scout
        // envelope — they are dropped, not smuggled through as stray fields.
        const validated = ENV.adaptHandoffTo(handler.output_envelope, read.handoff,
          { project_id: projectId, task_id: String(taskId), run_id: rec.run_id, phase_id: defId });
        if (!validated.ok) return { ok: false, accounting, state: "FAILED", failure: validated.failure };
        ctx.semantic_envelope = validated;
        ctx[`${semanticId}_envelope`] = validated;
        return { ok: true, accounting, envelope: validated.envelope, notes: `${semanticId} produced ${handler.output_envelope}` };
      }
      return { ok: true, accounting, notes: `run ${rec.run_id} ended ${rec.outcome}` };
    });
  };

  // A phase the SELECTED WORKFLOW does not contain. Recorded, not silent: a
  // reader of the trace must be able to tell "this workflow has no delivery
  // phase" from "delivery was meant to happen and did not".
  const ACCEPTED_SKIP = { state: "ACCEPTED", outcome: "NOT_IN_WORKFLOW", skipped: true, failure: null, gate_reports: [] };
  const skip = (defId, why) => {
    skipped.push({ phase_id: defId, reason: why });
    emit("scheduler.phase_executed", { state: "SKIPPED", outcome: "NOT_IN_WORKFLOW", reason: why }, { taskId, attempt, phaseId: defId });
    return ACCEPTED_SKIP;
  };
  // Run a phase only if the selected template contains it.
  const maybe = async (defId, work) =>
    (inWorkflow(defId) ? runOne(defId, work) : skip(defId, `template ${wf.ok ? wf.template_id : "(fallback)"} does not include this phase`));

  // What a NEXT attempt is allowed to know about this one: the failure, the
  // gate reports that produced it, the command output, and the paths currently
  // in the tree. Not the transcript, not the prompt, not the worker's stdout.
  const stopWith = (rec, outcome, failure) => ({
    outcome, failure: failure ?? rec?.failure ?? null, run_id: runId, attempt,
    classification: classifyFailure(failure?.code ?? rec?.failure?.code, { task: ctx.task, attempt, repairsUsed }),
    phases: done.map((p) => ({ phase_id: p.phase_id, state: p.state, failure: p.failure })),
    gate_reports: done.flatMap((p) => p.gate_reports ?? []),
    effects: ctx.effects ?? null, verification: ctx.verification ?? null,
    prompt_characters: ctx.prompt_manifest?.total_characters ?? null,
    started_at: startedAt, ended_at: now(),
  });

  const envFor = (phaseId, status, summary, extra = {}) =>
    ENV.build(phaseId === "deliver" ? "DeliveryEnvelopeV1" : (phaseOf(phaseId).output_schema ?? "CodeResultEnvelopeV1"),
      { ...identity(), phase_id: phaseId }, { status, summary, ...extra });

  // ---------------------------------------------------------------- prepare
  let p = await runOne("prepare", async () => {
    const st = loadState(projectId);
    ctx.state = st;
    ctx.task = (st.tasks ?? []).find((t) => t.id === Number(taskId));
    ctx.task_state = TR.canonicalState(ctx.task);
    ctx.workspace = WS.validateWorkspace({ projectId, repoPath: project.path });
    ctx.graph_validation = GRAPH.validateGraph(projectId, { state: st, canonicalState: TR.canonicalState });
    // Readiness is computed against the task as it was BEFORE this scheduler
    // claimed it: a claimed task is not "ready", and grading it on that would
    // make the scheduler fail its own gate on every single task.
    ctx.readiness = GRAPH.readiness(st, { ...ctx.task, state: "READY" }, { canonicalState: (t) => (t.id === ctx.task.id ? "READY" : TR.canonicalState(t)) });
    return { ok: true, envelope: envFor("prepare", "SUCCESS", `attempt ${attempt} prepared for task #${taskId} "${clamp(ctx.task?.title, 120)}"`,
      { result: { attempt_dir: aDir, task_state: ctx.task_state } }) };
  });
  if (p.state !== "ACCEPTED") return stopWith(p, "FAILED");

  // ------------------------------------------------------------ readiness gate
  p = await runOne("task-readiness", async () => ({ ok: true,
    envelope: envFor("task-readiness", "SUCCESS", `readiness evaluated for task #${taskId}`, { outcome: "PASS", gates: [] }) }));
  if (p.state !== "ACCEPTED") return stopWith(p, "FAILED", { code: "TASK_INELIGIBLE", message: p.failure?.message ?? "the task is not ready" });

  // -------------------------------------------------------- compile context
  p = await runOne("compile-context", async () => {
    const repair = attempt > 1
      ? repairContext({ task: ctx.task, previousAttempt, gateReports: previousAttempt?.gate_reports ?? [],
          verification: previousAttempt?.verification ?? null, effects: previousAttempt?.effects ?? null })
      : { text: "", manifest: { unit: "characters", total_characters: 0, sections: [], omitted: [] } };
    ctx.repair = repair;
    WS.writeAtomic(join(aDir, "repair-context.json"), JSON.stringify(repair.manifest, null, 2));
    if (repair.text) WS.writeAtomic(join(aDir, "repair-context.md"), repair.text);
    return { ok: true, accounting: { previous_evidence_characters: repair.manifest.total_characters },
      envelope: envFor("compile-context", "SUCCESS",
        attempt > 1 ? `repair context compiled: ${repair.manifest.total_characters} characters from ${repair.manifest.sections.length} section(s)` : "first attempt — no previous evidence to carry",
        { result: repair.manifest }) };
  });
  if (p.state !== "ACCEPTED") return stopWith(p, "FAILED");

  // ------------------------------------------------------------------ scout
  //
  // Read-only. Runs a real fresh worker, produces a ScoutEnvelopeV1, and any
  // repository change it makes fails the phase as a role-policy violation.
  if (inWorkflow("scout")) {
    p = await runSemantic("scout", "scout");
    if (p.state !== "ACCEPTED")
      return stopWith(p, p.failure?.code === "ROLE_POLICY_VIOLATION" ? "NEEDS_DECISION" : (p.state === "NEEDS_DECISION" ? "NEEDS_DECISION" : "FAILED"), p.failure);
  }

  // ------------------------------------------------------------------- plan
  //
  // Read-only. Its validated envelope becomes an IMMUTABLE artifact that the
  // builder later receives as typed fields — never as a conversation.
  if (inWorkflow("plan")) {
    p = await runSemantic("plan", "plan", { extraCtx: { scout_envelope: ctx.scout_envelope ?? null } });
    if (p.state !== "ACCEPTED")
      return stopWith(p, p.failure?.code === "ROLE_POLICY_VIOLATION" ? "NEEDS_DECISION" : (p.state === "NEEDS_DECISION" ? "NEEDS_DECISION" : "FAILED"), p.failure);
    // Persist the plan beside the attempt, immutably. A retry writes a new
    // attempt directory, so the original plan evidence is never overwritten.
    if (ctx.plan_envelope) {
      planArtifact = { hash: ctx.plan_envelope.hash, ...ctx.plan_envelope.envelope, phase_execution_id: ctx.role_config?.phase_execution_id ?? null };
      try { WS.writeAtomic(join(aDir, "plan-envelope.json"), JSON.stringify(planArtifact, null, 2)); } catch {}
      emit("scheduler.envelope_accepted", { type: "PlannerEnvelopeV1", hash: planArtifact.hash, artifact: "plan-envelope.json" }, { taskId, attempt, phaseId: "plan" });
    }
  }

  // --------------------------------------------------------------- document
  if (inWorkflow("document")) {
    p = await runSemantic("document", "document");
    if (p.state !== "ACCEPTED") return stopWith(p, p.state === "NEEDS_DECISION" ? "NEEDS_DECISION" : "FAILED", p.failure);
  }

  // ------------------------------------------------------------- implement
  //
  // The fresh external worker. `runTask` owns the process, the timeout, the
  // effect inspection and the verification — the scheduler adds nothing to it
  // and re-implements none of it.
  // The builder. Same shared semantic path as every other AGENT phase — the
  // role is resolved, the write policy is the task's, and the plan (when a
  // planner ran) arrives as typed fields, not as a conversation.
  if (inWorkflow("implement")) {
    p = await runSemantic("implement", "implement", { planEnvelope: planArtifact });
    if (p.state !== "ACCEPTED")
      return stopWith(p, p.state === "NEEDS_DECISION" ? "NEEDS_DECISION" : p.state === "CANCELLED" ? "CANCELLED" : "FAILED", p.failure);
  }

  // ------------------------------------------------- parse builder envelope
  p = await maybe("parse-builder-envelope", async () => {
    if (!ctx.handoff)
      return { ok: false, state: "FAILED", failure: { code: "AGENT_PROTOCOL_ERROR", message: `run ${runId} produced no handoff to read as an envelope` } };
    return { ok: true, envelope: ctx.handoff };     // the legacy adapter turns it into BuilderEnvelopeV1
  });
  if (p.state !== "ACCEPTED") return stopWith(p, "FAILED", p.failure ?? { code: "AGENT_PROTOCOL_ERROR", message: "the worker's envelope was not acceptable" });
  ctx.builder_envelope = p.envelope;

  // ------------------------------------------------------------- effects
  p = await maybe("inspect-effects", async () => ({ ok: true,
    envelope: envFor("inspect-effects", "SUCCESS",
      `${(ctx.effects?.paths ?? []).length} path(s) changed, ${(ctx.effects?.rejected_paths ?? []).length} out of policy, ${(ctx.effects?.git_effects ?? []).length} forbidden git effect(s)`,
      { result: { counts: ctx.effects?.counts ?? null, claim_comparison: ctx.effects?.claim_comparison ?? null } }) }));
  if (p.state !== "ACCEPTED") return stopWith(p, "FAILED");

  p = await maybe("effects-gate", async () => ({ ok: true,
    envelope: envFor("effects-gate", "SUCCESS", "worker effects evaluated against the task's path policy", { outcome: "PASS", gates: [] }) }));
  if (p.state !== "ACCEPTED") {
    const worst = (ctx.effects?.git_effects ?? []).length ? "FORBIDDEN_GIT_EFFECT"
      : (ctx.effects?.rejected_paths ?? []).length ? "PATH_SCOPE_VIOLATION" : "GATE_FAILED";
    return stopWith(p, worst === "FORBIDDEN_GIT_EFFECT" ? "NEEDS_DECISION" : "FAILED",
      { code: worst, message: p.failure?.message ?? "the worker's effects are outside policy" });
  }

  // ------------------------------------------------------------ verification
  p = await maybe("verify", async () => ({ ok: true,
    envelope: envFor("verify", ctx.verification?.all_passed ? "SUCCESS" : "FAILED",
      ctx.verification ? `${ctx.verification.passed}/${ctx.verification.total} required command(s) passed` : "no verification was recorded",
      { result: { passed: ctx.verification?.passed ?? 0, failed: ctx.verification?.failed ?? 0 } }) }));
  if (p.state !== "ACCEPTED") return stopWith(p, "FAILED");

  p = await maybe("verification-gate", async () => ({ ok: true,
    envelope: envFor("verification-gate", "SUCCESS", "deterministic verification evaluated", { outcome: "PASS", gates: [] }) }));
  if (p.state !== "ACCEPTED") {
    const code = !ctx.verification?.all_passed ? (ctx.verification?.failure?.code ?? "VERIFICATION_FAILURE")
      : (p.gate_summary?.failed ?? []).includes("secret-scan-passed") ? "SECRET_DETECTED" : "GATE_FAILED";
    return stopWith(p, "FAILED", { code, message: p.failure?.message ?? "verification did not pass" });
  }
  // The worker said BLOCKED or FAILED. Green tests do not overrule that: it is
  // telling us it did not do the task.
  // Only a workflow that HAS a builder can be contradicted by one. A scout or a
  // planner never produces a builder envelope, and treating its absence as a
  // disagreement made every read-only workflow stop as AMBIGUOUS_EVIDENCE.
  if (inWorkflow("parse-builder-envelope") && ctx.builder_envelope?.status !== "SUCCESS")
    return stopWith(p, "NEEDS_DECISION", { code: "AMBIGUOUS_EVIDENCE",
      message: `verification passed but the worker reported ${ctx.builder_envelope?.status}: ${clamp(ctx.builder_envelope?.summary, 400)}` });

  // -------------------------------------------------------- semantic review
  //
  // Behind a project policy flag. When it is off, that is RECORDED — pretending
  // deterministic verification is a code review is exactly the claim this
  // milestone refuses to make.
  const reviewEnabled = project?.semanticReview === true || project?.semanticReview === "true";
  // A REAL, READ-ONLY, INDEPENDENT REVIEWER.
  //
  // It runs in its own fresh process and receives the actual diff, the changed
  // paths, the deterministic verification summary, the plan (when there was one)
  // and the compact gate evidence — never the builder's reasoning, because a
  // reviewer that reads the builder's rationale is agreeing with it rather than
  // reviewing it. It cannot write, deliver, stage, commit, push or move the task.
  if (inWorkflow("semantic-review")) {
    if (!reviewEnabled && !SEM_REVIEW_REQUIRED.has(wf.template_id)) {
      // Recorded explicitly. Deterministic verification is NOT a code review,
      // and a workflow that skipped review must say so rather than imply one.
      // NOT the same as "absent". The reviewer is fully executable; this
      // PROJECT has not enabled it. That is a configuration decision and it is
      // RECORDED as one — a phase that quietly disappears is exactly the
      // reporting failure this milestone exists to remove.
      ctx.semantic_review = { status: "NOT_CONFIGURED", note: "this project has not enabled an independent semantic reviewer; deterministic verification is not a code review" };
      p = await runOne("semantic-review", async () => ({ ok: true,
        notes: "semantic_review: NOT_CONFIGURED — the reviewer is executable but this project has not enabled it" }),
        { ...phaseOf("semantic-review"), output_schema: null, output_envelope: null, gates: [] });
    } else {
      p = await runSemantic("semantic-review", "review", {
        extraCtx: {
          review_inputs: {
            acceptance_criteria: ctx.task?.ac ?? [],
            changed_paths: (ctx.effects?.paths ?? []).map((x) => x.path),
            verification: ctx.verification ? EV.compactVerification(ctx.verification, { runDir: ctx.run?.run_dir ?? null }) : null,
            plan_hash: planArtifact?.hash ?? null,
            gate_evidence: done.flatMap((x) => (x.gate_reports ?? []).map((g) => ({ gate_id: g.gate_id, outcome: g.outcome }))),
          },
        },
      });
      const env = ctx.review_envelope?.envelope ?? ctx.semantic_envelope?.envelope ?? null;
      const outcome = env?.outcome ?? (env?.status === "NEEDS_DECISION" ? "NEEDS_DECISION" : env ? "APPROVE" : "INCONCLUSIVE");
      ctx.semantic_review = { status: outcome, summary: clamp(env?.summary, 400),
        must_fix: env?.must_fix ?? [], findings: env?.findings ?? [] };
    }
    if (p.state !== "ACCEPTED")
      return stopWith(p, p.failure?.code === "ROLE_POLICY_VIOLATION" ? "NEEDS_DECISION" : (p.state === "NEEDS_DECISION" ? "NEEDS_DECISION" : "FAILED"), p.failure);
  }

  p = await maybe("review-gate", async () => ({ ok: true,
    envelope: envFor("review-gate", "SUCCESS", `semantic review: ${ctx.semantic_review?.status ?? "NOT_CONFIGURED"}`, { outcome: "PASS", gates: [] }) }));
  if (p.state !== "ACCEPTED") return stopWith(p, "FAILED");
  // The reviewer's VERDICT, which it may return but never enforce. It cannot
  // override a deterministic gate that already failed — by this point every
  // factual gate has passed, so the reviewer is adding judgement, not replacing
  // evidence.
  const verdict = ctx.semantic_review?.status ?? null;
  if (verdict === "CHANGES_REQUIRED")
    return stopWith(p, "REVISION_REQUIRED", { code: "SEMANTIC_REVISION_REQUIRED",
      message: `the independent reviewer requires changes: ${clamp(ctx.semantic_review?.summary, 300)}` +
        (ctx.semantic_review?.must_fix?.length ? ` — must fix: ${ctx.semantic_review.must_fix.slice(0, 5).join("; ")}` : "") });
  if (verdict === "NEEDS_DECISION")
    return stopWith(p, "NEEDS_DECISION", { code: "AMBIGUOUS_EVIDENCE",
      message: `the independent reviewer could not decide and referred it to a person: ${clamp(ctx.semantic_review?.summary, 300)}` });

  // ------------------------------------------------------ prepare delivery
  p = await maybe("prepare-delivery", async () => {
    if (!ctx.candidate)
      return { ok: false, state: "FAILED", failure: { code: "RUN_NOT_DELIVERY_ELIGIBLE", message: `run ${runId} recorded no delivery candidate` } };
    // Recomputed with EXACTLY the inputs the delivery controller will use, or
    // the three hashes describe different questions and the comparison is
    // guaranteed to report drift that never happened.
    const current = CAND.computeCandidate({
      // The worker's checkout, where the change actually is — recomputing this
      // against the operator's working tree would find no change at all.
      repoRoot: workRoot ?? repoRoot, projectId, taskId, runId,
      baseline: ctx.baseline, verification: ctx.verification, promptManifest: ctx.prompt_manifest,
      policy: { allowed: ctx.task.allowedPaths ?? [], forbidden: ctx.task.forbiddenPaths ?? [], controlCategory: ctx.task.controlCategory ?? null },
      outcome: ctx.run?.outcome, verifiedAt: ctx.run?.ended_at,
    });
    const drift = current.ok ? CAND.compareCandidates(ctx.candidate, current.candidate) : [{ code: "VERIFIED_DIFF_CHANGED", message: current.failure?.message ?? "the candidate could not be recomputed" }];
    ctx.candidate_comparison = {
      same: drift.length === 0, verified_diff_hash: ctx.candidate.verified_diff_hash,
      differences: drift.map((d) => ({ path: d.code, why: d.message })),
    };
    const trans = TR.transition(projectId, taskId, { to: "VERIFYING", actor: "runner", reason: `run ${runId} verified`, runId, attempt });
    if (!trans.ok) return { ok: false, state: "FAILED", failure: trans.failure };
    const ready = TR.transition(projectId, taskId, { to: "AWAITING_DELIVERY", actor: "verifier", reason: "verification accepted; ready to deliver", runId, attempt });
    if (!ready.ok) return { ok: false, state: "FAILED", failure: ready.failure };
    emit("scheduler.task_awaiting_delivery", { run_id: runId, paths: ctx.candidate.changed_paths?.length ?? 0 }, { taskId, attempt });
    return { ok: true, envelope: envFor("prepare-delivery", "SUCCESS",
      `candidate ${String(ctx.candidate.verified_diff_hash).slice(0, 12)} bound for delivery`,
      { result: { paths: ctx.candidate.changed_paths ?? [], drift: drift.map((d) => d.code) } }) };
  });
  if (p.state !== "ACCEPTED")
    return stopWith(p, "NEEDS_DECISION", p.failure?.code === "GATE_FAILED"
      ? { code: "VERIFIED_DIFF_CHANGED", message: p.failure.message }
      : (p.failure ?? { code: "INTERNAL_STATE_CONFLICT", message: "the delivery candidate could not be prepared" }));

  // ------------------------------------------------------ delivery approval
  //
  // A HUMAN phase. It starts no agent and decides nothing itself: it runs the
  // delivery controller far enough to write down exactly what it intends, then
  // reads whether a person has signed that intention.
  p = await maybe("delivery-approval", async () => {
    // DELIVERING is entered BEFORE the controller is called, not after. The
    // controller may run all the way to a pushed commit in one call when no
    // approval is required, and marking the task DELIVERING afterwards would
    // overwrite the `delivered` it had already earned.
    const enter = TR.transition(projectId, taskId, { to: "DELIVERING", actor: "delivery", reason: `delivery controller invoked for run ${runId}`, runId, attempt });
    if (!enter.ok && TR.canonicalState(loadState(projectId).tasks.find((t) => t.id === Number(taskId))) !== "DELIVERING")
      return { ok: false, state: "FAILED", failure: enter.failure };
    const first = DEL.deliverRun({ projectId, runId, workRoot });
    let read = DEL.readDelivery(projectId, runId);

    // ONE HUMAN DECISION, TWO RECORDS. If the operator has already answered the
    // typed human gate for this run, that answer is what signs the delivery
    // transaction — they are not asked a second time in a second vocabulary.
    // The signature is over the transaction's own subject, so a diff that moved
    // since they said yes still invalidates it.
    if (read.ok && read.approval_status !== "APPROVED" && read.approval_status !== "NO_APPROVAL_REQUIRED") {
      const answered = HG.list(projectId).find((g) =>
        g.gate_type === "DELIVERY_APPROVAL" && g.run_id === runId && ["APPROVED", "REJECTED"].includes(g.status));
      if (answered) {
        const stillTheSameDiff = !answered.diff_hash || answered.diff_hash === (ctx.candidate?.verified_diff_hash ?? null);
        if (!stillTheSameDiff) {
          HG.revalidate(projectId, answered.id, { diffHash: ctx.candidate?.verified_diff_hash ?? null });
        } else {
          DEL.approveDelivery(projectId, runId, {
            approver: answered.approver, decision: answered.status,
            why: `human gate ${answered.id}${answered.conditions ? `: ${answered.conditions}` : ""}`,
          });
          if (answered.status === "APPROVED") DEL.deliverRun({ projectId, runId, workRoot });
          read = DEL.readDelivery(projectId, runId);
        }
      }
    }

    ctx.delivery = read;
    ctx.transaction = read.ok ? { ...read.transaction, outgoing: read.outgoing?.outgoing ?? [], incoming: read.outgoing?.incoming ?? [], integration_commits: read.outgoing?.integration ?? [], remote_verification: read.remote_verification ?? read.transaction.remote_verification ?? null } : null;
    ctx.approval = read.ok
      ? { state: read.approval_status, approver: read.transaction.approval?.approver ?? null, at: read.transaction.approval?.at ?? null, why: read.transaction.failure?.message ?? null }
      : { state: "PENDING", why: read.failure?.message ?? "no delivery transaction" };

    // Stepping back out of DELIVERING whenever the controller did NOT deliver:
    // a task parked for a decision must not read as "being delivered" on a
    // dashboard for however long the operator takes to answer.
    const stepBack = () => TR.transition(projectId, taskId, { to: "AWAITING_DELIVERY", actor: "delivery", reason: "the delivery controller stopped without pushing", runId, attempt });

    if (ctx.approval.state === "REJECTED") {
      stepBack();
      return { ok: false, state: "BLOCKED", failure: { code: "APPROVAL_REJECTED", message: `the operator rejected this delivery; the change is still in the working tree, unstaged` } };
    }
    if (read.transaction?.state === "DELIVERED" || first.state === "DELIVERED") {
      commit = first.commit?.hash ?? read.transaction?.commit?.hash ?? null;
      return { ok: true, notes: "delivered on the first pass" };
    }

    // THE CONTROLLER'S OWN REASON COMES FIRST. Only an APPROVAL failure is a
    // question for a person; an incoming commit, an unrelated outgoing commit,
    // a changed diff or a rejected push are facts, and asking someone to
    // "approve" one of those would be asking them to approve a lie.
    const APPROVAL_FAILURES = new Set(["APPROVAL_REQUIRED", "APPROVAL_EXPIRED", "APPROVAL_INVALIDATED", "APPROVAL_REJECTED"]);
    const stopped = read.transaction?.failure ?? first.failure ?? null;
    if (stopped && !APPROVAL_FAILURES.has(stopped.code)) {
      stepBack();
      return { ok: false, state: DEL.deliveryOutcomeFor(stopped.code) === "NEEDS_DECISION" ? "NEEDS_DECISION" : "FAILED", failure: stopped };
    }
    // No approval is configured for this project or task: the controller simply
    // has not written a signature because none was ever asked for.
    const policy = DEL.approvalPolicy(project, ctx.task);
    if (!policy.approval_before_commit && !policy.approval_before_push && !stopped)
      return { ok: true, notes: "no approval is required by this project's delivery policy" };
    if (ctx.approval.state === "APPROVED" || ctx.approval.state === "NO_APPROVAL_REQUIRED") return { ok: true, notes: `approval: ${ctx.approval.state}` };

    // Not approved. That is a decision for a person, so ask them properly and stop.
    const gate = HG.create(projectId, {
      gateType: "DELIVERY_APPROVAL", taskId, runId, attempt, phaseId: "delivery-approval",
      stateVersion: TR.canonicalState(ctx.task) ? (loadState(projectId).tasks.find((t) => t.id === Number(taskId))?.stateVersion ?? null) : null,
      diffHash: ctx.candidate?.verified_diff_hash ?? null,
      question: `Task #${taskId} "${clamp(ctx.task?.title, 120)}" is verified and ready to be committed and pushed.\n\n` +
        `It would create ONE commit on ${read.transaction?.branch ?? "the current branch"} and push it to ${read.transaction?.remote ?? "the configured remote"}:\n` +
        `  ${clamp(read.transaction?.commit_message ?? "(no message proposed)", 300)}\n\n` +
        `Files (${(read.transaction?.verified_paths ?? []).length}): ${clamp((read.transaction?.verified_paths ?? []).join(", "), 400)}\n\n` +
        `Approve this delivery? APPROVED pushes it; REJECTED leaves the change in the working tree, unstaged, and stops the queue.`,
      options: ["APPROVED — commit and push this exact diff", "REJECTED — do not push; stop the queue and leave the change in the tree"],
      recommended: "APPROVED if the diff is what you asked for",
      subject: { commit_message: read.transaction?.commit_message ?? null, paths: read.transaction?.verified_paths ?? [] },
    });
    if (gate.ok) emit("scheduler.human_gate_created", { gate_id: gate.gate.id, gate_type: "DELIVERY_APPROVAL", existing: Boolean(gate.existing) }, { taskId, attempt, phaseId: "delivery-approval" });
    stepBack();
    return { ok: false, state: "NEEDS_DECISION",
      failure: { code: "APPROVAL_REQUIRED", message: `delivery of task #${taskId} needs approval: ${gate.ok ? gate.gate.id : gate.failure.message}` } };
  });
  if (p.state !== "ACCEPTED") return stopWith(p, p.state === "NEEDS_DECISION" ? "NEEDS_DECISION" : "FAILED", p.failure);

  // ---------------------------------------------------------------- deliver
  p = await maybe("deliver", async () => {
    // The task is already DELIVERING (entered before the controller was first
    // called). If the approval phase completed the push, this is a no-op that
    // re-reads the transaction; otherwise the controller runs to completion now.
    if (TR.canonicalState(loadState(projectId).tasks.find((t) => t.id === Number(taskId))) === "AWAITING_DELIVERY")
      TR.transition(projectId, taskId, { to: "DELIVERING", actor: "delivery", reason: `delivering run ${runId}`, runId, attempt });
    const d = commit ? { state: "DELIVERED", commit: { hash: commit } } : DEL.deliverRun({ projectId, runId, workRoot });
    const read = DEL.readDelivery(projectId, runId);
    ctx.delivery = read;
    ctx.transaction = read.ok ? { ...read.transaction, outgoing: read.outgoing?.outgoing ?? [], incoming: read.outgoing?.incoming ?? [], integration_commits: read.outgoing?.integration ?? [], remote_verification: read.remote_verification ?? read.transaction.remote_verification ?? null } : null;
    try { if (db && read.ok) PROJ.upsertDeliveryReference(db, projectId, { ...read.transaction, approval_status: read.approval_status, commit: read.transaction.commit?.hash ?? null }); } catch {}
    if (d.state !== "DELIVERED") {
      // The delivery controller stopped. It never force-pushed, never rewrote
      // history, and never merged anything; the scheduler adds nothing here
      // except stopping too.
      TR.transition(projectId, taskId, { to: "AWAITING_DELIVERY", actor: "delivery", reason: `delivery stopped: ${d.failure?.code}`, runId, attempt });
      return { ok: false, state: DEL.deliveryOutcomeFor(d.failure?.code) === "NEEDS_DECISION" ? "NEEDS_DECISION" : "FAILED", failure: d.failure };
    }
    commit = d.commit?.hash ?? read.transaction?.commit?.hash ?? null;
    return { ok: true, envelope: envFor("deliver", "SUCCESS", `delivered as ${String(commit).slice(0, 8)}`,
      { delivery_id: read.transaction?.delivery_id ?? "", commit: String(commit ?? ""), branch: read.transaction?.branch ?? "", remote: read.transaction?.remote ?? "", state: "DELIVERED" }) };
  });
  if (p.state !== "ACCEPTED") return stopWith(p, p.state === "NEEDS_DECISION" ? "NEEDS_DECISION" : "FAILED", p.failure);

  // -------------------------------------------------- remote verification
  p = await maybe("remote-verification", async () => ({ ok: true,
    envelope: envFor("remote-verification", "SUCCESS", "remote delivery evaluated independently", { outcome: "PASS", gates: [] }) }));
  if (p.state !== "ACCEPTED") return stopWith(p, "NEEDS_DECISION", { code: "REMOTE_CHANGED", message: p.failure?.message ?? "the remote does not confirm the delivery" });

  // ------------------------------------------------------------- complete
  p = await maybe("complete-task", async () => {
    // The delivery controller already set the legacy `delivered` through
    // markDelivered — the only path that may, and only after it proved the
    // commit on the remote. The canonical state follows THAT fact; the
    // transition is refused if the controller did not actually complete.
    let st = loadState(projectId);
    let task = (st.tasks ?? []).find((t) => t.id === Number(taskId));
    if (task?.status === "delivered" && TR.canonicalState(task) !== "DELIVERED") {
      const done = TR.transition(projectId, taskId, {
        to: "DELIVERED", actor: "delivery", runId, attempt,
        reason: `commit ${String(commit).slice(0, 8)} verified on ${task.delivery?.remote ?? "the remote"}`,
      });
      if (!done.ok) return { ok: false, state: "FAILED", failure: done.failure };
      st = loadState(projectId); task = (st.tasks ?? []).find((t) => t.id === Number(taskId));
    }
    ctx.task = task;
    ctx.task_state = TR.canonicalState(task);
    return { ok: true, envelope: envFor("complete-task", "SUCCESS", `task #${taskId} delivered as ${String(commit).slice(0, 8)}`,
      { result: { commit, state: ctx.task_state } }) };
  });
  if (p.state !== "ACCEPTED") return stopWith(p, "NEEDS_DECISION", { code: "INTERNAL_STATE_CONFLICT", message: p.failure?.message ?? "the task is not properly completed" });

  // WHAT THE WORKFLOW ACTUALLY ACHIEVED. A template with no delivery phase
  // reaching its end has NOT delivered, and saying DELIVERED here would be the
  // single most damaging lie this engine could tell — the scheduler would move
  // to the next task believing the previous one was on the remote.
  // COMPLETION SEMANTICS. Six distinct outcomes, because "done" means six
  // different things and calling a read-only scout DELIVERED would claim a
  // remote commit that does not exist.
  const delivered = inWorkflow("complete-task") && Boolean(commit);
  const verified = inWorkflow("verification-gate");
  const wroteAnything = wf.ok && wf.template.phases.some((x) => x.semantic && SEM.SEMANTIC_HANDLERS[x.semantic]?.writes_allowed);
  const planned = inWorkflow("plan") && !wroteAnything;
  const outcome = delivered ? "DELIVERED"
    : !wroteAnything ? (planned ? "PLAN_COMPLETED" : "READ_ONLY_COMPLETED")
    : verified ? "AWAITING_DELIVERY" : "AWAITING_DELIVERY";
  return {
    outcome,
    failure: null, run_id: runId, attempt, commit: delivered ? commit : null,
    workflow: wf.ok ? { template_id: wf.template_id, template_version: wf.template_version, selected_by: wf.selected_by } : null,
    phases: done.map((x) => ({ phase_id: x.phase_id, state: x.state })),
    skipped_phases: skipped,
    prompt_characters: ctx.prompt_manifest?.total_characters ?? null,
    started_at: startedAt, ended_at: now(),
  };
}

// ------------------------------------------------------------- projections

export function schedulerProjection(projectId, { limit = 10 } = {}) {
  const project = getProject(projectId);
  if (!project?.path) return { project: projectId, available: false, reason: "no such project", schedulers: [] };
  let wsDir;
  try { wsDir = WS.resolveWorkspaceDir(WS.repositoryRoot(project.path) ?? project.path, { mustExist: true }); }
  catch (e) { return { project: projectId, available: false, reason: e.message, schedulers: [] }; }
  const root = join(schedulerRoot(wsDir), "runs");
  const rows = [];
  if (existsSync(root))
    for (const id of readdirSync(root).filter((d) => d.startsWith("SCHED-")).sort().reverse().slice(0, limit)) {
      try { rows.push(JSON.parse(readFileSync(join(root, id, "scheduler.json"), "utf8"))); } catch {}
    }
  const live = liveSchedulerLease(wsDir);
  return {
    schema_version: SCHEMA_VERSION, project: projectId, available: true, workspace: wsDir,
    lease: live, active: rows.find((r) => r.state === "RUNNING" && live?.scheduler_id === r.scheduler_id) ?? null,
    schedulers: rows.map(summary),
    completion: evaluateCompletion(projectId, { wsDir }),
    write_actions_require_local_operator: true,
  };
}

export function readScheduler(projectId, schedulerId) {
  const project = getProject(projectId);
  const wsDir = WS.resolveWorkspaceDir(WS.repositoryRoot(project?.path ?? ".") ?? project?.path ?? ".", { mustExist: true });
  const d = schedulerDir(wsDir, schedulerId);
  const load = (f) => { try { return JSON.parse(readFileSync(join(d, f), "utf8")); } catch { return null; } };
  const events = (() => {
    try { return readFileSync(join(d, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
    catch { return []; }
  })();
  return { dir: d, scheduler: load("scheduler.json"), events };
}

// Every phase record for one task, across every attempt — the restart view and
// the dashboard's "what happened" view are the same data.
export function taskPhases(projectId, taskId, { schedulerId = null } = {}) {
  const project = getProject(projectId);
  let wsDir;
  try { wsDir = WS.resolveWorkspaceDir(WS.repositoryRoot(project?.path ?? ".") ?? project?.path ?? ".", { mustExist: true }); }
  catch { return { project: projectId, task_id: Number(taskId), attempts: [] }; }
  const td = taskDir(wsDir, taskId);
  if (!existsSync(td)) return { project: projectId, task_id: Number(taskId), attempts: [] };
  const load = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
  const out = [];
  for (const n of attemptNumbers(wsDir, taskId)) {
    const dirPath = attemptDir(wsDir, taskId, n);
    const meta = load(join(dirPath, "attempt.json"));
    if (schedulerId && meta?.scheduler_id !== schedulerId) continue;
    out.push({
      attempt: n, dir: dirPath, scheduler_id: meta?.scheduler_id ?? null, run_id: meta?.run_id ?? null,
      recovery: PH.recoveryPoint(dirPath, TASK_WORKFLOW),
      repair_context: load(join(dirPath, "repair-context.json")),
    });
  }
  return { project: projectId, task_id: Number(taskId), workflow: TASK_WORKFLOW.map((p) => ({ id: p.id, kind: p.kind, gates: p.gates })), attempts: out };
}
