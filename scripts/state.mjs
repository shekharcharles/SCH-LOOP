#!/usr/bin/env node
// SCH Loop — single source of truth, multi-project.
//
// A registry (projects.json) lists every project; each project has its own
// isolated state file at projects/<id>/state.json (good for client
// separation). One dashboard reads them all; one loop targets one project via
// --project <id> (or SCH_PROJECT). Every loop pass re-reads from disk — nothing
// here keeps memory between runs.
//
// Usage:  node scripts/state.mjs <command> --project <id> [--flag value]
//         node scripts/state.mjs help

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync, copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import * as SK from "./skills.mjs";
import * as WT from "./worktree.mjs";

// Skills actually invoked in Claude Code's session transcripts since `sinceMs`.
// Ground truth the agent cannot fake — used to hard-gate completion.
export function invokedSkills(sinceMs) {
  const root = join(homedir(), ".claude", "projects");
  const set = new Set();
  if (!existsSync(root)) return set;
  for (const dir of readdirSync(root)) {
    let files = [];
    try { files = readdirSync(join(root, dir)).filter((x) => x.endsWith(".jsonl")); } catch { continue; }
    for (const file of files) {
      const fp = join(root, dir, file);
      try { if (statSync(fp).mtimeMs < sinceMs) continue; } catch { continue; }
      let t = ""; try { t = readFileSync(fp, "utf8"); } catch { continue; }
      for (const line of t.split("\n")) {
        if (!line.includes('"name":"Skill"')) continue;
        const s = line.match(/"skill":"([^"]+)"/)?.[1];
        if (s) { set.add(s); set.add(s.split(":").pop()); }
      }
    }
  }
  return set;
}

// SCH_HOME overrides where state lives (documented as the engine home; also lets
// tests run against a throwaway directory instead of the real registry).
// Resolved per call, not once at import: a module is cached, so a process that
// sets SCH_HOME after first importing this file kept reading the old home for
// the rest of its life — silently answering about the wrong machine's state.
const root = () => process.env.SCH_HOME || join(dirname(fileURLToPath(import.meta.url)), "..");
export const registryPath = () => join(root(), "projects.json");
const PROJECTS_DIR = () => join(root(), "projects");
const LOGS_DIR = () => join(root(), "logs");

// Append-only audit log — one JSONL line per action, rotated by date. This is
// the durable "who did what, when, against which target, and was it in scope"
// record a regulated (banking) engagement needs. Never mutated, only appended.
export function auditLog(entry) {
  try {
    mkdirSync(LOGS_DIR(), { recursive: true });
    const f = join(LOGS_DIR(), "audit-" + new Date().toISOString().slice(0, 10) + ".jsonl");
    appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* logging must never break the engine */ }
}

export const STATUSES = ["queued", "building", "review", "changes", "merged", "delivered", "blocked", "stuck", "superseded"];
// "superseded" = closed because it was replaced/decomposed. Not done, not
// awaiting — it must never show up in the "needs you" banner.
export const CLOSED = new Set(["merged", "delivered", "superseded"]);
// "merged"    = the in-session loop finished it LOCALLY. It is not pushed, and
//               it never was — reusing it to mean "delivered" would have made
//               every existing merged task claim a remote it never reached.
// "delivered" = committed, pushed and VERIFIED ON THE REMOTE by the delivery
//               controller. Only that controller may set it (see markDelivered).
const DONE = new Set(["merged", "delivered"]);
// Statuses no operator command may set directly — they assert something only the
// controller that performed the irreversible act can honestly assert.
export const CONTROLLER_ONLY_STATUSES = new Set(["delivered"]);
export const OFFENSIVE = new Set(["web-pentest", "api-pentest", "mobile-android", "mobile-ios",
  "red-team-external", "red-team-internal", "external-network", "internal-network"]);

const REGISTRY_EMPTY = { version: 3, projects: [], authorizations: [] };
// `coverage` is the matrix "coverage is the contract" always claimed but never
// held: one row per endpoint × class × role, so an untested cell is a fact the
// report must state rather than an absence nobody can see. `sessions` is the
// per-role login recipe, so authenticated tasks resume instead of re-racing a
// bank's login and spending its lockout budget.
const STATE_EMPTY = { tasks: [], inbox: [], events: [], findings: [], coverage: [], sessions: {}, seq: { task: 0, inbox: 0, event: 0, finding: 0 } };
// Scope is the authorization gate for offensive packs. authorized=false or an
// empty targets list means active tasks must not run.
const SCOPE_EMPTY = { authorized: false, targets: [], outOfScope: [], roe: "", ref: "", halt: false, expiry: "", client: "", compliance: [] };

const now = () => new Date().toISOString();
const statePath = (id) => join(PROJECTS_DIR(), id, "state.json");

// Corrupt-state recovery: a truncated/invalid file must never hard-crash every
// command. Fall back to the .bak written on the previous successful write; if
// that is also unusable, quarantine the bad file and start from the empty shape
// rather than throwing.
function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    const bak = path + ".bak";
    if (existsSync(bak)) {
      try {
        const recovered = JSON.parse(readFileSync(bak, "utf8"));
        console.error(`warn: ${path} was corrupt — recovered from .bak`);
        return recovered;
      } catch { /* fall through */ }
    }
    try { renameSync(path, path + ".corrupt-" + Date.now()); } catch {}
    console.error(`warn: ${path} was corrupt and unrecoverable — quarantined, starting fresh`);
    return structuredClone(fallback);
  }
}
// Atomic write + keep one backup: temp file → rename, previous good copy kept as
// .bak so a crash mid-write can always be recovered from.
function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (existsSync(path)) { try { copyFileSync(path, path + ".bak"); } catch {} }
  renameSync(tmp, path);
}

// --- write lock (fixes read-modify-write races) ---------------------------
// Concurrent writers (parallel waves + the dashboard) could previously clobber
// each other last-write-wins. mkdir is atomic on every OS, so we use a lock dir:
// acquire → read → mutate → write → release. Stale locks (crashed holder) expire.
const LOCK_TTL = 10000, LOCK_WAIT = 5000;
function withFileLock(path, fn) {
  const lock = path + ".lock";
  const start = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; }                        // acquired
    catch {
      let age = Infinity;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { break; }
      if (age > LOCK_TTL) { try { rmSync(lock, { recursive: true, force: true }); } catch {} continue; }
      if (Date.now() - start > LOCK_WAIT) break;           // give up waiting; proceed (availability > perfection)
      // busy-wait briefly (sync API by design — these are millisecond-scale ops)
      const until = Date.now() + 25; while (Date.now() < until);
    }
  }
  // A command may be async (task-set consults the graph on claim). Releasing in a
  // plain `finally` would free the lock the instant fn() returned its PROMISE —
  // i.e. before the read-modify-write finished — silently undoing the mutual
  // exclusion this whole function exists to provide. Hold until it settles.
  const release = () => { try { rmSync(lock, { recursive: true, force: true }); } catch {} };
  let result;
  try { result = fn(); }
  catch (e) { release(); throw e; }
  if (result && typeof result.then === "function") return result.finally(release);
  release();
  return result;
}

export const loadRegistry = () => readJson(registryPath(), REGISTRY_EMPTY);
export const saveRegistry = (r) => writeJson(registryPath(), r);
export const getProject = (id) => loadRegistry().projects.find((p) => p.id === id) || null;
export const loadState = (id) => readJson(statePath(id), STATE_EMPTY);
export const saveState = (id, s) => writeJson(statePath(id), s);

export function event(state, msg) {
  state.events.unshift({ id: ++state.seq.event, ts: now(), msg });
  state.events = state.events.slice(0, 500); // ponytail: cap log
}

export function addTask(state, t) {
  const task = {
    id: ++state.seq.task,
    phase: Number(t.phase ?? 1),
    phaseName: t.phaseName ?? "",      // human name of the phase, e.g. "Auth & accounts"
    category: t.category ?? "",        // frontend | backend | ui-ux | infra | security | testing | docs
    priority: Number(t.priority ?? 3), // 1=highest … 5=lowest; picked before phase order
    title: t.title ?? "(untitled)",
    ac: t.ac ?? [],           // dev: acceptance criteria; offensive: phase objectives
    ng: t.ng ?? [],
    deps: (t.deps ?? []).map(Number),
    // Where this task's work actually lands. Written by the locate-first step so
    // the discovery is paid once — and so the engine can tell which ready tasks
    // sit on the SAME files and could share one subagent's ground truth.
    files: t.files ?? [],
    // WHY ONE TASK WAITS FOR ANOTHER. `deps` was a bare list of numbers, which
    // cannot answer the only question that matters before a scheduler executes a
    // graph: what does this task CONSUME from that one? An edge nobody can
    // defend serialises work for free, and three of them in a ring deadlock a
    // queue silently. Optional, so every existing task keeps working — an edge
    // with no reason is FLAGGED by the false-edge audit, never deleted.
    //   [{ from: 8, type: "DATA_DEPENDENCY", consumes: "api_contract" }]
    depMeta: t.depMeta ?? [],
    // Bounded retries. Absent means the scheduler's defaults apply; nothing here
    // can create an unlimited one.
    retryPolicy: t.retryPolicy ?? null,
    // Which irreversible acts need a person first. Delivery approval is required
    // by default by the delivery controller itself — this only narrows or names
    // the others.
    approvalPolicy: t.approvalPolicy ?? null,
    // Per-task ceilings the scheduler enforces before it starts an attempt.
    budgets: t.budgets ?? null,
    // Which agent role executes and which reviews. Roles are separate from
    // executors and models on purpose (see scripts/phases.mjs).
    executorRole: t.executorRole ?? null,
    verifierRole: t.verifierRole ?? null,
    // Deliberate exceptions to dependency rules, e.g. allow_cancelled.
    dependencyPolicy: t.dependencyPolicy ?? null,
    // The task's PATH POLICY and its REQUIRED VERIFICATION. These are the two
    // things the external runner enforces mechanically: a worker may only touch
    // allowedPaths, may never touch forbiddenPaths, and "it works" means these
    // commands passed in SCH's own process — not that the worker said so.
    // Absent = the task is not eligible for an autonomous run; the in-session
    // loop is unaffected, which is why every existing task keeps working.
    allowedPaths: t.allowedPaths ?? [],
    forbiddenPaths: t.forbiddenPaths ?? [],
    // At most one durable `.sch-loop/` category this task may write. Null means
    // the whole workspace is off limits, which is the right default for the
    // application-development task that has no business editing SCH's own state.
    controlCategory: t.controlCategory ?? null,
    verify: t.verify ?? [],
    // A question for the operator MUST be born blocked. Creating it queued and
    // blocking it in a second call is how three real questions ended up invisible:
    // the second call was simply never made, so they sat in the queue looking like
    // work, absent from the dashboard's NEEDS YOU banner, unanswerable from a
    // phone. A "DECISION:" title now forces blocked — it cannot be got wrong.
    status: /^\s*DECISION\b/i.test(t.title ?? "") ? "blocked"
      : (STATUSES.includes(t.status) ? t.status : "queued"),
    branch: "",               // dev only
    active: t.active === true || t.active === "true", // offensive: does this run active/attack tooling?
    target: t.target ?? "",   // offensive: which in-scope target
    source: t.source ?? "plan",
    notes: t.notes ?? "",
    skills: t.skills ?? [],   // which installed skills this task dispatched to
    answers: t.answers ?? [], // operator answers to blocked-task questions
    createdAt: now(),
    updatedAt: now(),
  };
  state.tasks.push(task);
  event(state, `task #${task.id} added (${task.source}): ${task.title}`);
  return task;
}

// THE ONLY WAY A TASK BECOMES `delivered`.
//
// Called by the delivery controller after — and only after — the commit has been
// pushed and independently verified on the remote. It is a plain function rather
// than a CLI command on purpose: there is no argv that reaches it, so no prompt,
// skill or operator can talk a task into claiming a remote it never reached.
// The provenance is written with the status, because "delivered" without the
// commit that delivered it is a claim nobody can check.
export function markDelivered(projectId, taskId, provenance) {
  const s = loadState(projectId);
  const t = s.tasks.find((x) => x.id === Number(taskId));
  if (!t) return { ok: false, message: `no task #${taskId} in ${projectId}` };
  for (const k of ["run_id", "delivery_id", "commit", "branch", "remote"])
    if (!provenance?.[k]) return { ok: false, message: `refusing to mark task #${taskId} delivered without ${k}` };
  t.status = "delivered";
  t.delivery = {
    run_id: provenance.run_id, delivery_id: provenance.delivery_id, commit: provenance.commit,
    branch: provenance.branch, remote: provenance.remote, remote_ref: provenance.remote_ref ?? null,
    pushed_range: provenance.pushed_range ?? null, verified_at: provenance.verified_at ?? now(),
  };
  t.updatedAt = now();
  event(s, `task #${t.id} DELIVERED: ${provenance.commit.slice(0, 8)} on ${provenance.remote}/${provenance.branch} (delivery ${provenance.delivery_id})`);
  saveState(projectId, s);
  auditLog({ kind: "delivery", project: projectId, task: String(taskId), ...t.delivery, event: "task-delivered" });
  return { ok: true, task: t };
}

// Creating a remote branch is an explicit decision. It stays explicit — but the
// decision is made ONCE PER PROJECT over a namespace, not once per task. A gate
// per task would make the queue stop on every single first push, which is the
// autonomy this milestone exists to enable.
export function branchNamespace(projectId) {
  const st = loadState(projectId);
  const ns = st?.delivery?.branch_namespace ?? null;
  return ns && ns.pattern ? ns : null;
}

export function branchInNamespace(projectId, branch) {
  return WT.branchMatchesNamespace(branchNamespace(projectId), branch);
}

// A finding is one tested class: either a validated issue (with evidence) or a
// tested-clean cell that proves coverage. Both feed the report + self-learning.
export function addFinding(state, f) {
  state.seq.finding = state.seq.finding ?? 0;
  state.findings = state.findings ?? [];
  const parents = (f.parents ?? []).map(Number).filter(Boolean);
  // chain depth = 1 + deepest parent (root finding = 0). Used to cap chaining.
  const parentDepth = parents.reduce((m, pid) => {
    const p = state.findings.find((x) => x.id === pid); return p ? Math.max(m, p.chainDepth ?? 0) : m;
  }, -1);
  const finding = {
    id: ++state.seq.finding,
    phase: Number(f.phase ?? 0),
    target: f.target ?? "",
    title: f.title ?? "(untitled)",
    category: f.category ?? "",       // WSTG / OWASP / MASTG id
    severity: f.severity ?? "",       // info|low|medium|high|critical
    cvss: f.cvss ?? "",
    status: f.status ?? "candidate",  // candidate|validated|tested-clean|false-positive|reported
    evidence: f.evidence ?? "",
    notes: f.notes ?? "",
    parents,                          // finding ids this was chained from
    chainDepth: parents.length ? parentDepth + 1 : 0,
    createdAt: now(),
  };
  state.findings.push(finding);
  const chain = parents.length ? ` (chain d${finding.chainDepth} from #${parents.join(",#")})` : "";
  event(state, `finding #${finding.id} [${finding.status}] ${finding.title}${chain}`);
  return finding;
}

// A QUESTION THE OPERATOR CANNOT UNDERSTAND OR ANSWER IS NOT A QUESTION.
// Three real ones from a live engagement read, in full: "NEEDS OPERATOR: ...
// Full question in the task notes." — a pointer to the very text being read.
// A fourth was a paragraph of incident status with nothing to answer at all.
// The operator is on a phone with only the dashboard: what is on screen is the
// whole question, and if it does not stand alone it is unanswerable.
function askGate(t, flags) {
  const q = `${flags.brief ?? t.brief ?? ""}\n${flags.notes ?? t.notes ?? ""}\n${flags.note ?? ""}`.trim();
  const bare = q.replace(/\s+/g, " ");
  if (bare.length < 80)
    die(`BLOCK REFUSED — task #${t.id} has no readable question. The dashboard shows exactly this text and nothing else: write the question, the options with what each one means, and your recommended default, into --brief.`);
  if (/\b(see|full question|details?)\b[^.]{0,30}\b(the )?(task )?notes\b/i.test(bare) || /full question is (in|below)/i.test(bare))
    die(`BLOCK REFUSED — task #${t.id} points at "the task notes", but the notes ARE what the operator sees. Put the whole question on screen, not a reference to somewhere else.`);
  if (!/\?/.test(bare))
    die(`BLOCK REFUSED — task #${t.id} contains no question. If there is nothing for a person to decide, do not block: if you are waiting on something external, leave it queued with a note and keep working the rest of the queue; if another task must finish first, name that task and it becomes a dependency.`);
}

// CHAINING WAS ADVICE, SO IT NEVER HAPPENED. Two engagements, 24 validated
// findings, zero with a parent — while `--parents`, `chainDepth` and CHAIN_MAX
// all sat there working. "Ask what this unlocks" in a methodology document is a
// suggestion; a task in the queue is a commitment. Every validated medium+
// finding now spawns its own chain hunt unless the depth cap is reached or the
// caller explicitly opts out with --no-chain.
function chainHunt(state, f, flags) {
  if (f.status !== "validated") return null;
  if (flags["no-chain"] === "true") return null;
  if (!["medium", "high", "critical"].includes((f.severity ?? "").toLowerCase())) return null;
  if ((f.chainDepth ?? 0) >= CHAIN_MAX) return null;
  const t = addTask(state, {
    phase: f.phase, priority: 2, active: true, target: f.target, source: "chain",
    category: "security", phaseName: "Chaining & impact",
    title: `Chain hunt from finding #${f.id}: ${f.title}`,
    notes: `PRIMITIVE (finding #${f.id}, ${f.severity}${f.category ? ", " + f.category : ""}): ${f.title}\n`
      + `Evidence: ${f.evidence || "n/a"}\n\n`
      + `What does this primitive UNLOCK? Do not re-test the finding — take it as given and reach for impact: `
      + `combine it with what other tasks already proved, escalate privilege, cross a tenant boundary, reach data or money. `
      + `A proven chain outranks its parts and is reported as one attack narrative.\n`
      + `Record the result with finding-add --parents ${f.id} so lineage and depth are tracked. `
      + `If nothing chains, log it tested-clean with why — that is a real answer, not a failure.`,
    ac: [`The chain from finding #${f.id} is either demonstrated end to end with a PoC, or recorded as not-chainable with the reason`],
    ng: ["No destructive action", "No out-of-scope pivot", "Do not re-prove the parent finding"],
  });
  event(state, `chain-hunt task #${t.id} spawned from finding #${f.id} (depth ${(f.chainDepth ?? 0) + 1})`);
  return t.id;
}

// A coverage cell is endpoint × class × role. `blocked` and `not-applicable`
// are honest outcomes and count as covered — "we could not reach it, here is
// why" is a statement a client can act on; silence is not.
const COVERAGE_STATUS = new Set(["untested", "validated", "tested-clean", "blocked", "not-applicable"]);
const COVERED = new Set(["validated", "tested-clean", "blocked", "not-applicable"]);
const cellOf = (s, e, c, r) => (s.coverage ?? []).find((x) => x.endpoint === e && x.class === c && x.role === r);
export function coverageSummary(state) {
  const cells = state.coverage ?? [];
  const by = {}; for (const st of COVERAGE_STATUS) by[st] = cells.filter((c) => c.status === st).length;
  const untested = cells.filter((c) => c.status === "untested");
  return {
    total: cells.length, covered: cells.filter((c) => COVERED.has(c.status)).length,
    pct: cells.length ? Math.round(cells.filter((c) => COVERED.has(c.status)).length / cells.length * 100) : 0,
    byStatus: by,
    untestedCells: untested.slice(0, 40).map((c) => `${c.endpoint} × ${c.class} × ${c.role}`),
  };
}

// A `validated` finding is a CLAIM ABOUT THE CLIENT'S SYSTEM. It goes in the
// CERT-In report, so it needs a PoC someone else can re-run — not a pointer at
// the phase write-up. An engagement reached 20 validated findings whose entire
// evidence was a shared class report ("reports/config/headers.md" on four of
// them), one of them untitled, and not one raw request/response or screenshot.
// The pack always demanded a PoC; nothing ever checked, so nothing produced one.
export function pocGate(project, state, f) {
  if ((f.status ?? "") !== "validated") return;         // only the reportable claims
  const home = getProject(project)?.path;
  const title = (f.title ?? "").trim();
  if (!title || title === "(untitled)") die("FINDING BLOCKED — a validated finding needs a --title. It is going in the client report.");
  // The report has a CVSS row for every finding. One engagement filled it once
  // in twenty, so nineteen client-facing findings render as "—" and nothing can
  // be prioritised. Required from medium up; info/low may carry a bare severity.
  const sev = (f.severity ?? "").toLowerCase();
  if (["medium", "high", "critical"].includes(sev) && !(f.cvss ?? "").trim())
    die(`FINDING BLOCKED — "${title}" is ${sev} and needs --cvss (e.g. "6.1 (AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N)"). The report prioritises on it.`);
  const ev = (f.evidence ?? "").trim();
  if (!ev) die(`FINDING BLOCKED — "${title}" is validated with no --evidence. Write the PoC first (raw request + response, or a screenshot) under reports/evidence/, then log the finding pointing at that file.`);
  if (home && !existsSync(join(home, ev)) && !existsSync(ev))
    die(`FINDING BLOCKED — "${title}": evidence "${ev}" does not exist under ${home}. Write the PoC file before logging the finding; a path to a file that is not there is not evidence.`);
  // A phase write-up covering eight findings is a summary, not a PoC. Warn once
  // it is reused rather than refusing — some findings genuinely share a capture.
  const shared = (state.findings ?? []).filter((x) => x.status === "validated" && x.evidence === ev && x.id !== f.id).length;
  if (shared) process.stderr.write(`[poc] warning: "${ev}" is already the evidence for ${shared} other validated finding(s) — give this one its own request/response or screenshot.\n`);
}

// A finding lived only in state.json, so the knowledge graph — the thing a fresh
// context actually asks — never learned what the engagement had already proven.
// Mirror it: the finding, the target it was found on, the evidence that proves
// it, and the findings it chained from. Best-effort; never fails the log.
export async function recordFinding(project, state, f) {
  try {
    const g = await import("./graph.mjs");
    const db = g.open(project);
    const fid = g.upsertNode(db, {
      kind: "finding", name: `#${f.id} ${f.title}`, path: f.target || "",
      summary: [f.severity && f.severity.toUpperCase(), f.status, f.category, f.notes].filter(Boolean).join(" · "),
      meta: { findingId: f.id, severity: f.severity, status: f.status, cvss: f.cvss, phase: f.phase },
    });
    if (f.target) g.addEdge(db, fid, g.upsertNode(db, { kind: "host", name: f.target }), "relates");
    if (f.evidence) g.addEdge(db, fid, g.upsertNode(db, { kind: "evidence", name: f.evidence, path: f.evidence }), "evidences");
    for (const p of f.parents || []) {
      const parent = (state.findings || []).find((x) => x.id === p);
      if (parent) g.addEdge(db, g.nodeId("finding", `#${parent.id} ${parent.title}`, parent.target || ""), fid, "relates");
    }
    db.close();
  } catch (e) { process.stderr.write(`[graph] finding #${f.id} not recorded: ${e.message}\n`); }
}

// Max chain depth reached in this project — the loop stops spawning chain-hunts
// past CHAIN_MAX (default 3) to avoid infinite self-spawning.
export const CHAIN_MAX = 3;

// Is this task UI/design work? (drives whether the design-skill gate applies)
const DESIGN_RE = /\b(ui|ux|design|redesign|restyle|frontend|front-end|css|style|styling|theme|layout|component|primitive|mockup|page|screen|dashboard|responsive|accessib|animation|motion|visual)\b/i;
// Words that mean the task is really backend/infra even if a design word appears
// ("DRM settings admin screen" is config work; "nginx: gate /media" is infra).
const NOT_DESIGN_RE = /\b(nginx|migration|celery|cron|smtp|webhook|api endpoint|database|schema|docker|deploy|packaging|encoding|transcode|token|rate.?limit|scan|recon|exploit|payload)\b/i;
export function isDesignTask(t) {
  const text = (t.title || "") + " " + (t.notes || "") + " " + (t.ac || []).join(" ");
  if (NOT_DESIGN_RE.test(text) && !/\b(ui-\d|redesign|mockup|responsive|accessib)\b/i.test(text)) return false;
  return DESIGN_RE.test(text);
}

// every dependency merged → this task can actually start
export const depsMet = (state, t) =>
  (t.deps ?? []).every((d) => { const dep = state.tasks.find((x) => x.id === Number(d)); return dep && DONE.has(dep.status); });

export function nextReady(state) {
  return state.tasks
    .filter((t) => t.status === "queued")
    .filter((t) => depsMet(state, t))
    // priority first (1=highest), then phase order, then FIFO — so a hot task
    // submitted from the dashboard jumps ahead of a 150-item queue when it should.
    .sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || a.phase - b.phase || a.id - b.id)[0] ?? null;
}

const expired = (iso) => iso && new Date(iso).getTime() < Date.now();

// Audit trail: record how/when/by-whom each asset entered scope. Since scope
// often arrives verbally / via Teams, this provenance IS the paper trail that a
// given asset was formally shared under the standing authorization.
function logProvenance(auth, domains, flags) {
  if (!domains.length) return;
  auth.provenance = auth.provenance ?? [];
  auth.provenance.unshift({
    domains, via: flags.via ?? "", by: flags.by ?? "", cr: flags.id ?? flags.cr ?? "",
    note: flags.note ?? "", ts: new Date().toISOString(),
  });
}

// Is `target` inside a project's authorized scope? Used to gate active tasks.
// An expired authorization fails closed — a standing engagement is time-boxed.
// What loop interval should this project run at?
//
// Since a pass now keeps working (up to 5 tasks / 25 min) instead of sleeping out
// its interval, the interval ONLY decides how long a *stopped* loop waits before
// waking. So the answer depends on why it would be stopped:
//   deep ready queue  → a pass batches anyway; a short interval only adds BUSY
//                       wake-ups that cost tokens and achieve nothing.
//   shallow queue     → the pass ends early, so waking sooner does real work.
//   blocked on you    → YOU are the bottleneck; wake soon after an answer lands.
//   nothing at all    → wake rarely; every wake-up on an empty queue is waste.
export function suggestInterval(state) {
  const t = state.tasks ?? [];
  const ready = t.filter((x) => x.status === "queued" &&
    (x.deps ?? []).every((d) => DONE.has(t.find((y) => y.id === Number(d))?.status))).length;
  const blocked = t.filter((x) => x.status === "blocked").length;
  const changes = t.filter((x) => x.status === "changes").length;
  const inbox = (state.inbox ?? []).filter((i) => i.status === "new").length;

  if (blocked && !ready && !changes)
    return { minutes: 10, why: `${blocked} task(s) waiting on your answer and nothing else ready — a short interval picks your answer up quickly` };
  if (ready + changes + inbox === 0)
    return { minutes: 30, why: "nothing queued — wake rarely; every wake-up on an empty queue is wasted tokens" };
  if (ready + changes >= 5)
    return { minutes: 30, why: `${ready + changes} ready — one pass batches up to 5 tasks / 25 min, so a shorter interval would only add BUSY wake-ups` };
  return { minutes: 15, why: `only ${ready + changes} ready — a pass will finish early, so waking sooner does real work` };
}

// What this project has spent today, against its cap. Counts every recorded
// subagent run, which is the part the loop controls; the orchestrator's own
// context is on top of this, so treat the number as a floor, never a total.
export function budgetStatus(id) {
  const cap = getProject(id)?.dailyTokenBudget ?? 0;
  const s = loadState(id);
  const day = new Date().toISOString().slice(0, 10);
  let spent = 0;
  for (const t of s.tasks ?? [])
    for (const c of t.costs ?? []) if ((c.at ?? "").slice(0, 10) === day) spent += c.tokens || 0;
  // tasks costed before per-agent breakdown existed still count for today
  for (const t of s.tasks ?? [])
    if (!(t.costs ?? []).length && t.tokens > 0 && (t.updatedAt ?? "").slice(0, 10) === day) spent += t.tokens;
  return {
    day, spent, cap,
    pct: cap ? Math.round(spent / cap * 100) : null,
    over: cap > 0 && spent >= cap,
    note: cap ? `${(spent / 1e6).toFixed(2)}M of ${(cap / 1e6).toFixed(2)}M recorded subagent tokens today`
              : "no cap set — state.mjs budget --project <id> --daily <tokens>",
  };
}

export function inScope(project, target) {
  const sc = project?.scope ?? SCOPE_EMPTY;
  if (!sc.authorized || sc.halt || expired(sc.expiry)) return false;
  if ((sc.outOfScope ?? []).some((o) => target && target.includes(o))) return false;
  return (sc.targets ?? []).some((t) => target && target.includes(t));
}

// A standing authorization is a master engagement record (client, signed ref,
// authorized host patterns, explicit out-of-scope, expiry, compliance). A new
// project whose target matches a NON-EXPIRED authorization auto-arms from it —
// so a year-long engagement is attested once, not per project. Production hosts
// listed in outOfScope are never covered.
export function authForTarget(registry, target) {
  return (registry.authorizations ?? []).find((a) =>
    !expired(a.expiry) &&
    !(a.outOfScope ?? []).some((o) => target && target.includes(o)) &&
    (a.scopeDomains ?? []).some((d) => target && target.includes(d))
  ) ?? null;
}

// Route an asset to its CLIENT engagement (which SOW does this belong to),
// using the authorization's broad clientDomains pattern (e.g. "acme-bank.com").
// This is only for routing a newly-shared asset to the right recorded client —
// it is NOT the enforcement gate. A client with no engagement on record does
// not match, so its assets are never auto-authorized.
export function clientMatch(registry, target) {
  return (registry.authorizations ?? []).find((a) =>
    !expired(a.expiry) && (a.clientDomains ?? []).some((d) => target && target.includes(d))
  ) ?? null;
}

// ---- CLI ----
function parseFlags(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = argv[++i];
    } else pos.push(a);
  }
  return { flags, pos };
}
const splitList = (s) => (s ? s.split(/\s*\|\s*|\n/).map((x) => x.trim()).filter(Boolean) : []);
// A verification command is an executable and its arguments — never a shell
// string. The AUTHORITATIVE stored form is structured:
//   { id, exe, args: [...], cwd, timeout_ms }
// `--verify "npm test"` is convenience shorthand that COMPILES INTO that shape;
// nothing downstream ever splits a string again, so `--verify-json` can carry an
// argument containing a space and it still runs as one argument.
const VERIFY_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const verifyRecord = (v, i) => ({
  id: String(v.id ?? `VER-${i + 1}`),
  exe: String(v.exe ?? ""),
  args: Array.isArray(v.args) ? v.args.map(String) : [],
  cwd: v.cwd ? String(v.cwd) : ".",
  timeout_ms: Number(v.timeout_ms) > 0 ? Number(v.timeout_ms) : VERIFY_DEFAULT_TIMEOUT_MS,
});
const parseVerify = (s) => splitList(s).map((c, i) => {
  const parts = c.split(/\s+/).filter(Boolean);
  return verifyRecord({ exe: parts[0], args: parts.slice(1) }, i);
});
// Exact commands, no splitting: a JSON array of the structured shape.
const parseVerifyJson = (s) => {
  let v;
  try { v = JSON.parse(s); } catch (e) { die(`--verify-json is not valid JSON: ${e.message}`); }
  if (!Array.isArray(v)) die("--verify-json must be a JSON array of { id, exe, args, cwd, timeout_ms }");
  return v.map((x, i) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) die(`--verify-json entry ${i} must be an object`);
    if (x.args !== undefined && !Array.isArray(x.args)) die(`--verify-json entry ${i}: args must be an array of strings`);
    if (!x.exe) die(`--verify-json entry ${i}: needs an "exe"`);
    return verifyRecord(x, i);
  });
};
const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
// Resolve the project from the current working directory, so --project is
// optional: run the command from inside a project's folder and it just works.
// Most specific (longest) registered path wins, so nested projects resolve right.
const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export function detectProject(cwd = process.cwd()) {
  const here = norm(cwd);
  return (loadRegistry().projects || [])
    .filter((p) => p.path && (here === norm(p.path) || here.startsWith(norm(p.path) + "/")))
    .sort((a, b) => norm(b.path).length - norm(a.path).length)[0]?.id ?? null;
}
const pid = (flags) => flags.project || process.env.SCH_PROJECT || detectProject()
  || die("no --project given and this folder matches no registered project. Use --project <id>, or run from the project folder. See: project-list");
const die = (m) => { console.error("error: " + m); process.exit(1); };

const commands = {
  init() { saveRegistry(loadRegistry()); out("registry ready: " + registryPath()); },

  "project-add"({ flags }) {
    const r = loadRegistry();
    if (!flags.id) die("need --id");
    if (r.projects.some((p) => p.id === flags.id)) die("project id exists: " + flags.id);
    const p = {
      id: flags.id,
      name: flags.name ?? flags.id,
      domain: flags.domain ?? "app-dev", // the pack
      description: flags.description ?? "",   // one-paragraph "what this project is"
      stack: splitList(flags.stack),          // e.g. "Django|React SPA|PostgreSQL|Docker"
      path: flags.path ?? "",
      scope: structuredClone(SCOPE_EMPTY),
      createdAt: now(),
    };
    r.projects.push(p);
    saveRegistry(r);
    saveState(p.id, STATE_EMPTY); // create isolated state file
    out(p);
  },
  "project-list"() { out(loadRegistry().projects); },
  // Set/update a project's brief + tech stack (shown at the top of its dashboard).
  "project-meta"({ flags }) {
    const r = loadRegistry(); const p = r.projects.find((x) => x.id === pid(flags));
    if (!p) die("no such project");
    if (flags.description !== undefined) p.description = flags.description;
    if (flags.stack !== undefined) p.stack = splitList(flags.stack);
    if (flags.name !== undefined) p.name = flags.name;
    saveRegistry(r); out({ name: p.name, description: p.description, stack: p.stack });
  },
  // Skills the operator REQUIRES this project to use. The loop must invoke them
  // (verified against the session transcript by scripts/verify-skills.mjs), and
  // a task cannot complete if a required skill for its kind was never invoked.
  "skills-set"({ flags }) {
    const r = loadRegistry(); const p = r.projects.find((x) => x.id === pid(flags));
    if (!p) die("no such project");
    p.requiredSkills = splitList(flags.skills);
    saveRegistry(r);
    const s = loadState(p.id); event(s, `required skills set: ${p.requiredSkills.join(", ") || "(none)"}`); saveState(p.id, s);
    out(p.requiredSkills);
  },
  "skills-get"({ flags }) { out(getProject(pid(flags))?.requiredSkills ?? []); },
  // Which project does the current folder resolve to? (--project is optional)
  "project-here"() {
    const id = detectProject();
    out(id ? { project: id, cwd: process.cwd(), ...getProject(id) } : "no registered project matches " + process.cwd());
  },
  "project-get"({ flags, pos }) { out(getProject(flags.project ?? pos[0]) ?? "not found"); },

  "scope-set"({ flags }) {
    const r = loadRegistry();
    const p = r.projects.find((x) => x.id === pid(flags));
    if (!p) die("no such project");
    const sc = p.scope ?? structuredClone(SCOPE_EMPTY);
    if (flags.authorized !== undefined) sc.authorized = flags.authorized === "true";
    if (flags.halt !== undefined) sc.halt = flags.halt === "true";
    if (flags.targets !== undefined) sc.targets = splitList(flags.targets);
    if (flags.out !== undefined) sc.outOfScope = splitList(flags.out);
    if (flags.roe !== undefined) sc.roe = flags.roe;
    if (flags.ref !== undefined) sc.ref = flags.ref;
    p.scope = sc;
    saveRegistry(r);
    out(sc);
  },
  "scope-get"({ flags }) { out(getProject(pid(flags))?.scope ?? "not found"); },
  "scope-check"({ flags, pos }) {
    const project = pid(flags); const target = flags.target ?? pos[0];
    const p = getProject(project); const ok = inScope(p, target);
    // Every scope decision is logged — the core audit event for offensive work.
    auditLog({ kind: "scope-check", project, target, decision: ok ? "IN-SCOPE" : "REFUSED", ref: p?.scope?.ref, client: p?.scope?.client });
    out(ok ? "IN-SCOPE" : "OUT-OF-SCOPE-OR-UNAUTHORIZED");
  },

  // ---- standing authorizations (master engagement records) ----
  "auth-add"({ flags }) {
    const r = loadRegistry(); r.authorizations = r.authorizations ?? [];
    if (!flags.client || !flags.ref) die("need --client and --ref (signed authorization reference)");
    const a = {
      client: flags.client,
      ref: flags.ref,                                   // SOW / contract / internal-auth id
      signatory: flags.signatory ?? "",
      clientDomains: splitList(flags["client-domains"]), // broad pattern to ROUTE assets to this client (e.g. "acme-bank.com")
      scopeDomains: splitList(flags.domains),           // specific authorized assets (the enforced allowlist, grows as shared)
      outOfScope: splitList(flags.out),                 // explicit never-touch
      expiry: flags.expiry ?? "",                       // ISO date; empty = never (discouraged)
      roe: flags.roe ?? "",
      compliance: splitList(flags.compliance),
      createdAt: now(),
    };
    r.authorizations.push(a); saveRegistry(r); out(a);
  },
  "auth-list"() { out(loadRegistry().authorizations ?? []); },
  "auth-find"({ flags, pos }) { out(authForTarget(loadRegistry(), flags.target ?? pos[0]) ?? "none"); },
  // Add newly-shared assets to a standing engagement's scope — no new auth email
  // needed (matches "added to the standing scope registry"). Append specific
  // hosts/IPs only; never a bare apex domain (that would over-cover).
  "auth-add-domain"({ flags }) {
    const r = loadRegistry(); const a = (r.authorizations ?? []).find((x) => x.ref === flags.ref);
    if (!a) die("no authorization with ref " + flags.ref);
    const add = splitList(flags.domains); const kind = flags.out === "true" ? "outOfScope" : "scopeDomains";
    a[kind] = [...new Set([...(a[kind] ?? []), ...add])];
    logProvenance(a, add, flags);           // who shared it, how, when — audit trail
    saveRegistry(r); out({ ref: a.ref, scopeDomains: a.scopeDomains, outOfScope: a.outOfScope });
  },
  // Spin up a per-CR pentest engagement in one call: record the shared assets
  // (with provenance) under the standing authorization, create the project, and
  // arm it scoped to just this CR's assets (least privilege). This is the daily
  // fast path — scope arrives by Teams/email/call/meeting, no new auth email.
  "cr-new"({ flags }) {
    const targets = splitList(flags.targets);
    if (!flags.id || !targets.length) die("need --id (CR ref) and --targets");
    const r = loadRegistry();
    // Match the client automatically: explicit --ref, else the standing
    // authorization whose recorded scope already covers this target, else (only
    // if a single authorization exists) that one. No match → the client has no
    // engagement on record; refuse and ask to record it once.
    const a = flags.ref ? (r.authorizations ?? []).find((x) => x.ref === flags.ref)
      : clientMatch(r, targets[0]);
    if (!a) die("no client engagement on record matches " + targets[0] + " — record it once with auth-add (client, ref, expiry, clientDomains), or pass --ref");
    if (expired(a.expiry)) die("authorization " + a.ref + " expired " + a.expiry + " — renew before testing");
    const pidv = (flags.project ?? flags.id).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (r.projects.some((p) => p.id === pidv)) die("project exists: " + pidv);
    a.scopeDomains = [...new Set([...(a.scopeDomains ?? []), ...targets])];
    logProvenance(a, targets, flags);
    const proj = {
      id: pidv, name: flags.name ?? flags.id, domain: flags.domain ?? "web-pentest",
      path: flags.path ?? "", createdAt: now(),
      // per-CR least privilege: this project can only touch THIS CR's assets
      scope: { authorized: true, halt: false, targets, outOfScope: a.outOfScope ?? [], roe: a.roe ?? "", ref: a.ref, expiry: a.expiry, client: a.client, compliance: a.compliance ?? [] },
    };
    r.projects.push(proj); saveRegistry(r);
    const s = structuredClone(STATE_EMPTY);
    event(s, `CR ${flags.id} created & armed from ${a.ref} — targets: ${targets.join(", ")} (shared via ${flags.via || "?"} by ${flags.by || "?"})`);
    saveState(proj.id, s);
    out({ project: proj.id, domain: proj.domain, targets, ref: a.ref, expiry: a.expiry, next: `sch-plan --project ${proj.id}` });
  },
  // ---- run lock: only one loop pass per project at a time ----
  // The loop interval no longer matters: if a pass is still working, the next
  // pass acquires nothing and exits. A stale lock (older than its TTL — e.g. the
  // session died mid-task) is taken over automatically so work never wedges.
  "lock-acquire"({ flags }) {
    const id = pid(flags); const s = loadState(id);
    const ttlMs = Number(flags.ttl ?? 45) * 60000;   // minutes; set > longest task
    const l = s.lock;
    if (l && Date.now() - new Date(l.ts).getTime() < (l.ttlMs ?? ttlMs)) {
      return out(`BUSY held-by=${l.holder} since=${l.ts} — a pass is still running, exit this pass`);
    }
    if (l) event(s, `stale lock from ${l.ts} taken over`);
    s.lock = { holder: flags.holder ?? "sch-run", ts: now(), ttlMs };
    event(s, `run-lock acquired (${s.lock.holder})`);
    saveState(id, s); out("ACQUIRED");
  },
  "lock-release"({ flags }) {
    const id = pid(flags); const s = loadState(id);
    if (s.lock) { delete s.lock; event(s, "run-lock released"); saveState(id, s); }
    out("RELEASED");
  },
  "lock-status"({ flags }) { out(loadState(pid(flags)).lock ?? "free"); },
  // ONE cheap call the loop makes at the very start of every pass, BEFORE loading
  // the heavy pack/knowledge/PRD. Decides in a few tokens whether the pass should
  // do anything at all — the main lever against token burn on idle/overlapping passes.
  // Called at the start of a pass, and again after each completed task so the pass
  // can keep working instead of sleeping out the rest of its interval.
  //   --holder <name>  the caller already holds the lock (a continuing pass), so
  //                    its OWN lock must not read as BUSY.
  "pass-gate"({ flags }) {
    const id = pid(flags);
    const s = loadState(id);
    const l = s.lock, ttl = l?.ttlMs ?? 45 * 60000;
    const mine = !!flags.holder && l?.holder === flags.holder;

    // ORPHAN RECOVERY. `building` and `review` only make sense while a pass holds
    // the lock. If the session was closed, crashed, or the operator stopped it
    // mid-task, the task keeps that status forever — and task-next only ever
    // returns `queued`, so it becomes invisible and is silently never built.
    // No live lock means nobody is working on it: put it back in the queue.
    const lockLive = l && Date.now() - new Date(l.ts).getTime() < ttl;
    if (!lockLive) {
      let rescued = 0;
      for (const t of s.tasks) {
        if (t.status !== "building" && t.status !== "review") continue;
        t.status = "queued";
        t.notes = `requeued: a pass was interrupted while this was ${t.status === "review" ? "in review" : "building"}` +
          (t.notes ? ` — previously: ${t.notes}` : "");
        t.updatedAt = now();
        rescued++;
      }
      if (rescued) { event(s, `orphan recovery: ${rescued} interrupted task(s) requeued`); saveState(id, s); }
    }
    let verdict;
    // PAUSED is a state contract, not a suggestion: "no new work may start"
    // means the pass does not start. Only fires when a capability profile
    // explicitly sets it — a project without a profile defaults to SINGLE_TASK
    // and behaves exactly as it always has.
    const elig = SK.runEligibility(SK.readProfile(getProject(id)));
    if (!elig.eligible) {
      s.run = { ...(s.run ?? {}), lastPass: now(), verdict: "PAUSED", intervalMin: Number(flags.interval ?? s.run?.intervalMin ?? 0) || 0 };
      saveState(id, s);
      return out(`PAUSED — ${elig.reason}. Resume with: state.mjs profile-set --project ${id} --mode SINGLE_TASK`);
    }
    // Spend cap first: past it, there is nothing worth loading a pack for.
    const b = budgetStatus(id);
    if (b.over) {
      s.run = { ...(s.run ?? {}), lastPass: now(), verdict: "BUDGET", intervalMin: Number(flags.interval ?? s.run?.intervalMin ?? 0) || 0 };
      saveState(id, s);
      return out(`BUDGET — ${b.note}. Stop the pass. Raise it with ` +
        `\`state.mjs budget --project ${id} --daily <tokens>\` or wait for tomorrow.`);
    }
    if (!mine && l && Date.now() - new Date(l.ts).getTime() < ttl) verdict = "BUSY";  // another pass running → exit
    else {
      const changes = s.tasks.some((t) => t.status === "changes");
      const inbox = s.inbox.some((i) => i.status === "new");
      verdict = (changes || inbox || !!nextReady(s)) ? "WORK" : "IDLE";               // real work → proceed
    }
    // HEARTBEAT — this is the only call guaranteed to happen on every pass, so it
    // is where "the loop is alive" gets recorded. Without it the dashboard cannot
    // tell a healthy idle loop from a cron that died hours ago: both look empty.
    // A continuing pass refreshes the timestamp (so a long pass still looks alive)
    // but does not increment the pass counter — it is the same pass.
    const prev = s.run ?? {};
    const interval = Number(flags.interval ?? prev.intervalMin ?? 0) || 0;
    s.run = { lastPass: now(), passN: (prev.passN ?? 0) + (mine ? 0 : 1), verdict, intervalMin: interval };
    if (mine) { s.lock = { ...l, ts: now() }; }   // keep our own lock fresh across a long pass
    saveState(id, s);
    out(verdict);
  },

  "provenance"({ flags }) {
    const a = (loadRegistry().authorizations ?? []).find((x) => x.ref === flags.ref);
    out(a ? (a.provenance ?? []) : "no such authorization");
  },
  // Retest: spin a new project seeded with one task per validated finding from a
  // source engagement (post-remediation re-verification). Inherits the source's
  // scope + authorization. The loop re-tests each and records fixed (tested-clean)
  // or still-open (validated); the report is the fixed/open delta.
  "retest-new"({ flags }) {
    const from = flags.from ?? die("need --from <source project id>");
    const r = loadRegistry(); const src = r.projects.find((p) => p.id === from);
    if (!src) die("no such source project: " + from);
    const validated = (loadState(from).findings ?? []).filter((f) => f.status === "validated");
    if (!validated.length) die("source has no validated findings to retest");
    const newId = (flags.id ?? from + "-retest").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (r.projects.some((p) => p.id === newId)) die("project exists: " + newId);
    const proj = { id: newId, name: flags.name ?? (src.name + " — retest"), domain: src.domain, path: flags.path ?? "", scope: structuredClone(src.scope ?? {}), createdAt: now() };
    r.projects.push(proj); saveRegistry(r);
    const s = structuredClone(STATE_EMPTY);
    for (const f of validated) addTask(s, { phase: f.phase, priority: 2, title: "Re-verify: " + f.title, active: f.target ? true : false, target: f.target, source: "retest", notes: `Original finding: ${f.category || ""} sev=${f.severity} — confirm fixed or still-open. Evidence: ${f.evidence || "n/a"}` });
    event(s, `retest of ${from}: ${validated.length} finding(s) queued for re-verification`);
    saveState(newId, s);
    out({ project: newId, retesting: validated.length, from, next: `sch-plan (optional) then /loop /sch-run --project ${newId}` });
  },
  "auth-remove"({ flags }) {
    const r = loadRegistry(); const n = (r.authorizations ?? []).length;
    r.authorizations = (r.authorizations ?? []).filter((x) => x.ref !== flags.ref);
    saveRegistry(r); out(n === r.authorizations.length ? "no match" : "removed " + flags.ref);
  },
  // Arm a project's scope FROM a matching standing authorization — no manual
  // re-attestation. Fails if no non-expired authorization covers the target.
  "scope-arm-from-auth"({ flags }) {
    const id = pid(flags); const target = flags.target ?? die("need --target");
    const reg = loadRegistry(); const a = authForTarget(reg, target);
    if (!a) die("no valid standing authorization covers " + target);
    const p = reg.projects.find((x) => x.id === id); if (!p) die("no such project");
    p.scope = { authorized: true, halt: false, targets: [...new Set([...(p.scope?.targets ?? []), ...a.scopeDomains])], outOfScope: a.outOfScope, roe: a.roe, ref: a.ref, expiry: a.expiry, client: a.client, compliance: a.compliance };
    saveRegistry(reg);
    const s = loadState(id); event(s, `armed from standing auth ${a.ref} (${a.client}), expires ${a.expiry || "n/a"}`); saveState(id, s);
    out(p.scope);
  },

  // ---- findings (per project) ----
  async "finding-add"({ flags }) {
    const id = pid(flags); const s = loadState(id);
    pocGate(id, s, flags);
    const f = addFinding(s, { phase: flags.phase, target: flags.target, title: flags.title, category: flags.category, severity: flags.severity, cvss: flags.cvss, status: flags.status, evidence: flags.evidence, notes: flags.notes, parents: splitList(flags.parents) });
    const chain = chainHunt(s, f, flags);
    // a finding IS a coverage result — record the cell without a second command
    if (flags.endpoint && flags.category) {
      const cell = cellOf(s, flags.endpoint, flags.category, flags.role ?? "anon");
      const st = f.status === "validated" ? "validated" : f.status === "tested-clean" ? "tested-clean" : null;
      if (st) { if (cell) Object.assign(cell, { status: st, finding: f.id, ts: now() });
                else s.coverage.push({ endpoint: flags.endpoint, class: flags.category, role: flags.role ?? "anon", status: st, finding: f.id, note: "", ts: now() }); }
    }
    saveState(id, s);
    await recordFinding(id, s, f);
    out(chain ? { finding: f.id, chainTask: chain } : f.id.toString());
  },
  // ---- coverage matrix (offensive) ----------------------------------------
  // "Coverage is the contract" was prose: `coverage_required` was set on every
  // offensive pack and nothing ever computed it, so "no untested cell" meant an
  // agent reading its own notes. A cell is endpoint × class × role.
  "coverage-add"({ flags }) {
    const id = pid(flags); const s = loadState(id);
    const eps = splitList(flags.endpoints ?? flags.endpoint);
    const cls = splitList(flags.classes ?? flags.class);
    const roles = splitList(flags.roles ?? flags.role);
    if (!eps.length || !cls.length) die("need --endpoints and --classes (pipe-separated); --roles defaults to anon");
    let added = 0;
    for (const e of eps) for (const c of cls) for (const r of (roles.length ? roles : ["anon"])) {
      if (cellOf(s, e, c, r)) continue;                       // declaring twice is not a reset
      s.coverage.push({ endpoint: e, class: c, role: r, status: "untested", finding: null, note: "", ts: now() });
      added++;
    }
    event(s, `coverage: +${added} cell(s) declared (${eps.length}ep × ${cls.length}cls × ${roles.length || 1}role)`);
    saveState(id, s); out({ added, total: s.coverage.length, untested: s.coverage.filter((c) => c.status === "untested").length });
  },
  "coverage-set"({ flags }) {
    const id = pid(flags); const s = loadState(id);
    const e = flags.endpoint ?? die("need --endpoint");
    const c = flags.class ?? die("need --class");
    const r = flags.role ?? "anon";
    const st = flags.status ?? die("need --status validated|tested-clean|blocked|not-applicable|untested");
    if (!COVERAGE_STATUS.has(st)) die(`unknown --status "${st}" — use one of: ${[...COVERAGE_STATUS].join(", ")}`);
    // A cell nobody declared is still a cell that was tested — record it rather
    // than refusing, or the matrix only ever describes what planning predicted.
    let cell = cellOf(s, e, c, r);
    if (!cell) { cell = { endpoint: e, class: c, role: r, status: "untested", finding: null, note: "", ts: now() }; s.coverage.push(cell); }
    if (st === "blocked" && !flags.note) die("a blocked cell needs --note saying what blocked it — that text goes in the client's coverage section");
    Object.assign(cell, { status: st, finding: flags.finding ? Number(flags.finding) : cell.finding, note: flags.note ?? cell.note, ts: now() });
    event(s, `coverage: ${e} × ${c} × ${r} -> ${st}`);
    saveState(id, s); out(cell);
  },
  "coverage-list"({ flags }) {
    const s = loadState(pid(flags));
    let rows = s.coverage ?? [];
    if (flags.status) rows = rows.filter((c) => c.status === flags.status);
    if (flags.endpoint) rows = rows.filter((c) => c.endpoint === flags.endpoint);
    if (flags.role) rows = rows.filter((c) => c.role === flags.role);
    out(flags.summary === "true" ? coverageSummary(s) : rows);
  },

  // ---- per-role sessions ---------------------------------------------------
  // Every authenticated task used to re-derive the login from zero, and the
  // authorization matrix needs several roles live at once. Storing the recipe
  // (and where Playwright's storage state lives) turns a race against a bank's
  // lockout counter into a resume.
  "session-set"({ flags }) {
    const id = pid(flags); const s = loadState(id);
    const role = flags.role ?? die("need --role (e.g. anon, retail-user, broker, admin)");
    s.sessions = s.sessions ?? {};
    const prev = s.sessions[role] ?? {};
    s.sessions[role] = {
      role, account: flags.account ?? prev.account ?? "",
      recipe: flags.recipe ?? prev.recipe ?? "",          // path to the written recipe, or the steps inline
      storageState: flags["storage-state"] ?? prev.storageState ?? "",  // Playwright storage_state json
      verifiedAt: flags.verified ?? now(),                // when a login last actually succeeded
      landedOn: flags["landed-on"] ?? prev.landedOn ?? "",
      failedAttempts: flags["failed-attempts"] !== undefined ? Number(flags["failed-attempts"]) : (prev.failedAttempts ?? 0),
      lockoutLimit: flags["lockout-limit"] !== undefined ? Number(flags["lockout-limit"]) : (prev.lockoutLimit ?? null),
      notes: flags.notes ?? prev.notes ?? "",
    };
    event(s, `session recorded for role "${role}"${flags.account ? ` (${flags.account})` : ""}`);
    saveState(id, s); out(s.sessions[role]);
  },
  // Records a failed login WITHOUT touching the recipe, and shouts before the
  // engagement locks a client's test account.
  "session-fail"({ flags }) {
    const id = pid(flags); const s = loadState(id);
    const role = flags.role ?? die("need --role");
    s.sessions = s.sessions ?? {};
    const sess = s.sessions[role] ?? { role, failedAttempts: 0, lockoutLimit: null };
    sess.failedAttempts = (sess.failedAttempts ?? 0) + 1;
    sess.lastFailure = flags.why ?? "(no reason recorded — screenshot it and say what you saw)";
    sess.lastFailureAt = now();
    s.sessions[role] = sess;
    event(s, `login FAILED for role "${role}" (${sess.failedAttempts} total): ${sess.lastFailure}`);
    saveState(id, s);
    const left = sess.lockoutLimit === null ? null : sess.lockoutLimit - sess.failedAttempts;
    out({ role, failedAttempts: sess.failedAttempts, attemptsLeft: left });
    // TWO IS THE CAP. A third attempt is what locks the account, and a locked
    // account stops every dependent task in the engagement — so this exits
    // non-zero rather than trusting a tired agent to remember a rule. The
    // failure is already recorded; the non-zero exit is the "stop now" signal.
    const cap = Number(flags["max-attempts"] ?? 2);
    if (sess.failedAttempts >= cap) {
      process.stderr.write(
        `[session] STOP — role "${role}" has failed ${sess.failedAttempts} time(s)${left === null ? "" : `, ${left} left before lockout`}.\n` +
        `Do NOT retry. Diagnose from the screenshot against the failure-signature table in the pack:\n` +
        `  · empty password field  -> the form cleared between typing and the click\n` +
        `  · "session timed out"   -> too slow, the IdP execution token expired\n` +
        `  · 400 at another step   -> a later stage is broken, the credentials are fine\n` +
        `  · a CAPTCHA appeared    -> escalate; submitting past it blind is what locks accounts\n` +
        `Record what you found, then block the task for the operator.\n`);
      process.exitCode = 1;
    }
  },
  "session-get"({ flags }) {
    const s = loadState(pid(flags));
    const all = s.sessions ?? {};
    const one = flags.role ? all[flags.role] : null;
    if (flags.role && !one) return out(`no session recorded for role "${flags.role}" — log in, then record it with session-set`);
    const age = (x) => x?.verifiedAt ? Math.round((Date.now() - new Date(x.verifiedAt).getTime()) / 60000) : null;
    // >= so `--max-age 0` means "treat everything as stale, re-verify now"
    const stamp = (x) => ({ ...x, ageMinutes: age(x), stale: age(x) === null || age(x) >= Number(flags["max-age"] ?? 60) });
    out(one ? stamp(one) : Object.fromEntries(Object.entries(all).map(([k, v]) => [k, stamp(v)])));
  },

  // Chain lineage: show each validated finding and what it chained from/into.
  "chains"({ flags }) {
    const s = loadState(pid(flags));
    const v = (s.findings ?? []).filter((f) => f.status === "validated");
    out(v.map((f) => ({ id: f.id, title: f.title, severity: f.severity, depth: f.chainDepth, from: f.parents, into: v.filter((x) => (x.parents ?? []).includes(f.id)).map((x) => x.id) })));
  },
  "finding-list"({ flags }) {
    const s = loadState(pid(flags));
    let fs = s.findings ?? [];
    if (flags.status) fs = fs.filter((f) => f.status === flags.status);
    out(fs);
  },
  async "finding-set"({ flags, pos }) {
    const id = pid(flags); const s = loadState(id);
    const f = (s.findings ?? []).find((x) => x.id === Number(pos[0]));
    if (!f) return out("not found");
    pocGate(id, s, { ...f, ...flags });
    for (const k of ["status", "severity", "cvss", "evidence", "notes", "category"]) if (flags[k] !== undefined) f[k] = flags[k];
    saveState(id, s);
    await recordFinding(id, s, f);   // candidate → validated must reach the graph too
    out(f);
  },

  "task-add"({ flags }) {
    const id = pid(flags); const s = loadState(id);
    const t = addTask(s, { phase: flags.phase, phaseName: flags.phaseName ?? flags["phase-name"], category: flags.category, priority: flags.priority, title: flags.title, ac: splitList(flags.ac), ng: splitList(flags.ng), deps: splitList(flags.deps), source: flags.source ?? "plan", notes: flags.notes, active: flags.active, target: flags.target, status: flags.status, files: splitList(flags.files),
      allowedPaths: splitList(flags.allow), forbiddenPaths: splitList(flags.forbid), controlCategory: flags["control-category"],
      verify: flags["verify-json"] !== undefined ? parseVerifyJson(flags["verify-json"]) : parseVerify(flags.verify) });
    saveState(id, s); out(t.id.toString());
  },
  "task-list"({ flags }) {
    const s = loadState(pid(flags));
    out(flags.status ? s.tasks.filter((t) => t.status === flags.status) : s.tasks);
  },
  "task-get"({ flags, pos }) {
    const s = loadState(pid(flags));
    out(s.tasks.find((t) => t.id === Number(pos[0])) ?? "not found");
  },
  async "task-set"({ flags, pos }) {
    const id = pid(flags); const s = loadState(id);
    const t = s.tasks.find((x) => x.id === Number(pos[0]));
    if (!t) return out("not found");
    // "delivered" asserts that a commit exists on the remote and was verified
    // there. Nobody can assert that by typing it — not an operator, not a skill,
    // and certainly not a worker. Only the delivery controller sets it, and only
    // after independent remote verification.
    if (CONTROLLER_ONLY_STATUSES.has(flags.status))
      die(`"${flags.status}" is set by the delivery controller only — it means committed, pushed and verified on the remote.\n` +
          `  Deliver a VERIFIED run instead: node scripts/sch-deliver-run.mjs --project ${id} --run <RUN-id>\n` +
          `  (for a locally finished task the status you want is "merged")`);
    // A CANONICAL state is reached by a controlled transition, never by typing
    // its name. `task-set` speaks the legacy vocabulary and only that.
    if (flags.status !== undefined && !STATUSES.includes(flags.status))
      die(`"${flags.status}" is not a task status (${STATUSES.join(", ")}).\n` +
          `  If you meant a graph state, move it with an EVENT instead — the machine decides whether the move is legal:\n` +
          `  node scripts/state.mjs task-transition --project ${id} --task ${t.id} --event <release|requeue|block|need_decision|fail|cancel|supersede>`);
    // WHILE A SCHEDULER OWNS THIS PROJECT, HANDS OFF. The in-session loop and the
    // queue scheduler both move tasks; both moving the same task at the same time
    // is how a task gets "merged" out from under a delivery that is mid-push.
    if (flags.status !== undefined) {
      const held = await schedulerHolding(id);
      if (held && !(flags.force === "true"))
        die(`scheduler ${held.scheduler_id} is running this project (pid ${held.pid}, lease expires ${held.expires_at}).\n` +
            `  It owns task state while it runs. Stop it first, or pass --force if you are certain it is dead:\n` +
            `  node scripts/state.mjs scheduler-cancel --project ${id} --scheduler ${held.scheduler_id}`);
    }
    // HARD GATE (smart): a UI/design task cannot complete unless AT LEAST ONE of
    // the project's chosen design skills was actually invoked (transcript-verified,
    // unfakeable). Only fires on design tasks — backend/recon/etc are never blocked.
    // The loop picks the best-fit skill per task; it need not use all of them.
    if (flags.status === "merged" && !(flags.force === "true")) {
      const req = getProject(id)?.requiredSkills ?? [];
      if (req.length && isDesignTask(t)) {
        const inv = invokedSkills(Date.now() - Number(flags.window ?? 120) * 60000);
        const used = req.filter((sk) => inv.has(sk) || inv.has(sk.split(":").pop()));
        if (!used.length) die(`MERGE BLOCKED — "${t.title}" is a UI/design task but none of your design skills were used (${req.join(", ")}). Use the best-fit one for this task, or pass --force with a reason if this task is genuinely not design work.`);
      }
    }
    if (flags.status === "merged" && flags.force === "true") event(s, `merge FORCED past skill gate: ${flags.note || "(no reason)"}`);
    // A BLOCKER IS A DEPENDENCY, NOT A NEW QUESTION.
    // Twelve tasks were once each set `blocked` carrying a copy of "waiting on
    // task 55", so the dashboard asked the operator the same thing twelve times
    // and answering one moved nothing. If the reason names another task, depend
    // on it instead: the task stays queued, asks nobody, and becomes ready the
    // moment the real blocker merges.
    // PROCEED ON YOUR OWN RECOMMENDATION. The operator handed over credentials
    // and a scope and expected the work to happen. A question they must answer
    // before anything moves is a stopped engagement; a question they can
    // OVERRULE later is a running one. So when the loop has a defensible
    // default, it takes it, says so, and keeps going — the operator sees the
    // decision on the dashboard and can change it, which requeues the task.
    if (flags.status === "blocked" && flags.assume) {
      askGate(t, flags);
      t.assumed = { choice: flags.assume, question: flags.brief ?? t.brief ?? flags.notes ?? "", at: now() };
      t.brief = flags.brief ?? t.brief;
      t.notes = `PROCEEDING ON MY OWN CALL: ${flags.assume}\n\nYou can change this any time — answering requeues the task with your decision.\n\n${flags.brief ?? t.brief ?? flags.notes ?? ""}`;
      // set the STATUS itself, not just the flag — this branch returns before
      // the flag-application loop below ever runs
      const TRx = await import("./transitions.mjs");
      TRx.stampLegacy(t, "queued", { reason: `proceeding on its own call: ${String(flags.assume).slice(0, 80)}` });
      t.priority = Math.min(t.priority ?? 3, 2); t.updatedAt = now();
      event(s, `task #${t.id} proceeding on its own call: ${String(flags.assume).slice(0, 60)}`);
      saveState(id, s); return out({ id: t.id, status: t.status, state: t.state, assumed: flags.assume });
    }
    if (flags.status === "blocked") {
      // dependency FIRST: a task waiting on another task is not a question at
      // all, so it must never be held to the question-quality gate below.
      const why = `${flags.notes ?? ""} ${flags.note ?? ""}`;
      const on = [...why.matchAll(/\b(?:task|#)\s*#?(\d+)/gi)].map((m) => Number(m[1]))
        .filter((n) => n !== t.id && s.tasks.some((x) => x.id === n && !DONE.has(x.status) && x.status !== "superseded"));
      if (on.length) {
        t.deps = [...new Set([...(t.deps ?? []), ...on])];
        flags.status = "queued";
        event(s, `task #${t.id} depends on #${on.join(",#")} instead of asking again`);
      } else {
        askGate(t, flags);   // still blocked ⇒ a person must read it, so it must be readable
      }
    }
    // THE STATUS WRITE GOES THROUGH THE CLOSED MACHINE. It is still the legacy
    // vocabulary and it still works, but it is now a recorded TRANSITION with an
    // actor, a state version and — when the machine would have refused the move —
    // that refusal written down beside it. A hand-driven queue leaves a trail
    // instead of a mystery.
    let stamped = null;
    if (flags.status !== undefined) {
      const TRx = await import("./transitions.mjs");
      stamped = TRx.stampLegacy(t, flags.status, { actor: flags.actor ?? "operator", reason: flags.note ?? flags.reason ?? "" });
      if (!stamped.ok) die(stamped.failure.message);
      if (stamped.transition)
        auditLog({ kind: "transition", project: id, task: String(t.id), ...stamped.transition });
    }
    for (const k of ["branch", "notes", "phase", "target", "priority", "category", "phaseName"]) if (flags[k] !== undefined) t[k] = (k === "phase" || k === "priority") ? Number(flags[k]) : flags[k];
    // the files this task touches — what locate-first found, so it is never
    // rediscovered and co-located tasks can be batched
    if (flags.files !== undefined) t.files = [...new Set([...(t.files ?? []), ...splitList(flags.files)])];
    // The run policy REPLACES rather than merges: a path policy you cannot
    // narrow is not a policy, and appending would only ever widen it.
    if (flags.allow !== undefined) t.allowedPaths = splitList(flags.allow);
    if (flags.forbid !== undefined) t.forbiddenPaths = splitList(flags.forbid);
    if (flags.verify !== undefined) t.verify = parseVerify(flags.verify);
    if (flags["verify-json"] !== undefined) t.verify = parseVerifyJson(flags["verify-json"]);
    // The one SCH control-state category this task may write, if any. Naming it
    // is a deliberate act; the default is that `.sch-loop/` is off limits.
    if (flags["control-category"] !== undefined) t.controlCategory = flags["control-category"] || null;
    // what the work actually cost. Without this "are tokens going down?" is
    // unanswerable, and every efficiency change is a guess.
    // Guard the arithmetic: Number("unknown") is NaN, and a NaN written here would
    // poison the cost data permanently while looking like a recorded value. A
    // non-numeric --tokens is left for the merge gate below to interpret.
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    if (flags.tokens !== undefined && num(flags.tokens) !== null) t.tokens = (t.tokens ?? 0) + num(flags.tokens);
    if (flags["tool-uses"] !== undefined && num(flags["tool-uses"]) !== null) t.toolUses = (t.toolUses ?? 0) + num(flags["tool-uses"]);
    // PER-SUBAGENT BREAKDOWN. One number per task hides where the money goes: a
    // task recorded at 95k looked like a cheap build, when in earlier passes the
    // builder and the reviewer together cost 126-205k and only the builder was
    // ever recorded. Each agent reports its own line, so "which agent is
    // expensive" becomes answerable instead of inferred.
    //   --agent builder --tokens 99016 --tool-uses 41
    //   --agent reviewer --tokens 64900 --tool-uses 17
    if (flags.agent && num(flags.tokens) !== null) {
      t.costs = [...(t.costs ?? []), {
        agent: flags.agent, tokens: num(flags.tokens),
        toolUses: num(flags["tool-uses"]) ?? 0, at: now(),
      }];
    }
    // record which installed skills this task dispatched to (visible on the dashboard)
    if (flags.skills !== undefined) t.skills = [...new Set([...(t.skills ?? []), ...splitList(flags.skills)])];
    // A TASK-LEVEL skill override outranks every project profile — it is the one
    // place that knows this particular task is not like its neighbours. It says
    // which skills to use, never which tools they get.
    for (const [flag, bucket] of [["skill-required", "required"], ["skill-recommended", "recommended"], ["skill-disabled", "disabled"]])
      if (flags[flag] !== undefined) {
        t.skillProfile = t.skillProfile ?? {};
        t.skillProfile[bucket] = splitList(flags[flag]);
      }
    // a status note (the "what it's doing" / the blocked question) sticks to the
    // task so the dashboard can surface it, not just log it as an event.
    // The planner's brief is ground truth and must survive status chatter.
    // `--note` was a destructive assignment, so claiming a task with
    // `--note claimed` deleted "FILES: frontend/src/.../ProfilePagesHeader.js |
    // VERIFY: ..." — the exact information the builder was about to need, thrown
    // away one line before it was needed. Keep the first note as the brief.
    if (flags.note !== undefined) {
      if (t.notes && !t.brief && !/^(claimed|building)\b/i.test(t.notes)) t.brief = t.notes;
      t.notes = flags.note;
    }
    // Time each task so the loop interval and lock TTL are set from measurement,
    // not from a guess. Clock starts when work actually begins (building) — not
    // at creation, which would just measure how long it sat in the queue.
    if (flags.status === "building" && !t.startedAt) t.startedAt = now();
    if (t.startedAt && (flags.status === "merged" || flags.status === "stuck")) {
      t.durationMs = Date.now() - new Date(t.startedAt).getTime();
    }

    // ATTACH GRAPH CONTEXT ON CLAIM — do not rely on the loop remembering to ask.
    //
    // The graph was wired up, the MCP tools were connected, the skill said to
    // query it first — and across a whole build the loop never made a single
    // call. Instructions get skipped; this is the third time that pattern has
    // cost real tokens (DECISION tasks unblocked, files unrecorded, now this).
    //
    // So the engine does it at the moment of claim: look the task up, write the
    // files into the task, and put the locations where the builder cannot miss
    // them. Fills `files` as a side effect, which is what clubbing needs too.
    if (flags.status === "building" && !(t.graphContext)) {
      try {
        const g = await import("./graph.mjs");
        const db = g.open(id);

        // READ WHAT THE PLANNER ALREADY WROTE before guessing. sch-plan is told
        // to name target files, and it does — "FILES: frontend/src/.../
        // ProfilePagesHeader.js" sat in the notes while a search for the task
        // TITLE returned two unrelated test files. Explicit beats inferred every
        // time; search is only for tasks that never named anything.
        // A planner writes globs as readily as literal paths — "FILES:
        // frontend/src/static/js/pages/Profile*.js" — so accept the star and
        // resolve it against the files the graph actually knows. Without this the
        // extraction silently failed and fell back to searching the title, which
        // returned unrelated tests and then attached the wrong build ritual.
        const said = [...[t.brief ?? "", t.notes ?? "", ...(t.ac ?? [])].join(" ")
          .matchAll(/\b([\w.-]+\/[\w./*-]+\.\w{1,5})\b/g)].map((m) => m[1]);
        const named = [];
        for (const p of new Set(said)) {
          if (!p.includes("*")) { named.push(p); continue; }
          const re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
          const matched = db.prepare("SELECT path FROM node WHERE kind='file' AND path IS NOT NULL").all()
            .map((r) => r.path).filter((f) => re.test(f));
          named.push(...matched.slice(0, 8));
        }

        const hits = named.length
          ? named.flatMap((p) => g.search(db, p, { limit: 2 })).slice(0, 6)
          : g.search(db, [t.title, ...(t.ac ?? [])].join(" ").slice(0, 300), { limit: 6 });
        if (named.length) t.files = [...new Set([...(t.files ?? []), ...named])];
        g.logQuery(db, { source: "engine", tool: "claim-context", q: t.title.slice(0, 60), hits: hits.length, ms: 0 });
        db.close();
        if (hits.length) {
          t.files = [...new Set([...(t.files ?? []), ...hits.map((h) => h.path).filter(Boolean)])];
          t.graphContext = hits.map((h) =>
            `${h.kind} ${h.name}${h.path ? ` — ${h.path}${h.line ? ":" + h.line : ""}` : ""}`);
          event(s, `graph context attached to #${t.id} (${hits.length} hits)`);
        }

        // THE RITUAL. Measured on a live pass: a 25-line source edit cost 120k
        // tokens and 50 tool uses, and the discovery was not the expensive part —
        // working out that the SPA must be rebuilt, the bundle copied, the
        // cache-buster bumped across 27 templates and gunicorn restarted was.
        // The project knows those commands; the builder should never derive them.
        const rituals = (getProject(id)?.rituals ?? [])
          .filter((r) => (t.files ?? []).some((f) => { try { return new RegExp(r.when).test(f); } catch { return false; } }));
        if (rituals.length) {
          t.ritual = rituals.map((r) => (r.why ? `${r.do}    # ${r.why}` : r.do));
          event(s, `ritual attached to #${t.id} (${rituals.length} step(s))`);
        }
      } catch { /* no graph yet — the task simply starts without it */ }
    }
    // COST IS NOT OPTIONAL. Unlike graph context, the engine cannot supply this —
    // only the loop sees what a subagent spent. Asking nicely produced 6 records
    // out of 121 tasks, so "are tokens going down?" stayed unanswerable and every
    // efficiency claim stayed an opinion. A merge without a cost is now refused.
    // `--tokens unknown` is allowed and recorded as unmeasured, so honesty is
    // always available and silence never is.
    if (flags.status === "merged" && t.startedAt && t.tokens === undefined && flags.force !== "true") {
      if (flags.tokens === undefined)
        die(`REFUSED: task #${t.id} was built by a subagent, so record what it cost before merging.\n` +
            `  node scripts/state.mjs task-set --project ${id} ${t.id} --status merged --tokens <n> --tool-uses <n>\n` +
            `  (the agent reports both on return; pass --tokens unknown if it genuinely did not)`);
      if (String(flags.tokens).toLowerCase() === "unknown") { t.tokens = 0; t.tokensUnmeasured = true; }
    }
    // --- graph metadata -------------------------------------------------------
    // WHY this task waits for that one. Written as `--dep-reason "8:DATA_DEPENDENCY:api_contract"`,
    // repeatable with `|`. Recorded per edge and REPLACED, never merged: a reason
    // you cannot correct is not a reason.
    if (flags["dep-reason"] !== undefined) {
      const TG = await import("./taskgraph.mjs");
      const parsed = splitList(flags["dep-reason"]).map((spec) => {
        const [from, type, ...rest] = String(spec).split(":");
        return { from: Number(from), type: String(type ?? "").toUpperCase(), consumes: rest.join(":").trim(), note: "" };
      });
      const badType = parsed.find((r) => r.type && !TG.DEPENDENCY_TYPES.includes(r.type));
      if (badType) die(`"${badType.type}" is not a dependency type — one of: ${TG.DEPENDENCY_TYPES.join(", ")}`);
      const badFrom = parsed.find((r) => !Number.isInteger(r.from));
      if (badFrom) die(`--dep-reason expects "<upstream-task-id>:<TYPE>:<what it consumes>"`);
      t.depMeta = parsed;
      // Naming a reason for an edge that does not exist is a typo, not a graph
      // edit — say so rather than silently recording a reason nothing uses.
      const orphan = parsed.map((r) => r.from).filter((f) => !(t.deps ?? []).map(Number).includes(f));
      if (orphan.length) die(`task #${t.id} does not depend on #${orphan.join(", #")} — add the dependency first (--deps), then give it a reason`);
    }
    for (const [flag, field] of [["retry-policy", "retryPolicy"], ["approval-policy", "approvalPolicy"],
                                 ["budgets", "budgets"], ["dependency-policy", "dependencyPolicy"]])
      if (flags[flag] !== undefined) {
        try { t[field] = flags[flag] === "" ? null : JSON.parse(flags[flag]); }
        catch (e) { die(`--${flag} must be JSON: ${e.message}`); }
      }
    // WHICH WORKFLOW this task runs. `--workflow PLAN_BUILD_TEST` or
    // `--workflow PLAN_BUILD_TEST@1` to pin the version. Validated against the
    // closed registry now, so a typo is caught at planning time rather than by
    // the scheduler halfway through a queue.
    if (flags.workflow !== undefined) {
      const WFx = await import("./workflows.mjs");
      if (!flags.workflow) t.workflow = null;
      else {
        const [tpl, ver] = String(flags.workflow).split("@");
        const def = WFx.TEMPLATES[tpl];
        if (!def) die(`"${tpl}" is not a workflow template — one of: ${WFx.TEMPLATE_IDS.join(", ")}`);
        if (ver !== undefined && Number(ver) !== def.version)
          die(`template "${tpl}" is at version ${def.version}; version ${ver} does not exist`);
        const check = WFx.validateTemplate(def, { taskType: t.category || null, task: t });
        if (!check.ok) die(`template "${tpl}" cannot run task #${t.id}: ${check.problems[0].message}`);
        t.workflow = { template: tpl, version: def.version };
      }
    }
    for (const [flag, field] of [["executor-role", "executorRole"], ["verifier-role", "verifierRole"]])
      if (flags[flag] !== undefined) {
        const PHx = await import("./phases.mjs");
        if (flags[flag] && !PHx.ROLES[flags[flag]]) die(`"${flags[flag]}" is not an agent role — one of: ${Object.keys(PHx.ROLES).join(", ")}`);
        t[field] = flags[flag] || null;
      }

    // a finished task is no longer what the loop is doing — stale activity is
    // what made the dashboard say "building #96" for minutes after it merged
    if (CLOSED.has(t.status) && s.run?.activity) delete s.run.activity;
    t.updatedAt = now();
    event(s, `task #${t.id} -> ${t.status}${stamped?.state ? ` [${stamped.state}]` : ""}${flags.note ? " (" + flags.note + ")" : ""}`);
    saveState(id, s); out(t);
  },
  // What the loop is doing RIGHT NOW, including work that is not a task.
  //
  // A pass spent 12 minutes on a planning subagent while the dashboard showed
  // "WAITING — no task building", because only tasks in `building` were visible.
  // Planning, reviewing, indexing and answering are all real work and all
  // invisible under that rule. The loop announces each phase here instead.
  //
  //   state.mjs activity --project <id> --doing "planning inbox #8 (PRD gap analysis)"
  //   state.mjs activity --project <id> --clear
  activity({ flags }) {
    const id = pid(flags); const s = loadState(id);
    s.run = s.run ?? {};
    if (flags.clear === "true" || flags.clear === "") { delete s.run.activity; }
    else if (flags.doing) s.run.activity = { what: flags.doing, since: now() };
    saveState(id, s);
    out(s.run.activity ?? "idle");
  },
  // A spend cap the loop cannot talk its way past.
  //
  // 122 tasks in one day consumed roughly half a weekly Max allowance. The loop
  // has no idea what it is spending — it will happily keep going until the plan
  // is exhausted on a Tuesday. This gives it a number and stops it at that
  // number, which is the difference between a budget and a hope.
  //
  //   state.mjs budget --project p --daily 1500000     # tokens/day, 0 = off
  //   state.mjs budget --project p                     # today's spend vs the cap
  budget({ flags }) {
    const id = pid(flags);
    if (flags.daily !== undefined) {
      const r = loadRegistry(); const p = r.projects.find((x) => x.id === id);
      if (!p) die("no such project");
      p.dailyTokenBudget = Number(flags.daily) || 0;
      saveRegistry(r);
    }
    out(budgetStatus(id));
  },
  "interval-advice"({ flags }) { out(suggestInterval(loadState(pid(flags)))); },
  // Per-project build rituals: the exact commands a change to certain files
  // requires, so a builder never derives them again.
  //
  //   state.mjs ritual-add --project p --when "^frontend/src/" \
  //     --do "cd frontend && npm run dist" --why "a source edit is a no-op without it"
  //   state.mjs ritual-list --project p
  "ritual-add"({ flags }) {
    const r = loadRegistry(); const p = r.projects.find((x) => x.id === pid(flags));
    if (!p) die("no such project");
    p.rituals = [...(p.rituals ?? []), { when: flags.when, do: flags.do, why: flags.why ?? "" }];
    saveRegistry(r); out(p.rituals);
  },
  "ritual-list"({ flags }) { out(getProject(pid(flags))?.rituals ?? []); },
  "ritual-clear"({ flags }) {
    const r = loadRegistry(); const p = r.projects.find((x) => x.id === pid(flags));
    if (p) { p.rituals = []; saveRegistry(r); } out("cleared");
  },
  // Which other READY tasks sit on the same files as this one?
  //
  // Two tasks on the same files pay for the same ground truth twice: the same
  // reads, the same call-graph, the same test setup — often the largest single
  // cost in a pass. Handing them to ONE subagent pays it once. They stay separate
  // tasks with their own acceptance criteria and their own commit; only the
  // discovery is shared.
  //
  // This is the mirror image of the parallel wave, which requires DISJOINT files
  // so three agents never collide. Overlapping → one agent, sequentially.
  // Disjoint → separate agents, in parallel.
  async "task-batch"({ flags, pos }) {
    const project = pid(flags);
    const s = loadState(project);
    const id = Number(flags.with ?? pos[0]);
    const lead = s.tasks.find((t) => t.id === id);
    if (!lead) return out("no such task");
    const norm = (f) => String(f).replace(/\\/g, "/").trim().toLowerCase();

    // Where a task will land, without the loop having to remember to say so.
    //
    // Recording files was an instruction, and instructions get skipped: two of a
    // hundred and seventeen tasks had them, so batching never fired. The graph
    // already knows every file and symbol, so ask it what this task's own words
    // point at. Inference is used only to GROUP tasks; the builder still grounds
    // itself in the real code before editing anything.
    let infer = async () => [];
    try {
      const g = await import("./graph.mjs");
      const db = g.open(project);
      infer = async (t) => {
        if ((t.files ?? []).length) return t.files;
        const q = [t.title, ...(t.ac ?? [])].join(" ").slice(0, 300);
        return [...new Set(g.search(db, q, { limit: 8 }).map((h) => h.path).filter(Boolean))];
      };
    } catch { /* no graph yet — fall back to recorded files only */ }

    const leadFiles = await infer(lead);
    const mine = new Set(leadFiles.map(norm));

    // The strongest co-location signal is already in the data and needs no
    // guessing: the planner put these tasks in the same phase and category
    // because they are the same slice of the product. File overlap is the
    // confirmation, not the primary test — inferring files from a task title is
    // fuzzy ("Showcase promotion workflow" matched auditlog/tests.py), and a
    // wrong guess there would club unrelated work.
    const sameSlice = (t) =>
      lead.phaseName && t.phaseName === lead.phaseName && t.category === lead.category;
    const cap = Number(flags.cap ?? 3);
    const batch = s.tasks.filter((t) => {
      if (t.id === id || t.status !== "queued") return false;
      if (!depsMet(s, t)) return false;                             // deps unmet
      if ((t.deps ?? []).map(Number).includes(id)) return false;    // depends on the lead: must not run beside it
      if (t.active || lead.active) return false;                    // never batch offensive active work
      // Shared FILES are the point — that is the ground truth being paid for
      // twice. Phase alone is too loose: "UI-6b forum topic" and "UI-11b manage
      // tables" sit in the same phase and share nothing, and clubbing them would
      // hand one subagent two unrelated jobs. Phase only decides it when neither
      // task has known files, where it is the best signal available.
      const theirs = (t.files ?? []).map(norm);
      if (theirs.length) return theirs.some((f) => mine.has(f));
      return sameSlice(t) && mine.size === 0;
    }).sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || a.id - b.id).slice(0, cap - 1);
    out({
      lead: id, leadPhase: lead.phaseName ? `${lead.category} › ${lead.phaseName}` : null,
      leadFiles: [...mine],
      batch: batch.map((t) => ({
        id: t.id, title: t.title,
        why: sameSlice(t) ? "same phase" : "shares files",
        shared: (t.files ?? []).filter((f) => mine.has(norm(f))),
      })),
      note: batch.length ? "one subagent, one shared ground truth, each task keeps its own AC and its own commit"
                         : "nothing co-located — run the lead task alone",
    });
  },
  // "How long do tasks actually take?" — the only honest basis for choosing the
  // loop interval and the lock TTL. Reports the measured distribution.
  timing({ flags }) {
    const s = loadState(pid(flags));
    const d = s.tasks.filter((t) => t.durationMs > 0).map((t) => t.durationMs).sort((a, b) => a - b);
    if (!d.length) return out({ measured: 0, note: "no completed task has been timed yet — run a few passes" });
    const at = (q) => Math.round(d[Math.min(d.length - 1, Math.floor(d.length * q))] / 60000);
    const p95 = at(0.95);
    // Is it actually getting cheaper? Compare the oldest half against the newest
    // half, in completion order — the only honest way to see whether an
    // efficiency change worked rather than asserting that it did.
    const costed = s.tasks.filter((t) => t.tokens > 0)
      .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
    let trend = "no token data yet — record it with task-set --tokens/--tool-uses";
    if (costed.length >= 4) {
      const half = Math.floor(costed.length / 2);
      const avg = (xs) => Math.round(xs.reduce((n, t) => n + t.tokens, 0) / xs.length);
      const older = avg(costed.slice(0, half)), newer = avg(costed.slice(half));
      const pct = Math.round((newer - older) / older * 100);
      trend = `${costed.length} costed tasks · first half avg ${(older / 1000).toFixed(0)}k → recent half ${(newer / 1000).toFixed(0)}k (${pct >= 0 ? "+" : ""}${pct}%)`;
    } else if (costed.length) {
      trend = `${costed.length} costed task(s), avg ${(costed.reduce((n, t) => n + t.tokens, 0) / costed.length / 1000).toFixed(0)}k — need 4+ for a trend`;
    }
    // where the tokens actually go, by agent role
    const byAgent = {};
    for (const t of s.tasks) for (const c of t.costs ?? []) {
      const a = (byAgent[c.agent] ??= { runs: 0, tokens: 0, toolUses: 0 });
      a.runs++; a.tokens += c.tokens; a.toolUses += c.toolUses;
    }
    const agents = Object.entries(byAgent)
      .sort((x, y) => y[1].tokens - x[1].tokens)
      .map(([a, v]) => `${a}: ${v.runs} run(s), avg ${(v.tokens / v.runs / 1000).toFixed(0)}k, ${Math.round(v.toolUses / v.runs)} tool uses`);

    out({
      measured: d.length,
      medianMin: at(0.5), p95Min: p95, maxMin: Math.round(d[d.length - 1] / 60000),
      tokenTrend: trend,
      byAgent: agents.length ? agents : "no per-agent costs yet — pass --agent <role> with --tokens",
      // TTL must cover the slow tail, or a still-running pass looks stale and a
      // second pass takes the lock on top of it. Interval is a separate question:
      // it is how fast you want NEW work picked up, not how long a task takes.
      suggestedLockTtlMin: Math.max(15, Math.ceil(p95 * 1.5 / 5) * 5),
    });
  },
  "task-next"({ flags }) { out(nextReady(loadState(pid(flags))) ?? "none"); },
  // Answer a blocked task's question → records the answer and returns it to the
  // queue at high priority so the next pass picks it up with the decision in hand.
  "task-answer"({ flags, pos }) {
    const id = pid(flags); const s = loadState(id);
    const t = s.tasks.find((x) => x.id === Number(pos[0] ?? flags.task));
    if (!t) return out("not found");
    const text = (flags.text ?? pos.slice(1).join(" ")).trim();
    if (!text) return out("need answer text");
    if (!t.question) t.question = t.notes ?? "";   // keep the question; the answer must not erase it
    t.answers = [...(t.answers ?? []), { text, ts: now() }];
    t.notes = "ANSWERED: " + text + (t.question ? "\n\nQUESTION ASKED: " + t.question : "");
    t.status = "queued"; t.priority = 1; t.updatedAt = now();
    event(s, `task #${t.id} answered by operator -> requeued (p1): ${text.slice(0, 80)}`);
    saveState(id, s); out(t);
  },

  "inbox-add"({ flags, pos }) {
    const id = pid(flags); const s = loadState(id);
    const item = { id: ++s.seq.inbox, text: flags.text ?? pos.join(" "), status: "new", createdAt: now() };
    s.inbox.unshift(item); event(s, `inbox +: ${item.text.slice(0, 60)}`); saveState(id, s); out(item.id.toString());
  },
  "inbox-list"({ flags }) {
    const s = loadState(pid(flags));
    out(flags.new !== undefined ? s.inbox.filter((i) => i.status === "new") : s.inbox);
  },
  "inbox-mark"({ flags, pos }) {
    const id = pid(flags); const s = loadState(id);
    const item = s.inbox.find((i) => i.id === Number(pos[0]));
    if (!item) return out("not found");
    item.status = "processed"; saveState(id, s); out(item);
  },
  "event-add"({ flags, pos }) { const id = pid(flags); const s = loadState(id); event(s, flags.text ?? pos.join(" ")); saveState(id, s); out("ok"); },

  stats({ flags }) {
    const p = getProject(pid(flags)); const s = loadState(pid(flags));
    const by = {}; for (const st of STATUSES) by[st] = 0;
    for (const t of s.tasks) by[t.status]++;
    out({ project: p?.name, domain: p?.domain, offensive: OFFENSIVE.has(p?.domain), authorized: p?.scope?.authorized ?? false, expiry: p?.scope?.expiry || "", client: p?.scope?.client || "", tasks: s.tasks.length, byStatus: by, findings: (s.findings ?? []).length, inboxNew: s.inbox.filter((i) => i.status === "new").length });
  },
  // ---- skill registry + capability profile (see scripts/skills.mjs) --------
  //
  // Discovery is READ-ONLY and executes nothing: it reads SKILL.md text, parses
  // the frontmatter, hashes the body. A skill is never imported, never spawned,
  // and a script its metadata names is never followed.
  "skill-discover"({ flags }) {
    const r = SK.refresh({ repo: flags.repo ?? process.cwd(), global: flags.global !== "false" });
    out({ discoveredAt: r.discoveredAt, roots: r.roots, found: r.skills.length, warnings: r.warnings });
  },
  "skill-list"({ flags }) {
    const reg = SK.registry({ repo: flags.repo ?? process.cwd(), global: flags.global !== "false" });
    let rows = reg.skills ?? [];
    if (flags.trust) rows = rows.filter((s) => s.trust === flags.trust);
    if (flags.source) rows = rows.filter((s) => s.source_kind === flags.source);
    if (flags.capability) rows = rows.filter((s) => (s.capabilities ?? []).includes(flags.capability));
    if (flags["task-type"]) rows = rows.filter((s) => (s.task_types ?? []).includes(flags["task-type"]));
    out(flags.full === "true" ? rows : rows.map((s) => ({
      id: s.id, trust: s.trust + (s.stale_approval ? " (stale approval)" : ""),
      source: s.source_kind, capabilities: s.capabilities, complete: s.capabilities_complete,
    })));
  },
  "skill-get"({ flags, pos }) {
    const reg = SK.registry({ repo: flags.repo ?? process.cwd(), global: flags.global !== "false" });
    out(SK.findSkill(reg, flags.id ?? pos[0]) ?? "not found");
  },
  // Trust is a human decision. Discovery never promotes anything, and an
  // approval is recorded against the exact content hash it was given to — edit
  // the skill and the approval stops applying.
  "skill-trust"({ flags, pos }) {
    const id = flags.id ?? pos[0] ?? die("need a skill id");
    const state = flags.state ?? pos[1] ?? die(`need --state (${SK.SETTABLE_TRUST.join(" | ")})`);
    try { out(SK.setTrust(id, state, { why: flags.why ?? "" })); } catch (e) { die(e.message); }
  },
  "profile-get"({ flags }) { out(SK.readProfile(getProject(pid(flags)))); },
  // Every write validates first and refuses rather than persisting nonsense.
  "profile-set"({ flags }) {
    const r = loadRegistry(); const p = r.projects.find((x) => x.id === pid(flags));
    if (!p) die("no such project");
    const prof = SK.readProfile(p);
    const changes = [];
    if (flags.mode !== undefined) {
      if (!SK.EXECUTION_MODES.includes(flags.mode))
        die(`invalid --mode "${flags.mode}" — use one of: ${SK.EXECUTION_MODES.join(", ")}`);
      if (prof.execution_mode !== "PAUSED") prof.previous_execution_mode = prof.execution_mode;
      prof.execution_mode = flags.mode;
      changes.push(`execution mode -> ${flags.mode}`);
    }
    if (flags.resume === "true") {
      prof.execution_mode = SK.EXECUTION_MODES.includes(prof.previous_execution_mode) && prof.previous_execution_mode !== "PAUSED"
        ? prof.previous_execution_mode : "SINGLE_TASK";
      changes.push(`resumed -> ${prof.execution_mode}`);
    }
    if (flags["default-skills"] !== undefined || flags["disable-defaults"] !== undefined) {
      const on = splitList(flags["default-skills"]).map((skill_id) => ({ skill_id, enabled: true }));
      const off = splitList(flags["disable-defaults"]).map((skill_id) => ({ skill_id, enabled: false }));
      const merged = new Map((prof.default_skills ?? []).map((d) => [d.skill_id, d]));
      for (const d of [...on, ...off]) merged.set(d.skill_id, d);
      prof.default_skills = [...merged.values()];
      changes.push(`default skills: ${prof.default_skills.map((d) => (d.enabled === false ? "-" : "+") + d.skill_id).join(" ") || "(none)"}`);
    }
    const layerKey = flags["task-type"] ? ["task_type_profiles", flags["task-type"]]
      : flags.phase !== undefined ? ["phase_profiles", String(flags.phase)] : null;
    if (layerKey) {
      const [table, name] = layerKey;
      const layer = { ...(prof[table]?.[name] ?? {}) };
      for (const [flag, bucket] of [["recommended", "recommended"], ["required", "required"], ["disabled", "disabled"]])
        if (flags[flag] !== undefined) layer[bucket] = splitList(flags[flag]);
      prof[table] = { ...(prof[table] ?? {}), [name]: layer };
      changes.push(`${table === "phase_profiles" ? "phase" : "task-type"} profile "${name}" updated`);
    }
    for (const [flag, key] of [["require-approval-on-hash-change", "require_skill_approval_on_hash_change"],
      ["allow-unreviewed", "allow_unreviewed_skills_during_autonomous_run"]])
      if (flags[flag] !== undefined) { prof.approval[key] = flags[flag] === "true"; changes.push(`${key} = ${prof.approval[key]}`); }

    const reg = SK.registry({ repo: p.path || process.cwd(), global: flags.global !== "false" });
    const problems = SK.validateProfile(prof, reg);
    // A profile that names a blocked skill or an unapproved required skill is not
    // saved — it would be a run permission nobody granted.
    const blocking = problems.filter((x) => /BLOCKED|requires|invalid execution_mode|malformed|must be a list/.test(x));
    if (blocking.length && flags.force !== "true")
      die("profile REFUSED:\n  " + blocking.join("\n  ") + "\n(fix these, or pass --force to save anyway)");
    p.capabilities = prof;
    saveRegistry(r);
    const s = loadState(p.id); event(s, `capability profile: ${changes.join("; ") || "(no change)"}`); saveState(p.id, s);
    out({ project: p.id, changes, profile: prof, warnings: problems });
  },
  "profile-validate"({ flags }) {
    const p = getProject(pid(flags));
    const prof = SK.readProfile(p);
    const reg = SK.registry({ repo: p?.path || process.cwd(), global: flags.global !== "false" });
    const problems = SK.validateProfile(prof, reg);
    out({ project: p?.id, execution_mode: prof.execution_mode, eligibility: SK.runEligibility(prof), problems, ok: problems.length === 0 });
  },
  // Which skills for THIS task, and why. Deterministic; loads no skill body.
  "skill-recommend"({ flags, pos }) {
    const id = pid(flags); const p = getProject(id);
    const prof = SK.readProfile(p);
    const reg = SK.registry({ repo: p?.path || process.cwd(), global: flags.global !== "false" });
    let taskType = flags.type ?? null, phase = flags.phase ?? null, files = splitList(flags.files), overrides = null;
    const tid = Number(flags.task ?? pos[0]);
    if (Number.isFinite(tid) && tid > 0) {
      const t = loadState(id).tasks.find((x) => x.id === tid);
      if (!t) die(`no task #${tid} in ${id}`);
      taskType = taskType ?? t.category ?? null;
      phase = phase ?? t.phase;
      files = files.length ? files : (t.files ?? []);
      overrides = t.skillProfile ?? null;
    }
    out(SK.recommend({
      profile: prof, reg, taskType: taskType || null, phase, files, overrides,
      autonomous: flags.autonomous !== "false",
    }));
  },
  // The one /SCH command table — the router skill, the CLI and the dashboard all
  // read this, so what they say about a command cannot drift apart.
  "sch-commands"({ flags, pos }) {
    const name = flags.name ?? pos[0];
    if (!name) return out(SK.SCH_COMMANDS);
    const c = SK.resolveCommand(name);
    out(c ?? { error: `unknown /SCH command "${name}"`, available: SK.SCH_COMMANDS.map((x) => x.name) });
  },

  // ---- the per-project `.sch-loop/` workspace ------------------------------
  // Explicit and idempotent. A run REQUIRES an initialized workspace and will
  // not create one for you: silently initializing a repository immediately
  // before writing to it is how a runner ends up creating a workspace in the
  // wrong folder and calling it success.
  async "workspace-init"({ flags }) {
    const id = pid(flags); const p = getProject(id);
    if (!p) die("no such project: " + id);
    const WS = await import("./workspace.mjs");
    let r;
    try { r = WS.initWorkspace({ projectId: id, repoPath: flags.path ?? p.path }); }
    catch (e) { die(`${e.code ?? "WORKSPACE_INVALID"} — ${e.message}`); }
    const s = loadState(id);
    event(s, `workspace ${r.created ? "initialized" : "revalidated"} at ${WS.WORKSPACE}/${r.ignore.changed ? " (+ runtime ignore rules)" : ""}`);
    saveState(id, s);
    if (r.ignore.overBroad)
      process.stderr.write(`[workspace] warning: .gitignore ignores ALL of ${WS.WORKSPACE}/ — the durable project record (project.yaml, SPEC, PLAN, decisions, handoffs) is meant to be trackable. Narrow that rule.\n`);
    out({ workspace: r.dir, repository_root: r.root, created: r.created, manifest: r.manifest, ignore: r.ignore,
      next: "commit .sch-loop/project.yaml and the .gitignore rules — a run requires a clean working tree" });
  },
  async "workspace-status"({ flags }) {
    const id = pid(flags); const p = getProject(id);
    if (!p) die("no such project: " + id);
    const WS = await import("./workspace.mjs");
    out(WS.validateWorkspace({ projectId: id, repoPath: flags.path ?? p.path }));
  },

  // ---- external single-task runs -------------------------------------------
  // Reads only. Starting a run is `scripts/sch-run-task.mjs` — a separate
  // entry point on purpose, so nothing in the normal CLI surface can launch a
  // worker process as a side effect of a status query.
  async "run-list"({ flags }) {
    const R = await import("./runner.mjs");
    out(R.runProjection(pid(flags), { limit: Number(flags.limit ?? 10) }));
  },
  async "run-get"({ flags, pos }) {
    const R = await import("./runner.mjs");
    const runId = flags.run ?? pos[0] ?? die("need --run <RUN-id>");
    try {
      const r = R.readRun(pid(flags), runId);
      // stdout/stderr stay on disk: they are unbounded and may contain anything.
      out({ ...r, stdout: r.stdout === null ? null : `[${r.stdout.length} chars in ${r.dir}/stdout.log]`,
                  stderr: r.stderr === null ? null : `[${r.stderr.length} chars in ${r.dir}/stderr.log]` });
    } catch (e) { die(e.message); }
  },
  async "run-cancel"({ flags, pos }) {
    const id = pid(flags); const p = getProject(id);
    if (!p) die("no such project: " + id);
    const [WS, R] = [await import("./workspace.mjs"), await import("./runner.mjs")];
    const runId = flags.run ?? pos[0] ?? die("need --run <RUN-id>");
    try {
      const wsDir = WS.resolveWorkspaceDir(WS.repositoryRoot(p.path) ?? p.path, { mustExist: true });
      const r = R.cancelRun(wsDir, runId, flags.reason ?? "operator cancelled");
      if (!r.ok) die(r.message);
      const s = loadState(id); event(s, `run ${runId} cancellation requested: ${r.reason}`); saveState(id, s);
      out(r);
    } catch (e) { die(e.message); }
  },

  // ---- delivery transactions -----------------------------------------------
  // Reads and authorization only. STARTING a delivery is
  // `scripts/sch-deliver-run.mjs` — a separate entry point on purpose, so
  // nothing on the ordinary CLI surface can commit or push as a side effect of
  // a status query. There is deliberately no generic git command here.
  async "delivery-status"({ flags, pos }) {
    const D = await import("./delivery.mjs");
    const runId = flags.run ?? pos[0] ?? die("need --run <RUN-id>");
    const d = D.readDelivery(pid(flags), runId);
    if (!d.ok) die(`${d.failure.code} — ${d.failure.message}`);
    out({
      delivery_id: d.transaction.delivery_id, state: d.transaction.state,
      approval: d.approval_status, approver: d.transaction.approval?.approver ?? null,
      commit_message: d.transaction.commit_message, verified_paths: d.transaction.verified_paths,
      verified_diff_hash: d.transaction.verified_diff_hash,
      commit: d.transaction.commit?.hash ?? null, push: d.transaction.push ?? null,
      remote_verification: d.transaction.remote_verification ?? null,
      failure: d.transaction.failure, events: d.events.length, dir: d.dir,
    });
  },
  async "delivery-list"({ flags }) {
    const D = await import("./delivery.mjs");
    out(D.deliveryProjection(pid(flags), { limit: Number(flags.limit ?? 10) }));
  },
  // The human gate. Binds a signature to THIS diff, branch, remote and message;
  // change any of them and the approval stops applying, by design.
  async "delivery-approve"({ flags, pos }) {
    const D = await import("./delivery.mjs");
    const id = pid(flags);
    const runId = flags.run ?? pos[0] ?? die("need --run <RUN-id>");
    const r = D.approveDelivery(id, runId, {
      approver: flags.approver ?? die("need --approver <name> — an approval nobody signed is not an approval"),
      decision: flags.reject === "true" ? "REJECTED" : "APPROVED",
      message: flags.message ?? null,
      ttlMs: flags["ttl-min"] ? Number(flags["ttl-min"]) * 60000 : null,
      why: flags.why ?? "",
    });
    if (!r.ok) die(`${r.failure.code} — ${r.failure.message}`);
    const s = loadState(id); event(s, `delivery for run ${runId} ${r.approval.decision} by ${r.approval.approver}`); saveState(id, s);
    out({ ...r, next: r.approval.decision === "APPROVED" ? `node scripts/sch-deliver-run.mjs --project ${id} --run ${runId}` : "delivery rejected" });
  },
  async "delivery-cancel"({ flags, pos }) {
    const D = await import("./delivery.mjs");
    const id = pid(flags);
    const runId = flags.run ?? pos[0] ?? die("need --run <RUN-id>");
    const r = D.cancelDelivery(id, runId, flags.reason ?? "operator cancelled");
    if (!r.ok) die(`${r.failure.code} — ${r.failure.message}`);
    out(r);
  },
  // Moves the "creating a remote branch is explicit" gate from per-branch to
  // per-project: one operator authorization over a NAMESPACE, so a per-task
  // branch's first push does not stop the queue on every single task.
  "delivery-branch-namespace"({ flags }) {
    const id = pid(flags);
    if (flags.revoke === "true" && flags.set)
      die(`--revoke and --set contradict each other — pass one or the other, not both`);
    const s = loadState(id);
    if (flags.revoke === "true") {
      if (!s.delivery?.branch_namespace) return out("no namespace set");
      delete s.delivery.branch_namespace;
      event(s, "branch namespace authorization revoked");
      saveState(id, s);
      return out("revoked");
    }
    if (!flags.set) return out(branchNamespace(id));
    const pattern = String(flags.set);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\*?$/.test(pattern))
      die(`"${pattern}" is not a usable branch namespace — one trailing "*" at most`);
    const rec = {
      id: "BNS-" + randomUUID().slice(0, 8), pattern,
      authorized_by: flags.approver ?? die("need --approver <name> — an authorization nobody signed is not one"),
      authorized_at: now(),
    };
    (s.delivery ??= {}).branch_namespace = rec;
    event(s, `branch namespace authorized: "${pattern}" by ${rec.authorized_by}`);
    saveState(id, s);
    auditLog({ kind: "delivery", project: id, event: "branch_namespace_authorized", ...rec });
    out(rec.id);
  },
  // Promote a run's raw handoff into the durable, trackable record. Separate
  // from the run on purpose: an attempt is not automatically worth keeping, and
  // one untracked file per attempt is litter, not history.
  async "handoff-promote"({ flags, pos }) {
    const id = pid(flags); const p = getProject(id);
    if (!p) die("no such project: " + id);
    const [WS, R] = [await import("./workspace.mjs"), await import("./runner.mjs")];
    const runId = flags.run ?? pos[0] ?? die("need --run <RUN-id>");
    try {
      const wsDir = WS.resolveWorkspaceDir(WS.repositoryRoot(p.path) ?? p.path, { mustExist: true });
      const r = R.promoteHandoff(wsDir, id, runId, { reason: flags.reason ?? "manual promotion" });
      if (!r.ok) die(r.message);
      out(r);
    } catch (e) { die(e.message); }
  },

  // ---- the task graph -------------------------------------------------------
  // Read-only. Validation NEVER edits the graph: a suspected false edge is a
  // judgement call about work a person planned, and the engine does not quietly
  // rewrite a plan it merely has an opinion about.
  async "graph-validate"({ flags }) {
    const id = pid(flags);
    const [TG, TR] = [await import("./taskgraph.mjs"), await import("./transitions.mjs")];
    const r = TG.validateGraph(id, { canonicalState: TR.canonicalState });
    out(r);
    if (!r.ok) process.exitCode = 1;
  },
  async "graph-show"({ flags }) {
    const id = pid(flags);
    const [TG, TR] = [await import("./taskgraph.mjs"), await import("./transitions.mjs")];
    const g = TG.projectGraph(id, { canonicalState: TR.canonicalState });
    if (flags.format === "markdown") { console.log(TG.renderTaskQueueMarkdown(g)); return; }
    out(g);
  },

  // ---- controlled task transitions -------------------------------------------
  // An EVENT, never a destination. Naming a destination is how a task ends up
  // "DELIVERED" because somebody typed it; an event resolves to a destination
  // this actor is allowed to reach from where the task actually is.
  async "task-transition"({ flags, pos }) {
    const id = pid(flags);
    const TR = await import("./transitions.mjs");
    const taskId = Number(flags.task ?? pos[0] ?? die("need --task <n>"));
    const ev = flags.event ?? pos[1] ?? die(`need --event <${Object.keys(TR.EVENTS).join("|")}>`);
    const r = TR.applyEvent(id, taskId, ev, {
      actor: flags.actor ?? null, reason: flags.reason ?? flags.note ?? "",
      expectVersion: flags["expect-version"] === undefined ? null : Number(flags["expect-version"]),
    });
    if (!r.ok) die(`${r.failure.code}: ${r.failure.message}`);
    out({ task: taskId, state: r.state, state_version: r.state_version, transition: r.transition });
  },
  async "task-states"({ flags }) {
    const TR = await import("./transitions.mjs");
    out(TR.projectStates(pid(flags)));
  },

  // ---- the sequential scheduler ----------------------------------------------
  // Reads only. Starting a scheduler is `scripts/sch-run-queue.mjs` — a separate
  // entry point on purpose, so no status query can start a queue as a side effect.
  async "scheduler-status"({ flags }) {
    const S = await import("./scheduler.mjs");
    out(S.schedulerProjection(pid(flags), { limit: Number(flags.limit ?? 10) }));
  },
  async "scheduler-list"({ flags }) {
    const S = await import("./scheduler.mjs");
    const p = S.schedulerProjection(pid(flags), { limit: Number(flags.limit ?? 20) });
    out({ project: p.project, lease: p.lease, schedulers: p.schedulers });
  },
  async "scheduler-cancel"({ flags, pos }) {
    const id = pid(flags); const p = getProject(id);
    if (!p) die("no such project: " + id);
    const [WSx, S] = [await import("./workspace.mjs"), await import("./scheduler.mjs")];
    const schedulerId = flags.scheduler ?? pos[0] ?? die("need --scheduler <SCHED-id>");
    try {
      const wsDir = WSx.resolveWorkspaceDir(WSx.repositoryRoot(p.path) ?? p.path, { mustExist: true });
      const live = S.liveSchedulerLease(wsDir);
      // Releasing the lease is the cancellation: the scheduler checks it before
      // every task and stops with SCHEDULER_LEASE_LOST. Nothing is killed, so a
      // task mid-delivery finishes its transaction rather than being torn in half.
      const r = S.releaseSchedulerLease(wsDir, schedulerId);
      const s = loadState(id);
      event(s, `scheduler ${schedulerId} cancelled by operator${r.released ? "" : ` (${r.reason})`}`);
      saveState(id, s);
      out({ scheduler: schedulerId, ...r, was_live: live?.scheduler_id === schedulerId,
        note: "the lease is released; the scheduler stops before its next task. Nothing was killed mid-delivery." });
    } catch (e) { die(e.message); }
  },
  async "phase-list"({ flags, pos }) {
    const S = await import("./scheduler.mjs");
    const taskId = Number(flags.task ?? pos[0] ?? die("need --task <n>"));
    out(S.taskPhases(pid(flags), taskId, { schedulerId: flags.scheduler ?? null }));
  },
  async "gate-report"({ flags, pos }) {
    const id = pid(flags);
    const [S, PH] = [await import("./scheduler.mjs"), await import("./phases.mjs")];
    const taskId = Number(flags.task ?? pos[0] ?? die("need --task <n>"));
    const wanted = flags.gate ?? null;
    const rows = [];
    for (const a of S.taskPhases(id, taskId).attempts)
      for (const p of PH.listPhases(a.dir))
        for (const g of p.gate_reports ?? [])
          if (!wanted || g.gate_id === wanted)
            rows.push({ scheduler_id: a.scheduler_id, attempt: a.attempt, phase_id: p.phase_id, ...g });
    out({ project: id, task_id: taskId, gate: wanted, reports: rows });
  },

  // ---- typed human decisions --------------------------------------------------
  async "human-gate-list"({ flags }) {
    const HG = await import("./humangates.mjs");
    out(flags.all === "true" ? HG.list(pid(flags), { taskId: flags.task ? Number(flags.task) : null })
                             : HG.projection(pid(flags)));
  },
  async "human-gate-show"({ flags, pos }) {
    const HG = await import("./humangates.mjs");
    const gateId = flags.gate ?? pos[0] ?? die("need --gate <HG-id>");
    out(HG.get(pid(flags), gateId) ?? { error: `no human gate ${gateId}` });
  },
  async "human-gate-decide"({ flags, pos }) {
    const id = pid(flags);
    const HG = await import("./humangates.mjs");
    const gateId = flags.gate ?? pos[0] ?? die("need --gate <HG-id>");
    const decision = String(flags.decision ?? "").toUpperCase() || die("need --decision APPROVED|REJECTED");
    const r = HG.decide(id, gateId, {
      decision, approver: flags.approver ?? die("need --approver <name> — a decision without an approver is not a decision"),
      conditions: flags.conditions ?? "", expectProposalHash: flags["expect-hash"] ?? null,
    });
    if (!r.ok) die(`${r.failure.code}: ${r.failure.message}`);
    out({ gate: r.gate.id, status: r.gate.status, approver: r.gate.approver, decided_at: r.gate.decided_at,
      next: decision === "APPROVED" ? `resume the queue: node scripts/sch-run-queue.mjs --project ${id}` : "the queue stays stopped" });
  },
  // A human gate raised outside the scheduler — the CLI equivalent of blocking a
  // task, but typed and bound instead of prose in a notes field.
  async "human-gate-open"({ flags }) {
    const id = pid(flags);
    const HG = await import("./humangates.mjs");
    const r = HG.create(id, {
      gateType: String(flags.type ?? "").toUpperCase() || die(`need --type <${(await import("./humangates.mjs")).GATE_TYPES.join("|")}>`),
      question: flags.question ?? die("need --question — the whole question, as the operator will read it"),
      options: splitList(flags.options ?? ""), recommended: flags.recommended ?? "",
      taskId: flags.task ? Number(flags.task) : null, requestedBy: flags.by ?? "operator",
    });
    if (!r.ok) die(`${r.failure.code}: ${r.failure.message}`);
    out({ gate: r.gate.id, status: r.gate.status, existing: Boolean(r.existing) });
  },

  // ---- the SQLite operational projection ---------------------------------------
  // A PROJECTION, not the authority. Safe to delete; rebuilt from state.
  async "projection-status"({ flags }) {
    const id = pid(flags);
    const [PJ, TG, TR, HG] = [await import("./projection.mjs"), await import("./taskgraph.mjs"),
                              await import("./transitions.mjs"), await import("./humangates.mjs")];
    if (flags.rebuild === "true") {
      PJ.reset(id);
      const db = PJ.open(id);
      const p = getProject(id);
      PJ.upsertProject(db, { project_id: id, name: p?.name, domain: p?.domain, execution_mode: null });
      PJ.upsertGraph(db, id, TG.projectGraph(id, { canonicalState: TR.canonicalState }));
      PJ.upsertHumanGates(db, id, HG.list(id));
      for (const r of (loadState(id).runs ?? [])) PJ.upsertRunReference(db, id, r);
      db.close();
    }
    out(PJ.dashboardProjection(id, { limit: Number(flags.limit ?? 20) }));
  },

  // ---- workflow templates ----------------------------------------------------
  // Read-only. A template is data validated against closed registries; it is
  // never edited from the CLI, because a template that project data can rewrite
  // is project data choosing what code runs.
  async "workflow-template-list"() {
    const WFx = await import("./workflows.mjs");
    out(WFx.templateProjection());
  },
  async "workflow-template-show"({ flags, pos }) {
    const WFx = await import("./workflows.mjs");
    const id = flags.template ?? pos[0] ?? die(`need --template <${WFx.TEMPLATE_IDS.join("|")}>`);
    const t = WFx.TEMPLATES[id];
    if (!t) die(`no workflow template "${id}" — one of: ${WFx.TEMPLATE_IDS.join(", ")}`);
    out({ ...t, hash: WFx.templateHash(id), validation: WFx.validateTemplate(t) });
  },
  async "workflow-template-validate"({ flags }) {
    const WFx = await import("./workflows.mjs");
    if (flags.template) {
      const t = WFx.TEMPLATES[flags.template] ?? die(`no template "${flags.template}"`);
      const r = WFx.validateTemplate(t, { taskType: flags["task-type"] ?? null });
      out(r); if (!r.ok) process.exitCode = 1; return;
    }
    const SEMx = await import("./semantic.mjs");
    const all = WFx.validateAll();
    // EXECUTABILITY, not just well-formedness. A template that validates but
    // declares a phase nothing can run is the exact defect this proves absent.
    const executable = all.results.map((r) => {
      const t = WFx.TEMPLATES[r.id];
      const agents = t.phases.filter((x) => x.kind === "AGENT");
      return {
        template_id: r.id, version: t.version, valid: r.ok,
        phases: t.phases.length, agent_phases: agents.length,
        semantic_phases: agents.map((x) => ({ phase: x.id, handler: x.semantic ?? null, role: x.role,
          executable: Boolean(x.semantic && SEMx.SEMANTIC_HANDLERS[x.semantic]),
          envelope: x.output_envelope ?? null,
          effect_policy: x.semantic ? SEMx.SEMANTIC_HANDLERS[x.semantic]?.effect_policy ?? null : null })),
        all_declared_phases_executable: agents.every((x) => x.semantic && SEMx.SEMANTIC_HANDLERS[x.semantic]),
      };
    });
    const gaps = executable.filter((x) => !x.valid || !x.all_declared_phases_executable);
    out({ ...all, executable,
      every_declared_phase_executable: gaps.length === 0,
      gaps: gaps.map((g) => g.template_id),
      note: "a template that declares a semantic phase with no registered handler is REJECTED, never recorded as absent" });
    if (!all.ok || gaps.length) process.exitCode = 1;
  },
  async "semantic-handler-list"() { out((await import("./semantic.mjs")).projection()); },

  // ---- agent roles and model profiles -----------------------------------------
  async "role-list"() { out((await import("./roles.mjs")).rosterProjection()); },
  async "role-show"({ flags, pos }) {
    const R = await import("./roles.mjs");
    const id = flags.role ?? pos[0] ?? die(`need --role <${R.ROLE_IDS.join("|")}>`);
    const r = R.ROLES[id] ?? die(`no agent role "${id}"`);
    out({ ...r, hash: R.roleHash(id), model_profile_resolved: R.MODEL_PROFILES[r.model_profile] });
  },
  async "role-validate"() {
    const r = (await import("./roles.mjs")).validateRoster();
    out(r); if (!r.ok) process.exitCode = 1;
  },
  // What this role would ACTUALLY run as, for this task, right now — including
  // the refusals. The answer to "why did the reviewer not get shell".
  async "role-resolve"({ flags, pos }) {
    const R = await import("./roles.mjs");
    const id = pid(flags); const project = getProject(id);
    const roleId = flags.role ?? pos[0] ?? die(`need --role <${R.ROLE_IDS.join("|")}>`);
    const task = flags.task ? loadState(id).tasks.find((t) => t.id === Number(flags.task)) : null;
    const r = R.resolve(roleId, { task, project });
    if (!r.ok) { out({ ok: false, ...r.failure }); process.exitCode = 1; return; }
    out(r.config);
  },

  // ---- workflow execution -------------------------------------------------------
  async "workflow-status"({ flags }) {
    const id = pid(flags);
    const [WFx, TRx] = [await import("./workflows.mjs"), await import("./transitions.mjs")];
    const s = loadState(id);
    out({
      project: id,
      default_workflow: getProject(id)?.workflowPolicy?.default ?? WFx.SAFE_DEFAULT.template + " (system default)",
      task_type_policy: getProject(id)?.workflowPolicy?.task_types ?? {},
      tasks: (s.tasks ?? []).map((t) => ({
        task_id: t.id, title: t.title, state: TRx.canonicalState(t),
        workflow_id: t.workflow_id ?? null,
        template: t.workflow_binding?.template_id ?? null,
        template_version: t.workflow_binding?.template_version ?? null,
        selected_by: t.workflow_binding?.selected_by ?? null,
        override: t.workflow ?? null,
      })),
    });
  },
  // The full trace of one task: every attempt, every phase, its actor lane, its
  // gates and its usage. Hashes only for prompts — never the bodies.
  async "workflow-trace"({ flags, pos }) {
    const id = pid(flags);
    const [S, PHx] = [await import("./scheduler.mjs"), await import("./phases.mjs")];
    const taskId = Number(flags.task ?? pos[0] ?? die("need --task <n>"));
    const t = loadState(id).tasks.find((x) => x.id === taskId);
    const WFx = await import("./workflows.mjs");
    const declared = t?.workflow_binding?.template_id ? (WFx.TEMPLATES[t.workflow_binding.template_id]?.phases ?? []) : [];
    const attempts = S.taskPhases(id, taskId).attempts.map((a) => ({
      attempt: a.attempt, scheduler_id: a.scheduler_id, run_id: a.run_id,
      resume_at: a.recovery.resume_at, completed: a.recovery.completed,
      // DECLARED vs EXECUTED, side by side. A built-in semantic phase that did
      // not run is a defect, not a footnote, so the trace names both.
      declared_phases: declared.map((d) => {
        const ran = PHx.listPhases(a.dir).find((x) => x.phase_id === d.id);
        return { phase_id: d.id, kind: d.kind, handler: d.handler, semantic: d.semantic ?? null,
          role: d.role ?? null, executed: Boolean(ran), state: ran?.state ?? "NOT_EXECUTED" };
      }),
      phases: PHx.listPhases(a.dir).map((p) => ({
        phase_id: p.phase_id, kind: p.kind, role: p.role ?? null,
        semantic: declared.find((d) => d.id === p.phase_id)?.semantic ?? null,
        executed: true,
        actor_lane: p.kind === "AGENT" ? "AGENT" : p.kind === "HUMAN" ? "ENGINEER" : p.kind === "GATE" ? "GATE" : "CODE",
        state: p.state, outcome: p.outcome, duration_ms: p.duration_ms,
        envelope_type: p.envelope_type, envelope_hash: p.envelope_hash,
        gates: (p.gate_reports ?? []).map((g) => ({ gate_id: g.gate_id, outcome: g.outcome, kind: g.kind })),
        accounting: p.accounting,
      })),
    }));
    out({ project: id, task_id: taskId, workflow_id: t?.workflow_id ?? null, workflow: t?.workflow_binding ?? null, attempts });
  },
  // Usage and cost, aggregated honestly: unknown is counted, never summed as zero.
  async "usage-show"({ flags }) {
    const id = pid(flags);
    const [S, U, PJ] = [await import("./scheduler.mjs"), await import("./usage.mjs"), await import("./projection.mjs")];
    const rows = [];
    for (const t of loadState(id).tasks ?? []) {
      for (const a of S.taskPhases(id, t.id).attempts) {
        const u = (() => { try { return JSON.parse(readFileSync(join(a.dir, "attempt.json"), "utf8")); } catch { return null; } })();
        if (!u?.run_dir) continue;
        try {
          const rec = JSON.parse(readFileSync(join(u.run_dir, "usage.json"), "utf8"));
          rows.push({ ...rec, task_id: t.id, attempt: a.attempt, role_id: null, phase_outcome: a.recovery.completed ? "ACCEPTED" : "FAILED" });
        } catch {}
      }
    }
    out({ project: id, phases: rows.length, total: U.aggregate(rows), by_outcome: U.splitByOutcome(rows),
      by_task: U.aggregate(rows, { by: "task_id" }),
      note: "UNKNOWN is counted, never summed as zero. A total with unknown_usage_phases > 0 is incomplete and says so." });
  },

  // ---- external skill sources -----------------------------------------------------
  // Every one of these is an OPERATOR action. Nothing in the scheduler, the
  // runner or a worker reaches this code.
  async "skill-source-add"({ flags }) {
    const SS = await import("./skillsources.mjs");
    const r = SS.addSource({
      id: flags.id ?? die("need --id <source-id>"),
      repository: flags.repository ?? flags.repo ?? die("need --repository <url-or-path>"),
      pinnedCommit: flags.commit ?? die("need --commit <full-40-char-commit>"),
      license: flags.license ?? null, note: flags.note ?? "",
    });
    if (!r.ok) die(`${r.failure.code}: ${r.failure.message}`);
    out({ ...r.source, next: `node scripts/state.mjs skill-source-sync --id ${r.source.id}` });
  },
  async "skill-source-list"() { out((await import("./skillsources.mjs")).projection()); },
  async "skill-source-show"({ flags, pos }) {
    const SS = await import("./skillsources.mjs");
    const id = flags.id ?? pos[0] ?? die("need --id <source-id>");
    const s = SS.getSource(id) ?? die(`no source "${id}"`);
    out({ ...s, skills: SS.load().skills.filter((k) => k.source_id === id).map((k) => ({ skill_id: k.skill_id, trust: k.trust, risk: k.risk_level, quality: k.quality?.result })) });
  },
  async "skill-source-sync"({ flags, pos }) {
    const SS = await import("./skillsources.mjs");
    const id = flags.id ?? pos[0] ?? die("need --id <source-id>");
    const r = SS.syncSource(id, { allowSubmodules: flags["allow-submodules"] === "true" });
    if (!r.ok) die(`${r.failure.code}: ${r.failure.message}`);
    const d = SS.discoverSkills(id);
    out({ synced: r.source.synced_commit, files: r.files, source_hash: r.source_hash, discovered: d.discovered,
      note: "discovery grants NO trust — every skill is UNREVIEWED until a person reviews and approves it per role" });
  },
  async "skill-source-disable"({ flags, pos }) {
    const SS = await import("./skillsources.mjs");
    const id = flags.id ?? pos[0] ?? die("need --id <source-id>");
    const r = SS.disableSource(id, flags.reason ?? "operator disabled");
    if (!r.ok) die(r.failure.message);
    out(r.source);
  },
  async "external-skill-list"() {
    const p = (await import("./skillsources.mjs")).projection();
    out({ skills: p.skills, counts: p.counts, mutations_require_local_operator: true });
  },
  async "external-skill-show"({ flags, pos }) {
    const SS = await import("./skillsources.mjs");
    const id = flags.skill ?? pos[0] ?? die("need --skill <skill-id>");
    const k = SS.load().skills.find((x) => x.skill_id === id) ?? die(`no external skill "${id}"`);
    out(k);
  },
  async "external-skill-review"({ flags }) {
    const SS = await import("./skillsources.mjs");
    const r = SS.reviewSkill(flags.source ?? die("need --source <id>"), flags.skill ?? die("need --skill <id>"),
      { reviewer: flags.reviewer ?? die("need --reviewer <name>"), notes: flags.notes ?? "" });
    if (!r.ok) die(`${r.failure.code}: ${r.failure.message}`);
    out({ skill_id: r.skill.skill_id, reviewed_at: r.skill.reviewed_at, reviewed_by: r.skill.reviewed_by,
      risk: r.skill.risk_level, quality: r.skill.quality.result,
      note: "a review is not an approval — approve per role with external-skill-approve" });
  },
  async "external-skill-approve"({ flags }) {
    const SS = await import("./skillsources.mjs");
    const r = SS.approveSkill(flags.source ?? die("need --source <id>"), flags.skill ?? die("need --skill <id>"), {
      approver: flags.approver ?? die("need --approver <name>"),
      eligibleRoles: splitList(flags.roles ?? ""), forbiddenRoles: splitList(flags["forbid-roles"] ?? ""),
      contentHash: flags["expect-hash"] ?? null, why: flags.why ?? "",
    });
    if (!r.ok) die(`${r.failure.code}: ${r.failure.message}`);
    out(r.approval);
  },
  async "external-skill-disable"({ flags }) {
    const SS = await import("./skillsources.mjs");
    const r = SS.disableSkill(flags.source ?? die("need --source <id>"), flags.skill ?? die("need --skill <id>"), flags.reason ?? "operator disabled");
    if (!r.ok) die(r.failure.message);
    out({ skill_id: r.skill.skill_id, trust: r.skill.trust });
  },
  async "external-skill-update-diff"({ flags }) {
    const SS = await import("./skillsources.mjs");
    const r = SS.updateDiff(flags.source ?? die("need --source <id>"), flags.commit ?? die("need --commit <full-commit>"));
    if (!r.ok) die(`${r.failure.code}: ${r.failure.message}`);
    out(r);
  },
  async "external-skill-conflicts"({ flags }) {
    const SS = await import("./skillsources.mjs");
    const [R, PR] = [await import("./roles.mjs"), await import("./procedures.mjs")];
    const r = SS.detectConflicts(flags.source ?? null, {
      installed: [], procedures: PR.projection().procedures.map((p) => ({ id: p.id, capabilities: p.capabilities })),
      roles: R.rosterProjection().roles,
    });
    out(r);
  },

  // ---- process + suite discipline ----------------------------------------------
  async "verification-process-status"({ flags, pos }) {
    const id = pid(flags);
    const S = await import("./scheduler.mjs");
    const taskId = Number(flags.task ?? pos[0] ?? die("need --task <n>"));
    const rows = [];
    for (const a of S.taskPhases(id, taskId).attempts) {
      const meta = (() => { try { return JSON.parse(readFileSync(join(a.dir, "attempt.json"), "utf8")); } catch { return null; } })();
      for (const r of meta?.verification?.results ?? [])
        rows.push({ attempt: a.attempt, check_id: r.id, result: r.result, exit_code: r.exit_code });
      try {
        const v = JSON.parse(readFileSync(join(meta.run_dir, "verification.json"), "utf8"));
        for (const r of v.results ?? []) {
          const row = rows.find((x) => x.attempt === a.attempt && x.check_id === r.id) ?? {};
          Object.assign(row, { timeout_ms: r.timeout_ms, timeout_decided_by: r.timeout_decided_by,
            duration_ms: r.duration_ms, cleanup: r.cleanup ?? null, timed_out: r.timed_out });
        }
      } catch {}
    }
    out({ project: id, task_id: taskId, checks: rows,
      cleanup_failures: rows.filter((r) => r.cleanup && r.cleanup.ok === false),
      note: "cleanup is present only when SCH had to kill a process tree; its absence means the process ended on its own" });
  },
  async "test-suite-status"() {
    const L = await import("./suitelock.mjs");
    const s = L.status();
    out({ ...s, running_for_seconds: s.running_for_ms ? Math.round(s.running_for_ms / 1000) : null,
      focused_allowed: L.focusedAllowed().ok });
  },

  help() { out("commands: " + Object.keys(commands).join(", ")); },
};

// Is a scheduler currently holding this project? Used to refuse a hand-driven
// status write while the queue owns the task states. Returns null if there is no
// workspace, no lease, or the holder is gone.
async function schedulerHolding(projectId) {
  try {
    const p = getProject(projectId);
    if (!p?.path) return null;
    const [WSx, S] = [await import("./workspace.mjs"), await import("./scheduler.mjs")];
    const wsDir = WSx.resolveWorkspaceDir(WSx.repositoryRoot(p.path) ?? p.path, { mustExist: true });
    return S.liveSchedulerLease(wsDir);
  } catch { return null; }
}

// Actions that change state or make a scope decision — logged to the audit
// trail. Pure reads (list/get/find/stats/help) are not, to keep the log signal.
const AUDITED = new Set(["project-add", "set-project", "scope-set", "scope-arm-from-auth",
  "auth-add", "auth-add-domain", "auth-remove", "cr-new", "task-add", "task-set",
  "finding-add", "finding-set", "inbox-add", "inbox-mark",
  "coverage-add", "coverage-set", "session-set", "session-fail",
  "skill-discover", "skill-trust", "profile-set", "workspace-init", "run-cancel",
  "delivery-approve", "delivery-cancel", "delivery-branch-namespace", "handoff-promote",
  "task-transition", "scheduler-cancel", "human-gate-decide", "human-gate-open",
  "skill-source-add", "skill-source-sync", "skill-source-disable",
  "external-skill-review", "external-skill-approve", "external-skill-disable"]);

// Commands that mutate state must hold the write lock for the whole
// read-modify-write, or concurrent writers (parallel waves + dashboard) clobber
// each other. Pure reads run without a lock.
const MUTATING = new Set([...AUDITED, "init", "skills-set", "task-answer", "retest-new",
  "lock-acquire", "lock-release", "event-add", "project-remove", "projection-status"]);

if (process.argv[1] && process.argv[1].endsWith("state.mjs")) {
  const [cmd, ...rest] = process.argv.slice(2);
  const parsed = parseFlags(rest);
  if (AUDITED.has(cmd)) auditLog({ kind: "command", cmd, flags: parsed.flags, pos: parsed.pos });
  // a command may be async (task-batch consults the graph); surface its failure
  // rather than letting the promise reject unhandled and exit 0
  const run = () => Promise.resolve((commands[cmd] ?? commands.help)(parsed))
    .catch((e) => { console.error(e.message); process.exitCode = 1; });
  MUTATING.has(cmd) ? withFileLock(registryPath(), run) : run();
}
