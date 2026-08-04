#!/usr/bin/env node
// SCH Loop — skill registry + project capability profile (Stage 0).
//
// WHAT THIS IS. The loop has always dispatched to installed skills by NAME, typed
// by hand into `requiredSkills` and into packs.json. Nothing ever looked at what
// is actually installed, whether it changed since anyone approved it, or whether
// it is even the right skill for the task. This module is that missing layer:
//
//   discover  read-only walk of the roots below; never executes a skill
//   normalize one record per skill (id, capabilities, hash, trust, source)
//   trust     BUILT_IN / APPROVED / UNREVIEWED / DISABLED / BLOCKED, persisted
//   profile   per-project defaults + task-type/phase profiles + execution mode
//   recommend deterministic, explainable "which skills for THIS task"
//
// WHAT THIS IS NOT. It does not run anything, does not launch workers, and does
// not grant tools or permissions. Recommending a skill is advice with a reason
// attached; the caller still decides, and SCH keeps orchestration, safety,
// budgets and Git effects to itself.
//
// A skill file is UNTRUSTED INPUT. It is read as text, parsed for frontmatter,
// hashed — never imported, never executed, and never followed to a script it
// names. Discovery is contained to the roots it was given: a path that resolves
// (through symlinks) outside its root is dropped with a warning.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, realpathSync, renameSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
// Same resolution rule as state.mjs: SCH_HOME wins, resolved per call so a test
// that sets it after import is not answered from the real machine's registry.
const home = () => process.env.SCH_HOME || REPO;
export const skillsPath = () => join(home(), "skills.json");
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- vocabulary

// Small on purpose, and extensible: a capability nobody can define is a
// capability nobody can act on. Adding one here is the whole change.
export const CAPABILITIES = [
  "brainstorming", "specification", "planning", "task-decomposition",
  "test-driven-development", "debugging", "backend-development",
  "frontend-development", "ui-design", "ui-review", "accessibility", "animation",
  "security-review", "code-review", "documentation", "git-worktrees",
  "context-management", "knowledge-graph", "browser-verification",
];

export const TRUST_STATES = ["BUILT_IN", "APPROVED", "UNREVIEWED", "DISABLED", "BLOCKED"];
// Trust states a skill may be moved TO by a human. BUILT_IN is derived from where
// the skill lives, so it is never something discovery or an operator assigns.
export const SETTABLE_TRUST = ["APPROVED", "UNREVIEWED", "DISABLED", "BLOCKED"];
// Never eligible for autonomous selection, whatever a profile says.
const NEVER_AUTONOMOUS = new Set(["UNREVIEWED", "DISABLED", "BLOCKED"]);

export const EXECUTION_MODES = ["SINGLE_TASK", "SUPERVISED_PHASE", "AUTONOMOUS_PROJECT", "PAUSED"];
export const EXECUTION_MODE_DOC = {
  SINGLE_TASK: "one explicitly selected task, then stop",
  SUPERVISED_PHASE: "every eligible pre-approved task in the current phase, then stop at the phase boundary or any human gate",
  AUTONOMOUS_PROJECT: "continue across eligible phases until a terminal state or a safety gate",
  PAUSED: "no new work may start",
};

// ------------------------------------------------------- capability adapters
//
// Superpowers and GSD are capability PROVIDERS, not schedulers. We do not vendor
// them, copy their prompts, or read their bodies into anything. When their own
// metadata says what they do, that wins; this table is the identified fallback
// for the (common) case where a skill ships only a name and a prose description.
// It is deliberately a plain data table so it is trivial to test and to update
// when upstream changes.
export const ADAPTERS = {
  // superpowers
  "superpowers-brainstorming": ["brainstorming", "specification"],
  "superpowers-writing-plans": ["planning", "task-decomposition"],
  "superpowers-executing-plans": ["planning"],
  "superpowers-subagent-driven-development": ["planning", "context-management"],
  "superpowers-test-driven-development": ["test-driven-development"],
  "superpowers-systematic-debugging": ["debugging"],
  "superpowers-using-git-worktrees": ["git-worktrees"],
  "superpowers-verification-before-completion": ["code-review"],
  "superpowers-requesting-code-review": ["code-review"],
  "superpowers-receiving-code-review": ["code-review"],
  // gsd (mapped even when not installed — the record only appears if discovered)
  "gsd-specification": ["specification", "planning"],
  "gsd-phase-decomposition": ["task-decomposition", "planning"],
  "gsd-atomic-plans": ["planning", "task-decomposition"],
  "gsd-context-management": ["context-management"],
  "gsd-fresh-context-execution": ["context-management"],
  "gsd-progress-continuity": ["context-management"],
  // SCH's own
  "sch-spec": ["specification", "brainstorming"],
  "sch-brainstorm": ["brainstorming"],
  "sch-plan": ["planning", "task-decomposition"],
  "sch-run": ["planning", "context-management"],
  "sch-review": ["code-review"],
  "sch-ship": ["documentation"],
  "sch-learn": ["documentation"],
  "SCH": ["planning"],
};

// Two skills that do the same job in the same place — using both is waste at
// best and contradiction at worst. Declared in a skill's own frontmatter first;
// this is the fallback for skills that ship none.
export const CONFLICTS = {
  "taste-skill": ["taste-skill-v1"],
  "taste-skill-v1": ["taste-skill"],
};

// Keyword inference is the LAST resort and is marked as such: a skill classified
// this way keeps `capabilitiesComplete: false`, so a human can finish the job and
// nothing downstream mistakes a guess for a fact.
const KEYWORDS = [
  [/\bbrainstorm/i, "brainstorming"],
  [/\bspecification\b|\bspec-driven\b|\bPRD\b/i, "specification"],
  [/\bplanning\b|\bwrite? a plan\b|\bimplementation plan\b/i, "planning"],
  [/\bdecompos|\bphase breakdown\b|\batomic task/i, "task-decomposition"],
  [/\bTDD\b|test-driven/i, "test-driven-development"],
  [/\bdebug/i, "debugging"],
  [/\bbackend\b|\bAPI\b|\bserver-side\b/i, "backend-development"],
  [/\bfrontend\b|front-end/i, "frontend-development"],
  [/\bUI\b|\bUX\b|\bdesign system\b|\bvisual\b/i, "ui-design"],
  [/\bdesign review\b|\bUI review\b|\bcritique\b|\baudit\b.*\bdesign\b/i, "ui-review"],
  [/accessib|\ba11y\b|WCAG/i, "accessibility"],
  [/\banimation\b|\bmotion\b|\bGSAP\b|\btransition/i, "animation"],
  [/\bsecurity\b|\bpentest\b|vulnerab|\bexploit\b/i, "security-review"],
  [/\bcode review\b|\breview the (diff|PR|branch)\b/i, "code-review"],
  [/\bdocumentation\b|\bchangelog\b|\breport\b/i, "documentation"],
  [/\bworktree/i, "git-worktrees"],
  [/\bcontext (management|window|budget)\b|\bfresh context\b/i, "context-management"],
  [/\bknowledge graph\b|\bcode graph\b/i, "knowledge-graph"],
  [/\bbrowser\b|\bPlaywright\b|\bscreenshot\b/i, "browser-verification"],
];

// Which task types a capability serves. Used to answer "what should a frontend
// task reach for" without anyone maintaining a second list by hand.
const CAPABILITY_TASK_TYPES = {
  "frontend-development": ["frontend"],
  "ui-design": ["frontend", "ui-review"],
  "ui-review": ["ui-review", "frontend"],
  accessibility: ["frontend", "ui-review"],
  animation: ["frontend"],
  "backend-development": ["backend"],
  "test-driven-development": ["backend", "frontend", "testing"],
  debugging: ["debugging", "backend"],
  "security-review": ["security"],
  "code-review": ["review"],
  brainstorming: ["planning"],
  specification: ["planning"],
  planning: ["planning"],
  "task-decomposition": ["planning"],
  "context-management": ["planning"],
  documentation: ["docs"],
  "browser-verification": ["testing"],
  "knowledge-graph": ["research"],
  "git-worktrees": ["infra"],
};

// ------------------------------------------------------------- file plumbing

function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return structuredClone(fallback); }
}
// Same atomic discipline as state.mjs: temp file, keep one .bak, rename.
function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (existsSync(path)) { try { copyFileSync(path, path + ".bak"); } catch {} }
  renameSync(tmp, path);
}

const EMPTY = { version: 1, discoveredAt: "", roots: [], skills: [], trust: {}, warnings: [] };
export const loadSkills = () => readJson(skillsPath(), EMPTY);
export const saveSkills = (r) => writeJson(skillsPath(), r);

// A minimal YAML-frontmatter reader: `key: value`, `key: [a, b]`, and block
// lists. Deliberately not a YAML engine — this parses metadata from untrusted
// files, so the smallest thing that reads the four keys we use is the safest
// thing that reads them.
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  let key = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && key) { (out[key] = Array.isArray(out[key]) ? out[key] : []).push(strip(item[1])); continue; }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(raw);
    if (!kv) continue;
    key = kv[1];
    const v = kv[2].trim();
    if (v === "") { out[key] = []; continue; }
    if (/^\[.*\]$/.test(v)) { out[key] = v.slice(1, -1).split(",").map(strip).filter(Boolean); continue; }
    out[key] = strip(v);
    key = null;
  }
  return out;
}
const strip = (s) => String(s).trim().replace(/^["']|["']$/g, "").trim();
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const listOf = (v) => (Array.isArray(v) ? v.map(strip).filter(Boolean) : v ? [strip(v)] : []);

// ------------------------------------------------------------------- roots

// Where discovery is allowed to look. Anything resolving outside these roots is
// dropped — this is the containment boundary, not a convention.
//
//   SCH_SKILL_ROOTS   "kind:path|kind:path"  replaces the defaults entirely
//                     (how the tests get a deterministic, fixture-only registry)
export function discoveryRoots({ repo = process.cwd(), global: withGlobal = true } = {}) {
  const override = process.env.SCH_SKILL_ROOTS;
  if (override) {
    return override.split("|").map((s) => s.trim()).filter(Boolean).map((s) => {
      const i = s.indexOf(":");
      // a Windows drive letter is not a kind separator ("C:\x"), so require a
      // known kind before the colon or treat the whole string as a path
      const kind = i > 1 ? s.slice(0, i) : "";
      return ["builtin", "repo", "command", "plugin", "global"].includes(kind)
        ? { kind, path: s.slice(i + 1) } : { kind: "repo", path: s };
    }).filter((r) => existsSync(r.path));
  }
  const roots = [
    { kind: "builtin", path: join(REPO, "skills") },
    { kind: "repo", path: join(repo, ".claude", "skills") },
    { kind: "command", path: join(repo, ".claude", "commands") },
  ];
  if (withGlobal) {
    roots.push({ kind: "global", path: join(homedir(), ".claude", "skills") });
    roots.push({ kind: "plugin", path: join(homedir(), ".claude", "plugins", "cache") });
  }
  return roots.filter((r) => existsSync(r.path));
}

// Is `p` genuinely inside `root` once every symlink is resolved? A skill folder
// that symlinks out to somewhere else on the disk is exactly the case this
// exists to refuse.
function contained(root, p) {
  let r, q;
  try { r = realpathSync(root); } catch { return false; }
  try { q = realpathSync(p); } catch { return false; }
  const norm = (x) => resolve(x).replace(/[\\/]+$/, "").toLowerCase();
  return norm(q) === norm(r) || norm(q).startsWith(norm(r) + (process.platform === "win32" ? "\\" : "/"));
}

// --------------------------------------------------------------- discovery

// sha256 over the skill's instruction text. Stable across machines (content
// only — never a path or an mtime), so "did this change since it was approved?"
// is answerable, and a changed body invalidates the approval that was given to
// the old one.
export const contentHash = (text) => createHash("sha256").update(String(text).replace(/\r\n/g, "\n")).digest("hex").slice(0, 32);

function classify(id, fm, text) {
  const explicit = listOf(fm.capabilities).filter((c) => CAPABILITIES.includes(c));
  if (explicit.length) return { capabilities: explicit, complete: true, source: "metadata" };
  if (ADAPTERS[id]) return { capabilities: ADAPTERS[id].slice(), complete: true, source: "adapter" };
  const hay = [id, fm.name || "", fm.description || ""].join(" ");
  const found = [...new Set(KEYWORDS.filter(([re]) => re.test(hay)).map(([, c]) => c))];
  // Inference is a hint, never a fact: the record is kept, flagged incomplete,
  // and left for a human to classify properly.
  return { capabilities: found, complete: false, source: found.length ? "inferred" : "unknown" };
}

const taskTypesFor = (caps) => [...new Set(caps.flatMap((c) => CAPABILITY_TASK_TYPES[c] ?? []))];

function record({ id, name, kind, path, text, version = null, plugin = null }) {
  const fm = frontmatter(text);
  const cls = classify(id, fm, text);
  return {
    id,
    name: fm.name ? strip(fm.name) : name,
    source_kind: kind,
    source_path: path,
    plugin,
    version: fm.version ? strip(fm.version) : version,
    content_hash: contentHash(text),
    trust: kind === "builtin" ? "BUILT_IN" : "UNREVIEWED",
    capabilities: cls.capabilities,
    capabilities_complete: cls.complete,
    capability_source: cls.source,
    task_types: listOf(fm.task_types).length ? listOf(fm.task_types) : taskTypesFor(cls.capabilities),
    requested_tools: listOf(fm["allowed-tools"] ?? fm.tools),
    token_cost: fm.token_cost ? strip(fm.token_cost) : "UNKNOWN",
    bytes: text.length,
    default_enabled: kind === "builtin",
    conflicts_with: listOf(fm.conflicts_with).length ? listOf(fm.conflicts_with) : (CONFLICTS[id] ?? []),
    discovered_at: now(),
  };
}

// Symlinked entries are INCLUDED here on purpose. Skipping them would make a
// skill that points outside its root silently invisible — indistinguishable
// from one that is simply absent. Including them lets contained() refuse it and
// say so, which is the difference between a rejection and a mystery.
const dirs = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name); } catch { return []; } };
const files = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; } };
const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

// Newest install of a plugin. Semver-ish directories sort numerically; a commit
// sha has no order, so those fall back to "most recently written".
function newestVersion(plugDir) {
  const vs = dirs(plugDir);
  if (vs.length < 2) return vs[0] ?? null;
  const semver = vs.filter((v) => /^\d+(\.\d+)*$/.test(v));
  if (semver.length) return semver.sort((a, b) => {
    const A = a.split("."), B = b.split(".");
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      const d = (Number(B[i]) || 0) - (Number(A[i]) || 0);
      if (d) return d;
    }
    return 0;
  })[0];
  return vs.map((v) => { let m = 0; try { m = statSync(join(plugDir, v)).mtimeMs; } catch {} return { v, m }; })
    .sort((a, b) => b.m - a.m)[0].v;
}

// One root -> zero or more normalized records. Reads text, nothing else: no
// import, no spawn, no following of any script a skill's metadata names.
function scanRoot(root, warnings) {
  const found = [];
  const add = (r) => { if (r) found.push(r); };

  if (root.kind === "command") {
    for (const f of files(root.path).filter((f) => f.endsWith(".md"))) {
      const p = join(root.path, f);
      if (!contained(root.path, p)) { warnings.push(`skipped ${p}: resolves outside its discovery root`); continue; }
      const text = readText(p); if (text === null) continue;
      add(record({ id: slug(basename(f, ".md")), name: basename(f, ".md"), kind: "command", path: p, text }));
    }
    return found;
  }

  if (root.kind === "plugin") {
    // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
    for (const market of dirs(root.path))
      for (const plug of dirs(join(root.path, market))) {
        // The cache keeps every version ever installed side by side. Scanning
        // them all would report the same skill three times as a "duplicate" and
        // could pin an id to an old body; only the newest install is the one
        // Claude Code actually loads.
        for (const ver of [newestVersion(join(root.path, market, plug))].filter(Boolean)) {
          const sdir = join(root.path, market, plug, ver, "skills");
          if (!existsSync(sdir)) continue;
          const manifest = readText(join(root.path, market, plug, ver, ".claude-plugin", "plugin.json"));
          let version = ver;
          try { version = manifest ? (JSON.parse(manifest).version ?? ver) : ver; } catch { /* untrusted manifest — keep the directory version */ }
          for (const name of dirs(sdir)) {
            const p = join(sdir, name, "SKILL.md");
            if (!existsSync(p)) continue;
            if (!contained(root.path, p)) { warnings.push(`skipped ${p}: resolves outside its discovery root`); continue; }
            const text = readText(p); if (text === null) continue;
            add(record({ id: `${slug(plug)}-${slug(name)}`, name, kind: "plugin", path: p, text, version, plugin: plug }));
          }
        }
      }
    return found;
  }

  for (const name of dirs(root.path)) {
    const p = join(root.path, name, "SKILL.md");
    if (!existsSync(p)) continue;
    if (!contained(root.path, p)) { warnings.push(`skipped ${p}: resolves outside its discovery root`); continue; }
    const text = readText(p); if (text === null) continue;
    add(record({ id: slug(name) || name, name, kind: root.kind, path: p, text }));
  }
  return found;
}

// Discover everything, first-root-wins on a duplicate id. A duplicate is not a
// silent overwrite: it is reported, because two different files answering to one
// id is how the wrong instructions get followed.
export function discover(opts = {}) {
  const roots = discoveryRoots(opts);
  const warnings = [];
  const byId = new Map();
  for (const root of roots)
    for (const r of scanRoot(root, warnings)) {
      const prev = byId.get(r.id);
      if (prev) {
        // A built-in also appearing under ~/.claude/skills is not a collision —
        // it is sync-skills.mjs having installed it, which is the intended state.
        // Warning about it would make the expected case look like a problem.
        const installedCopy = prev.source_kind === "builtin" && r.source_kind === "global";
        if (!installedCopy) warnings.push(`duplicate skill id "${r.id}": keeping ${prev.source_path}, ignoring ${r.source_path}`);
        continue;
      }
      byId.set(r.id, r);
    }
  return { roots, skills: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), warnings };
}

// Apply the persisted trust decisions onto a freshly discovered set. Discovery
// NEVER promotes anything: an unknown skill is UNREVIEWED, and an approval that
// was given to a different body than the one on disk is not an approval.
export function applyTrust(skills, trust = {}) {
  for (const s of skills) {
    if (s.source_kind === "builtin") { s.trust = "BUILT_IN"; continue; }
    const t = trust[s.id];
    if (!t) { s.trust = "UNREVIEWED"; continue; }
    s.trust = TRUST_STATES.includes(t.state) ? t.state : "UNREVIEWED";
    s.approved_hash = t.hash ?? null;
    s.trust_set_at = t.at ?? null;
    // DISABLED/BLOCKED are decisions about the skill, not about one version of
    // it — they survive an edit. An APPROVAL does not.
    if (s.trust === "APPROVED" && t.hash && t.hash !== s.content_hash) {
      s.trust = "UNREVIEWED";
      s.stale_approval = true;
    }
  }
  return skills;
}

// Rescan and persist. Returns the same shape the file holds.
export function refresh(opts = {}) {
  const prev = loadSkills();
  const d = discover(opts);
  applyTrust(d.skills, prev.trust);
  const next = {
    version: 1, discoveredAt: now(),
    roots: d.roots, skills: d.skills, trust: prev.trust ?? {}, warnings: d.warnings,
  };
  saveSkills(next);
  return next;
}

// The registry, rescanning on first use so nothing depends on someone having
// remembered to run discovery.
export function registry(opts = {}) {
  const r = loadSkills();
  if (!r.skills?.length) return refresh(opts);
  return { ...r, skills: applyTrust(r.skills, r.trust) };
}

export const findSkill = (reg, id) => (reg.skills ?? []).find((s) => s.id === id) ?? null;

// Move a skill's trust state. Rejects unknown ids and unknown states, records
// the hash the decision was made against, and never touches a built-in.
export function setTrust(id, state, { why = "" } = {}) {
  const reg = registry();
  const s = findSkill(reg, id);
  if (!s) throw new Error(`unknown skill "${id}" — run skill-discover, or check skill-list`);
  if (!SETTABLE_TRUST.includes(state))
    throw new Error(`invalid trust state "${state}" — use one of: ${SETTABLE_TRUST.join(", ")}`);
  if (s.source_kind === "builtin")
    throw new Error(`"${id}" is a SCH built-in skill — its trust is BUILT_IN and cannot be set`);
  const file = loadSkills();
  file.trust = file.trust ?? {};
  file.trust[id] = { state, hash: s.content_hash, at: now(), why };
  file.skills = applyTrust(file.skills ?? reg.skills, file.trust);
  saveSkills(file);
  return { id, state, hash: s.content_hash, at: file.trust[id].at, why };
}

// ------------------------------------------------------- capability profile

// Safe defaults for a project that has never seen one — which is every project
// that exists today. Nothing third-party is enabled; the mode is the most
// conservative one; approval is required when a skill's body changes.
export function defaultProfile() {
  return {
    schema_version: 1,
    execution_mode: "SINGLE_TASK",
    default_skills: [],
    task_type_profiles: {},
    phase_profiles: {},
    approval: {
      require_skill_approval_on_hash_change: true,
      allow_unreviewed_skills_during_autonomous_run: false,
    },
  };
}

// Read a profile off a project record, filling anything absent with the safe
// default. An existing project without a profile must keep loading — it does,
// and it behaves exactly as it did before.
export function readProfile(project) {
  const d = defaultProfile();
  const p = project?.capabilities;
  if (!p || typeof p !== "object") return d;
  return {
    ...d, ...p,
    default_skills: Array.isArray(p.default_skills) ? p.default_skills : d.default_skills,
    task_type_profiles: p.task_type_profiles && typeof p.task_type_profiles === "object" ? p.task_type_profiles : d.task_type_profiles,
    phase_profiles: p.phase_profiles && typeof p.phase_profiles === "object" ? p.phase_profiles : d.phase_profiles,
    approval: { ...d.approval, ...(p.approval ?? {}) },
  };
}

const BUCKETS = ["recommended", "required", "disabled"];
const bucketOf = (layer, id) => BUCKETS.find((b) => (layer?.[b] ?? []).includes(id)) ?? null;

// Everything a profile can say wrong, said plainly. Used by profile-validate and
// before any future run is allowed to start.
export function validateProfile(profile, reg) {
  const problems = [];
  const p = profile ?? {};
  if (!EXECUTION_MODES.includes(p.execution_mode))
    problems.push(`invalid execution_mode "${p.execution_mode}" — use one of: ${EXECUTION_MODES.join(", ")}`);
  if (!Array.isArray(p.default_skills)) problems.push("default_skills must be a list");

  const known = new Map((reg.skills ?? []).map((s) => [s.id, s]));
  const seen = new Set();
  for (const d of Array.isArray(p.default_skills) ? p.default_skills : []) {
    if (!d || typeof d !== "object" || !d.skill_id) { problems.push(`malformed default_skills entry: ${JSON.stringify(d)}`); continue; }
    if (seen.has(d.skill_id)) problems.push(`duplicate default skill "${d.skill_id}"`);
    seen.add(d.skill_id);
    const s = known.get(d.skill_id);
    if (!s) { problems.push(`default skill "${d.skill_id}" is not installed`); continue; }
    if (!existsSync(s.source_path)) problems.push(`skill "${s.id}": source file is missing (${s.source_path})`);
    if (s.trust === "BLOCKED" && d.enabled !== false) problems.push(`default skill "${d.skill_id}" is BLOCKED but enabled`);
  }
  for (const [kind, table] of [["task_type", p.task_type_profiles], ["phase", p.phase_profiles]]) {
    for (const [name, layer] of Object.entries(table ?? {})) {
      if (!layer || typeof layer !== "object") { problems.push(`${kind} profile "${name}" is malformed`); continue; }
      for (const b of Object.keys(layer))
        if (!BUCKETS.includes(b)) problems.push(`${kind} profile "${name}": unknown key "${b}" (use ${BUCKETS.join("/")})`);
      for (const b of BUCKETS) {
        if (layer[b] === undefined) continue;
        if (!Array.isArray(layer[b])) { problems.push(`${kind} profile "${name}".${b} must be a list`); continue; }
        for (const id of layer[b]) {
          const s = known.get(id);
          if (!s) { problems.push(`${kind} profile "${name}" names an uninstalled skill "${id}"`); continue; }
          if (b !== "disabled" && s.trust === "BLOCKED") problems.push(`${kind} profile "${name}" selects BLOCKED skill "${id}"`);
          if (b === "required" && !["BUILT_IN", "APPROVED"].includes(s.trust))
            problems.push(`${kind} profile "${name}" requires "${id}" but its trust is ${s.trust}${s.stale_approval ? " (approval is stale — its content changed)" : ""}`);
        }
      }
    }
  }
  // conflicts inside one selection are the operator's to resolve, not ours
  const selected = [...seen, ...Object.values(p.task_type_profiles ?? {}).flatMap((l) => [...(l.required ?? []), ...(l.recommended ?? [])])];
  for (const id of new Set(selected)) {
    const s = known.get(id); if (!s) continue;
    for (const c of s.conflicts_with ?? [])
      if (selected.includes(c)) problems.push(`conflicting skills selected together: "${id}" and "${c}"`);
  }
  for (const w of reg.warnings ?? []) if (w.startsWith("duplicate skill id")) problems.push(w);
  return problems;
}

// May a run start at all? PAUSED is the whole point of this being a state
// contract rather than a comment: no new work, no argument.
export function runEligibility(profile) {
  const mode = profile?.execution_mode;
  if (!EXECUTION_MODES.includes(mode)) return { eligible: false, mode, reason: `invalid execution mode "${mode}"` };
  if (mode === "PAUSED") return { eligible: false, mode, reason: "execution mode is PAUSED — no new work may start" };
  return { eligible: true, mode, reason: EXECUTION_MODE_DOC[mode] };
}

// -------------------------------------------------------------- recommend

// Affected files are a hint, never an override: they only answer "what kind of
// task is this" when nobody said.
const FRONTEND_FILE = /\.(css|scss|sass|less|jsx|tsx|vue|svelte|html|htm)$/i;
const BACKEND_FILE = /\.(py|rb|go|rs|java|php|sql)$/i;
export function inferTaskType(files = []) {
  const f = files.map(String);
  if (f.some((x) => FRONTEND_FILE.test(x))) return "frontend";
  if (f.some((x) => BACKEND_FILE.test(x))) return "backend";
  return null;
}

// Deterministic, explainable "which skills for THIS task".
//
// Precedence, highest first: the task's own override, then the phase profile,
// then the project's task-type profile, then the project defaults. The first
// layer that mentions a skill decides it; nothing below can promote it back.
//
// It returns ids and reasons. It does not read a single skill BODY, does not put
// one in a prompt, and grants no tool or permission — a recommendation is advice
// with its justification attached.
export function recommend({ profile, reg, taskType = null, phase = null, files = [], overrides = null, autonomous = true } = {}) {
  const p = profile ?? defaultProfile();
  const known = new Map((reg?.skills ?? []).map((s) => [s.id, s]));
  const type = taskType || inferTaskType(files);
  const typeWhy = taskType ? null : (type ? `inferred from the affected files` : null);

  const layers = [
    { name: "task override", layer: overrides },
    { name: `phase ${phase} profile`, layer: phase != null ? p.phase_profiles?.[String(phase)] : null },
    { name: `${type} profile`, layer: type ? p.task_type_profiles?.[type] : null },
  ].filter((l) => l.layer);

  const decided = new Map();   // id -> { bucket, why }
  for (const { name, layer } of layers)
    for (const b of BUCKETS)
      for (const id of layer[b] ?? []) {
        if (decided.has(id)) continue;                       // a higher layer already ruled
        decided.set(id, { bucket: b, why: `${b} by the ${name}${typeWhy && name.startsWith(String(type)) ? ` (${typeWhy})` : ""}` });
      }
  for (const d of p.default_skills ?? []) {
    if (!d?.skill_id || decided.has(d.skill_id)) continue;
    decided.set(d.skill_id, d.enabled === false
      ? { bucket: "disabled", why: "disabled in the project defaults" }
      : { bucket: "recommended", why: "enabled in the project defaults" });
  }

  const required = [], recommended = [], optional = [], excluded = [], warnings = [];
  const requireApproval = p.approval?.require_skill_approval_on_hash_change !== false;
  const allowUnreviewed = p.approval?.allow_unreviewed_skills_during_autonomous_run === true;

  for (const [id, d] of decided) {
    const s = known.get(id);
    if (!s) {
      excluded.push({ skill_id: id, reason: "not installed — nothing discovered under the approved roots" });
      warnings.push(`${d.bucket} skill "${id}" is not installed`);
      continue;
    }
    if (d.bucket === "disabled") { excluded.push({ skill_id: id, reason: d.why }); continue; }
    if (s.trust === "BLOCKED" || s.trust === "DISABLED") {
      excluded.push({ skill_id: id, reason: `trust is ${s.trust}` });
      warnings.push(`${d.bucket} skill "${id}" is ${s.trust} and was excluded`);
      continue;
    }
    // An approval given to a body that has since changed is not an approval.
    const stale = s.stale_approval && requireApproval;
    if (stale) warnings.push(`"${id}" changed since it was approved — re-approve it (skill-trust ${id} --state APPROVED)`);
    const trusted = ["BUILT_IN", "APPROVED"].includes(s.trust) && !stale;
    if (!trusted) {
      if (autonomous && !allowUnreviewed) {
        excluded.push({ skill_id: id, reason: `${stale ? "approval is stale" : "trust is " + s.trust} — never selected for autonomous use` });
        if (d.bucket === "required") warnings.push(`REQUIRED skill "${id}" is not approved — an autonomous run cannot satisfy this profile`);
        continue;
      }
      optional.push({ skill_id: id, reason: `${d.why}, but ${stale ? "its approval is stale" : "it is " + s.trust} — approve it before autonomous use` });
      continue;
    }
    (d.bucket === "required" ? required : recommended).push({ skill_id: id, reason: d.why });
  }

  const picked = new Set([...required, ...recommended].map((x) => x.skill_id));
  for (const id of picked) {
    for (const c of known.get(id)?.conflicts_with ?? [])
      if (picked.has(c) && id < c) warnings.push(`"${id}" and "${c}" conflict — resolve which one this project uses`);
  }
  return { task_type: type, phase, execution_mode: p.execution_mode, required, recommended, optional, excluded, warnings };
}

// ------------------------------------------------------- /SCH command table
//
// One table, read by the router skill, the CLI and the dashboard — so what the
// three of them say about a command cannot drift apart. `status` is honest:
// "planned" means the behaviour does not exist yet and the router says so.
export const SCH_COMMANDS = [
  { name: "SCH", status: "implemented", summary: "resolve the active project, summarise its status, show the next actions" },
  { name: "status", status: "implemented", routes_to: "state.mjs stats + interval-advice", summary: "queue, blockers, budget and loop health for one project" },
  { name: "project", status: "implemented", routes_to: "state.mjs project-list / project-here / project-get", summary: "list, resolve or inspect projects" },
  { name: "spec", status: "implemented", routes_to: "skill:sch-spec", summary: "interactive specification — PRD (dev) or armed CR (offensive)" },
  { name: "brainstorm", status: "implemented", routes_to: "skill:sch-brainstorm", summary: "explore options and trade-offs; records proposals, authorizes nothing" },
  { name: "plan", status: "implemented", routes_to: "skill:sch-plan", summary: "interactive phases, bounded tasks, gates and the execution profile" },
  { name: "skills", status: "implemented", routes_to: "state.mjs skill-list / skill-get / skill-trust / skill-recommend", summary: "the discovered skill registry and its trust states" },
  { name: "run", status: "legacy", routes_to: "skill:sch-run", summary: "run one pass of the IN-SESSION loop (the legacy path)", note: "LEGACY. It cannot set controller-only states, cannot name a canonical graph state, and cannot change task status at all while a scheduler holds the project. To execute the queue itself use `/SCH queue` (sch-run-queue.mjs); for exactly one task in a fresh external process use `/SCH run-task`." },
  { name: "queue", status: "implemented", routes_to: "sch-run-queue.mjs --project <id>", summary: "execute the task graph SEQUENTIALLY — one ready task at a time, each in a fresh worker, each delivered and remotely verified before the next is claimed", note: "stops at a typed terminal condition; bounded by --max-tasks / --max-duration-ms; a pending human decision stops it" },
  { name: "graph-validate", status: "implemented", routes_to: "state.mjs graph-validate / graph-show", summary: "validate the task graph (cycles, self/duplicate/missing edges, cancelled dependencies) and audit undefended edges", note: "read only — a suspected false edge is reported, never deleted" },
  { name: "phases", status: "implemented", routes_to: "state.mjs phase-list --task <n> / gate-report --task <n>", summary: "what every phase of every attempt did, and what each named gate actually checked" },
  { name: "scheduler", status: "implemented", routes_to: "state.mjs scheduler-status / scheduler-list / scheduler-cancel", summary: "which scheduler is live, where it is, why it stopped, and whether the project is complete" },
  { name: "decide", status: "implemented", routes_to: "state.mjs human-gate-list / human-gate-show / human-gate-decide", summary: "the typed human decisions the queue is waiting on, and the CLI that answers them", note: "deciding is local-operator authority and stays on the CLI — the dashboard has no authentication" },
  { name: "transition", status: "implemented", routes_to: "state.mjs task-transition --task <n> --event <event>", summary: "move a task through the closed state machine by EVENT, never by naming a destination" },
  { name: "run-task", status: "implemented", routes_to: "sch-run-task.mjs --project <id> --task <n>", summary: "run ONE pre-approved task in a fresh external Claude process, inspect the real Git effects, verify, and stop", note: "requires workspace-init and a task with --allow/--forbid/--verify; VERIFIED is not committed, pushed or done" },
  { name: "workspace", status: "implemented", routes_to: "state.mjs workspace-init / workspace-status", summary: "the canonical per-project .sch-loop/ workspace and its versioned manifest" },
  { name: "runs", status: "implemented", routes_to: "state.mjs run-list / run-get / run-cancel", summary: "supervised run history, evidence and cancellation for one project" },
  { name: "deliver", status: "implemented", routes_to: "sch-deliver-run.mjs --project <id> --run <RUN-id>", summary: "stage, commit, push and remotely verify ONE verified run, then stop", note: "approval is required by default; the task becomes `delivered` only after the commit is verified on the remote" },
  { name: "approve-delivery", status: "implemented", routes_to: "state.mjs delivery-approve --run <RUN-id> --approver <name>", summary: "sign off one delivery — bound to its exact diff, branch, remote and message" },
  { name: "deliveries", status: "implemented", routes_to: "state.mjs delivery-status / delivery-list / delivery-cancel", summary: "delivery transactions, their state, approval and evidence" },
  { name: "review", status: "implemented", routes_to: "skill:sch-review", summary: "fresh-context review of one task's branch" },
  { name: "learn", status: "implemented", routes_to: "skill:sch-learn", summary: "distill reusable lessons into the pack knowledge base" },
  { name: "graph", status: "implemented", routes_to: "graph.mjs", summary: "query the project knowledge graph" },
  { name: "pause", status: "implemented", routes_to: "state.mjs profile-set --mode PAUSED", summary: "no new work may start" },
  { name: "resume", status: "implemented", routes_to: "state.mjs profile-set --mode <previous>", summary: "leave PAUSED and restore the previous execution mode" },
  { name: "stop", status: "implemented", routes_to: "state.mjs profile-set --mode PAUSED + lock-release", summary: "pause and release the run lock", note: "for offensive work HALT is the harder stop: scope-set --halt true" },
  { name: "approve", status: "implemented", routes_to: "state.mjs skill-trust / profile-set", summary: "approve a skill's current content, or the project's execution profile" },
  { name: "dashboard", status: "implemented", routes_to: "dashboard.mjs", summary: "the live dashboard on http://localhost:4600" },
  { name: "doctor", status: "implemented", routes_to: "doctor.mjs", summary: "is what the repo declares actually wired up on this machine" },
];

// Case-insensitive: `/SCH Plan` and `/sch plan` are the same command. The
// canonical spelling shown back to the operator is always `/SCH <name>`.
export const resolveCommand = (name) =>
  SCH_COMMANDS.find((c) => c.name.toLowerCase() === String(name ?? "SCH").trim().toLowerCase()) ?? null;

// ------------------------------------------------------ dashboard projection

// One compact object answering everything the dashboard needs to show about
// capabilities. Never includes a skill body — ids, trust and reasons only.
export function projection(project, { taskType = null } = {}) {
  const reg = registry();
  const profile = readProfile(project);
  const skills = (reg.skills ?? []).map((s) => ({
    id: s.id, name: s.name, source_kind: s.source_kind, trust: s.trust,
    stale_approval: !!s.stale_approval, capabilities: s.capabilities,
    capabilities_complete: s.capabilities_complete, task_types: s.task_types,
    conflicts_with: s.conflicts_with ?? [],
  }));
  const problems = validateProfile(profile, reg);
  const types = [...new Set([...Object.keys(profile.task_type_profiles ?? {}), ...(taskType ? [taskType] : [])])];
  return {
    discoveredAt: reg.discoveredAt ?? "",
    counts: TRUST_STATES.reduce((a, t) => (a[t] = skills.filter((s) => s.trust === t).length, a), {}),
    skills,
    profile,
    execution_mode: profile.execution_mode,
    eligibility: runEligibility(profile),
    recommendations: Object.fromEntries(types.map((t) => [t, recommend({ profile, reg, taskType: t })])),
    stale: skills.filter((s) => s.stale_approval).map((s) => s.id),
    conflicts: problems.filter((p) => p.startsWith("conflicting")),
    needs_approval: problems.filter((p) => /not approved|stale|BLOCKED/.test(p)),
    problems,
    warnings: reg.warnings ?? [],
    commands: SCH_COMMANDS,
  };
}
