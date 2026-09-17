// Phase verification must fail closed. Every test here is a way the phase could be waved through.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyPhase, decide, unfinished, phaseGoal, phaseTickets, phaseFiles, verifyPrompt } from "./verify-phase.mjs";

const TASK = `# task.md

## Phase 1 — Todo core   (2/2 done)
- [x] T1.1-add-priority  build  Add priority  deps:-  size:S
- [x] T1.2-cover-remove  test  Cover remove  deps:T1.1  size:S
`;

function proj(task = TASK, plan = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-vp-"));
  fs.mkdirSync(path.join(root, ".sch-loop", "tickets"), { recursive: true });
  fs.writeFileSync(path.join(root, "task.md"), task);
  for (const [id, slug] of [["T1.1", "add-priority"], ["T1.2", "cover-remove"]]) {
    fs.writeFileSync(path.join(root, ".sch-loop", "tickets", `${id}-${slug}.json`), JSON.stringify({
      id, slug, type: "build", title: slug, action: "do it", acceptance: [`${id} works`], allowed_paths: ["src/**"],
    }));
  }
  if (plan) fs.writeFileSync(path.join(root, ".sch-loop", "PLAN.md"), plan);
  return root;
}
const GREEN = [{ name: "npm test", ok: true, exitCode: 0 }];
const seatSaying = obj => ({ role: "reviewer", call: async () => ({ text: JSON.stringify(obj) }) });
const run = (root, seat, checks = GREEN) => verifyPhase({
  projectRoot: root, phase: "1", seat, checks: [{ name: "npm test", command: "npm", args: ["test"] }],
  runChecks: async () => ({ checks }), ask: (s, a) => s.call(a),
});
const verified = n => ({ truths: Array.from({ length: n }, (_, i) => ({ truth: `t${i}`, level_reached: "flowing", status: "verified", evidence: "src/a.mjs:1" })), gaps: [] });

test("a phase whose truths all flow passes, and the report says what was checked", async () => {
  const root = proj();
  const r = await run(root, seatSaying(verified(3)));
  assert.equal(r.status, "passed");
  const md = fs.readFileSync(r.file, "utf8");
  assert.match(md, /\*\*Status:\*\* passed/);
  assert.match(md, /3\/3 truths/);
  assert.match(md, /PASS — npm test/);
});

test("a red deterministic check cannot be argued past, however confident the verifier is", async () => {
  const root = proj();
  const r = await run(root, seatSaying(verified(5)), [{ name: "npm test", ok: false, exitCode: 1, stderr: "2 failing" }]);
  assert.equal(r.status, "gaps_found");
  assert.match(r.why, /deterministic checks failed: npm test/);
});

test("an unfinished ticket stops verification before a seat is paid for", async () => {
  const root = proj(TASK.replace("- [x] T1.2", "- [!] T1.2"));
  let asked = 0;
  const r = await run(root, { role: "reviewer", call: async () => { asked++; return { text: "{}" }; } });
  assert.equal(asked, 0, "no seat is asked to verify a phase that is not finished");
  assert.equal(r.status, "gaps_found");
  assert.match(r.why, /T1\.2 is \[!\]/);
});

test("a runtime-behaviour truth with no test behind it goes to the human, not to passed", async () => {
  const root = proj();
  const r = await run(root, seatSaying({ truths: [{ truth: "state resets on unmount", level_reached: "wired", status: "behaviour_unverified", evidence: "no test" }], gaps: [] }));
  assert.equal(r.status, "human_needed");
  assert.match(r.why, /no test behind it/);
});

test("an unreadable or empty verifier answer is human_needed, never passed", async () => {
  for (const text of ["I think it's fine, honestly", '{"truths":[]}', ""]) {
    const root = proj();
    const r = await verifyPhase({ projectRoot: root, phase: "1", seat: {}, runChecks: async () => ({ checks: GREEN }), ask: async () => ({ text }) });
    assert.equal(r.status, "human_needed", `"${text}" must not pass`);
  }
});

test("a verifier seat that throws is human_needed, and the raw answer is kept for the human", async () => {
  const root = proj();
  const r = await verifyPhase({ projectRoot: root, phase: "1", seat: {}, runChecks: async () => ({ checks: GREEN }), ask: async () => { throw new Error("seat exploded"); } });
  assert.equal(r.status, "human_needed");
  assert.match(fs.readFileSync(path.join(root, ".sch-loop", "verify", "phase-1.raw.txt"), "utf8"), /seat exploded/);
});

test("a truth with a made-up status is not silently treated as verified", () => {
  const d = decide({ parsed: { truths: [{ truth: "x", status: "looks-good" }] }, checks: [], unfinishedTickets: [] });
  assert.equal(d.status, "human_needed");
  assert.match(d.why, /no usable status/);
});

test("the goal comes from PLAN.md when it is there, and says so when it is not", () => {
  // A real goal runs to more than one line, and the LAST phase in the file has no `## ` after it. Both
  // were needed to catch an end-of-input anchor that `$` under the `m` flag had turned into end-of-line:
  // the match failed, the fallback quietly returned the task.md heading, and the old one-line fixture
  // could not tell the difference.
  const PLAN = [
    "# Plan", "",
    "## Phase 1 — Todo core",
    "A user can set and read a priority on any todo,",
    "and it survives complete() and remove().", "",
    "## Phase 2 — Filtering",
    "A user who only cares about one priority can ask",
    "for exactly those items.", "",
  ].join("\n");
  const withPlan = proj(TASK, PLAN);

  const first = phaseGoal(withPlan, "1");
  assert.equal(first.source, ".sch-loop/PLAN.md");
  assert.match(first.goal, /A user can set and read a priority/);
  assert.match(first.goal, /survives complete\(\) and remove\(\)/, "the goal is not truncated at the first line");
  assert.doesNotMatch(first.goal, /Filtering|only cares/, "the next phase's goal does not bleed in");

  const last = phaseGoal(withPlan, "2");
  assert.equal(last.source, ".sch-loop/PLAN.md", "the last phase in the file is still found");
  assert.match(last.goal, /for exactly those items/, "and is still read to the end");

  assert.match(phaseGoal(proj(), "1").source, /no PLAN\.md/);
  assert.match(phaseGoal(withPlan, "9").source, /no PLAN\.md/, "a phase the plan does not mention falls back");
});

test("the prompt hands the verifier the check results rather than letting it run them", () => {
  const root = proj();
  const p = verifyPrompt({ goal: "g", goalSource: "s", phase: "1", tickets: phaseTickets(root, "1"), checks: [{ name: "npm test", ok: false, exitCode: 1, stderr: "2 failing" }], files: ["src/todo.mjs"] });
  assert.match(p, /you cannot overrule these/);
  assert.match(p, /npm test: FAILED \(exit 1\)/);
  assert.match(p, /2 failing/);
  assert.match(p, /T1\.1 works/, "acceptance criteria travel with the ticket");
});

test("unfinished names every non-done glyph, not only pending ones", () => {
  assert.deepEqual(unfinished([{ id: "A", status: "x" }, { id: "B", status: " " }, { id: "C", status: "!" }, { id: "D", status: "?" }, { id: "E", status: "~" }]),
    ["B is [pending]", "C is [!]", "D is [?]", "E is [~]"]);
});

test("the file list is what the phase delivered, not what it was allowed to touch", () => {
  const root = proj();
  fs.mkdirSync(path.join(root, ".sch-loop", "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sch-loop", "reports", "T1.1.json"), JSON.stringify({ id: "T1.1", artifacts: ["src/todo.mjs"] }));
  // T1.2 delivered nothing and has no report at all; its `src/**` permission must not appear as work.
  const files = phaseFiles(root, phaseTickets(root, "1"));
  assert.deepEqual(files, ["src/todo.mjs"]);
  assert.ok(!files.includes("src/**"), "a permission glob is never presented as a delivered file");
});
