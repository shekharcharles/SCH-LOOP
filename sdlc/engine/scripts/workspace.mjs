#!/usr/bin/env node
// SCH Loop — the canonical per-project `.sch-loop/` workspace.
//
// Every managed project gets exactly ONE workspace directory, at the repository
// root, spelled exactly `.sch-loop` (lowercase, hyphen). It is the portable half
// of a project: identity, spec, plan, decisions, human-readable handoffs — the
// things that should travel with the repository and can be reviewed in a diff.
// The operational half (task status, locks, budgets, audit) stays in SCH_HOME,
// which is machine-specific and is NOT what this file writes.
//
// Two rules make the split safe:
//   1. tracked  = project.yaml, SPEC/PLAN/TASK-QUEUE/LEARNING, phases, tasks,
//                 decisions, handoffs  — reviewable, portable, no secrets.
//   2. runtime  = runs, artifacts, logs, cache, locks, tmp — raw worker prompts,
//                 stdout, stderr and evidence. Ignored by default because they
//                 can contain anything the repository or the model produced.
// The whole `.sch-loop/` directory is NEVER ignored wholesale: that would hide
// the durable project record, which is the entire point of it being in the repo.
//
//   node scripts/state.mjs workspace-init   --project <id>
//   node scripts/state.mjs workspace-status --project <id>

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, sep, dirname } from "node:path";

export const WORKSPACE = ".sch-loop";
export const MANIFEST = "project.yaml";
export const MANIFEST_SCHEMA_VERSION = 1;

// Created on init. Deliberately not the full logical tree — an empty directory
// that means nothing is noise in a diff, and every other directory is created by
// the first thing that writes into it.
export const INIT_DIRS = ["handoffs", "runs", "locks"];

// Runtime directories: ignored by default. Raw prompts, stdout/stderr and
// artifacts may contain anything, so they never leave the machine by accident.
// `scheduler/` holds one directory per scheduler run: its record, its event log,
// and one directory per task attempt with that attempt's phase records. Runtime
// by the same argument as `runs/` — it references worker evidence and is
// rebuildable, so it is ignored rather than committed into the customer's repo.
export const RUNTIME_DIRS = ["runs", "artifacts", "logs", "cache", "locks", "tmp", "scheduler"];

// Durable project record: allowed (not forced) to be tracked in git.
export const TRACKED_PATHS = [
  "project.yaml", "SPEC.md", "PLAN.md", "TASK-QUEUE.md", "LEARNING.md",
  "phases/", "tasks/", "decisions/", "handoffs/",
];

const IGNORE_HEADER = "# --- SCH Loop per-project workspace: runtime only (the tracked planning";
const IGNORE_BLOCK = [
  IGNORE_HEADER,
  "# files under .sch-loop/ are deliberately NOT ignored) ---",
  ...RUNTIME_DIRS.map((d) => `${WORKSPACE}/${d}/`),
].join("\n");

const now = () => new Date().toISOString();

// ------------------------------------------------------------- path plumbing

// Real path, symlinks and junctions resolved, so containment is decided on what
// the filesystem actually points at rather than on the string someone typed.
export function real(p) {
  try { return realpathSync.native(p); } catch { /* not on this platform / not present */ }
  try { return realpathSync(p); } catch { return resolve(p); }
}

// Windows paths are case-insensitive; a check that is not would call
// D:\Repo\src contained and D:\repo\src an escape, which is a lie either way.
const key = (p) => (process.platform === "win32" ? String(p).toLowerCase() : String(p));

export function contains(root, p) {
  const a = key(resolve(root)), b = key(resolve(p));
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

// A path a worker reported, normalized for policy checks. Returns null when the
// path could never be inside the repository — absolute, traversing, or escaping
// through a link. Fail closed: null means "reject", never "allow".
export function safeRelative(repoRoot, p) {
  const raw = String(p ?? "").trim();
  if (!raw) return null;
  const slashed = raw.replace(/\\/g, "/");
  if (/^([A-Za-z]:|\/|\\\\)/.test(raw) || /^\/\//.test(slashed)) return null;   // absolute / UNC
  if (slashed.split("/").some((seg) => seg === "..")) return null;              // traversal
  const abs = resolve(repoRoot, slashed);
  if (!contains(repoRoot, abs)) return null;
  // A link that resolves outside the repository is an escape even though every
  // segment of the written path looked innocent.
  if (existsSync(abs) && !contains(real(repoRoot), real(abs))) return null;
  return slashed.replace(/^\.\//, "").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------- git

export const git = (cwd, ...args) => {
  try { return execFileSync("git", ["-C", cwd, ...args], { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch { return null; }
};

// The repository root, as the filesystem really spells it. null = not a repo.
export function repositoryRoot(dir) {
  const top = git(dir, "rev-parse", "--show-toplevel");
  return top ? real(top.trim()) : null;
}

// ----------------------------------------------------------------- manifest

// A deliberately tiny flat-YAML reader/writer: `key: value`, nothing nested.
// The manifest is five scalar keys and is read before every run, so the smallest
// parser that reads exactly those keys is also the safest one.
export function parseManifest(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line || /^\s*#/.test(line)) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function renderManifest(m) {
  return [
    "# SCH Loop workspace manifest. Portable by design: no absolute path lives",
    "# here — machine-specific paths belong to SCH_HOME, not to the repository.",
    `schema_version: ${m.schema_version}`,
    `project_id: ${m.project_id}`,
    `repository_root: ${m.repository_root}`,
    `created_at: ${m.created_at}`,
    `updated_at: ${m.updated_at}`,
    "",
  ].join("\n");
}

// Same atomic discipline as the rest of the engine: temp file then rename, so a
// crash mid-write can never leave a half-parsed manifest behind.
export function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// ------------------------------------------------------------- ignore rules

// Narrow, additive, idempotent. Never writes `.sch-loop/` on its own line: that
// single character difference is what would hide the durable project record.
export function ensureIgnoreRules(repoRoot) {
  const file = join(repoRoot, ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const missing = RUNTIME_DIRS.filter((d) => !new RegExp(`^\\s*${WORKSPACE}/${d}/?\\s*$`, "m").test(current));
  const overBroad = /^\s*\.sch-loop\/?\s*$/m.test(current);
  if (!missing.length) return { changed: false, added: [], overBroad };
  const body = (current && !current.endsWith("\n") ? current + "\n" : current) +
    (current ? "\n" : "") + IGNORE_BLOCK + "\n";
  writeAtomic(file, body);
  return { changed: true, added: missing.map((d) => `${WORKSPACE}/${d}/`), overBroad };
}

// ------------------------------------------------------------- init + check

class WorkspaceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new WorkspaceError(code, message); };

// Everything that must be true about a repository BEFORE a workspace may exist
// in it. Shared by init and by every preflight, so the two cannot drift.
export function resolveRepository(projectId, repoPath) {
  if (!repoPath) fail("WORKSPACE_INVALID", `project "${projectId}" has no path registered — set one with: state.mjs project-add --path <dir>`);
  if (!existsSync(repoPath)) fail("WORKSPACE_INVALID", `project "${projectId}" points at a missing folder: ${repoPath}`);
  const registered = real(repoPath);
  const root = repositoryRoot(registered);
  if (!root) fail("WORKSPACE_INVALID", `${registered} is not a git repository — SCH runs only inside one`);
  if (key(root) !== key(registered))
    fail("WORKSPACE_INVALID", `project "${projectId}" is registered at ${registered} but the repository root is ${root} — register the root`);
  return { root, gitDir: real(join(root, ".git")) };
}

// The `.sch-loop` path itself, refusing everything that is not a plain directory
// contained by the repository. A symlink or a junction here is the whole escape
// class: the path reads as inside the repository while writing somewhere else.
export function resolveWorkspaceDir(repoRoot, { mustExist = false } = {}) {
  const dir = join(repoRoot, WORKSPACE);
  if (existsSync(dir) || (() => { try { lstatSync(dir); return true; } catch { return false; } })()) {
    let st;
    try { st = lstatSync(dir); } catch { st = null; }
    if (st?.isSymbolicLink())
      fail("WORKSPACE_INVALID", `${dir} is a symlink or junction — refused: it can point outside the repository. Remove it and re-run workspace-init.`);
    if (st && !st.isDirectory())
      fail("WORKSPACE_INVALID", `${dir} exists and is not a directory — refused. Move it aside and re-run workspace-init.`);
    if (!contains(real(repoRoot), real(dir)))
      fail("WORKSPACE_INVALID", `${dir} resolves outside ${repoRoot} — refused`);
  } else if (mustExist) {
    fail("WORKSPACE_INVALID", `no workspace at ${dir} — initialize it first: node scripts/state.mjs workspace-init --project <id>`);
  }
  return dir;
}

// Idempotent. Creates only what this milestone needs, never overwrites a file it
// did not write, and refuses a manifest that belongs to a different project or
// to a schema this build does not understand.
export function initWorkspace({ projectId, repoPath }) {
  const { root } = resolveRepository(projectId, repoPath);
  const dir = resolveWorkspaceDir(root);
  const manifestPath = join(dir, MANIFEST);

  let manifest, created = false;
  if (existsSync(manifestPath)) {
    const m = parseManifest(readFileSync(manifestPath, "utf8"));
    const v = Number(m.schema_version);
    if (!Number.isInteger(v) || v < 1)
      fail("WORKSPACE_INVALID", `${manifestPath}: schema_version "${m.schema_version}" is not a version`);
    if (v > MANIFEST_SCHEMA_VERSION)
      fail("WORKSPACE_INVALID", `${manifestPath}: schema_version ${v} is newer than this SCH build understands (${MANIFEST_SCHEMA_VERSION})`);
    if (m.project_id !== projectId)
      fail("WORKSPACE_INVALID", `${manifestPath} belongs to project "${m.project_id}", not "${projectId}" — refusing to take it over`);
    manifest = { ...m, schema_version: v, repository_root: ".", updated_at: now() };
  } else {
    created = true;
    manifest = {
      schema_version: MANIFEST_SCHEMA_VERSION, project_id: projectId,
      repository_root: ".", created_at: now(), updated_at: now(),
    };
  }

  mkdirSync(dir, { recursive: true });
  for (const d of INIT_DIRS) mkdirSync(join(dir, d), { recursive: true });
  writeAtomic(manifestPath, renderManifest(manifest));
  const ignore = ensureIgnoreRules(root);

  return { dir, root, manifest, created, ignore };
}

// Read-only: everything a run must confirm before it is allowed to start.
// Returns problems rather than throwing, because a preflight reports all of them
// at once instead of stopping at the first.
export function validateWorkspace({ projectId, repoPath }) {
  const problems = [];
  let root = null, dir = null, manifest = null;
  try {
    ({ root } = resolveRepository(projectId, repoPath));
    dir = resolveWorkspaceDir(root, { mustExist: true });
  } catch (e) {
    return { ok: false, problems: [{ code: e.code ?? "WORKSPACE_INVALID", message: e.message }], root, dir, manifest };
  }
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) {
    problems.push({ code: "WORKSPACE_INVALID", message: `${manifestPath} is missing — run: node scripts/state.mjs workspace-init --project ${projectId}` });
    return { ok: false, problems, root, dir, manifest };
  }
  manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  const v = Number(manifest.schema_version);
  if (!Number.isInteger(v) || v < 1 || v > MANIFEST_SCHEMA_VERSION)
    problems.push({ code: "WORKSPACE_INVALID", message: `${manifestPath}: unsupported schema_version "${manifest.schema_version}" (this build understands ${MANIFEST_SCHEMA_VERSION})` });
  if (manifest.project_id !== projectId)
    problems.push({ code: "WORKSPACE_INVALID", message: `${manifestPath} declares project "${manifest.project_id}" but this run is for "${projectId}"` });
  if (manifest.repository_root && manifest.repository_root !== ".")
    problems.push({ code: "WORKSPACE_INVALID", message: `${manifestPath}: repository_root must be "." — an absolute path is not portable` });
  return { ok: problems.length === 0, problems, root, dir, manifest };
}

// Where a run's evidence lives. Kept here so exactly one module decides the
// layout and the path-policy checker can recognise it as runner-owned.
export const runsDir = (wsDir) => join(wsDir, "runs");
export const locksDir = (wsDir) => join(wsDir, "locks");
export const runDir = (wsDir, runId) => join(runsDir(wsDir), runId);
export const deliveryDir = (wsDir, runId) => join(runDir(wsDir, runId), "delivery");
export const handoffDir = (wsDir, taskId) => join(wsDir, "handoffs", String(taskId));

// ------------------------------------------------------- worker path policy
//
// DEFAULT DENY for the whole workspace. `.sch-loop/` is SCH's control state: an
// application-development task has no business editing the spec, the plan, the
// queue, a decision record or a handoff, and the first version of this list —
// which denied only runs/, locks/ and the manifest — left every one of those
// writable by any task whose allow-list happened to be broad.
//
// These are absolute. No task policy can re-open them, because they are the
// evidence and the identity the controller grades the worker against.
export const WORKSPACE_ALWAYS_DENY = [
  `${WORKSPACE}/${MANIFEST}`,
  ...RUNTIME_DIRS.map((d) => `${WORKSPACE}/${d}/`),
];

// Durable categories a task MAY be explicitly authorized to write, one at a
// time (`task.controlCategory`). Everything here is denied unless named.
export const WORKSPACE_DURABLE_CATEGORIES = {
  spec: `${WORKSPACE}/SPEC.md`,
  plan: `${WORKSPACE}/PLAN.md`,
  queue: `${WORKSPACE}/TASK-QUEUE.md`,
  learning: `${WORKSPACE}/LEARNING.md`,
  phases: `${WORKSPACE}/phases/`,
  tasks: `${WORKSPACE}/tasks/`,
  decisions: `${WORKSPACE}/decisions/`,
  handoffs: `${WORKSPACE}/handoffs/`,
};

// `.git/` is never negotiable either. Kept separate from the workspace rules so
// the reason each path is denied stays legible.
export const WORKER_FORBIDDEN = [".git/", `${WORKSPACE}/`];

// Is a repository-relative path SCH control state a worker must not touch?
// `controlCategory` names at most one durable category the task authorizes.
export function workerDenied(rel, { controlCategory = null } = {}) {
  const p = String(rel ?? "").replace(/\\/g, "/");
  if (p === ".git" || p.startsWith(".git/")) return { denied: true, why: "`.git/` is never writable by a worker" };
  if (p !== WORKSPACE && !p.startsWith(`${WORKSPACE}/`)) return { denied: false };
  for (const deny of WORKSPACE_ALWAYS_DENY)
    if (p === deny.replace(/\/$/, "") || p.startsWith(deny)) return { denied: true, why: `${deny} is SCH-owned and never writable by a worker` };
  const allow = controlCategory ? WORKSPACE_DURABLE_CATEGORIES[controlCategory] : null;
  if (allow && (p === allow.replace(/\/$/, "") || p.startsWith(allow) || p === allow))
    return { denied: false, why: `authorized by this task's control category "${controlCategory}"` };
  return { denied: true, why: `${WORKSPACE}/ is SCH control state — a task must name a control category to write here` };
}

// Runtime paths are ignored, so an uncommitted change to one of them is not the
// operator's work in progress. Everything else under `.sch-loop/` — the spec,
// the plan, a decision, a promoted handoff — is durable project content and
// MUST participate in dirty-tree and diff inspection like any other file.
export function isRuntimePath(rel) {
  const p = String(rel ?? "").replace(/\\/g, "/");
  return RUNTIME_DIRS.some((d) => p === `${WORKSPACE}/${d}` || p.startsWith(`${WORKSPACE}/${d}/`));
}
