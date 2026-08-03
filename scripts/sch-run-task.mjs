#!/usr/bin/env node
// SCH Loop — run ONE explicitly selected, pre-approved task in a fresh external
// Claude process, then stop. EXPERIMENTAL: this is the supervised runner, not
// the autonomous loop. It executes one task, one attempt, and never retries,
// never picks another task, and never stages, commits or pushes anything in the
// managed project.
//
//   node scripts/sch-run-task.mjs --project <id> --task <n>
//   node scripts/sch-run-task.mjs --project <id> --task <n> --preflight-only
//
// Environment:
//   SCH_CLAUDE_EXECUTABLE  path to the claude CLI (default: "claude" on PATH)
//   SCH_CLAUDE_ARGS        arguments for it     (default: "-p")
//   SCH_WORKER_TIMEOUT_MS  worker timeout       (default: 20 min)
//   SCH_VERIFY_TIMEOUT_MS  per verification cmd (default: 10 min)
//   SCH_PROMPT_MAX_CHARS   prompt-size limit    (default: 60000 characters)
//   SCH_MAX_OUTPUT_BYTES   stdout/stderr cap    (default: 1 MiB per stream)
//   SCH_SKILL_EXCERPT_CHARS per-skill excerpt   (default: 3000 characters)

import { runTask, preflight } from "./runner.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf("--" + name); return i === -1 ? undefined : argv[i + 1]; };
const has = (name) => argv.includes("--" + name);
const die = (m) => { console.error("error: " + m); process.exit(2); };

const projectId = flag("project") ?? die("need --project <id> — this runner never guesses which project");
const taskRaw = flag("task") ?? die("need --task <n> — this runner never selects a task");
const taskId = Number(taskRaw);
if (!Number.isInteger(taskId) || taskId <= 0) die(`--task "${taskRaw}" is not a task id`);

if (has("preflight-only")) {
  const pre = preflight({ projectId, taskId });
  const prep = pre.preparePromise ? await pre.preparePromise : { ok: true, problems: [] };
  const failures = [...pre.failures, ...(prep.ok ? [] : prep.problems)];
  console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
  process.exit(failures.length ? 1 : 0);
}

const record = await runTask({ projectId, taskId });
console.log(JSON.stringify({
  run_id: record.run_id, project_id: record.project_id, task_id: record.task_id,
  outcome: record.outcome, failure: record.failure, duration_ms: record.duration_ms,
  run_dir: record.run_dir,
  note: "the task status is unchanged and nothing was staged, committed or pushed — that is the next milestone",
}, null, 2));

// 0 = VERIFIED. Anything else is a distinct exit code so a supervisor can tell
// "needs a person" from "the code is wrong" without parsing the JSON.
process.exit({ VERIFIED: 0, RETRYABLE: 3, NEEDS_DECISION: 4, CANCELLED: 5 }[record.outcome] ?? 1);
