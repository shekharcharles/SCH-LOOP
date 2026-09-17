// Ship is the last gate, so every test here is an attempt to get something out that should not leave.
// The pull request itself is stubbed: what is under test is which gate stops the release and whether the
// release record tells the truth about it afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ship, scanSecrets, readVerify, readQueue, SECRET_PATTERNS } from "./ship.mjs";

const TASK = `# task.md

## Phase 1 — Todo core   (2/2 done)
- [x] T1.1-add-priority  build  Add priority  deps:-  size:S
- [x] T1.2-cover-remove  test  Cover remove  deps:T1.1  size:S
`;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

// A real repository, because every gate here is a real git command. Two commits on `main`, then a branch.
function repo({ task = TASK, status = "passed", extra = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-ship-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "lab@example.invalid");
  git(root, "config", "user.name", "lab");
  fs.mkdirSync(path.join(root, ".sch-loop", "verify"), { recursive: true });
  fs.writeFileSync(path.join(root, "task.md"), task);
  fs.writeFileSync(path.join(root, ".sch-loop", "verify", "phase-1.md"), `# Phase 1 verification\n\n**Status:** ${status}\n`);
  fs.writeFileSync(path.join(root, "README.md"), "# lab\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "sch/phase-1");
  fs.writeFileSync(path.join(root, "src.mjs"), extra ?? "export const gate = () => true;\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "work");
  return root;
}
const shipIt = (root, over = {}) => ship({ projectRoot: root, phase: "1", base: "main", runGh: async () => "https://github.invalid/x/y/pull/1", ...over });
const gate = (r, name) => r.results.find(x => x.name === name);

test("every gate green opens the pull request and records its URL and rollback", async () => {
  const root = repo();
  const r = await shipIt(root);
  assert.equal(r.decision, "GO");
  assert.equal(r.prUrl, "https://github.invalid/x/y/pull/1");
  const md = fs.readFileSync(r.file, "utf8");
  assert.match(md, /\*\*Pull request:\*\* https:\/\/github\.invalid/);
  assert.match(md, /gh pr close/);
  assert.match(md, /push origin --delete sch\/phase-1/);
});

test("a dry run passes every gate and still pushes nothing", async () => {
  const root = repo();
  let called = 0;
  const r = await shipIt(root, { dryRun: true, runGh: async () => { called++; return "nope"; } });
  assert.equal(called, 0);
  assert.match(r.decision, /^GO \(dry run/);
  assert.equal(r.prUrl, null);
  assert.match(fs.readFileSync(r.file, "utf8"), /\*\*Pull request:\*\* \(not opened\)/);
});

test("a phase whose verification is not passed does not ship", async () => {
  for (const status of ["gaps_found", "human_needed"]) {
    const r = await shipIt(repo({ status }));
    assert.equal(r.decision, "NO-GO");
    assert.match(gate(r, "phase verification").why, new RegExp(status));
  }
});

test("a missing verification file does not ship — absence is not approval", async () => {
  const root = repo();
  fs.rmSync(path.join(root, ".sch-loop", "verify", "phase-1.md"));
  const r = await shipIt(root);
  assert.equal(r.decision, "NO-GO");
  assert.match(gate(r, "phase verification").why, /run verify first/);
});

test("an open ticket in the phase does not ship", async () => {
  const r = await shipIt(repo({ task: TASK.replace("- [x] T1.2", "- [ ] T1.2") }));
  assert.equal(r.decision, "NO-GO");
  assert.match(gate(r, "queue").why, /T1\.2/);
});

test("uncommitted work does not ship, and the untracked file counts", async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, "forgotten.mjs"), "// never committed\n");
  const r = await shipIt(root);
  assert.equal(r.decision, "NO-GO");
  assert.match(gate(r, "working tree is clean").why, /forgotten\.mjs/);
});

test("a secret in the diff does not ship", async () => {
  const r = await shipIt(repo({ extra: 'const key = "AKIAIOSFODNN7EXAMPLE";\n' }));
  assert.equal(r.decision, "NO-GO");
  assert.match(gate(r, "no secrets in the diff").why, /AWS access key id/);
});

test("a failing release check does not ship, and its output is in the record", async () => {
  const root = repo();
  const r = await shipIt(root, { checks: [{ name: "suite", command: process.execPath, args: ["-e", "console.error('2 failing'); process.exit(1)"] }] });
  assert.equal(r.decision, "NO-GO");
  assert.match(gate(r, "suite").why, /2 failing/);
  assert.match(fs.readFileSync(r.file, "utf8"), /\| suite \| NO-GO \|/);
});

test("shipping from the base branch itself is refused", async () => {
  const root = repo();
  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--no-ff", "-m", "merge", "sch/phase-1");
  const r = await shipIt(root);
  assert.equal(r.decision, "NO-GO");
  assert.match(gate(r, "branch").why, /ship from a branch/);
});

test("a branch with nothing on it does not ship", async () => {
  const root = repo();
  git(root, "checkout", "-qb", "sch/empty", "main");
  const r = await shipIt(root);
  assert.equal(r.decision, "NO-GO");
  assert.match(gate(r, "there is something to ship").why, /no changes against main/);
});

test("a pull request that fails to open is NO-GO, not a silent success", async () => {
  const root = repo();
  const r = await shipIt(root, { runGh: async () => { throw new Error("gh: not authenticated"); } });
  assert.equal(r.decision, "NO-GO");
  assert.equal(r.prUrl, null);
  assert.match(gate(r, "pull request").why, /not authenticated/);
});

test("the first NO-GO stops the release instead of running every remaining gate", async () => {
  const root = repo({ status: "gaps_found" });
  let ran = 0;
  const r = await shipIt(root, { checks: [{ name: "expensive", command: process.execPath, args: ["-e", "process.exit(0)"] }] });
  assert.equal(r.decision, "NO-GO");
  assert.equal(gate(r, "expensive"), undefined, "the expensive check was never reached");
  assert.equal(ran, 0);
});

test("the secret scan reads added lines only, and knows the patterns it claims to", () => {
  assert.deepEqual(scanSecrets('-const key = "AKIAIOSFODNN7EXAMPLE";'), [], "a REMOVED secret is not a new leak");
  assert.deepEqual(scanSecrets("+++ b/AKIAIOSFODNN7EXAMPLE"), [], "a diff header is not a line of code");
  assert.equal(scanSecrets('+const key = "AKIAIOSFODNN7EXAMPLE";').length, 1);
  assert.equal(scanSecrets("+-----BEGIN RSA PRIVATE KEY-----").length, 1);
  assert.equal(scanSecrets('+password: "hunter2hunter2hunter2"').length, 1);
  assert.equal(scanSecrets("+const total = count + 1;").length, 0, "ordinary code is not a secret");
  assert.equal(SECRET_PATTERNS.length, 5);
});

test("the queue and verify readers report why, not just false", () => {
  const root = repo({ task: "# task.md\n\n## Phase 9 — Empty   (0/0 done)\n" });
  assert.match(readQueue(root, "1").why, /no tickets in phase 1/);
  assert.equal(readVerify(root, "1").ok, true);
  fs.writeFileSync(path.join(root, ".sch-loop", "verify", "phase-1.md"), "# no status line here\n");
  assert.match(readVerify(root, "1").why, /no Status line/);
});
