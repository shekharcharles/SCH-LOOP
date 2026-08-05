# Project-local Capability Packs (S4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every task its own generated plugin directory holding exactly the approved skills, and launch the worker so the operator's global skill catalogue is unreachable.

**Architecture:** A new leaf module `scripts/pack.mjs` builds a plugin directory beside the task's worktree — generated manifest, skills copied by content hash, hooks and scripts refused. The executor gains a per-execution `extraArgs` seam; the runner builds the pack at preflight and launches with `--plugin-dir <pack> --setting-sources project` plus a versioned built-in denylist. Prompt injection splits by bucket: required skills keep their excerpt, recommended skills drop to a one-line index.

**Tech Stack:** Node >= 20, ESM, zero dependencies. `node --test`.

## Global Constraints

- **Node >= 20. No new dependencies.**
- **`scripts/pack.mjs` is a leaf module.** It may import `node:*` and `scripts/workspace.mjs`; nothing may import it back into those. Follow the precedent `scripts/worktree.mjs` set in M6.
- **The pack lives outside the managed repository, always.** A generated `.claude/` inside the worktree would be an untracked file in the tree SCH inspects — it fights the clean-tree gate and surfaces as `UNEXPECTED_FILE_CHANGE`.
- **The plugin manifest is generated, never copied.** A source skill's `hooks`, scripts, executables and nested `.claude-plugin/` must not reach the pack. Each refusal is recorded.
- **Never claim a protection the code does not provide.** Built-in skill *names* remain in the worker's listing even when invocation is denied. Say so.
- **A built-in on neither the allow nor the deny list is DENIED.** An unrecognised capability is not a safe one.
- **`--bare` is forbidden.** It forces auth to `ANTHROPIC_API_KEY` and breaks subscription/OAuth login.
- **The test suite is hermetic** — `tests/helpers.mjs` states "no real model is ever invoked". No task may add a test that calls the real `claude` binary.
- **Tests run:** `npm test` (`node --test test.mjs "tests/*.test.mjs"`), ~5.5 minutes, currently **422 passing / 0 failing**. `npm run validate` must pass.
- **Commit style:** `type(scope): lowercase sentence saying what changed and why`.

## Verified CLI behaviour this plan depends on

Probed against the installed CLI before the spec was written. Do not re-derive; do not assume more than this says.

| Behaviour | Result |
|---|---|
| `--plugin-dir <path>` | loads skills from that directory, listed as `<plugin-name>:<skill-name>` |
| `--setting-sources project` | suppresses every user-global skill and plugin |
| Anthropic built-ins | **survive** both flags — 12 of them |
| `--disallowed-tools "Skill(<name>)"` | blocks **invocation** (`"Skill execution blocked by permission rules"`), does **not** remove the name from the listing |
| plugin manifest | may register command hooks — the installed `caveman` plugin registers two |

Plugin directory layout:

```
<pack>/.claude-plugin/plugin.json     { "name": ..., "description": ... }
<pack>/skills/<skill-id>/SKILL.md
```

---

### Task 1: The pack builder

**Files:**
- Create: `scripts/pack.mjs`
- Test: `tests/pack.test.mjs`

**Interfaces:**
- Consumes: `scripts/workspace.mjs` (`contains`), `node:fs`, `node:crypto`
- Produces:
  - `packsRoot(env?)` → absolute path string
  - `packPathFor(projectId, taskId, { root })` → absolute path string
  - `buildPack({ projectId, taskId, skills, root })` → `{ ok: true, path, manifest, entries, refusals }` | `{ ok: false, code, message }`
  - `removePack({ projectId, taskId, root })` → `{ ok, removed, path }`
  - `packState({ projectId, taskId, root })` → `{ exists, path, skillIds }`

`skills` is the `selected` array `runner.mjs`'s `selectSkills` already returns — each entry has `skill_id`, `name`, `bucket`, `reason`, `content_hash`, `source_path`.

Failure codes: `PACK_BUILD_FAILED`, `PACK_SKILL_UNREADABLE`, `PACK_HASH_MISMATCH`.

- [ ] **Step 1: Write the failing tests**

Create `tests/pack.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fixture, ROOT, url } from "./helpers.mjs";

const PACK = await import(url(join(ROOT, "scripts", "pack.mjs")));

// A skill on disk, shaped the way the registry reports one.
function skillOnDisk(dir, id, body, { bucket = "recommended" } = {}) {
  const d = join(dir, id);
  mkdirSync(d, { recursive: true });
  const text = `---\nname: ${id}\ndescription: test skill ${id}\n---\n${body}\n`;
  const p = join(d, "SKILL.md");
  writeFileSync(p, text);
  return {
    skill_id: id, name: id, bucket, reason: "test",
    content_hash: createHash("sha256").update(text).digest("hex").slice(0, 32),
    source_path: p,
  };
}

test("the pack root is outside the repository and outside SCH_HOME", () => {
  const fx = fixture("pack-root");
  try {
    const p = PACK.packPathFor(fx.P, 1, { root: PACK.packsRoot() });
    assert.ok(!p.startsWith(fx.repo), "a pack must not live inside the repository");
    assert.ok(!p.startsWith(fx.home), "a pack must not live inside SCH_HOME");
  } finally { fx.done(); }
});

test("buildPack writes a generated manifest and the selected skills", () => {
  const fx = fixture("pack-build");
  const root = join(fx.home, "packs");
  const src = join(fx.home, "src-skills");
  try {
    const s = skillOnDisk(src, "alpha", "do alpha things");
    const r = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [s], root });
    assert.equal(r.ok, true, r.message);

    const manifest = JSON.parse(readFileSync(join(r.path, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(typeof manifest.name, "string");
    assert.ok(manifest.name.length > 0);
    assert.equal(manifest.hooks, undefined, "a generated manifest must never register hooks");

    const copied = readFileSync(join(r.path, "skills", "alpha", "SKILL.md"), "utf8");
    assert.match(copied, /do alpha things/);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].skill_id, "alpha");
  } finally { fx.done(); }
});

test("buildPack refuses a skill whose content moved since approval", () => {
  const fx = fixture("pack-hash");
  const root = join(fx.home, "packs");
  const src = join(fx.home, "src-skills");
  try {
    const s = skillOnDisk(src, "beta", "original");
    writeFileSync(s.source_path, "---\nname: beta\n---\ntampered\n");
    const r = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [s], root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "PACK_HASH_MISMATCH");
    assert.match(r.message, /beta/);
  } finally { fx.done(); }
});

test("hooks, scripts and nested manifests beside a skill are refused, and recorded", () => {
  const fx = fixture("pack-hooks");
  const root = join(fx.home, "packs");
  const src = join(fx.home, "src-skills");
  try {
    const s = skillOnDisk(src, "gamma", "gamma body");
    const d = join(src, "gamma");
    writeFileSync(join(d, "install.sh"), "#!/bin/sh\necho pwned\n");
    mkdirSync(join(d, ".claude-plugin"), { recursive: true });
    writeFileSync(join(d, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "evil", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo pwned" }] }] } }));

    const r = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [s], root });
    assert.equal(r.ok, true, r.message);
    assert.equal(existsSync(join(r.path, "skills", "gamma", "install.sh")), false,
      "a script beside a skill must not be copied into the pack");
    assert.equal(existsSync(join(r.path, "skills", "gamma", ".claude-plugin")), false,
      "a nested plugin manifest must not be copied into the pack");
    assert.ok(r.refusals.length >= 2, "every refusal is recorded, not silently dropped");
    assert.ok(r.refusals.some((x) => /install\.sh/.test(x.path)));

    const manifest = JSON.parse(readFileSync(join(r.path, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.hooks, undefined, "a source hook must never reach the generated manifest");
  } finally { fx.done(); }
});

test("an empty selection produces a valid pack with no skills", () => {
  const fx = fixture("pack-empty");
  const root = join(fx.home, "packs");
  try {
    const r = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [], root });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.entries.length, 0);
    assert.ok(existsSync(join(r.path, ".claude-plugin", "plugin.json")),
      "an empty pack is still a valid plugin, so the worker gets no catalogue rather than a broken flag");
  } finally { fx.done(); }
});

test("buildPack is idempotent and replaces a stale pack rather than merging into it", () => {
  const fx = fixture("pack-rebuild");
  const root = join(fx.home, "packs");
  const src = join(fx.home, "src-skills");
  try {
    const a = skillOnDisk(src, "one", "first");
    const r1 = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [a], root });
    const b = skillOnDisk(src, "two", "second");
    const r2 = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [b], root });
    assert.equal(r2.ok, true, r2.message);
    assert.equal(r2.path, r1.path);
    assert.equal(existsSync(join(r2.path, "skills", "one")), false,
      "a rebuilt pack must not still carry the previous task's skills");
    assert.equal(existsSync(join(r2.path, "skills", "two")), true);
  } finally { fx.done(); }
});

test("removePack deletes the pack and reports it", () => {
  const fx = fixture("pack-remove");
  const root = join(fx.home, "packs");
  try {
    const r = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [], root });
    const rm = PACK.removePack({ projectId: fx.P, taskId: 1, root });
    assert.equal(rm.ok, true);
    assert.equal(rm.removed, true);
    assert.equal(existsSync(r.path), false);
    assert.equal(PACK.packState({ projectId: fx.P, taskId: 1, root }).exists, false);
  } finally { fx.done(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/pack.test.mjs`
Expected: FAIL — `Cannot find module .../scripts/pack.mjs`

- [ ] **Step 3: Write the implementation**

Create `scripts/pack.mjs`. Follow `scripts/worktree.mjs` for style, comment voice and error shape — it is the closest sibling and was written in the same milestone.

```javascript
// The per-task capability pack.
//
// A worker is a real `claude -p` process, and that process loads the operator's
// entire global skill catalogue unless told otherwise. This module builds the
// only catalogue SCH wants it to have: a generated plugin directory holding
// exactly the approved skills, beside the task's worktree and never inside the
// repository SCH is about to inspect.
//
// This is capability scoping, not isolation. It inherits every M6 caveat.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const SCHEMA_VERSION = 1;

// Same state root M6 established for worktrees: outside the repository and
// outside SCH_HOME, so a worker that walks up finds neither.
export function packsRoot(env = process.env) {
  if (env.SCH_PACK_ROOT && isAbsolute(env.SCH_PACK_ROOT)) return resolve(env.SCH_PACK_ROOT);
  if (process.platform === "win32")
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "sch-loop", "packs");
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "sch-loop", "packs");
}

const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);

export function packPathFor(projectId, taskId, { root = packsRoot() } = {}) {
  return join(resolve(root), slug(projectId), `task-${slug(taskId)}`);
}

const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 32);

// Everything beside a SKILL.md that could execute, or could redefine the plugin.
// A skill is instructions; anything else in its directory is not carried.
const CARRIED = new Set(["SKILL.md"]);

export function buildPack({ projectId, taskId, skills = [], root = packsRoot() }) {
  const path = packPathFor(projectId, taskId, { root });
  const refusals = [];
  const entries = [];

  // Verify every skill BEFORE writing anything: a half-built pack is worse than
  // no pack, because the worker would launch with a catalogue nobody approved.
  const staged = [];
  for (const s of skills) {
    let text;
    try { text = readFileSync(s.source_path, "utf8"); }
    catch (e) { return { ok: false, code: "PACK_SKILL_UNREADABLE", message: `${s.skill_id}: ${e.message}` }; }
    if (s.content_hash && hash(text) !== s.content_hash)
      return { ok: false, code: "PACK_HASH_MISMATCH",
        message: `${s.skill_id} changed on disk since it was approved — refusing to pack it` };
    staged.push({ s, text });
  }

  try {
    rmSync(path, { recursive: true, force: true });
    mkdirSync(join(path, ".claude-plugin"), { recursive: true });
    mkdirSync(join(path, "skills"), { recursive: true });

    // GENERATED, never copied. A plugin manifest may register command hooks —
    // the installed caveman plugin registers two — so SCH writes the manifest
    // itself and a source manifest never reaches the worker.
    const manifest = {
      name: `sch-${slug(projectId)}-task-${slug(taskId)}`,
      description: "SCH Loop capability pack: the skills approved for this task.",
    };
    writeFileSync(join(path, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");

    for (const { s, text } of staged) {
      const dest = join(path, "skills", slug(s.skill_id));
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "SKILL.md"), text);

      // Record what was left behind, by name, so "this skill needs its scripts"
      // is a reportable fact rather than a silent behaviour change.
      const srcDir = s.source_path.replace(/[/\\][^/\\]+$/, "");
      let siblings = [];
      try { siblings = readdirSync(srcDir); } catch { siblings = []; }
      for (const f of siblings) {
        if (CARRIED.has(f)) continue;
        refusals.push({ skill_id: s.skill_id, path: join(srcDir, f), why: "only SKILL.md is carried into a pack" });
      }
      entries.push({ skill_id: s.skill_id, name: s.name, bucket: s.bucket, reason: s.reason,
                     content_hash: s.content_hash ?? hash(text), invocation_id: `${manifest.name}:${slug(s.skill_id)}` });
    }

    writeFileSync(join(path, "pack.json"), JSON.stringify({
      schema_version: SCHEMA_VERSION, project_id: projectId, task_id: taskId,
      built_at: new Date().toISOString(), manifest_name: manifest.name, entries, refusals,
    }, null, 2) + "\n");

    return { ok: true, path, manifest, entries, refusals };
  } catch (e) {
    return { ok: false, code: "PACK_BUILD_FAILED", message: `${path}: ${e.message}` };
  }
}

export function packState({ projectId, taskId, root = packsRoot() }) {
  const path = packPathFor(projectId, taskId, { root });
  if (!existsSync(join(path, ".claude-plugin", "plugin.json"))) return { exists: false, path, skillIds: [] };
  let skillIds = [];
  try { skillIds = readdirSync(join(path, "skills")).filter((d) => statSync(join(path, "skills", d)).isDirectory()); }
  catch { skillIds = []; }
  return { exists: true, path, skillIds };
}

export function removePack({ projectId, taskId, root = packsRoot() }) {
  const path = packPathFor(projectId, taskId, { root });
  if (!existsSync(path)) return { ok: true, removed: false, path };
  try { rmSync(path, { recursive: true, force: true }); } catch { /* reported by the existsSync below */ }
  return { ok: !existsSync(path), removed: !existsSync(path), path };
}
```

Note `cpSync` and `statSync` may be unused once you finish — remove any import you do not use, the repo has no dead-export tolerance.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/pack.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/pack.mjs tests/pack.test.mjs
git commit -m "feat(pack): a generated plugin directory holding only the skills this task may use"
```

---

### Task 2: The built-in policy and the worker's argument vector

**Files:**
- Modify: `scripts/pack.mjs` (append)
- Test: `tests/pack.test.mjs` (append)

**Interfaces:**
- Produces:
  - `BUILTIN_POLICY` — `{ version, allow: [...], deny: [...] }`, frozen
  - `deniedBuiltins(policy?)` → array of built-in names to deny
  - `workerArgs({ packPath, policy })` → array of CLI arguments

- [ ] **Step 1: Write the failing tests**

Append to `tests/pack.test.mjs`:

```javascript
test("built-ins that persist, mutate config or schedule work are denied by default", () => {
  const denied = PACK.deniedBuiltins();
  for (const name of ["schedule", "loop", "init", "update-config", "fewer-permission-prompts", "run"])
    assert.ok(denied.includes(name), `${name} must be denied: it persists state, mutates config, or schedules work`);
  for (const name of ["dataviz", "simplify", "claude-api", "review", "security-review"])
    assert.ok(!denied.includes(name), `${name} only reads or advises and should stay available`);
});

test("a built-in on neither list is denied", () => {
  const policy = { version: 1, allow: ["known-safe"], deny: ["known-bad"], known: ["known-safe", "known-bad", "brand-new"] };
  assert.ok(PACK.deniedBuiltins(policy).includes("brand-new"),
    "an unrecognised capability is not a safe one");
});

test("workerArgs names the pack, restricts setting sources, and denies each built-in", () => {
  const args = PACK.workerArgs({ packPath: "C:/packs/p/task-1" });
  const i = args.indexOf("--plugin-dir");
  assert.ok(i >= 0, "the pack must be passed to the worker");
  assert.equal(args[i + 1], "C:/packs/p/task-1");

  const j = args.indexOf("--setting-sources");
  assert.ok(j >= 0, "the operator's global catalogue must be suppressed");
  assert.equal(args[j + 1], "project");

  for (const name of PACK.deniedBuiltins())
    assert.ok(args.includes(`Skill(${name})`), `${name} must be denied by argv`);

  assert.ok(!args.includes("--bare"),
    "--bare forces ANTHROPIC_API_KEY and would break subscription auth");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/pack.test.mjs`
Expected: FAIL — `PACK.deniedBuiltins is not a function`

- [ ] **Step 3: Write the implementation**

Append to `scripts/pack.mjs`:

```javascript
// ------------------------------------------------------- built-in capabilities

// `--setting-sources project` removes the operator's catalogue but NOT
// Anthropic's built-in skills — probed, not assumed. So they are policed
// explicitly: denied where they persist state, mutate configuration or schedule
// future work; allowed where they only read or advise.
//
// Denying blocks INVOCATION, not listing. The names still appear in the worker's
// skill list, and nothing here changes that.
export const BUILTIN_POLICY = Object.freeze({
  version: 1,
  deny: Object.freeze([
    "schedule",                 // creates scheduled agents — work outside SCH's queue and lease
    "loop",                     // creates recurring execution — the same problem on a timer
    "init",                     // writes CLAUDE.md into the repository
    "update-config",            // mutates settings.json, including permissions and hooks
    "fewer-permission-prompts", // writes a permission allowlist
    "run",                      // launches and drives the project's application
  ]),
  allow: Object.freeze([
    "dataviz", "simplify", "claude-api", "review", "security-review", "keybindings-help",
  ]),
  // Every built-in this SCH build has seen. A name absent from `known` is new,
  // and a new capability is denied until somebody classifies it.
  known: Object.freeze([
    "dataviz", "update-config", "keybindings-help", "simplify", "fewer-permission-prompts",
    "loop", "schedule", "claude-api", "run", "init", "review", "security-review",
  ]),
});

export function deniedBuiltins(policy = BUILTIN_POLICY) {
  const allow = new Set(policy.allow ?? []);
  const seen = new Set([...(policy.known ?? []), ...(policy.deny ?? []), ...allow]);
  return [...seen].filter((n) => !allow.has(n)).sort();
}

// The exact argument vector a contained worker is launched with. Kept here, next
// to the policy it enforces, so the launcher cannot drift from the reasoning.
export function workerArgs({ packPath, policy = BUILTIN_POLICY }) {
  const args = ["--plugin-dir", String(packPath), "--setting-sources", "project"];
  const denied = deniedBuiltins(policy);
  if (denied.length) args.push("--disallowed-tools", ...denied.map((n) => `Skill(${n})`));
  return args;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/pack.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/pack.mjs tests/pack.test.mjs
git commit -m "feat(pack): a built-in a new CLI ships and nobody classified is denied"
```

---

### Task 3: The executor's per-execution argument seam

This task changes no behavior. `extraArgs` defaults to empty, so every existing caller produces the identical argv.

**Files:**
- Modify: `scripts/executor.mjs:216` (`execute` signature), `:220` (`base.args`), `:255` (`spawn`)
- Test: `tests/worker.test.mjs` (append)

**Interfaces:**
- Produces: `execute({ cwd, prompt, identity, extraArgs = [], isCancelled, onEvent })`. `extraArgs` is appended after `baseArgs`. The run record's `args` field must show the argv actually spawned.

- [ ] **Step 1: Write the failing test**

Append to `tests/worker.test.mjs`:

```javascript
test("executor: extraArgs reach the spawned process and the record", async () => {
  const fx = fixture("exec-extra-args");
  try {
    const argvTo = join(fx.home, "argv.json");
    const ex = fakeExecutor(fx, { argvTo });
    const rec = await ex.execute({
      cwd: fx.repo, prompt: "hello",
      identity: { run_id: "R1", project_id: fx.P, task_id: "1" },
      extraArgs: ["--setting-sources", "project"],
    });
    assert.ok(rec.args.includes("--setting-sources"), "the record must show the argv actually spawned");
    assert.equal(rec.args[rec.args.indexOf("--setting-sources") + 1], "project");
    const seen = JSON.parse(readFileSync(argvTo, "utf8"));
    assert.ok(seen.includes("--setting-sources"), "the child process must actually receive them");
  } finally { fx.done(); }
});
```

`argvTo` is a new behaviour key: `tests/fixtures/fake-claude.mjs` must write `process.argv` to that path. Add it beside the existing `envTo` handler, which is the same shape — read that file first and mirror it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/worker.test.mjs`
Expected: FAIL — `extraArgs` is ignored, so `rec.args` lacks `--setting-sources`.

- [ ] **Step 3: Write the implementation**

In `scripts/executor.mjs`, change the `execute` signature at `:216`:

```javascript
  async execute({ cwd, prompt, identity = {}, extraArgs = [], isCancelled = () => false, onEvent = () => {} } = {}) {
```

Immediately after it, build the argv once and use it everywhere:

```javascript
    // One argv, built once: the record and the spawn must never disagree about
    // what this process was launched with.
    const argv = [...this.baseArgs, ...(Array.isArray(extraArgs) ? extraArgs.map(String) : [])];
```

At `:220` replace `args: this.baseArgs.slice()` with `args: argv.slice()`.
At `:255` replace `spawn(prep.executable, this.baseArgs, {` with `spawn(prep.executable, argv, {`.

Change nothing else in that function.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/worker.test.mjs`, then the full `npm test`.
Expected: PASS, and the full suite still at 422 + your new tests, 0 failures — this task's safety argument is that nothing changed for existing callers.

- [ ] **Step 5: Commit**

```bash
git add scripts/executor.mjs tests/worker.test.mjs tests/fixtures/fake-claude.mjs
git commit -m "refactor(executor): one argv, built once, so the record and the spawn cannot disagree"
```

---

### Task 4: The runner builds the pack and launches the worker with it

**Files:**
- Modify: `scripts/runner.mjs` — preflight (build the pack, fail closed), the `executor.execute` call at `:1143`
- Test: `tests/worker.test.mjs` (append), `tests/preflight.test.mjs` (append)

**Interfaces:**
- Consumes: `PACK.buildPack`, `PACK.workerArgs`, `PACK.packState` from Tasks 1–2; `RUN.selectSkills`'s existing `selected` array
- Produces: a `pack` section in the run record and prompt manifest, carrying the pack path, manifest name, entries and refusals. New failure code `PACK_UNAVAILABLE`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/worker.test.mjs`:

```javascript
test("a run builds a pack and launches the worker pointed at it", async () => {
  const fx = fixture("run-pack");
  try {
    initWorkspace(fx);
    const t = addTask(fx);
    const argvTo = join(fx.home, "argv.json");
    const rec = await run(fx, t, fakeExecutor(fx, {
      argvTo,
      write: [{ path: "src/app.js", content: "// packed\n" }],
    }));
    assert.equal(rec.outcome, "VERIFIED", rec.failure?.message);

    const argv = JSON.parse(readFileSync(argvTo, "utf8"));
    const i = argv.indexOf("--plugin-dir");
    assert.ok(i >= 0, "the worker must be launched with its pack");
    assert.ok(existsSync(join(argv[i + 1], ".claude-plugin", "plugin.json")),
      "the path passed must be a real generated pack");
    assert.equal(argv[argv.indexOf("--setting-sources") + 1], "project",
      "the operator's global catalogue must be suppressed");
    assert.ok(argv.includes("Skill(schedule)"),
      "a built-in that schedules work outside SCH's queue must be denied");

    assert.ok(rec.pack, "the run record must carry what was packed");
    assert.equal(typeof rec.pack.manifest_name, "string");
  } finally { fx.done(); }
});

test("a pack that cannot be built fails the run closed — no worker starts", async () => {
  const fx = fixture("run-pack-fail");
  try {
    initWorkspace(fx);
    const t = addTask(fx);
    // An unwritable pack root is the reachable form of "the pack is unavailable".
    const rec = await run(fx, t, fakeExecutor(fx, {}), {
      env: { ...process.env, SCH_PACK_ROOT: join(fx.repo, "src", "app.js") },
    });
    assert.notEqual(rec.outcome, "VERIFIED");
    assert.equal(rec.failure?.code, "PACK_UNAVAILABLE");
  } finally { fx.done(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/worker.test.mjs`
Expected: FAIL — no `--plugin-dir` in the argv; `rec.pack` undefined.

- [ ] **Step 3: Write the implementation**

Add `import * as PACK from "./pack.mjs";` beside the existing `SK` import in `scripts/runner.mjs`.

Register the failure code in the arrays at `scripts/runner.mjs:39-43` and give it an outcome in `FAILURE_OUTCOME` at `:52`:

```javascript
  PACK_UNAVAILABLE: "NEEDS_DECISION",
```

`NEEDS_DECISION`, not `RETRYABLE`: a worker launched without its pack would silently fall back to whatever the CLI finds, which is the exact failure this milestone exists to prevent, and retrying does not change it.

In preflight, after skills are selected and before the worker is prepared, build the pack:

```javascript
  // The catalogue the worker will actually have. Built before the worker is
  // prepared, because a run whose pack failed must never reach a spawn.
  const built = PACK.buildPack({
    projectId, taskId, skills: ctx.skills?.selected ?? [],
    root: PACK.packsRoot(env),
  });
  if (!built.ok) return bad("PACK_UNAVAILABLE", built.message);
  ctx.pack = {
    path: built.path, manifest_name: built.manifest.name,
    entries: built.entries, refusals: built.refusals,
  };
```

Find the real names for `ctx.skills`, `bad()` and the `env` in scope — read the surrounding preflight rather than assuming these; a previous milestone lost time to a brief that named a helper that did not exist.

At the `executor.execute` call (`scripts/runner.mjs:1143`), pass the argv:

```javascript
      cwd: repoRoot, prompt: compiled.text, identity,
      extraArgs: PACK.workerArgs({ packPath: ctx.pack.path }),
```

Record `ctx.pack` in the run record beside the prompt manifest, following how the existing sections are persisted.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/worker.test.mjs` and `node --test tests/preflight.test.mjs`, then the full `npm test`.

- [ ] **Step 5: Commit**

```bash
git add scripts/runner.mjs tests/worker.test.mjs tests/preflight.test.mjs
git commit -m "feat(runner): the worker gets the task's pack, or the run stops before it starts"
```

---

### Task 5: Required skills keep their excerpt, recommended skills become an index

**Files:**
- Modify: `scripts/runner.mjs` — the prompt section that renders selected skills, and the prompt manifest accounting
- Test: `tests/worker.test.mjs` (append)

**Interfaces:**
- Consumes: `selectSkills`'s `selected[].bucket` (`"required"` / `"recommended"`) and the pack's `entries[].invocation_id` from Task 1
- Produces: prompt manifest fields `skills_injected_chars` and `skills_indexed_count`, so the saving is measurable rather than asserted

- [ ] **Step 1: Write the failing test**

Append to `tests/worker.test.mjs`:

```javascript
test("a recommended skill is indexed by name, a required skill is injected in full", async () => {
  const fx = fixture("skill-bucket-split");
  try {
    initWorkspace(fx);
    const t = addTask(fx);
    const promptTo = join(fx.home, "prompt.txt");
    const rec = await run(fx, t, fakeExecutor(fx, {
      promptTo, write: [{ path: "src/app.js", content: "// ok\n" }],
    }));
    assert.equal(rec.outcome, "VERIFIED", rec.failure?.message);

    const prompt = readFileSync(promptTo, "utf8");
    const manifest = rec.prompt_manifest ?? {};
    assert.equal(typeof manifest.skills_injected_chars, "number",
      "the prompt manifest must account for what injection cost");
    assert.equal(typeof manifest.skills_indexed_count, "number");

    // Whatever this fixture's recommendation engine selects, a recommended skill
    // contributes its invocation id and not its body.
    for (const s of (rec.skills ?? []).filter((x) => x.bucket === "recommended")) {
      assert.ok(prompt.includes(s.skill_id), "a recommended skill must still be named to the worker");
      assert.ok(!prompt.includes(s.excerpt?.slice(0, 200) ?? "\u0000IMPOSSIBLE"),
        "a recommended skill's body must not be injected — it loads from the pack");
    }
  } finally { fx.done(); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/worker.test.mjs`
Expected: FAIL — `skills_injected_chars` is undefined and recommended bodies are still in the prompt.

- [ ] **Step 3: Write the implementation**

Find the prompt section that renders `ctx.skills.selected` and split it by bucket:

- **required** — unchanged. Heading, reason, and the excerpt exactly as today.
- **recommended** — one line each: the skill's name, its one-line purpose, and the `invocation_id` from `ctx.pack.entries`, plus a sentence saying these are available and load on demand.

Required skills keep their injection deliberately: SCH guarantees they are in context. Making a required skill's presence depend on the model choosing to invoke it would invert this system's rule that code owns the decision and the model owns bounded execution inside it. Put that reasoning in the comment — it is the whole argument for the asymmetry.

Add the two counters to the prompt manifest where the existing per-section character accounting is built.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/worker.test.mjs`, then the full `npm test`.

- [ ] **Step 5: Commit**

```bash
git add scripts/runner.mjs tests/worker.test.mjs
git commit -m "feat(runner): inject what the worker must have, index what it may fetch"
```

---

### Task 6: Pack lifecycle, the honest boundary, and the known gap

**Files:**
- Modify: `scripts/scheduler.mjs` — remove the pack wherever the worktree is removed
- Modify: `README.md`, `SCH-LOOP.md`, `skills/SCH/SKILL.md`
- Create: `docs/adr/0005-project-local-capability-packs.md`
- Test: `tests/containment.test.mjs` (append), `tests/scheduler.test.mjs` (append)

**Interfaces:**
- Consumes: `PACK.removePack`, `PACK.packState`, `PACK.deniedBuiltins`

- [ ] **Step 1: Write the failing tests**

Append to `tests/scheduler.test.mjs`:

```javascript
test("the pack is removed with the worktree, and survives a FAILED task", async () => {
  const fx = fixture("pack-lifecycle");
  try {
    initWorkspace(fx);
    const t = addTask(fx);
    await runQueue(fx, {
      env: fakeQueueEnv(fx, { [t]: { write: [{ path: "src/app.js", content: "// x\n" }] } }),
      maxTasks: 1,
    });
    // Whatever terminal state this run reaches, the pack's presence must match
    // the worktree's: both removed on success, both kept as evidence on failure.
    const pack = PACK.packState({ projectId: fx.P, taskId: t });
    const wt = WT.worktreeState({ projectId: fx.P, taskId: t, repoRoot: fx.repo });
    assert.equal(pack.exists, wt.exists,
      "a pack must never outlive its worktree, nor be reaped while the worktree is still evidence");
  } finally { fx.done(); }
});
```

Import `PACK` and `WT` at the top of that file the way the other modules are imported.

Append to `tests/containment.test.mjs`:

```javascript
test("the argv SCH launches a worker with suppresses the operator's catalogue", () => {
  const args = PACK.workerArgs({ packPath: "X" });
  assert.equal(args[args.indexOf("--setting-sources") + 1], "project");
  assert.ok(args.includes("Skill(schedule)"));
  assert.ok(!args.includes("--bare"));
});

test("KNOWN GAP: denying a built-in blocks invocation but not listing", () => {
  // Probed against the real CLI: `--disallowed-tools "Skill(init)"` returns
  // "Skill execution blocked by permission rules" on invocation, while the name
  // still appears in the worker's skill list. So a denied built-in still costs
  // context. There is no flag that removes it without removing the pack too.
  //
  // This asserts the SHAPE of the mitigation, not the CLI's behaviour — the
  // suite is hermetic and never invokes a real model. If a future CLI stops
  // listing denied skills, this comment is what tells you the README's residual
  // can be deleted.
  assert.ok(PACK.deniedBuiltins().length > 0,
    "denial is by name, so the names are known and still listed");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/scheduler.test.mjs` and `node --test tests/containment.test.mjs`
Expected: FAIL — the pack outlives the worktree; `PACK` is not imported.

- [ ] **Step 3: Implement the lifecycle, then write the documentation**

In `scripts/scheduler.mjs`, find where M6 removes the worktree (the `DELIVERED`/`CANCELLED` branch that calls `WT.removeWorktree` and emits `scheduler.worktree_removed`) and remove the pack in the same place, emitting a matching event. Add the event name to the vocabulary array. Do **not** remove the pack on `FAILED` — it is part of the evidence, exactly as the worktree is.

Then the documentation. Add to the README's containment section, under **True now**:

```markdown
- **A worker cannot see your global skills.** Each task gets a generated plugin
  directory holding exactly the skills SCH approved for it, and the worker is
  launched with `--setting-sources project` so nothing from `~/.claude` reaches
  it. The pack lives beside the worktree, never inside your repository.
- **A worker cannot invoke a built-in that schedules work or edits your config.**
  `schedule`, `loop`, `init`, `update-config`, `fewer-permission-prompts` and
  `run` are denied by argv; a built-in a future CLI ships that nobody has
  classified is denied too.
```

And under **Still NOT true**:

```markdown
- **Denied built-in skills still appear in the worker's skill listing.** Denial
  blocks invocation, not listing, so roughly a dozen names remain as context
  cost. No flag removes them without removing the pack as well.
- **A skill that needs its own scripts cannot be packed.** Only `SKILL.md` is
  carried; hooks, scripts and nested plugin manifests are refused and recorded.
```

Mirror both in `SCH-LOOP.md` and `skills/SCH/SKILL.md` — those two drifted from the README in the previous milestone and the drift was a review finding.

Create `docs/adr/0005-project-local-capability-packs.md` following ADR 0004's shape: the decision (generated plugin dir, argv-level suppression, built-in denylist as versioned data), the alternatives rejected (`--safe-mode`, which would leave a project unable to grant any skill at all; `--bare`, which breaks subscription auth; a `.claude/` inside the worktree, which collides with the clean-tree gate), and the consequences (a skill needing scripts cannot be packed; built-in names still listed).

- [ ] **Step 4: Run the full check**

Run: `npm test` and `npm run validate`.
Expected: PASS. `validate.mjs` requires every `scripts/*.mjs` to appear in the README file map — `scripts/pack.mjs` needs its line there, or validate fails.

- [ ] **Step 5: Commit**

```bash
git add scripts/scheduler.mjs tests/scheduler.test.mjs tests/containment.test.mjs \
        README.md SCH-LOOP.md skills/SCH/SKILL.md docs/adr/0005-project-local-capability-packs.md
git commit -m "docs(pack): say what the worker can still reach, and test the gap that remains"
```

---

## A note on verification the suite cannot do

The spec's strongest verification — *"a real worker's skill listing contains no globally installed skill"* — cannot live in this suite. `tests/helpers.mjs` guarantees no real model is ever invoked, and that guarantee is worth more than the assertion.

So the suite asserts the **deterministic half**: that SCH constructs the right argv and the right pack. The behavioural half was proven by probe before this plan was written, and the probe is reproducible:

```bash
claude -p --plugin-dir <pack> --setting-sources project \
  <<< "List the exact name of every skill available to you, one per line."
```

Record that procedure in ADR 0005 so the next person can re-run it against a new CLI release rather than trusting a design note.

## Out of scope

The operator's own interactive session. Conflict detection between overlapping methodologies. Any change to which skills `skill-recommend` chooses — this plan changes how the chosen set reaches the worker, not how it is chosen.
