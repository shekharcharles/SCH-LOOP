import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseConfig } from "./config.mjs";
import { resolveSpawn, isBypass, isReadOnly, applyPreset } from "./roles.mjs";
import { runRole, isLooping, contextTokens } from "./spawn.mjs";
import { ensureTicketWorktree, mergeTicket, commitFiles, removeTicketWorktree } from "./worktrees.mjs";
import { writeReport, readReport } from "./report.mjs";
import { isWorktree, checkFences } from "./fences.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "tests", "fake-cli.mjs");

test("config: parses scalars, lists, maps, and stops at notes", () => {
  const c = parseConfig(`# x\nowner: SCH\nmax_executor_attempts: 3\ntimeouts_minutes: { XS: 5, S: 15 }\nrate_limit_backoff_minutes: [1, 2, 4]\nprotected_paths:\n  - .env*\n  - "**/*.pem"\n\n## Notes\nignored: yes\n`);
  assert.equal(c.max_executor_attempts, 3);
  assert.deepEqual(c.timeouts_minutes, { XS: 5, S: 15 });
  assert.deepEqual(c.rate_limit_backoff_minutes, [1, 2, 4]);
  assert.deepEqual(c.protected_paths, [".env*", "**/*.pem"]);
  assert.equal(c.ignored, undefined);
});

test("roles: model_arg inserted only when a model is set; presets toggle; bypass/read-only detection", () => {
  const spec = { provider: "claude", model: null, model_arg: ["--model", "{model}"], spawn: ["claude", "--dangerously-skip-permissions", "-p"] };
  assert.deepEqual(resolveSpawn(spec).args, ["--dangerously-skip-permissions", "-p"]);
  assert.deepEqual(resolveSpawn(spec, { model: "opus" }).args, ["--dangerously-skip-permissions", "-p", "--model", "opus"]);
  assert.deepEqual(resolveSpawn({ ...spec, model: "cli-default" }).args, ["--dangerously-skip-permissions", "-p"]);
  assert.equal(isBypass(spec), true);
  assert.equal(isReadOnly(spec), false);
  const presets = { claude: { read_only_tools: ["--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit"] } };
  const ro = applyPreset(spec, presets, "read_only_tools", true);
  assert.equal(isReadOnly(ro), true);
  assert.deepEqual(applyPreset(ro, presets, "read_only_tools", false).spawn, spec.spawn);
});

test("spawn: parses stream-json, captures usage, reports context tokens", async () => {
  const r = await runRole({ exe: process.execPath, args: [FAKE], cwd: here, prompt: "hello", env: { ...process.env, FAKE_MODE: "ok", FAKE_REPLY: "done" }, timeoutMs: 20000 });
  assert.equal(r.outcome, "PASSED");
  assert.equal(r.text, "done");
  assert.equal(r.sessionId, "fake-session");
  assert.equal(contextTokens(r.usage), 115);
  assert.deepEqual(r.events.filter(e => e.type === "tool").map(e => e.tool), ["Read", "Edit"]);
});

test("spawn: loop detection kills a spinning process", async () => {
  assert.equal(isLooping(["a", "b", "a", "b", "a", "b"], 2, 3), true);
  assert.equal(isLooping(["a", "b", "a", "c", "a", "b"], 2, 3), false);
  const r = await runRole({ exe: process.execPath, args: [FAKE], cwd: here, prompt: "x", env: { ...process.env, FAKE_MODE: "loop" }, timeoutMs: 20000 });
  assert.equal(r.outcome, "LOOP");
  assert.ok(r.events.some(e => e.type === "loop"));
});

test("spawn: silence and non-zero exit are distinct outcomes", async () => {
  const s = await runRole({ exe: process.execPath, args: [FAKE], cwd: here, prompt: "x", env: { ...process.env, FAKE_MODE: "silent" }, timeoutMs: 20000, silenceMs: 1500 });
  assert.equal(s.outcome, "SILENT");
  const f = await runRole({ exe: process.execPath, args: [FAKE], cwd: here, prompt: "x", env: { ...process.env, FAKE_MODE: "fail" }, timeoutMs: 20000 });
  assert.equal(f.outcome, "FAILED"); assert.equal(f.exitCode, 3); assert.match(f.stderr, /boom/);
});

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-wt-"));
  const g = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", windowsHide: true });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "core.autocrlf", "false");
  fs.mkdirSync(path.join(root, "proj", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "proj", "src", "a.txt"), "a\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".worktrees/\n");
  g("add", "."); g("commit", "-q", "-m", "init");
  return root;
}

test("worktrees: per-ticket worktree under a subfolder project, commit files, fail-closed merge", () => {
  const root = tmpRepo();
  const project = path.join(root, "proj");
  const wt = ensureTicketWorktree({ projectRoot: project, id: "T1.1", slug: "first" });
  assert.equal(wt.branch, "sch/T1.1-first");
  assert.ok(fs.existsSync(path.join(wt.cwd, "src", "a.txt")));
  assert.equal(isWorktree(wt.cwd), true);
  assert.equal(isWorktree(project), false);
  fs.writeFileSync(path.join(wt.cwd, "src", "a.txt"), "a\nb\n");
  const c = commitFiles({ cwd: wt.cwd, files: ["src/a.txt"], message: "feat(T1.1): b" });
  assert.equal(c.ok, true, c.error);
  const m = mergeTicket({ projectRoot: project, id: "T1.1", slug: "first" });
  assert.equal(m.ok, true, m.error);
  assert.equal(fs.readFileSync(path.join(project, "src", "a.txt"), "utf8"), "a\nb\n");
  // conflicting second ticket: main changes the same line, merge must abort cleanly
  const wt2 = ensureTicketWorktree({ projectRoot: project, id: "T1.2", slug: "second" });
  fs.writeFileSync(path.join(wt2.cwd, "src", "a.txt"), "a\nZ\n");
  commitFiles({ cwd: wt2.cwd, files: ["src/a.txt"], message: "feat(T1.2)" });
  fs.writeFileSync(path.join(project, "src", "a.txt"), "a\nY\n");
  execFileSync("git", ["commit", "-qam", "main edit"], { cwd: root, windowsHide: true });
  const m2 = mergeTicket({ projectRoot: project, id: "T1.2", slug: "second" });
  assert.equal(m2.ok, false); assert.equal(m2.conflict, true);
  assert.equal(execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).trim(), "");
  assert.equal(removeTicketWorktree({ projectRoot: project, id: "T1.2", slug: "second", deleteBranch: true }), true);
});

test("fences: bypass executor without hooks or worktree is refused; non-bypass is advisory", () => {
  const root = tmpRepo();
  const project = path.join(root, "proj");
  const roles = { executor: { provider: "claude", spawn: ["claude", "--dangerously-skip-permissions", "-p"] } };
  const r = checkFences({ projectRoot: project, cwd: project, roles, config: { protected_paths: [] } });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => /fence 1/.test(f)) && r.failures.some(f => /fence 2/.test(f)) && r.failures.some(f => /fence 3/.test(f)));
  const ok = checkFences({ projectRoot: project, cwd: project, roles: { executor: { spawn: ["claude", "-p"] } }, config: {} });
  assert.equal(ok.ok, true); assert.equal(ok.bypass, false);
});

test("report: envelope round-trips", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-rep-"));
  writeReport(root, { id: "T1.1", status: "done", summary: "did it", artifacts: ["src/a.txt"], attempts: 1, what_did_not_work: [] });
  const r = readReport(root, "T1.1");
  assert.equal(r.status, "done"); assert.deepEqual(r.artifacts, ["src/a.txt"]);
  assert.ok(fs.existsSync(path.join(root, ".sch-loop", "reports", "T1.1.md")));
});

test("contextTokens measures the biggest single turn, not the session's billing total", async () => {
  const { contextTokens, sessionTokens } = await import("./spawn.mjs");
  // Shape taken verbatim from a real T2.1a attempt. `cache_read_input_tokens` at the top level is the
  // CUMULATIVE read across every turn, so summing it reported 547k for a ticket whose window peaked at
  // 52k. The two numbers must never be confused for one another again.
  const real = {
    input_tokens: 22, cache_creation_input_tokens: 35241, cache_read_input_tokens: 512194,
    iterations: [
      { input_tokens: 2, cache_read_input_tokens: 51921, cache_creation_input_tokens: 366 },
      { input_tokens: 5, cache_read_input_tokens: 30110, cache_creation_input_tokens: 120 },
    ],
  };
  assert.equal(contextTokens(real), 52289, "the peak turn, which is what a context ceiling is about");
  assert.equal(sessionTokens(real), 547457, "the session total, which is what it cost");
  assert.ok(contextTokens(real) < sessionTokens(real) / 10, "a long session dwarfs its own window");

  // A single-turn call has no iterations array; the top level is then the turn.
  assert.equal(contextTokens({ input_tokens: 2, cache_read_input_tokens: 17046, cache_creation_input_tokens: 26637 }), 43685);
  assert.equal(contextTokens(null), null);
});
