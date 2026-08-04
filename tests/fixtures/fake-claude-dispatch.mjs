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

try {
  appendFileSync(join(dir, "invocations.log"),
    JSON.stringify({ pid: process.pid, task_id: taskId, attempt, run_id: process.env.SCH_RUN_ID ?? null, at: new Date().toISOString() }) + "\n");
} catch { /* the log is evidence, not a dependency */ }

const candidates = [
  join(dir, `task-${taskId}-attempt-${attempt}.json`),
  join(dir, `task-${taskId}.json`),
  join(dir, "default.json"),
];
const behaviour = candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1];

// Hand over to the ordinary fake worker, in THIS process, so stdin (the prompt)
// and stdout (the handoff) flow through untouched.
process.argv = [process.argv[0], join(dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs"), behaviour];
await import("./fake-claude.mjs");
