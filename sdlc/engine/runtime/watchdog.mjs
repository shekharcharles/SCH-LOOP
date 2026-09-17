// The dispatch loop. Code owns it, not a model (design §3.14). Reads task.md top to bottom, runs the
// first ticket whose deps are done, watches the outcome, and applies the recovery ladder:
//
//   tier 1  crash / timeout / loop      → attempt++ and respawn fresh (buildTicket's own retry)
//   tier 2  rate limit / overloaded     → backoff 1→2→4→8 min, attempt unchanged
//   tier 3  attempts exhausted          → [!], council when gated, re-dispatch once with its verdict
//   tier 4  council inconclusive / gate → [?], notify, move to the next unblocked ticket
//
// Tiers 3 and 4 live in escalate.mjs; everything above them is here or inside buildTicket.
//
// The orchestrator terminal is nudged, never polled: it can be closed and the run continues.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { loadRoles } from "./roles.mjs";
import { parse, next } from "./taskmd.mjs";
import { buildTicket } from "./build.mjs";
import { appendEvent, readReport } from "./report.mjs";
import { notify } from "./notify.mjs";
import { RATE_LIMIT_RE } from "./spawn.mjs";
import { escalate } from "./escalate.mjs";

export const HEARTBEAT_MS = 30_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function heartbeatPath(projectRoot) { return path.join(projectRoot, ".sch-loop", "heartbeat"); }

export function writeHeartbeat(projectRoot, extra = {}) {
  const f = heartbeatPath(projectRoot);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...extra }, null, 2) + "\n");
}

// A heartbeat older than 3 beats means the watchdog is gone, whatever the file claims.
export function heartbeatStatus(projectRoot, now = Date.now()) {
  const f = heartbeatPath(projectRoot);
  if (!fs.existsSync(f)) return { alive: false, reason: "no heartbeat file" };
  try {
    const h = JSON.parse(fs.readFileSync(f, "utf8"));
    const age = now - Date.parse(h.at);
    return { alive: age < HEARTBEAT_MS * 3, ageMs: age, pid: h.pid, ticket: h.ticket || null, reason: age < HEARTBEAT_MS * 3 ? "fresh" : `stale by ${Math.round(age / 1000)}s` };
  } catch (e) { return { alive: false, reason: `unreadable heartbeat: ${e.message}` }; }
}

// Was this failure the provider refusing service rather than the work being wrong?
export function isRateLimited(report) {
  const hay = [report?.summary, ...(report?.what_did_not_work || [])].filter(Boolean).join(" ");
  return RATE_LIMIT_RE.test(hay);
}

export function backoffMs(config, strike) {
  const ladder = config.rate_limit_backoff_minutes || [1, 2, 4, 8];
  return ladder[Math.min(strike, ladder.length - 1)] * 60_000;
}

export function readTask(projectRoot) {
  return parse(fs.readFileSync(path.join(projectRoot, "task.md"), "utf8"));
}

// One pass: pick a ticket, run it, classify. Returns null when there is nothing dispatchable.
export async function step({ projectRoot, roles, config, build = buildTicket, escalateFn = escalate, strikes = { n: 0 }, onEvent }) {
  const doc = readTask(projectRoot);
  const t = next(doc);
  if (!t) return null;

  writeHeartbeat(projectRoot, { ticket: t.id, state: "dispatching" });
  appendEvent(projectRoot, { type: "watchdog.dispatch", id: t.id });
  let r;
  try {
    r = await build({ projectRoot, id: t.id, roles, config, onEvent });
  } catch (e) {
    // buildTicket throwing is a configuration fault (bad roles.json, unreadable ticket), not a ticket
    // failure: stopping is correct, because every subsequent ticket would hit the same wall.
    appendEvent(projectRoot, { type: "watchdog.fault", id: t.id, error: e.message });
    await notify(projectRoot, `SCH ✖ watchdog stopped on ${t.id}: ${e.message}`, { config, level: "error", ticket: t.id });
    return { id: t.id, decision: "FAULT", error: e.message, stop: true };
  }

  const report = readReport(projectRoot, t.id);
  if (r.decision === "PASS") { strikes.n = 0; return { id: t.id, decision: "PASS", report }; }

  if (isRateLimited(report)) {
    const ms = backoffMs(config, strikes.n++);
    appendEvent(projectRoot, { type: "watchdog.backoff", id: t.id, ms, strike: strikes.n });
    return { id: t.id, decision: "BACKOFF", waitMs: ms, report };
  }
  strikes.n = 0;
  // Tier 3: the ticket is out of attempts and buildTicket has already marked it `[!]`. A refusal is not
  // a failed attempt — the fences stopped the run before a model ever saw the work — so no council is
  // convened for one; there is nothing for it to advise about except the operator's own configuration.
  if (r.decision === "HUMAN" && !r.refused) {
    // An escalation that throws must not take the run with it. The ticket is already `[!]` and already
    // the human's problem; losing every remaining ticket on top of that is the worse outcome.
    try {
      const e = await escalateFn({ projectRoot, id: t.id, report, roles, config });
      if (e.decision === "COUNCIL_REDISPATCH") return { id: t.id, decision: "COUNCIL", councilId: e.councilId, report };
      return { id: t.id, decision: "HUMAN", report, why: e.why };
    } catch (e) {
      appendEvent(projectRoot, { type: "watchdog.escalation_failed", id: t.id, error: e.message });
      return { id: t.id, decision: "HUMAN", report, why: `escalation failed: ${e.message}` };
    }
  }
  return { id: t.id, decision: r.decision, report, refused: r.refused };
}

// Runs until nothing is dispatchable, a fault stops it, or `maxTickets` is reached.
export async function run({ projectRoot, maxTickets = Infinity, build, escalateFn, onEvent, sleepFn = sleep }) {
  const config = loadConfig(projectRoot);
  const roles = loadRoles(projectRoot);
  const strikes = { n: 0 };
  const results = [];
  const beat = setInterval(() => writeHeartbeat(projectRoot, { state: "running" }), HEARTBEAT_MS);
  beat.unref?.();
  try {
    while (results.length < maxTickets) {
      const r = await step({ projectRoot, roles, config, build, ...(escalateFn ? { escalateFn } : {}), strikes, onEvent });
      if (!r) break;
      if (r.decision === "BACKOFF") { await sleepFn(r.waitMs); continue; }   // same ticket, no attempt spent
      // A COUNCIL result means the verdict put the ticket back in the queue, so the next pass picks up
      // the same id. It is recorded and it counts as a dispatch: a run that silently re-ran a red until
      // it went green would look exactly like a run that never failed.
      results.push(r);
      if (r.stop) break;
    }
  } finally {
    clearInterval(beat);
    writeHeartbeat(projectRoot, { state: "stopped" });
  }
  const blocked = results.filter(r => r.decision === "HUMAN").map(r => r.id);
  if (blocked.length) await notify(projectRoot, `SCH — run paused: ${blocked.length} ticket(s) need you: ${blocked.join(", ")}`, { config, level: "warn" });
  return { results, blocked, done: results.filter(r => r.decision === "PASS").map(r => r.id) };
}
