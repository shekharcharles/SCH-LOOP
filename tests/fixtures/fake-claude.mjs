#!/usr/bin/env node
// A FAKE Claude CLI. Every runner test drives this instead of the real thing:
// no model is ever invoked, no network is used, no credential is needed.
//
//   node fake-claude.mjs <behaviour.json> [...ignored args]
//
// It reads the prompt from stdin (proving the prompt is never an argument),
// then does exactly what the behaviour file says: touch files, run git, print a
// handoff, stall, or misbehave. Anything the real worker could do wrong, this
// can do on purpose.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, renameSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";

const behaviourPath = process.argv[2];
const b = behaviourPath && existsSync(behaviourPath) ? JSON.parse(readFileSync(behaviourPath, "utf8")) : {};
const cwd = process.cwd();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const abs = (p) => join(cwd, p);

// Read the prompt from stdin so the test can assert it arrived, and so nothing
// in this file depends on the prompt being visible in the process list.
let prompt = "";
try { prompt = readFileSync(0, "utf8"); } catch { /* no stdin */ }
if (b.promptTo) writeFileSync(b.promptTo, prompt);

// The environment this worker actually received — the evidence for "unrelated
// secrets never reach the worker".
if (b.envTo) writeFileSync(b.envTo, JSON.stringify(process.env, null, 2));

// Ask to be cancelled: exactly what an operator pressing cancel looks like from
// the worker's side. The runner polls for this file.
if (b.selfCancel) {
  const d = join(cwd, ".sch-loop", "runs", process.env.SCH_RUN_ID ?? "unknown");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "CANCEL"), JSON.stringify({ reason: "test cancellation", at: new Date().toISOString() }));
}

// A descendant that outlives its parent unless the process TREE is killed.
if (b.spawnChild) {
  const target = abs(b.spawnChild.path).replace(/\\/g, "\\\\");
  const child = spawn(process.execPath, ["-e",
    `setTimeout(()=>require("fs").writeFileSync("${target}","grandchild survived"), ${b.spawnChild.afterMs})`],
    { stdio: "ignore" });
  child.unref?.();
}

for (const w of b.write ?? []) {
  const p = abs(w.path);
  mkdirSync(dirname(p), { recursive: true });
  w.append ? appendFileSync(p, w.content ?? "") : writeFileSync(p, w.content ?? "");
}
for (const p of b.delete ?? []) { try { rmSync(abs(p), { force: true, recursive: true }); } catch {} }
for (const r of b.rename ?? []) { try { renameSync(abs(r.from), abs(r.to)); } catch {} }
for (const args of b.git ?? []) {
  try { execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" }); } catch { /* the runner catches the effect, not the exit code */ }
}

if (b.stdoutBytes) process.stdout.write("x".repeat(b.stdoutBytes) + "\n");
if (b.stderrBytes) process.stderr.write("e".repeat(b.stderrBytes) + "\n");
if (b.stderr) process.stderr.write(b.stderr + "\n");
if (b.sleepMs) sleep(b.sleepMs);

// The handoff. `raw` writes whatever the test wants (missing, duplicated,
// malformed); otherwise a well-formed block filled from the run's own identity.
if (b.raw !== undefined) {
  process.stdout.write(b.raw + "\n");
} else if (b.handoff !== false) {
  const h = {
    schema_version: 1,
    run_id: process.env.SCH_RUN_ID, project_id: process.env.SCH_PROJECT_ID, task_id: process.env.SCH_TASK_ID,
    worker_status: "COMPLETED", summary: "did the task",
    files_reported_changed: (b.write ?? []).map((w) => w.path),
    commands_reported: [], tests_reported: [], decisions: [], issues: [], candidate_lessons: [],
    recommended_next_action: "run deterministic verification",
    ...(b.handoff ?? {}),
  };
  process.stdout.write("some narrative before the block\n");
  process.stdout.write("<<<SCH_HANDOFF_JSON>>>\n" + JSON.stringify(h) + "\n<<<END_SCH_HANDOFF_JSON>>>\n");
}

process.exit(b.exit ?? 0);
