import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, step, backoffMs, isRateLimited, writeHeartbeat, heartbeatStatus, HEARTBEAT_MS } from "./watchdog.mjs";
import { writeReport } from "./report.mjs";

const TASK = `# task.md
<!-- legend -->

## Phase 1 — Foundation   (0/3 done)
- [ ] T1.1-first   build  First   deps:-      size:S
- [ ] T1.2-second  build  Second  deps:T1.1   size:S
- [ ] T1.3-third   build  Third   deps:-      size:S
`;

function proj(task = TASK) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-wd-"));
  fs.mkdirSync(path.join(root, ".sch-loop", "tickets"), { recursive: true });
  fs.writeFileSync(path.join(root, "task.md"), task);
  fs.writeFileSync(path.join(root, ".sch-loop", "config.md"), "rate_limit_backoff_minutes: [1, 2, 4]\n");
  fs.writeFileSync(path.join(root, ".sch-loop", "roles.json"), JSON.stringify({ executor: { spawn: ["x"] }, reviewer: { spawn: ["x"] }, judge: { spawn: ["x"] }, council: [] }));
  return root;
}
// A stub build that marks task.md the way the real one does, so `next()` advances.
function stubBuild(outcomes) {
  const seen = [];
  return {
    seen,
    fn: async ({ projectRoot, id }) => {
      const o = outcomes[id] || { decision: "PASS" };
      seen.push(id);
      const f = path.join(projectRoot, "task.md");
      const glyph = o.decision === "PASS" ? "x" : (o.decision === "HUMAN" ? "!" : "~");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(new RegExp(`- \\[.\\] ${id}-`), `- [${glyph}] ${id}-`));
      writeReport(projectRoot, { id, status: o.decision === "PASS" ? "done" : "blocked", summary: o.summary || "", what_did_not_work: o.what_did_not_work || [] });
      return { decision: o.decision, report: readReportSafe(projectRoot, id) };
    },
  };
}
const readReportSafe = (root, id) => JSON.parse(fs.readFileSync(path.join(root, ".sch-loop", "reports", `${id}.json`), "utf8"));

test("heartbeat: fresh is alive, stale is not, missing is not", () => {
  const root = proj();
  assert.equal(heartbeatStatus(root).alive, false);
  writeHeartbeat(root, { ticket: "T1.1" });
  const h = heartbeatStatus(root);
  assert.equal(h.alive, true);
  assert.equal(h.ticket, "T1.1");
  assert.equal(heartbeatStatus(root, Date.now() + HEARTBEAT_MS * 4).alive, false);
});

test("backoff ladder clamps at the last rung", () => {
  const c = { rate_limit_backoff_minutes: [1, 2, 4] };
  assert.deepEqual([0, 1, 2, 3, 9].map(s => backoffMs(c, s)), [60000, 120000, 240000, 240000, 240000]);
  assert.equal(backoffMs({}, 0), 60000);
});

test("isRateLimited reads the report, not the exception", () => {
  assert.equal(isRateLimited({ what_did_not_work: ["claude exited 1: rate limit reached"] }), true);
  assert.equal(isRateLimited({ summary: "429 Too Many Requests" }), true);
  assert.equal(isRateLimited({ what_did_not_work: ["check test failed"] }), false);
});

test("run: dispatches in file order, respects deps, stops when nothing is dispatchable", async () => {
  const root = proj();
  const b = stubBuild({});
  const out = await run({ projectRoot: root, build: b.fn });
  assert.deepEqual(b.seen, ["T1.1", "T1.2", "T1.3"]);
  assert.deepEqual(out.done, ["T1.1", "T1.2", "T1.3"]);
  assert.deepEqual(out.blocked, []);
});

test("run: a blocked ticket is skipped and its dependants are never dispatched", async () => {
  const root = proj();
  const b = stubBuild({ "T1.1": { decision: "HUMAN", what_did_not_work: ["check test failed"] } });
  const out = await run({ projectRoot: root, build: b.fn });
  assert.deepEqual(b.seen, ["T1.1", "T1.3"], "T1.2 depends on the blocked T1.1");
  assert.deepEqual(out.blocked, ["T1.1"]);
  assert.deepEqual(out.done, ["T1.3"]);
});

test("run: an inserted ticket is dispatched before a later one", async () => {
  const root = proj(`# task.md

## Phase 1 — Foundation   (0/3 done)
- [x] T1.1-first   build  First    deps:-      size:S
- [ ] T1.1a-fixup  build  Fixup    deps:T1.1   size:S
- [ ] T1.2-second  build  Second   deps:T1.1   size:S
`);
  const b = stubBuild({});
  await run({ projectRoot: root, build: b.fn });
  assert.deepEqual(b.seen, ["T1.1a", "T1.2"]);
});

test("run: a rate-limited ticket backs off and is retried without spending an attempt", async () => {
  const root = proj(`# task.md

## Phase 1 — Foundation   (0/1 done)
- [ ] T1.1-first  build  First  deps:-  size:S
`);
  let call = 0;
  const waits = [];
  const build = async ({ projectRoot, id }) => {
    call++;
    const limited = call === 1;
    const f = path.join(projectRoot, "task.md");
    if (!limited) fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(`- [ ] ${id}-`, `- [x] ${id}-`));
    writeReport(projectRoot, { id, status: limited ? "blocked" : "done", what_did_not_work: limited ? ["claude exited 1: rate limit reached, retry later"] : [] });
    return { decision: limited ? "HUMAN" : "PASS" };
  };
  const out = await run({ projectRoot: root, build, sleepFn: async ms => { waits.push(ms); } });
  assert.equal(call, 2);
  assert.deepEqual(waits, [60000]);
  assert.deepEqual(out.done, ["T1.1"]);
});

test("step: a throwing build is a fault that stops the run", async () => {
  const root = proj();
  const out = await run({ projectRoot: root, build: async () => { throw new Error("roles.json: judge missing"); } });
  assert.equal(out.results[0].decision, "FAULT");
  assert.match(out.results[0].error, /judge missing/);
  assert.equal(out.results.length, 1, "no further tickets after a configuration fault");
});

test("step returns null when every ticket is done or blocked", async () => {
  const root = proj(`# task.md

## Phase 1 — F   (1/1 done)
- [x] T1.1-first  build  First  deps:-  size:S
`);
  const r = await step({ projectRoot: root, roles: {}, config: {}, build: async () => ({ decision: "PASS" }) });
  assert.equal(r, null);
});

test("heartbeat is written during a run and marked stopped after", async () => {
  const root = proj();
  await run({ projectRoot: root, build: stubBuild({}).fn });
  const h = JSON.parse(fs.readFileSync(path.join(root, ".sch-loop", "heartbeat"), "utf8"));
  assert.equal(h.state, "stopped");
  assert.equal(typeof h.pid, "number");
});

test("step routes an exhausted ticket through the escalation, and a council verdict re-queues it", async () => {
  const root = proj();
  const b = stubBuild({ "T1.1": { decision: "HUMAN", summary: "stopped after 3 attempts" } });
  const seen = [];
  const r = await step({
    projectRoot: root, roles: { council: [] }, config: {}, build: b.fn,
    escalateFn: async (a) => { seen.push(a.id); return { decision: "COUNCIL_REDISPATCH", councilId: "c-1" }; },
  });
  assert.deepEqual(seen, ["T1.1"]);
  assert.equal(r.decision, "COUNCIL");
  assert.equal(r.councilId, "c-1");
});

test("a fence refusal is never escalated to the council — no model ever saw the work", async () => {
  const root = proj();
  const build = async ({ projectRoot, id }) => {
    writeReport(projectRoot, { id, status: "refused", summary: "not a worktree", what_did_not_work: ["worktree fence"] });
    return { decision: "HUMAN", refused: true };
  };
  let convened = 0;
  const r = await step({ projectRoot: root, roles: { council: [] }, config: {}, build, escalateFn: async () => { convened++; return { decision: "HUMAN" }; } });
  assert.equal(convened, 0);
  assert.equal(r.decision, "HUMAN");
  assert.equal(r.refused, true);
});

test("an escalation that throws leaves the ticket with the human instead of killing the run", async () => {
  const root = proj();
  const b = stubBuild({ "T1.1": { decision: "HUMAN" }, "T1.3": { decision: "PASS" } });
  const out = await run({
    projectRoot: root, build: b.fn,
    escalateFn: async () => { throw new Error("council module is broken"); },
  });
  assert.deepEqual(b.seen, ["T1.1", "T1.3"], "the run continued to the next unblocked ticket");
  assert.deepEqual(out.blocked, ["T1.1"]);
  assert.match(out.results[0].why, /council module is broken/);
});
