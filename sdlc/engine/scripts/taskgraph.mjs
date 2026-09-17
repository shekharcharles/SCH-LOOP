#!/usr/bin/env node
// SCH Loop — the project task graph.
//
// WHY THIS EXISTS
// `task.deps` was a bare list of numbers. It could not answer the only question
// that matters before a scheduler runs anything: *why* does 12 wait for 8? An
// edge nobody can defend is an edge that serialises work for no reason, and a
// cycle among three such edges deadlocks a queue silently — there was no cycle
// check at all.
//
// So an edge now carries a REASON, the reasons are typed, and an edge with no
// defensible reason is FLAGGED rather than deleted: a graph the operator has
// not audited is not a graph the engine may quietly rewrite.
//
// It also computes the dependencies nobody wrote down. Two tasks that both own
// `src/auth/**` are ordered whether or not anyone said so, and running them
// together is how one worker's tree eats another's. Those are HIDDEN edges:
// they block readiness, they are reported with their evidence, and they are
// never persisted as graph edges the operator did not author.

import { loadState, getProject } from "./state.mjs";
import { matchPath } from "./runner.mjs";

export const SCHEMA_VERSION = 1;

// ------------------------------------------------------------ dependency types

// Why one task waits for another. Every one of these names a real thing the
// downstream task CONSUMES — which is exactly what the false-edge audit asks
// for, so an edge that cannot be typed is an edge that probably should not exist.
export const DEPENDENCY_TYPES = [
  "DATA_DEPENDENCY",         // consumes an output/contract the upstream produces
  "SCHEMA_DEPENDENCY",       // consumes a schema/migration the upstream defines
  "FILE_CONFLICT",           // both own the same files; order is the only safety
  "APPROVAL_DEPENDENCY",     // an approval on the upstream gates this one
  "ENVIRONMENT_DEPENDENCY",  // shares an environment/lock the upstream holds
  "INTEGRATION_DEPENDENCY",  // must land after the upstream to integrate
  "ORDERING_POLICY",         // a deliberate policy ordering, not a technical need
];

// Types that must name what is consumed. ORDERING_POLICY is the honest escape
// hatch — but an escape hatch with no note is indistinguishable from a guess,
// so it needs one too.
const NEEDS_SUBJECT = new Set(DEPENDENCY_TYPES);

// Control files whose ownership orders two tasks whatever their glob says.
// A second task editing package.json while the first has it open is a conflict
// nobody wrote down and everybody hits.
export const SHARED_CONTROL_FILES = [
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock",
  "pnpm-lock.yaml", "requirements.txt", "pyproject.toml", "poetry.lock",
  "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "composer.json", "Gemfile.lock",
  "tsconfig.json", "Dockerfile", "docker-compose.yml",
];
// Path prefixes that mean "this task owns the schema". Two of those in flight is
// a migration conflict, and a migration conflict is not a merge conflict — it is
// a database.
export const SCHEMA_PREFIXES = ["migrations/", "db/migrate/", "prisma/", "alembic/", "schema/"];

// ------------------------------------------------------------------ helpers

const num = (x) => Number(x);
const uniq = (xs) => [...new Set(xs)];
const clamp = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));

// A task's declared dependency reasons, indexed by upstream id. Reads BOTH the
// new `depMeta` and any inline `dependency_reasons` a planner wrote, so a queue
// authored either way validates the same.
export function reasonsFor(task) {
  const raw = task?.depMeta ?? task?.dependency_reasons ?? [];
  const out = new Map();
  for (const r of Array.isArray(raw) ? raw : []) {
    const from = num(r?.from);
    if (!Number.isInteger(from)) continue;
    out.set(from, {
      from,
      type: String(r?.type ?? "").toUpperCase(),
      consumes: String(r?.consumes ?? ""),
      note: String(r?.note ?? ""),
    });
  }
  return out;
}

// ---------------------------------------------------------------- edge model

// Every edge, with its reason resolved and its audit verdict attached. An edge
// with no recorded reason is not an error — most existing queues have none —
// but it is UNJUSTIFIED, and the audit says so out loud.
export function edges(state) {
  const byId = new Map((state.tasks ?? []).map((t) => [t.id, t]));
  const out = [];
  for (const t of state.tasks ?? []) {
    const reasons = reasonsFor(t);
    const seen = new Set();
    for (const raw of t.deps ?? []) {
      const from = num(raw);
      const r = reasons.get(from) ?? null;
      out.push({
        from, to: t.id,
        type: r?.type || null,
        consumes: r?.consumes || "",
        note: r?.note || "",
        duplicate: seen.has(from),
        upstream_exists: byId.has(from),
        self: from === t.id,
      });
      seen.add(from);
    }
  }
  return out;
}

// ------------------------------------------------------------ cycle detection

// Iterative DFS with an explicit colour map: a 400-task queue must not be able
// to blow the stack while proving it has no cycles.
export function findCycles(state) {
  const adj = new Map();
  for (const t of state.tasks ?? []) adj.set(t.id, uniq((t.deps ?? []).map(num)).filter((d) => adj.has(d) || true));
  const colour = new Map();  // 0 = unvisited, 1 = on stack, 2 = done
  const cycles = [];
  for (const start of adj.keys()) {
    if (colour.get(start)) continue;
    const stack = [[start, 0]];
    const path = [];
    colour.set(start, 1); path.push(start);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const [node, i] = frame;
      const kids = adj.get(node) ?? [];
      if (i >= kids.length) {
        colour.set(node, 2); stack.pop(); path.pop();
        continue;
      }
      frame[1] += 1;
      const kid = kids[i];
      if (!adj.has(kid)) continue;                   // missing task: a different finding
      if (colour.get(kid) === 1) {
        const at = path.indexOf(kid);
        cycles.push([...path.slice(at), kid]);
        continue;
      }
      if (colour.get(kid) === 2) continue;
      colour.set(kid, 1); path.push(kid); stack.push([kid, 0]);
    }
  }
  // de-duplicate rotations of the same cycle
  const seen = new Set(), unique = [];
  for (const c of cycles) {
    const key = [...c.slice(0, -1)].sort((a, b) => a - b).join(",");
    if (seen.has(key)) continue;
    seen.add(key); unique.push(c);
  }
  return unique;
}

// --------------------------------------------------------- hidden dependencies

// Do two path policies overlap? Compared by matching each side's literal-ish
// prefix against the other's globs and vice versa — cheap, and it catches the
// case that matters (`src/auth/**` vs `src/auth/service.ts`, `src/**` vs
// `src/auth/**`) without pretending to be a full glob-intersection solver.
export function pathsOverlap(a = [], b = []) {
  const probe = (glob) => String(glob).replace(/\*\*\/?/g, "").replace(/\*/g, "x").replace(/\/+$/, "");
  for (const x of a) for (const y of b) {
    if (x === y) return { overlap: true, on: x };
    const px = probe(x), py = probe(y);
    if (px && matchPath(y, px)) return { overlap: true, on: px };
    if (py && matchPath(x, py)) return { overlap: true, on: py };
    if (px && py && (px.startsWith(py) || py.startsWith(px))) return { overlap: true, on: px.length < py.length ? px : py };
  }
  return { overlap: false, on: null };
}

const ownsControlFile = (paths = []) =>
  SHARED_CONTROL_FILES.filter((f) => paths.some((p) => matchPath(p, f) || p === f));
const ownsSchema = (paths = []) =>
  SCHEMA_PREFIXES.filter((pre) => paths.some((p) => String(p).startsWith(pre) || matchPath(p, pre + "x")));

// States in which a task still OWNS its paths. A delivered task's files are on
// the remote and belong to nobody; an in-flight or unfinished one's do not.
const OWNING = new Set(["CLAIMED", "RUNNING", "VERIFYING", "AWAITING_DELIVERY", "DELIVERING", "RETRYABLE", "NEEDS_DECISION"]);

// Dependencies nobody wrote down. Never persisted as graph edges — the operator
// authored the graph and the engine does not edit it — but they DO block
// readiness, because two tasks holding the same files is not a scheduling
// preference, it is data loss.
export function hiddenDependencies(state, task, { canonicalState }) {
  const found = [];
  const mine = task.allowedPaths ?? [];
  if (!mine.length) return found;
  for (const other of state.tasks ?? []) {
    if (other.id === task.id) continue;
    const st = canonicalState(other);
    if (!OWNING.has(st)) continue;
    if ((task.deps ?? []).map(num).includes(other.id)) continue;  // already explicit
    const theirs = other.allowedPaths ?? [];
    if (!theirs.length) continue;
    const ov = pathsOverlap(mine, theirs);
    if (ov.overlap) {
      found.push({ from: other.id, type: "FILE_CONFLICT", state: st,
        evidence: `task #${other.id} is ${st} and its path policy overlaps this one on "${ov.on}"` });
      continue;
    }
    const ctl = ownsControlFile(mine).filter((f) => ownsControlFile(theirs).includes(f));
    if (ctl.length) {
      found.push({ from: other.id, type: "ENVIRONMENT_DEPENDENCY", state: st,
        evidence: `task #${other.id} is ${st} and both tasks may write the shared control file(s): ${ctl.join(", ")}` });
      continue;
    }
    const sch = ownsSchema(mine).filter((p) => ownsSchema(theirs).includes(p));
    if (sch.length) {
      found.push({ from: other.id, type: "SCHEMA_DEPENDENCY", state: st,
        evidence: `task #${other.id} is ${st} and both tasks own schema path(s): ${sch.join(", ")}` });
      continue;
    }
    if (task.controlCategory && task.controlCategory === other.controlCategory) {
      found.push({ from: other.id, type: "ORDERING_POLICY", state: st,
        evidence: `task #${other.id} is ${st} and holds the same SCH control category "${task.controlCategory}"` });
    }
  }
  return found;
}

// ------------------------------------------------------------- graph validation

// PROBLEMS block. WARNINGS are audit output a person must read — a suspected
// false edge is a judgement call, and the engine does not make judgement calls
// about a graph a person authored.
export function validateGraph(projectId, { state = null, canonicalState = null } = {}) {
  const s = state ?? loadState(projectId);
  const cs = canonicalState ?? ((t) => t.state || null);
  const byId = new Map((s.tasks ?? []).map((t) => [t.id, t]));
  const problems = [], warnings = [];
  const bad = (code, message, extra = {}) => problems.push({ code, message, ...extra });
  const warn = (code, message, extra = {}) => warnings.push({ code, message, ...extra });

  for (const e of edges(s)) {
    if (e.self) { bad("SELF_DEPENDENCY", `task #${e.to} depends on itself`, { task: e.to }); continue; }
    if (!e.upstream_exists) { bad("MISSING_DEPENDENCY", `task #${e.to} depends on #${e.from}, which does not exist`, { task: e.to, dep: e.from }); continue; }
    if (e.duplicate) { bad("DUPLICATE_DEPENDENCY", `task #${e.to} lists #${e.from} more than once`, { task: e.to, dep: e.from }); continue; }

    const up = byId.get(e.from);
    const upState = cs(up);
    if (upState === "CANCELLED" && !(byId.get(e.to)?.dependencyPolicy?.allow_cancelled === true))
      bad("CANCELLED_DEPENDENCY", `task #${e.to} depends on #${e.from}, which is CANCELLED — set dependencyPolicy.allow_cancelled on #${e.to} if that is deliberate`, { task: e.to, dep: e.from });

    if (e.type && !DEPENDENCY_TYPES.includes(e.type))
      bad("INVALID_DEPENDENCY_REASON", `task #${e.to} → #${e.from}: "${e.type}" is not a dependency type (${DEPENDENCY_TYPES.join(", ")})`, { task: e.to, dep: e.from });

    // --- the false-edge audit ------------------------------------------------
    // "Does the downstream task consume an actual output, resource, schema,
    // approval or protected ordering requirement from the upstream task?"
    if (!e.type) {
      warn("FALSE_EDGE_SUSPECTED", `task #${e.to} → #${e.from}: no dependency reason recorded — nothing says what #${e.to} consumes from #${e.from}. Record one with task-set --dep-reason, or drop the edge.`, { task: e.to, dep: e.from });
    } else if (NEEDS_SUBJECT.has(e.type) && !e.consumes && !e.note) {
      warn("FALSE_EDGE_SUSPECTED", `task #${e.to} → #${e.from}: typed ${e.type} but names nothing consumed — an edge nobody can defend serialises work for free.`, { task: e.to, dep: e.from, type: e.type });
    } else if (e.type === "FILE_CONFLICT") {
      const ov = pathsOverlap(byId.get(e.to)?.allowedPaths ?? [], up?.allowedPaths ?? []);
      if (!ov.overlap)
        warn("FALSE_EDGE_SUSPECTED", `task #${e.to} → #${e.from}: declared FILE_CONFLICT, but their path policies do not overlap.`, { task: e.to, dep: e.from, type: e.type });
    }
  }

  for (const c of findCycles(s))
    bad("DEPENDENCY_CYCLE", `dependency cycle: ${c.map((n) => "#" + n).join(" → ")}`, { cycle: c });

  return {
    schema_version: SCHEMA_VERSION, project_id: projectId,
    ok: problems.length === 0,
    tasks: (s.tasks ?? []).length,
    edges: edges(s).length,
    problems, warnings,
    checked_at: new Date().toISOString(),
  };
}

// ------------------------------------------------------------------ readiness

// A dependency is satisfied when its work is ON THE REMOTE. The legacy `merged`
// status is accepted too and only because it is history: it meant "the
// in-session loop finished this locally", it was never pushed, and rejecting it
// would strand every task planned before the delivery controller existed.
export function dependencySatisfied(task, canonical) {
  if (canonical === "DELIVERED") return true;
  if (task?.status === "merged") return true;                 // historical local completion
  if (canonical === "SUPERSEDED") return true;
  return false;
}

const NOT_READY = {
  BACKLOG: "the task is in BACKLOG — it has not been released for execution",
  CLAIMED: "the task is already claimed", RUNNING: "the task is already running",
  VERIFYING: "the task is verifying", AWAITING_DELIVERY: "the task is waiting to be delivered",
  DELIVERING: "the task is being delivered", DELIVERED: "the task is delivered",
  NEEDS_DECISION: "the task is waiting on a human decision",
  BLOCKED: "the task is blocked", FAILED: "the task has failed",
  CANCELLED: "the task is cancelled", SUPERSEDED: "the task was superseded",
};

// Why this task can or cannot run, right now, with the evidence attached. Used
// by the scheduler to pick, and by the dashboard to explain a stopped queue.
export function readiness(state, task, { canonicalState }) {
  const st = canonicalState(task);
  const blockers = [];
  if (st !== "READY" && st !== "RETRYABLE")
    blockers.push({ code: "NOT_READY", detail: NOT_READY[st] ?? `the task is ${st}` });

  const byId = new Map((state.tasks ?? []).map((t) => [t.id, t]));
  for (const raw of uniq((task.deps ?? []).map(num))) {
    const dep = byId.get(raw);
    if (!dep) { blockers.push({ code: "MISSING_DEPENDENCY", detail: `depends on #${raw}, which does not exist`, dep: raw }); continue; }
    const depState = canonicalState(dep);
    if (dependencySatisfied(dep, depState)) continue;
    if (["CANCELLED"].includes(depState) && task.dependencyPolicy?.allow_cancelled === true) continue;
    blockers.push({
      code: depState === "BLOCKED" || depState === "FAILED" || depState === "NEEDS_DECISION" ? "BLOCKED_DEPENDENCY" : "DEPENDENCY_INCOMPLETE",
      detail: `depends on #${raw} "${clamp(dep.title, 60)}", which is ${depState}`, dep: raw, dep_state: depState,
    });
  }

  for (const h of hiddenDependencies(state, task, { canonicalState }))
    blockers.push({ code: "HIDDEN_" + h.type, detail: h.evidence, dep: h.from, hidden: true });

  return { task_id: task.id, state: st, ready: blockers.length === 0, blockers };
}

// Exactly one ready task, chosen deterministically: priority (1 = highest),
// then phase order, then id. The same order the in-session loop always used, so
// a queue does not reorder itself the day a scheduler starts running it.
export function selectReady(state, { canonicalState, phase = null }) {
  const rows = (state.tasks ?? [])
    .filter((t) => phase === null || Number(t.phase) === Number(phase))
    .map((t) => ({ task: t, r: readiness(state, t, { canonicalState }) }));
  const ready = rows.filter((x) => x.r.ready).map((x) => x.task)
    .sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || (a.phase ?? 1) - (b.phase ?? 1) || a.id - b.id);
  return { selected: ready[0] ?? null, ready, rows };
}

// --------------------------------------------------------------- projection

// The graph as the dashboard and `graph-show` want it: nodes with their state
// and readiness, edges with their reason, hidden edges kept separate from the
// authored ones, and the audit verdict alongside.
export function projectGraph(projectId, { canonicalState, state = null } = {}) {
  const s = state ?? loadState(projectId);
  const validation = validateGraph(projectId, { state: s, canonicalState });
  const nodes = (s.tasks ?? []).map((t) => {
    const r = readiness(s, t, { canonicalState });
    return {
      id: t.id, title: clamp(t.title, 140), phase: t.phase ?? 1, priority: t.priority ?? 3,
      category: t.category ?? "", state: canonicalState(t), legacy_status: t.status,
      state_version: t.stateVersion ?? 0,
      ready: r.ready, blockers: r.blockers,
      depends_on: uniq((t.deps ?? []).map(num)),
      blocks: (s.tasks ?? []).filter((x) => (x.deps ?? []).map(num).includes(t.id)).map((x) => x.id),
      allowed_paths: t.allowedPaths ?? [], forbidden_paths: t.forbiddenPaths ?? [],
      attempts: (t.attempts ?? []).length,
      delivery: t.delivery ? { commit: t.delivery.commit, branch: t.delivery.branch, remote: t.delivery.remote } : null,
    };
  });
  return {
    schema_version: SCHEMA_VERSION, project_id: projectId, project: getProject(projectId)?.name ?? projectId,
    nodes, edges: edges(s),
    hidden_edges: (s.tasks ?? []).flatMap((t) => hiddenDependencies(s, t, { canonicalState }).map((h) => ({ ...h, to: t.id }))),
    validation: { ok: validation.ok, problems: validation.problems, warnings: validation.warnings },
    generated_at: new Date().toISOString(),
  };
}

// A READ-ONLY human projection of the queue. Written only when explicitly asked
// for: the operational authority is SCH state, and a Markdown file that drifts
// from it is worse than no file at all — which is why it says so at the top.
export function renderTaskQueueMarkdown(projection) {
  const line = (n) => `| ${n.id} | ${n.phase} | ${n.state} | ${n.ready ? "ready" : (n.blockers[0]?.code ?? "—")} | ${n.depends_on.map((d) => "#" + d).join(" ") || "—"} | ${n.title.replace(/\|/g, "\\|")} |`;
  return [
    "# TASK QUEUE (read-only projection)",
    "",
    `Generated ${projection.generated_at} from SCH operational state for \`${projection.project_id}\`.`,
    "This file is a VIEW. Editing it changes nothing — the queue lives in SCH state,",
    "and `node scripts/state.mjs graph-show --project <id>` is the authority.",
    "",
    "| # | phase | state | readiness | depends on | title |",
    "|---|-------|-------|-----------|------------|-------|",
    ...projection.nodes.map(line),
    "",
    projection.validation.ok ? "Graph validation: OK" : "Graph validation: **FAILED**",
    ...projection.validation.problems.map((p) => `- ✗ ${p.code}: ${p.message}`),
    ...projection.validation.warnings.map((w) => `- ⚠ ${w.code}: ${w.message}`),
    "",
  ].join("\n");
}
