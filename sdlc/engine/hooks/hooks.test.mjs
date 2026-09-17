// The two fences, checked against a throwaway project built here rather than whatever project the hooks
// happen to be installed into. They used to read the live lab's `task.md` and `CLAUDE.md`, which made
// them fail the moment the hooks moved and meant a passing run depended on the state of a real queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// A minimal project with the two files the curated rules care about.
const TASK = `# task.md

## Phase 1 — Core   (1/3 done)
- [x] T1.1-first   build  First   deps:-     size:S
- [ ] T1.2-second  build  Second  deps:T1.1  size:S
- [ ] T1.3-third   test   Third   deps:-     size:S
`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-hooks-"));
fs.mkdirSync(path.join(root, ".sch-loop"), { recursive: true });
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.writeFileSync(path.join(root, "task.md"), TASK);
fs.writeFileSync(path.join(root, "CLAUDE.md"), Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n");
fs.writeFileSync(path.join(root, "src", "todo.mjs"), "export const x = 1;\n");

const run = (script, payload) => spawnSync(process.execPath, [path.join(here, script)], {
  input: JSON.stringify({ cwd: root, ...payload }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root },
});

test("destructive-bash blocks rm -rf, git clean, git stash, npm install", () => {
  for (const command of ["rm -rf build", "git clean -fd", "git stash pop", "npm install left-pad", "git push -f origin main"]) {
    const r = run("destructive-bash.mjs", { tool_name: "Bash", tool_input: { command } });
    assert.equal(r.status, 2, `${command} should be blocked: ${r.stderr}`);
  }
});

test("destructive-bash allows ordinary commands", () => {
  for (const command of ["npm test", "git status --short", "git add src/todo.mjs", "rm build/out.txt", "git checkout -- src/todo.mjs"]) {
    const r = run("destructive-bash.mjs", { tool_name: "Bash", tool_input: { command } });
    assert.equal(r.status, 0, `${command} should pass: ${r.stderr}`);
  }
});

test("write-guard blocks outside project and protected paths, allows src", () => {
  assert.equal(run("write-guard.mjs", { tool_name: "Write", tool_input: { file_path: path.resolve(root, "..", "outside.txt"), content: "x" } }).status, 2);
  assert.equal(run("write-guard.mjs", { tool_name: "Edit", tool_input: { file_path: path.join(root, ".sch-loop/private/keys.json") } }).status, 2);
  assert.equal(run("write-guard.mjs", { tool_name: "Edit", tool_input: { file_path: path.join(root, ".env") } }).status, 2);
  assert.equal(run("write-guard.mjs", { tool_name: "Edit", tool_input: { file_path: path.join(root, "src/todo.mjs") } }).status, 0);
});

test("write-guard blocks a shrinking whole-file Write of a curated prose file", () => {
  // The ratio rule guards prose (PRD, PLAN, ARCHITECTURE) and only once the file is substantial;
  // task.md is guarded by ticket count instead, in its own test below.
  const target = path.join(root, ".sch-loop", "PLAN.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existed = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  fs.writeFileSync(target, Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") + "\n");
  try {
    const r = run("write-guard.mjs", { tool_name: "Write", tool_input: { file_path: target, content: "# gone\n" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /shrink/);
  } finally {
    if (existed === null) fs.rmSync(target, { force: true }); else fs.writeFileSync(target, existed);
  }
});

test("write-guard enforces allowed_paths of the active ticket, whose file carries a slug", () => {
  const state = path.join(root, ".sch-loop", "state.json");
  const before = fs.existsSync(state) ? fs.readFileSync(state, "utf8") : null;
  const dir = path.join(root, ".sch-loop", "tickets");
  fs.mkdirSync(dir, { recursive: true });
  const tf = path.join(dir, "TZ9.9-guard-probe.json");
  fs.writeFileSync(tf, JSON.stringify({ id: "TZ9.9", allowed_paths: ["docs/**"] }));
  fs.writeFileSync(state, JSON.stringify({ current_task: "TZ9.9" }));
  try {
    assert.equal(run("write-guard.mjs", { tool_name: "Edit", tool_input: { file_path: path.join(root, "docs", "a.md") } }).status, 0, "inside allowed_paths passes");
    const out = run("write-guard.mjs", { tool_name: "Edit", tool_input: { file_path: path.join(root, "src", "todo.mjs") } });
    assert.equal(out.status, 2, "outside allowed_paths is blocked");
    assert.match(out.stderr, /allowed_paths of TZ9\.9/);
  } finally {
    fs.rmSync(tf, { force: true });
    if (before === null) fs.rmSync(state, { force: true }); else fs.writeFileSync(state, before);
  }
});

test("write-guard blocks a whole-file Write that drops tickets from task.md at any size", () => {
  const keep = fs.readFileSync(path.join(root, "task.md"), "utf8");
  const dropped = keep.split("\n").filter(l => !/^- \[[ ~x!?]\] T\d/.test(l)).join("\n");
  const out = run("write-guard.mjs", { tool_name: "Write", tool_input: { file_path: path.join(root, "task.md"), content: dropped } });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /drop \d+ of \d+ tickets/);
  assert.equal(run("write-guard.mjs", { tool_name: "Write", tool_input: { file_path: path.join(root, "task.md"), content: keep + "\n- [ ] T9.9-new  docs  New  deps:-\n" } }).status, 0, "adding a ticket is fine");
});

test("curated patterns are case-insensitive — the paths they see are lowercased", () => {
  const target = path.join(root, "CLAUDE.md");
  const before = fs.readFileSync(target, "utf8");
  const r = run("write-guard.mjs", { tool_name: "Write", tool_input: { file_path: target, content: "# gone\n" } });
  assert.equal(r.status, 2, "a whole-file Write that guts CLAUDE.md must be blocked");
  assert.equal(fs.readFileSync(target, "utf8"), before);
});
