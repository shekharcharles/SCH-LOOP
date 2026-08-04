#!/usr/bin/env node
// SCH Loop — run a project's task queue SEQUENTIALLY through the graph
// scheduler, then stop at a defined terminal condition.
//
// One task at a time. Each task gets a fresh external worker process, is
// verified by SCH's own commands, is committed and pushed by the delivery
// controller, and becomes delivered only after that controller has proved the
// commit on the remote with its own fetch. Nothing here retries forever, nothing
// runs two tasks at once, and nothing continues past a pending human decision.
//
//   node scripts/sch-run-queue.mjs --project <id>
//   node scripts/sch-run-queue.mjs --project <id> --max-tasks 3
//   node scripts/sch-run-queue.mjs --project <id> --phase 2
//   node scripts/sch-run-queue.mjs --project <id> --stop-after-task 12
//   node scripts/sch-run-queue.mjs --project <id> --dry-run
//
// Environment (shared with the single-task runner):
//   SCH_CLAUDE_EXECUTABLE / SCH_CLAUDE_ARGS / SCH_WORKER_TIMEOUT_MS
//   SCH_VERIFY_TIMEOUT_MS / SCH_PROMPT_MAX_CHARS / SCH_MAX_OUTPUT_BYTES

import { runQueue } from "./scheduler.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf("--" + name); return i === -1 ? undefined : argv[i + 1]; };
const has = (name) => argv.includes("--" + name);
const die = (m) => { console.error("error: " + m); process.exit(2); };
const int = (name, v) => {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) die(`--${name} "${v}" is not a positive number`);
  return n;
};

const projectId = flag("project") ?? die("need --project <id> — the scheduler never guesses which project");

// A live progress line, so a queue that runs for an hour is not a silent hour.
// Bounded: one line per event, never worker output.
const verbose = !has("quiet");
const onEvent = verbose
  ? (e) => process.stderr.write(`[${e.timestamp.slice(11, 19)}] ${e.type}${e.task_id ? ` task#${e.task_id}` : ""}${e.phase_id ? ` ${e.phase_id}` : ""}${e.payload?.failure ? ` (${e.payload.failure})` : ""}\n`)
  : null;

const r = await runQueue({
  projectId,
  maxTasks: int("max-tasks", flag("max-tasks")),
  maxDurationMs: int("max-duration-ms", flag("max-duration-ms")),
  phase: flag("phase") === undefined ? null : Number(flag("phase")),
  stopAfterTask: flag("stop-after-task") === undefined ? null : Number(flag("stop-after-task")),
  dryRun: has("dry-run"),
  onEvent,
});

console.log(JSON.stringify({
  scheduler_id: r.scheduler_id, project_id: r.project_id, state: r.state,
  stop_reason: r.stop_reason, failure: r.failure ?? null,
  tasks_delivered: r.tasks_delivered, total_attempts: r.total_attempts,
  tasks: (r.tasks ?? []).map((t) => ({ task_id: t.task_id, state: t.state, attempts: t.attempts, commit: t.commit ?? null, failure: t.failure?.code ?? null })),
  duration_ms: r.duration_ms,
  note: r.stop_reason === "NEEDS_DECISION"
    ? "the queue stopped for a person: node scripts/state.mjs human-gate-list --project " + projectId
    : "nothing was force-pushed, amended, reset or rewritten",
}, null, 2));

// Distinct exit codes so a supervisor can tell "you are done" from "a person
// must look" from "it is broken" without parsing the JSON.
process.exit({
  PROJECT_COMPLETED: 0, PHASE_COMPLETED: 0, MAX_TASKS_REACHED: 0, STOP_AFTER_TASK: 0, DRY_RUN: 0,
  NO_READY_TASK: 6, MAX_DURATION_REACHED: 6,
  NEEDS_DECISION: 4, BLOCKED: 4, CONSECUTIVE_FAILURE_LIMIT: 4, PROJECT_BUDGET_EXCEEDED: 4,
  CANCELLED: 5, SCHEDULER_LEASE_LOST: 7,
}[r.stop_reason] ?? 1);
