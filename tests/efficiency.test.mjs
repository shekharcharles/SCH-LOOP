// SCH Loop — the token-efficiency guard.
//
// WHY THIS TEST EXISTS
// Everything else in this suite protects correctness. Nothing protected the
// property the whole architecture is built on: that a worker's prompt PREFIX is
// byte-identical between tasks, so 90%+ of input is served from cache instead of
// re-billed. Measured on a real project: 2,164,041 of 2,361,184 input tokens
// were cache reads — 136 tokens were charged as fresh input.
//
// That property is silent when it breaks. A timestamp, a task id, a counter or
// a re-ordered section anywhere before the task body costs nothing in tests,
// passes review, and quietly multiplies the bill. These assertions fail loudly
// instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as RUN from "../scripts/runner.mjs";
import * as ROLES from "../scripts/roles.mjs";

const identity = (taskId) => ({ run_id: "RUN-FIXED", project_id: "p", task_id: String(taskId) });
const policy = { allowed: ["src/**"], forbidden: [], verify: [{ exe: "pytest", args: ["-q"] }] };
const task = (id) => ({ title: "task " + id, phase: 1, ac: ["works"], ng: ["no gui"], notes: "" });

const compile = (id) => RUN.compilePrompt({ identity: identity(id), task: task(id), policy, skills: [] });

// The cached prefix is everything before the task body. If these sections stop
// being identical across tasks, cache reuse collapses.
const prefixOf = (text) => {
  const i = text.indexOf("# TASK ");
  assert.ok(i > 0, "the prompt must contain a task section — the prefix boundary is defined by it");
  return text.slice(0, i);
};

test("efficiency: the prompt prefix is byte-identical across tasks", () => {
  const a = prefixOf(compile(1).text);
  const b = prefixOf(compile(2).text);
  const c = prefixOf(compile(99).text);
  assert.equal(a, b, "prefix differs between task 1 and task 2 — cache reuse is lost");
  assert.equal(b, c, "prefix differs between task 2 and task 99 — cache reuse is lost");
  assert.ok(a.length > 200, "the prefix is suspiciously small; the safety kernel should be in it");
});

test("efficiency: the prefix carries no clock, no run id and no task id", () => {
  const p = prefixOf(compile(7).text);
  // A timestamp is the classic cache killer: correct-looking, invisible, and it
  // invalidates the prefix on every single run.
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(p), "an ISO timestamp appears in the cached prefix");
  assert.ok(!p.includes("RUN-FIXED"), "the run id appears in the cached prefix");
  assert.ok(!/# TASK 7\b/.test(p), "the task id appears in the cached prefix");
});

test("efficiency: the discretion envelope is inside the cached prefix", () => {
  const r = compile(3);
  const names = r.manifest.sections.filter((s) => s.included).map((s) => s.name);
  assert.equal(names[0], "safety-kernel");
  assert.equal(names[1], "discretion",
    "the discretion envelope must sit in the stable prefix, not after the task — otherwise it is re-billed every task");
  assert.ok(prefixOf(r.text).includes("Do NOT stop because"),
    "the envelope's own text must be inside the prefix");
});

test("efficiency: model routing sends cheap roles to cheap models", () => {
  const m = (r) => ROLES.modelForRole(r, {}).model;
  assert.equal(m("scout"), "haiku", "search is the cheapest thing this system does");
  assert.equal(m("documenter"), "haiku");
  assert.equal(m("builder"), "sonnet", "code is not written by the cheapest model");
  assert.equal(m("repairer"), "sonnet");
  assert.equal(m("planner"), "opus", "planning decides what everything else costs");
  assert.equal(m("reviewer"), "opus");
});

test("efficiency: a retry escalates upward, never downward", () => {
  for (const role of ROLES.ROLE_IDS) {
    const first = ROLES.modelForAttempt(role, {}, 1).model;
    const second = ROLES.modelForAttempt(role, {}, 2).model;
    const rank = { haiku: 1, sonnet: 2, opus: 3, inherited: 0 };
    assert.ok(rank[second] >= rank[first],
      `${role} escalates DOWN on retry (${first} -> ${second}) — a retry must never become weaker`);
  }
  assert.equal(ROLES.modelForAttempt("builder", {}, 2).model, "opus");
  assert.equal(ROLES.modelForAttempt("builder", {}, 5).model, "opus", "escalation holds, it does not keep climbing");
});

test("efficiency: an operator's model choice is honoured and recorded", () => {
  const project = { modelPolicy: { models: { builder: "opus" } } };
  const chosen = ROLES.modelForRole("builder", project);
  assert.equal(chosen.model, "opus");
  assert.equal(chosen.source, "project", "the record must say WHY it ran on what it ran on");
  assert.equal(ROLES.modelForRole("reviewer", project).source, "profile",
    "an override on one role must not silently move another");
});

test("efficiency: a model outside the closed set is refused, not passed through", () => {
  const project = { modelPolicy: { models: { builder: "gpt-4o" } } };
  const r = ROLES.modelForRole("builder", project);
  assert.equal(r.model, "sonnet", "an unknown model must fall back to the profile, never reach the CLI");
  assert.equal(r.source, "profile");
});

test("efficiency: --model and --effort actually reach the CLI", () => {
  assert.deepEqual(RUN.modelArgs({ model: "opus", reasoning: "high" }), ["--model", "opus", "--effort", "high"]);
  assert.deepEqual(RUN.modelArgs({ model: "inherited", reasoning: "low" }), ["--effort", "low"],
    "an inherited model must not be passed as a --model value");
  assert.deepEqual(RUN.modelArgs(null), []);
});

test("efficiency: usage is read from the provider, never invented", () => {
  const envelope = JSON.stringify({
    result: "ok", num_turns: 3, total_cost_usd: 0.25,
    usage: { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 90000, cache_creation_input_tokens: 1000 },
    modelUsage: { "claude-haiku-4-5": { outputTokens: 5, costUSD: 0.001 },
                  "claude-sonnet-5": { outputTokens: 495, costUSD: 0.249 } },
  });
  const o = RUN.readCliOutput(envelope);
  assert.equal(o.structured, true);
  assert.equal(o.usage.cache_read_tokens, 90000);
  assert.equal(o.usage.cost_usd, 0.25);
  // the model that did the work, not the first key or the last one
  assert.equal(o.usage.model, "claude-sonnet-5",
    "the primary model must be the one that cost the most — first/last key gave two different answers for one run");
  const plain = RUN.readCliOutput("just some text");
  assert.equal(plain.structured, false);
  assert.equal(plain.usage, null, "usage must be null when the provider reported none, never zero");
});
