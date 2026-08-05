#!/usr/bin/env node
// A FAKE Claude CLI that picks its behaviour from the task it was started for.
//
// The scheduler starts one fresh worker PER TASK and per attempt, so a queue
// test needs different behaviour for task 1 and task 2 without either process
// knowing the other exists. This dispatcher reads SCH_TASK_ID (which the
// executor sets for every worker) and, optionally, SCH_RUN_ID's attempt, then
// delegates to the ordinary fake worker with the matching behaviour file.
//
//   node fake-claude-dispatch.mjs <behaviour-dir> [...ignored]
//
// Behaviour files, most specific first:
//   <dir>/task-<id>-attempt-<n>.json   this task, this attempt
//   <dir>/task-<id>.json               this task, any attempt
//   <dir>/default.json                 anything else
//
// It also APPENDS one line per invocation to <dir>/invocations.log, which is how
// a test proves "a fresh process per task" rather than assuming it.

import { existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2];
const taskId = process.env.SCH_TASK_ID ?? "unknown";
const attempt = process.env.SCH_ATTEMPT ?? "1";

// Which SEMANTIC phase this worker is. A scout, a planner and a builder are
// three different processes with three different jobs, so a test must be able to
// give each of them its own behaviour — otherwise a single "write this file"
// fixture makes the planner write too, and the planner is read-only.
const semantic = process.env.SCH_SEMANTIC || process.env.SCH_PHASE || "";

const append = (file, rec) => {
  try { appendFileSync(join(dir, file), JSON.stringify(rec) + String.fromCharCode(10)); }
  catch { /* the log is evidence, not a dependency */ }
};

append("invocations.log", { pid: process.pid, task_id: taskId, attempt, semantic,
  run_id: process.env.SCH_RUN_ID ?? null, at: new Date().toISOString() });

// Wall-clock START and END, in their OWN file so the invocation log keeps
// meaning exactly one line per worker. Two workers overlapping is the only
// direct proof the queue ran them at the same time; a start-only record cannot
// show it. Paired by pid, which is unique per worker process.
append("spans.log", { pid: process.pid, task_id: taskId, start: Date.now() });
process.on("exit", () => append("spans.log", { pid: process.pid, task_id: taskId, end: Date.now() }));

const candidates = [
  join(dir, `task-${taskId}-${semantic}.json`),
  join(dir, `task-${taskId}-attempt-${attempt}.json`),
  join(dir, `task-${taskId}.json`),
  join(dir, `${semantic}.json`),
  join(dir, "default.json"),
];
const behaviour = candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1];

// Hand over to the ordinary fake worker, in THIS process, so stdin (the prompt)
// and stdout (the handoff) flow through untouched.
process.argv = [process.argv[0], join(dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs"), behaviour];
await import("./fake-claude.mjs");
