#!/usr/bin/env node
// SCH Loop — the versioned workflow-template registry.
//
// WHY THIS EXISTS
// The scheduler ran one workflow, and it ran it twice: a hardcoded 16-entry
// array AND sixteen hand-written call sites. Editing the array changed nothing,
// which is the worst kind of configuration — it looks adjustable and is not. And
// every task got the full sixteen: a documentation task waited for a delivery
// approval gate it had no use for.
//
// A template is DATA validated against CLOSED registries. Project data names a
// handler id, never a module path; an unknown handler, role, gate or envelope
// fails closed rather than being skipped. That is the difference between
// configuration and code execution, and it is the whole security story here.
//
// WHAT A TEMPLATE CANNOT DO, enforced in validation rather than in prose:
//   * expand the tools a role has;
//   * expand the write scope a task allowed;
//   * weaken a task's path policy;
//   * name a handler, role, gate or envelope that does not exist.

import { createHash } from "node:crypto";
import * as ROLES from "./roles.mjs";
import { GATES } from "./gates.mjs";
import { REGISTRY as ENVELOPES } from "./envelopes.mjs";
import * as SEM from "./semantic.mjs";

export const SCHEMA_VERSION = 1;

export const PHASE_KINDS = ["HUMAN", "AGENT", "CODE", "GATE"];

// ------------------------------------------------------- the handler registry
//
// The CLOSED set of things a template may ask for. Each id maps to a function
// the scheduler owns. A template cannot introduce a new one, and cannot name a
// file — this list is the entire vocabulary.
export const HANDLERS = {
  "task-prepare":              { id: "task-prepare", kind: "CODE", description: "resolve project, task, workspace and graph state for this attempt" },
  "context-compile":           { id: "context-compile", kind: "CODE", description: "compile the bounded context this attempt is allowed to see" },
  "agent-run":                 { id: "agent-run", kind: "AGENT", description: "run one bounded semantic phase in a fresh external worker" },
  "builder-envelope-parse":    { id: "builder-envelope-parse", kind: "CODE", description: "read the worker's handoff as a typed envelope" },
  "effect-inspect":            { id: "effect-inspect", kind: "CODE", description: "inspect what actually changed in the repository" },
  "deterministic-verification":{ id: "deterministic-verification", kind: "CODE", description: "run the task's required commands in SCH's own process" },
  "semantic-review":           { id: "semantic-review", kind: "AGENT", description: "independent read-only review against acceptance criteria" },
  "delivery-prepare":          { id: "delivery-prepare", kind: "CODE", description: "bind the verified candidate and step the task toward delivery" },
  "delivery-approval":         { id: "delivery-approval", kind: "HUMAN", description: "obtain, or wait for, the operator's signature on this exact diff" },
  "verified-delivery":         { id: "verified-delivery", kind: "CODE", description: "stage, commit, push and remotely verify through the delivery controller" },
  "task-complete":             { id: "task-complete", kind: "CODE", description: "record completion once the controller proved the remote" },
  "gate-only":                 { id: "gate-only", kind: "GATE", description: "evaluate named gates and nothing else" },
  "no-op":                     { id: "no-op", kind: "CODE", description: "structural placeholder that records a phase without doing work" },
};
export const HANDLER_IDS = Object.keys(HANDLERS);

// Templates whose effects are irreversible or wide enough that a person should
// have said yes to the WORKFLOW, not just to the diff it eventually produces.
export const HIGH_RISK_TEMPLATES = new Set(["FULL_SDLC", "SECURITY_REVIEW"]);

// EVERY phase produces a typed envelope, and the default is the point: a CODE
// phase without one produces no evidence, and the first version of these
// templates silently dropped envelopes from eleven phases that used to emit
// them. Defaulting here means a new template cannot make that mistake.
const p = (id, kind, handler, extra = {}) => ({ id, kind, handler, gates: [], output_envelope: "CodeResultEnvelopeV1", ...extra });
const agent = (id, semantic, gates = []) => {
  const h = SEM.SEMANTIC_HANDLERS[semantic];
  if (!h) throw new Error(`no semantic handler ""`);
  return { id, kind: "AGENT", handler: "agent-run", semantic, role: h.role, output_envelope: h.output_envelope, gates: gates.length ? gates : h.gates };
};
const gate = (id, gates) => ({ id, kind: "GATE", handler: "gate-only", gates, output_envelope: "GateReportEnvelopeV1" });

// ------------------------------------------------------------- the templates

const READINESS = ["project-workspace-valid", "dependency-graph-valid", "task-ready"];
const EFFECTS = ["worker-effects-contained", "worker-stayed-in-its-worktree", "changed-paths-allowed", "forbidden-git-effects-absent"];
const VERIFY = ["required-verification-passed", "prompt-budget-valid", "secret-scan-passed"];

export const TEMPLATES = {
  // Find out where something is. Reads nothing into the repository.
  SCOUT: {
    schema_version: 1, id: "SCOUT", version: 1,
    description: "Locate and report where work would land. Changes nothing.",
    supported_task_types: ["*"],
    phases: [
      p("prepare", "CODE", "task-prepare"),
      gate("task-readiness", READINESS),
      p("compile-context", "CODE", "context-compile"),
      agent("scout", "scout"),
      p("inspect-effects", "CODE", "effect-inspect"),
      gate("effects-gate", EFFECTS),
    ],
  },
  PLAN_ONLY: {
    schema_version: 1, id: "PLAN_ONLY", version: 1,
    description: "Produce a plan for an approved task. Implements nothing.",
    supported_task_types: ["*"],
    phases: [
      p("prepare", "CODE", "task-prepare"),
      gate("task-readiness", READINESS),
      p("compile-context", "CODE", "context-compile"),
      agent("plan", "plan"),
      p("inspect-effects", "CODE", "effect-inspect"),
      gate("effects-gate", EFFECTS),
    ],
  },
  BUILD_ONLY: {
    schema_version: 1, id: "BUILD_ONLY", version: 1,
    description: "Implement one task and stop before verification. For work whose proof is external.",
    supported_task_types: ["*"],
    phases: [
      p("prepare", "CODE", "task-prepare"),
      gate("task-readiness", READINESS),
      p("compile-context", "CODE", "context-compile"),
      agent("implement", "implement"),
      p("parse-builder-envelope", "CODE", "builder-envelope-parse", { output_envelope: "BuilderEnvelopeV1", gates: ["handoff-valid"] }),
      p("inspect-effects", "CODE", "effect-inspect"),
      gate("effects-gate", EFFECTS),
    ],
  },
  PLAN_BUILD: {
    schema_version: 1, id: "PLAN_BUILD", version: 1,
    description: "Plan, then implement. Verification is somebody else's phase.",
    supported_task_types: ["*"],
    phases: [
      p("prepare", "CODE", "task-prepare"),
      gate("task-readiness", READINESS),
      p("compile-context", "CODE", "context-compile"),
      agent("plan", "plan"),
      agent("implement", "implement"),
      p("parse-builder-envelope", "CODE", "builder-envelope-parse", { output_envelope: "BuilderEnvelopeV1", gates: ["handoff-valid"] }),
      p("inspect-effects", "CODE", "effect-inspect"),
      gate("effects-gate", EFFECTS),
    ],
  },
  PLAN_BUILD_TEST: {
    schema_version: 1, id: "PLAN_BUILD_TEST", version: 1,
    description: "Plan, build and deterministically verify one task. No delivery.",
    supported_task_types: ["frontend", "backend", "infra", "testing", "*"],
    phases: [
      p("prepare", "CODE", "task-prepare"),
      gate("task-readiness", READINESS),
      p("compile-context", "CODE", "context-compile"),
      agent("plan", "plan"),
      agent("implement", "implement"),
      p("parse-builder-envelope", "CODE", "builder-envelope-parse", { output_envelope: "BuilderEnvelopeV1", gates: ["handoff-valid"] }),
      p("inspect-effects", "CODE", "effect-inspect"),
      gate("effects-gate", EFFECTS),
      p("verify", "CODE", "deterministic-verification"),
      gate("verification-gate", VERIFY),
    ],
  },
  BUILD_REVIEW: {
    schema_version: 1, id: "BUILD_REVIEW", version: 1,
    description: "Implement, verify, and have an independent reviewer compare it with the criteria.",
    supported_task_types: ["*"],
    phases: [
      p("prepare", "CODE", "task-prepare"),
      gate("task-readiness", READINESS),
      p("compile-context", "CODE", "context-compile"),
      agent("implement", "implement"),
      p("parse-builder-envelope", "CODE", "builder-envelope-parse", { output_envelope: "BuilderEnvelopeV1", gates: ["handoff-valid"] }),
      p("inspect-effects", "CODE", "effect-inspect"),
      gate("effects-gate", EFFECTS),
      p("verify", "CODE", "deterministic-verification"),
      gate("verification-gate", VERIFY),
      { ...agent("semantic-review", "review"), handler: "semantic-review" },
      gate("review-gate", []),
    ],
  },
  // The workflow the scheduler has always run, now named and versioned. Its
  // phase list is IDENTICAL to the previous hardcoded one on purpose: every
  // existing task keeps behaving exactly as it did.
  FULL_SDLC: {
    schema_version: 1, id: "FULL_SDLC", version: 1,
    description: "Implement, verify, review, and deliver to the remote through the controller.",
    supported_task_types: ["*"],
    high_risk: true,
    phases: [
      p("prepare", "CODE", "task-prepare"),
      gate("task-readiness", READINESS),
      p("compile-context", "CODE", "context-compile"),
      agent("implement", "implement", ["skills-approved", "executor-ready"]),
      p("parse-builder-envelope", "CODE", "builder-envelope-parse", { output_envelope: "BuilderEnvelopeV1", gates: ["handoff-valid"] }),
      p("inspect-effects", "CODE", "effect-inspect"),
      gate("effects-gate", EFFECTS),
      p("verify", "CODE", "deterministic-verification"),
      gate("verification-gate", VERIFY),
      { ...agent("semantic-review", "review"), handler: "semantic-review" },
      gate("review-gate", []),
      p("prepare-delivery", "CODE", "delivery-prepare", { gates: ["verified-diff-unchanged"] }),
      p("delivery-approval", "HUMAN", "delivery-approval", { output_envelope: null, gates: ["delivery-approval-valid"] }),
      p("deliver", "CODE", "verified-delivery", { output_envelope: "DeliveryEnvelopeV1" }),
      gate("remote-verification", ["outgoing-commit-safe", "remote-commit-present"]),
      p("complete-task", "CODE", "task-complete", { gates: ["task-completion-valid"] }),
    ],
  },
  SECURITY_REVIEW: {
    schema_version: 1, id: "SECURITY_REVIEW", version: 1,
    description: "Read-only security review of an approved change. Writes nothing, delivers nothing.",
    supported_task_types: ["security", "review"],
    high_risk: true,
    // No `inspect-effects`/`effects-gate` phase, and that is not an omission:
    // the review handler's OWN gates (`no-repository-effects`,
    // `forbidden-git-effects-absent`) already prove the reviewer changed
    // nothing, and they run at the point the reviewer finishes rather than
    // before it has started.
    phases: [
      p("prepare", "CODE", "task-prepare"),
      gate("task-readiness", READINESS),
      p("compile-context", "CODE", "context-compile"),
      { ...agent("semantic-review", "review"), handler: "semantic-review" },
      gate("review-gate", []),
    ],
  },
  DOCUMENTATION_ONLY: {
    schema_version: 1, id: "DOCUMENTATION_ONLY", version: 1,
    description: "Document work that already exists. Cheap model, narrow write scope.",
    supported_task_types: ["docs", "documentation"],
    phases: [
      p("prepare", "CODE", "task-prepare"),
      gate("task-readiness", READINESS),
      p("compile-context", "CODE", "context-compile"),
      agent("document", "document"),
      p("inspect-effects", "CODE", "effect-inspect"),
      gate("effects-gate", EFFECTS),
      p("verify", "CODE", "deterministic-verification"),
      gate("verification-gate", VERIFY),
    ],
  },
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES);

// THE SYSTEM DEFAULT, and the reasoning matters because the obvious choice is
// wrong. A non-delivering default (PLAN_BUILD_TEST) looks safer, and it would
// silently stop delivering for every project that already exists — changing
// proven behaviour for everyone who never asked for a workflow. That is not
// safety, it is a regression wearing safety's clothes.
//
// FULL_SDLC is what the scheduler has always run, and delivery inside it is
// still gated by an approval a person has to give. A project that wants less
// says so; nothing silently does less than it did yesterday.
export const SAFE_DEFAULT = { template: "FULL_SDLC", version: 1 };

const stable = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
};
export const templateHash = (id) => (TEMPLATES[id] ? createHash("sha256").update(stable(TEMPLATES[id])).digest("hex") : null);

// ------------------------------------------------------------- validation

// Everything a template asserts, checked against the closed registries. This is
// what makes a template data rather than an instruction.
export function validateTemplate(t, { taskType = null, task = null } = {}) {
  const problems = [], warnings = [];
  const bad = (code, message) => problems.push({ code, message });

  if (!t || typeof t !== "object") return { ok: false, problems: [{ code: "TEMPLATE_MALFORMED", message: "a template must be an object" }], warnings };
  if (Number(t.schema_version) !== SCHEMA_VERSION) bad("TEMPLATE_SCHEMA_UNKNOWN", `template "${t.id}" declares schema_version ${t.schema_version}; this engine speaks ${SCHEMA_VERSION}`);
  if (!t.id || !/^[A-Z][A-Z0-9_]*$/.test(t.id)) bad("TEMPLATE_MALFORMED", `template id "${t.id}" must be SCREAMING_SNAKE_CASE`);
  if (!Number.isInteger(t.version) || t.version < 1) bad("TEMPLATE_MALFORMED", `template "${t.id}" needs an integer version >= 1`);
  if (!Array.isArray(t.phases) || !t.phases.length) bad("TEMPLATE_MALFORMED", `template "${t.id}" has no phases`);

  const seen = new Set();
  for (const ph of t.phases ?? []) {
    if (!ph?.id) { bad("TEMPLATE_MALFORMED", `template "${t.id}" has a phase with no id`); continue; }
    if (seen.has(ph.id)) bad("TEMPLATE_MALFORMED", `template "${t.id}" repeats phase id "${ph.id}"`);
    seen.add(ph.id);

    if (!PHASE_KINDS.includes(ph.kind)) bad("UNKNOWN_PHASE_KIND", `phase "${ph.id}": kind "${ph.kind}" is not one of ${PHASE_KINDS.join(", ")}`);
    // CLOSED HANDLER REGISTRY. This is the line that stops project data naming a module.
    if (!HANDLERS[ph.handler]) bad("UNKNOWN_HANDLER", `phase "${ph.id}": handler "${ph.handler}" is not registered (${HANDLER_IDS.join(", ")})`);
    else if (HANDLERS[ph.handler].kind !== ph.kind)
      bad("HANDLER_KIND_MISMATCH", `phase "${ph.id}": handler "${ph.handler}" is a ${HANDLERS[ph.handler].kind} handler but the phase declares ${ph.kind}`);

    if (ph.kind === "AGENT" || ph.role) {
      if (!ph.role) bad("TEMPLATE_MALFORMED", `phase "${ph.id}" is an AGENT phase with no role`);
      else if (!ROLES.ROLES[ph.role]) bad("UNKNOWN_ROLE", `phase "${ph.id}": role "${ph.role}" is not in the roster (${ROLES.ROLE_IDS.join(", ")})`);
    }
    // EVERY AGENT PHASE MUST BE EXECUTABLE.
    //
    // A template used to be able to declare a scout, a planner or a documenter
    // that the scheduler had no branch for; the phase was then recorded as
    // "absent" at run time, so the template promised work it could not do. A
    // semantic phase is now a registered handler or the template is REJECTED —
    // there is no third state and no silent downgrade.
    if (ph.kind === "AGENT") {
      const sem = SEM.validateSemanticPhase(ph);
      for (const p of sem.problems) bad(p.code, p.message);
    } else if (ph.semantic) {
      bad("SEMANTIC_KIND_MISMATCH", `phase "${ph.id}" names semantic handler "${ph.semantic}" but is a ${ph.kind} phase — only an AGENT phase runs one`);
    }
    if (ph.output_envelope && !ENVELOPES[ph.output_envelope])
      bad("UNKNOWN_ENVELOPE", `phase "${ph.id}": envelope "${ph.output_envelope}" is not registered (${Object.keys(ENVELOPES).join(", ")})`);
    // A role's declared envelope and the phase's must agree, or the phase is
    // asking a role for something it does not produce.
    if (ph.role && ph.output_envelope && ROLES.ROLES[ph.role] && ROLES.ROLES[ph.role].output_envelope !== ph.output_envelope)
      warnings.push({ code: "ENVELOPE_ROLE_MISMATCH", message: `phase "${ph.id}": role "${ph.role}" produces ${ROLES.ROLES[ph.role].output_envelope}, the phase declares ${ph.output_envelope}` });

    for (const g of ph.gates ?? [])
      if (!GATES[g]) bad("UNKNOWN_GATE", `phase "${ph.id}": gate "${g}" is not registered`);

    // A TEMPLATE CANNOT EXPAND AUTHORITY. These fields do not exist in the
    // schema, and a template that invents them is refused rather than ignored —
    // silently dropping an authority grant teaches the author it worked.
    for (const forbidden of ["tools", "writes", "allowed_paths", "allowedPaths", "forbidden_paths", "write_scope", "grant"])
      if (ph[forbidden] !== undefined)
        bad("TEMPLATE_CANNOT_GRANT_AUTHORITY", `phase "${ph.id}" tries to set "${forbidden}". A template sequences work; it never grants tools or write scope — those come from the role and the task policy.`);
  }

  // Task-type compatibility.
  if (taskType && Array.isArray(t.supported_task_types) && !t.supported_task_types.includes("*") && !t.supported_task_types.includes(taskType))
    bad("TASK_TYPE_UNSUPPORTED", `template "${t.id}" supports ${t.supported_task_types.join(", ")} — not "${taskType}"`);

  // A template with a delivering phase on a task with no verification is a
  // template that would push unverified work.
  if ((t.phases ?? []).some((x) => x.handler === "verified-delivery") && task && !(task.verify ?? []).length)
    bad("TEMPLATE_REQUIRES_VERIFICATION", `template "${t.id}" delivers to a remote, but task #${task.id} has no required verification command`);

  return { ok: problems.length === 0, problems, warnings, template_id: t.id, template_version: t.version };
}

export function validateAll() {
  const results = TEMPLATE_IDS.map((id) => ({ id, ...validateTemplate(TEMPLATES[id]) }));
  return { ok: results.every((r) => r.ok), results, count: results.length };
}

// ------------------------------------------------------------- selection
//
//   task override → task-type project policy → project default → safe default
//
// Precedence is explicit and reported, because "why did this task run THAT
// workflow" must be answerable without reading four config files.
export function selectTemplate({ task = null, project = null } = {}) {
  const wanted =
    normalize(task?.workflow) ??
    normalize(project?.workflowPolicy?.task_types?.[task?.category]) ??
    normalize(project?.workflowPolicy?.default) ??
    { ...SAFE_DEFAULT, _source: "safe system default" };

  const source = wanted._source ?? (
    normalize(task?.workflow) ? "task override"
      : normalize(project?.workflowPolicy?.task_types?.[task?.category]) ? `project policy for task type "${task?.category}"`
      : "project default");

  const t = TEMPLATES[wanted.template];
  if (!t)
    return { ok: false, failure: { code: "UNKNOWN_TEMPLATE", message: `no workflow template "${wanted.template}" (${TEMPLATE_IDS.join(", ")})` }, selected_by: source };
  if (wanted.version !== undefined && Number(wanted.version) !== t.version)
    return { ok: false, failure: { code: "TEMPLATE_VERSION_UNAVAILABLE",
      message: `template "${t.id}" is at version ${t.version}; version ${wanted.version} was requested. Historical executions remain readable, but a new run uses a version that exists.` }, selected_by: source };

  const v = validateTemplate(t, { taskType: task?.category ?? null, task });
  if (!v.ok) return { ok: false, failure: { code: v.problems[0].code, message: v.problems[0].message }, selected_by: source, problems: v.problems };

  return {
    ok: true, selected_by: source,
    template: t, template_id: t.id, template_version: t.version, template_hash: templateHash(t.id),
    high_risk: Boolean(t.high_risk) || HIGH_RISK_TEMPLATES.has(t.id),
    warnings: v.warnings,
  };
}

const normalize = (w) => {
  if (!w) return null;
  if (typeof w === "string") return { template: w };
  if (typeof w === "object" && w.template) return { template: String(w.template), version: w.version === undefined ? undefined : Number(w.version) };
  return null;
};

// --------------------------------------------------------------- projection

export const templateProjection = () => ({
  schema_version: SCHEMA_VERSION,
  templates: TEMPLATE_IDS.map((id) => {
    const t = TEMPLATES[id];
    return {
      template_id: id, version: t.version, hash: templateHash(id), description: t.description,
      supported_task_types: t.supported_task_types,
      high_risk: Boolean(t.high_risk) || HIGH_RISK_TEMPLATES.has(id),
      phase_count: t.phases.length,
      phases: t.phases.map((x) => ({ id: x.id, kind: x.kind, handler: x.handler, role: x.role ?? null, output_envelope: x.output_envelope ?? null, gates: x.gates ?? [] })),
      roles_used: [...new Set(t.phases.map((x) => x.role).filter(Boolean))],
      delivers: t.phases.some((x) => x.handler === "verified-delivery"),
    };
  }),
  handlers: HANDLER_IDS.map((id) => HANDLERS[id]),
  safe_default: SAFE_DEFAULT,
});
