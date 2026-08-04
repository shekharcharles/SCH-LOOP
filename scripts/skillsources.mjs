#!/usr/bin/env node
// SCH Loop — governed external skill sources.
//
// WHY THIS IS SO CAREFUL
// A skill is a prompt that a worker is told to follow. Installing one from a
// stranger's repository is running their instructions inside your agent, with
// your credentials, on your code. The industry norm — `git clone`, point the
// agent at it, done — is remote code execution with a friendly name.
//
// So nothing here is automatic:
//   * a source is pinned to a FULL COMMIT, never a branch (a branch is a
//     promise the other end can rewrite after you read it);
//   * synchronisation is an operator action, never a worker's;
//   * discovery grants NO trust;
//   * a quality PASS is not an approval;
//   * approval binds to (source commit, content hash) and dies when either moves;
//   * approval is ROLE-SCOPED, and the default eligibility is nothing at all.
//
// AND THE PART THAT MATTERS MOST: a skill can never grant a tool or widen a
// write scope. Even a fully approved skill is CONTENT. `roles.mjs` enforces that
// by intersection; this file classifies what the content is asking for so a
// person can see it before saying yes.
//
// The risk classifier is defence in depth and says so. It reads text with
// regular expressions; it is not a sandbox, and a determined author can evade
// it. Its job is to make the obvious cases obvious.

import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, lstatSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = () => process.env.SCH_HOME || REPO;
export const sourcesPath = () => join(home(), "skill-sources.json");
export const checkoutRoot = () => join(home(), "external-skills");
export const checkoutDir = (id) => join(checkoutRoot(), id);

const now = () => new Date().toISOString();
const sha = (s) => createHash("sha256").update(s).digest("hex");
const clamp = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));

export const TRUST_STATES = ["UNREVIEWED", "APPROVED", "DISABLED", "BLOCKED", "NEEDS_DECISION"];
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
export const QUALITY_RESULTS = ["PASS", "WARN", "FAIL", "NEEDS_REVIEW"];

// Licenses this engine recognises well enough to proceed without a person. An
// absent or unrecognised license is NEEDS_DECISION, not a warning: shipping
// somebody's prose into your pipeline is a licensing act.
const KNOWN_LICENSES = /\b(MIT|Apache[- ]?2\.0|BSD[- ]?(2|3)[- ]Clause|ISC|MPL[- ]?2\.0|Unlicense|CC0|GPL[- ]?[23]\.0|AGPL[- ]?3\.0|LGPL[- ]?[23]\.[01])\b/i;

// -------------------------------------------------------------- persistence

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return structuredClone(fallback); }
}
function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}
const EMPTY = { schema_version: SCHEMA_VERSION, sources: [], skills: [], approvals: [], reviews: [] };
export const load = () => readJson(sourcesPath(), EMPTY);
export const save = (db) => writeJson(sourcesPath(), db);

const fail = (code, message) => ({ ok: false, failure: { code, message } });

// ---------------------------------------------------------------- git helper

// Every git call is an argument array with no shell, and every one of them runs
// inside the checkout. A source cannot inject a flag through its own name.
function git(cwd, args, { timeoutMs = 120000 } = {}) {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return { ok: true, stdout: String(stdout) };
  } catch (e) {
    return { ok: false, code: e.status ?? null, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message ?? "") };
  }
}

// ------------------------------------------------------------- registration

const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const CREDENTIAL_URL = /\/\/[^/@\s]*:[^@/\s]*@/;

// Register a source. Refuses everything that would make provenance a guess.
export function addSource({ id, repository, pinnedCommit, license = null, type = "git", note = "" }) {
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id))
    return fail("SOURCE_ID_INVALID", `source id "${id}" must be a simple identifier`);
  if (type !== "git") return fail("SOURCE_TYPE_UNSUPPORTED", `only "git" sources are supported, not "${type}"`);
  if (!repository) return fail("SOURCE_REPOSITORY_REQUIRED", "a source needs a repository");
  // A URL carrying a username and password would be written into a state file
  // and every audit record that quotes it.
  if (CREDENTIAL_URL.test(String(repository)))
    return fail("SOURCE_URL_HAS_CREDENTIALS", "the repository URL contains credentials — use a credential helper, never an embedded password");
  // THE PIN. A branch name is a promise the other end can rewrite after you
  // read it; a tag can be moved. Only a full commit identifies content.
  if (!pinnedCommit || !FULL_COMMIT.test(String(pinnedCommit)))
    return fail("SOURCE_PIN_REQUIRED",
      `a source must be pinned to a FULL 40-character commit hash, not "${pinnedCommit ?? "(nothing)"}". ` +
      `A branch or tag is not provenance: the other end can move it after you reviewed it.`);

  const db = load();
  if (db.sources.some((s) => s.id === id)) return fail("SOURCE_EXISTS", `a source "${id}" is already registered`);

  const source = {
    schema_version: SCHEMA_VERSION, id, type, repository: String(repository),
    pinned_commit: String(pinnedCommit).toLowerCase(),
    license: license ? String(license) : null,
    license_status: license && KNOWN_LICENSES.test(String(license)) ? "RECOGNISED" : "NEEDS_DECISION",
    default_trust: "UNREVIEWED",
    auto_update: false,          // not configurable. There is no field that turns this on.
    enabled: true, note: clamp(note, 500),
    synced_commit: null, synced_at: null, source_hash: null,
    registered_at: now(),
  };
  db.sources.push(source);
  save(db);
  return { ok: true, source };
}

export const listSources = () => load().sources;
export const getSource = (id) => load().sources.find((s) => s.id === id) ?? null;

export function disableSource(id, reason = "operator disabled") {
  const db = load();
  const s = db.sources.find((x) => x.id === id);
  if (!s) return fail("SOURCE_NOT_FOUND", `no source "${id}"`);
  s.enabled = false; s.disabled_reason = clamp(reason, 300); s.disabled_at = now();
  // Disabling a source disables what came from it. A skill whose provenance is
  // switched off must not remain eligible.
  for (const sk of db.skills) if (sk.source_id === id) sk.trust = sk.trust === "APPROVED" ? "DISABLED" : sk.trust;
  save(db);
  return { ok: true, source: s };
}

// ------------------------------------------------------------------- sync

// Fetch the pinned commit into a local checkout. An OPERATOR action: nothing in
// the worker or scheduler path calls this, and the CLI is the only entry point.
export function syncSource(id, { allowSubmodules = false } = {}) {
  const db = load();
  const s = db.sources.find((x) => x.id === id);
  if (!s) return fail("SOURCE_NOT_FOUND", `no source "${id}"`);
  if (!s.enabled) return fail("SOURCE_DISABLED", `source "${id}" is disabled`);

  const dir = checkoutDir(id);
  mkdirSync(checkoutRoot(), { recursive: true });

  if (!existsSync(join(dir, ".git"))) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    mkdirSync(dir, { recursive: true });
    const init = git(dir, ["init", "-q"]);
    if (!init.ok) return fail("SYNC_FAILED", `git init failed: ${clamp(init.stderr, 400)}`);
    git(dir, ["remote", "add", "origin", s.repository]);
  }
  // Fetch EXACTLY the pinned commit. No refspec wildcards, no tags, no depth
  // games that could resolve to something else.
  const fetch = git(dir, ["fetch", "--no-tags", "--depth", "1", "origin", s.pinned_commit]);
  if (!fetch.ok) {
    const byRef = git(dir, ["fetch", "--no-tags", "origin"]);
    if (!byRef.ok) return fail("SYNC_FAILED", `cannot fetch ${s.pinned_commit} from ${s.repository}: ${clamp(fetch.stderr || byRef.stderr, 600)}`);
  }
  const checkout = git(dir, ["checkout", "-q", "--detach", s.pinned_commit]);
  if (!checkout.ok) return fail("SYNC_COMMIT_MISSING", `commit ${s.pinned_commit} is not in ${s.repository}: ${clamp(checkout.stderr, 400)}`);

  const head = git(dir, ["rev-parse", "HEAD"]).stdout?.trim();
  if (head !== s.pinned_commit)
    return fail("SYNC_PIN_MISMATCH", `checked out ${head}, expected the pinned ${s.pinned_commit}`);

  // Submodules are somebody else's pin inside your pin. Off unless a person said
  // otherwise, and reported either way.
  const submodules = existsSync(join(dir, ".gitmodules"))
    ? String(readFileSync(join(dir, ".gitmodules"), "utf8")).match(/path\s*=\s*(.+)/g)?.map((l) => l.split("=")[1].trim()) ?? []
    : [];
  if (submodules.length && !allowSubmodules)
    return fail("SOURCE_HAS_SUBMODULES",
      `${id} declares ${submodules.length} submodule(s): ${submodules.join(", ")}. They are NOT initialised — each is a separate pin needing its own review. Re-sync with --allow-submodules once reviewed.`);

  const inv = inventorySource(dir);
  if (!inv.ok) return inv;

  s.synced_commit = head; s.synced_at = now(); s.source_hash = inv.source_hash;
  s.submodules = submodules;
  save(db);
  return { ok: true, source: s, dir, files: inv.files.length, source_hash: inv.source_hash, submodules };
}

// A deterministic hash of everything tracked at the pinned commit — the identity
// an approval binds to, independent of checkout path or filesystem order.
export function inventorySource(dir) {
  const listed = git(dir, ["ls-files", "-z"]);
  if (!listed.ok) return fail("INVENTORY_FAILED", `cannot list files: ${clamp(listed.stderr, 300)}`);
  const files = listed.stdout.split("\0").filter(Boolean).sort();

  const root = resolve(dir);
  const entries = [];
  for (const f of files) {
    const abs = resolve(dir, f);
    // TRAVERSAL AND LINK ESCAPE. A path that resolves outside the checkout is
    // refused rather than read — a symlink to /etc or to the operator's home is
    // the cheapest possible exfiltration.
    if (!(abs === root || abs.startsWith(root + sep)))
      return fail("SOURCE_PATH_ESCAPE", `"${f}" resolves outside the source root`);
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink())
      return fail("SOURCE_SYMLINK_REFUSED", `"${f}" is a symbolic link; external sources may not contain links`);
    entries.push({ path: f, bytes: st.size, hash: sha(safeRead(abs)) });
  }
  return { ok: true, files: entries, source_hash: sha(entries.map((e) => `${e.path}:${e.hash}`).join("\n")) };
}

const safeRead = (p) => { try { return readFileSync(p, "utf8"); } catch { try { return readFileSync(p).toString("base64"); } catch { return ""; } } };

// ------------------------------------------------------ discovery + analysis

// Every SKILL.md under a synced source, analysed. Discovery grants no trust:
// everything lands UNREVIEWED and stays there until a person acts.
export function discoverSkills(id) {
  const db = load();
  const s = db.sources.find((x) => x.id === id);
  if (!s) return fail("SOURCE_NOT_FOUND", `no source "${id}"`);
  if (!s.synced_commit) return fail("SOURCE_NOT_SYNCED", `source "${id}" has never been synced`);

  const dir = checkoutDir(id);
  const inv = inventorySource(dir);
  if (!inv.ok) return inv;

  const manifests = inv.files.filter((f) => /(^|\/)SKILL\.md$/i.test(f.path));
  const found = [];
  for (const m of manifests) {
    const skillDir = dirname(m.path) === "." ? "" : dirname(m.path);
    const text = safeRead(join(dir, m.path));
    const siblings = inv.files.filter((f) => (skillDir ? f.path.startsWith(skillDir + "/") : true));
    const analysed = analyseSkill({ text, path: m.path, dir: skillDir, files: siblings, sourceDir: dir });

    const skillId = analysed.declared_id || (skillDir ? skillDir.split("/").pop() : id);
    const prev = db.skills.find((x) => x.source_id === id && x.path === m.path);
    const record = {
      schema_version: SCHEMA_VERSION,
      skill_id: skillId, source_id: id, source_commit: s.synced_commit, path: m.path,
      license: s.license, license_status: s.license_status,
      content_hash: sha(text),
      // A source update that changes the file resets trust to UNREVIEWED. It is
      // not a downgrade; it is the honest state of a thing nobody has read.
      trust: prev && prev.content_hash === sha(text) ? prev.trust : "UNREVIEWED",
      previous_hash: prev?.content_hash ?? null,
      changed_since_review: Boolean(prev && prev.content_hash !== sha(text)),
      ...analysed.inventory,
      risk_level: analysed.risk.level, risk_reasons: analysed.risk.reasons,
      quality: analysed.quality,
      overlaps: [], conflicts: [],
      reviewed_at: prev && prev.content_hash === sha(text) ? prev.reviewed_at ?? null : null,
      discovered_at: now(),
    };
    found.push(record);
  }

  db.skills = [...db.skills.filter((x) => x.source_id !== id), ...found];
  save(db);
  return { ok: true, source: id, discovered: found.length, skills: found };
}

// ------------------------------------------------------------ the analyser

// Regular expressions over text. This is DEFENCE IN DEPTH, not a sandbox: it
// makes the obvious dangerous thing visible to a reviewer. A determined author
// evades it, and the answer to that is the reviewer, not a cleverer regex.
const PATTERNS = {
  push_deploy: /\bgit\s+push\b|\bnpm\s+publish\b|\bdocker\s+push\b|\bkubectl\s+apply\b|\bterraform\s+apply\b|\bvercel\s+deploy\b|\bgh\s+release\s+create\b/i,
  force_push: /--force\b|--force-with-lease\b|\bpush\s+-f\b/i,
  global_config: /~\/\.claude\/settings|\.claude\/settings\.json|CLAUDE\.md|~\/\.gitconfig|git\s+config\s+--global|\.bashrc|\.zshrc|\.profile/i,
  credentials: /\bAWS_SECRET|ANTHROPIC_API_KEY|GITHUB_TOKEN|\.env\b|id_rsa|credential\.helper|\bnetrc\b|~\/\.aws\/credentials/i,
  installer: /\bcurl\b[^\n]*\|\s*(ba)?sh\b|\bwget\b[^\n]*\|\s*(ba)?sh\b|\bnpm\s+i(nstall)?\s+-g\b|\bpip\s+install\b|\bbrew\s+install\b/i,
  destructive: /\brm\s+-rf\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f|\bDROP\s+TABLE\b|\bmkfs\b|\bformat\s+[A-Z]:/i,
  self_schedule: /\bcrontab\b|\bschtasks\b|\bsystemd\b|\blaunchctl\b|\bsetInterval\b|\bwhile\s+true\b|\bloop\s+forever\b/i,
  goal_loop: /\buntil\s+(the\s+)?(goal|task|it)\s+is\s+(complete|done)\b|\brepeat\s+until\b|\bkeep\s+(going|iterating)\s+until\b|\bautonomous(ly)?\s+(loop|iterate)\b/i,
  worktree: /\bgit\s+worktree\b/i,
  shell: /\bbash\b|\bsh\s+-c\b|\bexeca?\b|\bchild_process\b|\bsubprocess\b|\bRun\s+shell\b|\bBash\s+tool\b/i,
  dependency_install: /\bnpm\s+(ci|install)\b|\byarn\s+add\b|\bpnpm\s+add\b|\bpoetry\s+add\b|\bcargo\s+add\b/i,
  service_control: /\bsystemctl\b|\bservice\s+\w+\s+(start|stop|restart)\b|\bdocker\s+(run|compose)\b|\bpm2\b/i,
  network: /https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+/i,
  database: /\bpsql\b|\bmysql\b|\bmongo(sh)?\b|\bredis-cli\b|\bALTER\s+TABLE\b|\bmigrate\b/i,
  browser: /\bplaywright\b|\bpuppeteer\b|\bselenium\b|\bbrowser_navigate\b/i,
  file_edit: /\bEdit\b|\bWrite\b|\bwriteFileSync\b|\bfs\.write/i,
  git_general: /\bgit\s+(add|commit|checkout|switch|branch|merge|rebase|stash|tag|remote)\b/i,
  env_reference: /process\.env\.[A-Z_]+|\$\{?[A-Z_]{3,}\}?|\bos\.environ\b/,
};

function analyseSkill({ text, path, dir, files, sourceDir }) {
  const body = String(text ?? "");
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const front = fm ? fm[1] : "";
  const declared_id = (front.match(/^name:\s*(.+)$/m)?.[1] ?? "").trim() || null;
  const description = (front.match(/^description:\s*(.+)$/m)?.[1] ?? "").trim();

  const scripts = files.filter((f) => /\.(sh|bash|zsh|ps1|py|mjs|cjs|js|rb|pl)$/i.test(f.path)).map((f) => f.path);
  const hooks = files.filter((f) => /hook|\.claude\/settings|settings\.json/i.test(f.path)).map((f) => f.path);
  const executables = files.filter((f) => /\.(exe|bat|cmd|com|app)$/i.test(f.path)).map((f) => f.path);

  // Read the skill body AND its scripts: a skill whose SKILL.md is innocent and
  // whose helper script pushes is still a skill that pushes.
  const scriptText = scripts.map((p) => safeRead(join(sourceDir, p))).join("\n");
  const all = body + "\n" + scriptText;

  const hit = (k) => PATTERNS[k].test(all);
  const matches = (re, cap = 12) => [...new Set((all.match(re) ?? []).map((m) => clamp(m, 120)))].slice(0, cap);

  const inventory = {
    declared_name: declared_id, description: clamp(description, 500),
    capabilities: inferCapabilities(all, description),
    scripts, hooks, executables,
    network_references: matches(PATTERNS.network),
    environment_references: matches(PATTERNS.env_reference),
    git_capabilities: [
      hit("push_deploy") && "push/deploy", hit("force_push") && "force push", hit("worktree") && "worktree",
      hit("git_general") && "general git", PATTERNS.destructive.test(all) && "destructive git",
    ].filter(Boolean),
    global_config_capabilities: hit("global_config") ? matches(PATTERNS.global_config, 6) : [],
    token_footprint_characters: body.length,
    file_count: files.length,
  };

  return { declared_id, inventory, risk: classifyRisk(inventory, all), quality: qualityGate({ front, body, description, declared_id, inventory }) };
}

function inferCapabilities(all, description) {
  const caps = [];
  const add = (c, cond) => { if (cond) caps.push(c); };
  add("shell", PATTERNS.shell.test(all));
  add("file-edit", PATTERNS.file_edit.test(all));
  add("git", PATTERNS.git_general.test(all));
  add("deploy", PATTERNS.push_deploy.test(all));
  add("browser", PATTERNS.browser.test(all));
  add("database", PATTERNS.database.test(all));
  add("network", PATTERNS.network.test(all));
  add("scheduling", PATTERNS.self_schedule.test(all));
  add("worktree", PATTERNS.worktree.test(all));
  add("documentation", /\bdocument|\breadme|\bchangelog/i.test(description));
  add("review", /\breview|\baudit|\bcritique/i.test(description));
  add("planning", /\bplan|\bbrainstorm|\bdesign/i.test(description));
  return [...new Set(caps)];
}

// Risk is EXPLAINABLE. Every level comes with the reasons that produced it, so a
// reviewer can disagree with the classifier rather than obey it.
export function classifyRisk(inv, all) {
  const reasons = [];
  const at = (level, why) => reasons.push({ level, why });

  if (PATTERNS.push_deploy.test(all)) at("CRITICAL", "pushes or deploys — an irreversible act outside this machine");
  if (PATTERNS.global_config.test(all)) at("CRITICAL", "mutates global agent or shell configuration, which outlives any single task");
  if (PATTERNS.credentials.test(all)) at("CRITICAL", "references credentials or credential files");
  if (PATTERNS.installer.test(all)) at("CRITICAL", "runs an arbitrary installer (curl|sh, global install)");
  if (PATTERNS.destructive.test(all)) at("CRITICAL", "performs destructive filesystem or repository operations");
  if (PATTERNS.self_schedule.test(all)) at("CRITICAL", "schedules itself or loops without an external bound");
  if (PATTERNS.goal_loop.test(all)) at("CRITICAL", "claims unbounded goal-seeking iteration authority");

  if (PATTERNS.worktree.test(all)) at("HIGH", "creates git worktrees");
  if (PATTERNS.shell.test(all)) at("HIGH", "executes shell commands");
  if (PATTERNS.dependency_install.test(all)) at("HIGH", "installs dependencies");
  if (PATTERNS.service_control.test(all)) at("HIGH", "starts or stops services");
  if (PATTERNS.network.test(all)) at("HIGH", "fetches over the network");
  if (PATTERNS.database.test(all)) at("HIGH", "administers a database");
  if (inv.executables.length) at("HIGH", `ships ${inv.executables.length} binary executable(s)`);
  if (inv.hooks.length) at("HIGH", `ships ${inv.hooks.length} hook/settings file(s), which run outside any task`);

  if (PATTERNS.file_edit.test(all)) at("MEDIUM", "edits files");
  if (PATTERNS.browser.test(all)) at("MEDIUM", "automates a browser");
  if (inv.scripts.length) at("MEDIUM", `ships ${inv.scripts.length} script(s)`);

  if (!reasons.length) at("LOW", "read-only reasoning or formatting; no shell, network, git or configuration authority detected");

  const order = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  const level = reasons.reduce((a, r) => (order[r.level] > order[a] ? r.level : a), "LOW");
  return { level, reasons };
}

// -------------------------------------------------------- static quality gate

// A PASS here means "this is well-formed and legible". It says nothing about
// whether you should trust it, and the return value says so out loud.
export function qualityGate({ front, body, description, declared_id, inventory }) {
  const findings = [];
  const add = (result, code, message) => findings.push({ result, code, message });

  if (!front) add("FAIL", "NO_FRONTMATTER", "no YAML frontmatter — nothing declares what this skill is");
  if (!declared_id) add("FAIL", "NO_NAME", "frontmatter declares no name");
  if (!description) add("FAIL", "NO_DESCRIPTION", "frontmatter declares no description, so nothing can route to it");
  else if (description.length < 40) add("WARN", "THIN_DESCRIPTION", "the description is too short to be a reliable trigger");
  if (!/\bwhen\b|\buse (this|when)\b|\btrigger/i.test(description + body)) add("WARN", "NO_TRIGGER_CLARITY", "nothing states WHEN this skill applies");
  if (!/\bnot\b.*\buse\b|\bdo not use\b|\bnever use\b|\bnon-goals?\b/i.test(body)) add("WARN", "NO_NON_USE_CASES", "nothing states when this skill does NOT apply");
  if (body.length > 40000) add("WARN", "LARGE_FOOTPRINT", `${body.length} characters is a large prompt footprint to carry into every run`);
  if (!/\boutput\b|\breturn\b|\bformat\b|\breport\b/i.test(body)) add("WARN", "NO_OUTPUT_CONTRACT", "no output contract is described");

  if (PATTERNS.goal_loop.test(body)) add("FAIL", "UNCONTROLLED_LOOP", "instructs unbounded iteration — SCH owns iteration, and a skill that claims it conflicts with the scheduler");
  if (/\byou (may|can|should) (approve|merge|push|deploy|commit)\b/i.test(body)) add("FAIL", "UNSAFE_AUTHORITY_CLAIM", "claims authority to approve, merge, push, deploy or commit");
  if (PATTERNS.force_push.test(body)) add("FAIL", "FORCE_PUSH_POLICY_CONFLICT", "permits force push or --force-with-lease, both of which SCH forbids");
  if (/\bgit\s+add\s+(-A|\.)/i.test(body)) add("FAIL", "STAGING_POLICY_CONFLICT", "stages with `git add -A` or `git add .`, which SCH forbids");
  if (inventory.hooks.length) add("NEEDS_REVIEW", "SHIPS_HOOKS", `ships ${inventory.hooks.length} hook/settings file(s) that would run outside any task`);
  if (inventory.executables.length) add("NEEDS_REVIEW", "SHIPS_BINARIES", "ships binary executables, whose contents cannot be reviewed as text");
  if (inventory.network_references.length) add("NEEDS_REVIEW", "NETWORK_REFERENCES", `references ${inventory.network_references.length} network endpoint(s)`);
  if (/\b(gpt-4|gpt-5|o[1-9]\b|gemini|llama|mistral|claude-[a-z0-9-]+)\b/i.test(body)) add("NEEDS_REVIEW", "VENDOR_MODEL_ROUTING", "names specific models — model routing is SCH policy, not a skill's");

  const worst = findings.reduce((a, f) =>
    (["PASS", "WARN", "NEEDS_REVIEW", "FAIL"].indexOf(f.result) > ["PASS", "WARN", "NEEDS_REVIEW", "FAIL"].indexOf(a) ? f.result : a), "PASS");
  return {
    result: worst, findings,
    note: "a quality PASS means well-formed and legible. It is NOT approval, and it grants no trust.",
  };
}

// ------------------------------------------------- overlap + conflict detection

// Compare an external skill against everything already in the system. Nothing is
// merged, removed or rewritten — the output is a report for a person.
export function detectConflicts(id, { installed = [], procedures = [], roles = [], templates = [] } = {}) {
  const db = load();
  const skills = db.skills.filter((s) => id ? s.source_id === id : true);
  const out = [];

  for (const s of skills) {
    const overlaps = [], conflicts = [];
    const cap = new Set(s.capabilities ?? []);

    // Capability duplication against what is already installed.
    for (const inst of installed) {
      const shared = (inst.capabilities ?? []).filter((c) => cap.has(c));
      if (shared.length) overlaps.push({ with: inst.id, kind: "DUPLICATE_CAPABILITY", detail: `both claim: ${shared.join(", ")}` });
    }
    // Against SCH's own machinery. These are the ones that matter: a skill that
    // schedules, delivers or retries is competing with the engine, not helping it.
    if (cap.has("scheduling")) conflicts.push({ with: "SCH scheduler", kind: "SCHEDULER_OVERLAP",
      detail: "the skill claims iteration or scheduling authority; SCH's scheduler owns sequencing and retries" });
    if (cap.has("deploy")) conflicts.push({ with: "SCH delivery controller", kind: "DELIVERY_OVERLAP",
      detail: "the skill pushes or deploys; delivery is controller-only and cannot be performed by a worker" });
    if ((s.git_capabilities ?? []).includes("force push")) conflicts.push({ with: "SCH git policy", kind: "CONTRADICTORY_PUSH_POLICY",
      detail: "permits force push or --force-with-lease; SCH forbids both" });
    if (cap.has("worktree")) conflicts.push({ with: "SCH worktree milestone", kind: "NOT_YET_SUPPORTED",
      detail: "worktrees are not implemented in this milestone; the skill is reference-only" });
    for (const p of procedures) if ((p.capabilities ?? []).some((c) => cap.has(c)))
      overlaps.push({ with: `procedure:${p.id}`, kind: "PROCEDURE_OVERLAP", detail: "a deterministic procedure already covers this" });
    for (const r of roles) if ((r.capabilities ?? []).some((c) => cap.has(c)))
      overlaps.push({ with: `role:${r.role_id ?? r.id}`, kind: "ROLE_AMBIGUITY", detail: "a role already declares this capability" });
    // Two skills claiming the same trigger is a routing coin-flip.
    const twins = skills.filter((o) => o !== s && o.declared_name && o.declared_name === s.declared_name);
    for (const t of twins) overlaps.push({ with: t.skill_id, kind: "DUPLICATE_TRIGGER", detail: `both declare the name "${s.declared_name}"` });
    if (s.token_footprint_characters > 20000)
      overlaps.push({ with: "(prompt budget)", kind: "LARGE_DUPLICATED_BODY", detail: `${s.token_footprint_characters} characters would be carried into a prompt` });

    s.overlaps = overlaps; s.conflicts = conflicts;
    out.push({ skill_id: s.skill_id, source_id: s.source_id, risk_level: s.risk_level, overlaps, conflicts,
      recommendation: recommend(s, conflicts) });
  }
  save(db);
  return { ok: true, analysed: out.length, results: out };
}

function recommend(s, conflicts) {
  if (conflicts.some((c) => c.kind === "DELIVERY_OVERLAP")) return ["reference only", "never eligible for any worker role", "delivery stays controller-only"];
  if (conflicts.some((c) => c.kind === "SCHEDULER_OVERLAP")) return ["reference only", "never eligible for builder, repairer or scheduler execution"];
  if (conflicts.some((c) => c.kind === "NOT_YET_SUPPORTED")) return ["reference only until the worktree milestone"];
  if (s.risk_level === "CRITICAL") return ["explicit human approval required", "scope to the narrowest role that needs it"];
  if (s.risk_level === "HIGH") return ["human approval required", "consider read-only roles only"];
  return ["review and approve per role if useful"];
}

// -------------------------------------------------------- role-scoped approval

// Roles that may NEVER receive a skill of a given risk, whatever an operator
// types. A push skill on a builder is not a preference; it is the thing the
// delivery controller exists to prevent.
const NEVER_ELIGIBLE = {
  "push/deploy": ["builder", "repairer", "reviewer", "planner", "scout", "documenter"],
  scheduling: ["builder", "repairer", "reviewer", "planner", "scout", "documenter"],
  worktree: ["builder", "repairer", "reviewer", "planner", "scout", "documenter"],
};

export function reviewSkill(sourceId, skillId, { reviewer, notes = "" }) {
  const db = load();
  const s = db.skills.find((x) => x.source_id === sourceId && x.skill_id === skillId);
  if (!s) return fail("SKILL_NOT_FOUND", `no skill "${skillId}" from source "${sourceId}"`);
  if (!reviewer) return fail("REVIEWER_REQUIRED", "a review needs a named reviewer");
  s.reviewed_at = now(); s.reviewed_by = String(reviewer); s.review_notes = clamp(notes, 2000);
  db.reviews = [{ source_id: sourceId, skill_id: skillId, reviewer: String(reviewer), at: s.reviewed_at,
    content_hash: s.content_hash, source_commit: s.source_commit, risk_level: s.risk_level,
    quality: s.quality.result, notes: s.review_notes }, ...(db.reviews ?? [])].slice(0, 500);
  save(db);
  return { ok: true, skill: s };
}

export function approveSkill(sourceId, skillId, { approver, eligibleRoles = [], forbiddenRoles = [], contentHash = null, why = "" }) {
  const db = load();
  const s = db.skills.find((x) => x.source_id === sourceId && x.skill_id === skillId);
  if (!s) return fail("SKILL_NOT_FOUND", `no skill "${skillId}" from source "${sourceId}"`);
  if (!approver) return fail("APPROVER_REQUIRED", "an approval nobody signed is not an approval");
  // Approval binds to the exact content the approver read.
  if (contentHash && contentHash !== s.content_hash)
    return fail("CONTENT_CHANGED", `the skill's content hash is ${s.content_hash.slice(0, 12)}, not the ${String(contentHash).slice(0, 12)} you approved`);
  if (s.license_status === "NEEDS_DECISION")
    return fail("LICENSE_NEEDS_DECISION", `source "${sourceId}" has license "${s.license ?? "(none)"}", which this engine does not recognise. Approving somebody's prose into your pipeline is a licensing act — record a decision first.`);
  if (!s.reviewed_at) return fail("REVIEW_REQUIRED", `skill "${skillId}" has not been reviewed; a quality pass is not a review`);
  if (!eligibleRoles.length) return fail("ROLE_SCOPE_REQUIRED",
    "an approval must name the roles it applies to. Default eligibility is NOTHING — a skill approved for everything is a skill nobody scoped.");

  // The absolute refusals.
  for (const cap of s.git_capabilities ?? []) {
    const banned = NEVER_ELIGIBLE[cap];
    if (!banned) continue;
    const clash = eligibleRoles.filter((r) => banned.includes(r));
    if (clash.length) return fail("ROLE_FORBIDDEN_FOR_CAPABILITY",
      `skill "${skillId}" has the "${cap}" capability and can never be eligible for ${clash.join(", ")}. That authority belongs to the delivery controller and the scheduler, not to a worker.`);
  }
  if ((s.capabilities ?? []).includes("scheduling") && eligibleRoles.some((r) => ["builder", "repairer"].includes(r)))
    return fail("ROLE_FORBIDDEN_FOR_CAPABILITY", `skill "${skillId}" claims scheduling authority and can never be eligible for a worker role`);
  if (["CRITICAL", "HIGH"].includes(s.risk_level) && !why)
    return fail("HIGH_RISK_NEEDS_REASON", `skill "${skillId}" is ${s.risk_level} risk — record why it is being approved`);

  const approval = {
    schema_version: SCHEMA_VERSION,
    skill_id: skillId, source_id: sourceId, content_hash: s.content_hash, source_commit: s.source_commit,
    eligible_roles: [...new Set(eligibleRoles)], forbidden_roles: [...new Set(forbiddenRoles)],
    approver: String(approver), why: clamp(why, 1000), at: now(),
  };
  db.approvals = [approval, ...(db.approvals ?? []).filter((a) => !(a.skill_id === skillId && a.source_id === sourceId))];
  s.trust = "APPROVED"; s.approved_hash = s.content_hash; s.approved_commit = s.source_commit;
  save(db);
  return { ok: true, approval, skill: s };
}

export function disableSkill(sourceId, skillId, reason = "operator disabled") {
  const db = load();
  const s = db.skills.find((x) => x.source_id === sourceId && x.skill_id === skillId);
  if (!s) return fail("SKILL_NOT_FOUND", `no skill "${skillId}"`);
  s.trust = "DISABLED"; s.disabled_reason = clamp(reason, 300);
  db.approvals = (db.approvals ?? []).filter((a) => !(a.skill_id === skillId && a.source_id === sourceId));
  save(db);
  return { ok: true, skill: s };
}

// Is this skill eligible for this role, right now? The one question the runtime
// asks. Every failure mode returns a REASON, because "not eligible" with no
// explanation is how a capable skill silently never gets used.
export function eligibility(skillId, roleId, { db = null } = {}) {
  const d = db ?? load();
  const s = d.skills.find((x) => x.skill_id === skillId);
  if (!s) return { eligible: false, why: `no external skill "${skillId}"` };
  const src = d.sources.find((x) => x.id === s.source_id);
  if (!src?.enabled) return { eligible: false, why: `source "${s.source_id}" is disabled` };
  if (s.trust !== "APPROVED") return { eligible: false, why: `skill trust is ${s.trust}` };
  if (s.approved_hash !== s.content_hash)
    return { eligible: false, why: "the skill changed since it was approved — approval binds to content, so it lapsed" };
  if (s.approved_commit !== src.pinned_commit)
    return { eligible: false, why: `approved at source commit ${String(s.approved_commit).slice(0, 8)}, but the source is now pinned to ${String(src.pinned_commit).slice(0, 8)}` };
  const a = (d.approvals ?? []).find((x) => x.skill_id === skillId && x.source_id === s.source_id);
  if (!a) return { eligible: false, why: "no approval record" };
  if (a.forbidden_roles.includes(roleId)) return { eligible: false, why: `explicitly forbidden for role "${roleId}"` };
  if (!a.eligible_roles.includes(roleId)) return { eligible: false, why: `not approved for role "${roleId}" (approved for: ${a.eligible_roles.join(", ") || "nothing"})` };
  return { eligible: true, approval: a, content_hash: s.content_hash, source_commit: s.source_commit };
}

// ------------------------------------------------------------- update diff

// What would change if the pin moved. Reports; changes nothing, approves nothing.
export function updateDiff(id, newCommit) {
  const db = load();
  const s = db.sources.find((x) => x.id === id);
  if (!s) return fail("SOURCE_NOT_FOUND", `no source "${id}"`);
  if (!FULL_COMMIT.test(String(newCommit))) return fail("SOURCE_PIN_REQUIRED", "an update target must be a full 40-character commit hash");
  const dir = checkoutDir(id);
  if (!existsSync(join(dir, ".git"))) return fail("SOURCE_NOT_SYNCED", `source "${id}" has never been synced`);

  const fetched = git(dir, ["fetch", "--no-tags", "origin", String(newCommit)]);
  if (!fetched.ok && !git(dir, ["cat-file", "-e", `${newCommit}^{commit}`]).ok)
    return fail("SYNC_FAILED", `cannot fetch ${newCommit}: ${clamp(fetched.stderr, 300)}`);

  const names = git(dir, ["diff", "--name-status", s.pinned_commit, String(newCommit)]);
  if (!names.ok) return fail("DIFF_FAILED", clamp(names.stderr, 300));
  const changes = names.stdout.split("\n").filter(Boolean).map((l) => { const [st, ...r] = l.split("\t"); return { status: st, path: r.join("\t") }; });
  const affected = db.skills.filter((sk) => sk.source_id === id && changes.some((c) => c.path === sk.path || c.path.startsWith(dirname(sk.path) + "/")));

  return {
    ok: true, source: id, from: s.pinned_commit, to: String(newCommit),
    changes, changed_files: changes.length,
    affected_skills: affected.map((sk) => ({ skill_id: sk.skill_id, trust: sk.trust, path: sk.path })),
    approvals_that_would_lapse: affected.filter((sk) => sk.trust === "APPROVED").map((sk) => sk.skill_id),
    note: "nothing has changed. Moving the pin lapses every approval bound to the old commit; re-review and re-approve deliberately.",
  };
}

// --------------------------------------------------------------- projection

export function projection() {
  const db = load();
  return {
    schema_version: SCHEMA_VERSION,
    sources: db.sources.map((s) => ({
      id: s.id, repository: s.repository, pinned_commit: s.pinned_commit, synced_commit: s.synced_commit,
      license: s.license, license_status: s.license_status, enabled: s.enabled, auto_update: s.auto_update,
      synced_at: s.synced_at, source_hash: s.source_hash ? s.source_hash.slice(0, 16) : null,
      out_of_date: Boolean(s.synced_commit && s.synced_commit !== s.pinned_commit),
      skills: db.skills.filter((k) => k.source_id === s.id).length,
    })),
    skills: db.skills.map((k) => ({
      skill_id: k.skill_id, source_id: k.source_id, path: k.path, trust: k.trust,
      risk_level: k.risk_level, quality: k.quality?.result ?? null,
      content_hash: k.content_hash.slice(0, 16), source_commit: String(k.source_commit ?? "").slice(0, 8),
      changed_since_review: Boolean(k.changed_since_review),
      capabilities: k.capabilities, scripts: (k.scripts ?? []).length, hooks: (k.hooks ?? []).length,
      conflicts: (k.conflicts ?? []).length, overlaps: (k.overlaps ?? []).length,
      eligible_roles: (db.approvals ?? []).find((a) => a.skill_id === k.skill_id && a.source_id === k.source_id)?.eligible_roles ?? [],
    })),
    counts: {
      sources: db.sources.length, skills: db.skills.length,
      approved: db.skills.filter((k) => k.trust === "APPROVED").length,
      critical: db.skills.filter((k) => k.risk_level === "CRITICAL").length,
      conflicted: db.skills.filter((k) => (k.conflicts ?? []).length).length,
    },
    // Said in the payload, because a UI that grows an approve button without it
    // is how an unauthenticated page gains skill-trust authority.
    mutations_require_local_operator: true,
    generated_at: now(),
  };
}
