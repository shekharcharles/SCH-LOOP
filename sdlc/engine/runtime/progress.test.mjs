// The progress view is the only place a person looks to answer "is it working". Every number in it must
// come from what the loop recorded, and it must be readable when the project is empty.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { summary, render, renderLog, live, events, ticketReports } from "./progress.mjs";

function proj() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-prog-"));
  fs.mkdirSync(path.join(root, ".sch-loop", "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "task.md"), [
    "# task.md", "",
    "## Phase 1 — Core   (1/2 done)",
    "- [x] T1.1-first   build  First   deps:-     size:S",
    "- [ ] T1.2-second  build  Second  deps:T1.1  size:S",
    "",
    "## Phase 2 — Later   (0/1 done)",
    "- [ ] T2.1-gate  decision  Decide  deps:T1.2  size:XS  gate:blocking-human",
    "",
  ].join("\n"));
  return root;
}
const put = (root, rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), typeof body === "string" ? body : JSON.stringify(body)); };

test("totals are summed from the reports, not invented", () => {
  const root = proj();
  put(root, ".sch-loop/reports/T1.1.json", { id: "T1.1", attempts: 2, artifacts: ["src/a.mjs", "tests/a.test.mjs"], cost_usd: 0.45, context_tokens: 52842, review: { verdict: "APPROVE" } });
  put(root, ".sch-loop/events.jsonl", JSON.stringify({ at: new Date().toISOString(), type: "ticket.done", id: "T1.1", attempts: 2, ms: 540000 }) + "\n");
  const s = summary(root);
  assert.equal(s.totals.tickets, 3);
  assert.equal(s.totals.done, 1);
  assert.equal(s.totals.attempts, 2);
  assert.equal(s.totals.filesTouched, 2);
  assert.equal(s.totals.costUsd, 0.45);
  assert.equal(s.totals.reviews, 1);
  assert.equal(s.totals.peakContextTokens, 52842);
  assert.equal(s.totals.buildMs, 540000);
});

test("a human-gated ticket is shown as waiting for a person, not as pending work", () => {
  const out = render(summary(proj()));
  assert.match(out, /T2\.1[\s\S]*waits for you/);
});

test("running versus idle is decided by the heartbeat's age, not its presence", () => {
  const root = proj();
  put(root, ".sch-loop/heartbeat", { pid: 1, at: new Date().toISOString(), state: "running", ticket: "T1.2" });
  assert.equal(live(root).running, true);
  assert.match(render(summary(root)), /BUILDING NOW[\s\S]*ticket   T1\.2/, "the heartbeat names the ticket even before its first event lands");

  put(root, ".sch-loop/heartbeat", { pid: 1, at: new Date(Date.now() - 10 * 60_000).toISOString(), state: "running" });
  assert.equal(live(root).running, false, "a stale heartbeat is not a running loop");

  put(root, ".sch-loop/heartbeat", { pid: 1, at: new Date().toISOString(), state: "stopped" });
  assert.equal(live(root).running, false, "and a fresh one that says stopped is not either");
});

test("an empty project renders without throwing and says nothing is done", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-prog-empty-"));
  const out = render(summary(root));
  assert.match(out, /GOAL\s+\(not set\)/);
  assert.match(out, /0\/0 done/);
  assert.equal(events(root).length, 0);
  assert.deepEqual(ticketReports(root), []);
});

test("the log turns events into sentences, and names the ticket stage by what it queued", () => {
  const rows = [
    { at: "2026-09-17T08:00:00Z", type: "stage.done", stage: "prd", artifact: ".sch-loop/PRD.md", chars: 10426, ms: 57000 },
    // This one reports `written`, not `chars` — rendering it generically said "0 chars" for a stage
    // that had produced thirteen tickets.
    { at: "2026-09-17T08:04:00Z", type: "stage.done", stage: "tickets", written: 13, rejected: 0, ms: 134000 },
    { at: "2026-09-17T08:13:00Z", type: "ticket.done", id: "T1.1", attempts: 2, ms: 536000 },
    { at: "2026-09-17T08:14:00Z", type: "ticket.council.start", id: "T1.4", seats: ["architect", "skeptic"], why: "attempts exhausted" },
  ];
  const out = renderLog(rows);
  assert.match(out, /wrote \.sch-loop\/PRD\.md — 10,426 chars/);
  assert.match(out, /queued 13 ticket\(s\) in 2m/);
  assert.doesNotMatch(out, /0 chars/);
  assert.match(out, /T1\.1 DONE after 2 attempt\(s\)/);
  assert.match(out, /council convened on T1\.4 \(architect, skeptic\)/);
});

test("an unknown event still prints rather than vanishing", () => {
  const out = renderLog([{ at: "2026-09-17T08:00:00Z", type: "something.new", detail: "x" }]);
  assert.match(out, /something\.new/);
});

test("a corrupt line in the event log does not hide the rest", () => {
  const root = proj();
  put(root, ".sch-loop/events.jsonl", JSON.stringify({ at: "2026-09-17T08:00:00Z", type: "ticket.done", id: "A" }) + "\n{ bad\n" + JSON.stringify({ at: "2026-09-17T08:01:00Z", type: "ticket.done", id: "B" }) + "\n");
  assert.deepEqual(events(root).map(e => e.id), ["A", "B"]);
});
