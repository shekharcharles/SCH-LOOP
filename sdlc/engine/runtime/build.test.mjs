// End-to-end per-ticket pipeline against a real git repo, with model seats replaced by `call` stubs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildTicket, timeoutFor } from "./build.mjs";
import { writeTicket } from "./tickets.mjs";
import { commitBookkeeping } from "./worktrees.mjs";

const HOOKS = ["write-guard.mjs", "destructive-bash.mjs"];

function lab() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-build-"));
  const g = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", windowsHide: true });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "core.autocrlf", "false");
  const proj = path.join(root, "proj");
  for (const d of [["src"], [".claude", "hooks"], [".sch-loop", "tickets"], [".sch-loop", "reports"]]) fs.mkdirSync(path.join(proj, ...d), { recursive: true });
  fs.writeFileSync(path.join(proj, "src", "todo.mjs"), "export const n = 1;\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".worktrees/\n");
  for (const h of HOOKS) fs.writeFileSync(path.join(proj, ".claude", "hooks", h), "// stub\n");
  fs.writeFileSync(path.join(proj, ".claude", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [
      { matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command: "node .claude/hooks/write-guard.mjs" }] },
      { matcher: "Bash", hooks: [{ type: "command", command: "node .claude/hooks/destructive-bash.mjs" }] },
    ] },
  }, null, 2));
  fs.writeFileSync(path.join(proj, ".sch-loop", "config.md"), "max_executor_attempts: 2\nmax_review_rounds: 2\nprotected_paths:\n  - .env*\ntimeouts_minutes: { S: 1 }\n");
  fs.writeFileSync(path.join(proj, "task.md"), "# task.md\n\n## Phase 1 — Foundation   (0/0 done)\n");
  fs.writeFileSync(path.join(proj, "CLAUDE.md"), "# standards\n- no console.log\n");
  g("add", "-A"); g("commit", "-q", "-m", "init");
  return { root, proj };
}

// A builder seat that edits a file in its worktree and reports it honestly.
const builderSeat = (edits, { claim = null, extra = "" } = {}) => ({
  provider: "fake",
  call: async ({ cwd }) => {
    for (const [rel, body] of Object.entries(edits)) {
      fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), body);
    }
    const files = claim ?? Object.keys(edits);
    return { text: `${extra}FILES CHANGED:\n${files.join("\n")}\nSUMMARY: edited ${files.length} file(s).`, usage: { input_tokens: 5, cache_read_input_tokens: 50 }, cost: 0.02, sessionId: "s1", model: "fake-1" };
  },
});
const judgeSeat = verdict => ({ provider: "fake", call: async () => ({ text: JSON.stringify({ verdict, checks: [], failures: verdict === "PASS" ? [] : [{ id: "J-1", requirement: "r", reason: "not met", evidence: "-" }] }) }) });
const reviewerSeat = replies => { let i = 0; return { provider: "fake", call: async () => ({ text: replies[Math.min(i++, replies.length - 1)] }) }; };
const CLEAN_REVIEW = JSON.stringify({ spec_verdict: "PASS", spec_checks: [{ criterion: "c", status: "PASS", evidence: "e" }], findings: [] });


const READ_ONLY = ["claude", "--dangerously-skip-permissions", "--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit", "-p"];
const BYPASS = ["claude", "--dangerously-skip-permissions", "-p"];

function ticket(proj, over = {}) {
  return writeTicket(proj, {
    phase: "1", type: "build", title: "Add counter", size: "S",
    deps: [], allowed_paths: ["src/**"], action: "Add a counter.",
    acceptance: ["n is 2"], must_not: ["no test deleted"],
    verify: [{ name: "check", command: process.execPath, args: ["-e", "process.exit(0)"] }],
    ...over,
  });
}

test("timeoutFor reads config, falls back to M", () => {
  assert.equal(timeoutFor({ timeouts_minutes: { S: 1 } }, "S"), 60_000);
  assert.equal(timeoutFor({ timeouts_minutes: { M: 30 } }, "XL"), 30 * 60_000);
});

test("green path: builds in a worktree, reviews clean, merges, marks x, writes report", async () => {
  const { root, proj } = lab();
  const t = ticket(proj);
  const spec = {
    executor: { ...builderSeat({ "src/todo.mjs": "export const n = 2;\n" }), spawn: BYPASS },
    reviewer: { ...reviewerSeat([CLEAN_REVIEW]), spawn: READ_ONLY },
    judge: { ...judgeSeat("PASS"), spawn: READ_ONLY },
    council: [],
  };
  const r = await buildTicket({ projectRoot: proj, id: t.id, roles: spec });
  assert.equal(r.decision, "PASS", JSON.stringify(r.report?.what_did_not_work));
  assert.equal(fs.readFileSync(path.join(proj, "src", "todo.mjs"), "utf8"), "export const n = 2;\n");
  assert.match(fs.readFileSync(path.join(proj, "task.md"), "utf8"), new RegExp(`- \\[x\\] ${t.id}-`));
  const rep = JSON.parse(fs.readFileSync(path.join(proj, ".sch-loop", "reports", `${t.id}.json`), "utf8"));
  assert.equal(rep.status, "done");
  assert.equal(rep.context_tokens, 55);
  assert.deepEqual(rep.artifacts, ["src/todo.mjs"]);
  assert.match(fs.readFileSync(path.join(proj, ".sch-loop", "events.jsonl"), "utf8"), /ticket.done/);
  assert.ok(!fs.existsSync(path.join(root, ".worktrees", t.id)), "worktree removed after delivery");
});

test("scope violation blocks: a write outside allowed_paths fails the attempt", async () => {
  const { proj } = lab();
  const t = ticket(proj, { title: "Escape", allowed_paths: ["src/**"] });
  const spec = {
    executor: { ...builderSeat({ "outside.txt": "nope\n" }), spawn: BYPASS },
    reviewer: { ...reviewerSeat([CLEAN_REVIEW]), spawn: READ_ONLY },
    judge: { ...judgeSeat("PASS"), spawn: READ_ONLY },
    council: [],
  };
  const r = await buildTicket({ projectRoot: proj, id: t.id, roles: spec });
  assert.equal(r.decision, "HUMAN");
  assert.match(fs.readFileSync(path.join(proj, "task.md"), "utf8"), new RegExp(`- \\[!\\] ${t.id}-`));
  assert.ok(r.report.what_did_not_work.some(w => /scope-containment/.test(w)));
});

test("diff-matches-claims: a builder that under-reports its own edits fails the gate", async () => {
  const { proj } = lab();
  const t = ticket(proj, { title: "Liar", allowed_paths: ["src/**"] });
  const spec = {
    executor: { ...builderSeat({ "src/todo.mjs": "export const n = 3;\n", "src/extra.mjs": "export const e = 1;\n" }, { claim: ["src/todo.mjs"] }), spawn: BYPASS },
    reviewer: { ...reviewerSeat([CLEAN_REVIEW]), spawn: READ_ONLY },
    judge: { ...judgeSeat("PASS"), spawn: READ_ONLY },
    council: [],
  };
  const r = await buildTicket({ projectRoot: proj, id: t.id, roles: spec });
  assert.equal(r.decision, "HUMAN");
  assert.ok(r.report.what_did_not_work.some(w => /diff-matches-claims/.test(w)));
});

test("review blocker requests changes, then a second round approves", async () => {
  const { proj } = lab();
  const t = ticket(proj, { title: "Two rounds" });
  const finding = { title: "logs a secret", severity: "HIGH", file: "src/todo.mjs", evidence: "console.log(token)", proof: "token is a credential" };
  const spec = {
    executor: { ...builderSeat({ "src/todo.mjs": "export const n = 2;\n" }), spawn: BYPASS },
    reviewer: { ...reviewerSeat([
      JSON.stringify({ spec_verdict: "PASS", findings: [finding] }),
      JSON.stringify({ is_real: true, confidence: 0.9, reasoning: "holds" }),
      CLEAN_REVIEW,
    ]), spawn: READ_ONLY },
    judge: { ...judgeSeat("PASS"), spawn: READ_ONLY },
    council: [],
  };
  const r = await buildTicket({ projectRoot: proj, id: t.id, roles: spec });
  assert.equal(r.decision, "PASS");
  assert.ok(fs.existsSync(path.join(proj, ".sch-loop", "reviews", `${t.id}-r1.md`)));
  assert.ok(fs.existsSync(path.join(proj, ".sch-loop", "reviews", `${t.id}-r2.md`)));
});

test("human and decision tickets never spawn an executor", async () => {
  const { proj } = lab();
  const t = writeTicket(proj, { phase: "1", type: "human", title: "Check the email", deps: [], action: "Open Gmail", acceptance: ["renders"], gate: "blocking-human" });
  const spec = { executor: { spawn: BYPASS, call: async () => { throw new Error("executor must not run"); } }, reviewer: { spawn: READ_ONLY }, judge: { spawn: READ_ONLY }, council: [] };
  const r = await buildTicket({ projectRoot: proj, id: t.id, roles: spec });
  assert.equal(r.decision, "HUMAN");
  assert.match(fs.readFileSync(path.join(proj, "task.md"), "utf8"), new RegExp(`- \\[\\?\\] ${t.id}-`));
  assert.equal(r.report.status, "needs_human");
});

test("fences: bypass executor with the hooks removed is refused before any model call", async () => {
  const { proj } = lab();
  fs.rmSync(path.join(proj, ".claude", "hooks", "destructive-bash.mjs"));
  const t = ticket(proj, { title: "No fence" });
  const spec = { executor: { spawn: BYPASS, call: async () => { throw new Error("executor must not run"); } }, reviewer: { spawn: READ_ONLY }, judge: { spawn: READ_ONLY }, council: [] };
  const r = await buildTicket({ projectRoot: proj, id: t.id, roles: spec });
  assert.equal(r.refused, true);
  assert.ok(r.fences.failures.some(f => /fence 3/.test(f)));
});

test("a reviewer that can write is refused outright", async () => {
  const { proj } = lab();
  const t = ticket(proj, { title: "Bad reviewer" });
  const spec = { executor: { spawn: BYPASS }, reviewer: { spawn: BYPASS }, judge: { spawn: READ_ONLY }, council: [] };
  await assert.rejects(() => buildTicket({ projectRoot: proj, id: t.id, roles: spec }), /reviewer must be tool-restricted read-only/);
});

test("commitBookkeeping records the loop's own trail and reports an empty run honestly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-book-"));
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "lab@example.invalid");
  git("config", "user.name", "lab");
  fs.mkdirSync(path.join(root, ".sch-loop", "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "task.md"), "# task.md\n");
  fs.writeFileSync(path.join(root, ".sch-loop", "reports", "T1.1.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src.mjs"), "// code, not bookkeeping\n");

  const first = commitBookkeeping({ cwd: root, message: "chore(T1.1): queue and report" });
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(first.files.sort(), [".sch-loop/reports/T1.1.json", "task.md"]);
  assert.equal(execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf8" }).trim(), "?? src.mjs",
    "application code is left for the ticket's own commit");

  const second = commitBookkeeping({ cwd: root, message: "chore: nothing changed" });
  assert.equal(second.ok, false);
  assert.equal(second.empty, true, "a run with no bookkeeping changes is empty, not failed");
});
