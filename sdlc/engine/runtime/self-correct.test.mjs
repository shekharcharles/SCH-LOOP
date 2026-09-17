// Recovery ladder tier 1: what happens when the executor process dies mid-ticket. Proven live once by
// killing a real `claude.exe` tree 45 seconds into T1.4 (see .sch-loop/evidence/criterion-7-kill-recovery.json,
// which recorded exactly one attempt with manager:RETRY, reason:builder-failed, then attempt 2). This
// pins the behaviour so it cannot regress without a kill test to catch it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSelfCorrectingTask, decideManager } from "./self-correct.mjs";

const cwd = () => fs.mkdtempSync(path.join(os.tmpdir(), "sch-sc-"));

// A seat that dies the first N times the way a killed CLI does — a non-zero exit, carrying the run record
// that seats.mjs attaches — then answers normally.
function dyingSeat(deaths, onPrompt = () => {}) {
  let calls = 0;
  return {
    role: "executor",
    call: async ({ prompt }) => {
      calls++;
      onPrompt(prompt, calls);
      if (calls <= deaths) {
        const err = new Error("claude FAILED exit 1: terminated");
        err.run = { outcome: "FAILED", exitCode: 1, events: [] };
        throw err;
      }
      return { text: "FILES CHANGED:\n(none)\nSUMMARY: nothing to do" };
    },
    get calls() { return calls; },
  };
}
const base = (builder, extra = {}) => ({
  ticketId: "T9.1", ticket: "T9.1 Kill me [type:chore]", requirements: "it survives",
  builder, judge: { role: "judge", call: async () => ({ text: '{"verdict":"PASS","reasons":["stub"]}' }) },
  allowedPaths: ["src/**"], verificationChecks: [], cwd: cwd(), maxAttempts: 3, ...extra,
});

test("a killed executor costs exactly one attempt and is respawned, not crashed", async () => {
  const seat = dyingSeat(1);
  const state = await runSelfCorrectingTask(base(seat));
  const dead = state.attempts.filter(a => a.reason === "builder-failed");
  assert.equal(dead.length, 1, "the death is recorded once, not zero times and not twice");
  assert.equal(dead[0].attempt, 1);
  assert.equal(dead[0].manager, "RETRY");
  assert.match(dead[0].error, /exit 1/);
  assert.equal(seat.calls, 2, "the builder was respawned exactly once after the kill");
});

test("the respawned executor is told what killed the last attempt", async () => {
  const prompts = [];
  const seat = dyingSeat(1, p => prompts.push(p));
  await runSelfCorrectingTask(base(seat));
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0], /FAILED/, "the first attempt has no prior failure to report");
  assert.match(prompts[1], /Previous attempt 1 ended with FAILED/, "the failure note rides into the respawn");
});

test("an executor that dies every attempt ends with the human, never a silent pass", async () => {
  const seat = dyingSeat(99);
  const state = await runSelfCorrectingTask(base(seat));
  assert.equal(seat.calls, 3, "maxAttempts is honoured — a dying seat is not retried forever");
  assert.equal(state.managerDecision, "HUMAN");
  assert.equal(state.status, "needs_decision");
  assert.equal(state.attempts.length, 3);
});

test("decideManager spends attempts before it spends the human", () => {
  const red = { verificationPassed: false, judgeVerdict: "REJECT", maxAttempts: 3 };
  assert.equal(decideManager({ ...red, attempt: 1 }), "RETRY");
  assert.equal(decideManager({ ...red, attempt: 3 }), "HUMAN");
  assert.equal(decideManager({ verificationPassed: true, judgeVerdict: "PASS", attempt: 1, maxAttempts: 3 }), "PASS");
});

test("the FILES CHANGED contract the builder is given matches the frame the gate checks", async () => {
  // `workspaceEvidence` passes `--relative`, so git answers in PROJECT-relative paths. The prompt used
  // to say "repository-relative", and every ticket spent its first attempt discovering the difference.
  const { builderPrompt } = await import("./self-correct.mjs");
  const p = builderPrompt({ ticket: "T1.1", requirements: "x", lessons: [], priorRejection: "", passingRequirements: [] });
  assert.match(p, /RELATIVE TO YOUR WORKING DIRECTORY/);
  assert.doesNotMatch(p, /repository-relative/, "the old wording contradicted the gate");
  assert.match(p, /src\/todo\.mjs/, "the prompt shows the shape it wants");
});
