#!/usr/bin/env node
// SCH Loop — the phase engine.
//
// WHY THIS EXISTS
// "The agent finished and exited 0" was doing the work of five separate claims:
// the process ran, it produced something, the something was well formed, the
// gates were evaluated, and the gates passed. Collapsing those into one boolean
// is how an agent that printed "done" and changed nothing looked like success.
//
// So a phase moves through five checkpoints and starts at none of them:
//
//   PENDING → RUNNING → EXECUTED → REPORTED → GATED → ACCEPTED
//
//   EXECUTED   the process or function returned. Nothing more.
//   REPORTED   a valid, typed, identity-checked envelope exists.
//   GATED      every required gate actually ran.
//   ACCEPTED   every required gate passed.
//
// A zero exit code gets you to EXECUTED. That is all it has ever meant.
//
// The engine is code, not a prompt convention. It persists every checkpoint, so
// a scheduler that dies between two phases can be told exactly where it was
// rather than having to guess from a log.

import { mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as WS from "./workspace.mjs";
import * as ENV from "./envelopes.mjs";
import * as GATES from "./gates.mjs";

export const SCHEMA_VERSION = 1;

export const PHASE_KINDS = ["HUMAN", "AGENT", "CODE", "GATE"];

export const PHASE_STATES = [
  "PENDING", "RUNNING", "EXECUTED", "REPORTED", "GATED", "ACCEPTED",
  "RETRYABLE", "NEEDS_DECISION", "FAILED", "CANCELLED",
];

// The forward order. A phase moves along this list one step at a time and never
// backwards — "it was ACCEPTED, then it was RUNNING again" is not a lifecycle,
// it is a lost write.
const ORDER = ["PENDING", "RUNNING", "EXECUTED", "REPORTED", "GATED", "ACCEPTED"];
export const STOPS = new Set(["RETRYABLE", "NEEDS_DECISION", "FAILED", "CANCELLED"]);

export function canAdvance(from, to) {
  if (!PHASE_STATES.includes(to)) return { ok: false, why: `unknown phase state "${to}"` };
  if (STOPS.has(from)) return { ok: false, why: `the phase already stopped in ${from}` };
  if (from === "ACCEPTED") return { ok: false, why: "the phase is already ACCEPTED" };
  if (STOPS.has(to)) return { ok: true };
  const i = ORDER.indexOf(from), j = ORDER.indexOf(to);
  if (i === -1 || j === -1) return { ok: false, why: `${from} → ${to} is not on the phase lifecycle` };
  if (j < i) return { ok: false, why: `a phase never moves backwards (${from} → ${to})` };
  if (j === i) return { ok: false, why: `already ${from}` };
  if (j > i + 1) return { ok: false, why: `a phase never skips a checkpoint (${from} → ${to} skips ${ORDER.slice(i + 1, j).join(", ")})` };
  return { ok: true };
}

// ------------------------------------------------------------- agent roles
//
// A ROLE is what the agent is for. An EXECUTOR is how it is started. A MODEL is
// what answers. Those were one concept, which is how "the reviewer" ended up
// with the builder's write access: there was no place to say they differ.
//
// Tools and writable paths are separate permissions on purpose. Read is not
// edit; edit is not "may write anywhere the task allows".
export const ROLES = {
  planner: {
    role: "planner", executor: "claude-cli", model: "inherited", reasoning: "high",
    capabilities: ["planning", "brainstorming"],       // resolved through the trusted registry, never named skills
    tools: ["read"], writes: [".sch-loop/PLAN.md"],
    output_envelope: "PlannerEnvelopeV1",
    budgets: { max_prompt_characters: 40000, max_duration_ms: 15 * 60 * 1000 },
  },
  builder: {
    role: "builder", executor: "claude-cli", model: "inherited", reasoning: "medium",
    skills_from_task_profile: true,
    tools: ["read", "edit", "shell"], writes_from_task_policy: true,
    output_envelope: "BuilderEnvelopeV1",
    budgets: { max_prompt_characters: 60000, max_duration_ms: 30 * 60 * 1000 },
  },
  reviewer: {
    role: "reviewer", executor: "claude-cli", model: "inherited", reasoning: "high",
    capabilities: ["review", "security-review"],
    tools: ["read"], writes: [],
    output_envelope: "ReviewerEnvelopeV1",
    budgets: { max_prompt_characters: 40000, max_duration_ms: 15 * 60 * 1000 },
  },
};

export function resolveRole(name) {
  const r = ROLES[name];
  if (!r) return { ok: false, failure: { code: "UNKNOWN_ROLE", message: `no agent role "${name}" (${Object.keys(ROLES).join(", ")})` } };
  return { ok: true, role: r };
}

// ------------------------------------------------------------ persistence

export const phasesDir = (attemptDir) => join(attemptDir, "phases");
export const phasePath = (attemptDir, phaseId) => join(phasesDir(attemptDir), `${phaseId}.json`);

export function readPhase(attemptDir, phaseId) {
  try { return JSON.parse(readFileSync(phasePath(attemptDir, phaseId), "utf8")); } catch { return null; }
}

export function listPhases(attemptDir) {
  const d = phasesDir(attemptDir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(readFileSync(join(d, f), "utf8")); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

function persist(attemptDir, rec) {
  mkdirSync(phasesDir(attemptDir), { recursive: true });
  WS.writeAtomic(phasePath(attemptDir, rec.phase_id), JSON.stringify(rec, null, 2));
  return rec;
}

// ---------------------------------------------------------------- accounting
//
// Characters and bytes, never "tokens". Nothing here has a tokenizer, and a
// number labelled "tokens" that came from dividing characters by four is a
// measurement nobody can act on.
const emptyAccounting = () => ({
  unit: "characters", note: "character/byte counts, not tokens — no tokenizer is used",
  prompt_characters: 0, skill_excerpt_characters: 0, previous_evidence_characters: 0,
  output_bytes: 0, compacted_sections: [], omitted_sections: [],
  executor: null, model: null,
});

const now = () => new Date().toISOString();

// ------------------------------------------------------------- the engine

// `def`  — the phase definition (id, kind, role, envelope types, gates, budgets)
// `work` — what the phase actually does. Returns:
//            { ok, envelope? , stdout?, gateContext?, result?, failure?, accounting? }
//          The engine never interprets `result`; it validates the ENVELOPE and
//          evaluates the GATES, and those two things alone decide acceptance.
export async function runPhase(def, { attemptDir, identity, ctx = {}, index = 0, work }) {
  const started = Date.now();
  let rec = {
    schema_version: SCHEMA_VERSION, index,
    phase_id: def.id, kind: def.kind, role: def.role ?? null,
    project_id: identity.project_id, task_id: String(identity.task_id),
    run_id: identity.run_id ?? null, attempt: identity.attempt ?? 1,
    state: "PENDING", outcome: null, failure: null,
    input_schema: def.input_schema ?? null, output_schema: def.output_schema ?? null,
    required_gates: def.gates ?? [], gate_summary: null, gate_reports: [],
    envelope: null, envelope_hash: null, envelope_type: null,
    accounting: emptyAccounting(),
    started_at: now(), ended_at: null, duration_ms: 0,
    timeout_ms: def.timeout_ms ?? null, max_attempts: def.max_attempts ?? 1,
    notes: null,
  };
  persist(attemptDir, rec);

  // The only way this record's state ever changes. Refuses a skip, refuses a
  // step backwards, and persists every accepted move.
  const move = (to, extra = {}) => {
    const legal = canAdvance(rec.state, to);
    if (!legal.ok) throw new Error(`PHASE_LIFECYCLE: ${def.id}: ${legal.why}`);
    rec = { ...rec, ...extra, state: to, ended_at: now(), duration_ms: Date.now() - started };
    return persist(attemptDir, rec);
  };
  const stop = (state, code, message, extra = {}) => {
    rec = { ...rec, ...extra, state, outcome: state, failure: { code, message },
      ended_at: now(), duration_ms: Date.now() - started };
    return persist(attemptDir, rec);
  };

  // A HUMAN phase never starts an agent and never decides anything itself. It
  // exists to say "a person has to look at this", and to be resumable when they
  // have. `work` returns the decision record, or the absence of one.
  move("RUNNING");

  let out;
  try { out = await work({ identity, ctx, record: rec }); }
  catch (e) { return stop("FAILED", def.kind === "AGENT" ? "AGENT_PROCESS_FAILURE" : "PHASE_EXECUTION_FAILURE", `${def.id} threw: ${e.message}`); }

  if (out?.accounting) rec.accounting = { ...rec.accounting, ...out.accounting };

  // ---- EXECUTED: the process/function returned. Nothing is accepted yet.
  move("EXECUTED", { notes: out?.notes ?? null });

  if (out?.stop) return stop(out.stop, out.failure?.code ?? "PHASE_STOPPED", out.failure?.message ?? `phase ${def.id} stopped`, { gate_reports: out.gate_reports ?? [] });
  if (out?.ok === false) {
    const state = out.state ?? (out.retryable ? "RETRYABLE" : "FAILED");
    return stop(state, out.failure?.code ?? "PHASE_FAILED", out.failure?.message ?? `phase ${def.id} failed`);
  }

  // ---- REPORTED: a valid envelope exists, of the type this phase declares.
  let envelopeResult = null;
  if (def.output_schema) {
    const wantType = def.output_schema;
    const id = { ...identity, phase_id: def.id };
    if (out?.stdout !== undefined && out?.envelope === undefined) {
      envelopeResult = ENV.parse(out.stdout, id, { type: wantType });
      // A worker built for the previous milestone prints a legacy handoff. It is
      // adapted, never guessed at: if the adapter cannot produce a valid
      // envelope, the phase fails rather than inventing one.
      if (!envelopeResult.ok && out.legacyHandoff) envelopeResult = ENV.adaptLegacyHandoff(out.legacyHandoff, id);
    } else if (out?.envelope !== undefined) {
      envelopeResult = ENV.isLegacyHandoff(out.envelope)
        ? ENV.adaptLegacyHandoff(out.envelope, id)
        : ENV.validate(out.envelope, id, { type: wantType });
    } else {
      envelopeResult = { ok: false, failure: { code: "ENVELOPE_MISSING", message: `phase ${def.id} declares ${wantType} but produced no envelope` } };
    }
    if (!envelopeResult.ok)
      return stop("FAILED", envelopeResult.failure.code, `${def.id}: ${envelopeResult.failure.message}`);
    move("REPORTED", { envelope: envelopeResult.envelope, envelope_hash: envelopeResult.hash, envelope_type: envelopeResult.envelope_type });
  } else {
    move("REPORTED");
  }

  // ---- GATED: every required gate ran. Then ACCEPTED, only if they all passed.
  const gateCtx = { ...ctx, ...(out?.gateContext ?? {}), envelope_result: envelopeResult };
  const summary = GATES.evaluate(def.gates ?? [], gateCtx);
  move("GATED", { gate_reports: summary.reports, gate_summary: {
    outcome: summary.outcome, passed: summary.passed, failed: summary.failed,
    factual_failures: summary.factual_failures, policy_failures: summary.policy_failures,
  } });

  if (summary.outcome === "FAIL") {
    // A failed FACTUAL gate is not retryable by re-running the same thing —
    // the world has to change. A failed POLICY gate may be, and the retry
    // engine decides; the phase only reports which kind it was.
    const state = summary.factual_failures.length ? "FAILED" : "RETRYABLE";
    return stop(state, "GATE_FAILED",
      `${def.id}: gate(s) failed: ${summary.failed.join(", ")}` +
      (summary.factual_failures.length ? ` — ${summary.factual_failures.join(", ")} state facts and cannot be overridden by anyone` : ""));
  }

  move("ACCEPTED", { outcome: "ACCEPTED" });
  return rec;
}

// ------------------------------------------------------------- recovery view

// What a restarted scheduler needs: the last phase that reached ACCEPTED, the
// one that stopped, and therefore where to resume. Derived from persisted phase
// records only — never from a log line, never from memory.
export function recoveryPoint(attemptDir, workflow) {
  const done = new Map(listPhases(attemptDir).map((p) => [p.phase_id, p]));
  let lastAccepted = null, stopped = null, next = null;
  for (const def of workflow) {
    const p = done.get(def.id);
    if (p?.state === "ACCEPTED") { lastAccepted = def.id; continue; }
    if (p && STOPS.has(p.state)) { stopped = p; break; }
    next = def.id; break;
  }
  return {
    last_accepted: lastAccepted, stopped: stopped ? { phase_id: stopped.phase_id, state: stopped.state, failure: stopped.failure } : null,
    resume_at: stopped ? stopped.phase_id : next,
    completed: next === null && !stopped,
    phases: [...done.values()].map((p) => ({ phase_id: p.phase_id, kind: p.kind, state: p.state, outcome: p.outcome, duration_ms: p.duration_ms, failure: p.failure })),
  };
}
