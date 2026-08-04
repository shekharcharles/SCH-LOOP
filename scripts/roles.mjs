#!/usr/bin/env node
// SCH Loop — the versioned agent-role roster and logical model profiles.
//
// WHY THESE ARE SEPARATE THINGS
// "The reviewer" used to mean a role, an executor, a model and a set of
// permissions all at once, which is how a reviewer ends up with the builder's
// write access: there was no place to say they differ. Seven things are
// separate here, and each one is configuration:
//
//     Role            what the agent is FOR
//     Executor        how the process is started
//     Provider        who answers
//     Model profile   which class of model, logically
//     Prompt template what it is told
//     Tools           what it may DO
//     Write scope     where it may WRITE
//
// Tools and write scope are separate on purpose. Read is not edit; edit is not
// "may write anywhere the task allows".
//
// THE RULE A SKILL CANNOT BREAK: a selected skill may inform the agent. It can
// never add a tool and never widen a write scope. Skills are content, not
// authority, and `resolve()` enforces that by intersection rather than by asking
// nicely in a prompt.

import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;

export const ACTOR_KINDS = ["ENGINEER", "AGENT", "CODE", "SYSTEM", "GATE"];
export const TOOLS = ["read", "search", "edit", "shell", "browser"];

// ------------------------------------------------------- logical model profiles
//
// A profile is a CLASS of model, not a model name. "workhorse" survives a model
// rename; "claude-x-20260101" does not. The exact model that answered is
// recorded per phase; the profile is what policy is written against.
//
// `model: "inherited"` is the honest value for the Claude CLI: the CLI decides,
// and SCH records what it actually got rather than pretending it chose.
export const MODEL_PROFILES = {
  economical: {
    id: "economical", version: 1, executor: "claude-cli", provider: "anthropic",
    model: "inherited", reasoning: "low",
    max_prompt_characters: 30000, max_output_bytes: 512 * 1024,
    cost_policy: { max_estimated_cost_usd: 2 },
    fallback_profiles: [],
  },
  workhorse: {
    id: "workhorse", version: 1, executor: "claude-cli", provider: "anthropic",
    model: "inherited", reasoning: "medium",
    max_prompt_characters: 60000, max_output_bytes: 1024 * 1024,
    cost_policy: { max_estimated_cost_usd: 10 },
    fallback_profiles: ["economical"],
  },
  "high-reasoning": {
    id: "high-reasoning", version: 1, executor: "claude-cli", provider: "anthropic",
    model: "inherited", reasoning: "high",
    max_prompt_characters: 60000, max_output_bytes: 1024 * 1024,
    cost_policy: { max_estimated_cost_usd: 20 },
    fallback_profiles: ["workhorse"],
  },
  "frontier-review": {
    id: "frontier-review", version: 1, executor: "claude-cli", provider: "anthropic",
    model: "inherited", reasoning: "high",
    max_prompt_characters: 80000, max_output_bytes: 1024 * 1024,
    cost_policy: { max_estimated_cost_usd: 40 },
    fallback_profiles: [],   // a review that silently ran on a cheaper model is not the review that was asked for
  },
  // Declared so policy can be written against it. NOT wired to an executor in
  // this milestone — resolving it fails preflight rather than silently falling
  // back to a cloud provider, which is the whole point of asking for it.
  "local-private": {
    id: "local-private", version: 1, executor: "local-runtime", provider: "local",
    model: "unspecified", reasoning: "medium",
    max_prompt_characters: 30000, max_output_bytes: 512 * 1024,
    cost_policy: { max_estimated_cost_usd: 0 },
    fallback_profiles: [],
    available: false,
    unavailable_reason: "no local executor is implemented in this milestone; asking for local-private fails preflight rather than quietly using a cloud provider",
  },
};

export const MODEL_PROFILE_IDS = Object.keys(MODEL_PROFILES);

// The executors that actually exist. An executor named by a profile but absent
// here fails preflight — a role cannot conjure a runtime.
export const AVAILABLE_EXECUTORS = new Set(["claude-cli"]);

// -------------------------------------------------------------- the roster

// One role means one prompt and one purpose. `writes_from_task_policy` is the
// builder/repairer case: their write scope is the TASK's, never the role's, so a
// role can never widen what a task permitted.
export const ROLES = {
  scout: {
    id: "scout", version: 1,
    purpose: "Find and report where something lives, and nothing else.",
    model_profile: "economical",
    prompt_template: "scout@1",
    tools: ["read", "search"],
    writes: [], writes_from_task_policy: false,
    output_envelope: "ScoutEnvelopeV1",
    capabilities: ["search", "codebase-analysis"],
    context_policy: { include: ["task", "acceptance-criteria", "path-policy"], exclude: ["previous-attempt", "gate-reports"] },
    budgets: { max_prompt_characters: 30000, max_duration_ms: 10 * 60 * 1000 },
  },
  planner: {
    id: "planner", version: 1,
    purpose: "Decide how the approved task should be done. It does not do it.",
    model_profile: "high-reasoning",
    prompt_template: "planner@1",
    tools: ["read", "search"],
    writes: [], writes_from_task_policy: false,
    output_envelope: "PlannerEnvelopeV1",
    capabilities: ["planning", "brainstorming"],
    context_policy: { include: ["task", "acceptance-criteria", "path-policy", "dependencies", "scout"], exclude: ["gate-reports"] },
    budgets: { max_prompt_characters: 40000, max_duration_ms: 15 * 60 * 1000 },
  },
  builder: {
    id: "builder", version: 1,
    purpose: "Implement one approved task inside its path policy.",
    model_profile: "workhorse",
    prompt_template: "builder@1",
    tools: ["read", "search", "edit", "shell"],
    writes: [], writes_from_task_policy: true,
    output_envelope: "BuilderEnvelopeV1",
    skills_from_task_profile: true,
    context_policy: { include: ["task", "acceptance-criteria", "path-policy", "dependencies", "plan", "skills"], exclude: ["passing-verification-logs"] },
    budgets: { max_prompt_characters: 60000, max_duration_ms: 30 * 60 * 1000 },
  },
  repairer: {
    id: "repairer", version: 1,
    purpose: "Fix a specific deterministic failure. It is told what broke, not everything that happened.",
    model_profile: "workhorse",
    prompt_template: "repairer@1",
    tools: ["read", "search", "edit", "shell"],
    writes: [], writes_from_task_policy: true,
    output_envelope: "RepairEnvelopeV1",
    skills_from_task_profile: true,
    // The defining constraint of this role: compact failure evidence and the
    // current diff. Not the transcript, not the passing logs, not the history.
    context_policy: { include: ["task", "acceptance-criteria", "path-policy", "failure-evidence", "current-diff"],
      exclude: ["passing-verification-logs", "full-transcripts", "previous-run-logs", "learning-corpus"] },
    budgets: { max_prompt_characters: 40000, max_duration_ms: 30 * 60 * 1000 },
  },
  reviewer: {
    id: "reviewer", version: 1,
    purpose: "Compare what was actually done against the acceptance criteria. Read-only, and independent of the builder's reasoning.",
    model_profile: "high-reasoning",
    prompt_template: "reviewer@1",
    tools: ["read", "search"],
    writes: [], writes_from_task_policy: false,
    output_envelope: "ReviewerEnvelopeV1",
    capabilities: ["review", "security-review"],
    // Deliberately NOT given the builder's chain of thought: a reviewer that
    // reads the builder's reasoning is agreeing with it, not reviewing it.
    context_policy: { include: ["task", "acceptance-criteria", "actual-diff", "verification-evidence"],
      exclude: ["builder-reasoning", "builder-notes"] },
    budgets: { max_prompt_characters: 40000, max_duration_ms: 15 * 60 * 1000 },
  },
  documenter: {
    id: "documenter", version: 1,
    purpose: "Write documentation for work that is already done and verified.",
    model_profile: "economical",
    prompt_template: "documenter@1",
    tools: ["read", "search", "edit"],
    // The one role with a role-level write scope, and it is intersected with the
    // task policy like every other write.
    writes: ["docs/**", "README.md", "*.md"], writes_from_task_policy: false,
    output_envelope: "DocumentationEnvelopeV1",
    capabilities: ["documentation"],
    context_policy: { include: ["task", "acceptance-criteria", "actual-diff"], exclude: ["failure-evidence"] },
    budgets: { max_prompt_characters: 30000, max_duration_ms: 10 * 60 * 1000 },
  },
};

export const ROLE_IDS = Object.keys(ROLES);

// Roles that may never be given write authority, whatever a task, template or
// skill says. Checked at resolution, not documented and hoped for.
export const READ_ONLY_ROLES = new Set(["scout", "planner", "reviewer"]);

const sha = (v) => createHash("sha256").update(typeof v === "string" ? v : stable(v)).digest("hex");
function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

export const roleHash = (id) => (ROLES[id] ? sha(ROLES[id]) : null);

// ---------------------------------------------------------------- resolution

const fail = (code, message, extra = {}) => ({ ok: false, failure: { code, message }, ...extra });

// Turn a role id into the exact, persistable configuration a phase will run
// with — or fail closed. Nothing here is implicit: an unavailable executor, an
// unavailable model profile and an unapproved fallback are all preflight
// failures, never a quiet substitution.
export function resolve(roleId, {
  task = null, project = null, skills = [], allowFallback = null, availableExecutors = AVAILABLE_EXECUTORS,
} = {}) {
  const role = ROLES[roleId];
  if (!role) return fail("UNKNOWN_ROLE", `no agent role "${roleId}" (${ROLE_IDS.join(", ")})`);

  // --- model profile, with EXPLICIT fallback only
  const requested = project?.modelPolicy?.roles?.[roleId] ?? role.model_profile;
  const chain = [];
  let profile = null, usedFallback = false;
  const fallbackAllowed = allowFallback ?? project?.modelPolicy?.allow_fallback === true;

  for (const candidate of [requested, ...(MODEL_PROFILES[requested]?.fallback_profiles ?? [])]) {
    const p = MODEL_PROFILES[candidate];
    chain.push(candidate);
    if (!p) return fail("UNKNOWN_MODEL_PROFILE", `no model profile "${candidate}" (${MODEL_PROFILE_IDS.join(", ")})`);
    const executorOk = availableExecutors.has(p.executor);
    const profileOk = p.available !== false;
    if (executorOk && profileOk) { profile = p; usedFallback = candidate !== requested; break; }
    // The first candidate failing is the real answer unless fallback is approved.
    if (!fallbackAllowed) {
      return fail(profileOk ? "EXECUTOR_UNAVAILABLE" : "MODEL_PROFILE_UNAVAILABLE",
        profileOk
          ? `role "${roleId}" needs executor "${p.executor}", which is not available. Fallback to ${p.fallback_profiles.join(", ") || "nothing"} is NOT implicit — approve it with modelPolicy.allow_fallback.`
          : `model profile "${candidate}" is unavailable: ${p.unavailable_reason}. Falling back to another provider is never implicit.`,
        { requested, chain });
    }
  }
  if (!profile)
    return fail("MODEL_PROFILE_UNAVAILABLE", `no usable model profile for role "${roleId}" — tried ${chain.join(" → ")}`, { requested, chain });

  // A cross-PROVIDER fallback is a different question from a cheaper model, and
  // it is never answered implicitly.
  const requestedProvider = MODEL_PROFILES[requested]?.provider;
  if (usedFallback && requestedProvider && profile.provider !== requestedProvider && project?.modelPolicy?.allow_provider_fallback !== true)
    return fail("PROVIDER_FALLBACK_FORBIDDEN",
      `falling back from provider "${requestedProvider}" to "${profile.provider}" requires modelPolicy.allow_provider_fallback`, { requested, chain });

  // --- tools: the ROLE is the ceiling. A skill may not add one.
  const tools = role.tools.filter((t) => TOOLS.includes(t));
  const skillTools = [...new Set(skills.flatMap((s) => s.tools ?? s.requested_tools ?? []))];
  const refusedTools = skillTools.filter((t) => !tools.includes(t));

  // --- write scope: the intersection of role and task. Never the union.
  const taskPaths = task?.allowedPaths ?? [];
  let writes;
  if (READ_ONLY_ROLES.has(roleId)) writes = [];
  else if (role.writes_from_task_policy) writes = [...taskPaths];
  else if (taskPaths.length) writes = role.writes.filter((w) => taskPaths.some((p) => p === w || pathish(p, w)));
  else writes = [...role.writes];
  const skillWrites = [...new Set(skills.flatMap((s) => s.writes ?? s.requested_writes ?? []))];
  const refusedWrites = skillWrites.filter((w) => !writes.includes(w));

  const config = {
    schema_version: SCHEMA_VERSION,
    actor_kind: "AGENT",
    role_id: role.id, role_version: role.version, role_hash: roleHash(role.id),
    purpose: role.purpose,
    executor_id: profile.executor, provider: profile.provider,
    model_profile: profile.id, model_profile_version: profile.version,
    // What the CLI actually used is filled in AFTER the process runs. "inherited"
    // is honest here: SCH did not choose it and does not yet know it.
    model: profile.model, resolved_model: null, reasoning: profile.reasoning,
    prompt_template: role.prompt_template,
    context_policy: role.context_policy,
    tools, writes,
    write_scope_summary: writes.length ? `${writes.length} path pattern(s): ${writes.slice(0, 5).join(", ")}${writes.length > 5 ? " …" : ""}` : "no write authority",
    output_envelope: role.output_envelope,
    selected_skills: skills.map((s) => ({ skill_id: s.skill_id ?? s.id, content_hash: s.content_hash ?? null, trust: s.trust ?? null })),
    budgets: {
      max_prompt_characters: Math.min(role.budgets.max_prompt_characters, profile.max_prompt_characters),
      max_output_bytes: profile.max_output_bytes,
      max_duration_ms: role.budgets.max_duration_ms,
      max_estimated_cost_usd: profile.cost_policy.max_estimated_cost_usd,
    },
    fallback_used: usedFallback, requested_profile: requested, resolution_chain: chain,
    // Said out loud in the record, because an authority question answered
    // silently is one nobody can audit later.
    refused: {
      tools: refusedTools, writes: refusedWrites,
      why: refusedTools.length || refusedWrites.length
        ? "a selected skill requested authority the role does not have; skills are content, never authority"
        : null,
    },
    resolved_at: new Date().toISOString(),
  };
  return { ok: true, config };
}

// "does allow-pattern `p` cover role-pattern `w`" — deliberately crude, and
// crude in the SAFE direction: an uncertain overlap is not granted.
function pathish(p, w) {
  const base = String(p).replace(/\*\*\/?/g, "").replace(/\*/g, "").replace(/\/+$/, "");
  return base.length > 0 && String(w).startsWith(base);
}

// ------------------------------------------------------------- validation

// Every role and profile is internally consistent. Run by `npm run validate`, so
// a roster edit that grants a reviewer write access fails the build.
export function validateRoster() {
  const problems = [];
  for (const [id, r] of Object.entries(ROLES)) {
    if (r.id !== id) problems.push(`role "${id}": id field says "${r.id}"`);
    if (!Number.isInteger(r.version) || r.version < 1) problems.push(`role "${id}": needs an integer version`);
    if (!MODEL_PROFILES[r.model_profile]) problems.push(`role "${id}": unknown model profile "${r.model_profile}"`);
    if (!r.output_envelope) problems.push(`role "${id}": needs an output envelope type`);
    for (const t of r.tools) if (!TOOLS.includes(t)) problems.push(`role "${id}": unknown tool "${t}"`);
    if (READ_ONLY_ROLES.has(id)) {
      if (r.writes.length) problems.push(`role "${id}" is read-only but declares writes`);
      if (r.writes_from_task_policy) problems.push(`role "${id}" is read-only but takes writes from the task policy`);
      for (const t of r.tools) if (["edit", "shell"].includes(t)) problems.push(`role "${id}" is read-only but declares the "${t}" tool`);
    }
  }
  for (const [id, p] of Object.entries(MODEL_PROFILES)) {
    if (p.id !== id) problems.push(`model profile "${id}": id field says "${p.id}"`);
    for (const f of p.fallback_profiles ?? [])
      if (!MODEL_PROFILES[f]) problems.push(`model profile "${id}": unknown fallback "${f}"`);
    if (!(Number(p.max_prompt_characters) > 0)) problems.push(`model profile "${id}": needs a prompt ceiling`);
  }
  return { ok: problems.length === 0, problems, roles: ROLE_IDS.length, profiles: MODEL_PROFILE_IDS.length };
}

// --------------------------------------------------------------- projection

export const rosterProjection = () => ({
  schema_version: SCHEMA_VERSION,
  roles: ROLE_IDS.map((id) => {
    const r = ROLES[id];
    return {
      role_id: id, version: r.version, hash: roleHash(id), purpose: r.purpose,
      model_profile: r.model_profile, tools: r.tools,
      write_scope: r.writes_from_task_policy ? "from the task's path policy" : (r.writes.length ? r.writes.join(", ") : "none"),
      read_only: READ_ONLY_ROLES.has(id), output_envelope: r.output_envelope,
    };
  }),
  model_profiles: MODEL_PROFILE_IDS.map((id) => {
    const p = MODEL_PROFILES[id];
    return { id, version: p.version, executor: p.executor, provider: p.provider, reasoning: p.reasoning,
      available: p.available !== false, unavailable_reason: p.unavailable_reason ?? null,
      fallback_profiles: p.fallback_profiles, max_prompt_characters: p.max_prompt_characters };
  }),
  available_executors: [...AVAILABLE_EXECUTORS],
});
