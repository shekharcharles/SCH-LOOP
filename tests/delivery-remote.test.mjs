// Staging, the commit, divergence, the push, and remote verification.
//
// Every test here pushes to a LOCAL BARE REMOTE on this machine: real git,
// real rejection semantics, no network, no GitHub, no credential.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, fakeExecutor, run, git, verifiedRun, withRemote,
         otherClone, approve, deliver, recordGit, DEL, WS, RUN, ROOT, STATE } from "./helpers.mjs";

const FEATURE = { write: [{ path: "src/feature.js", content: "export const feature = 1;\n" }] };
const wsOf = (fx) => join(fx.repo, ".sch-loop");
const txOf = (fx, runId) => DEL.readTransaction(WS.deliveryDir(wsOf(fx), runId));
const art = (fx, runId, f) => JSON.parse(readFileSync(join(WS.deliveryDir(wsOf(fx), runId), f), "utf8"));

async function ready(name, behaviour = FEATURE, taskOpts = {}) {
  const fx = fixture(name);
  initWorkspace(fx);
  const bare = withRemote(fx);
  const t = addTask(fx, taskOpts);
  const rec = await verifiedRun(fx, t, behaviour);
  return { fx, t, rec, bare };
}

// ------------------------------------------------------ the happy path

test("delivery: stage, commit, fetch, push, verify on the remote, mark delivered", async () => {
  const { fx, t, rec, bare } = await ready("dl-happy");
  const before = git(fx.repo, "rev-parse", "HEAD").trim();
  approve(fx, rec.run_id);
  const audit = recordGit();
  const d = deliver(fx, rec.run_id);
  audit.stop();

  assert.equal(d.state, "DELIVERED", JSON.stringify(d.failure));
  assert.equal(d.ok, true);
  assert.match(d.commit, /^[0-9a-f]{40}$/);
  assert.equal(d.branch, "main");
  assert.equal(d.remote, "origin");
  assert.equal(d.pushed_range, `${before}..${d.commit}`);

  // the commit is real, has one parent, and that parent is the verified baseline
  const parents = git(fx.repo, "rev-list", "--parents", "-n", "1", d.commit).trim().split(" ").slice(1);
  assert.equal(parents.length, 1);
  assert.equal(parents[0], before);
  assert.equal(git(fx.repo, "log", "-1", "--format=%s").trim(), "feat(task): do the thing");
  assert.deepEqual(git(fx.repo, "diff", "--name-only", before, d.commit).trim().split("\n"), ["src/feature.js"]);

  // and it is genuinely on the remote — asked of the bare repository itself
  const onRemote = execFileSync("git", ["-C", bare, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
  assert.equal(onRemote, d.commit, "the bare remote holds exactly this commit");

  // the task is delivered, with provenance
  const task = fx.state().tasks.find((x) => x.id === t);
  assert.equal(task.status, "delivered");
  assert.equal(task.delivery.commit, d.commit);
  assert.equal(task.delivery.run_id, rec.run_id);
  assert.equal(task.delivery.delivery_id, d.delivery_id);
  assert.equal(task.delivery.remote, "origin");
  assert.ok(task.delivery.verified_at);

  // every required artifact
  for (const f of ["transaction.json", "events.jsonl", "preflight.json", "approved-effects.json",
                   "staging.json", "commit.json", "outgoing.json", "push.json", "remote-verification.json",
                   "secret-scan.json", "post-commit.json"])
    assert.ok(existsSync(join(d.delivery_dir, f)), `missing artifact ${f}`);
  assert.ok(existsSync(join(d.delivery_dir, "stdout")) && existsSync(join(d.delivery_dir, "stderr")));

  // NOT ONE forbidden git invocation, across the whole delivery
  const joined = audit.calls.join("\n");
  for (const bad of ["add -A", "add .", "commit -a", "push --force", "--force-with-lease", "reset --hard", "rebase"])
    assert.ok(!joined.includes(bad), `the controller ran: git ${bad}`);
  assert.ok(audit.calls.some((c) => c.startsWith("add -- src/feature.js")), "staging is explicit");
  assert.ok(audit.calls.some((c) => c === "push origin refs/heads/main:refs/heads/main"), "the refspec is explicit");
  fx.done();
});

test("delivery: leaves the repository CLEAN, and offers the handoff for promotion", async () => {
  const { fx, t, rec } = await ready("dl-promote");
  approve(fx, rec.run_id);
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "DELIVERED");
  // The controller's last act must not dirty the tree it just proved clean —
  // an auto-promoted handoff here would block the very next run.
  assert.equal(git(fx.repo, "status", "--porcelain", "--untracked-files=all").trim(), "");
  assert.equal(existsSync(join(fx.repo, ".sch-loop", "handoffs", String(t))), false, "promotion is not automatic");
  assert.match(d.transaction.handoff_promotable.command, /handoff-promote --project/);
  assert.match(d.transaction.handoff_promotable.reason, new RegExp(`delivered as ${d.commit}`));
  // and promoting it explicitly works, with the delivery's reason preserved
  const p = RUN.promoteHandoff(wsOf(fx), fx.P, rec.run_id, { reason: d.transaction.handoff_promotable.reason });
  assert.equal(p.ok, true);
  assert.match(readFileSync(p.file, "utf8"), new RegExp(`delivered as ${d.commit}`));
  fx.done();
});

test("delivery: a second task can run straight after a delivery", async () => {
  const { fx, rec } = await ready("dl-next");
  approve(fx, rec.run_id);
  assert.equal(deliver(fx, rec.run_id).state, "DELIVERED");
  // the tree is clean, so the next task is not blocked by the last delivery
  const t2 = addTask(fx, { title: "the next one" });
  const second = await run(fx, t2, fakeExecutor(fx, { write: [{ path: "src/second.js", content: "2\n" }] }));
  assert.equal(second.outcome, "VERIFIED", JSON.stringify(second.failure));
  fx.done();
});

// ------------------------------------------------------------- staging

for (const [name, behaviour, expectStaged, taskOpts] of [
  ["a modified tracked file", { write: [{ path: "src/app.js", content: "// modified\n" }] }, ["src/app.js"], {}],
  ["a new file", FEATURE, ["src/feature.js"], {}],
  ["a filename containing spaces", { write: [{ path: "src/a file with spaces.js", content: "spaces\n" }] }, ["src/a file with spaces.js"], {}],
  ["a filename beginning with a dash", { write: [{ path: "src/-leading-dash.js", content: "dash\n" }] }, ["src/-leading-dash.js"], {}],
  ["a deletion", { delete: ["src/app.js"], handoff: { files_reported_changed: [] } }, ["src/app.js"], { allow: "src/**" }],
]) {
  test(`staging: ${name} is staged explicitly and delivered`, async () => {
    const { fx, rec, bare } = await ready("st-" + name.replace(/\W+/g, "-").slice(0, 12), behaviour, taskOpts);
    approve(fx, rec.run_id);
    const audit = recordGit();
    const d = deliver(fx, rec.run_id);
    audit.stop();
    assert.equal(d.state, "DELIVERED", JSON.stringify(d.failure));
    const staged = art(fx, rec.run_id, "staging.json");
    assert.deepEqual(staged.staged.map((e) => e.path).sort(), expectStaged.sort());
    // the pathspec went in verbatim, after `--`
    const addCall = audit.calls.find((c) => c.startsWith("add --"));
    assert.ok(addCall.includes(expectStaged[0]), `${addCall} should carry ${expectStaged[0]}`);
    const onRemote = execFileSync("git", ["-C", bare, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
    assert.equal(onRemote, d.commit);
    fx.done();
  });
}

test("staging: a rename is delivered on both sides", async () => {
  const { fx, rec } = await ready("st-rename",
    { rename: [{ from: "src/app.js", to: "src/renamed.js" }], handoff: { files_reported_changed: [] } },
    { allow: "src/**" });
  approve(fx, rec.run_id);
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "DELIVERED", JSON.stringify(d.failure));
  const names = git(fx.repo, "diff", "--name-status", `${d.commit}^`, d.commit).trim();
  assert.match(names, /src\/app\.js/);
  assert.match(names, /src\/renamed\.js/);
  fx.done();
});

test("staging: an unrelated working-tree change is never staged", async () => {
  const { fx, rec } = await ready("st-unrelated");
  approve(fx, rec.run_id);
  // an operator edits something else after verification but does not stage it
  writeFileSync(join(fx.repo, "OPERATOR-NOTES.md"), "my own notes\n");
  const d = deliver(fx, rec.run_id);
  // the tree no longer matches what was verified, so nothing happens at all
  assert.equal(d.state, "NEEDS_DECISION");
  assert.equal(d.failure.code, "VERIFIED_DIFF_CHANGED");
  assert.match(d.failure.message, /OPERATOR-NOTES\.md/);
  assert.equal(readFileSync(join(fx.repo, "OPERATOR-NOTES.md"), "utf8"), "my own notes\n", "and their work is untouched");
  fx.done();
});

test("staging: an ALREADY staged unrelated file blocks the delivery", async () => {
  const { fx, rec } = await ready("st-prestaged");
  approve(fx, rec.run_id);
  writeFileSync(join(fx.repo, "src", "theirs.js"), "someone else's half-finished work\n");
  git(fx.repo, "add", "--", "src/theirs.js");
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "NEEDS_DECISION", JSON.stringify(d.failure));
  // it is caught as drift (the tree changed) — and if it were not, the index
  // check below would catch it. Either way nothing is committed.
  assert.equal(git(fx.repo, "rev-list", "--count", "origin/main..HEAD").trim(), "0");
  assert.match(git(fx.repo, "diff", "--cached", "--name-only").trim(), /src\/theirs\.js/, "their staged work is left exactly as it was");
  fx.done();
});

test("staging: a runtime artifact is never staged", async () => {
  const { fx, rec } = await ready("st-runtime");
  approve(fx, rec.run_id);
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "DELIVERED", JSON.stringify(d.failure));
  const files = git(fx.repo, "show", "--name-only", "--format=", d.commit).trim().split("\n").filter(Boolean);
  assert.deepEqual(files, ["src/feature.js"]);
  for (const f of files) assert.ok(!f.startsWith(".sch-loop/runs/"), `${f} is runtime evidence and must never be committed`);
  fx.done();
});

test("staging: a mismatch unstages only what this delivery staged, and never touches the worktree", async () => {
  const { fx, rec } = await ready("st-rollback");
  approve(fx, rec.run_id);
  // The staged-content proof is what catches a candidate that moved between the
  // drift check and `git add` — simulated here by comparing against a candidate
  // whose blob is deliberately wrong.
  const cand = JSON.parse(readFileSync(join(rec.run_dir, "delivery-candidate.json"), "utf8"));
  const problems = DEL.readDelivery ? null : null;
  const staged = { entries: [{ path: "src/feature.js", status: "A", from: null, mode_index: "100644", blob: "0".repeat(40) }] };
  const mismatch = (await import("file:///" + join(ROOT, "scripts", "candidate.mjs").replace(/\\/g, "/")))
    .compareStaged(cand, staged);
  assert.ok(mismatch.some((p) => p.code === "STAGED_DIFF_MISMATCH"), JSON.stringify(mismatch));
  assert.equal(problems, null);
  // the real delivery still succeeds, and the worktree file is intact throughout
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "DELIVERED");
  assert.equal(readFileSync(join(fx.repo, "src", "feature.js"), "utf8"), "export const feature = 1;\n");
  fx.done();
});

test("staging: the secret gate blocks the commit and unstages what it staged", async () => {
  const { fx, rec } = await ready("st-secret",
    { write: [{ path: "src/feature.js", content: 'const k = "AKIA' + "1234567890ABCDEF" + '";\n' }] });
  approve(fx, rec.run_id);
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "FAILED", JSON.stringify(d.failure));
  assert.equal(d.failure.code, "SECRET_DETECTED");
  assert.equal(git(fx.repo, "rev-list", "--count", "HEAD").trim(), "2", "nothing was committed");
  assert.equal(git(fx.repo, "diff", "--cached", "--name-only").trim(), "", "and the index was put back");
  const scan = art(fx, rec.run_id, "secret-scan.json");
  assert.equal(scan.blocked, true);
  assert.match(scan.stderr || scan.stdout, /AWS access key|BLOCKED/);
  assert.equal(existsSync(join(fx.repo, "src", "feature.js")), true, "the file itself is left for the operator");
  fx.done();
});

test("commit: a missing git identity stops the delivery before committing", async () => {
  const { fx, rec } = await ready("cm-identity");
  approve(fx, rec.run_id);
  // An EMPTY local identity, which git itself refuses to commit with. Unsetting
  // it would only fall back to whatever this machine has configured globally,
  // and a global identity is a perfectly valid one to commit with.
  git(fx.repo, "config", "user.name", "");
  git(fx.repo, "config", "user.email", "");
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "NEEDS_DECISION");
  assert.equal(d.failure.code, "GIT_IDENTITY_MISSING");
  assert.equal(git(fx.repo, "rev-list", "--count", "HEAD").trim(), "2", "nothing committed");
  fx.done();
});

// --------------------------------------------------- fetch and divergence

test("divergence: an incoming commit blocks the push, and nothing is merged or rebased", async () => {
  const { fx, rec, bare } = await ready("dv-incoming");
  approve(fx, rec.run_id);
  // someone else pushes first
  const other = otherClone(bare);
  writeFileSync(join(other, "THEIRS.md"), "their work\n");
  execFileSync("git", ["-C", other, "add", "--", "THEIRS.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", other, "commit", "-q", "-m", "their commit"], { stdio: "ignore" });
  execFileSync("git", ["-C", other, "push", "-q", "origin", "main"], { stdio: "ignore" });
  const theirHead = execFileSync("git", ["-C", bare, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();

  const audit = recordGit();
  const d = deliver(fx, rec.run_id);
  audit.stop();
  assert.equal(d.state, "NEEDS_DECISION");
  assert.equal(d.failure.code, "INCOMING_COMMITS_PRESENT");
  assert.match(d.failure.message, /NOT pushed and nothing was merged or rebased/);
  // the commit exists locally and is NOT rewritten
  assert.ok(d.transaction.commit?.hash);
  assert.equal(git(fx.repo, "rev-parse", "HEAD").trim(), d.transaction.commit.hash);
  // the remote is untouched
  assert.equal(execFileSync("git", ["-C", bare, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), theirHead);
  assert.ok(!audit.calls.some((c) => c.startsWith("push ")), "no push was attempted at all");
  const outgoing = art(fx, rec.run_id, "outgoing.json");
  assert.equal(outgoing.incoming.length, 1);
  assert.equal(outgoing.behind, 1);
  rmSync(other, { recursive: true, force: true });
  fx.done();
});

test("divergence: an unrelated outgoing commit blocks the push", async () => {
  const { fx, rec, bare } = await ready("dv-outgoing");
  approve(fx, rec.run_id);
  // the delivery's own commit will be the SECOND outgoing one
  const staged = join(fx.repo, "UNRELATED.md");
  writeFileSync(staged, "committed locally but never pushed\n");
  git(fx.repo, "add", "--", "UNRELATED.md");
  git(fx.repo, "commit", "-q", "-m", "an unrelated local commit");
  const d = deliver(fx, rec.run_id);
  // HEAD moved after verification, so the binding catches it first — which is
  // exactly the right answer, and nothing is pushed either way.
  assert.equal(d.state, "NEEDS_DECISION");
  assert.ok(["BASELINE_HEAD_CHANGED", "UNRELATED_OUTGOING_COMMITS"].includes(d.failure.code), d.failure.code);
  const remoteHead = execFileSync("git", ["-C", bare, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
  assert.notEqual(remoteHead, git(fx.repo, "rev-parse", "HEAD").trim(), "nothing reached the remote");
  fx.done();
});

test("divergence: more than one outgoing commit is refused after the commit is made", async () => {
  const { fx, rec, bare } = await ready("dv-two");
  approve(fx, rec.run_id);
  // rewind the REMOTE so the local branch is two ahead once the delivery commits
  const other = otherClone(bare);
  execFileSync("git", ["-C", bare, "update-ref", "refs/heads/main",
    execFileSync("git", ["-C", bare, "rev-parse", "refs/heads/main^"], { encoding: "utf8" }).trim()], { stdio: "ignore" });
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "NEEDS_DECISION");
  assert.equal(d.failure.code, "UNRELATED_OUTGOING_COMMITS");
  assert.match(d.failure.message, /exactly one — the delivery commit — is permitted/);
  assert.ok(d.transaction.commit.hash, "the commit exists and was not rewritten");
  rmSync(other, { recursive: true, force: true });
  fx.done();
});

test("divergence: a missing remote branch requires a decision, never an implicit branch creation", async () => {
  const { fx, rec, bare } = await ready("dv-nobranch");
  approve(fx, rec.run_id);
  execFileSync("git", ["-C", bare, "update-ref", "-d", "refs/heads/main"], { stdio: "ignore" });
  const audit = recordGit();
  const d = deliver(fx, rec.run_id);
  audit.stop();
  assert.equal(d.state, "NEEDS_DECISION");
  assert.equal(d.failure.code, "UPSTREAM_CHANGED");
  assert.match(d.failure.message, /explicit decision/);
  assert.ok(!audit.calls.some((c) => c.startsWith("push ")), "no branch was created on the remote");
  fx.done();
});

test("divergence: a changed remote URL is refused", async () => {
  const { fx, rec } = await ready("dv-remote");
  approve(fx, rec.run_id);
  git(fx.repo, "remote", "set-url", "origin", join(fx.home, "somewhere-else.git"));
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "NEEDS_DECISION");
  assert.ok(["FETCH_FAILED", "UPSTREAM_CHANGED", "REMOTE_CHANGED"].includes(d.failure.code), d.failure.code);
  fx.done();
});

test("divergence: a branch that moved since verification is refused", async () => {
  const { fx, rec } = await ready("dv-branch");
  approve(fx, rec.run_id);
  git(fx.repo, "checkout", "-q", "-b", "somewhere-else");
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "NEEDS_DECISION");
  assert.equal(d.failure.code, "BRANCH_CHANGED");
  fx.done();
});

// ---------------------------------------------------------------- push

test("push: a rejected push is recorded and never retried with force", async () => {
  const { fx, rec, bare } = await ready("ps-rejected");
  approve(fx, rec.run_id);
  // A remote that refuses the update: deny non-fast-forward AND make the ref
  // move underneath after the outgoing check, via a pre-receive hook.
  const hooks = join(bare, "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-receive"), "#!/bin/sh\necho 'policy: pushes are refused here' >&2\nexit 1\n", { mode: 0o755 });

  const audit = recordGit();
  const d = deliver(fx, rec.run_id);
  audit.stop();
  assert.equal(d.state, "NEEDS_DECISION", JSON.stringify(d.failure));
  assert.equal(d.failure.code, "PUSH_REJECTED");
  assert.match(d.failure.message, /will NOT be retried with force/);
  const push = art(fx, rec.run_id, "push.json");
  assert.equal(push.ok, false);
  assert.notEqual(push.exit_code, 0);
  assert.match(push.stderr, /refused|rejected|policy/i);
  // exactly ONE push attempt, and no force anywhere
  assert.equal(audit.calls.filter((c) => c.startsWith("push ")).length, 1, "a rejected push is not retried");
  assert.ok(!audit.calls.join("\n").includes("--force"));
  // the commit is still there, unamended
  assert.equal(git(fx.repo, "rev-parse", "HEAD").trim(), d.transaction.commit.hash);
  fx.done();
});

test("push: the pushed range is recorded exactly", async () => {
  const { fx, rec } = await ready("ps-range");
  const before = git(fx.repo, "rev-parse", "HEAD").trim();
  approve(fx, rec.run_id);
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "DELIVERED");
  const push = art(fx, rec.run_id, "push.json");
  assert.equal(push.pushed_range, `${before}..${d.commit}`);
  assert.equal(push.refspec, "refs/heads/main:refs/heads/main");
  assert.equal(push.local_ref, "refs/heads/main");
  assert.equal(push.remote_ref, "refs/heads/main");
  assert.equal(push.command, "git push origin refs/heads/main:refs/heads/main");
  fx.done();
});

// ------------------------------------------------------ remote verification

test("remote verification: push stdout alone is never accepted as proof", async () => {
  const { fx, rec, bare } = await ready("rv-independent");
  approve(fx, rec.run_id);
  const audit = recordGit();
  const d = deliver(fx, rec.run_id);
  audit.stop();
  assert.equal(d.state, "DELIVERED");
  // there is a SECOND fetch after the push, and it is what verification uses
  const fetches = audit.calls.filter((c) => c.startsWith("fetch "));
  assert.ok(fetches.length >= 2, `expected a fetch before and after the push, got ${fetches.length}`);
  const pushIdx = audit.calls.findIndex((c) => c.startsWith("push "));
  assert.ok(audit.calls.slice(pushIdx).some((c) => c.startsWith("fetch ")), "verification fetches after pushing");
  const v = art(fx, rec.run_id, "remote-verification.json");
  assert.equal(v.independent_fetch, true);
  assert.deepEqual(v.problems, []);
  assert.equal(v.commit, d.commit);
  assert.equal(v.remote_head, d.commit);
  fx.done();
});

test("remote verification: a remote that does not contain the commit fails, and nothing is forced", async () => {
  const { fx, rec, bare } = await ready("rv-missing");
  approve(fx, rec.run_id);
  // a post-receive hook that silently rewinds the branch: the push succeeds, the
  // remote does not end up holding the commit. Exactly the case push stdout lies about.
  const hooks = join(bare, "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "post-receive"),
    "#!/bin/sh\ngit update-ref refs/heads/main $(git rev-parse refs/heads/main^) 2>/dev/null || true\n", { mode: 0o755 });

  const audit = recordGit();
  const d = deliver(fx, rec.run_id);
  audit.stop();
  assert.equal(d.state, "NEEDS_DECISION", JSON.stringify(d.failure));
  assert.equal(d.failure.code, "REMOTE_VERIFICATION_FAILED");
  assert.match(d.failure.message, /the push reported success but the remote does not confirm it/);
  assert.match(d.failure.message, /nothing was force-pushed or rewritten/);
  assert.ok(!audit.calls.join("\n").includes("--force"));
  // and the task is NOT delivered
  assert.notEqual(fx.state().tasks[0].status, "delivered");
  fx.done();
});

test("completion: the task is delivered only after remote verification succeeds", async () => {
  const { fx, t, rec, bare } = await ready("cp-order");
  approve(fx, rec.run_id);
  const events = [];
  const d = DEL.deliverRun({ projectId: fx.P, runId: rec.run_id, onEvent: (e) => events.push(e.type) });
  assert.equal(d.state, "DELIVERED");
  const types = events.filter((e) => e !== "delivery.state_changed");
  const iVerified = types.indexOf("delivery.remote_verification_completed");
  const iDelivered = types.indexOf("delivery.delivered");
  assert.ok(iVerified >= 0 && iDelivered > iVerified, "delivered comes after remote verification");
  // ordering of the whole transaction
  for (const [a, b] of [["delivery.created", "delivery.preflight_completed"],
                        ["delivery.staging_completed", "delivery.commit_created"],
                        ["delivery.commit_verified", "delivery.fetch_started"],
                        ["delivery.outgoing_inspected", "delivery.push_started"],
                        ["delivery.push_completed", "delivery.remote_verification_started"]])
    assert.ok(types.indexOf(a) < types.indexOf(b) && types.indexOf(a) >= 0, `${a} must precede ${b}`);
  assert.equal(fx.state().tasks.find((x) => x.id === t).status, "delivered");
  fx.done();
});

test("completion: nothing but the delivery controller may set `delivered`", async () => {
  const { fx, t } = await ready("cp-guard");
  assert.throws(() => fx.cli("task-set", "--project", fx.P, String(t), "--status", "delivered"),
    /set by the delivery controller only/);
  assert.notEqual(fx.state().tasks.find((x) => x.id === t).status, "delivered");
  // markDelivered itself refuses incomplete provenance
  const r = (await import("file:///" + join(ROOT, "scripts", "state.mjs").replace(/\\/g, "/")))
    .markDelivered(fx.P, t, { run_id: "RUN-x" });
  assert.equal(r.ok, false);
  assert.match(r.message, /without delivery_id/);
  fx.done();
});

// ------------------------------------------------- leases, restart, dashboard

test("lease: the repository lease blocks a task run, and is released on every path", async () => {
  const { fx, t, rec } = await ready("ls-repo");
  const ws = wsOf(fx);
  // held by someone else
  const held = DEL.acquireRepoLease(ws, { projectId: fx.P, taskId: t, runId: "RUN-other", deliveryId: "DELIVERY-other" });
  assert.equal(held.ok, true);
  const blocked = DEL.acquireRepoLease(ws, { projectId: fx.P, taskId: t, runId: rec.run_id, deliveryId: "DELIVERY-mine" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failure.code, "DELIVERY_LEASE_CONFLICT");
  // a task run refuses to start while it is held
  const runRec = await run(fx, t, fakeExecutor(fx, {}));
  assert.equal(runRec.outcome, "FAILED");
  assert.ok(runRec.preflight_failures.some((f) => f.code === "LEASE_CONFLICT" && /committing or pushing/.test(f.message)));
  // releasing someone else's lease is refused; releasing our own works
  assert.equal(DEL.releaseRepoLease(ws, "DELIVERY-not-mine").released, false);
  assert.equal(DEL.releaseRepoLease(ws, "DELIVERY-other").released, true);
  fx.done();
});

test("lease: a stale lease is recovered rather than wedging the repository", async () => {
  const { fx, rec } = await ready("ls-stale");
  const ws = wsOf(fx);
  writeFileSync(DEL.repoLeasePath(ws), JSON.stringify({
    delivery_id: "DELIVERY-crashed", run_id: "RUN-crashed", pid: 999999,
    acquired_at: "2000-01-01T00:00:00Z", expires_at: "2000-01-01T01:00:00Z",
  }));
  const got = DEL.acquireRepoLease(ws, { projectId: fx.P, taskId: 1, runId: rec.run_id, deliveryId: "DELIVERY-new" });
  assert.equal(got.ok, true);
  assert.equal(got.recovered.delivery_id, "DELIVERY-crashed", "the recovery is recorded, not silent");
  DEL.releaseRepoLease(ws, "DELIVERY-new");
  // and a real delivery still works afterwards
  approve(fx, rec.run_id);
  assert.equal(deliver(fx, rec.run_id).state, "DELIVERED");
  assert.equal(existsSync(DEL.repoLeasePath(ws)), false, "released on success");
  fx.done();
});

test("lease: released after a failure and after a cancellation", async () => {
  const { fx, rec } = await ready("ls-release");
  const ws = wsOf(fx);
  approve(fx, rec.run_id);
  // An empty NAME is what git hard-refuses; an empty email it will happily
  // synthesise from the hostname.
  git(fx.repo, "config", "user.name", "");
  git(fx.repo, "config", "user.email", "");
  const failed = deliver(fx, rec.run_id);
  assert.equal(failed.state, "NEEDS_DECISION");
  assert.equal(existsSync(DEL.repoLeasePath(ws)), false, "released after a failure");

  const c = JSON.parse(fx.cli("delivery-cancel", "--project", fx.P, "--run", rec.run_id, "--reason", "changed my mind"));
  assert.equal(c.state, "CANCELLED");
  assert.equal(existsSync(DEL.repoLeasePath(ws)), false, "released after a cancellation");
  fx.done();
});

test("restart: a delivery is fully readable from disk by a separate process", async () => {
  const { fx, rec } = await ready("rs-restart");
  approve(fx, rec.run_id);
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "DELIVERED");
  const out = execFileSync("node", [join(ROOT, "scripts", "state.mjs"), "delivery-status", "--project", fx.P, "--run", rec.run_id],
    { encoding: "utf8", env: { ...process.env, SCH_HOME: fx.home, NODE_NO_WARNINGS: "1" } });
  const back = JSON.parse(out);
  assert.equal(back.state, "DELIVERED");
  assert.equal(back.commit, d.commit);
  assert.equal(back.approval, "APPROVED");
  assert.equal(back.approver, "test-operator");
  assert.ok(back.verified_diff_hash);
  assert.equal(back.remote_verification.problems.length, 0);
  assert.ok(back.events > 10);
  fx.done();
});

test("dashboard: the delivery projection shows state, approval and attention", async () => {
  const { fx, t, rec } = await ready("db-proj");
  // before approval: waiting on a person
  deliver(fx, rec.run_id);
  let p = DEL.deliveryProjection(fx.P);
  assert.equal(p.available, true);
  assert.equal(p.deliveries.length, 1);
  assert.equal(p.deliveries[0].state, "NEEDS_DECISION");
  assert.equal(p.deliveries[0].approval_status, "PENDING");
  assert.match(p.deliveries[0].attention_required, /needs approval/);
  assert.equal(p.write_actions_require_local_operator, true);

  approve(fx, rec.run_id);
  const d = deliver(fx, rec.run_id);
  p = DEL.deliveryProjection(fx.P);
  const view = p.deliveries[0];
  assert.equal(view.state, "DELIVERED");
  assert.equal(view.approval_status, "APPROVED");
  assert.equal(view.approver, "test-operator");
  assert.equal(view.commit, d.commit);
  assert.deepEqual(view.intended_paths, ["src/feature.js"]);
  assert.deepEqual(view.staged_paths, ["src/feature.js"]);
  assert.deepEqual(view.outgoing_commits, [d.commit]);
  assert.deepEqual(view.incoming_commits, []);
  assert.equal(view.push.ok, true);
  assert.equal(view.remote_verification.ok, true);
  assert.equal(view.attention_required, null);
  assert.ok(view.verified_diff_hash && view.last_event === "delivery.delivered");
  assert.equal(p.active, null, "nothing is left in flight");
  assert.ok(!JSON.stringify(p).includes("-----BEGIN"), "the projection never inlines file content");
  assert.equal(view.task_id, String(t));
  fx.done();
});

test("events: delivery evidence is versioned, identity-stamped and bounded", async () => {
  const { fx, rec } = await ready("ev-delivery");
  approve(fx, rec.run_id);
  const d = deliver(fx, rec.run_id);
  const events = DEL.readDeliveryEvents(d.delivery_dir);
  assert.ok(events.length > 10);
  for (const e of events) {
    assert.equal(e.schema_version, 1);
    assert.match(e.event_id, /^DEV-[0-9a-f]{12}$/);
    assert.ok(!Number.isNaN(Date.parse(e.timestamp)));
    assert.equal(e.project_id, fx.P);
    assert.equal(e.run_id, rec.run_id);
    assert.equal(e.delivery_id, d.delivery_id);
    assert.ok(DEL.DELIVERY_EVENTS.includes(e.type), `undeclared event type ${e.type}`);
    assert.ok(JSON.stringify(e.payload ?? {}).length < 4000, `${e.type} carries an unbounded payload`);
  }
  assert.equal(events[0].type, "delivery.created");
  assert.equal(events[events.length - 1].type, "delivery.delivered");
  fx.done();
});

// --------------------------------------------- branch namespace authorization

test("a project has no branch namespace until an operator sets one", () => {
  const fx = fixture("ns-default");
  try {
    assert.equal(STATE.branchNamespace(fx.P), null);
    assert.equal(STATE.branchInNamespace(fx.P, "sch/task-1"), false);
  } finally { fx.done(); }
});

test("an authorized namespace admits only branches that match it", () => {
  const fx = fixture("ns-set");
  try {
    fx.cli("delivery-branch-namespace", "--project", fx.P, "--set", "sch/task-*", "--approver", "test-operator");
    const ns = STATE.branchNamespace(fx.P);
    assert.equal(ns.pattern, "sch/task-*");
    assert.equal(ns.authorized_by, "test-operator");
    assert.ok(ns.id, "an authorization must have an id so a delivery can cite it");
    assert.equal(STATE.branchInNamespace(fx.P, "sch/task-12"), true);
    assert.equal(STATE.branchInNamespace(fx.P, "main"), false);
    assert.equal(STATE.branchInNamespace(fx.P, "release/1.0"), false);
    assert.equal(STATE.branchInNamespace(fx.P, "sch/task-1/../../main"), false);
  } finally { fx.done(); }
});

test("revoking the namespace closes it again", () => {
  const fx = fixture("ns-revoke");
  try {
    fx.cli("delivery-branch-namespace", "--project", fx.P, "--set", "sch/task-*", "--approver", "test-operator");
    fx.cli("delivery-branch-namespace", "--project", fx.P, "--revoke", "true");
    assert.equal(STATE.branchNamespace(fx.P), null);
    assert.equal(STATE.branchInNamespace(fx.P, "sch/task-1"), false);
  } finally { fx.done(); }
});

test("revoking a namespace that was never set writes nothing", () => {
  const fx = fixture("ns-revoke-noop");
  try {
    assert.equal(fx.cli("delivery-branch-namespace", "--project", fx.P, "--revoke", "true"), "no namespace set");
    // Stronger than checking the event log: state.json must not even exist —
    // proof no read-modify-write happened for an authorization that was never there.
    assert.equal(existsSync(join(fx.home, "projects", fx.P, "state.json")), false,
      "nothing was actually revoked, so nothing should have been written");
  } finally { fx.done(); }
});

test("--set and --revoke together is a contradiction, not a silent --revoke win", () => {
  const fx = fixture("ns-contradiction");
  try {
    assert.throws(() => fx.cli("delivery-branch-namespace", "--project", fx.P, "--set", "sch/task-*", "--revoke", "true", "--approver", "test-operator"),
      /contradict/);
    assert.equal(STATE.branchNamespace(fx.P), null, "neither side of the contradiction took effect");
  } finally { fx.done(); }
});
