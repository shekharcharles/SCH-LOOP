#!/usr/bin/env node
// SCH Loop — the typed envelope registry.
//
// WHY THIS EXISTS
// The worker handoff was one shape for one job. A phase engine needs several —
// a planner's output is not a builder's, a reviewer's is not a delivery's — and
// each of them crosses a process boundary carrying text a model wrote.
//
// THE INVARIANT, WHICH IS THE WHOLE POINT:
//
//     Envelope claims are not system evidence.
//
// An envelope says what the agent BELIEVES it did. What it actually did is in
// the git effects, the verification results and the gate reports, all produced
// by SCH's own process. The envelope is parsed, bounded, type-checked and then
// COMPARED against evidence — it is never the reason anything is accepted.
//
// Everything here is deliberately dumb: fixed key sets, fixed enums, hard
// length caps. An envelope is untrusted input from a process that reads the
// repository, and the repository can contain anything anybody ever committed.

import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;

// The markers the worker prints around its envelope. Identical to the original
// handoff markers so a worker built for the previous milestone still parses.
export const ENVELOPE_OPEN = "<<<SCH_HANDOFF_JSON>>>";
export const ENVELOPE_CLOSE = "<<<END_SCH_HANDOFF_JSON>>>";

// ------------------------------------------------------------------ limits

export const LIMITS = {
  envelope_bytes: 64 * 1024,   // the whole block
  summary: 4000,
  string: 2000,                // any other single string
  array: 50,                   // any array
  artifacts: 50,
  learnings: 10,
};

export const AGENT_STATUSES = ["SUCCESS", "BLOCKED", "FAILED", "NEEDS_DECISION"];
export const REVIEW_OUTCOMES = ["APPROVE", "CHANGES_REQUIRED", "NEEDS_DECISION", "INCONCLUSIVE"];

// --------------------------------------------------------------- the registry

// Every envelope shares the base. `extra` is the ONLY additional key set a type
// may carry — anything else is rejected rather than ignored, because a key
// nobody validates is a key somebody will eventually put an instruction in.
const BASE_KEYS = [
  "schema_version", "envelope_type", "project_id", "task_id", "run_id", "phase_id",
  "status", "summary", "artifacts", "claims", "notes_for_next_phase", "candidate_learnings",
];

export const REGISTRY = {
  PlannerEnvelopeV1: {
    kind: "AGENT", statuses: AGENT_STATUSES,
    extra: { plan_steps: "string[]", open_questions: "string[]" },
  },
  // A scout reports WHERE, never what it changed — it has no write authority, so
  // an envelope claiming changed files from a scout is a contradiction the
  // registry refuses to represent.
  ScoutEnvelopeV1: {
    kind: "AGENT", statuses: AGENT_STATUSES,
    extra: { locations: "string[]", entry_points: "string[]", observations: "string[]", open_questions: "string[]" },
  },
  BuilderEnvelopeV1: {
    kind: "AGENT", statuses: AGENT_STATUSES,
    extra: { files_reported_changed: "string[]", commands_reported: "string[]", tests_reported: "string[]", decisions: "string[]", issues: "string[]", recommended_next_action: "string" },
  },
  // A repairer answers one question: what was broken, and what was done about
  // it. `addressed_checks` names the failing checks it believes it fixed — a
  // claim, compared afterwards against the re-run, never trusted.
  RepairEnvelopeV1: {
    kind: "AGENT", statuses: AGENT_STATUSES,
    extra: { addressed_checks: "string[]", files_reported_changed: "string[]", root_cause: "string",
             remaining_concerns: "string[]", recommended_next_action: "string" },
  },
  DocumentationEnvelopeV1: {
    kind: "AGENT", statuses: AGENT_STATUSES,
    extra: { files_reported_changed: "string[]", sections_written: "string[]", claims_verified: "string[]" },
  },
  ReviewerEnvelopeV1: {
    kind: "AGENT", statuses: AGENT_STATUSES,
    extra: { outcome: REVIEW_OUTCOMES, findings: "string[]", must_fix: "string[]" },
  },
  DecisionRequestEnvelopeV1: {
    kind: "AGENT", statuses: ["NEEDS_DECISION"],
    extra: { gate_type: "string", question: "string", options: "string[]", recommended: "string" },
  },
  CodeResultEnvelopeV1: {
    kind: "CODE", statuses: ["SUCCESS", "FAILED", "BLOCKED", "NEEDS_DECISION"],
    extra: { result: "object", failure_code: "string" },
  },
  GateReportEnvelopeV1: {
    kind: "GATE", statuses: ["SUCCESS", "FAILED", "NEEDS_DECISION"],
    extra: { gates: "object[]", outcome: ["PASS", "FAIL", "SKIP"] },
  },
  DeliveryEnvelopeV1: {
    kind: "CODE", statuses: ["SUCCESS", "FAILED", "BLOCKED", "NEEDS_DECISION"],
    extra: { delivery_id: "string", commit: "string", branch: "string", remote: "string", state: "string" },
  },
};

export const ENVELOPE_TYPES = Object.keys(REGISTRY);

// ------------------------------------------------------------------ helpers

const isStr = (v) => typeof v === "string";
const isArr = (v) => Array.isArray(v);
const fail = (code, message) => ({ ok: false, failure: { code, message } });

export const envelopeHash = (env) => createHash("sha256").update(stableJson(env)).digest("hex");

// Stable serialisation so a hash means "this content", not "this key order".
export function stableJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
}

// -------------------------------------------------------------- extraction

// Exactly ONE envelope. Two blocks is not "use the last one" — it is a worker
// that printed a second opinion, or repository text that printed a first, and
// choosing between them is exactly the judgement a controller must not make.
export function extract(stdout) {
  const text = String(stdout ?? "");
  const opens = [...text.matchAll(new RegExp(ENVELOPE_OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
  if (opens.length === 0) return fail("ENVELOPE_MISSING", "the worker printed no envelope block");
  if (opens.length > 1) return fail("ENVELOPE_AMBIGUOUS", `the worker printed ${opens.length} envelope blocks — exactly one is required`);
  const start = opens[0].index + ENVELOPE_OPEN.length;
  const end = text.indexOf(ENVELOPE_CLOSE, start);
  if (end === -1) return fail("ENVELOPE_MALFORMED", "the envelope block was opened but never closed");
  const raw = text.slice(start, end).trim();
  if (Buffer.byteLength(raw, "utf8") > LIMITS.envelope_bytes)
    return fail("ENVELOPE_TOO_LARGE", `the envelope is ${Buffer.byteLength(raw, "utf8")} bytes, over the ${LIMITS.envelope_bytes} limit`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return fail("ENVELOPE_MALFORMED", `the envelope is not valid JSON: ${e.message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return fail("ENVELOPE_MALFORMED", "the envelope must be a JSON object");
  return { ok: true, envelope: parsed, raw };
}

// -------------------------------------------------------------- validation

// `identity` is what the CONTROLLER knows: which project, task, run, attempt and
// phase this envelope had better belong to. An envelope that names a different
// one is not a mistake to correct — it is either a stale process or a prompt
// injection, and both are refused.
export function validate(envelope, identity, { type = null } = {}) {
  const e = envelope;
  if (Number(e.schema_version) !== SCHEMA_VERSION)
    return fail("ENVELOPE_SCHEMA_UNKNOWN", `envelope schema_version ${e.schema_version} — this engine speaks ${SCHEMA_VERSION}`);

  const declared = String(e.envelope_type ?? "");
  if (!REGISTRY[declared]) return fail("ENVELOPE_TYPE_UNKNOWN", `unknown envelope_type "${declared}" (${ENVELOPE_TYPES.join(", ")})`);
  if (type && declared !== type) return fail("ENVELOPE_TYPE_MISMATCH", `this phase expects ${type}, the envelope declares ${declared}`);
  const def = REGISTRY[declared];

  const allowed = new Set([...BASE_KEYS, ...Object.keys(def.extra ?? {})]);
  const stray = Object.keys(e).filter((k) => !allowed.has(k));
  if (stray.length) return fail("ENVELOPE_UNKNOWN_FIELD", `envelope carries field(s) nothing validates: ${stray.join(", ")} — an unvalidated field is where an instruction hides`);

  for (const [k, want] of [["project_id", identity.project_id], ["task_id", String(identity.task_id)], ["run_id", identity.run_id], ["phase_id", identity.phase_id]]) {
    if (want === undefined || want === null) continue;
    if (String(e[k] ?? "") !== String(want))
      return fail("ENVELOPE_IDENTITY_MISMATCH", `envelope ${k} is "${e[k]}", this phase is "${want}"`);
  }
  if (identity.attempt !== undefined && identity.attempt !== null && e.claims && e.claims.attempt !== undefined
      && Number(e.claims.attempt) !== Number(identity.attempt))
    return fail("ENVELOPE_IDENTITY_MISMATCH", `envelope claims attempt ${e.claims.attempt}, this is attempt ${identity.attempt}`);

  if (!def.statuses.includes(String(e.status ?? "")))
    return fail("ENVELOPE_STATUS_INVALID", `status "${e.status}" is not one of ${def.statuses.join(", ")} for ${declared}`);

  if (!isStr(e.summary) || !e.summary.trim())
    return fail("ENVELOPE_FIELD_INVALID", "summary must be a non-empty string");
  if (e.summary.length > LIMITS.summary)
    return fail("ENVELOPE_FIELD_TOO_LONG", `summary is ${e.summary.length} characters, over the ${LIMITS.summary} limit`);

  for (const [k, cap] of [["artifacts", LIMITS.artifacts], ["candidate_learnings", LIMITS.learnings]]) {
    if (e[k] === undefined) continue;
    if (!isArr(e[k])) return fail("ENVELOPE_FIELD_INVALID", `${k} must be an array`);
    if (e[k].length > cap) return fail("ENVELOPE_FIELD_TOO_LONG", `${k} has ${e[k].length} entries, over the ${cap} limit`);
  }
  if (e.claims !== undefined && (typeof e.claims !== "object" || e.claims === null || Array.isArray(e.claims)))
    return fail("ENVELOPE_FIELD_INVALID", "claims must be an object");
  if (e.notes_for_next_phase !== undefined && (!isStr(e.notes_for_next_phase) || e.notes_for_next_phase.length > LIMITS.string))
    return fail("ENVELOPE_FIELD_INVALID", `notes_for_next_phase must be a string under ${LIMITS.string} characters`);

  for (const [k, spec] of Object.entries(def.extra ?? {})) {
    const v = e[k];
    if (v === undefined) continue;
    if (Array.isArray(spec)) {
      if (!spec.includes(String(v))) return fail("ENVELOPE_FIELD_INVALID", `${k} must be one of ${spec.join(", ")}`);
    } else if (spec === "string") {
      if (!isStr(v) || v.length > LIMITS.string) return fail("ENVELOPE_FIELD_INVALID", `${k} must be a string under ${LIMITS.string} characters`);
    } else if (spec === "string[]") {
      if (!isArr(v)) return fail("ENVELOPE_FIELD_INVALID", `${k} must be an array of strings`);
      if (v.length > LIMITS.array) return fail("ENVELOPE_FIELD_TOO_LONG", `${k} has ${v.length} entries, over the ${LIMITS.array} limit`);
      for (const x of v) if (!isStr(x) || x.length > LIMITS.string) return fail("ENVELOPE_FIELD_INVALID", `${k} entries must be strings under ${LIMITS.string} characters`);
    } else if (spec === "object[]") {
      if (!isArr(v) || v.length > LIMITS.array) return fail("ENVELOPE_FIELD_INVALID", `${k} must be an array of at most ${LIMITS.array} objects`);
    } else if (spec === "object") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return fail("ENVELOPE_FIELD_INVALID", `${k} must be an object`);
    }
  }

  const art = validateArtifacts(e.artifacts ?? []);
  if (!art.ok) return art;

  return { ok: true, envelope: e, envelope_type: declared, kind: def.kind, hash: envelopeHash(e) };
}

// An artifact is a REFERENCE into evidence this run already owns. It may not be
// an absolute path, may not escape, and may not name a scheme that would make
// something fetch it.
export function validateArtifacts(artifacts) {
  for (const a of artifacts) {
    const ref = isStr(a) ? a : a?.ref;
    if (!isStr(ref)) return fail("ENVELOPE_ARTIFACT_INVALID", "each artifact needs a string ref");
    if (!ref.startsWith("artifact://"))
      return fail("ENVELOPE_ARTIFACT_INVALID", `artifact "${ref}" must be an artifact:// reference — nothing else is resolvable evidence`);
    const rel = ref.slice("artifact://".length);
    if (!rel || rel.length > 512) return fail("ENVELOPE_ARTIFACT_INVALID", `artifact ref "${ref}" is empty or absurdly long`);
    if (/^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("/") || rel.startsWith("\\"))
      return fail("ENVELOPE_ARTIFACT_INVALID", `artifact "${ref}" is an absolute path`);
    if (rel.split(/[\\/]/).includes("..")) return fail("ENVELOPE_ARTIFACT_INVALID", `artifact "${ref}" escapes its run directory`);
  }
  return { ok: true };
}

// ------------------------------------------------------ parse + validate once

export function parse(stdout, identity, { type = null } = {}) {
  const got = extract(stdout);
  if (!got.ok) return got;
  const v = validate(got.envelope, identity, { type });
  if (!v.ok) return v;
  return { ...v, raw: got.raw };
}

// ------------------------------------------------------------ legacy adapter

// The previous milestone's handoff, read as a BuilderEnvelopeV1. A worker built
// against the old contract still works: nothing about it was wrong, it was just
// one type in a world that now has seven.
export const LEGACY_HANDOFF_KEYS = ["schema_version", "run_id", "project_id", "task_id", "worker_status",
  "summary", "files_reported_changed", "commands_reported", "tests_reported", "decisions", "issues",
  "candidate_lessons", "recommended_next_action"];

const LEGACY_STATUS = { COMPLETED: "SUCCESS", BLOCKED: "BLOCKED", FAILED: "FAILED" };

export function isLegacyHandoff(obj) {
  return Boolean(obj) && typeof obj === "object" && obj.envelope_type === undefined && obj.worker_status !== undefined;
}

export function adaptLegacyHandoff(handoff, identity) {
  if (!isLegacyHandoff(handoff)) return fail("ENVELOPE_TYPE_UNKNOWN", "not a legacy worker handoff");
  const status = LEGACY_STATUS[String(handoff.worker_status)];
  if (!status) return fail("ENVELOPE_STATUS_INVALID", `legacy worker_status "${handoff.worker_status}" has no envelope status`);
  const arr = (v) => (Array.isArray(v) ? v.slice(0, LIMITS.array).map((x) => String(x).slice(0, LIMITS.string)) : []);
  const env = {
    schema_version: SCHEMA_VERSION, envelope_type: "BuilderEnvelopeV1",
    project_id: String(handoff.project_id ?? identity.project_id),
    task_id: String(handoff.task_id ?? identity.task_id),
    run_id: String(handoff.run_id ?? identity.run_id),
    phase_id: String(identity.phase_id ?? "implement"),
    status,
    summary: String(handoff.summary ?? "(no summary)").slice(0, LIMITS.summary) || "(no summary)",
    artifacts: [], claims: { adapted_from: "legacy-worker-handoff", worker_status: String(handoff.worker_status) },
    notes_for_next_phase: String(handoff.recommended_next_action ?? "").slice(0, LIMITS.string),
    candidate_learnings: arr(handoff.candidate_lessons).slice(0, LIMITS.learnings),
    files_reported_changed: arr(handoff.files_reported_changed),
    commands_reported: arr(handoff.commands_reported),
    tests_reported: arr(handoff.tests_reported),
    decisions: arr(handoff.decisions),
    issues: arr(handoff.issues),
    recommended_next_action: String(handoff.recommended_next_action ?? "").slice(0, LIMITS.string),
  };
  const v = validate(env, identity, { type: "BuilderEnvelopeV1" });
  if (!v.ok) return v;
  return { ...v, adapted: true };
}

// --------------------------------------------------------------- construction

// Envelopes SCH itself produces for CODE and GATE phases. Built here so every
// phase result on disk has the same shape whether a model or a function made it.
export function build(type, identity, { status, summary, artifacts = [], claims = {}, notes = "", learnings = [], ...extra }) {
  const env = {
    schema_version: SCHEMA_VERSION, envelope_type: type,
    project_id: String(identity.project_id), task_id: String(identity.task_id),
    run_id: identity.run_id ?? null, phase_id: String(identity.phase_id),
    status, summary: String(summary ?? "").slice(0, LIMITS.summary) || "(no summary)",
    artifacts, claims, notes_for_next_phase: String(notes ?? "").slice(0, LIMITS.string),
    candidate_learnings: learnings.slice(0, LIMITS.learnings),
    ...extra,
  };
  if (env.run_id === null) delete env.run_id;
  return env;
}
