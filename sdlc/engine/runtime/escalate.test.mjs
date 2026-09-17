// Recovery ladder tiers 3 and 4. The council is stubbed: what is under test is the gate, the
// re-dispatch, and the fact that a second red on the same ticket stops instead of convening again.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { escalate, councilGate, failureQuestion, MAX_COUNCIL_ROUNDS } from "./escalate.mjs";
import { ticketToBuildSpec } from "./tickets.mjs";

const SEATS = [{ role: "architect", spawn: ["claude"] }, { role: "skeptic", spawn: ["codex"] }];
const ROLES = { reviewer: { role: "reviewer", spawn: ["claude"] }, council: SEATS };
const CONFIG = { council_mode: "gated", council_minimum_seats: 2 };

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-esc-"));
  fs.mkdirSync(path.join(root, ".sch-loop", "tickets"), { recursive: true });
  fs.writeFileSync(path.join(root, "task.md"), [
    "# Tasks", "",
    "## Phase 1 — Lab (0/1 done)",
    "- [!] T1.1-make-it-red  build  Make it red  deps:-  size:S",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, ".sch-loop", "tickets", "T1.1-make-it-red.json"), JSON.stringify({
    id: "T1.1", slug: "make-it-red", type: "build", title: "Make it red", action: "Do the impossible",
    acceptance: ["it passes"], allowed_paths: ["src/**"], verify: [{ command: "npm", args: ["test"] }],
  }, null, 2));
  return root;
}
const taskLine = root => fs.readFileSync(path.join(root, "task.md"), "utf8").split("\n").find(l => l.includes("T1.1"));
const ticket = root => JSON.parse(fs.readFileSync(path.join(root, ".sch-loop", "tickets", "T1.1-make-it-red.json"), "utf8"));
const REPORT = { summary: "stopped after 3 attempts", what_did_not_work: ["tests still red"], attempts: 3 };
const opts = root => ({ projectRoot: root, id: "T1.1", report: REPORT, roles: ROLES, config: CONFIG, notify: async () => {} });

test("a red ticket convenes the council and goes back into the queue carrying the verdict", async () => {
  const root = project();
  let asked = null;
  const r = await escalate({
    ...opts(root),
    council: async (req) => { asked = req; return { id: "council-1", verdict: "VERDICT: split the ticket. Write the failing test first." }; },
  });
  assert.equal(r.decision, "COUNCIL_REDISPATCH");
  assert.equal(r.councilId, "council-1");
  assert.match(taskLine(root), /^- \[ \] T1\.1/, "the ticket is pending again, not blocked");
  const t = ticket(root);
  assert.equal(t.council_rounds, 1);
  assert.match(t.council_guidance, /split the ticket/);
  assert.ok(fs.existsSync(path.join(root, ".sch-loop", "council", "T1.1-verdict.md")));
  assert.equal(asked.seats.length, 2);
  assert.equal(asked.chair.role, "reviewer", "the reviewer chairs by default");
  assert.match(asked.question, /tests still red/, "the council is told what did not work");
});

test("the verdict reaches the next executor as part of its brief", () => {
  const root = project();
  const t = { ...ticket(root), council_guidance: "VERDICT: the API is misnamed, rename it first." };
  const spec = ticketToBuildSpec(t, root);
  assert.match(spec.ticket, /A COUNCIL HAS ALREADY REVIEWED/);
  assert.match(spec.ticket, /the API is misnamed/);
});

test("a second red on the same ticket stops instead of convening again", async () => {
  const root = project();
  await escalate({ ...opts(root), council: async () => ({ id: "c1", verdict: "try harder" }) });
  let convened = 0;
  const r = await escalate({ ...opts(root), council: async () => { convened++; return { id: "c2", verdict: "x" }; } });
  assert.equal(convened, 0, "no second council on the same ticket");
  assert.equal(r.decision, "HUMAN");
  assert.match(r.why, /already convened/);
  assert.match(taskLine(root), /^- \[\?\] T1\.1/);
});

test("too few enabled seats skips the council and escalates to the human, saying so", async () => {
  const root = project();
  const roles = { ...ROLES, council: [SEATS[0], { ...SEATS[1], enabled: false }] };
  const r = await escalate({ ...opts(root), roles, council: async () => { throw new Error("must not convene"); } });
  assert.equal(r.decision, "HUMAN");
  assert.match(r.why, /only 1 council seat\(s\) enabled, minimum is 2/);
  assert.match(taskLine(root), /^- \[\?\] T1\.1/);
});

test("a council that throws or returns nothing is a human escalation, never a silent pass", async () => {
  for (const council of [async () => { throw new Error("every seat timed out"); }, async () => ({ id: "c", verdict: "   " })]) {
    const root = project();
    const r = await escalate({ ...opts(root), council });
    assert.equal(r.decision, "HUMAN");
    assert.match(taskLine(root), /^- \[\?\] T1\.1/);
    assert.equal(ticket(root).council_rounds ?? 0, 0, "a failed council does not spend the ticket's one round");
  }
});

test("council_mode off never convenes", () => {
  const g = councilGate({ config: { council_mode: "off" }, roles: ROLES, ticket: { id: "T1.1" } });
  assert.equal(g.ok, false);
  assert.match(g.why, /off/);
});

test("the gate allows exactly MAX_COUNCIL_ROUNDS", () => {
  const ok = councilGate({ config: CONFIG, roles: ROLES, ticket: { id: "T1.1", council_rounds: MAX_COUNCIL_ROUNDS - 1 } });
  const no = councilGate({ config: CONFIG, roles: ROLES, ticket: { id: "T1.1", council_rounds: MAX_COUNCIL_ROUNDS } });
  assert.equal(ok.ok, true);
  assert.equal(no.ok, false);
});

test("the question carries the acceptance criteria the ticket failed to meet", () => {
  const q = failureQuestion({ id: "T1.1", title: "Make it red", type: "build", action: "Do it", acceptance: ["the suite is green"] }, REPORT);
  assert.match(q, /the suite is green/);
  assert.match(q, /Make it red/);
});
