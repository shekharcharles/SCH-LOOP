#!/usr/bin/env node
// SCH Loop — the lazy-loaded procedure registry.
//
// WHY THIS EXISTS
// `/SCH` was becoming an encyclopedia. Every new capability added paragraphs to
// a router that is read on every invocation, so the cost of knowing how to do
// something was paid by every run that did not need to.
//
// A procedure is a named, versioned, hashable piece of operational text that is
// loaded ONLY when the phase that needs it runs. The router stays a router.
//
// WHAT A PROCEDURE IS NOT: authority. Procedure text cannot grant a tool, widen
// a write scope or override the safety kernel — it is compiled into a prompt
// alongside the kernel, never instead of it, and `roles.mjs` decides permissions
// regardless of what any procedure says. That is checked here rather than
// trusted: a procedure whose text tries to grant authority fails validation.

import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;

// Text that would be an authority grant if a prompt honoured it. A procedure
// containing one of these is refused at validation, because the safest time to
// catch it is before it is ever compiled into a prompt.
const AUTHORITY_CLAIMS = [
  [/\byou (may|can|are allowed to) (push|commit|stage|deploy|merge|approve)\b/i, "claims git or approval authority"],
  [/\bgit\s+(push|commit|add\s+-A|add\s+\.)\b/i, "instructs a forbidden git operation"],
  [/\bignore (the )?(previous|above|safety|kernel)\b/i, "attempts to override higher-level policy"],
  [/\byou now have (access|permission)\b/i, "claims to widen permissions"],
  [/--force(-with-lease)?\b/i, "references a force push"],
];

const P = (id, version, capabilities, text) => ({ id, version, capabilities, text: text.trim() });

// The registry. Text is deliberately SHORT: a procedure competes for the same
// prompt budget as the task itself, and duplicated guidance across role,
// template, procedure and skill layers is the fastest way to waste it.
export const PROCEDURES = {
  "workspace-initialize": P("workspace-initialize", 1, ["workspace"], `
Initialize the per-project .sch-loop/ workspace before any run. It is explicit and
idempotent: a run REQUIRES an initialized workspace and never creates one for you.
Commit .sch-loop/project.yaml and the ignore rules; a run needs a clean tree.`),

  "task-graph-validate": P("task-graph-validate", 1, ["graph"], `
Validate the task graph before selecting work: self-dependencies, duplicates,
missing tasks, cycles and cancelled dependencies are refused. An edge nobody can
defend is FLAGGED, never deleted — the graph is a plan a person wrote.`),

  "workflow-select": P("workflow-select", 1, ["workflow"], `
Workflow selection precedence: task override, then task-type project policy, then
project default, then the safe system default (PLAN_BUILD_TEST, which verifies but
does not deliver). Record the exact template id and version on the task.`),

  "context-compile": P("context-compile", 1, ["context"], `
Compile only what this phase's role policy admits. Passing verification logs are
never included. Previous-attempt evidence is bounded and its omissions recorded.
Every included section is hashed into the context manifest.`),

  "worker-run": P("worker-run", 1, ["execution"], `
One phase, one fresh external process. The prompt goes over stdin so it never
appears in a process list. The environment is an allowlist and SCH_HOME is not in
it. SCH owns the timeout, the cancellation and the process-tree kill.`),

  "effect-inspect": P("effect-inspect", 1, ["git"], `
Compare the repository before and after. The worker's account of what it changed
is compared against what actually changed and never substituted for it. Any git
effect the worker should not have produced stops the phase with evidence intact.`),

  "verification-run": P("verification-run", 1, ["verification"], `
Run the task's own commands as an executable plus an argument vector — never a
shell string. The effective timeout is the MINIMUM of command, phase, task,
scheduler and operator bounds. A large default never overrides a smaller ceiling.`),

  "repair-compile": P("repair-compile", 1, ["repair"], `
A repairer is told what broke and nothing else: the failing checks, bounded
stdout/stderr excerpts, the gate report and the current diff summary. Not the
transcript, not previous run logs, not passing output. Record what was omitted.`),

  "semantic-review": P("semantic-review", 1, ["review"], `
The reviewer is a separate role in a separate process, read-only, and receives the
actual diff and deterministic evidence — never the builder's reasoning. A reviewer
that reads the builder's rationale is agreeing with it, not reviewing it.`),

  "delivery-run": P("delivery-run", 1, ["delivery"], `
Delivery is controller-only. Recompute the verified content hashes, refuse on any
drift, stage exact pathspecs after --, scan staged content, make one commit, refuse
any incoming or unrelated outgoing commit, push without force, then FETCH AGAIN and
ask the remote before the task is delivered.`),

  "external-skill-review": P("external-skill-review", 1, ["skills", "governance"], `
An external skill is somebody else's instructions running in your agent. Sources
are pinned to a full commit; synchronisation is an operator action; discovery grants
no trust; a quality PASS is not an approval. Approval binds to (source commit,
content hash) and is scoped to named roles. Default eligibility is nothing.`),
};

export const PROCEDURE_IDS = Object.keys(PROCEDURES);

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
export const procedureHash = (id) => (PROCEDURES[id] ? sha(`${id}@${PROCEDURES[id].version}\n${PROCEDURES[id].text}`) : null);

// LAZY. The point of the registry: a caller names what it needs and pays for
// exactly that. Nothing loads the whole set into a prompt.
export function load(ids = []) {
  const loaded = [], missing = [];
  for (const id of ids) {
    const p = PROCEDURES[id];
    if (!p) { missing.push(id); continue; }
    loaded.push({ id: p.id, version: p.version, hash: procedureHash(id), characters: p.text.length, text: p.text, capabilities: p.capabilities });
  }
  return {
    procedures: loaded, missing,
    // Fail closed: a phase that asked for a procedure that does not exist is
    // misconfigured, and running it with silently less guidance hides that.
    ok: missing.length === 0,
    failure: missing.length ? { code: "UNKNOWN_PROCEDURE", message: `no procedure(s): ${missing.join(", ")} (${PROCEDURE_IDS.join(", ")})` } : null,
    total_characters: loaded.reduce((n, p) => n + p.characters, 0),
    manifest: loaded.map((p) => ({ id: p.id, version: p.version, hash: p.hash, characters: p.characters })),
  };
}

// Which procedures a phase should be given. Deliberately narrow — a phase gets
// the procedure for the thing it is doing, not the manual.
const BY_HANDLER = {
  "task-prepare": ["workspace-initialize", "task-graph-validate"],
  "context-compile": ["context-compile"],
  "agent-run": ["worker-run"],
  "effect-inspect": ["effect-inspect"],
  "deterministic-verification": ["verification-run"],
  "semantic-review": ["semantic-review"],
  "delivery-prepare": ["delivery-run"],
  "verified-delivery": ["delivery-run"],
};
export const proceduresFor = (handlerId, { role = null } = {}) => {
  const base = BY_HANDLER[handlerId] ?? [];
  if (role === "repairer") return [...new Set([...base, "repair-compile"])];
  return base;
};

export function validateRegistry() {
  const problems = [];
  for (const [id, p] of Object.entries(PROCEDURES)) {
    if (p.id !== id) problems.push(`procedure "${id}": id field says "${p.id}"`);
    if (!Number.isInteger(p.version) || p.version < 1) problems.push(`procedure "${id}": needs an integer version`);
    if (!p.text?.trim()) problems.push(`procedure "${id}": has no text`);
    if (p.text.length > 2000) problems.push(`procedure "${id}": ${p.text.length} characters is too long — a procedure competes with the task for prompt budget`);
    for (const [re, why] of AUTHORITY_CLAIMS)
      if (re.test(p.text)) problems.push(`procedure "${id}": ${why}. A procedure is guidance; it never grants authority.`);
  }
  return { ok: problems.length === 0, problems, count: PROCEDURE_IDS.length };
}

export const projection = () => ({
  schema_version: SCHEMA_VERSION,
  procedures: PROCEDURE_IDS.map((id) => ({
    id, version: PROCEDURES[id].version, hash: procedureHash(id),
    capabilities: PROCEDURES[id].capabilities, characters: PROCEDURES[id].text.length,
  })),
});
