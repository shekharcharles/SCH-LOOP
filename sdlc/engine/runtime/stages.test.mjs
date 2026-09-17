// The front half of the lifecycle. It had never run, and the chain was broken at its first link, so
// these tests are mostly about the two things that matter: order, and refusing a hollow artifact.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STAGES, stageById, stageStatus, stageReport, nextStage, runStage, setGoal, goal,
  cleanDocument, stagePrompt, skillBody, skillsRoots, advanceLifecycle, GOAL_FILE,
  runTicketsStage, parseTickets,
} from "./stages.mjs";

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const proj = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), "sch-stage-")); fs.mkdirSync(path.join(r, ".sch-loop"), { recursive: true }); return r; };
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

const GOOD = {
  brainstorm: "# Brainstorm: habits\n\n## Outcome\nA person sees a streak.\n\n## Who it is for\nSomeone building a daily habit alone.\n\n## Locked decisions\n- D-01 — one JSON file. Why: zero dependencies.\n\n## Open questions\nWhere does the file live?\n" + "x".repeat(600),
  prd: "# PRD: habits\n\n## Problem\nPeople lose streaks.\n\n## Requirements\n- TRACK-01 the tool records a habit as done today\n- TRACK-02 the tool reports a streak\n" + "x".repeat(600),
  architecture: "# Architecture: habits\n\n## System diagram\n\n```mermaid\nflowchart LR\n  CLI --> Store\n```\n\n## Responsibilities\n- store.mjs owns the file\n" + "x".repeat(600),
  plan: "# Plan: habits\n\n## Phase 1 — Recording\n\nA person can record a habit and the record survives a restart.\n\nSlices:\n- record\n  - covers: TRACK-01\n" + "x".repeat(400),
};
const seatSaying = text => ({ role: "reviewer", call: async () => ({ text }) });
const ask = (s, a) => s.call(a);
const run = (root, stage, over = {}) => runStage({ projectRoot: root, engineRoot: ENGINE, stage, seat: {}, ask, ...over });

test("stage order is brainstorm, prd, architecture, plan and nextStage walks it", () => {
  assert.deepEqual(STAGES.map(s => s.id), ["brainstorm", "prd", "architecture", "plan"]);
  const root = proj();
  assert.equal(nextStage(root).id, "brainstorm");
  put(root, ".sch-loop/BRAINSTORM.md", GOOD.brainstorm);
  assert.equal(nextStage(root).id, "prd");
  put(root, ".sch-loop/PRD.md", GOOD.prd);
  assert.equal(nextStage(root).id, "architecture");
  put(root, ".sch-loop/ARCHITECTURE.md", GOOD.architecture);
  assert.equal(nextStage(root).id, "plan");
  put(root, ".sch-loop/PLAN.md", GOOD.plan);
  assert.equal(nextStage(root), null, "and then the front half is done");
});

test("a stage cannot run before the stage it reads from", async () => {
  const root = proj();
  await assert.rejects(run(root, stageById("prd"), { ask: async () => { throw new Error("must not be asked"); } }),
    /needs \.sch-loop\/BRAINSTORM\.md first/);
});

test("a hollow artifact is refused and kept for the next attempt, not accepted", async () => {
  const root = proj();
  setGoal(root, "build a thing");
  await assert.rejects(run(root, stageById("brainstorm"), { ask: async () => ({ text: "# Brainstorm\n\nlooks fine to me\n" }) }),
    /came back hollow/);
  assert.equal(fs.existsSync(path.join(root, ".sch-loop/BRAINSTORM.md")), false, "the real artifact is not written");
  assert.match(fs.readFileSync(path.join(root, ".sch-loop/BRAINSTORM.md.rejected"), "utf8"), /looks fine to me/);
});

test("each stage names what its own artifact must contain", () => {
  const root = proj();
  const why = (id, text) => { put(root, stageById(id).artifact, text); return stageStatus(root, stageById(id)).why; };
  assert.match(why("prd", "# PRD\n\n## Problem\nx\n" + "y".repeat(700)), /no requirement IDs/);
  assert.match(why("architecture", "# A\n\n## Responsibilities\nx\n" + "y".repeat(700)), /no mermaid diagram/);
  assert.match(why("plan", "# P\n\nno phases here\n" + "y".repeat(500)), /no `## Phase N` headings/);
});

test("a good document is written, the lifecycle advances, and the next stage is named", async () => {
  const root = proj();
  const r = await run(root, stageById("brainstorm"), { seat: seatSaying(GOOD.brainstorm), goalText: "build a habit tracker" });
  assert.equal(r.ok, true);
  assert.equal(r.next, "prd");
  assert.match(fs.readFileSync(path.join(root, ".sch-loop/BRAINSTORM.md"), "utf8"), /Locked decisions/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".sch-loop/state.json"), "utf8")).lifecycle_stage, "PRD");
  assert.match(fs.readFileSync(path.join(root, GOAL_FILE), "utf8"), /habit tracker/, "the goal is kept for the later stages");
});

test("brainstorm refuses to start without a goal, because it has no other input", async () => {
  const root = proj();
  await assert.rejects(run(root, stageById("brainstorm"), { ask: async () => { throw new Error("must not be asked"); } }), /needs a goal/);
});

test("a completed stage is skipped unless forced", async () => {
  const root = proj();
  put(root, ".sch-loop/BRAINSTORM.md", GOOD.brainstorm);
  const skipped = await run(root, stageById("brainstorm"), { ask: async () => { throw new Error("must not be asked"); } });
  assert.equal(skipped.skipped, true);
  const forced = await run(root, stageById("brainstorm"), { seat: seatSaying(GOOD.brainstorm), force: true, goalText: "g" });
  assert.equal(forced.ok, true);
});

test("the prompt carries the skill's own prose and the upstream artifacts", () => {
  const root = proj();
  put(root, ".sch-loop/BRAINSTORM.md", GOOD.brainstorm);
  const stage = stageById("prd");
  const p = stagePrompt({
    stage, instructions: skillBody(skillsRoots({ engineRoot: ENGINE, projectRoot: root }), stage.skill), goalText: "a habit tracker",
    inputs: [{ rel: ".sch-loop/BRAINSTORM.md", text: GOOD.brainstorm }], projectRoot: root,
  });
  assert.match(p, /--- SKILL: sch-prd ---/);
  assert.match(p, /CAT-NN/, "the skill's own template travels with it");
  assert.match(p, /D-01 — one JSON file/, "and so does the upstream document");
  assert.match(p, /a habit tracker/);
  assert.match(p, /You cannot write files/, "the seat is told the engine writes the artifact");
});

test("a whole-document code fence is stripped, an inner one is left alone", () => {
  assert.equal(cleanDocument("```markdown\n# Title\n\ntext\n```"), "# Title\n\ntext");
  assert.equal(cleanDocument("```\n# Title\n```"), "# Title");
  const withInner = "# Title\n\n```mermaid\nflowchart LR\n```\n\nmore";
  assert.equal(cleanDocument(withInner), withInner, "a diagram inside the document survives");
});

test("an empty answer is a failure, not an empty artifact", async () => {
  const root = proj();
  setGoal(root, "g");
  await assert.rejects(run(root, stageById("brainstorm"), { ask: async () => ({ text: "   " }) }), /produced nothing/);
  assert.equal(fs.existsSync(path.join(root, ".sch-loop/BRAINSTORM.md")), false);
});

test("a seat that throws reports which stage failed", async () => {
  const root = proj();
  setGoal(root, "g");
  await assert.rejects(run(root, stageById("brainstorm"), { ask: async () => { throw new Error("rate limited"); } }), /brainstorm seat failed: rate limited/);
});

test("lifecycle_stage lands on TICKETS once every stage is complete", () => {
  const root = proj();
  for (const s of STAGES) put(root, s.artifact, GOOD[s.id]);
  assert.equal(advanceLifecycle(root, "plan"), "TICKETS");
  assert.ok(stageReport(root).every(s => s.complete));
});

test("every stage points at a skill that exists and reads a real upstream artifact", () => {
  const artifacts = new Set(STAGES.map(s => s.artifact));
  for (const s of STAGES) {
    assert.ok(fs.existsSync(path.join(ENGINE, "skills", s.skill, "SKILL.md")), `${s.skill} is missing`);
    // The chain broke because a skill wrote one path and the next read another. Every `reads` entry must
    // be an artifact some earlier stage actually produces.
    for (const rel of s.reads) assert.ok(artifacts.has(rel), `${s.id} reads ${rel}, which no stage writes`);
    const body = skillBody(skillsRoots({ engineRoot: ENGINE }), s.skill);
    assert.ok(body.includes(s.artifact), `${s.skill} never mentions ${s.artifact}, the file the engine will write from it`);
  }
});

// The seam between the plan and the queue. A requirement that falls out here is invisible everywhere
// else, so a rejected ticket must be named rather than dropped.
const PLANNED = [
  { phase: "1", phaseName: "Recording", type: "build", title: "Record a habit as done", size: "S",
    action: "Add done <habit>.", acceptance: ["done marks today"], allowed_paths: ["src/**"],
    verify: [{ name: "test", command: "npm", args: ["test"] }] },
  { phase: "1", type: "docs", title: "Document the commands", size: "XS",
    action: "Write the README usage section.", acceptance: ["README lists every command"] },
];

test("plan-to-tickets writes every valid ticket and names the ones it refuses", async () => {
  const root = proj();
  put(root, ".sch-loop/PLAN.md", GOOD.plan);
  const bad = { phase: "1", type: "build", title: "No acceptance", size: "S", action: "x" };
  const seen = [];
  const r = await runTicketsStage({
    projectRoot: root, engineRoot: ENGINE, seat: {},
    ask: async () => ({ text: JSON.stringify([...PLANNED, bad]) }),
    write: (_root, t) => { if (!t.acceptance?.length) throw new Error("acceptance required"); seen.push(t.title); return { ...t, id: `T1.${seen.length}` }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.written, ["T1.1", "T1.2"]);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].title, "No acceptance");
  assert.match(r.rejected[0].error, /acceptance required/);
});

test("plan-to-tickets refuses to run before the plan is ready", async () => {
  const root = proj();
  await assert.rejects(runTicketsStage({ projectRoot: root, engineRoot: ENGINE, seat: {}, ask: async () => { throw new Error("must not be asked"); } }),
    /no \.sch-loop\/PLAN\.md/);
  put(root, ".sch-loop/PLAN.md", "# Plan\n\nno phases\n");
  await assert.rejects(runTicketsStage({ projectRoot: root, engineRoot: ENGINE, seat: {}, ask: async () => { throw new Error("must not be asked"); } }),
    /the plan is not ready/);
});

test("a queue that already has tickets is not silently appended to", async () => {
  const root = proj();
  put(root, ".sch-loop/PLAN.md", GOOD.plan);
  put(root, "task.md", "# task.md\n\n## Phase 1 — Mine   (0/1 done)\n- [ ] T1.1-mine  build  Mine  deps:-  size:S\n");
  const r = await runTicketsStage({ projectRoot: root, engineRoot: ENGINE, seat: {}, ask: async () => { throw new Error("must not be asked"); } });
  assert.equal(r.skipped, true);
  assert.match(r.why, /already holds 1 ticket/);
});

test("every proposal being invalid is a failure, not an empty queue", async () => {
  const root = proj();
  put(root, ".sch-loop/PLAN.md", GOOD.plan);
  await assert.rejects(runTicketsStage({
    projectRoot: root, engineRoot: ENGINE, seat: {},
    ask: async () => ({ text: JSON.stringify(PLANNED) }),
    write: () => { throw new Error("nope"); },
  }), /every proposed ticket was invalid/);
});

test("the ticket list is parsed out of prose, a fence, or a bare array", () => {
  const arr = [{ title: "a" }];
  assert.deepEqual(parseTickets(JSON.stringify(arr)), arr);
  assert.deepEqual(parseTickets("```json\n" + JSON.stringify(arr) + "\n```"), arr);
  assert.deepEqual(parseTickets("Here you go:\n" + JSON.stringify(arr) + "\nhope that helps"), arr);
  assert.throws(() => parseTickets("no array here"), /did not return a JSON array/);
  assert.throws(() => parseTickets("[]"), /empty ticket list/);
});
