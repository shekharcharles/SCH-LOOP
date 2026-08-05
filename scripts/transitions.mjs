#!/usr/bin/env node
// SCH Loop — the closed task-state machine.
//
// WHY THIS EXISTS
// `task-set --status <anything>` was a free write. Any prompt, any skill, any
// operator could move a task to any status, in any order, from any process, and
// the last writer won. That is fine for a queue a person reads and terrible for
// a queue a scheduler executes: "RUNNING" that nobody is running, "merged" that
// no run produced, and two processes overwriting each other's decisions with no
// way to tell afterwards which one was stale.
//
// So a task now has a CANONICAL state, moved only by a named actor, only along a
// legal edge, and only against the version the caller expected. `task.status`
// stays exactly where it was, in exactly its old vocabulary — it is a MIRROR
// maintained by this service, not a second authority, and nothing else writes it.
//
// Nothing historical is rewritten. A task with no canonical state is READ
// through the legacy map on demand; it gains a canonical state the first time
// something legitimately moves it.

import { loadState, mutateState, event as stateEvent, auditLog, STATUSES, CONTROLLER_ONLY_STATUSES } from "./state.mjs";

export const SCHEMA_VERSION = 1;

export const STATES = [
  "BACKLOG", "READY", "CLAIMED", "RUNNING", "VERIFYING", "RETRYABLE",
  "AWAITING_DELIVERY", "DELIVERING", "NEEDS_DECISION", "BLOCKED",
  "FAILED", "DELIVERED", "CANCELLED", "SUPERSEDED",
];
export const TERMINAL = new Set(["DELIVERED", "CANCELLED", "SUPERSEDED"]);
export const ACTIVE = new Set(["CLAIMED", "RUNNING", "VERIFYING", "AWAITING_DELIVERY", "DELIVERING"]);

// ------------------------------------------------------ legacy <-> canonical
//
// The map is DOCUMENTED, not clever. Read it as: "what did the old word mean?"
//
//   queued      nothing has started               -> READY
//   building    a worker is on it                 -> RUNNING
//   review      the work exists, it is being      -> VERIFYING
//               checked
//   changes     the check said do it again        -> RETRYABLE
//   merged      the in-session loop finished it    -> AWAITING_DELIVERY
//               LOCALLY. It was never pushed.
//   delivered   committed, pushed, verified on    -> DELIVERED
//               the remote by the controller
//   blocked     a person must answer something    -> NEEDS_DECISION
//   stuck       it cannot proceed                 -> FAILED
//   superseded  replaced/decomposed               -> SUPERSEDED
//
// `merged -> AWAITING_DELIVERY` is the one that matters. Mapping it to DELIVERED
// would have made every historical task claim a remote it never reached.
export const LEGACY_TO_STATE = {
  queued: "READY", building: "RUNNING", review: "VERIFYING", changes: "RETRYABLE",
  merged: "AWAITING_DELIVERY", delivered: "DELIVERED", blocked: "NEEDS_DECISION",
  stuck: "FAILED", superseded: "SUPERSEDED",
};

// The mirror written back into `task.status`. Lossy on purpose in one direction:
// CLAIMED and RUNNING both read "building" to a legacy consumer, because the old
// vocabulary has no word for "claimed but not started" and inventing one would
// break every existing dashboard, skill and report that reads this field.
export const STATE_TO_LEGACY = {
  BACKLOG: "queued", READY: "queued", CLAIMED: "building", RUNNING: "building",
  VERIFYING: "review", RETRYABLE: "changes", AWAITING_DELIVERY: "merged",
  DELIVERING: "review", DELIVERED: "delivered", NEEDS_DECISION: "blocked",
  BLOCKED: "blocked", FAILED: "stuck", CANCELLED: "superseded", SUPERSEDED: "superseded",
};

// The canonical state of a task that may never have had one. Never written as a
// side effect of reading — a historical record is evidence, not a draft.
export function canonicalState(task) {
  if (!task) return null;
  if (task.state && STATES.includes(task.state)) return task.state;
  return LEGACY_TO_STATE[task.status] ?? "READY";
}

// ------------------------------------------------------------------- actors

// Who may move what. The model is deliberately absent: an agent produces
// evidence, and evidence is graded by a controller. It never moves a task.
export const ACTORS = ["scheduler", "runner", "verifier", "delivery", "retry", "human-gate", "operator", "system"];

// from -> { to: [actors allowed] }
const EDGES = {
  BACKLOG:           { READY: ["scheduler", "operator"] },
  READY:             { CLAIMED: ["scheduler"], BACKLOG: ["operator"] },
  CLAIMED:           { RUNNING: ["runner"], READY: ["scheduler", "operator"] },
  RUNNING:           { VERIFYING: ["runner"], RETRYABLE: ["runner", "retry"] },
  VERIFYING:         { AWAITING_DELIVERY: ["verifier"], RETRYABLE: ["verifier", "retry"] },
  RETRYABLE:         { READY: ["retry", "operator"] },
  AWAITING_DELIVERY: { DELIVERING: ["delivery"] },
  DELIVERING:        { DELIVERED: ["delivery"], AWAITING_DELIVERY: ["delivery"] },
  NEEDS_DECISION:    { READY: ["human-gate", "operator"] },
};

// Any nonterminal state may fall to these. That is what fail-closed means: the
// machine can always stop, it can never sneak forward.
const FALLBACK = {
  NEEDS_DECISION: ["scheduler", "runner", "verifier", "delivery", "retry", "operator", "system"],
  BLOCKED: ["scheduler", "runner", "verifier", "delivery", "retry", "operator", "system"],
  FAILED: ["scheduler", "runner", "verifier", "delivery", "retry", "operator", "system"],
  CANCELLED: ["operator", "human-gate"],
  SUPERSEDED: ["operator"],
};
// NEEDS_DECISION may also resolve to a stop, via the gate that owns it.
const GATE_RESOLUTIONS = { FAILED: ["human-gate"], CANCELLED: ["human-gate"] };

export function canTransition(from, to, actor) {
  if (!STATES.includes(to)) return { ok: false, why: `unknown task state "${to}"` };
  if (!STATES.includes(from)) return { ok: false, why: `unknown current state "${from}"` };
  if (!ACTORS.includes(actor)) return { ok: false, why: `"${actor}" is not an actor that may move a task` };
  if (actor === "model" || actor === "worker" || actor === "agent")
    return { ok: false, why: "a model never moves a task — it produces evidence, and evidence is graded" };
  if (TERMINAL.has(from)) return { ok: false, why: `task is already terminal in ${from}` };
  if (from === to) return { ok: false, why: `already in ${from}` };

  const forward = EDGES[from]?.[to];
  if (forward) return forward.includes(actor) ? { ok: true } : { ok: false, why: `${from} → ${to} is a ${forward.join("/")} transition, not a ${actor} one` };

  const fall = FALLBACK[to];
  if (fall) {
    const extra = GATE_RESOLUTIONS[to] ?? [];
    const allowed = from === "NEEDS_DECISION" ? [...fall, ...extra] : fall;
    return allowed.includes(actor) ? { ok: true } : { ok: false, why: `"${actor}" may not move a task to ${to}` };
  }
  return { ok: false, why: `illegal transition ${from} → ${to}` };
}

// ------------------------------------------------------------- the transition

const now = () => new Date().toISOString();
const clamp = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));

// Move one task. Fails closed on: unknown task, illegal edge, wrong actor, or a
// state version that is not the one the caller read. The version check is what
// stops a process that slept through a delivery from resurrecting a stale state.
//
// `mutate(task)` runs INSIDE the write, after the edge is approved, so a caller
// that needs to attach evidence to the same durable write does not race itself.
export function transition(projectId, taskId, { to, actor, reason = "", expectVersion = null, runId = null, attempt = null, phaseId = null, causation = null, mutate = null }) {
  // The load, the checks and the write are ONE locked section: a transition
  // that read a state version another writer had already moved would decide
  // legality against a task that no longer exists in that form.
  let audit = null;
  try {
    const out = mutateState(projectId, (s) => {
      const t = (s.tasks ?? []).find((x) => x.id === Number(taskId));
      if (!t) return { ok: false, failure: { code: "TASK_NOT_FOUND", message: `no task #${taskId} in ${projectId}` } };
  
      const from = canonicalState(t);
      const version = t.stateVersion ?? 0;
      if (expectVersion !== null && Number(expectVersion) !== version)
        return { ok: false, failure: { code: "STATE_VERSION_CONFLICT", message: `task #${taskId} is at state version ${version}, not ${expectVersion} — something moved it since you read it` }, state: from, state_version: version };
  
      const legal = canTransition(from, to, actor);
      if (!legal.ok)
        return { ok: false, failure: { code: "ILLEGAL_TRANSITION", message: `task #${taskId}: ${legal.why}` }, state: from, state_version: version };
  
      const record = {
        schema_version: SCHEMA_VERSION, from, to, actor, reason: clamp(reason, 500),
        project_id: projectId, task_id: Number(taskId), run_id: runId, attempt,
        phase_id: phaseId, state_version: version + 1, causation_event: causation, at: now(),
      };
  
      t.state = to;
      t.status = STATE_TO_LEGACY[to];
      t.stateVersion = version + 1;
      t.stateHistory = [record, ...(t.stateHistory ?? [])].slice(0, 50);
      t.updatedAt = now();
      // A caller mutation that throws must discard the whole write, including
      // the state/version fields set just above. Throwing does exactly that:
      // mutateState saves only on a normal return.
      if (mutate) try { mutate(t, record); } catch (e) { throw Object.assign(new Error(e.message), { __schMutateConflict: true }); }

      stateEvent(s, `task #${t.id} ${from} → ${to} (${actor}${reason ? ": " + clamp(reason, 90) : ""})`);
      audit = record;
      return { ok: true, transition: record, task: t, state: to, state_version: t.stateVersion };
    });
    if (audit) auditLog({ kind: "transition", project: projectId, task: String(taskId), ...audit });
    return out;
  } catch (err) {
    if (err && err.__schMutateConflict)
      return { ok: false, failure: { code: "INTERNAL_STATE_CONFLICT", message: err.message } };
    throw err;
  }
}

// ------------------------------------------------------- legacy status writes
//
// `task-set --status` still exists and still works — but it goes THROUGH here.
// It may not name a canonical state (that is what `task-transition` is for), it
// may not name a controller-only status, and what it does is recorded as a
// transition like everything else. A legacy write that the closed machine would
// refuse is reported as such and, in legacy mode, allowed with the refusal
// written down: this is the compatibility seam, and a silent one would be a lie.
export function applyLegacyStatus(projectId, taskId, legacyStatus, { actor = "operator", reason = "", mutate = null, strict = false } = {}) {
  if (STATES.includes(String(legacyStatus).toUpperCase()) && !STATUSES.includes(legacyStatus))
    return { ok: false, failure: { code: "CANONICAL_STATE_NOT_SETTABLE", message:
      `"${legacyStatus}" is a canonical task state. It is reached by a controlled transition, never by typing it:\n` +
      `  node scripts/state.mjs task-transition --project ${projectId} --task ${taskId} --event <event>` } };
  if (CONTROLLER_ONLY_STATUSES.has(legacyStatus))
    return { ok: false, failure: { code: "CONTROLLER_ONLY_STATUS", message: `"${legacyStatus}" is set by the delivery controller only` } };
  if (!STATUSES.includes(legacyStatus))
    return { ok: false, failure: { code: "UNKNOWN_STATUS", message: `"${legacyStatus}" is not a task status (${STATUSES.join(", ")})` } };

  const to = LEGACY_TO_STATE[legacyStatus];
  // Same locked section as `transition`: read, decide and write together.
  let audit = null;
  try {
    const out = mutateState(projectId, (s) => {
      const t = (s.tasks ?? []).find((x) => x.id === Number(taskId));
      if (!t) return { ok: false, failure: { code: "TASK_NOT_FOUND", message: `no task #${taskId} in ${projectId}` } };
      const from = canonicalState(t);
      if (from === to) {
        // Not a move. Still let the caller attach its own field writes.
        if (mutate) { mutate(t, null); t.updatedAt = now(); }
        return { ok: true, noop: true, state: to, state_version: t.stateVersion ?? 0 };
      }
      const legal = canTransition(from, to, actor);
      if (!legal.ok && strict)
        return { ok: false, failure: { code: "ILLEGAL_TRANSITION", message: `task #${taskId}: ${legal.why}` }, state: from };

      const r = transitionUnchecked(projectId, taskId, { to, actor, reason: reason || `legacy task-set --status ${legacyStatus}`, mutate, legacyOverride: legal.ok ? null : legal.why });
      return r;
    });
    if (audit) auditLog({ kind: "transition", project: projectId, task: String(taskId), ...audit });
    return out;
  } catch (err) {
    if (err && err.__schMutateConflict)
      return { ok: false, failure: { code: "INTERNAL_STATE_CONFLICT", message: err.message } };
    throw err;
  }
}

// The legacy seam, and the ONLY place a refused edge is still written. It
// records WHY the closed machine would have refused, so a queue that is being
// driven by hand instead of by the scheduler leaves a trail rather than a
// mystery. The scheduler never calls this.
function transitionUnchecked(projectId, taskId, { to, actor, reason, mutate, legacyOverride }) {
  const s = loadState(projectId);
  const t = (s.tasks ?? []).find((x) => x.id === Number(taskId));
  if (!t) return { ok: false, failure: { code: "TASK_NOT_FOUND", message: `no task #${taskId}` } };
  const from = canonicalState(t);
  const version = t.stateVersion ?? 0;
  const record = {
    schema_version: SCHEMA_VERSION, from, to, actor, reason: clamp(reason, 500),
    project_id: projectId, task_id: Number(taskId), run_id: null, attempt: null,
    phase_id: null, state_version: version + 1, causation_event: null,
    legacy_override: legacyOverride, at: now(),
  };
  t.state = to; t.status = STATE_TO_LEGACY[to]; t.stateVersion = version + 1;
  t.stateHistory = [record, ...(t.stateHistory ?? [])].slice(0, 50);
  t.updatedAt = now();
  // Throwing discards the whole write, including the state fields set above.
  if (mutate) try { mutate(t, record); } catch (e) { throw Object.assign(new Error(e.message), { __schMutateConflict: true }); }
  stateEvent(s, `task #${t.id} ${from} → ${to} (${actor})${legacyOverride ? ` [legacy write the closed machine would refuse: ${clamp(legacyOverride, 80)}]` : ""}`);
  audit = record;
  return { ok: true, transition: record, task: t, state: to, state_version: t.stateVersion, legacy_override: legacyOverride };
}

// The PURE form of the legacy write, for a caller that already holds the state
// object and owns the single durable write (task-set does). Mutates the task,
// returns the transition record, and records the closed machine's verdict —
// including when that verdict is "I would have refused this".
export function stampLegacy(task, legacyStatus, { actor = "operator", reason = "" } = {}) {
  const to = LEGACY_TO_STATE[legacyStatus];
  if (!to) return { ok: false, failure: { code: "UNKNOWN_STATUS", message: `"${legacyStatus}" is not a task status` } };
  const from = canonicalState(task);
  if (from === to) return { ok: true, noop: true, state: to, transition: null };
  const legal = canTransition(from, to, actor);
  const version = task.stateVersion ?? 0;
  const record = {
    schema_version: SCHEMA_VERSION, from, to, actor, reason: clamp(reason || `task-set --status ${legacyStatus}`, 500),
    task_id: task.id, run_id: null, attempt: null, phase_id: null,
    state_version: version + 1, causation_event: null,
    legacy_override: legal.ok ? null : legal.why, at: now(),
  };
  task.state = to; task.status = STATE_TO_LEGACY[to]; task.stateVersion = version + 1;
  task.stateHistory = [record, ...(task.stateHistory ?? [])].slice(0, 50);
  return { ok: true, state: to, transition: record, legacy_override: record.legacy_override };
}

// ---------------------------------------------------------------- named events
//
// `task-transition --event <event>` speaks in EVENTS, not destinations: an
// operator naming a destination is how a task ends up "DELIVERED" because
// somebody typed it. An event resolves to a destination the actor is allowed to
// reach from where the task actually is.
export const EVENTS = {
  release:      { to: "READY", actor: "operator", from: ["BACKLOG"] },
  shelve:       { to: "BACKLOG", actor: "operator", from: ["READY"] },
  block:        { to: "BLOCKED", actor: "operator" },
  need_decision:{ to: "NEEDS_DECISION", actor: "operator" },
  fail:         { to: "FAILED", actor: "operator" },
  cancel:       { to: "CANCELLED", actor: "operator" },
  supersede:    { to: "SUPERSEDED", actor: "operator" },
  requeue:      { to: "READY", actor: "operator", from: ["RETRYABLE", "NEEDS_DECISION", "CLAIMED"] },
};

export function applyEvent(projectId, taskId, eventName, { actor = null, reason = "", expectVersion = null } = {}) {
  const def = EVENTS[eventName];
  if (!def) return { ok: false, failure: { code: "UNKNOWN_EVENT", message: `no such transition event "${eventName}" (${Object.keys(EVENTS).join(", ")})` } };
  return transition(projectId, taskId, { to: def.to, actor: actor ?? def.actor, reason: reason || `event:${eventName}`, expectVersion });
}

// --------------------------------------------------------------- projections

export const isActive = (task) => ACTIVE.has(canonicalState(task));
export const isTerminal = (task) => TERMINAL.has(canonicalState(task));

// What every task in a project looks like to the closed machine, including the
// ones that have never been through it.
export function projectStates(projectId, { state = null } = {}) {
  const s = state ?? loadState(projectId);
  return (s.tasks ?? []).map((t) => ({
    id: t.id, title: t.title, state: canonicalState(t), legacy_status: t.status,
    state_version: t.stateVersion ?? 0, migrated: Boolean(t.state),
    last_transition: (t.stateHistory ?? [])[0] ?? null,
  }));
}
