import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, dedupe, isBlocking, runReview, reviewToMarkdown } from "./review.mjs";

// A seat may carry its own transport (`call`), which is how the pipeline is exercised end to end
// without spawning a real CLI. Replies are consumed in order: review first, then one per verifier call.
const seatFromReplies = replies => {
  let i = 0;
  return { provider: "fake", call: async () => ({ text: replies[Math.min(i++, replies.length - 1)] }) };
};

test("extractJson survives fences and prose", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('here you go\n```json\n{"a":2}\n```\nthanks'), { a: 2 });
  assert.deepEqual(extractJson('prefix {"a":3} suffix'), { a: 3 });
  assert.throws(() => extractJson("no json here"), /did not return JSON/);
});

test("dedupe collapses on evidence and keeps the strictest severity", () => {
  const out = dedupe([
    { file: "a.ts", evidence: "eval(x)", severity: "MEDIUM", title: "eval" },
    { file: "a.ts", evidence: "eval( x )", severity: "CRITICAL", title: "code injection" },
    { file: "b.ts", evidence: "", title: "naming", line: 3, severity: "LOW" },
  ]);
  assert.equal(out.length, 3);
  const evalFindings = out.filter(f => f.file === "a.ts");
  assert.equal(evalFindings.length, 2, "different whitespace normalises to the same key only when identical after collapse");
  assert.equal(isBlocking({ severity: "HIGH" }), true);
  assert.equal(isBlocking({ severity: "MEDIUM" }), false);
});

test("dedupe merges identical evidence and raises severity", () => {
  const out = dedupe([
    { file: "a.ts", evidence: "eval(x)", severity: "MEDIUM", title: "eval" },
    { file: "a.ts", evidence: "  eval(x)  ", severity: "CRITICAL", title: "code injection" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "CRITICAL");
});

test("runReview: clean diff approves", async () => {
  const seat = seatFromReplies([JSON.stringify({ spec_verdict: "PASS", spec_checks: [{ criterion: "c1", status: "PASS", evidence: "line 4" }], findings: [] })]);
  const r = await runReview({ seat, cwd: process.cwd(), ticket: "T", acceptance: ["c1"], diff: "diff" });
  assert.equal(r.verdict, "APPROVE");
  assert.equal(r.blocking.length, 0);
});

test("runReview: confirmed blocker requests changes; refuted one does not", async () => {
  const finding = { title: "SQL injection", severity: "CRITICAL", file: "db.ts", line: 9, evidence: "`SELECT ${id}`", proof: "id is user input" };
  const confirmed = seatFromReplies([
    JSON.stringify({ spec_verdict: "PASS", findings: [finding] }),
    JSON.stringify({ is_real: true, confidence: 0.9, reasoning: "holds" }),
  ]);
  const a = await runReview({ seat: confirmed, cwd: ".", ticket: "T", acceptance: [], diff: "d" });
  assert.equal(a.verdict, "CHANGES_REQUESTED");
  assert.equal(a.blocking[0].disposition, "confirmed");

  const refutedSeat = seatFromReplies([
    JSON.stringify({ spec_verdict: "PASS", findings: [finding] }),
    JSON.stringify({ is_real: false, confidence: 0.95, reasoning: "parameterised two lines above" }),
  ]);
  const b = await runReview({ seat: refutedSeat, cwd: ".", ticket: "T", acceptance: [], diff: "d" });
  assert.equal(b.verdict, "APPROVE");
  assert.equal(b.advisory[0].disposition, "refuted");
});

test("runReview: low-confidence refutation and verifier failure both stay blocking", async () => {
  const finding = { title: "race", severity: "HIGH", file: "x.ts", evidence: "await later", proof: "two writers" };
  const unsure = seatFromReplies([
    JSON.stringify({ spec_verdict: "PASS", findings: [finding] }),
    JSON.stringify({ is_real: false, confidence: 0.4, reasoning: "not sure" }),
  ]);
  const a = await runReview({ seat: unsure, cwd: ".", ticket: "T", acceptance: [], diff: "d" });
  assert.equal(a.verdict, "CHANGES_REQUESTED");
  assert.equal(a.blocking[0].disposition, "uncertain");

  let n = 0;
  const brokenVerifier = {
    provider: "fake",
    call: async () => { if (n++ === 0) return { text: JSON.stringify({ spec_verdict: "PASS", findings: [finding] }) }; throw new Error("verifier died"); },
  };
  const b = await runReview({ seat: brokenVerifier, cwd: ".", ticket: "T", acceptance: [], diff: "d" });
  assert.equal(b.verdict, "CHANGES_REQUESTED");
  assert.equal(b.blocking[0].disposition, "unverified");
});

test("runReview: spec FAIL blocks even with zero findings, and a blocker without evidence is demoted", async () => {
  const specFail = seatFromReplies([JSON.stringify({ spec_verdict: "FAIL", spec_checks: [{ criterion: "c1", status: "FAIL", evidence: "not implemented" }], findings: [] })]);
  const a = await runReview({ seat: specFail, cwd: ".", ticket: "T", acceptance: ["c1"], diff: "d" });
  assert.equal(a.verdict, "CHANGES_REQUESTED");

  const vapour = seatFromReplies([JSON.stringify({ spec_verdict: "PASS", findings: [{ title: "feels wrong", severity: "CRITICAL", file: "a.ts" }] })]);
  const b = await runReview({ seat: vapour, cwd: ".", ticket: "T", acceptance: [], diff: "d" });
  assert.equal(b.verdict, "APPROVE");
  assert.match(b.advisory[0].title, /demoted/);
});

test("reviewToMarkdown renders both sections", () => {
  const md = reviewToMarkdown({ verdict: "CHANGES_REQUESTED", spec_verdict: "PASS", spec_checks: [], blocking: [{ severity: "HIGH", file: "a.ts", line: 2, title: "bug", evidence: "x", fix: "y", disposition: "confirmed" }], advisory: [], stats: { raw: 1, unique: 1, blocking: 1, refuted: 0, advisory: 0 } }, "T1.1", 1);
  assert.match(md, /# Review T1\.1 — round 1/);
  assert.match(md, /\*\*HIGH\*\* a\.ts:2 — bug/);
  assert.match(md, /## Advisory\n- none/);
});
