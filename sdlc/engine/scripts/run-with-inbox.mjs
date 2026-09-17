#!/usr/bin/env node
// SCH Loop — plan the inbox, then run the queue. One process, two phases, in
// the order an operator means when they press Start.
//
// Kept separate from the scheduler on purpose: the scheduler executes a graph
// and must not grow a second job. This is the thin sequencer above it, and it
// is honest about which half failed.
//
//   node scripts/run-with-inbox.mjs --project <id> [--max-tasks N] [--no-plan]

import { planInbox, newInboxItems } from "./inbox-planner.mjs";
import { runQueue } from "./scheduler.mjs";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf("--" + n); return i === -1 ? undefined : argv[i + 1]; };
const has = (n) => argv.includes("--" + n);
const project = flag("project") ?? argv[0];
if (!project) { console.error("error: need --project <id>"); process.exit(2); }
const maxTasks = Number(flag("max-tasks") ?? 50);
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (s) => process.stderr.write(`[${stamp()}] ${s}\n`);

let planning = { skipped: true };
if (!has("no-plan")) {
  const pending = newInboxItems(project);
  if (pending.length) {
    say(`inbox.planning ${pending.length} item(s)`);
    try {
      planning = await planInbox(project, { onEvent: (t, p) => say(`${t} ${JSON.stringify(p)}`) });
      if (planning.ok) {
        say(`inbox.planned created=${planning.planned} rejected=${(planning.rejected || []).length} unplannable=${(planning.unplannable || []).length}`);
        for (const r of planning.rejected || []) say(`  refused: ${r.title} — ${r.why.join("; ")}`);
        for (const u of planning.unplannable || []) say(`  unplannable #${u.inbox_id}: ${u.reason}`);
      } else {
        // A planning failure must not stop work that is already queued.
        say(`inbox.plan_failed ${planning.reason} — continuing with the existing queue`);
      }
    } catch (e) {
      planning = { ok: false, reason: String(e?.message || e) };
      say(`inbox.plan_error ${planning.reason} — continuing with the existing queue`);
    }
  } else {
    planning = { ok: true, planned: 0, items: 0, note: "inbox empty" };
  }
}

const result = await runQueue({
  projectId: project, maxTasks,
  onEvent: (e) => process.stderr.write(
    `[${e.timestamp.slice(11, 19)}] ${e.type}${e.task_id ? ` task#${e.task_id}` : ""}` +
    `${e.payload?.failure ? ` (${e.payload.failure})` : ""}\n`),
});

console.log(JSON.stringify({ inbox: planning, queue: result }, null, 2));
process.exit(result?.ok === false ? 1 : 0);
