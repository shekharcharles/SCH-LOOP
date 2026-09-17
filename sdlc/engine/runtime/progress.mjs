// What has this project actually done, and what is happening right now.
//
// Everything below is read from durable state the loop already writes — events.jsonl, the reports, the
// queue, the stage artifacts. Nothing is recomputed or estimated. If a number is here, a run produced it.
//
// This exists because the loop was observable only by reading four files by hand. A person watching an
// autonomous process needs one place that answers "is it working, what did it change, and what did that
// cost", and needs it to be true rather than encouraging.
import fs from "node:fs";
import path from "node:path";
import { parse } from "./taskmd.mjs";
import { STAGES, stageStatus, goal } from "./stages.mjs";
import { unread } from "./notify.mjs";

const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), "utf8"); } catch { return null; } };
const readJson = (root, rel) => { try { return JSON.parse(read(root, rel)); } catch { return null; } };

export function events(projectRoot, { limit = Infinity } = {}) {
  const text = read(projectRoot, ".sch-loop/events.jsonl") || "";
  const rows = text.split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  return limit === Infinity ? rows : rows.slice(-limit);
}

export function ticketReports(projectRoot) {
  const dir = path.join(projectRoot, ".sch-loop", "reports");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".json")).flatMap(f => {
    try { return [JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))]; } catch { return []; }
  });
}

// A run is "live" when the heartbeat is fresh. The loop can be closed and reopened, so the file alone
// proves nothing — its age does.
export function live(projectRoot, now = Date.now()) {
  const h = readJson(projectRoot, ".sch-loop/heartbeat");
  if (!h?.at) return { running: false };
  const ageMs = now - Date.parse(h.at);
  return { running: ageMs < 90_000 && h.state !== "stopped", ageMs, state: h.state || null, ticket: h.ticket || null, pid: h.pid };
}

// Every ticket's life, reconstructed from the event stream: when it was picked up, when it finished,
// how long that took, and how it ended. The reports say what changed; only the events say when.
export function timeline(projectRoot) {
  const byId = new Map();
  for (const e of events(projectRoot)) {
    if (!e.id) continue;
    const t = byId.get(e.id) || { id: e.id, startedAt: null, endedAt: null, ms: null, attempts: null, outcome: null, runs: 0 };
    if (e.type === "ticket.start") { t.startedAt = e.at; t.endedAt = null; t.outcome = "running"; t.runs += 1; }
    if (e.type === "ticket.done") { t.endedAt = e.at; t.ms = e.ms ?? null; t.attempts = e.attempts ?? null; t.outcome = "done"; }
    if (e.type === "ticket.blocked") { t.endedAt = e.at; t.ms = e.ms ?? null; t.attempts = e.attempts ?? null; t.outcome = "blocked"; }
    if (e.type === "ticket.needs_human") { t.endedAt = e.at; t.outcome = "needs_human"; t.why = e.why; }
    if (e.type === "ticket.council.start") t.council = true;
    byId.set(e.id, t);
  }
  return byId;
}

// How long the specification took, stage by stage. The tickets stage reports a count rather than a
// length, so it is carried separately instead of being rendered as a zero.
export function stageTimings(projectRoot) {
  const out = new Map();
  for (const e of events(projectRoot)) {
    if (e.type !== "stage.start" && e.type !== "stage.done") continue;
    const t = out.get(e.stage) || { stage: e.stage };
    if (e.type === "stage.start") t.startedAt = e.at;
    else { t.endedAt = e.at; t.ms = e.ms ?? null; t.chars = e.chars ?? null; t.written = e.written ?? null; }
    out.set(e.stage, t);
  }
  return out;
}

export function summary(projectRoot, now = Date.now()) {
  const doc = (() => { try { return parse(read(projectRoot, "task.md") || ""); } catch { return { phases: [], tickets: [] }; } })();
  const reports = ticketReports(projectRoot);
  const byId = new Map(reports.map(r => [r.id, r]));
  const ev = events(projectRoot);
  const tl = timeline(projectRoot);
  const st = stageTimings(projectRoot);

  const phases = doc.phases.map(p => {
    const tickets = p.tickets.map(t => {
      const r = byId.get(t.id), line = tl.get(t.id) || {};
      const runningMs = line.outcome === "running" && line.startedAt ? now - Date.parse(line.startedAt) : null;
      return {
        id: t.id, status: t.status, type: t.type, title: t.title,
        size: t.fields?.size || null, gate: t.fields?.gate || null,
        startedAt: line.startedAt || null, endedAt: line.endedAt || null,
        ms: line.ms ?? runningMs, running: line.outcome === "running",
        outcome: line.outcome || null, council: !!line.council, dispatches: line.runs || 0,
        attempts: r?.attempts ?? line.attempts ?? null,
        files: (r?.artifacts || []).length, review: r?.review?.verdict || null,
        judge: r?.judge?.verdict || null, cost: r?.cost_usd || null,
        tests: r?.tests?.passed ?? null, contextTokens: r?.context_tokens || null,
      };
    });
    const timed = tickets.filter(t => t.ms != null);
    const starts = tickets.map(t => t.startedAt).filter(Boolean).sort();
    const ends = tickets.map(t => t.endedAt).filter(Boolean).sort();
    return {
      id: p.id, name: p.name,
      done: tickets.filter(t => t.status === "x").length, total: tickets.length,
      // Build time is the sum of what the tickets took. Wall time is first pickup to last finish, which
      // is larger whenever a run was paused, interrupted or resumed the next day — and saying so is the
      // point: "this phase took 9 minutes of work spread over six hours" is the useful sentence.
      buildMs: timed.reduce((n, t) => n + t.ms, 0),
      wallMs: starts.length && ends.length ? Math.max(0, Date.parse(ends.at(-1)) - Date.parse(starts[0])) : null,
      startedAt: starts[0] || null, endedAt: tickets.every(t => t.status === "x") ? ends.at(-1) || null : null,
      cost: Number(tickets.reduce((n, t) => n + (t.cost || 0), 0).toFixed(2)),
      files: tickets.reduce((n, t) => n + t.files, 0),
      attempts: tickets.reduce((n, t) => n + (t.attempts || 0), 0),
      tickets,
    };
  });

  // Which ticket is being built right now. The event stream is the better source — it carries the start
  // time — but the heartbeat knows too, and it is the only one that knows during the gap between a
  // dispatch and the first event reaching disk. Preferring one and ignoring the other left the view
  // saying "RUNNING" with nothing beside it.
  const fromEvents = phases.flatMap(p => p.tickets.filter(t => t.running).map(t => ({ ...t, phase: p.id, phaseName: p.name })))[0] || null;
  const beat = live(projectRoot, now);
  const fromBeat = !fromEvents && beat.running && beat.ticket
    ? phases.flatMap(p => p.tickets.filter(t => t.id === beat.ticket).map(t => ({ ...t, phase: p.id, phaseName: p.name })))[0] || null
    : null;
  const current = fromEvents || fromBeat;
  const specMs = [...st.values()].reduce((n, x) => n + (x.ms || 0), 0);
  const buildMs = phases.reduce((n, p) => n + p.buildMs, 0);
  const firstEvent = ev[0]?.at || null, lastEvent = ev.at(-1)?.at || null;

  return {
    goal: goal(projectRoot),
    live: beat,
    current,
    stages: STAGES.map(s => {
      const t = st.get(s.id) || {};
      return { ...stageStatus(projectRoot, s), chars: (read(projectRoot, s.artifact) || "").length, ms: t.ms ?? null, endedAt: t.endedAt || null };
    }).concat(st.has("tickets") ? [{
      id: "tickets", complete: (st.get("tickets").written || 0) > 0, why: "", chars: null,
      written: st.get("tickets").written, ms: st.get("tickets").ms ?? null, endedAt: st.get("tickets").endedAt || null,
    }] : []),
    phases,
    totals: {
      tickets: doc.tickets.length,
      done: doc.tickets.filter(t => t.status === "x").length,
      blocked: doc.tickets.filter(t => t.status === "!").length,
      needsHuman: doc.tickets.filter(t => t.status === "?").length,
      attempts: reports.reduce((n, r) => n + (r.attempts || 0), 0),
      reviews: reports.filter(r => r.review?.verdict).length,
      councils: [...tl.values()].filter(t => t.council).length,
      filesTouched: new Set(reports.flatMap(r => r.artifacts || [])).size,
      costUsd: Number(reports.reduce((n, r) => n + (r.cost_usd || 0), 0).toFixed(2)),
      specMs, buildMs,
      wallMs: firstEvent && lastEvent ? Date.parse(lastEvent) - Date.parse(firstEvent) : null,
      peakContextTokens: Math.max(0, ...reports.map(r => r.context_tokens || 0)) || null,
      startedAt: firstEvent, lastActivityAt: lastEvent,
    },
    unreadNotifications: unread(projectRoot).length,
    recent: ev.slice(-12),
  };
}

const GLYPH = { " ": "·", "~": "▶", x: "✔", "!": "✖", "?": "?" };
const pad = (s, n) => String(s ?? "").padEnd(n);
const lpad = (s, n) => String(s ?? "").padStart(n);

// Durations read as durations: 45s, 9m, 1h04. Anything longer than an hour is why a wall-clock figure
// beside a build figure is worth printing at all.
export function dur(ms) {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
export const clock = at => (at ? new Date(at).toTimeString().slice(0, 5) : "—");

// One screen: what is being built right now, what each ticket cost in time and money, and how long each
// phase took. Every figure comes from the event stream or a delivery report.
export function render(s) {
  const L = [];
  const bar = (d, t) => { const n = t ? Math.round((d / t) * 24) : 0; return "█".repeat(n) + "░".repeat(24 - n); };
  const push = (...x) => L.push(...x);

  push("");
  const firstLine = (s.goal || "").replace(/^#\s*Goal\s*/i, "").trim().split(/\r?\n/).filter(Boolean)[0] || "";
  push(firstLine ? `  GOAL   ${firstLine.slice(0, 72)}` : "  GOAL   (not set)");
  push("");

  if (s.current) {
    push(`  ● BUILDING NOW`);
    push(`      phase    ${s.current.phase} — ${s.current.phaseName}`);
    push(`      ticket   ${s.current.id}  ${s.current.title.slice(0, 52)}`);
    push(`      since    ${clock(s.current.startedAt)}   running ${dur(s.current.ms)}${s.current.dispatches > 1 ? `   (dispatch ${s.current.dispatches})` : ""}`);
  } else if (s.live.running) {
    push(`  ● RUNNING   ${s.live.state || ""}  (pid ${s.live.pid})`);
  } else {
    push(`  ○ IDLE      last activity ${s.totals.lastActivityAt ? clock(s.totals.lastActivityAt) : "never"}`);
  }
  push("");

  push(`  SPECIFICATION${lpad(dur(s.totals.specMs), 52)}`);
  for (const x of s.stages) {
    const what = x.written != null ? `${x.written} tickets` : x.complete ? `${(x.chars || 0).toLocaleString()} chars` : x.why;
    push(`    ${x.complete ? "✔" : "·"}  ${pad(x.id, 15)}${pad(what, 26)}${lpad(dur(x.ms), 6)}   ${clock(x.endedAt)}`);
  }
  push("");

  push(`  BUILD   ${s.totals.done}/${s.totals.tickets} done  ${bar(s.totals.done, s.totals.tickets)}${lpad(dur(s.totals.buildMs), 8)}`);
  for (const p of s.phases) {
    push("");
    const wall = p.wallMs != null && p.wallMs > p.buildMs * 1.5 ? `   (${dur(p.wallMs)} wall)` : "";
    push(`    Phase ${p.id} — ${pad(p.name.slice(0, 44), 46)} ${p.done}/${p.total}  ${lpad(dur(p.buildMs), 6)}${wall}${p.cost ? `   $${p.cost.toFixed(2)}` : ""}`);
    for (const t of p.tickets) {
      const when = t.startedAt ? `${clock(t.startedAt)}→${t.endedAt ? clock(t.endedAt) : "…"}` : "";
      const bits = [];
      if (t.attempts) bits.push(`${t.attempts} att`);
      if (t.files) bits.push(`${t.files} file${t.files === 1 ? "" : "s"}`);
      if (t.review) bits.push(t.review);
      if (t.council) bits.push("council");
      if (t.cost) bits.push(`$${t.cost.toFixed(2)}`);
      if (!t.startedAt && t.gate) bits.push("waits for you");
      if (t.outcome === "needs_human" && t.why) bits.push(t.why.slice(0, 30));
      push(`      ${GLYPH[t.status] || "?"} ${pad(t.id, 7)}${pad(t.type, 9)}${pad(t.title.slice(0, 38), 40)}${pad(when, 13)}${lpad(dur(t.ms), 6)}  ${bits.join("  ")}`);
    }
  }
  push("");

  const t = s.totals;
  push("  TOTALS");
  push(`    specification  ${dur(t.specMs)}`);
  push(`    build          ${dur(t.buildMs)} of work across ${t.done} ticket(s), ${t.attempts} executor attempt(s)`);
  if (t.wallMs != null) push(`    wall clock     ${dur(t.wallMs)} since the first event`);
  push(`    changed        ${t.filesTouched} file(s)`);
  push(`    reviewed       ${t.reviews} independent review(s)${t.councils ? `, ${t.councils} council(s)` : ""}`);
  push(`    cost           $${t.costUsd.toFixed(2)}`);
  if (t.peakContextTokens) push(`    peak context   ${t.peakContextTokens.toLocaleString()} tokens`);
  if (t.blocked) push(`    blocked        ${t.blocked}`);
  if (t.needsHuman) push(`    needs you      ${t.needsHuman}`);
  if (s.unreadNotifications) push(`    unread         ${s.unreadNotifications} notification(s)`);
  push("");
  return L.join("\n");
}

// The event stream as sentences. The raw jsonl is the record; this is for a person watching it happen.
const SAY = {
  "stage.start": e => `started the ${e.stage} stage`,
  // The tickets stage reports what it WROTE, not how long the document was — rendering it as
  // "0 chars" made a stage that produced thirteen tickets look like it had produced nothing.
  "stage.done": e => e.stage === "tickets"
    ? `queued ${e.written} ticket(s)${e.rejected ? `, rejected ${e.rejected}` : ""} in ${dur(e.ms || 0)}`
    : `wrote ${e.artifact || e.stage} — ${(e.chars || 0).toLocaleString()} chars in ${dur(e.ms || 0)}`,
  "stage.rejected": e => `rejected the ${e.stage} draft: ${(e.failures || []).join("; ")}`,
  "stage.failed": e => `the ${e.stage} stage failed: ${e.error}`,
  "watchdog.dispatch": e => `picked ${e.id} off the queue`,
  "ticket.start": e => `${e.id} started — ${e.type_}, on branch ${e.branch}`,
  "ticket.review": e => `${e.id} review round ${e.round}: ${e.verdict}${e.blocking ? `, ${e.blocking} blocking` : ""}`,
  "ticket.done": e => `${e.id} DONE after ${e.attempts} attempt(s), ${dur(e.ms || 0)}`,
  "ticket.blocked": e => `${e.id} blocked after ${e.attempts} attempt(s)`,
  "ticket.needs_human": e => `${e.id} needs you — ${e.why}`,
  "ticket.council.start": e => `council convened on ${e.id} (${(e.seats || []).join(", ")}) — ${e.why}`,
  "ticket.council.verdict": e => `council returned a verdict on ${e.id} (${e.chars} chars)`,
  "ticket.council.failed": e => `council failed on ${e.id}: ${e.error}`,
  "ticket.merge_failed": e => `${e.id} could not merge: ${e.error}`,
  "ticket.bookkeeping_failed": e => `${e.id} delivered but its paperwork did not commit: ${e.error}`,
  "watchdog.backoff": e => `rate limited on ${e.id}, waiting ${dur(e.ms)} (strike ${e.strike})`,
  "watchdog.fault": e => `the run stopped on ${e.id}: ${e.error}`,
  "watchdog.escalation_failed": e => `escalation failed on ${e.id}: ${e.error}`,
  "phase.verified": e => `phase ${e.phase} verification: ${e.status} — ${e.why}`,
  "phase.shipped": e => `phase ${e.phase} ship: ${e.decision}${e.prUrl ? ` — ${e.prUrl}` : ""}`,
};

export function renderLog(rows) {
  return rows.map(e => {
    const t = new Date(e.at);
    const hh = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0") + ":" + String(t.getSeconds()).padStart(2, "0");
    const say = SAY[e.type];
    return `  ${hh}  ${say ? say(e) : e.type + " " + JSON.stringify(e).slice(0, 100)}`;
  }).join("\n");
}
