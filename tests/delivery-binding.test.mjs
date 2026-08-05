// Delivery ELIGIBILITY and the verified-diff BINDING.
//
// A run saying VERIFIED is a claim about a moment. Everything here exists to
// make sure the thing about to be pushed is the thing that was verified — and
// that a human's approval of one diff can never authorize a different one.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, fakeExecutor, run, git, verifiedRun, withRemote,
         approve, deliver, CAND, DEL, WS } from "./helpers.mjs";

const CHANGE = { write: [{ path: "src/feature.js", content: "export const feature = 1;\n" }] };

// A fixture that is one approval away from a real push to a local bare remote.
async function ready(name, behaviour = CHANGE, taskOpts = {}) {
  const fx = fixture(name);
  initWorkspace(fx);
  withRemote(fx);
  const t = addTask(fx, taskOpts);
  const rec = await verifiedRun(fx, t, behaviour);
  return { fx, t, rec };
}

// ------------------------------------------------------------- eligibility

test("binding: a run that is not VERIFIED is never deliverable", async () => {
  const fx = fixture("bd-notverified"); initWorkspace(fx); withRemote(fx);
  const t = addTask(fx);
  const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "wandered.txt", content: "x\n" }] }));
  assert.equal(rec.outcome, "FAILED");
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "FAILED");
  assert.equal(d.failure.code, "RUN_NOT_VERIFIED");
  assert.match(d.failure.message, /not VERIFIED/);
  fx.done();
});

test("binding: a VERIFIED run without a recorded candidate is not deliverable", async () => {
  const { fx, rec } = await ready("bd-nocandidate");
  rmSync(join(rec.run_dir, "delivery-candidate.json"), { force: true });
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "FAILED");
  assert.equal(d.failure.code, "RUN_NOT_DELIVERY_ELIGIBLE");
  assert.match(d.failure.message, /no delivery candidate/);
  fx.done();
});

test("binding: an unknown run is refused", () => {
  const fx = fixture("bd-norun"); initWorkspace(fx);
  const d = deliver(fx, "RUN-20200101T000000Z-deadbeef");
  assert.equal(d.state, "FAILED");
  assert.equal(d.failure.code, "RUN_NOT_DELIVERY_ELIGIBLE");
  fx.done();
});

test("binding: an already delivered run is never delivered twice", async () => {
  const { fx, rec } = await ready("bd-twice");
  approve(fx, rec.run_id);
  const first = deliver(fx, rec.run_id);
  assert.equal(first.state, "DELIVERED", JSON.stringify(first.failure));
  const second = deliver(fx, rec.run_id);
  assert.equal(second.failure.code, "DELIVERY_ALREADY_COMPLETED");
  assert.match(second.failure.message, /never re-delivered/);
  fx.done();
});

// ------------------------------------------------------ the hash is stable

test("binding: the candidate hash is stable across reload and recomputation", async () => {
  const { fx, t, rec } = await ready("bd-stable");
  const stored = JSON.parse(readFileSync(join(rec.run_dir, "delivery-candidate.json"), "utf8"));
  const again = CAND.computeCandidate({
    repoRoot: WS.real(fx.repo), projectId: fx.P, taskId: t, runId: rec.run_id,
    baseline: JSON.parse(readFileSync(join(rec.run_dir, "baseline.json"), "utf8")),
    verification: JSON.parse(readFileSync(join(rec.run_dir, "verification.json"), "utf8")),
  });
  assert.equal(again.ok, true);
  assert.equal(again.candidate.verified_diff_hash, stored.verified_diff_hash);
  assert.equal(again.candidate.verified_effects_hash, stored.verified_effects_hash);
  assert.equal(again.candidate.verification_evidence_hash, stored.verification_evidence_hash);
  // and canonical serialization does not depend on key order
  assert.equal(CAND.canonicalHash({ a: 1, b: [2, 3] }), CAND.canonicalHash({ b: [2, 3], a: 1 }));
  assert.notEqual(CAND.canonicalHash({ a: 1 }), CAND.canonicalHash({ a: 2 }));
  fx.done();
});

// Every way the working tree can stop being what was verified.
for (const [name, mutate] of [
  ["the content of a changed file", (fx) => writeFileSync(join(fx.repo, "src", "feature.js"), "export const feature = 999; // edited after verification\n")],
  ["an added file", (fx) => writeFileSync(join(fx.repo, "src", "extra.js"), "snuck in\n")],
  ["a deleted candidate file", (fx) => rmSync(join(fx.repo, "src", "feature.js"), { force: true })],
  ["a renamed candidate file", (fx) => renameSync(join(fx.repo, "src", "feature.js"), join(fx.repo, "src", "renamed.js"))],
  ["a deleted tracked file", (fx) => rmSync(join(fx.repo, "README.md"), { force: true })],
]) {
  test(`binding: ${name} invalidates delivery`, async () => {
    const { fx, rec } = await ready("bd-drift");
    approve(fx, rec.run_id);          // approved for the ORIGINAL diff
    mutate(fx);
    const d = deliver(fx, rec.run_id);
    assert.equal(d.state, "NEEDS_DECISION", JSON.stringify(d.failure));
    assert.equal(d.failure.code, "VERIFIED_DIFF_CHANGED");
    assert.match(d.failure.message, /Re-run verification|re-run verification/);
    // fail-closed: nothing was staged and nothing was committed
    assert.equal(git(fx.repo, "diff", "--cached", "--name-only").trim(), "");
    assert.equal(git(fx.repo, "rev-list", "--count", "origin/main..HEAD").trim(), "0");
    fx.done();
  });
}

test("binding: a moved baseline HEAD invalidates delivery", async () => {
  const { fx, rec } = await ready("bd-head");
  approve(fx, rec.run_id);
  // someone commits something else underneath
  writeFileSync(join(fx.repo, "OTHER.md"), "unrelated\n");
  git(fx.repo, "add", "--", "OTHER.md");
  git(fx.repo, "commit", "-q", "-m", "unrelated work");
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "NEEDS_DECISION");
  assert.equal(d.failure.code, "BASELINE_HEAD_CHANGED");
  assert.equal(git(fx.repo, "diff", "--cached", "--name-only").trim(), "", "nothing staged");
  fx.done();
});

test("binding: changed verification evidence invalidates delivery", async () => {
  const { fx, rec } = await ready("bd-evidence");
  const v = JSON.parse(readFileSync(join(rec.run_dir, "verification.json"), "utf8"));
  v.results[0].exit_code = 1; v.results[0].result = "FAILED";
  writeFileSync(join(rec.run_dir, "verification.json"), JSON.stringify(v, null, 2));
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "NEEDS_DECISION");
  assert.equal(d.failure.code, "VERIFIED_DIFF_CHANGED");
  assert.match(d.failure.message, /verification evidence/);
  fx.done();
});

test("binding: a mode change is part of the identity", () => {
  // Filesystem mode bits are not observable on every platform, so the mechanism
  // is proven where it lives: two candidates differing ONLY in mode must not
  // hash the same. Anything else would let an executable bit ride along unseen.
  const entry = (mode) => [{ path: "s.sh", status: "M", from: null, mode_head: "100644", mode_worktree: mode, blob: "abc", unmerged: false }];
  const effects = (mode) => entry(mode).map((e) => ({ path: e.path, status: e.status, from: e.from, mode_head: e.mode_head, mode_worktree: e.mode_worktree, unmerged: e.unmerged }));
  assert.notEqual(CAND.canonicalHash(effects("100644")), CAND.canonicalHash(effects("100755")),
    "a file becoming executable must change the effects hash");
  const drift = CAND.compareCandidates(
    { head: "h", baseline_head: "b", branch: "main", verified_diff_hash: "d", verified_effects_hash: CAND.canonicalHash(effects("100644")), verification_evidence_hash: "e", changed_paths: ["s.sh"] },
    { head: "h", baseline_head: "b", branch: "main", verified_diff_hash: "d", verified_effects_hash: CAND.canonicalHash(effects("100755")), verification_evidence_hash: "e", changed_paths: ["s.sh"] });
  assert.equal(drift.length, 1);
  assert.equal(drift[0].code, "VERIFIED_DIFF_CHANGED");
  assert.match(drift[0].message, /modes or rename structure/);
});

// ---------------------------------------------------------------- approval

test("approval: delivery refuses to commit without one, and says exactly how to give it", async () => {
  const { fx, rec } = await ready("ap-required");
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "NEEDS_DECISION");
  assert.equal(d.failure.code, "APPROVAL_REQUIRED");
  assert.match(d.failure.message, /delivery-approve --project/);
  assert.equal(d.transaction.state, "NEEDS_DECISION");
  assert.equal(git(fx.repo, "diff", "--cached", "--name-only").trim(), "", "nothing staged before approval");
  assert.equal(git(fx.repo, "rev-list", "--count", "HEAD").trim(), "2", "nothing committed before approval");
  fx.done();
});

test("approval: an approval given for one diff does NOT authorize another", async () => {
  const { fx, rec } = await ready("ap-invalid");
  const a = approve(fx, rec.run_id);
  assert.equal(a.ok, true);
  const dp = WS.deliveryDir(join(fx.repo, ".sch-loop"), rec.run_id);
  assert.equal(DEL.approvalStatus(DEL.readTransaction(dp)), "APPROVED");

  // the diff moves; the signature stops matching
  writeFileSync(join(fx.repo, "src", "feature.js"), "export const feature = 2; // different\n");
  const d = deliver(fx, rec.run_id);
  assert.equal(d.failure.code, "VERIFIED_DIFF_CHANGED", "the diff check fires before the approval is even consulted");

  // and once the transaction records the new hash, the old approval is invalid
  const tx = DEL.readTransaction(dp);
  const moved = { ...tx, verified_diff_hash: "a-different-hash" };
  assert.equal(DEL.approvalStatus(moved), "INVALIDATED");
  fx.done();
});

test("approval: expiry, rejection and message binding", async () => {
  const { fx, rec } = await ready("ap-states");
  const dp = WS.deliveryDir(join(fx.repo, ".sch-loop"), rec.run_id);

  // an approval that has run out of time is not an approval
  approve(fx, rec.run_id, { ttlMs: 1000 });
  const tx = DEL.readTransaction(dp);
  assert.equal(DEL.approvalStatus(tx, Date.now() + 60_000), "EXPIRED");
  assert.equal(DEL.approvalStatus(tx), "APPROVED");

  // changing the message changes what was approved
  const withMessage = { ...tx, commit_message: "feat(other): something else entirely" };
  assert.equal(DEL.approvalStatus(withMessage), "INVALIDATED");

  // a rejection is terminal for this delivery
  const rej = approve(fx, rec.run_id, { decision: "REJECTED", why: "not now" });
  assert.equal(rej.ok, true);
  const d = deliver(fx, rec.run_id);
  assert.equal(d.failure.code, "APPROVAL_REJECTED");
  assert.match(d.failure.message, /not now/);
  fx.done();
});

test("approval: an unsigned approval is refused", async () => {
  const { fx, rec } = await ready("ap-unsigned");
  deliver(fx, rec.run_id);                       // creates the transaction to sign
  const r = DEL.approveDelivery(fx.P, rec.run_id, { approver: "" });
  assert.equal(r.ok, false);
  assert.match(r.failure.message, /an approval nobody signed/);
  // and there is nothing to sign before a delivery has described its intent
  const none = DEL.approveDelivery(fx.P, "RUN-20200101T000000Z-deadbeef", { approver: "x" });
  assert.equal(none.ok, false);
  assert.match(none.failure.message, /no delivery transaction/);
  fx.done();
});

test("approval: the CLI binds an explicit commit message to the signature", async () => {
  const { fx, rec } = await ready("ap-cli");
  deliver(fx, rec.run_id);                       // stops at APPROVAL_REQUIRED, writing down its intent
  const out = JSON.parse(fx.cli("delivery-approve", "--project", fx.P, "--run", rec.run_id,
    "--approver", "charles", "--message", "fix(api): tighten the upload quota check", "--why", "reviewed the diff"));
  assert.equal(out.approval.decision, "APPROVED");
  assert.equal(out.approval.approver, "charles");
  assert.equal(out.commit_message, "fix(api): tighten the upload quota check");
  assert.equal(out.approval.subject.commit_message, "fix(api): tighten the upload quota check");
  const status = JSON.parse(fx.cli("delivery-status", "--project", fx.P, "--run", rec.run_id));
  assert.equal(status.approval, "APPROVED");
  fx.done();
});

// ---------------------------------------------------------- commit message

test("commit message: built from trusted task data, not worker narrative", () => {
  assert.equal(DEL.proposeCommitMessage({ title: "Add a greet function", category: "backend" }),
    "feat(backend): Add a greet function");
  assert.equal(DEL.proposeCommitMessage({ title: "x", phaseName: "Auth & accounts" }), "feat(auth-accounts): x");
  assert.equal(DEL.proposeCommitMessage({ title: "x" }), "feat(task): x");
  const long = DEL.proposeCommitMessage({ title: "y".repeat(200), category: "ui" });
  assert.ok(long.length <= 72, `subject is ${long.length}`);
  assert.equal(DEL.proposeCommitMessage({ title: "ignored" }, { override: "chore: exactly this" }), "chore: exactly this");
});

test("commit message: validation refuses AI and session trailers", () => {
  assert.deepEqual(DEL.validateCommitMessage("feat(api): a normal subject"), []);
  assert.deepEqual(DEL.validateCommitMessage("feat(api): subject\n\na body paragraph"), []);
  const bad = (m, why) => assert.ok(DEL.validateCommitMessage(m).some((p) => why.test(p)), `${m} should be refused by ${why}`);
  bad("feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>", /co-author or session trailer/);
  bad("feat: x\n\nCo-authored-by: GPT-4", /co-author or session trailer/);
  bad("feat: x\n\n🤖 Generated with Claude Code", /co-author or session trailer/);
  bad("feat: x\n\nsession-id: abc123", /co-author or session trailer/);
  bad("feat: x\n\nclaude-session: abc", /co-author or session trailer/);
  bad("z".repeat(90), /the subject is 90 characters/);
  bad("# not a subject", /stripped by git as a comment/);
  bad("feat: x\nno blank line", /must be blank/);
  bad("feat: x\ty", /control characters/);
  bad("", /empty/);
  bad("feat: x\n\n--\n", /bare `--` line/);
});

// -------------------------------------------------- the git argv guardrails

test("guardrails: the forbidden git argv shapes are refused outright", () => {
  const no = (args, why) => assert.throws(() => CAND.assertSafeGitArgs(args), why, args.join(" "));
  no(["add", "-A"], /add -A/);
  no(["add", "--all"], /add -A/);
  no(["add", "-u"], /add -A/);
  no(["add", "."], /add \./);
  no(["add", "src/a.js"], /must separate its pathspecs with `--`/);
  no(["commit", "-a", "-m", "x"], /commit -a/);
  no(["commit", "--amend"], /commit -a/);
  no(["push", "origin", "main", "--force"], /force, mirror, prune and delete/);
  no(["push", "--force-with-lease", "origin", "main"], /force, mirror, prune and delete/);
  no(["push", "--mirror", "origin"], /force, mirror, prune and delete/);
  no(["push", "origin", "--delete", "main"], /force, mirror, prune and delete/);
  no(["push", "--all", "origin"], /all branches or tags/);
  no(["push", "--tags", "origin"], /all branches or tags/);
  no(["push", "origin", "refs/heads/*:refs/heads/*"], /wildcard refspec/);
  no(["push", "origin", ":refs/heads/main"], /wildcard refspec/);
  no(["reset", "--hard", "HEAD~1"], /reset --hard/);
  for (const cmd of ["rebase", "cherry-pick", "revert", "filter-branch", "merge", "clean", "stash"])
    no([cmd, "whatever"], /never run automatically/);
  no(["worktree", "move", "a", "b"], /add, remove, list or prune/);
  no(["worktree", "lock", "a"], /add, remove, list or prune/);
  no(["worktree"], /add, remove, list or prune/);
  // and the shapes the controller actually needs are allowed
  // A first push may name its upstream. That is the ONLY push flag permitted,
  // and it moves nothing — the force variants above are still refused.
  for (const args of [["add", "--", "src/a.js"], ["commit", "--file", "-"], ["push", "origin", "refs/heads/main:refs/heads/main"],
                      ["push", "--set-upstream", "origin", "refs/heads/sch/task-1:refs/heads/sch/task-1"],
                      ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
                      ["status", "--porcelain=v2", "-z"], ["rev-parse", "HEAD"], ["restore", "--staged", "--", "src/a.js"],
                      ["worktree", "add", "/tmp/x", "-b", "sch/task-1", "HEAD"], ["worktree", "remove", "--force", "/tmp/x"],
                      ["worktree", "list"], ["worktree", "prune"]])
    assert.equal(CAND.assertSafeGitArgs(args), true, args.join(" "));
});

test("guardrails: a credential-bearing remote URL is refused before any push", async () => {
  const { fx, rec } = await ready("gd-creds");
  approve(fx, rec.run_id);
  git(fx.repo, "remote", "set-url", "origin", "https://someone:s3cr3t@example.com/repo.git");
  const d = deliver(fx, rec.run_id);
  assert.equal(d.state, "NEEDS_DECISION");
  assert.equal(d.failure.code, "REMOTE_CHANGED");
  assert.match(d.failure.message, /credential/);
  assert.ok(!JSON.stringify(d.transaction).includes("s3cr3t"), "the credential is never persisted");
  assert.equal(CAND.redactRemote("https://u:p@h/x.git"), "https://[redacted]@h/x.git");
  assert.equal(CAND.hasCredentials("https://u:p@h/x.git"), true);
  assert.equal(CAND.hasCredentials("https://github.com/x/y.git"), false);
  fx.done();
});

// ------------------------------------------------------- the state machine

test("state machine: transitions are closed, forward-only and actor-checked", () => {
  assert.equal(DEL.canTransition("CREATED", "PREFLIGHT").ok, true);
  assert.equal(DEL.canTransition("CREATED", "PUSHING").ok, false, "no skipping to the push");
  assert.equal(DEL.canTransition("PUSHED", "STAGING").ok, false, "no going backwards");
  assert.equal(DEL.canTransition("DELIVERED", "PUSHING").ok, false, "a delivered transaction is finished");
  assert.equal(DEL.canTransition("FAILED", "PREFLIGHT").ok, false);
  assert.equal(DEL.canTransition("STAGED", "COMMITTING").ok, true);
  assert.equal(DEL.canTransition("REMOTE_VERIFYING", "DELIVERED").ok, true);
  assert.equal(DEL.canTransition("COMMITTED", "DELIVERED").ok, false, "delivery requires remote verification first");
  // any live state may fall to a terminal outcome — that is fail-closed
  for (const s of ["PREFLIGHT", "STAGING", "COMMITTING", "PUSHING", "REMOTE_VERIFYING"])
    for (const t of ["NEEDS_DECISION", "FAILED", "CANCELLED"])
      assert.equal(DEL.canTransition(s, t).ok, true, `${s} -> ${t}`);
  assert.equal(DEL.canTransition("CREATED", "NOT_A_STATE").ok, false);
  assert.equal(DEL.canTransition("CREATED", "PREFLIGHT", "the-model").ok, false, "only named actors may move a delivery");
  assert.deepEqual(DEL.ACTORS, ["controller", "approval", "cancel"]);
});
