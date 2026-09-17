import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedRoles, upsertManagedBlock, managedBlock, setupProject, verifyInstall, prunable, CLAUDE_MD_START, CLAUDE_MD_END } from "./setup.mjs";
import { isBypass, isReadOnly } from "./roles.mjs";

const seats = avail => ["claude", "codex", "opencode", "gemini", "antigravity"].map(p => ({ provider: p, available: avail.includes(p), models: [] }));

test("seedRoles: claude present → executor bypasses, reviewer and judge are read-only, no model pinned", async () => {
  const r = await seedRoles(seats(["claude", "codex", "opencode"]));
  assert.equal(r.executor.provider, "claude");
  assert.equal(r.executor.model, null, "no model is hard-coded at setup");
  assert.equal(isBypass(r.executor), true);
  assert.equal(isReadOnly(r.executor), false);
  assert.equal(isReadOnly(r.reviewer), true);
  assert.equal(isReadOnly(r.judge), true);
  assert.deepEqual(r.executor.model_arg, ["--model", "{model}"]);
  assert.ok(r.executor.spawn.includes("--output-format"));
});

test("seedRoles: council seats are enabled only for CLIs that exist", async () => {
  const r = await seedRoles(seats(["claude", "codex"]));
  const by = Object.fromEntries(r.council.map(c => [c.provider, c]));
  assert.equal(by.claude.enabled, true);
  assert.equal(by.codex.enabled, true);
  assert.equal(by.opencode.enabled, false);
  assert.match(by.antigravity._why, /not on PATH/);
  assert.equal(r.council.filter(c => c.enabled).length, 2, "two live seats meets council_minimum_seats");
});

test("seedRoles: no claude → codex takes the chair, read-only sandbox for review", async () => {
  const r = await seedRoles(seats(["codex", "opencode"]));
  assert.equal(r.executor.provider, "codex");
  assert.ok(r.executor.spawn.includes("workspace-write"));
  assert.equal(isReadOnly(r.reviewer), true);
});

test("seedRoles: nothing installed is a refusal, not a guess", async () => {
  await assert.rejects(() => seedRoles(seats([])), /no agent CLI found on PATH/);
});

test("managed block replaces itself and leaves other content alone", () => {
  const block = managedBlock({ engineRel: ".claude/sch" });
  const before = "# My project\n\nSome notes.\n";
  const once = upsertManagedBlock(before, block);
  assert.ok(once.startsWith("# My project"));
  assert.ok(once.includes(CLAUDE_MD_START) && once.includes(CLAUDE_MD_END));
  const twice = upsertManagedBlock(once, block.replace("Retry cap 3", "Retry cap 5"));
  assert.equal((twice.match(/SCH-LOOP:PROJECT:START/g) || []).length, 1, "block is replaced, never duplicated");
  assert.ok(twice.includes("Retry cap 5"));
  assert.ok(twice.startsWith("# My project"), "unrelated content survives");
});

test("setupProject writes the tree, merges hooks into an existing settings.json, and is idempotent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-setup-"));
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node mine.mjs" }] }] } }, null, 2));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Existing\n");

  const a = await setupProject({ projectRoot: root });
  assert.ok(fs.existsSync(path.join(root, ".sch-loop", "roles.json")));
  assert.ok(fs.existsSync(path.join(root, "task.md")));
  assert.match(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /# Existing[\s\S]*SCH-LOOP:PROJECT:START/);
  const s = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
  assert.ok(JSON.stringify(s).includes("node mine.mjs"), "the project's own hook is preserved");
  assert.ok(JSON.stringify(s).includes("write-guard.mjs"));
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /\.worktrees\//);

  // What matters is that a real queue survives, not whether the file was listed as skipped. An
  // untouched template is re-seeded, which loses nothing; a queue with tickets in it is left alone.
  fs.writeFileSync(path.join(root, "task.md"), "# task.md\n\n## Phase 1 — Mine   (0/1 done)\n- [ ] T1.1-mine  build  Mine  deps:-  size:S\n");
  await setupProject({ projectRoot: root });
  assert.match(fs.readFileSync(path.join(root, "task.md"), "utf8"), /T1\.1-mine/, "a second run does not clobber the queue");
  assert.equal((fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8").match(/SCH-LOOP:PROJECT:START/g) || []).length, 1);
  assert.ok(a.seats.some(x => x.provider === "claude"));
});

// Setup used to report success for a project it had made no attempt to make runnable: no engine, no
// hooks (the copy read from a path that has never existed), no skills. Every test below is one of the
// things a project needs before `cli.mjs run` can do anything at all.

test("setup installs an engine, both fences and the skills, and says so", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-install-"));
  const r = await setupProject({ projectRoot: root });
  assert.equal(r.ok, true, r.error);
  assert.ok(fs.existsSync(path.join(root, ".claude/sch/runtime/cli.mjs")), "the engine is installed, not just referenced");
  assert.ok(fs.existsSync(path.join(root, ".claude/hooks/write-guard.mjs")));
  assert.ok(fs.existsSync(path.join(root, ".claude/hooks/destructive-bash.mjs")));
  assert.ok(fs.readdirSync(path.join(root, ".claude/skills")).length >= 10, "skills come with the engine");
  assert.ok(r.checks.every(c => c.ok), JSON.stringify(r.checks.filter(c => !c.ok)));
});

test("a project missing any piece is reported as not runnable, not as a success", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-install-"));
  await setupProject({ projectRoot: root });
  for (const gone of [".claude/sch/runtime/cli.mjs", ".claude/hooks/write-guard.mjs", ".claude/hooks/destructive-bash.mjs", "task.md"]) {
    const keep = fs.readFileSync(path.join(root, gone));
    fs.rmSync(path.join(root, gone));
    const checks = verifyInstall(root);
    assert.ok(checks.some(c => !c.ok), `removing ${gone} must fail a check`);
    fs.writeFileSync(path.join(root, gone), keep);
  }
  assert.ok(verifyInstall(root).every(c => c.ok), "and restoring them all makes it green again");
});

test("the fences end up wired even when the project already had hooks of its own", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-install-"));
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node ./mine.mjs" }] }] },
    permissions: { deny: ["Read(./secrets/**)"] },
    somethingElse: { keep: true },
  }, null, 2));
  const r = await setupProject({ projectRoot: root });
  assert.equal(r.ok, true, r.error);
  const s = JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8"));
  const wired = JSON.stringify(s.hooks.PreToolUse);
  assert.match(wired, /mine\.mjs/, "the project's own hook survives");
  assert.match(wired, /write-guard\.mjs/);
  assert.match(wired, /destructive-bash\.mjs/);
  assert.ok(s.permissions.deny.includes("Read(./secrets/**)"), "and its own deny rules");
  assert.deepEqual(s.somethingElse, { keep: true }, "and everything setup has no opinion about");
});

test("setup refuses a settings.json it cannot parse rather than overwriting it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-install-"));
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  const broken = "{ this is not json";
  fs.writeFileSync(path.join(root, ".claude/settings.json"), broken);
  await assert.rejects(setupProject({ projectRoot: root }), /not valid JSON/);
  assert.equal(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8"), broken, "untouched");
});

test("re-running setup refreshes the engine without touching the project's own work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-install-"));
  await setupProject({ projectRoot: root });
  fs.writeFileSync(path.join(root, "task.md"), "# my queue\n\n## Phase 1 — Mine   (0/1 done)\n- [ ] T1.1-keep-me  build  Keep me  deps:-  size:S\n");
  fs.writeFileSync(path.join(root, ".claude/hooks/write-guard.mjs"), "// hand-patched\n");
  const r = await setupProject({ projectRoot: root });
  assert.equal(r.ok, true, r.error);
  assert.match(fs.readFileSync(path.join(root, "task.md"), "utf8"), /keep-me/, "the queue is the project's, and survives");
  assert.doesNotMatch(fs.readFileSync(path.join(root, ".claude/hooks/write-guard.mjs"), "utf8"), /hand-patched/,
    "a fence is the engine's, and is restored — a silently patched fence is worse than a lost edit");
});

test("installing over a live project never leaves it without an engine", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-install-"));
  await setupProject({ projectRoot: root });
  const cli = path.join(root, ".claude/sch/runtime/cli.mjs");
  assert.ok(fs.existsSync(cli));

  // A stale module from an older engine is pruned; a file the project owns elsewhere is untouched.
  fs.writeFileSync(path.join(root, ".claude/sch/runtime/gone-in-v5.mjs"), "// removed upstream\n");
  fs.writeFileSync(path.join(root, "notes.md"), "mine\n");
  const r = await setupProject({ projectRoot: root, force: true });

  assert.equal(r.ok, true, r.error);
  assert.ok(fs.existsSync(cli), "the engine is present at every moment, not deleted and re-copied");
  assert.equal(fs.existsSync(path.join(root, ".claude/sch/runtime/gone-in-v5.mjs")), false, "stale modules are pruned");
  assert.equal(fs.readFileSync(path.join(root, "notes.md"), "utf8"), "mine\n");
});

test("prunable names only what the source no longer has, at the top level", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "sch-prune-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "sch-prune-b-"));
  fs.writeFileSync(path.join(a, "keep.mjs"), "");
  fs.writeFileSync(path.join(b, "keep.mjs"), "");
  fs.writeFileSync(path.join(b, "drop.mjs"), "");
  assert.deepEqual(prunable(a, b), ["drop.mjs"]);
  assert.deepEqual(prunable(a, path.join(b, "nope")), [], "a destination that does not exist prunes nothing");
});

test("setup --force refreshes the engine and NEVER destroys the project's queue", async () => {
  // A second `setup --force` used to overwrite task.md with the empty template, erasing a
  // thirteen-ticket queue. `force` means "refresh the engine", never "discard my work".
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-force-"));
  await setupProject({ projectRoot: root });

  const queue = "# task.md\n\n## Phase 1 — Mine   (0/2 done)\n- [x] T1.1-done  build  Done  deps:-  size:S\n- [ ] T1.2-next  build  Next  deps:T1.1  size:S\n";
  fs.writeFileSync(path.join(root, "task.md"), queue);
  const roles = JSON.parse(fs.readFileSync(path.join(root, ".sch-loop/roles.json"), "utf8"));
  roles.executor.model = "chosen-in-the-dashboard";
  fs.writeFileSync(path.join(root, ".sch-loop/roles.json"), JSON.stringify(roles, null, 2));
  fs.writeFileSync(path.join(root, ".claude/sch/runtime/cli.mjs"), "// stale engine\n");

  const r = await setupProject({ projectRoot: root, force: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.readFileSync(path.join(root, "task.md"), "utf8"), queue, "the queue is untouched");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".sch-loop/roles.json"), "utf8")).executor.model,
    "chosen-in-the-dashboard", "and so is the model chosen in the dashboard");
  assert.doesNotMatch(fs.readFileSync(path.join(root, ".claude/sch/runtime/cli.mjs"), "utf8"), /stale engine/,
    "while the engine IS refreshed — that is what force is for");
});

test("an untouched template queue is re-seeded, because nothing is lost by doing so", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-force-"));
  await setupProject({ projectRoot: root });
  fs.writeFileSync(path.join(root, "task.md"), "# task.md\n\n(nothing here yet)\n");
  await setupProject({ projectRoot: root, force: true });
  assert.match(fs.readFileSync(path.join(root, "task.md"), "utf8"), /SCH-LOOP:TASKS/);
});
