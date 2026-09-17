// A council has to survive the machine it runs on. Three of the four seeded seats are different CLIs,
// and any of them can be uninstalled, logged out, or rate limited on the day a ticket goes red.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SCH_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), "sch-council-"));
const { startCouncil, MIN_SEATS } = await import("./council.mjs");

const answering = (role, text = `${role} says go`) => ({ role, call: async () => ({ text }) });
const dead = role => ({ role, call: async () => { throw new Error(`${role} is not logged in`); } });
// The chair reports which seats' proposals reached its synthesis prompt, so a test can tell a complete
// debate from one that quietly lost half its evidence on the way.
const SEATS = ["architect", "skeptic", "pragmatist", "critic"];
const chair = { role: "chair", call: async ({ prompt }) => ({ text: `VERDICT: proceed.\nSAW:${SEATS.filter(r => prompt.includes(`"${r}":`)).join(",")}` }) };

test("a council finishes when one seat of three cannot answer, and records who was absent", async () => {
  const s = await startCouncil({
    question: "Ticket T1.1 is red. What now?",
    seats: [answering("architect"), dead("skeptic"), answering("pragmatist")],
    chair,
  });
  assert.equal(s.status, "completed");
  assert.deepEqual(s.absentSeats, ["skeptic"]);
  assert.deepEqual(Object.keys(s.proposals).sort(), ["architect", "pragmatist"]);
  assert.ok(!("skeptic" in s.critiques), "an absent seat is not asked to critique");
  assert.match(s.verdict, /VERDICT: proceed/);
});

test("a council fails, loudly, when too few seats answer to be a council", async () => {
  await assert.rejects(
    startCouncil({ question: "q", seats: [answering("architect"), dead("skeptic")], chair }),
    e => {
      assert.match(e.message, new RegExp(`only 1 of 2 seats answered.*at least ${MIN_SEATS}`));
      return true;
    },
  );
});

test("a seat that dies after proposing costs its own critique, not the verdict", async () => {
  let calls = 0;
  const flaky = { role: "skeptic", call: async () => { if (++calls > 1) throw new Error("connection reset"); return { text: "skeptic proposes" }; } };
  const s = await startCouncil({ question: "q", seats: [answering("architect"), flaky, answering("pragmatist")], chair });
  assert.equal(s.status, "completed");
  assert.deepEqual(s.absentSeats, [], "it did propose, so it is not absent");
  assert.ok("skeptic" in s.proposals);
  assert.ok(!("skeptic" in s.critiques), "its later phases dropped out");
  assert.match(s.verdict, /SAW:architect,skeptic,pragmatist/, "the chair still sees all three proposals");
});

test("a dead challenger leaves a stated gap, not an empty string the chair reads as agreement", async () => {
  const s = await startCouncil({
    question: "q",
    seats: [answering("architect"), answering("pragmatist"), { role: "critic", call: async ({ prompt }) => { if (/Attack the emerging consensus/.test(prompt)) throw new Error("gone"); return { text: "critic proposes" }; } }],
    chair,
  });
  assert.equal(s.status, "completed");
  assert.match(s.challenge, /no adversarial challenge/);
});

test("a chair with no reachable transport is rejected before any seat is paid for", async () => {
  let asked = 0;
  const counted = role => ({ role, call: async () => { asked++; return { text: "x" }; } });
  await assert.rejects(
    startCouncil({ question: "q", seats: [counted("architect"), counted("skeptic")], chair: { role: "chair" } }),
    /chair must carry spawn argv, providerId, or call\(\)/,
  );
  assert.equal(asked, 0);
});
