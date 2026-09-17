// Recovery ladder tiers 3 and 4 (design §3.14). Tiers 0-2 are already spent by the time anything here
// runs: the nudge and the fresh respawn live inside runSelfCorrectingTask, the rate-limit backoff lives
// in the watchdog. What is left is the case the ladder exists for — a ticket that burned every attempt
// and is now red.
//
//   tier 3  convene the council on the failure, then re-dispatch the ticket ONCE with its verdict
//   tier 4  no council, council failed, or the second red — [?], notify, move on
//
// The council is advice, not authority: it cannot mark a ticket done, it can only tell the next executor
// what the last three attempts got wrong. A ticket that fails again after a council goes to the human,
// because a second council on the same red is the loop arguing with itself at full token price.
import fs from "node:fs";
import path from "node:path";
import { setStatus } from "./taskmd.mjs";
import { loadTicket, saveTicket } from "./tickets.mjs";
import { appendEvent } from "./report.mjs";
import { councilSeats } from "./roles.mjs";
import { startCouncil } from "./council.mjs";
import { notify as notifySink } from "./notify.mjs";

export const MAX_COUNCIL_ROUNDS = 1;

function setTicketStatus(projectRoot, id, glyph) {
  const f = path.join(projectRoot, "task.md");
  fs.writeFileSync(f, setStatus(fs.readFileSync(f, "utf8"), id, glyph));
}

// Why this red does or does not deserve a council. Returned as a reason string either way so the event
// log says which gate closed — "council skipped" with no cause is the kind of silence that hides a
// misconfigured roles.json for weeks.
export function councilGate({ config = {}, roles, ticket }) {
  const mode = config.council_mode ?? "gated";
  if (mode === "off") return { ok: false, why: "council_mode is off" };
  const rounds = ticket.council_rounds || 0;
  if (rounds >= MAX_COUNCIL_ROUNDS) return { ok: false, why: `council already convened ${rounds}x on this ticket` };
  const seats = councilSeats(roles || { council: [] });
  const min = config.council_minimum_seats ?? 2;
  if (seats.length < min) return { ok: false, why: `only ${seats.length} council seat(s) enabled, minimum is ${min}` };
  if (mode === "always") return { ok: true, why: "council_mode is always", seats };
  return { ok: true, why: `attempts exhausted on ${ticket.id}`, seats };
}

export function failureQuestion(ticket, report) {
  const tried = (report?.what_did_not_work || []).map(x => `- ${x}`).join("\n") || "- (the report recorded no specific failure)";
  return [
    `Ticket ${ticket.id} — ${ticket.title} — has failed every executor attempt and is now blocked.`,
    "",
    `Type: ${ticket.type}   Size: ${ticket.size || "?"}`,
    `Action asked of the executor:\n${ticket.action}`,
    "",
    `Acceptance criteria:\n${(ticket.acceptance || []).map(a => `- ${a}`).join("\n") || "- (none recorded)"}`,
    "",
    `Manager summary: ${report?.summary || "(none)"}`,
    `What did not work:\n${tried}`,
    "",
    "Decide ONE of: (a) the ticket is achievable and the next executor needs specific corrected guidance —",
    "say exactly what to do differently; (b) the ticket is mis-specified and a human must rewrite it;",
    "(c) the ticket is blocked by something outside its allowed_paths and must be split.",
    "Answer with the choice, then the concrete instruction the next executor should be given.",
  ].join("\n");
}

// The chair is the reviewer seat by default: it is already configured, already read-only, and is the
// role whose whole job is judging work it did not produce.
export function pickChair(roles) {
  return roles?.chair || roles?.reviewer || null;
}

export async function escalate({ projectRoot, id, report, roles, config = {}, council = startCouncil, notify = null }) {
  const say = notify || ((text, level = "info") => notifySink(projectRoot, text, { config, level, ticket: id }));
  // A ticket line with no JSON behind it is a broken queue, not a reason to lose the escalation: the
  // stand-in is enough to close the gate and hand the id to the human, which is the right answer anyway.
  let ticket;
  try { ticket = loadTicket(projectRoot, id); }
  catch { ticket = { id, title: id, type: "build", action: "(ticket file missing)", acceptance: [] }; }
  const gate = councilGate({ config, roles, ticket });
  if (!gate.ok) return needsHuman({ projectRoot, ticket, why: gate.why, notify: say });

  const chair = pickChair(roles);
  if (!chair) return needsHuman({ projectRoot, ticket, why: "no chair seat configured", notify: say });

  appendEvent(projectRoot, { type: "ticket.council.start", id: ticket.id, seats: gate.seats.map(s => s.role), why: gate.why });
  let state;
  try {
    state = await council({
      question: failureQuestion(ticket, report),
      seats: gate.seats, chair,
      context: { ticket: ticket.id, type: ticket.type, allowed_paths: ticket.allowed_paths || [], attempts: report?.attempts ?? null },
    });
  } catch (e) {
    appendEvent(projectRoot, { type: "ticket.council.failed", id: ticket.id, error: e.message });
    return needsHuman({ projectRoot, ticket, why: `council failed: ${e.message}`, notify: say });
  }

  const verdict = String(state?.verdict || "").trim();
  if (!verdict) {
    appendEvent(projectRoot, { type: "ticket.council.failed", id: ticket.id, error: "empty verdict" });
    return needsHuman({ projectRoot, ticket, why: "council returned an empty verdict", notify: say });
  }

  // The verdict rides on the ticket, so the re-dispatched executor reads it as part of its brief rather
  // than as a file it has to be told to open.
  ticket.council_rounds = (ticket.council_rounds || 0) + 1;
  ticket.council_guidance = verdict;
  ticket.council_id = state.id;
  try { saveTicket(projectRoot, ticket); }
  catch (e) {
    // The verdict cannot ride on a ticket that will not persist, and re-queueing without it would send
    // the executor back in with nothing new. Stop instead.
    appendEvent(projectRoot, { type: "ticket.council.failed", id: ticket.id, error: `verdict could not be saved: ${e.message}` });
    return needsHuman({ projectRoot, ticket, why: `council verdict could not be saved to the ticket: ${e.message}`, notify: say });
  }

  const dir = path.join(projectRoot, ".sch-loop", "council");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ticket.id}-verdict.md`), `# Council verdict — ${ticket.id}\n\nCouncil: ${state.id}\n\n${verdict}\n`);

  setTicketStatus(projectRoot, ticket.id, " ");   // back in the queue, once, carrying the verdict
  appendEvent(projectRoot, { type: "ticket.council.verdict", id: ticket.id, councilId: state.id, chars: verdict.length });
  await say(`SCH ⚖ ${ticket.id} — council convened, re-dispatching with its verdict`, "info");
  return { decision: "COUNCIL_REDISPATCH", councilId: state.id, verdict, ticket: ticket.id };
}

function needsHuman({ projectRoot, ticket, why, notify }) {
  setTicketStatus(projectRoot, ticket.id, "?");
  appendEvent(projectRoot, { type: "ticket.needs_human", id: ticket.id, why });
  const r = notify(`SCH ✖ ${ticket.id} needs you — ${why}`, "warn");
  if (r && typeof r.catch === "function") r.catch(() => {});
  return { decision: "HUMAN", why, ticket: ticket.id };
}
