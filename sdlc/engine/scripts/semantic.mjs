#!/usr/bin/env node
// SCH Loop — the closed registry of executable semantic AGENT phases.
//
// WHY THIS EXISTS
// Four built-in templates declared phases that never ran. `SCOUT` announced a
// scout, `PLAN_ONLY` announced a planner, `DOCUMENTATION_ONLY` announced a
// documenter — and the scheduler, which dispatched on phase ID, simply had no
// branch for any of them. They were recorded as `NOT_IN_WORKFLOW`, which is a
// lie: they WERE in the workflow. A template that can promise work it cannot do
// is worse than one that offers less.
//
// So a semantic phase is now a registered handler or it is a validation error.
// There is no third state, and no built-in may declare a phase that cannot run.
//
// THE EFFECT POLICY IS THE PART THAT MATTERS. Claude CLI gives SCH no tool
// sandbox: there is no API that stops a read-only worker from writing a file.
// Pretending otherwise would be the dishonest kind of security. What SCH can do,
// and does, is:
//
//   * compile the prompt with an EMPTY allow-list, so nothing is authorized;
//   * inspect what actually changed in the repository afterwards;
//   * fail the phase on any effect, as a ROLE_POLICY_VIOLATION;
//   * preserve the evidence and never silently revert it.
//
// That is enforcement after the fact, not prevention — and it is named as such
// here and in the README rather than dressed up as isolation.

import * as ROLES from "./roles.mjs";
import { REGISTRY as ENVELOPES } from "./envelopes.mjs";
import { GATES } from "./gates.mjs";

export const SCHEMA_VERSION = 1;

// What a handler is allowed to change in the repository.
//
//   NO_EFFECTS     nothing at all. Any changed path fails the phase.
//   TASK_POLICY    exactly the task's allowed paths, minus its forbidden ones.
//   DOCUMENTATION  the intersection of the task policy and the documentation
//                  allow-list — never the union, and never inferred from a file
//                  extension alone.
export const EFFECT_POLICIES = ["NO_EFFECTS", "TASK_POLICY", "DOCUMENTATION"];

// Documentation paths, named explicitly. A `.md` file is not automatically
// documentation: `packages/foo/src/README.md` next to source is still inside a
// source tree, and inferring authority from an extension is how a documenter
// ends up editing a package manifest that happens to end in `.json`.
export const DOCUMENTATION_PATHS = [
  "docs/**", "README.md", "SCH-LOOP.md", "CHANGELOG.md", "CONTRIBUTING.md",
  "*.md", "doc/**", "documentation/**",
];

// Paths a documenter may NEVER touch, whatever the task policy says and
// whatever the glob above would otherwise admit.
export const DOCUMENTATION_FORBIDDEN = [
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "pyproject.toml", "Cargo.toml", "go.mod", "tsconfig.json", "Dockerfile",
  "scripts/**", "src/**", "tests/**", "test/**", ".github/**", ".sch-loop/**", ".git/**",
];

const h = (id, o) => ({ id, schema_version: SCHEMA_VERSION, phase_kind: "AGENT", ...o });

// ------------------------------------------------------------- the registry

export const SEMANTIC_HANDLERS = {
  // Find out where the work would land. Changes nothing, ever.
  scout: h("scout", {
    role: "scout",
    purpose: "Locate and report where the work would land, and what constrains it.",
    prompt_template: "scout@1",
    output_envelope: "ScoutEnvelopeV1",
    effect_policy: "NO_EFFECTS",
    writes_allowed: false,
    context: ["task", "acceptance-criteria", "path-policy", "dependencies"],
    // `no-repository-effects` is the one that makes read-only real.
    gates: ["handoff-valid", "no-repository-effects", "forbidden-git-effects-absent"],
    completion: "READ_ONLY_COMPLETED",
  }),

  // Decide HOW an approved task should be done. Does not do it.
  plan: h("plan", {
    role: "planner",
    purpose: "Produce a bounded implementation plan for an approved task.",
    prompt_template: "planner@1",
    output_envelope: "PlannerEnvelopeV1",
    effect_policy: "NO_EFFECTS",
    writes_allowed: false,
    context: ["task", "acceptance-criteria", "path-policy", "dependencies", "scout"],
    gates: ["handoff-valid", "no-repository-effects", "forbidden-git-effects-absent",
            "plan-envelope-valid", "plan-scope-valid"],
    completion: "PLAN_COMPLETED",
  }),

  // The one that already worked. Writes inside the task's own policy.
  implement: h("implement", {
    role: "builder",
    purpose: "Implement one approved task inside its path policy.",
    prompt_template: "builder@1",
    // The builder's envelope is parsed by the following CODE phase, which is
    // where `handoff-valid` runs — keeping the legacy pipeline shape intact.
    output_envelope: null,
    effect_policy: "TASK_POLICY",
    writes_allowed: true,
    context: ["task", "acceptance-criteria", "path-policy", "dependencies", "plan", "skills"],
    gates: ["skills-approved", "executor-ready"],
    completion: "AWAITING_DELIVERY",
  }),

  // Fix one specific deterministic failure. Told what broke, not everything.
  repair: h("repair", {
    role: "repairer",
    purpose: "Fix a specific deterministic failure inside the task's path policy.",
    prompt_template: "repairer@1",
    output_envelope: null,
    effect_policy: "TASK_POLICY",
    writes_allowed: true,
    context: ["task", "acceptance-criteria", "path-policy", "failure-evidence", "current-diff"],
    gates: ["skills-approved", "executor-ready"],
    completion: "AWAITING_DELIVERY",
  }),

  // Compare what was actually done against the criteria. Read-only, and
  // independent of the builder's reasoning.
  review: h("review", {
    role: "reviewer",
    purpose: "Compare the actual change against the acceptance criteria.",
    prompt_template: "reviewer@1",
    output_envelope: "ReviewerEnvelopeV1",
    effect_policy: "NO_EFFECTS",
    writes_allowed: false,
    context: ["task", "acceptance-criteria", "actual-diff", "verification-evidence", "plan", "gate-evidence"],
    gates: ["handoff-valid", "no-repository-effects", "forbidden-git-effects-absent"],
    completion: "AWAITING_DELIVERY",
  }),

  // Document work that already exists, inside a narrow explicit scope.
  document: h("document", {
    role: "documenter",
    purpose: "Document work that already exists, within the approved documentation scope.",
    prompt_template: "documenter@1",
    output_envelope: "DocumentationEnvelopeV1",
    effect_policy: "DOCUMENTATION",
    writes_allowed: true,
    context: ["task", "acceptance-criteria", "actual-diff", "path-policy"],
    gates: ["handoff-valid", "documentation-scope-valid", "forbidden-git-effects-absent"],
    completion: "AWAITING_DELIVERY",
  }),
};

export const SEMANTIC_IDS = Object.keys(SEMANTIC_HANDLERS);
export const isSemantic = (id) => Object.hasOwn(SEMANTIC_HANDLERS, id);

// --------------------------------------------------------- effective policy

// The write policy a phase ACTUALLY runs with. Always a narrowing of the task's
// own policy — a handler can restrict, never widen, and a read-only handler
// ends up with an empty allow-list so that nothing at all is authorized.
export function effectivePolicy(handlerId, task) {
  const handler = SEMANTIC_HANDLERS[handlerId];
  if (!handler) return { ok: false, failure: { code: "UNKNOWN_SEMANTIC_HANDLER", message: `no semantic handler "${handlerId}"` } };

  const taskAllowed = task?.allowedPaths ?? [];
  const taskForbidden = task?.forbiddenPaths ?? [];
  const verify = task?.verify ?? [];
  const controlCategory = task?.controlCategory ?? null;

  if (handler.effect_policy === "NO_EFFECTS")
    return { ok: true, policy: {
      allowed: [], forbidden: [...taskForbidden], verify, controlCategory: null,
      // Recorded so the prompt and the record both say WHY there is no allow-list.
      read_only: true,
      why: `role "${handler.role}" is read-only: this phase has no write authorization at all`,
    } };

  if (handler.effect_policy === "DOCUMENTATION") {
    // Intersection, never union. A documentation path the TASK did not allow is
    // still not allowed.
    const allowed = taskAllowed.length
      ? DOCUMENTATION_PATHS.filter((d) => taskAllowed.some((t) => containedIn(t, d)))
      : [];
    return { ok: true, policy: {
      allowed, forbidden: [...new Set([...taskForbidden, ...DOCUMENTATION_FORBIDDEN])],
      verify, controlCategory: null, read_only: false,
      why: allowed.length
        ? `role "documenter" may write only documentation paths the task also allows`
        : `the task's path policy admits no documentation path, so this documenter may write nothing`,
    } };
  }

  return { ok: true, policy: { allowed: [...taskAllowed], forbidden: [...taskForbidden], verify, controlCategory, read_only: false,
    why: `role "${handler.role}" writes within the task's own path policy` } };
}

// Is documentation pattern `doc` CONTAINED IN task pattern `task`?
//
// Containment, not overlap — and the direction is the whole point. A symmetric
// test let `doc/**` through on a task that only allowed `docs/**`, because each
// prefixed the other. Intersecting a policy must only ever narrow it, so the
// question is "does the task already permit this", never "do these two touch".
function containedIn(taskPattern, docPattern) {
  const base = (g) => String(g).replace(/\\/g, "/").replace(/\*\*\/?/g, "").replace(/\*/g, "").replace(/\/+$/, "");
  if (taskPattern === docPattern) return true;
  const T = base(taskPattern), D = base(docPattern);
  if (T === "") return true;                 // the task allows everything under this root
  if (D === "") return false;                // a bare `*.md` is not inside a specific task root
  return D === T || D.startsWith(T.endsWith("/") ? T : T + "/");
}

// ------------------------------------------------------------- validation

// Everything a template's semantic phase asserts, checked against the closed
// registries. A failure here REJECTS the template — it is never downgraded into
// "the phase is absent", which is exactly the behaviour this milestone removes.
export function validateSemanticPhase(phase) {
  const problems = [];
  const bad = (code, message) => problems.push({ code, message });
  const id = phase?.semantic ?? null;

  if (!id) {
    bad("SEMANTIC_HANDLER_MISSING",
      `phase "${phase?.id}" is an AGENT phase with no \`semantic\` handler. An AGENT phase that names no handler cannot execute, and a template may not declare work it cannot do.`);
    return { ok: false, problems };
  }
  const handler = SEMANTIC_HANDLERS[id];
  if (!handler) {
    bad("UNKNOWN_SEMANTIC_HANDLER", `phase "${phase.id}": semantic handler "${id}" is not registered (${SEMANTIC_IDS.join(", ")})`);
    return { ok: false, problems };
  }

  if (phase.kind !== handler.phase_kind)
    bad("SEMANTIC_KIND_MISMATCH", `phase "${phase.id}": handler "${id}" is a ${handler.phase_kind} handler but the phase declares ${phase.kind}`);
  if (phase.role && phase.role !== handler.role)
    bad("SEMANTIC_ROLE_MISMATCH", `phase "${phase.id}": handler "${id}" requires role "${handler.role}", the phase declares "${phase.role}"`);
  if (!ROLES.ROLES[handler.role])
    bad("UNKNOWN_ROLE", `semantic handler "${id}" requires role "${handler.role}", which is not in the roster`);
  const declared = phase.output_envelope ?? phase.output_schema ?? null;
  if (declared !== handler.output_envelope)
    bad("SEMANTIC_ENVELOPE_MISMATCH", `phase "${phase.id}": handler "${id}" produces ${handler.output_envelope ?? "no envelope"}, the phase declares ${declared ?? "none"}`);
  if (handler.output_envelope && !ENVELOPES[handler.output_envelope])
    bad("UNKNOWN_ENVELOPE", `semantic handler "${id}" declares envelope "${handler.output_envelope}", which is not registered`);
  if (!EFFECT_POLICIES.includes(handler.effect_policy))
    bad("UNKNOWN_EFFECT_POLICY", `semantic handler "${id}" declares effect policy "${handler.effect_policy}"`);
  // A read-only handler that claims writes, or a writing handler with no effect
  // budget, is a contradiction the registry must not contain.
  if (handler.writes_allowed && handler.effect_policy === "NO_EFFECTS")
    bad("SEMANTIC_WRITE_POLICY_INCOMPATIBLE", `semantic handler "${id}" allows writes but declares NO_EFFECTS`);
  if (!handler.writes_allowed && handler.effect_policy !== "NO_EFFECTS")
    bad("SEMANTIC_WRITE_POLICY_INCOMPATIBLE", `semantic handler "${id}" forbids writes but declares effect policy ${handler.effect_policy}`);
  // A read-only role must never be paired with a writing handler.
  if (ROLES.READ_ONLY_ROLES.has(handler.role) && handler.writes_allowed)
    bad("SEMANTIC_WRITE_POLICY_INCOMPATIBLE", `semantic handler "${id}" uses read-only role "${handler.role}" but allows writes`);
  for (const g of handler.gates ?? [])
    if (!GATES[g]) bad("UNKNOWN_GATE", `semantic handler "${id}" names gate "${g}", which is not registered`);

  return { ok: problems.length === 0, problems, handler };
}

export function validateRegistry() {
  const problems = [];
  for (const [id, x] of Object.entries(SEMANTIC_HANDLERS)) {
    if (x.id !== id) problems.push(`semantic handler "${id}": id field says "${x.id}"`);
    const r = validateSemanticPhase({ id: `(registry:${id})`, kind: x.phase_kind, semantic: id, role: x.role, output_envelope: x.output_envelope });
    for (const p of r.problems) problems.push(p.message);
  }
  return { ok: problems.length === 0, problems, count: SEMANTIC_IDS.length };
}

// --------------------------------------------------------------- projection

export const projection = () => ({
  schema_version: SCHEMA_VERSION,
  handlers: SEMANTIC_IDS.map((id) => {
    const x = SEMANTIC_HANDLERS[id];
    return {
      semantic_id: id, phase_kind: x.phase_kind, role: x.role, purpose: x.purpose,
      prompt_template: x.prompt_template, output_envelope: x.output_envelope,
      effect_policy: x.effect_policy, writes_allowed: x.writes_allowed,
      context: x.context, gates: x.gates, completion: x.completion,
    };
  }),
  documentation_paths: DOCUMENTATION_PATHS,
  documentation_forbidden: DOCUMENTATION_FORBIDDEN,
  // Said in the payload because the distinction is load-bearing and easy to
  // misread as a stronger guarantee than it is.
  enforcement: "read-only is enforced by an empty write policy plus post-run effect inspection and a factual gate — NOT by tool sandboxing, which the Claude CLI does not provide",
});
