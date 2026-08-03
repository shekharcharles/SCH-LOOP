#!/usr/bin/env node
// SCH Loop — deliver ONE previously VERIFIED run to its remote, then stop.
//
// Stages exactly the verified paths, creates one commit, fetches, inspects
// divergence, pushes without force, verifies the commit on the remote
// independently, and marks the task delivered. It runs no worker, selects no
// task, retries nothing, and never merges, rebases, amends, resets or forces.
//
//   node scripts/sch-deliver-run.mjs --project <id> --run <RUN-id>
//   node scripts/sch-deliver-run.mjs --project <id> --run <RUN-id> --dry-run
//   node scripts/sch-deliver-run.mjs --project <id> --run <RUN-id> --message "fix(api): ..."
//
// Approval is REQUIRED by default, before the commit and again before the push:
//   node scripts/state.mjs delivery-approve --project <id> --run <RUN-id> --approver <you>

import { deliverRun, readDelivery } from "./delivery.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf("--" + name); return i === -1 ? undefined : argv[i + 1]; };
const has = (name) => argv.includes("--" + name);
const die = (m) => { console.error("error: " + m); process.exit(2); };

const projectId = flag("project") ?? die("need --project <id> — this controller never guesses which project");
const runId = flag("run") ?? die("need --run <RUN-id> — this controller never selects a run");
if (!/^RUN-/.test(runId)) die(`--run "${runId}" is not a run id`);

// A dry run reports where the delivery stands without touching the repository.
if (has("dry-run")) {
  const d = readDelivery(projectId, runId);
  console.log(JSON.stringify(d.ok
    ? { state: d.transaction.state, approval: d.approval_status, commit_message: d.transaction.commit_message,
        paths: d.transaction.verified_paths, commit: d.transaction.commit?.hash ?? null, failure: d.transaction.failure }
    : d, null, 2));
  process.exit(d.ok ? 0 : 1);
}

const r = deliverRun({ projectId, runId, commitMessageOverride: flag("message") ?? null });

console.log(JSON.stringify({
  delivery_id: r.delivery_id, run_id: runId, project_id: projectId,
  state: r.state, failure: r.failure ?? null,
  commit: r.commit ?? null, branch: r.branch ?? null,
  remote: r.remote ?? null, remote_ref: r.remote_ref ?? null,
  pushed_range: r.pushed_range ?? null,
  delivery_dir: r.delivery_dir ?? null,
  note: r.state === "DELIVERED"
    ? "committed, pushed and verified on the remote; the task is marked delivered"
    : "nothing was force-pushed, amended, reset or rewritten — inspect the delivery directory",
}, null, 2));

// 0 = DELIVERED. Distinct codes so a supervisor can tell "a person must look at
// this" from "the code is wrong" without parsing the JSON.
process.exit({ DELIVERED: 0, NEEDS_DECISION: 4, CANCELLED: 5 }[r.state] ?? 1);
