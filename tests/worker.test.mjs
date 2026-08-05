// The worker process itself: a fresh external process per attempt, an explicit
// environment, SCH-owned timeout and cancellation, process-tree cleanup, bounded
// output, and the structured handoff protocol.
//
// No real model is ever invoked: every test drives tests/fixtures/fake-claude.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, fakeExecutor, run, git, RUN, WS, SECRET_ENV, FAKE_CLAUDE } from "./helpers.mjs";

const runsOf = (fx) => readdirSync(join(fx.repo, ".sch-loop", "runs"));
const artifact = (rec, name) => readFileSync(join(rec.run_dir, name), "utf8");

test("worker: a successful fake process produces a VERIFIED run", async () => {
  const fx = fixture("wk-ok"); initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/new.js", content: "added\n" }] }));
  assert.equal(rec.outcome, "VERIFIED", JSON.stringify(rec.failure));
  assert.equal(rec.failure, null);
  assert.match(rec.means, /NOT committed, NOT pushed/, "VERIFIED never means delivered");
  assert.equal(readFileSync(join(fx.repo, "src", "new.js"), "utf8"), "added\n");
  // every required artifact exists
  for (const f of ["run.json", "baseline.json", "prompt.txt", "prompt-manifest.json",
                   "stdout.log", "stderr.log", "git-effects.json", "verification.json",
                   "events.jsonl", "handoff.json", "worker.json"])
    assert.ok(existsSync(join(rec.run_dir, f)), `missing artifact ${f}`);
  // and the change is left UNSTAGED for the (not yet implemented) git controller
  assert.equal(git(fx.repo, "diff", "--cached", "--name-only").trim(), "", "the runner never stages");
  fx.done();
});

test("worker: exactly one task runs, one attempt, and no other task is touched", async () => {
  const fx = fixture("wk-one"); initWorkspace(fx);
  const a = addTask(fx, { title: "the one" });
  const b = addTask(fx, { title: "not this one" });
  const rec = await run(fx, a, fakeExecutor(fx, { write: [{ path: "src/one.js", content: "1\n" }] }));
  assert.equal(rec.outcome, "VERIFIED");
  assert.equal(runsOf(fx).length, 1, "exactly one run directory");
  assert.equal(rec.attempt, 1);
  const state = fx.state();
  assert.equal(state.tasks.find((x) => x.id === a).status, "queued", "the runner never marks a task done");
  assert.equal(state.tasks.find((x) => x.id === b).status, "queued", "the other task is untouched");
  assert.equal(state.runs.length, 1, "one run reference in SCH_HOME");
  assert.equal(state.runs[0].outcome, "VERIFIED");
  fx.done();
});

test("worker: each attempt is a NEW process — no session is reused", async () => {
  const fx = fixture("wk-fresh"); initWorkspace(fx);
  const t = addTask(fx);
  const pids = [];
  for (let i = 0; i < 2; i++) {
    const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: `src/f${i}.js`, content: `${i}\n` }] }), { attempt: i + 1 });
    pids.push(JSON.parse(artifact(rec, "worker.json")).pid);
    git(fx.repo, "add", "-A"); git(fx.repo, "commit", "-q", "-m", "accept " + i);   // clean for the next attempt
  }
  assert.notEqual(pids[0], pids[1], "a second attempt is a different OS process");
  assert.ok(pids.every(Boolean));
  fx.done();
});

test("worker: the environment is an allowlist — unrelated secrets never reach it", async () => {
  const fx = fixture("wk-env"); initWorkspace(fx);
  const t = addTask(fx);
  const envDump = join(fx.home, "worker-env.json");
  const rec = await run(fx, t, fakeExecutor(fx, { envTo: envDump, write: [{ path: "src/e.js", content: "e\n" }] }));
  assert.equal(rec.outcome, "VERIFIED");

  const got = JSON.parse(readFileSync(envDump, "utf8"));
  for (const name of Object.keys(SECRET_ENV))
    assert.equal(got[name], undefined, `${name} must never reach the worker`);
  assert.equal(got.SCH_HOME, undefined, "the worker must not be able to find SCH operational state");
  assert.equal(got.SCH_RUN_ID, rec.run_id, "run identity IS passed");
  assert.equal(got.SCH_PROJECT_ID, fx.P);
  assert.ok(got.PATH || got.Path, "executable discovery survives");
  assert.equal(got.GIT_CONFIG_COUNT, "1", "the credential helper is disabled");
  assert.equal(got.GIT_CONFIG_KEY_0, "credential.helper");
  assert.equal(got.GIT_CONFIG_VALUE_0, "");

  // and none of it is persisted either
  const everything = readdirSync(rec.run_dir).filter((f) => f.endsWith(".json") || f.endsWith(".log") || f.endsWith(".txt"))
    .map((f) => readFileSync(join(rec.run_dir, f), "utf8")).join("\n");
  for (const [name, value] of Object.entries(SECRET_ENV)) {
    assert.ok(!everything.includes(value), `${name}'s VALUE was persisted into a run artifact`);
  }
  const names = JSON.parse(artifact(rec, "worker.json")).environment_names;
  assert.ok(!names.includes("AWS_SECRET_ACCESS_KEY"));
  fx.done();
});

test("worker: the prompt arrives on stdin, never as an argument", async () => {
  const fx = fixture("wk-stdin"); initWorkspace(fx);
  const t = addTask(fx, { title: "a distinctive task title" });
  const promptDump = join(fx.home, "prompt.txt");
  const rec = await run(fx, t, fakeExecutor(fx, { promptTo: promptDump, write: [{ path: "src/p.js", content: "p\n" }] }));
  const got = readFileSync(promptDump, "utf8");
  assert.match(got, /a distinctive task title/);
  assert.match(got, /IMMUTABLE RULES/, "the safety kernel is first");
  assert.ok(got.indexOf("IMMUTABLE RULES") < got.indexOf("a distinctive task title"), "safety before task");
  const args = JSON.parse(artifact(rec, "worker.json")).args;
  assert.ok(!args.some((a) => a.includes("distinctive task title")), "the prompt is not in the process arguments");
  fx.done();
});

test("worker: a nonzero exit is a terminal failure with the effects still inspected", async () => {
  const fx = fixture("wk-exit"); initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, { exit: 7, stderr: "the worker crashed", handoff: false,
    write: [{ path: "src/half.js", content: "half done\n" }] }));
  assert.equal(rec.outcome, "FAILED");
  assert.equal(rec.failure.code, "AGENT_PROCESS_FAILURE");
  assert.match(rec.failure.message, /exited 7/);
  assert.equal(rec.worker.exit_code, 7);
  assert.match(artifact(rec, "stderr.log"), /the worker crashed/);
  // the half-finished change is REPORTED, not hidden and not reverted
  const effects = JSON.parse(artifact(rec, "git-effects.json"));
  assert.ok(effects.paths.some((p) => p.path === "src/half.js"));
  assert.equal(readFileSync(join(fx.repo, "src", "half.js"), "utf8"), "half done\n");
  fx.done();
});

test("worker: SCH owns the timeout, kills the tree, and releases the lease", async () => {
  const fx = fixture("wk-timeout"); const ws = initWorkspace(fx);
  const t = addTask(fx);
  const exec = fakeExecutor(fx, { sleepMs: 60000, spawnChild: { afterMs: 4000, path: "grandchild.txt" } }, { timeoutMs: 2000 });
  const t0 = Date.now();
  const rec = await run(fx, t, exec);
  const elapsed = Date.now() - t0;
  assert.equal(rec.outcome, "RETRYABLE", "a timeout is a transient class — but nothing is retried here");
  assert.equal(rec.failure.code, "AGENT_TIMEOUT");
  assert.ok(elapsed < 20000, `SCH stopped it (${elapsed}ms), the worker did not stop itself`);
  assert.equal(rec.worker.timed_out, true);
  assert.ok(rec.worker.cleanup, "cleanup evidence is recorded");
  assert.equal(rec.worker.cleanup.ok, true);
  assert.match(rec.worker.cleanup.method, process.platform === "win32" ? /taskkill/ : /process group/);
  assert.equal(existsSync(RUN.leasePath(ws, t)), false, "the lease is released after a timeout");
  assert.equal(rec.state, "finished", "a timed-out run is never left active");
  // the descendant was killed with its parent
  await new Promise((r) => setTimeout(r, 5000));
  assert.equal(existsSync(join(fx.repo, "grandchild.txt")), false, "a descendant process outlived the tree kill");
  fx.done();
});

test("worker: explicit cancellation is terminal, and the lease is released", async () => {
  const fx = fixture("wk-cancel"); const ws = initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, { selfCancel: true, sleepMs: 30000 }, { timeoutMs: 60000 }));
  assert.equal(rec.outcome, "CANCELLED");
  assert.equal(rec.failure.code, "CANCELLED");
  assert.equal(rec.worker.cancelled, true);
  assert.equal(existsSync(RUN.leasePath(ws, t)), false, "the lease is released after cancellation");
  const types = RUN.readEvents(rec.run_dir).map((e) => e.type);
  assert.ok(types.includes("run.worker_cancelled"));
  assert.ok(types.includes("run.lease_released"));
  fx.done();
});

test("worker: the lease is released after a plain failure too", async () => {
  const fx = fixture("wk-lease-fail"); const ws = initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, { exit: 3, handoff: false }));
  assert.equal(rec.outcome, "FAILED");
  assert.equal(existsSync(RUN.leasePath(ws, t)), false);
  fx.done();
});

test("worker: output is capped and the truncation is recorded, not hidden", async () => {
  const fx = fixture("wk-output"); initWorkspace(fx);
  const t = addTask(fx);
  const exec = fakeExecutor(fx, { stdoutBytes: 300000, stderrBytes: 300000, handoff: false }, { maxOutputBytes: 4096 });
  const rec = await run(fx, t, exec);
  assert.equal(rec.worker.stdout.truncated, true);
  assert.equal(rec.worker.stdout.bytes_kept, 4096);
  assert.ok(rec.worker.stdout.bytes_total > 250000, "the true size is still reported");
  assert.equal(rec.worker.stderr.truncated, true);
  assert.ok(artifact(rec, "stdout.log").length <= 4096);
  // a truncated stream cannot contain a handoff, and that is a protocol failure —
  // never a silent pass
  assert.equal(rec.outcome, "FAILED");
  assert.equal(rec.failure.code, "AGENT_PROTOCOL_ERROR");
  fx.done();
});

test("worker: stdout, stderr, exit code and cleanup are all captured", async () => {
  const fx = fixture("wk-capture"); initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, { stderr: "a warning on stderr", write: [{ path: "src/c.js", content: "c\n" }] }));
  assert.match(artifact(rec, "stdout.log"), /SCH_HANDOFF_JSON/);
  assert.match(artifact(rec, "stderr.log"), /a warning on stderr/);
  const w = JSON.parse(artifact(rec, "worker.json"));
  assert.equal(w.exit_code, 0);
  assert.equal(w.signal, null);
  assert.ok(w.duration_ms >= 0 && w.pid > 0);
  assert.equal(w.cwd, WS.real(fx.repo));
  fx.done();
});

test("worker: SCH_CLAUDE_EXECUTABLE selects the worker binary", async () => {
  const fx = fixture("wk-exe"); initWorkspace(fx);
  const t = addTask(fx);
  const behaviour = join(fx.home, "b.json");
  writeFileSync(behaviour, JSON.stringify({ write: [{ path: "src/x.js", content: "x\n" }] }));
  const rec = await RUN.runTask({
    projectId: fx.P, taskId: t,
    env: { ...process.env, SCH_CLAUDE_EXECUTABLE: process.execPath, SCH_CLAUDE_ARGS: `${FAKE_CLAUDE} ${behaviour}` },
  });
  assert.equal(rec.outcome, "VERIFIED", JSON.stringify(rec.failure));
  assert.equal(JSON.parse(artifact(rec, "worker.json")).executable, process.execPath);
  fx.done();
});

// ---------------------------------------------------------------- handoff

const ident = { run_id: "RUN-x", project_id: "p", task_id: "1" };
const good = (over = {}) => JSON.stringify({
  schema_version: 1, run_id: "RUN-x", project_id: "p", task_id: "1",
  worker_status: "COMPLETED", summary: "ok", ...over,
});
const wrap = (body) => `chatter\n${RUN.HANDOFF_OPEN}\n${body}\n${RUN.HANDOFF_CLOSE}\ntrailing\n`;

test("handoff: a valid block parses and defaults its optional arrays", () => {
  const r = RUN.parseHandoff(wrap(good()), ident);
  assert.equal(r.ok, true);
  assert.equal(r.handoff.worker_status, "COMPLETED");
  assert.deepEqual(r.handoff.files_reported_changed, []);
  assert.deepEqual(r.handoff.tests_reported, []);
});

for (const [name, stdout, why] of [
  ["a missing handoff", "the worker just talked\n", /no handoff block/],
  ["a duplicated handoff", wrap(good()) + wrap(good()), /2 opening and 2 closing/],
  ["a reversed delimiter order", `${RUN.HANDOFF_CLOSE}\n${good()}\n${RUN.HANDOFF_OPEN}\n`, /before the opening/],
  ["malformed JSON", wrap("{not json,,}"), /not valid JSON/],
  ["a JSON array", wrap("[1,2,3]"), /single JSON object/],
  ["a wrong schema version", wrap(good({ schema_version: 2 })), /schema_version 2/],
  ["a wrong run id", wrap(good({ run_id: "RUN-someone-else" })), /run_id .* identity mismatch/],
  ["a wrong project id", wrap(good({ project_id: "other" })), /project_id .* identity mismatch/],
  ["a wrong task id", wrap(good({ task_id: "99" })), /task_id .* identity mismatch/],
  ["an invalid status enum", wrap(good({ worker_status: "DONE" })), /not one of COMPLETED/],
  ["a missing summary", wrap(good({ summary: undefined })), /missing "summary"/],
  ["an oversized field", wrap(good({ summary: "x".repeat(5000) })), /is 5000 characters/],
  ["an oversized array", wrap(good({ files_reported_changed: Array(500).fill("a.js") })), /has 500 items/],
  ["a wrongly typed array", wrap(good({ tests_reported: "all of them" })), /must be an array/],
  ["an oversized handoff", wrap(good({ summary: "s", issues: Array(199).fill("y".repeat(600)) })), /bytes — the limit/],
]) {
  test(`handoff: rejects ${name}`, () => {
    const r = RUN.parseHandoff(stdout, ident);
    assert.equal(r.ok, false, `${name} should have been rejected`);
    assert.equal(r.failure.code, "AGENT_PROTOCOL_ERROR");
    assert.match(r.failure.message, why);
  });
}

test("handoff: a malformed handoff can never produce VERIFIED", async () => {
  const fx = fixture("hf-bad"); initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, {
    write: [{ path: "src/ok.js", content: "fine\n" }],
    raw: `${RUN.HANDOFF_OPEN}\n{ broken\n${RUN.HANDOFF_CLOSE}`,
  }));
  assert.equal(rec.outcome, "FAILED");
  assert.equal(rec.failure.code, "AGENT_PROTOCOL_ERROR");
  assert.ok(!existsSync(join(rec.run_dir, "handoff.json")), "no handoff artifact for an invalid handoff");
  assert.ok(RUN.readEvents(rec.run_dir).some((e) => e.type === "run.handoff_rejected"));
  fx.done();
});

test("handoff: a worker claim that differs from the actual effects is recorded as a difference", async () => {
  const fx = fixture("hf-claim"); initWorkspace(fx);
  const t = addTask(fx, { allow: "src/**" });
  const rec = await run(fx, t, fakeExecutor(fx, {
    write: [{ path: "src/real.js", content: "really changed\n" }],
    handoff: { files_reported_changed: ["src/imaginary.js"] },
  }));
  const effects = JSON.parse(artifact(rec, "git-effects.json"));
  assert.equal(effects.claim_comparison.agrees, false);
  assert.deepEqual(effects.claim_comparison.claimed_not_observed, ["src/imaginary.js"]);
  assert.deepEqual(effects.claim_comparison.observed_not_claimed, ["src/real.js"]);
  // the claim is evidence about the WORKER, never about the repository
  assert.equal(rec.outcome, "VERIFIED", "the actual change was in policy and verification passed");
  fx.done();
});

test("handoff: a worker reporting BLOCKED is never VERIFIED, however green the tests", async () => {
  const fx = fixture("hf-blocked"); initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, {
    write: [{ path: "src/partial.js", content: "partial\n" }],
    handoff: { worker_status: "BLOCKED", summary: "I need a decision about the schema" },
  }));
  assert.equal(rec.outcome, "NEEDS_DECISION");
  assert.equal(rec.failure.code, "AMBIGUOUS_EVIDENCE");
  assert.match(rec.failure.message, /schema/);
  fx.done();
});

test("handoff: the human-readable handoff separates reported, observed and verified", async () => {
  const fx = fixture("hf-md"); initWorkspace(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, {
    write: [{ path: "src/doc.js", content: "doc\n" }],
    handoff: { summary: "I changed everything perfectly", files_reported_changed: ["src/doc.js", "src/lies.js"] },
  }));
  // The RAW handoff lives with the run's other evidence, in the ignored run
  // directory. Promotion into `.sch-loop/handoffs/` is a separate act.
  const md = readFileSync(join(rec.run_dir, "handoff.md"), "utf8");
  assert.match(md, /## Worker reported \(UNTRUSTED/);
  assert.match(md, /## System observed/);
  assert.match(md, /## System verified/);
  assert.match(md, /## System outcome \(authoritative\)/);
  assert.ok(md.indexOf("System outcome") < md.indexOf("Worker reported"),
    "the authoritative verdict is above the worker's story, not below it");
  assert.ok(md.includes("I changed everything perfectly"), "the claim is shown");
  assert.ok(md.indexOf("I changed everything perfectly") > md.indexOf("UNTRUSTED"), "and it is labelled");
  fx.done();
});

test("a run writes evidence to the main workspace while working in workRoot", async () => {
  const fx = fixture("split-root");
  try {
    initWorkspace(fx);
    const t = addTask(fx);
    const alt = join(fx.home, "alt-checkout");
    git(fx.repo, "worktree", "add", alt, "-b", "sch/task-" + t, "HEAD");

    const rec = await run(fx, t, fakeExecutor(fx, {
      write: [{ path: "src/app.js", content: "// edited in the alternate checkout\n" }],
    }), { workRoot: alt });

    assert.equal(rec.outcome, "VERIFIED", JSON.stringify(rec.failure));
    assert.ok(existsSync(join(fx.repo, ".sch-loop", "runs", rec.run_id)),
      "evidence must land in the MAIN repository workspace, not the alternate checkout");
    assert.ok(!existsSync(join(alt, ".sch-loop", "runs", rec.run_id)),
      "no run evidence in the disposable checkout");
    assert.equal(readFileSync(join(alt, "src", "app.js"), "utf8"), "// edited in the alternate checkout\n");
    assert.equal(readFileSync(join(fx.repo, "src", "app.js"), "utf8"), "// app\n",
      "the main working tree must be untouched");
  } finally { fx.done(); }
});


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
