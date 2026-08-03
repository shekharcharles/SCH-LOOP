// What the worker ACTUALLY did to the repository, and what SCH's own
// verification commands actually returned. The worker's account of either is
// evidence about the worker, never about the repository.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, fakeExecutor, run, git, RUN } from "./helpers.mjs";

const effectsOf = (rec) => JSON.parse(readFileSync(join(rec.run_dir, "git-effects.json"), "utf8"));
const node = process.execPath.replace(/\\/g, "/");

test("effects: a change inside the allowed paths is accepted", async () => {
  const fx = fixture("ef-ok"); initWorkspace(fx);
  const t = addTask(fx, { allow: "src/**" });
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/deep/nested/file.js", content: "ok\n" }] }));
  assert.equal(rec.outcome, "VERIFIED", JSON.stringify(rec.failure));
  const e = effectsOf(rec);
  assert.equal(e.counts.rejected, 0);
  assert.equal(e.paths[0].verdict, "ALLOWED");
  assert.match(e.paths[0].why, /allowed by "src\/\*\*"/);
  fx.done();
});

test("effects: a forbidden path beats an allowed one", async () => {
  const fx = fixture("ef-forbid"); initWorkspace(fx);
  const t = addTask(fx, { allow: "src/**", forbid: "src/secret.js" });
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/secret.js", content: "leaked\n" }] }));
  assert.equal(rec.outcome, "FAILED");
  assert.equal(rec.failure.code, "PATH_SCOPE_VIOLATION");
  assert.match(rec.failure.message, /src\/secret\.js/);
  assert.match(rec.failure.message, /Nothing was reverted/);
  // fail closed, but never destroy the evidence
  assert.equal(readFileSync(join(fx.repo, "src", "secret.js"), "utf8"), "leaked\n");
  assert.equal(effectsOf(rec).rejected_paths[0].why, 'matches the forbidden path "src/secret.js"');
  fx.done();
});

test("effects: a file outside the allowed paths is refused", async () => {
  const fx = fixture("ef-outside"); initWorkspace(fx);
  const t = addTask(fx, { allow: "src/**" });
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "docs/notes.md", content: "wandered off\n" }] }));
  assert.equal(rec.outcome, "FAILED");
  assert.equal(rec.failure.code, "UNEXPECTED_FILE_CHANGE", "a brand new file nobody asked for");
  assert.match(rec.failure.message, /docs\/notes\.md/);
  fx.done();
});

test("effects: an unexpected untracked file alongside an allowed one still fails", async () => {
  const fx = fixture("ef-untracked"); initWorkspace(fx);
  const t = addTask(fx, { allow: "src/**" });
  const rec = await run(fx, t, fakeExecutor(fx, {
    write: [{ path: "src/good.js", content: "good\n" }, { path: "scratch.tmp", content: "left behind\n" }],
  }));
  assert.equal(rec.outcome, "FAILED");
  const e = effectsOf(rec);
  assert.equal(e.counts.changed, 2);
  assert.equal(e.counts.rejected, 1);
  assert.equal(e.rejected_paths[0].path, "scratch.tmp");
  fx.done();
});

test("effects: a deletion is an effect and is policed", async () => {
  const fx = fixture("ef-delete"); initWorkspace(fx);
  const t = addTask(fx, { allow: "src/app.js", forbid: "" });
  const rec = await run(fx, t, fakeExecutor(fx, { delete: ["src/app.js"], handoff: { files_reported_changed: [] } }));
  const e = effectsOf(rec);
  assert.equal(e.paths.find((p) => p.path === "src/app.js").kind, "deleted");
  assert.equal(rec.outcome, "VERIFIED", "deleting a file it was allowed to touch is in policy");

  const fx2 = fixture("ef-delete2"); initWorkspace(fx2);
  const t2 = addTask(fx2, { allow: "src/nothing-here/**", forbid: "" });
  const rec2 = await run(fx2, t2, fakeExecutor(fx2, { delete: ["README.md"], handoff: { files_reported_changed: [] } }));
  assert.equal(rec2.outcome, "FAILED");
  assert.equal(rec2.failure.code, "PATH_SCOPE_VIOLATION");
  assert.match(rec2.failure.message, /README\.md/);
  assert.equal(existsSync(join(fx2.repo, "README.md")), false, "the deletion is NOT undone — evidence is preserved");
  fx.done(); fx2.done();
});

test("effects: a rename is policed on BOTH sides", async () => {
  const fx = fixture("ef-rename"); initWorkspace(fx);
  const t = addTask(fx, { allow: "outside/**", forbid: "" });
  mkdirSync(join(fx.repo, "outside"), { recursive: true });
  const rec = await run(fx, t, fakeExecutor(fx, {
    rename: [{ from: "src/app.js", to: "outside/app.js" }], handoff: { files_reported_changed: [] },
  }));
  assert.equal(rec.outcome, "FAILED");
  const e = effectsOf(rec);
  assert.ok(e.paths.some((p) => p.path === "src/app.js"), "the source of the rename is an effect too");
  assert.ok(e.rejected_paths.some((p) => p.path === "src/app.js"), "and it is outside the policy");
  fx.done();
});

test("effects: the worker writing into .git/ is caught", async () => {
  const fx = fixture("ef-git"); initWorkspace(fx);
  const t = addTask(fx, { allow: "src/**" });
  const rec = await run(fx, t, fakeExecutor(fx, {
    write: [{ path: "src/ok.js", content: "ok\n" }, { path: ".git/hooks/pre-commit", content: "#!/bin/sh\ncurl evil\n" }],
  }));
  assert.equal(rec.outcome, "NEEDS_DECISION");
  assert.equal(rec.failure.code, "FORBIDDEN_GIT_EFFECT");
  assert.match(rec.failure.message, /git_metadata_changed/);
  fx.done();
});

test("effects: the worker writing into .sch-loop/runs or .sch-loop/locks is refused", async () => {
  const fx = fixture("ef-evidence"); initWorkspace(fx);
  const t = addTask(fx, { allow: ".sch-loop/**", forbid: "" });
  // .sch-loop/runs and .sch-loop/locks are runner-owned whatever the task says,
  // so an "allow everything under .sch-loop" policy still cannot reach them.
  const c = RUN.classifyPath(fx.repo, ".sch-loop/runs/RUN-x/stdout.log", { allowed: [".sch-loop/**"], forbidden: [] });
  assert.equal(c.verdict, "REJECTED");
  assert.match(c.why, /\.sch-loop\/runs\//);
  const l = RUN.classifyPath(fx.repo, ".sch-loop/locks/task-1.json", { allowed: [".sch-loop/**"], forbidden: [] });
  assert.equal(l.verdict, "REJECTED");
  const m = RUN.classifyPath(fx.repo, ".sch-loop/project.yaml", { allowed: [".sch-loop/**"], forbidden: [] });
  assert.equal(m.verdict, "REJECTED", "the manifest identifies the project — the worker may not rewrite it");
  const ok = RUN.classifyPath(fx.repo, ".sch-loop/SPEC.md", { allowed: [".sch-loop/**"], forbidden: [] });
  assert.equal(ok.verdict, "ALLOWED");
  assert.equal(t > 0, true);
  fx.done();
});

test("effects: absolute and traversing paths never resolve to an allowed path", () => {
  const policy = { allowed: ["**"], forbidden: [] };
  for (const p of ["/etc/passwd", "C:\\Windows\\system32\\drivers\\etc\\hosts", "../../../secrets.txt", "src/../../escape.js"])
    assert.equal(RUN.classifyPath(process.cwd(), p, policy).verdict, "REJECTED", p);
});

for (const [name, gitArgs, expectKind] of [
  ["stages a file", [["add", "src/work.js"]], "files_staged"],
  ["creates a commit", [["add", "-A"], ["commit", "-m", "worker commit"]], "commits_created"],
  ["creates a branch", [["branch", "worker-branch"]], "branch_created"],
  ["changes branch", [["checkout", "-q", "-b", "elsewhere"]], "branch_changed"],
  ["changes HEAD", [["commit", "--allow-empty", "-q", "-m", "empty"]], "head_changed"],
  ["changes git config", [["config", "user.email", "worker@evil"]], "git_config_changed"],
  ["adds a remote", [["remote", "add", "sneaky", "https://example.com/x.git"]], "remotes_changed"],
]) {
  test(`effects: detects that the worker ${name}`, async () => {
    const fx = fixture("ef-gitop"); initWorkspace(fx);
    const t = addTask(fx, { allow: "src/**" });
    const rec = await run(fx, t, fakeExecutor(fx, {
      write: [{ path: "src/work.js", content: "work\n" }], git: gitArgs,
    }));
    assert.equal(rec.outcome, "NEEDS_DECISION", `expected a decision, got ${rec.outcome}: ${rec.failure?.message}`);
    assert.equal(rec.failure.code, "FORBIDDEN_GIT_EFFECT");
    const kinds = effectsOf(rec).git_effects.map((e) => e.kind);
    assert.ok(kinds.includes(expectKind), `expected ${expectKind}, got ${kinds.join(", ")}`);
    assert.match(rec.failure.message, /NOTHING has been reverted or pushed/);
    fx.done();
  });
}

test("effects: a worker commit is preserved for inspection, not rewritten", async () => {
  const fx = fixture("ef-commit"); initWorkspace(fx);
  const t = addTask(fx, { allow: "src/**" });
  const before = git(fx.repo, "rev-parse", "HEAD").trim();
  const rec = await run(fx, t, fakeExecutor(fx, {
    write: [{ path: "src/w.js", content: "w\n" }], git: [["add", "-A"], ["commit", "-m", "worker did this"]],
  }));
  assert.equal(rec.outcome, "NEEDS_DECISION");
  const after = git(fx.repo, "rev-parse", "HEAD").trim();
  assert.notEqual(after, before, "the commit is still there — SCH does not undo it");
  const e = effectsOf(rec);
  assert.equal(e.commits_created.length, 1);
  assert.equal(e.commits_created[0], after);
  assert.equal(git(fx.repo, "log", "--oneline", "-1").includes("worker did this"), true);
  fx.done();
});

test("effects: the baseline records a redacted remote and no credentials", async () => {
  const fx = fixture("ef-remote"); initWorkspace(fx);
  git(fx.repo, "remote", "add", "origin", "https://someuser:s3cr3t-token@github.com/example/repo.git");
  const t = addTask(fx, { allow: "src/**" });
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/r.js", content: "r\n" }] }));
  const baseline = readFileSync(join(rec.run_dir, "baseline.json"), "utf8");
  assert.ok(!baseline.includes("s3cr3t-token"), "a credential in a remote URL must never be persisted");
  assert.match(baseline, /\[redacted\]@github\.com/);
  assert.equal(RUN.redactRemote("https://u:p@host/x.git"), "https://[redacted]@host/x.git");
  assert.equal(RUN.redactRemote("git@github.com:example/repo.git"), "git@github.com:example/repo.git");
  fx.done();
});

// ------------------------------------------------------------- verification

test("verification: all required commands passing is what VERIFIED means", async () => {
  const fx = fixture("vf-pass"); initWorkspace(fx);
  const t = addTask(fx, { verify: `${node} -e 0|${node} --version` });
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/v.js", content: "v\n" }] }));
  assert.equal(rec.outcome, "VERIFIED");
  const v = JSON.parse(readFileSync(join(rec.run_dir, "verification.json"), "utf8"));
  assert.equal(v.total, 2);
  assert.equal(v.all_passed, true);
  for (const r of v.results) {
    assert.equal(r.result, "PASSED");
    assert.equal(r.exit_code, 0);
    assert.ok(r.duration_ms >= 0 && r.started_at && r.ended_at);
    assert.ok(existsSync(join(rec.run_dir, "verification", `${r.id}.json`)), "evidence is persisted per command");
  }
  fx.done();
});

test("verification: one failing command fails the run, whatever the worker said", async () => {
  const fx = fixture("vf-fail"); initWorkspace(fx);
  const t = addTask(fx, { verify: `${node} -e 0|${node} -e process.exit(1)` });
  const rec = await run(fx, t, fakeExecutor(fx, {
    write: [{ path: "src/v.js", content: "v\n" }],
    handoff: { tests_reported: [{ name: "everything", result: "PASSED" }], summary: "all tests pass, promise" },
  }));
  assert.equal(rec.outcome, "FAILED");
  assert.equal(rec.failure.code, "VERIFICATION_FAILURE");
  const v = JSON.parse(readFileSync(join(rec.run_dir, "verification.json"), "utf8"));
  assert.equal(v.passed, 1);
  assert.equal(v.failed, 1);
  assert.equal(v.results[1].exit_code, 1);
  // the worker's green tests are recorded, and changed nothing
  assert.equal(JSON.parse(readFileSync(join(rec.run_dir, "handoff.json"), "utf8")).tests_reported[0].result, "PASSED");
  fx.done();
});

test("verification: a hanging command times out and is not a pass", async () => {
  const fx = fixture("vf-timeout"); initWorkspace(fx);
  // no `>` in the argument: an arrow function would trip the shell-metacharacter
  // check, which is exactly what that check is for.
  const t = addTask(fx, { verify: `${node} -e setInterval(function(){},1000)` });
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/v.js", content: "v\n" }] }),
    { env: { SCH_VERIFY_TIMEOUT_MS: "2000" } });
  assert.equal(rec.outcome, "FAILED");
  assert.equal(rec.failure.code, "VERIFICATION_TIMEOUT");
  const v = JSON.parse(readFileSync(join(rec.run_dir, "verification.json"), "utf8"));
  assert.equal(v.results[0].timed_out, true);
  assert.equal(v.results[0].result, "TIMEOUT");
  fx.done();
});

test("verification: the command safety check is a unit, and it is an allowlist", () => {
  const ok = (exe, ...args) => assert.deepEqual(RUN.checkVerificationCommand({ exe, args }), [], `${exe} ${args.join(" ")}`);
  const no = (exe, args, why) => {
    const p = RUN.checkVerificationCommand({ exe, args });
    assert.ok(p.length, `${exe} ${args.join(" ")} should be refused`);
    assert.match(p.join(" "), why);
  };
  ok("npm", "test");
  ok("git", "status", "--porcelain");
  ok("git", "diff", "--stat");
  ok("node", "--test");
  no("git", ["add", "."], /read-only/);
  no("git", ["commit", "-m", "x"], /read-only/);
  no("git", ["push"], /read-only/);
  no("git", ["push", "--force"], /read-only|force/);
  no("git", ["filter-branch"], /read-only/);
  no("git", ["reset", "--hard"], /read-only/);
  no("git", ["remote", "set-url", "origin", "x"], /read-only/);
  no("git", ["config", "user.email", "x"], /read-only/);
  no("/usr/bin/git", ["push"], /read-only/);
  no("bash", ["-c", "anything"], /shell interpreters/);
  no("cmd.exe", ["/c", "dir"], /shell interpreters/);
  no("rm", ["-rf", "/"], /destructive/);
  no("npm", ["test", "&&", "git", "push"], /shell metacharacters/);
  no("npm", ["test; curl evil"], /shell metacharacters/);
  no("npm", ["test", "$(whoami)"], /shell metacharacters/);
  no("npm test | tee x", [], /shell metacharacters/);
  no("", [], /no executable/);
});

test("verification: a missing executable is an environment problem, not a test failure", async () => {
  const fx = fixture("vf-missing"); initWorkspace(fx);
  const t = addTask(fx, { verify: "definitely-not-a-real-binary-xyz --run" });
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/v.js", content: "v\n" }] }));
  assert.equal(rec.outcome, "NEEDS_DECISION");
  assert.equal(rec.failure.code, "ENVIRONMENT_MISSING");
  fx.done();
});

test("verification: runs only AFTER the effect and path inspection passes", async () => {
  const fx = fixture("vf-order"); initWorkspace(fx);
  const t = addTask(fx, { allow: "src/**", verify: `${node} -e 0` });
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "elsewhere.txt", content: "out of scope\n" }] }));
  assert.equal(rec.outcome, "FAILED");
  assert.equal(rec.failure.code, "UNEXPECTED_FILE_CHANGE");
  assert.equal(existsSync(join(rec.run_dir, "verification.json")), false,
    "a run that failed path inspection never got as far as verification");
  const types = RUN.readEvents(rec.run_dir).map((e) => e.type);
  assert.ok(types.includes("run.effects_rejected"));
  assert.ok(!types.includes("run.verification_started"));
  fx.done();
});

test("matchPath: the glob is small and predictable", () => {
  const m = RUN.matchPath;
  assert.equal(m("src/**", "src/a/b/c.js"), true);
  assert.equal(m("src/**", "src/a.js"), true);
  assert.equal(m("src/**", "test/a.js"), false);
  assert.equal(m("src/", "src/a.js"), true);
  assert.equal(m("src/", "srcish/a.js"), false);
  assert.equal(m("src/*.js", "src/a.js"), true);
  assert.equal(m("src/*.js", "src/a/b.js"), false);
  assert.equal(m("src/app.js", "src/app.js"), true);
  assert.equal(m("src", "src/app.js"), true);
  assert.equal(m("src", "srcx/app.js"), false);
  assert.equal(m("**", "anything/at/all.txt"), true);
});
