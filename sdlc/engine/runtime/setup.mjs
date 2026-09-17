// Onboard a project: probe which CLIs exist, seed roles.json from a preset catalogue, write the
// managed CLAUDE.md block, config, state, task.md and the two fence hooks. Idempotent; never writes
// outside the project unless --global is passed (which this build does not implement).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCLIs, fetchModels } from "./providers.mjs";

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Argv fragments per provider. Editable here and in the dashboard; the engine hard-codes nothing.
export const PRESETS = {
  claude: {
    base: ["claude"], model_arg: ["--model", "{model}"],
    bypass_permissions: ["--dangerously-skip-permissions"],
    read_only_tools: ["--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit"],
    stream_events: ["-p", "--output-format", "stream-json", "--verbose"],
    remote_control: ["--remote-control"],
  },
  codex: {
    base: ["codex", "exec"], model_arg: ["-m", "{model}"],
    read_only_sandbox: ["--sandbox", "read-only"],
    workspace_write: ["--sandbox", "workspace-write"],
    bypass_all: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  opencode: { base: ["opencode", "run"], model_arg: ["-m", "{model}"], json_events: ["--format", "json"] },
  gemini: { base: ["gemini"], model_arg: ["--model", "{model}"], auto_edit: ["--approval-mode", "auto_edit"], plan_only: ["--approval-mode", "plan"] },
  antigravity: { base: ["antigravity", "-p"], model_arg: null },
};

const withPresets = (provider, ...names) => {
  const p = PRESETS[provider];
  return [...p.base, ...names.flatMap(n => p[n] || [])];
};

export async function probeSeats() {
  const clis = await discoverCLIs({ fresh: true });
  const seen = new Map(clis.map(c => [c.id.replace(/^cli:/, ""), c]));
  const out = [];
  for (const provider of Object.keys(PRESETS)) {
    const hit = seen.get(provider);
    let models = [];
    if (hit) { try { models = (await fetchModels(hit.id)).map(m => m.id); } catch { models = []; } }
    out.push({ provider, available: !!hit, path: hit?.path || null, version: hit?.version || null, models });
  }
  return out;
}

// roles.json seeded from what is actually installed. Claude first when present (it is the only CLI
// here whose tool set can be restricted per-invocation, which is what reviewer and judge require).
export async function seedRoles(seats) {
  const have = p => seats.find(s => s.provider === p && s.available);
  const coder = have("claude") ? "claude" : (have("codex") ? "codex" : seats.find(s => s.available)?.provider);
  if (!coder) throw new Error("no agent CLI found on PATH — install one (claude, codex, opencode, gemini) and rerun");

  const exec = coder === "claude" ? withPresets("claude", "bypass_permissions", "stream_events")
    : coder === "codex" ? withPresets("codex", "workspace_write") : PRESETS[coder].base;
  const readOnly = coder === "claude" ? withPresets("claude", "bypass_permissions", "read_only_tools", "stream_events")
    : withPresets("codex", "read_only_sandbox");

  const councilRoles = [["architect", "claude"], ["skeptic", "codex"], ["pragmatist", "opencode"], ["critic", "antigravity"]];
  return {
    _comment: "Seed values. Everything here is editable from the dashboard Roles page; the engine hard-codes no model and no flag. model=null means the provider's own default.",
    _presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([n]) => n !== "base" && n !== "model_arg"))])),
    executor: { provider: coder, model: null, model_arg: PRESETS[coder].model_arg, spawn: exec, interactive_pane: coder === "claude" ? withPresets("claude", "bypass_permissions", "remote_control") : PRESETS[coder].base },
    reviewer: { provider: coder === "claude" ? "claude" : "codex", model: null, model_arg: PRESETS[coder === "claude" ? "claude" : "codex"].model_arg, spawn: readOnly },
    judge: { provider: coder === "claude" ? "claude" : "codex", model: null, model_arg: PRESETS[coder === "claude" ? "claude" : "codex"].model_arg, spawn: readOnly },
    council: councilRoles.map(([role, provider]) => ({
      role, provider, model: null, model_arg: PRESETS[provider].model_arg,
      spawn: provider === "claude" ? withPresets("claude", "bypass_permissions", "read_only_tools", "stream_events")
        : provider === "codex" ? withPresets("codex", "read_only_sandbox")
        : provider === "opencode" ? withPresets("opencode", "json_events")
        : provider === "gemini" ? withPresets("gemini", "plan_only") : PRESETS[provider].base,
      enabled: !!have(provider),
      ...(have(provider) ? {} : { _why: "not on PATH at setup time" }),
    })),
  };
}

export const CLAUDE_MD_START = "<!-- SCH-LOOP:PROJECT:START -->";
export const CLAUDE_MD_END = "<!-- SCH-LOOP:PROJECT:END -->";

export function managedBlock({ engineRel }) {
  return `${CLAUDE_MD_START}
# SCH-LOOP

This project runs the SCH-LOOP lifecycle. Say \`go\` to continue from durable state; nobody types skill names.

## Roles
- Orchestrator (this terminal): picks tickets, dispatches, reads reports. Writes \`task.md\`, \`.sch-loop/\`, docs. Never app source.
- Executor: fresh process per ticket, bypass permissions, confined to a worktree and the ticket's \`allowed_paths\`.
- Reviewer, Judge: fresh read-only processes. Council: gated, read-only.
- Manager: \`${engineRel}/runtime/cli.mjs\` — code decides PASS / RETRY / HUMAN. Retry cap 3.

## State
- \`task.md\` is the queue. Read top to bottom; first \`[ ]\` whose deps are \`[x]\` is next. Never renumber — insert with a suffix (\`T1.4a-slug\`).
- \`.sch-loop/state.json\` is the machine index. If it disagrees with \`task.md\`, \`task.md\` wins.
- Stage files: \`.sch-loop/{BRAINSTORM,PRD,ARCHITECTURE,PLAN}.md\`.

## Fences (bypass mode refuses to start without all three)
1. worktree per ticket, write-outside detection
2. \`.claude/hooks/write-guard.mjs\`
3. \`.claude/hooks/destructive-bash.mjs\` — package installs are a \`human\` ticket

## \`go\`
Routine continuation inside approved scope. Never authorization for destructive operations, credentials, or scope expansion.
${CLAUDE_MD_END}`;
}

// Replace the managed block if present, append otherwise. Unrelated content is never touched.
export function upsertManagedBlock(existing, block) {
  const s = existing || "";
  const i = s.indexOf(CLAUDE_MD_START), j = s.indexOf(CLAUDE_MD_END);
  if (i >= 0 && j > i) return s.slice(0, i) + block + s.slice(j + CLAUDE_MD_END.length);
  return (s.trimEnd() + (s.trim() ? "\n\n" : "") + block + "\n");
}

export const DEFAULT_CONFIG = seats => `# SCH-LOOP Project Configuration

owner: SCH-LOOP
loop: sdlc
autonomous_mode: enabled
user_control_word: go
state_file: .sch-loop/state.json
task_file: task.md
roles_file: .sch-loop/roles.json
engine: .claude/sch
transport: herdr
executor_permission: bypass
max_code_executors: 1
max_executor_attempts: 3
max_review_rounds: 3
council_mode: gated
council_minimum_seats: 2
context_soft_limit: 100000
context_hard_limit: 130000
require_tdd_for_behavior_changes: true
require_independent_review: true
require_fresh_evidence: true
timeouts_minutes: { XS: 5, S: 15, M: 30, L: 60 }
silence_nudge_seconds: 120
rate_limit_backoff_minutes: [1, 2, 4, 8]
protected_paths:
  - .sch-loop/private/**
  - .claude/sch/**
  - .claude/hooks/**
  - .env*
  - "**/*.pem"

## Notes

- Live seats at setup time: ${seats.filter(s => s.available).map(s => s.provider).join(", ") || "none"}.
- Bypass mode starts only when all three fences hold.
- Council is gated: architecture approval, plan approval, \`council:true\` tickets, two consecutive reds, phase-verify failure.
`;

const TASK_MD = `# task.md
<!-- SCH-LOOP:TASKS — read top to bottom. Never renumber. Insert = suffix (T1.4a-slug). -->
<!-- [ ] pending  [~] in progress  [x] done  [!] blocked  [?] needs human -->
<!-- line: - [status] ID-slug  type  Title  deps:ID,ID|-  size:XS|S|M|L  [council:true] [gate:blocking-human] -->

(empty — written by sch-tickets after brainstorm → prd → architecture → plan)
`;

const SETTINGS = {
  hooks: {
    PreToolUse: [
      { matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/write-guard.mjs"', timeout: 5 }] },
      { matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/destructive-bash.mjs"', timeout: 5 }] },
    ],
  },
  permissions: { deny: ["Read(./.sch-loop/private/**)", "Read(./.env)", "Read(./.env.*)"] },
};

const w = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };

export async function setupProject({ projectRoot, force = false }) {
  const seats = await probeSeats();
  const roles = await seedRoles(seats);
  const written = [], skipped = [];
  const put = (rel, body, overwrite = false) => {
    const f = path.join(projectRoot, rel);
    if (fs.existsSync(f) && !overwrite && !force) { skipped.push(rel); return; }
    w(f, body); written.push(rel);
  };

  for (const d of ["tickets", "briefs", "reports", "reviews", "evidence", "council", "private", "debug"]) fs.mkdirSync(path.join(projectRoot, ".sch-loop", d), { recursive: true });
  put(".sch-loop/roles.json", JSON.stringify(roles, null, 2) + "\n");
  put(".sch-loop/config.md", DEFAULT_CONFIG(seats));
  put(".sch-loop/state.json", JSON.stringify({ schema_version: 1, project_status: "READY", lifecycle_stage: "BRAINSTORM", current_phase: null, current_task: null, current_role: null, attempt: 0, active_jobs: {}, last_event: "PROJECT_SETUP", updated_at: new Date().toISOString() }, null, 2) + "\n");
  put("task.md", TASK_MD);

  // Install the engine itself. Without this the managed CLAUDE.md block points at an empty directory,
  // `checkFences` finds no hooks and refuses every ticket, and the project cannot run a single thing —
  // which is exactly what setup produced before: seven files, none of them executable. The old hook copy
  // read from `<engine>/../hooks`, a path that has never existed, so it silently copied nothing.
  //
  // These are overwritten on every setup, `force` or not. They are not the project's files to edit; they
  // belong to this engine and are installed here. A project quietly running a hand-patched fence is a
  // worse outcome than one losing a local change it should never have made.
  const install = (srcDir, destRel) => {
    if (!fs.existsSync(srcDir)) throw new Error(`engine is incomplete: ${srcDir} is missing`);
    const dest = path.join(projectRoot, destRel);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(srcDir, dest, { recursive: true });
    written.push(`${destRel}/ (${fs.readdirSync(dest).length} entries)`);
  };
  install(path.join(ENGINE, "runtime"), ".claude/sch/runtime");
  install(path.join(ENGINE, "scripts"), ".claude/sch/scripts");
  install(path.join(ENGINE, "hooks"), ".claude/hooks");
  install(path.join(ENGINE, "skills"), ".claude/skills");
  // Merge rather than replace: a project may have hooks and permissions of its own and setup has no
  // right to drop them. But both fences must end up wired whatever was there before, and an unreadable
  // settings file is refused rather than silently clobbered.
  const sf = path.join(projectRoot, ".claude", "settings.json");
  let cur = {};
  if (fs.existsSync(sf)) {
    try { cur = JSON.parse(fs.readFileSync(sf, "utf8")); }
    catch (e) { throw new Error(`.claude/settings.json is not valid JSON (${e.message}) — fix or delete it; setup will not overwrite a file it cannot read`); }
  }
  const settingsBefore = JSON.stringify(cur);
  cur.hooks = cur.hooks || {};
  const pre = (cur.hooks.PreToolUse = cur.hooks.PreToolUse || []);
  for (const entry of SETTINGS.hooks.PreToolUse) {
    const name = entry.hooks[0].command.match(/([\w-]+)\.mjs/)[1];
    if (!pre.some(e => JSON.stringify(e).includes(name))) pre.push(entry);
  }
  cur.permissions = cur.permissions || {};
  cur.permissions.deny = [...new Set([...(cur.permissions.deny || []), ...SETTINGS.permissions.deny])];
  if (JSON.stringify(cur) !== settingsBefore) { w(sf, JSON.stringify(cur, null, 2) + "\n"); written.push(".claude/settings.json"); }
  else skipped.push(".claude/settings.json");

  const cmd = path.join(projectRoot, "CLAUDE.md");
  const block = managedBlock({ engineRel: ".claude/sch" });
  const before = fs.existsSync(cmd) ? fs.readFileSync(cmd, "utf8") : "";
  const after = upsertManagedBlock(before, block);
  if (after !== before) { w(cmd, after); written.push("CLAUDE.md (managed block)"); } else skipped.push("CLAUDE.md");

  const gi = path.join(projectRoot, ".gitignore");
  const lines = [".sch-loop/private/", ".sch-loop/evidence/", ".sch-loop/heartbeat", ".sch-loop/events.jsonl", ".worktrees/"];
  const giBefore = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  const missing = lines.filter(l => !giBefore.split(/\r?\n/).includes(l));
  if (missing.length) { w(gi, giBefore.trimEnd() + (giBefore.trim() ? "\n" : "") + missing.join("\n") + "\n"); written.push(".gitignore"); }

  // Prove the project can actually run before reporting success. Setup used to return a tidy list of
  // seven written files for a project that could not execute one ticket.
  const checks = verifyInstall(projectRoot);
  const broken = checks.filter(c => !c.ok);

  return {
    seats,
    roles: { executor: roles.executor.provider, reviewer: roles.reviewer.provider, council: roles.council.filter(c => c.enabled).map(c => `${c.role}:${c.provider}`) },
    written, skipped,
    ok: broken.length === 0,
    checks,
    ...(broken.length ? { error: `setup finished but the project is not runnable: ${broken.map(c => c.name).join(", ")}` } : {}),
  };
}

// What has to be true for `cli.mjs run` to work in this project. Every line here is something that was
// silently absent from a setup that reported success.
export function verifyInstall(projectRoot) {
  const has = rel => fs.existsSync(path.join(projectRoot, rel));
  const read = rel => { try { return fs.readFileSync(path.join(projectRoot, rel), "utf8"); } catch { return ""; } };
  const readJson = rel => { try { return JSON.parse(read(rel)); } catch { return null; } };
  const wired = JSON.stringify(readJson(".claude/settings.json")?.hooks?.PreToolUse || []);
  const roles = readJson(".sch-loop/roles.json");
  const skills = has(".claude/skills") ? fs.readdirSync(path.join(projectRoot, ".claude", "skills")) : [];
  return [
    { name: "engine cli installed", ok: has(".claude/sch/runtime/cli.mjs") },
    { name: "write-guard hook on disk", ok: has(".claude/hooks/write-guard.mjs") },
    { name: "destructive-bash hook on disk", ok: has(".claude/hooks/destructive-bash.mjs") },
    { name: "both fences wired in settings", ok: /write-guard\.mjs/.test(wired) && /destructive-bash\.mjs/.test(wired) },
    { name: "skills installed", ok: skills.length > 0, detail: `${skills.length} skill(s)` },
    { name: "roles.json has executor, reviewer and judge", ok: !!(roles?.executor?.spawn && roles?.reviewer?.spawn && roles?.judge?.spawn) },
    { name: "task.md exists", ok: has("task.md") },
    // The marker comes from the constant that writes it. Spelling it out here as a literal is how this
    // check came to look for a string no version of the writer has ever produced.
    { name: "CLAUDE.md carries the managed block", ok: read("CLAUDE.md").includes(CLAUDE_MD_START) },
  ];
}
