#!/usr/bin/env node
// SCH Loop — the fail-closed target-project Git transaction controller.
//
// This is the ONLY component in SCH permitted to stage, commit or push anything
// in a managed project. It takes one run that the supervised runner already
// marked VERIFIED, proves the repository still holds exactly the effects that
// were verified, stages exactly those paths, creates exactly one commit, fetches
// and inspects divergence, pushes without force, verifies the commit on the
// remote independently, marks the task delivered, and stops.
//
// It never runs a worker, never selects a task, never retries, and never merges,
// rebases, amends, resets, reverts or force-pushes. Every git call goes through
// candidate.mjs's gitRun(), which refuses those argv shapes outright and records
// every invocation so a test can prove what was and was not run.
//
//   node scripts/sch-deliver-run.mjs --project <id> --run <RUN-id>

import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as WS from "./workspace.mjs";
import * as C from "./candidate.mjs";
// The pure namespace matcher only. worktree.mjs is a leaf, so this cannot close
// an import cycle the way reaching back into state.mjs for it would.
import * as WT from "./worktree.mjs";
import { readRun, promoteHandoff } from "./runner.mjs";
import { getProject, loadState, auditLog, markDelivered } from "./state.mjs";

export const SCHEMA_VERSION = 1;
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------- state machine

export const DELIVERY_STATES = [
  "CREATED", "PREFLIGHT", "AWAITING_APPROVAL", "STAGING", "STAGED", "COMMITTING",
  "COMMITTED", "FETCHING", "CHECKING_OUTGOING", "PUSHING", "PUSHED",
  "REMOTE_VERIFYING", "DELIVERED", "NEEDS_DECISION", "FAILED", "CANCELLED",
];
export const TERMINAL_STATES = new Set(["DELIVERED", "NEEDS_DECISION", "FAILED", "CANCELLED"]);
const TERMINALS = ["NEEDS_DECISION", "FAILED", "CANCELLED"];

// Closed transitions. Any state may fall to a terminal outcome — that is what
// fail-closed means — but nothing may skip a gate and nothing may go backwards.
const FORWARD = {
  CREATED: ["PREFLIGHT"],
  PREFLIGHT: ["AWAITING_APPROVAL", "STAGING"],
  AWAITING_APPROVAL: ["STAGING", "PUSHING"],
  STAGING: ["STAGED"],
  STAGED: ["COMMITTING"],
  COMMITTING: ["COMMITTED"],
  COMMITTED: ["FETCHING"],
  FETCHING: ["CHECKING_OUTGOING"],
  CHECKING_OUTGOING: ["AWAITING_APPROVAL", "PUSHING"],
  PUSHING: ["PUSHED"],
  PUSHED: ["REMOTE_VERIFYING"],
  REMOTE_VERIFYING: ["DELIVERED"],
};

// Who may authorize a transition. The model is not on this list, and neither is
// any prompt: a delivery state asserts something about irreversible acts.
export const ACTORS = ["controller", "approval", "cancel"];

export function canTransition(from, to, actor = "controller") {
  if (!DELIVERY_STATES.includes(to)) return { ok: false, why: `unknown delivery state "${to}"` };
  if (!ACTORS.includes(actor)) return { ok: false, why: `"${actor}" may not move a delivery` };
  if (TERMINAL_STATES.has(from)) return { ok: false, why: `the delivery is already terminal in ${from}` };
  if (to === "CANCELLED" && actor !== "cancel" && actor !== "controller") return { ok: false, why: "only a cancellation may cancel" };
  if (TERMINALS.includes(to)) return { ok: true };
  if (!(FORWARD[from] ?? []).includes(to)) return { ok: false, why: `illegal transition ${from} -> ${to}` };
  return { ok: true };
}

// ------------------------------------------------------------ failure table

export const DELIVERY_FAILURES = [
  "RUN_NOT_VERIFIED", "RUN_NOT_DELIVERY_ELIGIBLE", "DELIVERY_ALREADY_EXISTS",
  "DELIVERY_ALREADY_COMPLETED", "VERIFIED_DIFF_CHANGED", "BASELINE_HEAD_CHANGED",
  "BRANCH_CHANGED", "REMOTE_CHANGED", "UPSTREAM_CHANGED", "APPROVAL_REQUIRED",
  "APPROVAL_REJECTED", "APPROVAL_EXPIRED", "APPROVAL_INVALIDATED", "STAGING_FAILED",
  "STAGED_PATH_MISMATCH", "STAGED_DIFF_MISMATCH", "UNEXPECTED_STAGED_FILE",
  "SECRET_DETECTED", "GIT_IDENTITY_MISSING", "COMMIT_FAILED",
  "POST_COMMIT_VERIFICATION_FAILED", "FETCH_FAILED", "INCOMING_COMMITS_PRESENT",
  "UNRELATED_OUTGOING_COMMITS", "NON_FAST_FORWARD", "PUSH_REJECTED",
  "REMOTE_VERIFICATION_FAILED", "DELIVERY_LEASE_CONFLICT", "DELIVERY_LEASE_LOST",
  "CANCELLED", "INTERNAL_STATE_CONFLICT", "WORKSPACE_INVALID",
];

// Everything a person must look at is NEEDS_DECISION; everything simply wrong is
// FAILED. Nothing is retried automatically, because every one of these is
// resolved by changing the world, not by trying the same thing again.
const FAILURE_OUTCOME = {
  APPROVAL_REQUIRED: "NEEDS_DECISION", APPROVAL_EXPIRED: "NEEDS_DECISION",
  APPROVAL_INVALIDATED: "NEEDS_DECISION", VERIFIED_DIFF_CHANGED: "NEEDS_DECISION",
  BASELINE_HEAD_CHANGED: "NEEDS_DECISION", BRANCH_CHANGED: "NEEDS_DECISION",
  REMOTE_CHANGED: "NEEDS_DECISION", UPSTREAM_CHANGED: "NEEDS_DECISION",
  INCOMING_COMMITS_PRESENT: "NEEDS_DECISION", UNRELATED_OUTGOING_COMMITS: "NEEDS_DECISION",
  NON_FAST_FORWARD: "NEEDS_DECISION", PUSH_REJECTED: "NEEDS_DECISION",
  REMOTE_VERIFICATION_FAILED: "NEEDS_DECISION", POST_COMMIT_VERIFICATION_FAILED: "NEEDS_DECISION",
  FETCH_FAILED: "NEEDS_DECISION", GIT_IDENTITY_MISSING: "NEEDS_DECISION",
  DELIVERY_LEASE_CONFLICT: "NEEDS_DECISION", DELIVERY_ALREADY_COMPLETED: "NEEDS_DECISION",
  CANCELLED: "CANCELLED",
};
export const deliveryOutcomeFor = (code) => FAILURE_OUTCOME[code] ?? "FAILED";

// ------------------------------------------------------------------ events

export const DELIVERY_EVENTS = [
  "delivery.created", "delivery.preflight_started", "delivery.preflight_completed",
  "delivery.diff_revalidated", "delivery.approval_required", "delivery.approved",
  "delivery.approval_invalidated", "delivery.staging_started", "delivery.staging_completed",
  "delivery.staging_rejected", "delivery.commit_started", "delivery.commit_created",
  "delivery.commit_verified", "delivery.fetch_started", "delivery.fetch_completed",
  "delivery.outgoing_inspected", "delivery.remote_branch_created",
  "delivery.push_started", "delivery.push_completed",
  "delivery.remote_verification_started", "delivery.remote_verification_completed",
  "delivery.delivered", "delivery.needs_decision", "delivery.failed", "delivery.cancelled",
  "delivery.lease_acquired", "delivery.lease_released", "delivery.state_changed",
];

const now = () => new Date().toISOString();
const clamp = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) + `\n… [truncated at ${n}]` : String(s ?? ""));

// Delivery evidence is AUTHORIZATION evidence. A diagnostic log may be dropped
// when the disk misbehaves; a record of what was approved and what was pushed
// may not — so unlike run events, this throws rather than swallowing.
export function emitDelivery(deliveryPath, ev) {
  const line = JSON.stringify({ schema_version: SCHEMA_VERSION, event_id: "DEV-" + randomBytes(6).toString("hex"), timestamp: now(), ...ev });
  mkdirSync(deliveryPath, { recursive: true });
  appendFileSync(join(deliveryPath, "events.jsonl"), line + "\n");
}

export const readDeliveryEvents = (deliveryPath) => {
  try {
    return readFileSync(join(deliveryPath, "events.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

// --------------------------------------------------------------- approval

export const APPROVAL_STATES = ["NO_APPROVAL_REQUIRED", "PENDING", "APPROVED", "REJECTED", "EXPIRED", "INVALIDATED"];
const DEFAULT_APPROVAL_TTL_MS = 60 * 60 * 1000;

// Fail-closed by default. An irreversible push to a shared remote is not
// something to opt INTO approving; a project or task may lower this
// deliberately, and nothing lowers it by accident.
export function approvalPolicy(project, task) {
  const p = project?.delivery ?? {};
  const t = task?.delivery ?? {};
  return {
    approval_before_commit: t.approval_before_commit ?? p.approval_before_commit ?? true,
    approval_before_push: t.approval_before_push ?? p.approval_before_push ?? true,
    ttl_ms: Number(t.approval_ttl_ms ?? p.approval_ttl_ms ?? DEFAULT_APPROVAL_TTL_MS),
  };
}

// An approval is a signature over a specific candidate. Change any part of what
// was approved and the signature stops matching — which is the whole point:
// yesterday's yes must never authorize today's different diff.
export const approvalSubject = (tx) => ({
  delivery_id: tx.delivery_id, run_id: tx.run_id,
  baseline_head: tx.baseline_head, branch: tx.branch,
  verified_diff_hash: tx.verified_diff_hash,
  verification_evidence_hash: tx.verification_evidence_hash,
  commit_message: tx.commit_message, remote: tx.remote, upstream_ref: tx.upstream_ref,
});

export function approvalStatus(tx, at = Date.now()) {
  const a = tx.approval;
  if (!a) return "PENDING";
  if (a.decision === "NO_APPROVAL_REQUIRED") return "NO_APPROVAL_REQUIRED";
  if (a.decision === "REJECTED") return "REJECTED";
  if (C.canonicalHash(a.subject) !== C.canonicalHash(approvalSubject(tx))) return "INVALIDATED";
  if (a.expires_at && new Date(a.expires_at).getTime() < at) return "EXPIRED";
  return a.decision === "APPROVED" ? "APPROVED" : "PENDING";
}

// ---------------------------------------------------------- commit message

const AI_TRAILER = /^(co-authored-by:\s*(claude|chatgpt|copilot|gpt|gemini|openai|anthropic|ai\b)|generated with\b|🤖|assistant:|session[-_ ]?id:|claude[-_ ]session|sch[-_ ]session)/i;
// Anything unprintable except the newlines that separate a subject from a body.
const CONTROL_CHARS = new RegExp("[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]");
const MAX_SUBJECT = 72;

export function validateCommitMessage(message) {
  const problems = [];
  const text = String(message ?? "");
  if (!text.trim()) return ["the commit message is empty"];
  if (CONTROL_CHARS.test(text)) problems.push("the commit message contains control characters");
  const lines = text.split("\n");
  const subject = lines[0];
  if (subject.length > MAX_SUBJECT) problems.push(`the subject is ${subject.length} characters — the limit is ${MAX_SUBJECT}`);
  if (/^\s*#/.test(subject)) problems.push("a subject beginning with # would be stripped by git as a comment");
  if (lines.length > 1 && lines[1].trim() !== "") problems.push("the line after the subject must be blank");
  for (const [i, l] of lines.entries())
    if (AI_TRAILER.test(l.trim())) problems.push(`line ${i + 1} is an AI co-author or session trailer — refused: "${l.trim().slice(0, 60)}"`);
  if (/^--\s*$/m.test(text)) problems.push("the message contains a bare `--` line");
  return problems;
}

const scopeOf = (task) => {
  const raw = task?.category || task?.phaseName || "";
  const s = String(raw).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return s || "task";
};

// Built from TRUSTED task data. The worker's narrative is evidence about the
// worker; it does not get to write the public history of the project. Task, run
// and delivery provenance lives in the transaction record, where it can be as
// long as it needs to be without polluting `git log`.
export function proposeCommitMessage(task, { override = null } = {}) {
  if (override) return String(override).replace(/\s+$/, "");
  const title = String(task?.title ?? "").replace(/\s+/g, " ").trim();
  const prefix = `feat(${scopeOf(task)}): `;
  const room = MAX_SUBJECT - prefix.length;
  return prefix + (title.length > room ? title.slice(0, room - 1).replace(/\s+\S*$/, "") + "…" : title);
}

// ---------------------------------------------------------------- leases

// ONE lease for the whole repository, not one per delivery. Staging, committing
// and pushing are repository-wide acts: a task run starting halfway through them
// would leave work nobody verified sitting in the tree being committed.
export const repoLeasePath = (wsDir) => join(WS.locksDir(wsDir), "repository.json");
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

export function acquireRepoLease(wsDir, { projectId, taskId, runId, deliveryId, ttlMs = 30 * 60 * 1000 }) {
  mkdirSync(WS.locksDir(wsDir), { recursive: true });
  const p = repoLeasePath(wsDir);
  let recovered = null;
  if (existsSync(p)) {
    let held = null;
    try { held = JSON.parse(readFileSync(p, "utf8")); } catch { held = null; }
    const expired = !held?.expires_at || new Date(held.expires_at).getTime() < Date.now();
    const ownerGone = !held?.pid || !pidAlive(Number(held.pid));
    if (!expired && !ownerGone)
      return { ok: false, failure: { code: "DELIVERY_LEASE_CONFLICT", message: `the repository is leased by delivery ${held.delivery_id ?? "?"} (run ${held.run_id}, pid ${held.pid}, expires ${held.expires_at})` }, held };
    try { unlinkSync(p); } catch {}
    recovered = held;   // stale: recovered, and said out loud rather than silently taken
  }
  const lease = {
    schema_version: SCHEMA_VERSION, kind: "delivery", project_id: projectId, task_id: String(taskId),
    run_id: runId, delivery_id: deliveryId, pid: process.pid,
    acquired_at: now(), heartbeat_at: now(), expires_at: new Date(Date.now() + ttlMs).toISOString(),
  };
  WS.writeAtomic(p, JSON.stringify(lease, null, 2));
  return { ok: true, lease, recovered };
}

export function releaseRepoLease(wsDir, deliveryId) {
  const p = repoLeasePath(wsDir);
  try {
    const held = JSON.parse(readFileSync(p, "utf8"));
    if (held.delivery_id !== deliveryId) return { released: false, reason: "DELIVERY_LEASE_LOST" };
  } catch { return { released: false, reason: "already gone" }; }
  try { unlinkSync(p); return { released: true }; } catch (e) { return { released: false, reason: e.message }; }
}

// Read-only: is a live delivery holding the repository? The RUN preflight asks
// this so a worker cannot start editing files while a commit is being pushed.
export function liveRepoLease(wsDir) {
  const p = repoLeasePath(wsDir);
  if (!existsSync(p)) return null;
  let held = null;
  try { held = JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
  const live = held?.expires_at && new Date(held.expires_at).getTime() > Date.now() && held.pid && pidAlive(Number(held.pid));
  return live ? held : null;
}

// ------------------------------------------------------------ transaction

export const newDeliveryId = () =>
  "DELIVERY-" + new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") + "-" + randomBytes(4).toString("hex");

export const deliveryPathFor = (wsDir, runId) => WS.deliveryDir(wsDir, runId);
export const transactionPath = (deliveryPath) => join(deliveryPath, "transaction.json");
export const readTransaction = (deliveryPath) => {
  try { return JSON.parse(readFileSync(transactionPath(deliveryPath), "utf8")); } catch { return null; }
};
const writeTransaction = (deliveryPath, tx) => {
  mkdirSync(deliveryPath, { recursive: true });
  WS.writeAtomic(transactionPath(deliveryPath), JSON.stringify(tx, null, 2));
};

// --------------------------------------------------- resolving the workspace

// `workRoot` is the checkout the commit is made in — a task's disposable
// worktree, not the operator's working tree. The WORKSPACE is still the
// project's own: runs, deliveries and the repository lease all live in the main
// repository, so a second checkout never gets a second set of records.
function resolveTarget(projectId, workRoot = null) {
  const project = getProject(projectId);
  if (!project) return { ok: false, failure: { code: "WORKSPACE_INVALID", message: `no registered project "${projectId}"` } };
  const ws = WS.validateWorkspace({ projectId, repoPath: project.path });
  if (!ws.ok) return { ok: false, failure: { code: "WORKSPACE_INVALID", message: ws.problems.map((p) => p.message).join("; ") } };
  const root = workRoot ? WS.repositoryRoot(workRoot) : ws.root;
  if (workRoot && !root) return { ok: false, failure: { code: "WORKSPACE_INVALID", message: `workRoot ${workRoot} is not a git repository` } };
  return { ok: true, project, repoRoot: root, mainRoot: ws.root, wsDir: ws.dir };
}

// ----------------------------------------------------------------- approval

// Operator approval, bound to the exact candidate on record. Recomputes nothing
// about the repository: it signs what the transaction says, and the controller
// re-checks that the transaction still matches the repository before it acts.
export function approveDelivery(projectId, runId, { approver, decision = "APPROVED", message = null, ttlMs = null, why = "" }) {
  const t = resolveTarget(projectId);
  if (!t.ok) return { ok: false, failure: t.failure };
  const dp = deliveryPathFor(t.wsDir, runId);
  const tx = readTransaction(dp);
  if (!tx) return { ok: false, failure: { code: "RUN_NOT_DELIVERY_ELIGIBLE", message: `no delivery transaction for run ${runId} — start one with sch-deliver-run.mjs` } };
  if (TERMINAL_STATES.has(tx.state) && tx.state !== "NEEDS_DECISION")
    return { ok: false, failure: { code: "DELIVERY_ALREADY_COMPLETED", message: `delivery ${tx.delivery_id} is already ${tx.state}` } };
  if (!approver) return { ok: false, failure: { code: "APPROVAL_REQUIRED", message: "an approval needs --approver: an approval nobody signed is not an approval" } };
  if (!["APPROVED", "REJECTED"].includes(decision))
    return { ok: false, failure: { code: "APPROVAL_REQUIRED", message: `decision must be APPROVED or REJECTED, not "${decision}"` } };

  // Approving a different message than the one on record is a different
  // approval, so the message is updated first and then signed with everything else.
  if (message) {
    const problems = validateCommitMessage(message);
    if (problems.length) return { ok: false, failure: { code: "APPROVAL_REQUIRED", message: `the approved commit message is invalid: ${problems.join("; ")}` } };
    tx.commit_message = message;
  }
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_APPROVAL_TTL_MS;
  tx.approval = {
    decision, approver: String(approver), why: String(why ?? ""),
    at: now(), expires_at: new Date(Date.now() + ttl).toISOString(),
    subject: approvalSubject(tx),
  };
  tx.updated_at = now();
  writeTransaction(dp, tx);
  emitDelivery(dp, {
    project_id: projectId, task_id: tx.task_id, run_id: runId, delivery_id: tx.delivery_id,
    type: decision === "APPROVED" ? "delivery.approved" : "delivery.failed",
    actor: { kind: "human", id: String(approver) },
    payload: { decision, expires_at: tx.approval.expires_at, commit_message: tx.commit_message, subject_hash: C.canonicalHash(tx.approval.subject) },
  });
  auditLog({ kind: "delivery", project: projectId, run: runId, delivery: tx.delivery_id, event: "approval", decision, approver: String(approver) });
  return { ok: true, approval: tx.approval, state: approvalStatus(tx), commit_message: tx.commit_message };
}

export function cancelDelivery(projectId, runId, reason = "operator cancelled") {
  const t = resolveTarget(projectId);
  if (!t.ok) return { ok: false, failure: t.failure };
  const dp = deliveryPathFor(t.wsDir, runId);
  const tx = readTransaction(dp);
  if (!tx) return { ok: false, failure: { code: "RUN_NOT_DELIVERY_ELIGIBLE", message: `no delivery transaction for run ${runId}` } };
  if (tx.state === "DELIVERED")
    return { ok: false, failure: { code: "DELIVERY_ALREADY_COMPLETED", message: `delivery ${tx.delivery_id} already reached the remote — a delivered commit is never withdrawn automatically` } };
  tx.state = "CANCELLED"; tx.failure = { code: "CANCELLED", message: String(reason) }; tx.updated_at = now();
  writeTransaction(dp, tx);
  emitDelivery(dp, { project_id: projectId, task_id: tx.task_id, run_id: runId, delivery_id: tx.delivery_id,
    type: "delivery.cancelled", actor: { kind: "human", id: "operator" }, payload: { reason: String(reason) } });
  releaseRepoLease(t.wsDir, tx.delivery_id);
  auditLog({ kind: "delivery", project: projectId, run: runId, delivery: tx.delivery_id, event: "cancelled", reason: String(reason) });
  return { ok: true, delivery_id: tx.delivery_id, state: tx.state };
}

// ------------------------------------------------------------- THE CONTROLLER

export function deliverRun({ projectId, runId, env = process.env, commitMessageOverride = null, onEvent = null, workRoot = null }) {
  const started = Date.now();
  const target = resolveTarget(projectId, workRoot);
  if (!target.ok) return { ok: false, state: "FAILED", failure: target.failure, delivery_id: null };
  const { project, repoRoot, mainRoot, wsDir } = target;

  const run = readRun(projectId, runId);
  if (!run?.run) return { ok: false, state: "FAILED", delivery_id: null,
    failure: { code: "RUN_NOT_DELIVERY_ELIGIBLE", message: `no run ${runId} under ${WS.runsDir(wsDir)}` } };

  const taskId = run.run.task_id;
  const dp = deliveryPathFor(wsDir, runId);
  const existing = readTransaction(dp);
  if (existing && existing.state === "DELIVERED")
    return { ok: false, state: "DELIVERED", delivery_id: existing.delivery_id,
      failure: { code: "DELIVERY_ALREADY_COMPLETED", message: `run ${runId} was already delivered as ${existing.commit?.hash} — a delivered commit is never re-delivered` } };

  // An earlier attempt that stopped for a decision is RESUMED (its approval and
  // evidence are still on record) rather than silently replaced.
  const deliveryId = existing?.delivery_id ?? newDeliveryId();
  mkdirSync(dp, { recursive: true });
  for (const d of ["stdout", "stderr"]) mkdirSync(join(dp, d), { recursive: true });

  let tx = existing ?? {
    schema_version: SCHEMA_VERSION, delivery_id: deliveryId,
    project_id: projectId, task_id: String(taskId), run_id: runId,
    state: "CREATED", baseline_head: null, branch: null, remote: null, upstream_ref: null,
    verified_effects_hash: null, verified_diff_hash: null, verified_paths: [],
    verification_evidence_hash: null, commit_message: null, approval: null,
    commit: null, push: null, failure: null,
    created_at: now(), updated_at: now(),
  };
  if (TERMINAL_STATES.has(tx.state)) { tx.state = "CREATED"; tx.failure = null; }

  const ev = (type, payload = {}, actor = { kind: "system", id: "sch-delivery" }) => {
    const rec = { project_id: projectId, task_id: String(taskId), run_id: runId, delivery_id: deliveryId, type, actor, payload };
    emitDelivery(dp, rec);                                    // fail-closed on purpose
    if (onEvent) { try { onEvent(rec); } catch {} }
  };
  const artifact = (name, obj) => WS.writeAtomic(join(dp, name), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  const capture = (stream, name, text) => { try { WS.writeAtomic(join(dp, stream, name), String(text ?? "")); } catch {} };

  const move = (to, actor = "controller") => {
    const check = canTransition(tx.state, to, actor);
    if (!check.ok) throw new Error(`INTERNAL_STATE_CONFLICT: ${check.why}`);
    const from = tx.state;
    tx.state = to; tx.updated_at = now();
    writeTransaction(dp, tx);
    ev("delivery.state_changed", { from, to, actor });
  };

  let leaseHeld = false;
  const stop = (code, message, extra = {}) => {
    const outcome = deliveryOutcomeFor(code);
    tx = { ...tx, ...extra, state: outcome, failure: { code, message }, updated_at: now() };
    writeTransaction(dp, tx);
    ev(outcome === "CANCELLED" ? "delivery.cancelled" : outcome === "NEEDS_DECISION" ? "delivery.needs_decision" : "delivery.failed",
      { code, message: clamp(message, 2000) });
    if (leaseHeld) { ev("delivery.lease_released", releaseRepoLease(wsDir, deliveryId)); leaseHeld = false; }
    auditLog({ kind: "delivery", project: projectId, task: String(taskId), run: runId, delivery: deliveryId, event: "outcome", state: outcome, failure: code });
    return { ok: false, state: outcome, failure: { code, message }, delivery_id: deliveryId, delivery_dir: dp, transaction: tx, duration_ms: Date.now() - started };
  };

  ev("delivery.created", { run_id: runId, task_id: String(taskId), resumed: !!existing });
  writeTransaction(dp, tx);
  auditLog({ kind: "delivery", project: projectId, task: String(taskId), run: runId, delivery: deliveryId, event: "created" });

  try {
    // ---------------------------------------------------------- 1. PREFLIGHT
    move("PREFLIGHT");
    ev("delivery.preflight_started");

    if (run.run.outcome !== "VERIFIED")
      return stop("RUN_NOT_VERIFIED", `run ${runId} is ${run.run.outcome ?? "unfinished"}, not VERIFIED — only a verified run is deliverable`);
    if (!run.candidate)
      return stop("RUN_NOT_DELIVERY_ELIGIBLE", `run ${runId} has no delivery candidate recorded (delivery-candidate.json). It predates the delivery controller: re-run the task so the verified content is bound to a hash.`);

    const state = loadState(projectId);
    const task = state.tasks.find((x) => x.id === Number(taskId));
    if (!task) return stop("RUN_NOT_DELIVERY_ELIGIBLE", `run ${runId} refers to task #${taskId}, which no longer exists`);
    if (task.status === "delivered")
      return stop("DELIVERY_ALREADY_COMPLETED", `task #${taskId} is already delivered (${task.delivery?.commit ?? "?"})`);

    // Repository identity: the run's evidence must belong to THIS repository.
    const verified = run.candidate;
    const recomputed = C.computeCandidate({
      repoRoot, projectId, taskId, runId,
      baseline: run.baseline, verification: run.verification, promptManifest: run.prompt_manifest,
      policy: { allowed: task.allowedPaths ?? [], forbidden: task.forbiddenPaths ?? [], controlCategory: task.controlCategory ?? null },
      outcome: run.run.outcome, verifiedAt: run.run.ended_at,
    });
    if (!recomputed.ok) return stop(recomputed.failure.code, recomputed.failure.message);
    const current = recomputed.candidate;
    artifact("approved-effects.json", { verified, recomputed: current });

    if (verified.repository_identity !== current.repository_identity)
      return stop("INTERNAL_STATE_CONFLICT", "this run's evidence was recorded against a different repository");

    // THE BINDING. Anything that moved between verification and now means the
    // thing that was verified is not the thing about to be pushed.
    const drift = C.compareCandidates(verified, current);
    ev("delivery.diff_revalidated", {
      matches: drift.length === 0,
      verified_diff_hash: verified.verified_diff_hash,
      current_diff_hash: current.verified_diff_hash,
      drift: drift.map((d) => d.code),
    });
    if (drift.length) return stop(drift[0].code, drift[0].message, { verified_diff_hash: verified.verified_diff_hash });

    if (!current.changed_paths.length)
      return stop("RUN_NOT_DELIVERY_ELIGIBLE", `run ${runId} has nothing to deliver — the working tree matches HEAD`);

    // Remote and upstream, pinned. Neither the task nor the worker chooses these.
    const branch = current.branch;
    const remote = C.gitOut(repoRoot, "config", `branch.${branch}.remote`)
      || (C.gitOut(repoRoot, "remote") ?? "").split("\n").filter(Boolean)[0] || null;
    if (!remote) return stop("UPSTREAM_CHANGED", `branch "${branch}" has no configured remote — configure one and approve the delivery explicitly`);
    const remoteUrl = C.gitOut(repoRoot, "remote", "get-url", remote);
    if (!remoteUrl) return stop("REMOTE_CHANGED", `remote "${remote}" has no URL`);
    if (C.hasCredentials(remoteUrl))
      return stop("REMOTE_CHANGED", `the remote URL for "${remote}" carries credentials — SCH refuses to push through a credential-bearing URL. Use a credential helper.`);
    const upstreamRef = C.gitOut(repoRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
    const remoteBranch = (C.gitOut(repoRoot, "config", `branch.${branch}.merge`) || "").replace(/^refs\/heads\//, "") || branch;
    if (upstreamRef && upstreamRef !== `${remote}/${remoteBranch}`)
      return stop("UPSTREAM_CHANGED", `the upstream is "${upstreamRef}" but this delivery targets "${remote}/${remoteBranch}"`);

    // The branch this one FORKED FROM. It is only consulted on a first push,
    // where there is no remote branch to measure against and a task branch's
    // whole history would otherwise read as outgoing. A task worktree is cut
    // from the main repository's HEAD, so the main repository's branch is the
    // first candidate; the remote's default branch and the target branch follow.
    //
    // The candidate is chosen by whether `<remote>/<candidate>` RESOLVES, not by
    // whether it is a plausible name. A main checkout sitting on a local-only
    // branch names something the remote has never heard of, and measuring
    // against a ref that does not exist would make every first push report the
    // branch's entire history as outgoing — fail-closed, but for a reason no
    // operator could read off the message.
    const remoteDefault = C.gitOut(repoRoot, "symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`) ?? "";
    const baseCandidates = [
      C.gitOut(mainRoot, "rev-parse", "--abbrev-ref", "HEAD"),
      remoteDefault.startsWith(`${remote}/`) ? remoteDefault.slice(remote.length + 1) : null,
      remoteBranch,
    ];
    const baseRemoteBranch = baseCandidates.find((b) =>
      b && b !== "HEAD" && C.gitOut(repoRoot, "rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${b}`)) ?? remoteBranch;

    // A baseline recorded against a different branch or head is not this one.
    if (run.baseline?.repository?.branch && run.baseline.repository.branch !== branch)
      return stop("BRANCH_CHANGED", `the run was verified on "${run.baseline.repository.branch}" and the repository is on "${branch}"`);

    const message = proposeCommitMessage(task, { override: commitMessageOverride ?? tx.commit_message });
    const msgProblems = validateCommitMessage(message);
    if (msgProblems.length) return stop("COMMIT_FAILED", `the proposed commit message is invalid: ${msgProblems.join("; ")}`);

    Object.assign(tx, {
      baseline_head: current.head, branch, remote, upstream_ref: upstreamRef ?? `${remote}/${remoteBranch}`,
      remote_branch: remoteBranch, base_remote_branch: baseRemoteBranch,
      remote_url_redacted: C.redactRemote(remoteUrl),
      verified_effects_hash: current.verified_effects_hash,
      verified_diff_hash: current.verified_diff_hash,
      verification_evidence_hash: current.verification_evidence_hash,
      verified_paths: current.changed_paths,
      commit_message: message,
    });
    artifact("preflight.json", {
      checked_at: now(), ok: true, branch, remote, upstream_ref: tx.upstream_ref,
      remote_url_redacted: tx.remote_url_redacted, commit_message: message,
      verified_paths: current.changed_paths,
      hashes: { effects: current.verified_effects_hash, diff: current.verified_diff_hash, evidence: current.verification_evidence_hash },
    });
    writeTransaction(dp, tx);
    ev("delivery.preflight_completed", { branch, remote, upstream_ref: tx.upstream_ref, paths: current.changed_paths.length, commit_message: message });

    // ------------------------------------------------------------ 2. LEASE
    const lease = acquireRepoLease(wsDir, { projectId, taskId, runId, deliveryId });
    if (!lease.ok) return stop(lease.failure.code, lease.failure.message);
    leaseHeld = true;
    ev("delivery.lease_acquired", { expires_at: lease.lease.expires_at, recovered_stale: lease.recovered?.delivery_id ?? null });

    // --------------------------------------------------------- 3. APPROVAL
    const policy = approvalPolicy(project, task);
    if (policy.approval_before_commit) {
      const status = approvalStatus(tx);
      if (status !== "APPROVED") {
        if (status === "REJECTED") return stop("APPROVAL_REJECTED", `delivery ${deliveryId} was rejected by ${tx.approval.approver}: ${tx.approval.why || "(no reason given)"}`);
        if (status === "EXPIRED") return stop("APPROVAL_EXPIRED", `the approval for delivery ${deliveryId} expired at ${tx.approval.expires_at} — approve it again`);
        if (status === "INVALIDATED") {
          ev("delivery.approval_invalidated", { reason: "the approved subject no longer matches the transaction" });
          return stop("APPROVAL_INVALIDATED", `the approval for delivery ${deliveryId} was given for a different diff, branch, remote or message — approve the current one`);
        }
        move("AWAITING_APPROVAL");
        ev("delivery.approval_required", { commit_message: tx.commit_message, paths: tx.verified_paths, subject_hash: C.canonicalHash(approvalSubject(tx)) });
        return stop("APPROVAL_REQUIRED",
          `delivery ${deliveryId} needs approval before it may commit.\n` +
          `  message: ${tx.commit_message}\n` +
          `  paths:   ${tx.verified_paths.join(", ")}\n` +
          `  target:  ${tx.remote}/${tx.remote_branch}\n` +
          `  approve: node scripts/state.mjs delivery-approve --project ${projectId} --run ${runId} --approver <you>`);
      }
    } else if (!tx.approval) {
      tx.approval = { decision: "NO_APPROVAL_REQUIRED", approver: "policy", at: now(), expires_at: null, subject: approvalSubject(tx) };
      writeTransaction(dp, tx);
    }

    // ---------------------------------------------------------- 4. STAGING
    move("STAGING");
    ev("delivery.staging_started", { paths: tx.verified_paths });

    // Nothing may already be staged: an operator's half-finished `git add` must
    // never ride along inside a delivery commit.
    const preStaged = C.stagedManifest(repoRoot);
    if (!preStaged.ok) return stop("STAGING_FAILED", `cannot read the index: ${preStaged.error}`);
    if (preStaged.entries.length)
      return stop("UNEXPECTED_STAGED_FILE", `the index already contains ${preStaged.entries.length} staged change(s) that this delivery did not stage: ${preStaged.entries.map((e) => e.path).join(", ")}. Resolve them first; SCH will not commit work it did not verify.`);

    // EXPLICIT pathspecs, always after `--`, so a filename beginning with `-` is
    // a filename and a filename containing a space is one argument.
    const add = C.gitRun(repoRoot, ["add", "--", ...tx.verified_paths]);
    capture("stdout", "git-add.log", add.stdout); capture("stderr", "git-add.log", add.stderr);
    if (!add.ok) return stop("STAGING_FAILED", `git add failed (${add.code}): ${clamp(add.stderr, 1000)}`);

    const staged = C.stagedManifest(repoRoot);
    if (!staged.ok) return stop("STAGING_FAILED", `cannot read the index after staging: ${staged.error}`);
    const stagedProblems = C.compareStaged(current, staged);
    // Nothing approved may be left behind in the worktree either.
    const leftover = C.worktreeManifest(repoRoot);
    const unstagedApproved = leftover.ok
      ? leftover.entries.filter((e) => tx.verified_paths.includes(e.path) && staged.entries.every((s) => s.path !== e.path)).map((e) => e.path)
      : [];
    if (unstagedApproved.length)
      stagedProblems.push({ code: "STAGED_PATH_MISMATCH", message: `approved but still unstaged: ${unstagedApproved.join(", ")}` });

    artifact("staging.json", {
      staged_at: now(), approved: tx.verified_paths,
      staged: staged.entries, problems: stagedProblems,
      name_status: C.gitRun(repoRoot, ["diff", "--cached", "--name-status", "-z"]).stdout.split("\0").filter(Boolean),
      porcelain_v2: C.gitRun(repoRoot, ["status", "--porcelain=v2", "-z"]).stdout.split("\0").filter(Boolean),
    });

    if (stagedProblems.length) {
      ev("delivery.staging_rejected", { problems: stagedProblems.map((p) => `${p.code}: ${p.message}` ) });
      // Compensation, bounded: unstage ONLY what this transaction staged, and
      // only when the index held nothing before it. Working-tree content is
      // never touched — a failed delivery must not destroy the work.
      const undo = C.gitRun(repoRoot, ["restore", "--staged", "--", ...tx.verified_paths]);
      artifact("staging-rollback.json", { attempted: true, ok: undo.ok, code: undo.code, stderr: clamp(undo.stderr, 500), unstaged: tx.verified_paths });
      return stop(stagedProblems[0].code, stagedProblems.map((p) => p.message).join("; "));
    }

    // ------------------------------------------------------- 5. SECRET GATE
    const scan = spawnSync(process.execPath, [join(REPO, "scripts", "secret-scan.mjs")],
      { cwd: repoRoot, encoding: "utf8", windowsHide: true, env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
    capture("stdout", "secret-scan.log", scan.stdout); capture("stderr", "secret-scan.log", scan.stderr);
    if (scan.status !== 0) {
      const undo = C.gitRun(repoRoot, ["restore", "--staged", "--", ...tx.verified_paths]);
      artifact("secret-scan.json", { blocked: true, exit_code: scan.status, stdout: clamp(scan.stdout, 4000), stderr: clamp(scan.stderr, 4000), unstaged: undo.ok });
      return stop("SECRET_DETECTED", `the staged content did not pass the secret gate — nothing was committed:\n${clamp(scan.stderr || scan.stdout, 1500)}`);
    }
    artifact("secret-scan.json", { blocked: false, exit_code: 0, stdout: clamp(scan.stdout, 2000) });

    move("STAGED");
    ev("delivery.staging_completed", { staged: staged.entries.map((e) => `${e.status} ${e.path}`) });

    // ----------------------------------------------------------- 6. COMMIT
    move("COMMITTING");
    // Everything re-checked at the last possible moment: an approval, a head and
    // a branch that were right two seconds ago may not be right now.
    if (approvalStatus(tx) === "INVALIDATED") return stop("APPROVAL_INVALIDATED", "the approval stopped matching this transaction before the commit");
    const headNow = C.gitOut(repoRoot, "rev-parse", "HEAD");
    if (headNow !== tx.baseline_head) return stop("BASELINE_HEAD_CHANGED", `HEAD moved from ${tx.baseline_head} to ${headNow} while this delivery was preparing`);
    const branchNow = C.gitOut(repoRoot, "rev-parse", "--abbrev-ref", "HEAD");
    if (branchNow !== tx.branch) return stop("BRANCH_CHANGED", `the branch moved from "${tx.branch}" to "${branchNow}" while this delivery was preparing`);
    // `git var GIT_AUTHOR_IDENT` is the authoritative answer across every config
    // scope — reading `user.name` alone would miss a perfectly valid global
    // identity, and would also accept an empty one that git itself refuses.
    const ident = C.gitRun(repoRoot, ["var", "GIT_AUTHOR_IDENT"]);
    if (!ident.ok) return stop("GIT_IDENTITY_MISSING", `git cannot determine an author identity — SCH will not commit anonymously: ${clamp(ident.stderr, 300)}`);
    const who = C.gitOut(repoRoot, "config", "user.name"), mail = C.gitOut(repoRoot, "config", "user.email");
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"])
      if (existsSync(join(repoRoot, ".git", marker))) return stop("INTERNAL_STATE_CONFLICT", `a git operation (${marker}) is in progress — resolve it before delivering`);

    ev("delivery.commit_started", { message: tx.commit_message });
    // The message arrives on stdin via -F -, so a message can never be mistaken
    // for an option however it begins.
    const commit = C.gitRun(repoRoot, ["commit", "--no-verify", "--file", "-", "--cleanup=verbatim"], { input: tx.commit_message + "\n" });
    capture("stdout", "git-commit.log", commit.stdout); capture("stderr", "git-commit.log", commit.stderr);
    if (!commit.ok) return stop("COMMIT_FAILED", `git commit failed (${commit.code}): ${clamp(commit.stderr || commit.stdout, 1000)}`);

    const hash = C.gitOut(repoRoot, "rev-parse", "HEAD");
    const parents = (C.gitOut(repoRoot, "rev-list", "--parents", "-n", "1", "HEAD") ?? "").split(" ").slice(1);
    const tree = C.gitOut(repoRoot, "rev-parse", "HEAD^{tree}");
    tx.commit = {
      hash, parents, tree, subject: tx.commit_message.split("\n")[0],
      // Author identity is recorded as configured, because a commit that claims
      // a person is a fact about the repository, not a secret.
      author_name: who ?? null, author_email: mail ?? null,
      committed_at: C.gitOut(repoRoot, "show", "-s", "--format=%cI", "HEAD"),
      files: (C.gitRun(repoRoot, ["diff", "--name-status", "-z", `${tx.baseline_head}`, hash]).stdout || "").split("\0").filter(Boolean),
      exit_code: commit.code,
    };
    artifact("commit.json", tx.commit);
    move("COMMITTED");
    ev("delivery.commit_created", { hash, parents, tree });
    auditLog({ kind: "delivery", project: projectId, task: String(taskId), run: runId, delivery: deliveryId, event: "commit", commit: hash });

    // -------------------------------------------------- 7. POST-COMMIT CHECK
    const postProblems = [];
    if (parents.length !== 1) postProblems.push(`the commit has ${parents.length} parents — exactly one was expected`);
    if (parents[0] !== tx.baseline_head) postProblems.push(`the commit's parent is ${parents[0]}, not the verified baseline ${tx.baseline_head}`);
    // Exactly the approved tree changes, compared by blob identity.
    // --abbrev=40: `git diff --raw` shortens blob ids by default, and a
    // seven-character prefix compared against a full hash never matches — which
    // would have made every post-commit check fail for the wrong reason.
    const changed = C.gitRun(repoRoot, ["diff", "--raw", "--abbrev=40", "-z", "--no-renames", tx.baseline_head, hash]);
    const rawEntries = (changed.stdout || "").split("\0").filter(Boolean);
    const committedPaths = [];
    for (let i = 0; i < rawEntries.length; i += 2) {
      const meta = rawEntries[i], p = rawEntries[i + 1];
      if (!meta?.startsWith(":")) continue;
      const f = meta.slice(1).split(" ");
      committedPaths.push({ path: p, mode_after: f[1], blob_after: f[3], status: (f[4] ?? "").trim() });
    }
    const wantPaths = new Set(current.entries.map((e) => e.path));
    for (const c of committedPaths) if (!wantPaths.has(c.path)) postProblems.push(`the commit contains "${c.path}", which was never part of the verified candidate`);
    for (const e of current.entries) {
      const c = committedPaths.find((x) => x.path === e.path);
      if (!c) { postProblems.push(`the commit is missing "${e.path}"`); continue; }
      if (e.status !== "D" && c.blob_after !== e.blob) postProblems.push(`"${e.path}" was committed as ${c.blob_after} but the verified content is ${e.blob}`);
    }
    // Nothing unexplained may remain in the tree: exactly the ignored runtime
    // artifacts SCH itself wrote, and nothing else.
    const after = C.worktreeManifest(repoRoot);
    const residue = after.ok ? after.entries.map((e) => e.path) : [];
    if (residue.length) postProblems.push(`the working tree still shows changes after the commit: ${residue.join(", ")}`);

    artifact("post-commit.json", { checked_at: now(), ok: postProblems.length === 0, parents, tree, committed: committedPaths, residue, problems: postProblems });
    if (postProblems.length) {
      // The commit EXISTS. It is not amended, reset or rewritten — a person
      // decides what a commit that does not match its candidate means.
      ev("delivery.needs_decision", { after: "commit", problems: postProblems });
      return stop("POST_COMMIT_VERIFICATION_FAILED",
        `commit ${hash} was created but does not match the verified candidate, and has NOT been amended, reset or pushed: ${postProblems.join("; ")}`,
        { commit: tx.commit });
    }
    ev("delivery.commit_verified", { hash, files: committedPaths.length });
    ev("delivery.diff_revalidated", { after: "commit", matches: true });

    // ------------------------------------------------------------ 8. FETCH
    move("FETCHING");
    ev("delivery.fetch_started", { remote: tx.remote, branch: tx.remote_branch });
    const fetch = C.gitRun(repoRoot, ["fetch", "--no-tags", tx.remote,
      `+refs/heads/${tx.remote_branch}:refs/remotes/${tx.remote}/${tx.remote_branch}`]);
    capture("stdout", "git-fetch.log", fetch.stdout); capture("stderr", "git-fetch.log", fetch.stderr);
    // A branch that does not exist on the remote yet is not a fetch failure —
    // it is a first push, and it needs a decision rather than a guess.
    const remoteMissing = !fetch.ok && /couldn't find remote ref|no such ref|not our ref/i.test(fetch.stderr);
    if (!fetch.ok && !remoteMissing)
      return stop("FETCH_FAILED", `git fetch ${tx.remote} failed (${fetch.code}): ${clamp(fetch.stderr, 1000)}`, { commit: tx.commit });
    ev("delivery.fetch_completed", { ok: fetch.ok, remote_branch_missing: remoteMissing });

    // ------------------------------------------- 9. DIVERGENCE / OUTGOING
    move("CHECKING_OUTGOING");
    const remoteRef = `refs/remotes/${tx.remote}/${tx.remote_branch}`;
    // Ask the REMOTE whether the branch exists, not the local tracking ref: a
    // stale `refs/remotes/...` survives a branch being deleted upstream, and
    // trusting it would turn "the branch is gone" into an implicit re-creation.
    const ls = C.gitRun(repoRoot, ["ls-remote", "--heads", tx.remote, `refs/heads/${tx.remote_branch}`]);
    // An ls-remote that ERRORED answered nothing. Reading it as "the branch is
    // absent" would send a branch the remote really does have down the
    // first-push path, past the incoming and fast-forward checks.
    if (!ls.ok)
      return stop("FETCH_FAILED",
        `git ls-remote ${tx.remote} failed (${ls.code}), so whether "${tx.remote_branch}" exists there is unknown. Commit ${hash} is NOT pushed: ${clamp(ls.stderr || ls.stdout, 1000)}`,
        { commit: tx.commit });
    const remoteHead = ls.stdout.trim() !== "" ? C.gitOut(repoRoot, "rev-parse", "--verify", "--quiet", remoteRef) : null;
    const localHead = C.gitOut(repoRoot, "rev-parse", "HEAD");
    let outgoing = [], incoming = [], mergeBase = null, ahead = 0, behind = 0;
    if (remoteHead) {
      mergeBase = C.gitOut(repoRoot, "merge-base", "HEAD", remoteRef);
      outgoing = (C.gitOut(repoRoot, "rev-list", `${remoteRef}..HEAD`) ?? "").split("\n").filter(Boolean);
      incoming = (C.gitOut(repoRoot, "rev-list", `HEAD..${remoteRef}`) ?? "").split("\n").filter(Boolean);
      ahead = outgoing.length; behind = incoming.length;
    } else {
      // No remote branch. What counts as "outgoing" is what this branch adds on
      // top of the base it forked from — not its entire history. With no shared
      // history to fork from there is nothing to subtract, and the whole branch
      // stays outgoing so the one-commit check below still fails closed.
      const baseRef = `${tx.remote}/${tx.base_remote_branch}`;
      mergeBase = C.gitOut(repoRoot, "merge-base", "HEAD", baseRef);
      outgoing = (C.gitOut(repoRoot, "rev-list", mergeBase ? `${mergeBase}..HEAD` : "HEAD") ?? "").split("\n").filter(Boolean);
      ahead = outgoing.length;
    }
    artifact("outgoing.json", {
      inspected_at: now(), remote: tx.remote, remote_branch: tx.remote_branch, remote_ref: remoteRef,
      remote_head: remoteHead, local_head: localHead, merge_base: mergeBase, ahead, behind,
      outgoing: outgoing.map((c) => ({ hash: c, subject: C.gitOut(repoRoot, "show", "-s", "--format=%s", c) })),
      incoming: incoming.map((c) => ({ hash: c, subject: C.gitOut(repoRoot, "show", "-s", "--format=%s", c) })),
    });
    ev("delivery.outgoing_inspected", { ahead, behind, outgoing, incoming, remote_head: remoteHead });

    // Creating a remote branch is STILL an explicit decision. The decision was
    // just made once, over a namespace, instead of once per task — outside that
    // namespace this stops exactly as it always did.
    const ns = state.delivery?.branch_namespace ?? null;
    const nsOk = !remoteHead && WT.branchMatchesNamespace(ns, tx.remote_branch);
    if (!remoteHead && !nsOk)
      return stop("UPSTREAM_CHANGED",
        `"${tx.remote_branch}" does not exist on "${tx.remote}". Commit ${hash} is created locally and NOT pushed — creating a remote branch is an explicit decision, not something SCH does on your behalf.\n` +
        `  authorize a namespace: node scripts/state.mjs delivery-branch-namespace --project ${projectId} --set "sch/task-*" --approver <you>`,
        { commit: tx.commit });
    // Both of these compare against a remote branch, so neither has anything to
    // say about a branch the remote has never seen.
    if (remoteHead) {
      if (incoming.length)
        return stop("INCOMING_COMMITS_PRESENT",
          `${incoming.length} commit(s) exist on ${tx.remote}/${tx.remote_branch} that are not local. Commit ${hash} is NOT pushed and nothing was merged or rebased — integrate them yourself, then deliver again.`,
          { commit: tx.commit });
      if (mergeBase !== remoteHead)
        return stop("NON_FAST_FORWARD", `the local branch has diverged from ${tx.remote}/${tx.remote_branch} (merge base ${mergeBase}) — refusing to push`, { commit: tx.commit });
    }
    if (outgoing.length !== 1)
      return stop("UNRELATED_OUTGOING_COMMITS",
        `${outgoing.length} commit(s) would be pushed but exactly one — the delivery commit — is permitted: ${outgoing.map((c) => c.slice(0, 8)).join(", ")}. Commit ${hash} is NOT pushed.`,
        { commit: tx.commit });
    if (outgoing[0] !== hash)
      return stop("UNRELATED_OUTGOING_COMMITS", `the single outgoing commit is ${outgoing[0]}, not this delivery's commit ${hash}`, { commit: tx.commit });

    // ------------------------------------------------- 10. APPROVAL TO PUSH
    if (policy.approval_before_push) {
      const status = approvalStatus(tx);
      if (status !== "APPROVED" && status !== "NO_APPROVAL_REQUIRED") {
        move("AWAITING_APPROVAL");
        ev("delivery.approval_required", { before: "push", commit: hash, target: `${tx.remote}/${tx.remote_branch}` });
        return stop(status === "EXPIRED" ? "APPROVAL_EXPIRED" : status === "INVALIDATED" ? "APPROVAL_INVALIDATED" : "APPROVAL_REQUIRED",
          `commit ${hash} is created and verified locally but needs approval before it is pushed to ${tx.remote}/${tx.remote_branch}.\n` +
          `  approve: node scripts/state.mjs delivery-approve --project ${projectId} --run ${runId} --approver <you>`,
          { commit: tx.commit });
      }
    }

    // ------------------------------------------------------------- 11. PUSH
    move("PUSHING");
    const refspec = `refs/heads/${tx.branch}:refs/heads/${tx.remote_branch}`;
    ev("delivery.push_started", { remote: tx.remote, refspec, commit: hash, creates_branch: nsOk });
    const pushStart = now();
    // `--set-upstream` on a first push only, so the branch that was just created
    // tracks the ref it was created as. It moves nothing and rewrites nothing.
    const push = C.gitRun(repoRoot, nsOk
      ? ["push", "--set-upstream", tx.remote, refspec]
      : ["push", tx.remote, refspec]);
    capture("stdout", "git-push.log", push.stdout); capture("stderr", "git-push.log", push.stderr);
    tx.push = {
      command: `git ${push.args.join(" ")}`, remote: tx.remote, refspec, created_branch: nsOk,
      local_ref: `refs/heads/${tx.branch}`, remote_ref: `refs/heads/${tx.remote_branch}`,
      started_at: pushStart, ended_at: now(), exit_code: push.code, ok: push.ok,
      // A branch the remote has never seen has no remote head to range from, so
      // the range starts at the commit it forked from. With no shared history
      // there is no range at all, and this stays null rather than becoming prose.
      pushed_range: (remoteHead ?? mergeBase) ? `${remoteHead ?? mergeBase}..${hash}` : null,
      stdout: clamp(push.stdout, 4000), stderr: clamp(push.stderr, 4000),
    };
    artifact("push.json", tx.push);
    writeTransaction(dp, tx);
    if (!push.ok)
      return stop("PUSH_REJECTED",
        `git push was rejected (${push.code}) and will NOT be retried with force: ${clamp(push.stderr || push.stdout, 1200)}`,
        { commit: tx.commit, push: tx.push });
    move("PUSHED");
    ev("delivery.push_completed", { exit_code: push.code, pushed_range: tx.push.pushed_range });
    // AFTER the push, not before it: a branch is created when the remote accepts
    // the ref, and a record written on the way in would be a claim rather than
    // an event. The independent verification below still has to agree.
    if (nsOk) ev("delivery.remote_branch_created", { branch: tx.remote_branch, namespace_id: ns?.id ?? null, namespace: ns?.pattern ?? null });

    // ------------------------------------------------ 12. REMOTE VERIFICATION
    move("REMOTE_VERIFYING");
    ev("delivery.remote_verification_started", { remote: tx.remote, branch: tx.remote_branch });
    // Push stdout is the pushing process describing its own success. It is not
    // evidence. Ask the remote, independently.
    const refetch = C.gitRun(repoRoot, ["fetch", "--no-tags", tx.remote,
      `+refs/heads/${tx.remote_branch}:refs/remotes/${tx.remote}/${tx.remote_branch}`]);
    capture("stdout", "git-fetch-verify.log", refetch.stdout); capture("stderr", "git-fetch-verify.log", refetch.stderr);
    const problems = [];
    if (!refetch.ok) problems.push(`the verification fetch failed (${refetch.code}): ${clamp(refetch.stderr, 400)}`);
    const nowRemote = C.gitOut(repoRoot, "rev-parse", "--verify", "--quiet", remoteRef);
    if (!nowRemote) problems.push(`${tx.remote}/${tx.remote_branch} does not resolve after the push`);
    else if (nowRemote !== hash) {
      // Containment is still delivery when someone else pushed on top; a remote
      // that does not contain the commit at all is not.
      const contains = C.gitRun(repoRoot, ["merge-base", "--is-ancestor", hash, remoteRef]).ok;
      if (!contains) problems.push(`${tx.remote}/${tx.remote_branch} is ${nowRemote} and does not contain ${hash}`);
    }
    if (!C.gitRun(repoRoot, ["cat-file", "-e", `${hash}^{commit}`]).ok) problems.push(`commit ${hash} is not available locally after the verification fetch`);
    const remoteTree = C.gitOut(repoRoot, "rev-parse", `${hash}^{tree}`);
    if (remoteTree !== tree) problems.push(`the fetched commit's tree is ${remoteTree}, not the ${tree} that was committed`);
    const remoteParents = (C.gitOut(repoRoot, "rev-list", "--parents", "-n", "1", hash) ?? "").split(" ").slice(1);
    if (remoteParents.join(",") !== parents.join(",")) problems.push(`the fetched commit's parents are ${remoteParents.join(",")}, not ${parents.join(",")}`);

    const verification = {
      verified_at: now(), remote: tx.remote, remote_ref: remoteRef, remote_head: nowRemote,
      commit: hash, tree: remoteTree, parents: remoteParents,
      pushed_range: tx.push.pushed_range, independent_fetch: true, problems,
    };
    artifact("remote-verification.json", verification);
    if (problems.length) {
      ev("delivery.remote_verification_completed", { ok: false, problems });
      return stop("REMOTE_VERIFICATION_FAILED",
        `the push reported success but the remote does not confirm it, and nothing was force-pushed or rewritten: ${problems.join("; ")}`,
        { commit: tx.commit, push: tx.push, remote_verification: verification });
    }
    ev("delivery.remote_verification_completed", { ok: true, remote_head: nowRemote });

    // ------------------------------------------------------- 13. COMPLETION
    const marked = markDelivered(projectId, taskId, {
      run_id: runId, delivery_id: deliveryId, commit: hash, branch: tx.branch,
      remote: tx.remote, remote_ref: `${tx.remote}/${tx.remote_branch}`,
      pushed_range: tx.push.pushed_range, verified_at: verification.verified_at,
    });
    if (!marked.ok)
      return stop("INTERNAL_STATE_CONFLICT", `the commit is delivered and verified on the remote but the task could not be marked: ${marked.message}`,
        { commit: tx.commit, push: tx.push, remote_verification: verification });

    tx.remote_verification = verification;
    move("DELIVERED");
    auditLog({ kind: "delivery", project: projectId, task: String(taskId), run: runId, delivery: deliveryId,
      event: "delivered", commit: hash, remote: tx.remote, branch: tx.remote_branch, range: tx.push.pushed_range });

    // Promotion is NOT automatic. Writing the durable handoff here would leave
    // the repository dirty as the controller's final act — the very state it
    // just proved clean — and would block the next run on a file SCH wrote
    // itself. So the delivery records that the handoff is worth keeping and the
    // operator promotes it when they next commit.
    tx.handoff_promotable = {
      run_id: runId, raw: join(WS.runDir(wsDir, runId), "handoff.md"),
      command: `node scripts/state.mjs handoff-promote --project ${projectId} --run ${runId}`,
      reason: `delivered as ${hash} on ${tx.remote}/${tx.remote_branch}`,
    };
    writeTransaction(dp, tx);

    // The lease goes back before the verdict, so `delivery.delivered` is the
    // LAST event of a successful transaction — which is what anything reading
    // the tail of the stream will treat as the outcome.
    if (leaseHeld) { ev("delivery.lease_released", releaseRepoLease(wsDir, deliveryId)); leaseHeld = false; }
    ev("delivery.delivered", { commit: hash, remote: tx.remote, branch: tx.remote_branch, pushed_range: tx.push.pushed_range, task_status: "delivered" });
    return {
      ok: true, state: "DELIVERED", delivery_id: deliveryId, delivery_dir: dp,
      commit: hash, branch: tx.branch, remote: tx.remote, remote_ref: `${tx.remote}/${tx.remote_branch}`,
      pushed_range: tx.push.pushed_range, task_id: String(taskId), transaction: tx,
      duration_ms: Date.now() - started,
    };
  } catch (e) {
    const internal = String(e.message ?? e);
    return stop(internal.startsWith("INTERNAL_STATE_CONFLICT") ? "INTERNAL_STATE_CONFLICT" : "COMMIT_FAILED", `unexpected delivery failure: ${internal}`);
  } finally {
    if (leaseHeld) { try { ev("delivery.lease_released", releaseRepoLease(wsDir, deliveryId)); } catch {} leaseHeld = false; }
  }
}

// ------------------------------------------------------------- projections

// Everything about one delivery, read back from disk. Nothing about a finished
// delivery lives in memory.
export function readDelivery(projectId, runId) {
  const t = resolveTarget(projectId);
  if (!t.ok) return { ok: false, failure: t.failure };
  const dp = deliveryPathFor(t.wsDir, runId);
  const load = (f) => { try { return JSON.parse(readFileSync(join(dp, f), "utf8")); } catch { return null; } };
  const tx = readTransaction(dp);
  if (!tx) return { ok: false, failure: { code: "RUN_NOT_DELIVERY_ELIGIBLE", message: `no delivery for run ${runId}` } };
  return {
    ok: true, dir: dp, transaction: tx, approval_status: approvalStatus(tx),
    preflight: load("preflight.json"), approved_effects: load("approved-effects.json"),
    staging: load("staging.json"), commit: load("commit.json"), outgoing: load("outgoing.json"),
    push: load("push.json"), remote_verification: load("remote-verification.json"),
    secret_scan: load("secret-scan.json"), post_commit: load("post-commit.json"),
    events: readDeliveryEvents(dp),
  };
}

// The smallest useful dashboard view: what is being delivered, where it is, and
// whether it is waiting on a person. Bounded — artifact references, never the
// unbounded output they point at.
export function deliveryProjection(projectId, { limit = 10 } = {}) {
  const t = resolveTarget(projectId);
  if (!t.ok) return { project: projectId, available: false, reason: t.failure.message, deliveries: [] };
  const runs = WS.runsDir(t.wsDir);
  if (!existsSync(runs)) return { project: projectId, available: true, deliveries: [] };
  const out = [];
  for (const id of readdirSync(runs).filter((d) => d.startsWith("RUN-")).sort().reverse()) {
    const dp = WS.deliveryDir(t.wsDir, id);
    const tx = readTransaction(dp);
    if (!tx) continue;
    const events = readDeliveryEvents(dp);
    const staging = (() => { try { return JSON.parse(readFileSync(join(dp, "staging.json"), "utf8")); } catch { return null; } })();
    const outgoing = (() => { try { return JSON.parse(readFileSync(join(dp, "outgoing.json"), "utf8")); } catch { return null; } })();
    out.push({
      delivery_id: tx.delivery_id, run_id: tx.run_id, task_id: tx.task_id, state: tx.state,
      branch: tx.branch, remote: tx.remote, upstream_ref: tx.upstream_ref,
      verified_diff_hash: tx.verified_diff_hash,
      approval_status: approvalStatus(tx),
      approver: tx.approval?.approver ?? null,
      commit_message: tx.commit_message,
      intended_paths: tx.verified_paths ?? [],
      staged_paths: staging?.staged?.map((e) => e.path) ?? [],
      commit: tx.commit?.hash ?? null,
      outgoing_commits: outgoing?.outgoing?.map((c) => c.hash) ?? [],
      incoming_commits: outgoing?.incoming?.map((c) => c.hash) ?? [],
      push: tx.push ? { ok: tx.push.ok, exit_code: tx.push.exit_code, pushed_range: tx.push.pushed_range } : null,
      remote_verification: tx.remote_verification ? { ok: (tx.remote_verification.problems ?? []).length === 0, remote_head: tx.remote_verification.remote_head } : null,
      attention_required: ["NEEDS_DECISION", "FAILED", "AWAITING_APPROVAL"].includes(tx.state)
        ? (tx.failure?.message ?? `waiting for approval of ${tx.commit_message}`) : null,
      failure: tx.failure ?? null,
      events: events.length, last_event: events[events.length - 1]?.type ?? null,
      created_at: tx.created_at, updated_at: tx.updated_at, dir: dp,
    });
    if (out.length >= limit) break;
  }
  return {
    project: projectId, available: true, workspace: t.wsDir,
    active: out.find((d) => !TERMINAL_STATES.has(d.state)) ?? null,
    // Write actions (approval, delivery) are operator authority. Documented here
    // because the dashboard has no authentication yet: they must never be
    // exposed beyond localhost/tailnet until it does.
    write_actions_require_local_operator: true,
    deliveries: out,
  };
}
