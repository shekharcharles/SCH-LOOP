#!/usr/bin/env node
// SCH Loop — typed human decision gates.
//
// WHY THIS EXISTS
// A question used to be a task with `status=blocked` and some prose. That works
// for "which colour" and fails for everything that matters: there was no record
// of WHAT was being approved, so an approval could not be invalidated when the
// proposal changed underneath it, and "I approved this" meant "I approved
// something, once, about this task".
//
// A decision here BINDS. It names the project, task, run, attempt, phase, the
// exact state version it was made against, and a hash of the proposal — and, for
// anything touching the repository, a hash of the diff. Change any of those and
// the approval is INVALIDATED, automatically, because it is no longer an
// approval of the thing that is about to happen.
//
// Records live in SCH operational state (projects/<id>/state.json), which is
// already atomic, locked, gitignored and read by the dashboard. A second store
// would be a second thing to lose.

import { createHash } from "node:crypto";
import { loadState, mutateState, event as stateEvent, auditLog } from "./state.mjs";

export const SCHEMA_VERSION = 1;

// What kind of decision this is. The type is not decoration: it says which
// authority is being exercised, and an operator answering "yes" to a
// SCHEMA_CHANGE is doing something categorically different from waving through
// a DELIVERY_APPROVAL.
export const GATE_TYPES = [
  "ARCHITECTURE_DECISION", "AUTHORIZATION_POLICY", "DEPENDENCY_CHANGE",
  "SCHEMA_CHANGE", "MIGRATION_CHANGE", "PUBLIC_API_BREAK", "SCOPE_EXPANSION",
  "DESTRUCTIVE_ACTION", "UNRELATED_FAILURE", "AMBIGUOUS_EVIDENCE",
  "BUDGET_INCREASE", "DELIVERY_APPROVAL",
  // FINDING A VULNERABILITY IS NOT PERMISSION TO EXPLOIT IT. Every phase up to
  // validation asks "is this vulnerable"; from exploitation onward the question
  // is "what can an attacker actually achieve", and answering it means acting on
  // a live system holding real customer data. Nothing in this engine separated
  // those two until this gate: `active: true` was one boolean covering both.
  "EXPLOITATION_AUTHORIZED",
];

// The phases that may not begin without an approved EXPLOITATION_AUTHORIZED
// gate. Numbers, not names, because the pack owns the names and this must not
// silently stop gating when one is reworded.
export const GATED_PHASES = new Set([9, 10, 11, 12, 13]);

export const GATE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "INVALIDATED"];
export const DECISIONS = ["APPROVED", "REJECTED"];

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;  // a decision that is a day old is a decision about a day-old repository
const now = () => new Date().toISOString();
const clamp = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));
const sha = (v) => createHash("sha256").update(typeof v === "string" ? v : stable(v)).digest("hex");

function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

// The PROPOSAL is what is being decided, and its hash is what the decision binds
// to. Deliberately excludes anything that changes without changing the question
// (timestamps, ids of the asking process) — otherwise every approval would
// invalidate itself the instant it was granted.
export const proposalHash = (proposal) => sha({
  gate_type: proposal.gate_type, question: proposal.question,
  options: proposal.options ?? [], recommended: proposal.recommended ?? "",
  subject: proposal.subject ?? null,
});

const newId = () => "HG-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();

// ------------------------------------------------------------------- create

// A question the operator cannot understand is not a question. The same rule the
// blocked-task gate has always enforced, applied here: what is on the dashboard
// is the whole thing, and it must stand alone on a phone at 3am.
export function create(projectId, {
  gateType, question, options = [], recommended = "", taskId = null, runId = null,
  attempt = null, phaseId = null, stateVersion = null, diffHash = null, subject = null,
  ttlMs = DEFAULT_TTL_MS, requestedBy = "scheduler",
}) {
  if (!GATE_TYPES.includes(gateType))
    return { ok: false, failure: { code: "UNKNOWN_GATE_TYPE", message: `"${gateType}" is not a human-gate type (${GATE_TYPES.join(", ")})` } };
  const q = String(question ?? "").trim();
  if (q.length < 40 || !/\?/.test(q))
    return { ok: false, failure: { code: "QUESTION_UNREADABLE", message:
      "a human gate needs a question a person can answer from the dashboard alone: what is being decided, the options with what each one means, and your recommended default. Pointing at notes elsewhere is not a question." } };

  // Read and write under one lock: a gate decided against a state another
  // writer had already moved is a decision about something that no longer
  // exists in that form.
  return mutateState(projectId, (s) => {
      s.humanGates = s.humanGates ?? [];
      const proposal = { gate_type: gateType, question: q, options: options.map((o) => clamp(o, 500)).slice(0, 10), recommended: clamp(recommended, 500), subject };
      const hash = proposalHash(proposal);

      // The same unanswered question, asked twice, is one question. Re-asking it
      // would put two identical cards on the dashboard and make answering either of
      // them look like it moved nothing.
      const open = s.humanGates.find((g) => g.status === "PENDING" && g.proposal_hash === hash && String(g.task_id ?? "") === String(taskId ?? ""));
      if (open) return { ok: true, gate: open, existing: true };

      const gate = {
        schema_version: SCHEMA_VERSION, id: newId(), project_id: projectId,
        task_id: taskId === null ? null : Number(taskId), run_id: runId, attempt,
        phase_id: phaseId, state_version: stateVersion,
        gate_type: gateType, ...proposal, proposal_hash: hash, diff_hash: diffHash,
        status: "PENDING", decision: null, approver: null, conditions: null, decided_at: null,
        requested_by: requestedBy, created_at: now(),
        expires_at: new Date(Date.now() + ttlMs).toISOString(),
        invalidated_reason: null,
      };
      s.humanGates = [gate, ...s.humanGates].slice(0, 300);
      stateEvent(s, `human gate ${gate.id} [${gateType}]${taskId ? ` on task #${taskId}` : ""}: ${clamp(q, 100)}`);
        auditLog({ kind: "human-gate", project: projectId, task: taskId === null ? null : String(taskId), gate: gate.id, gate_type: gateType, event: "created" });
      return { ok: true, gate };
  });
}

// ------------------------------------------------------------------ read

// The live status of a gate, expiry applied. Expiry is computed on READ rather
// than by a sweeper: a decision that quietly stays valid because nothing ran the
// sweeper is exactly the failure this is meant to prevent.
export function statusOf(gate, at = Date.now()) {
  if (!gate) return null;
  if (gate.status === "PENDING" && new Date(gate.expires_at).getTime() < at) return "EXPIRED";
  if (gate.status === "APPROVED" && gate.expires_at && new Date(gate.expires_at).getTime() < at) return "EXPIRED";
  return gate.status;
}

export function list(projectId, { taskId = null, status = null, state = null } = {}) {
  const s = state ?? loadState(projectId);
  return (s.humanGates ?? [])
    .filter((g) => taskId === null || Number(g.task_id) === Number(taskId))
    .map((g) => ({ ...g, status: statusOf(g) }))
    .filter((g) => status === null || g.status === status);
}

export const get = (projectId, gateId, { state = null } = {}) => {
  const g = ((state ?? loadState(projectId)).humanGates ?? []).find((x) => x.id === gateId);
  return g ? { ...g, status: statusOf(g) } : null;
};

export const pending = (projectId, opts = {}) => list(projectId, { ...opts, status: "PENDING" });

// ---------------------------------------------------------------- decide

export function decide(projectId, gateId, { decision, approver, conditions = "", expectProposalHash = null }) {
  if (!DECISIONS.includes(decision))
    return { ok: false, failure: { code: "UNKNOWN_DECISION", message: `decision must be ${DECISIONS.join(" or ")}` } };
  if (!approver) return { ok: false, failure: { code: "APPROVER_REQUIRED", message: "a decision without an approver is not a decision" } };

  // Read and write under one lock: a gate decided against a state another
  // writer had already moved is a decision about something that no longer
  // exists in that form.
  return mutateState(projectId, (s) => {
      const g = (s.humanGates ?? []).find((x) => x.id === gateId);
      if (!g) return { ok: false, failure: { code: "GATE_NOT_FOUND", message: `no human gate ${gateId} in ${projectId}` } };
      const live = statusOf(g);
      if (live !== "PENDING")
        return { ok: false, failure: { code: "GATE_NOT_PENDING", message: `human gate ${gateId} is ${live}, not PENDING` }, gate: { ...g, status: live } };
      if (expectProposalHash && expectProposalHash !== g.proposal_hash)
        return { ok: false, failure: { code: "PROPOSAL_CHANGED", message: `the proposal changed since you read it (${g.proposal_hash.slice(0, 12)} now)` } };

      g.status = decision; g.decision = decision; g.approver = String(approver);
      g.conditions = clamp(conditions, 1000) || null; g.decided_at = now();
      stateEvent(s, `human gate ${g.id} ${decision} by ${g.approver}${g.conditions ? ` (${clamp(g.conditions, 60)})` : ""}`);
        auditLog({ kind: "human-gate", project: projectId, task: g.task_id === null ? null : String(g.task_id), gate: g.id, gate_type: g.gate_type, event: "decided", decision, approver: g.approver });
      return { ok: true, gate: g };
  });
}

// -------------------------------------------------------------- invalidate

// A decision is about a specific proposal against a specific state. If either
// moved, the decision no longer describes what is about to happen — so it is
// invalidated, and the operator is asked again rather than being taken to have
// agreed to something they never saw.
export function revalidate(projectId, gateId, { proposal = null, diffHash = null, stateVersion = null }) {
  // Read and write under one lock: a gate decided against a state another
  // writer had already moved is a decision about something that no longer
  // exists in that form.
  return mutateState(projectId, (s) => {
      const g = (s.humanGates ?? []).find((x) => x.id === gateId);
      if (!g) return { ok: false, failure: { code: "GATE_NOT_FOUND", message: `no human gate ${gateId}` } };
      const reasons = [];
      if (proposal && proposalHash(proposal) !== g.proposal_hash) reasons.push("the proposal changed");
      if (diffHash !== null && g.diff_hash !== null && diffHash !== g.diff_hash) reasons.push("the diff changed since it was approved");
      if (stateVersion !== null && g.state_version !== null && Number(stateVersion) !== Number(g.state_version))
        reasons.push(`the task moved (state version ${g.state_version} → ${stateVersion})`);
      if (!reasons.length) return { ok: true, gate: { ...g, status: statusOf(g) }, invalidated: false };

      g.status = "INVALIDATED"; g.invalidated_reason = reasons.join("; "); g.decided_at = g.decided_at ?? null;
      stateEvent(s, `human gate ${g.id} INVALIDATED: ${g.invalidated_reason}`);
        auditLog({ kind: "human-gate", project: projectId, gate: g.id, event: "invalidated", reason: g.invalidated_reason });
      return { ok: true, gate: g, invalidated: true, reasons };
  });
}

// ------------------------------------------------------------- projection

// What the dashboard shows and what the scheduler consults. READ ONLY over the
// network: deciding is an authority, and the dashboard has no authentication.
export function projection(projectId, { state = null, limit = 50 } = {}) {
  const all = list(projectId, { state });
  return {
    schema_version: SCHEMA_VERSION, project_id: projectId,
    pending: all.filter((g) => g.status === "PENDING").slice(0, limit),
    decided: all.filter((g) => g.status !== "PENDING").slice(0, limit),
    counts: GATE_STATUSES.reduce((o, st) => ({ ...o, [st.toLowerCase()]: all.filter((g) => g.status === st).length }), {}),
    // Said out loud, in the payload, because a UI that grows an approve button
    // without this line is how an unauthenticated remote gains push authority.
    decisions_require_local_operator: true,
    decide_with: `node scripts/state.mjs human-gate-decide --project ${projectId} --gate <id> --decision APPROVED --approver <name>`,
    generated_at: now(),
  };
}

// ------------------------------------------------- exploitation authorization

// The subject of an exploitation gate is the whole reason it can be trusted:
// it is hashed into the proposal, so an approval survives only while every one
// of these facts still holds. Change the authorization reference — which is what
// happens when a real signed reference finally replaces a placeholder — and the
// approval granted under the old one is no longer an approval.
export function exploitationSubject({ target, action, findings = [], authRef, authExpiry = null, roe = "" }) {
  return {
    target: String(target ?? ""),
    action: clamp(action, 800),
    // Sorted, so the same set of findings in a different order is the same
    // subject and does not re-ask a question the operator already answered.
    findings: findings.map((f) => ({ id: String(f.id ?? f), title: clamp(f.title ?? "", 200) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    authorization_ref: String(authRef ?? ""),
    authorization_expiry: authExpiry ?? null,
    roe: clamp(roe, 800),
  };
}

// Open the gate for one phase task. Granularity is deliberate: one gate per
// task, listing the findings it intends to exploit. Per-finding would ask the
// operator forty times; per-phase-with-no-list would let the set change under an
// approval that was granted for something else. Listing them inside the hashed
// subject gets both — one decision, and a NEW decision the moment the set moves.
export function openExploitationGate(projectId, {
  taskId, phase, target, action, findings = [], authRef, authExpiry = null, roe = "",
  runId = null, attempt = null, stateVersion = null, ttlMs = DEFAULT_TTL_MS, requestedBy = "scheduler",
}) {
  // FAIL CLOSED ON A MISSING AUTHORIZATION. A gate whose subject has no
  // reference would still hash, still be approvable, and would record an
  // operator authorising exploitation against nothing in particular.
  if (!String(authRef ?? "").trim())
    return { ok: false, failure: { code: "AUTHORIZATION_REF_MISSING", message:
      `task #${taskId} is in phase ${phase}, which cannot begin without a recorded authorization reference. ` +
      `Record one first: node scripts/state.mjs auth-add --client "<client>" --ref "<signed reference>" --domains "<target>" --expiry <YYYY-MM-DD>` } };
  if (!GATED_PHASES.has(Number(phase)))
    return { ok: false, failure: { code: "PHASE_NOT_GATED", message: `phase ${phase} is not an exploitation phase (${[...GATED_PHASES].join(", ")})` } };

  const subject = exploitationSubject({ target, action, findings, authRef, authExpiry, roe });
  const list = findings.length
    ? findings.map((f) => `  · ${f.id ?? f}${f.title ? " — " + clamp(f.title, 120) : ""}`).join("\n")
    : "  · none recorded — this phase would begin with nothing validated to act on";

  const question =
    `Authorize EXPLOITATION against ${subject.target}?\n\n` +
    `Task #${taskId} (phase ${phase}) intends to: ${subject.action}\n\n` +
    `Findings it would act on:\n${list}\n\n` +
    `Authorization on record: ${subject.authorization_ref}` +
    (subject.authorization_expiry ? ` (expires ${subject.authorization_expiry})` : " (NO EXPIRY RECORDED)") +
    (subject.roe ? `\nRules of engagement: ${subject.roe}` : "\nRules of engagement: NONE RECORDED") +
    `\n\nApproving means acting on a live system, not testing whether it is vulnerable. ` +
    `This approval covers exactly the findings listed above — if that set changes, you will be asked again.`;

  return create(projectId, {
    gateType: "EXPLOITATION_AUTHORIZED", question,
    options: [
      "APPROVED — proceed with exploitation within the rules of engagement above",
      "REJECTED — stop here; the phase is recorded as not-covered with this reason",
    ],
    recommended: "REJECTED unless the authorization reference above is a real signed reference and the rules of engagement are the client's own words",
    taskId, runId, attempt, phaseId: `phase-${phase}`, stateVersion, subject, ttlMs, requestedBy,
  });
}

// Is this task allowed to run right now? The scheduler's question, answered in
// one place so "gated" cannot mean two different things in two files.
export function exploitationAllowed(projectId, task, { state = null, subject = null } = {}) {
  const phase = Number(task?.phase);
  if (!GATED_PHASES.has(phase)) return { allowed: true, gated: false };
  const gates = list(projectId, { taskId: task.id, state })
    .filter((g) => g.gate_type === "EXPLOITATION_AUTHORIZED");

  // An approval is an approval OF SOMETHING. Accepting any approved gate on the
  // task would let the finding set grow, or a placeholder authorization ref be
  // replaced, under a decision the operator made about something smaller — which
  // is precisely the failure the hashed subject exists to prevent.
  const approved = gates.find((g) => g.status === "APPROVED" &&
    (subject === null || stable(g.subject ?? null) === stable(subject)));
  if (approved) return { allowed: true, gated: true, gate: approved };
  const staleApproval = subject !== null && gates.some((g) => g.status === "APPROVED");
  if (staleApproval)
    return { allowed: false, gated: true, gate: gates.find((g) => g.status === "APPROVED"),
             reason: "EXPLOITATION_SUBJECT_CHANGED" };
  const pending = gates.find((g) => g.status === "PENDING");
  const rejected = gates.find((g) => g.status === "REJECTED");
  const invalid = gates.find((g) => g.status === "INVALIDATED" || g.status === "EXPIRED");
  return {
    allowed: false, gated: true, gate: pending ?? rejected ?? invalid ?? null,
    reason: pending ? "EXPLOITATION_GATE_PENDING"
      : rejected ? "EXPLOITATION_REJECTED"
      : invalid ? "EXPLOITATION_GATE_INVALIDATED"
      : "EXPLOITATION_GATE_MISSING",
  };
}
