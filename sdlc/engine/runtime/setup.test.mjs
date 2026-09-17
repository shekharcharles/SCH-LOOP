import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedRoles, upsertManagedBlock, managedBlock, setupProject, CLAUDE_MD_START, CLAUDE_MD_END } from "./setup.mjs";
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

  const b = await setupProject({ projectRoot: root });
  assert.ok(b.skipped.includes("task.md"), "a second run does not clobber the queue");
  assert.equal((fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8").match(/SCH-LOOP:PROJECT:START/g) || []).length, 1);
  assert.ok(a.seats.some(x => x.provider === "claude"));
});
