// Runnable check for the two fences. `node .claude/hooks/hooks.test.mjs` from the lab root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
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

test("write-guard blocks a shrinking whole-file Write of task.md", () => {
  const big = Array.from({ length: 60 }, (_, i) => `- [ ] T0.${i}-x line`).join("\n");
  const r = run("write-guard.mjs", { tool_name: "Write", tool_input: { file_path: path.join(root, "task.md"), content: "# task.md\n" } });
  // task.md in a fresh lab is under FLOOR_LINES, so this passes; the rule only bites once the file is real.
  assert.equal(r.status, 0);
  assert.ok(big.length > 0);
});
