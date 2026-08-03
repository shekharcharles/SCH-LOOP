// Stage 1 boundaries that were too wide, and the structured verification
// command that a whitespace split could not represent.
//
//   * only IGNORED RUNTIME paths are exempt from the dirty-tree gate;
//   * `.sch-loop/` is DEFAULT DENY to a worker, not default allow;
//   * the raw handoff belongs to the ignored run directory, and promotion into
//     the durable record is a separate, deliberate act;
//   * a verification argument may contain a space.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, fakeExecutor, run, git, RUN, WS } from "./helpers.mjs";

// ------------------------------------------ .sch-loop/ dirty-tree exemption

test("hardening: an uncommitted RUNTIME artifact does not block a run", async () => {
  const fx = fixture("hd-runtime"); initWorkspace(fx);
  const t = addTask(fx);
  // exactly what a previous run leaves behind
  for (const d of WS.RUNTIME_DIRS) {
    mkdirSync(join(fx.repo, ".sch-loop", d), { recursive: true });
    writeFileSync(join(fx.repo, ".sch-loop", d, "leftover.log"), "evidence from an earlier run\n");
  }
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/a.js", content: "a\n" }] }));
  assert.equal(rec.outcome, "VERIFIED", JSON.stringify(rec.failure));
  fx.done();
});

// Every DURABLE workspace file is project content and must be seen by the gate.
for (const [name, path] of [
  ["SPEC.md", ".sch-loop/SPEC.md"],
  ["PLAN.md", ".sch-loop/PLAN.md"],
  ["TASK-QUEUE.md", ".sch-loop/TASK-QUEUE.md"],
  ["LEARNING.md", ".sch-loop/LEARNING.md"],
  ["a task definition", ".sch-loop/tasks/7.md"],
  ["a decision record", ".sch-loop/decisions/0001-use-postgres.md"],
  ["a phase file", ".sch-loop/phases/02-auth.md"],
  ["a promoted handoff", ".sch-loop/handoffs/1/RUN-old.md"],
]) {
  test(`hardening: an uncommitted change to ${name} BLOCKS a run`, async () => {
    const fx = fixture("hd-durable"); initWorkspace(fx);
    const t = addTask(fx);
    mkdirSync(join(fx.repo, path, ".."), { recursive: true });
    writeFileSync(join(fx.repo, path), "someone edited SCH control state and did not commit it\n");
    const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/a.js", content: "a\n" }] }));
    assert.equal(rec.outcome, "FAILED", `expected a block, got ${rec.outcome}`);
    assert.ok(rec.preflight_failures.some((f) => f.code === "REPOSITORY_DIRTY"), JSON.stringify(rec.preflight_failures));
    assert.match(rec.preflight_failures.find((f) => f.code === "REPOSITORY_DIRTY").message, new RegExp(path.replace(/[.[\]]/g, "\\$&")));
    fx.done();
  });
}

test("hardening: isRuntimePath separates evidence from durable project content", () => {
  for (const p of [".sch-loop/runs/RUN-x/stdout.log", ".sch-loop/locks/repository.json",
                   ".sch-loop/tmp/x", ".sch-loop/cache/y", ".sch-loop/artifacts/z", ".sch-loop/logs/l"])
    assert.equal(WS.isRuntimePath(p), true, p);
  for (const p of [".sch-loop/project.yaml", ".sch-loop/SPEC.md", ".sch-loop/decisions/1.md",
                   ".sch-loop/handoffs/1/RUN-x.md", ".sch-loop/tasks/1.md", "src/app.js", ".sch-loop/runsomething/x"])
    assert.equal(WS.isRuntimePath(p), false, p);
});

// -------------------------------------------- worker access to .sch-loop/

test("hardening: a worker may not touch ANY .sch-loop/ path by default", () => {
  const policy = { allowed: ["**"], forbidden: [] };   // the broadest policy possible
  for (const p of [".sch-loop/project.yaml", ".sch-loop/SPEC.md", ".sch-loop/PLAN.md",
                   ".sch-loop/TASK-QUEUE.md", ".sch-loop/LEARNING.md", ".sch-loop/phases/1.md",
                   ".sch-loop/tasks/1.md", ".sch-loop/decisions/1.md", ".sch-loop/handoffs/1/x.md",
                   ".sch-loop/runs/RUN-x/run.json", ".sch-loop/locks/repository.json",
                   ".sch-loop/artifacts/a", ".sch-loop/logs/l", ".sch-loop/cache/c", ".sch-loop/tmp/t",
                   ".git/config", ".git/hooks/pre-commit"]) {
    const c = RUN.classifyPath(process.cwd(), p, policy);
    assert.equal(c.verdict, "REJECTED", `${p} must be denied even with allowed:["**"]`);
  }
});

test("hardening: a named control category authorizes exactly that one, and nothing else", () => {
  const policy = { allowed: ["**"], forbidden: [], controlCategory: "decisions" };
  assert.equal(RUN.classifyPath(process.cwd(), ".sch-loop/decisions/0002-x.md", policy).verdict, "ALLOWED");
  assert.match(RUN.classifyPath(process.cwd(), ".sch-loop/decisions/0002-x.md", policy).why, /control category "decisions"/);
  for (const p of [".sch-loop/SPEC.md", ".sch-loop/PLAN.md", ".sch-loop/tasks/1.md", ".sch-loop/handoffs/1/x.md"])
    assert.equal(RUN.classifyPath(process.cwd(), p, policy).verdict, "REJECTED", `${p} is not the authorized category`);
  // the always-deny set is not a category and can never be authorized
  for (const cat of Object.keys(WS.WORKSPACE_DURABLE_CATEGORIES))
    for (const p of [".sch-loop/project.yaml", ".sch-loop/runs/RUN-x/run.json", ".sch-loop/locks/repository.json"])
      assert.equal(RUN.classifyPath(process.cwd(), p, { allowed: ["**"], forbidden: [], controlCategory: cat }).verdict,
        "REJECTED", `${p} must stay denied under category "${cat}"`);
});

test("hardening: a worker writing SCH control state fails the run", async () => {
  const fx = fixture("hd-control"); initWorkspace(fx);
  const t = addTask(fx, { allow: "src/**|.sch-loop/**" });
  const rec = await run(fx, t, fakeExecutor(fx, {
    write: [{ path: "src/ok.js", content: "ok\n" }, { path: ".sch-loop/SPEC.md", content: "I rewrote the spec\n" }],
  }));
  assert.equal(rec.outcome, "FAILED");
  assert.equal(rec.failure.code, "PATH_SCOPE_VIOLATION");
  assert.match(rec.failure.message, /\.sch-loop\/ is SCH control state/);
  fx.done();
});

test("hardening: an unknown control category is refused before anything runs", async () => {
  const fx = fixture("hd-cat"); initWorkspace(fx);
  const t = addTask(fx);
  fx.cli("task-set", "--project", fx.P, String(t), "--control-category", "everything");
  const rec = await run(fx, t, fakeExecutor(fx, {}));
  assert.equal(rec.outcome, "FAILED");
  assert.ok(rec.preflight_failures.some((f) => /unknown control category/.test(f.message)));
  fx.done();
});

// ------------------------------------------------- raw vs promoted handoff

test("hardening: the raw handoff stays in the ignored run directory", async () => {
  const fx = fixture("hd-handoff"); initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/h.js", content: "h\n" }] }));
  assert.equal(rec.outcome, "VERIFIED");
  assert.ok(existsSync(join(rec.run_dir, "handoff.md")), "the raw handoff belongs to the run");
  assert.equal(existsSync(join(fx.repo, ".sch-loop", "handoffs", String(t))), false,
    "no durable file is created for an attempt nobody asked to keep");
  // and it is ignored, so it never dirties the tree for the next run
  assert.doesNotMatch(git(fx.repo, "status", "--porcelain", "--untracked-files=all"), /handoff\.md/);
  fx.done();
});

test("hardening: a failed attempt leaves no durable litter either", async () => {
  const fx = fixture("hd-litter"); initWorkspace(fx);
  const t = addTask(fx);
  await run(fx, t, fakeExecutor(fx, { write: [{ path: "wandered.txt", content: "x\n" }] }));
  assert.equal(existsSync(join(fx.repo, ".sch-loop", "handoffs")), true, "the directory exists from init");
  assert.deepEqual(readdirSync(join(fx.repo, ".sch-loop", "handoffs")), [], "but nothing was promoted into it");
  fx.done();
});

test("hardening: promotion is explicit, deterministic and carries provenance", async () => {
  const fx = fixture("hd-promote"); const ws = initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/p.js", content: "p\n" }] }));
  const r = JSON.parse(fx.cli("handoff-promote", "--project", fx.P, "--run", rec.run_id, "--reason", "worth keeping"));
  assert.equal(r.ok, true);
  const promoted = readFileSync(join(fx.repo, ".sch-loop", "handoffs", String(t), `${rec.run_id}.md`), "utf8");
  assert.match(promoted, /promoted by SCH/);
  assert.match(promoted, new RegExp(`run: ${rec.run_id}`));
  assert.match(promoted, /reason: worth keeping/);
  assert.match(promoted, /## System outcome \(authoritative\)/, "the raw handoff is preserved verbatim below the header");
  // deterministic: promoting twice produces the same bytes
  const first = promoted;
  RUN.promoteHandoff(ws, fx.P, rec.run_id, { reason: "worth keeping" });
  assert.equal(readFileSync(join(fx.repo, ".sch-loop", "handoffs", String(t), `${rec.run_id}.md`), "utf8"), first);
  fx.done();
});

test("hardening: a previous attempt's handoff is still found, from the run artifacts", async () => {
  const fx = fixture("hd-prev"); const ws = initWorkspace(fx);
  const t = addTask(fx);
  const first = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/one.js", content: "1\n" }],
    handoff: { summary: "THE-FIRST-ATTEMPT-SUMMARY" } }));
  git(fx.repo, "add", "-A"); git(fx.repo, "commit", "-q", "-m", "accept");
  const prev = RUN.previousHandoff(ws, t, "RUN-nonexistent");
  assert.match(prev, /THE-FIRST-ATTEMPT-SUMMARY/);
  assert.equal(RUN.previousHandoff(ws, t, first.run_id), null, "the current run is not its own predecessor");
  fx.done();
});

// ------------------------------------------ structured verification commands

test("hardening: a verification argument may contain a space", async () => {
  const fx = fixture("hd-verify"); initWorkspace(fx);
  // the classic failure: a path with a space, split into two arguments
  const script = "tests/a file with spaces.mjs";
  mkdirSync(join(fx.repo, "tests"), { recursive: true });
  writeFileSync(join(fx.repo, script), "process.exit(0)\n");
  git(fx.repo, "add", "-A"); git(fx.repo, "commit", "-q", "-m", "add the test file");

  const t = Number(fx.cli("task-add", "--project", fx.P, "--title", "spaces", "--ac", "x", "--allow", "src/**",
    "--verify-json", JSON.stringify([{ id: "unit-tests", exe: process.execPath, args: [script], cwd: ".", timeout_ms: 60000 }])));
  const stored = JSON.parse(fx.cli("task-get", "--project", fx.P, String(t))).verify;
  assert.deepEqual(stored[0].args, [script], "the argument is stored as ONE argument");
  assert.equal(stored[0].id, "unit-tests");
  assert.equal(stored[0].cwd, ".");
  assert.equal(stored[0].timeout_ms, 60000);

  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/s.js", content: "s\n" }] }));
  assert.equal(rec.outcome, "VERIFIED", JSON.stringify(rec.failure));
  const v = JSON.parse(readFileSync(join(rec.run_dir, "verification.json"), "utf8"));
  assert.deepEqual(v.results[0].args, [script]);
  assert.equal(v.results[0].result, "PASSED");
  assert.match(v.results[0].display, /"tests\/a file with spaces\.mjs"/, "the display form quotes it, and is display only");
  fx.done();
});

test("hardening: CLI shorthand compiles into the structured shape", () => {
  const fx = fixture("hd-shorthand"); initWorkspace(fx);
  const t = addTask(fx, { verify: "npm test|npm run lint" });
  const v = JSON.parse(fx.cli("task-get", "--project", fx.P, String(t))).verify;
  assert.equal(v.length, 2);
  assert.deepEqual(v.map((x) => [x.exe, x.args]), [["npm", ["test"]], ["npm", ["run", "lint"]]]);
  for (const x of v) { assert.equal(x.cwd, "."); assert.ok(x.timeout_ms > 0); assert.ok(x.id); }
  fx.done();
});

test("hardening: a verification command with a string for args is refused", () => {
  const problems = RUN.checkVerificationCommand({ id: "x", exe: "npm", args: "test --watch" });
  assert.ok(problems.some((p) => /args must be an array/.test(p)));
  assert.deepEqual(RUN.checkVerificationCommand({ id: "y", exe: "npm", args: ["test"], cwd: ".", timeout_ms: 60000 }), []);
  assert.ok(RUN.checkVerificationCommand({ exe: "npm", args: [], cwd: "/etc" }).some((p) => /repository-relative/.test(p)));
  assert.ok(RUN.checkVerificationCommand({ exe: "npm", args: [], timeout_ms: 5 }).some((p) => /timeout_ms/.test(p)));
});

test("hardening: --verify-json refuses malformed input rather than guessing", () => {
  const fx = fixture("hd-badjson"); initWorkspace(fx);
  assert.throws(() => fx.cli("task-add", "--project", fx.P, "--title", "x", "--verify-json", "{not json"), /not valid JSON/);
  assert.throws(() => fx.cli("task-add", "--project", fx.P, "--title", "x", "--verify-json", '{"exe":"npm"}'), /must be a JSON array/);
  assert.throws(() => fx.cli("task-add", "--project", fx.P, "--title", "x", "--verify-json", '[{"args":["test"]}]'), /needs an "exe"/);
  assert.throws(() => fx.cli("task-add", "--project", fx.P, "--title", "x", "--verify-json", '[{"exe":"npm","args":"test"}]'), /args must be an array/);
  fx.done();
});
