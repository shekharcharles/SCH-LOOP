// Phase verification, goal-backward (design §3.6, skill sch-verify). Every ticket in the phase is `[x]`;
// that is task completion, not goal achievement. A ticket can complete by creating a file that renders
// nothing, so this asks what is TRUE in the codebase and works backwards from the phase goal.
//
// The split is deliberate: code gathers the evidence — which tickets, which files, which checks and what
// they actually returned — and a read-only seat judges it. The seat never gets to decide whether the test
// suite passed; it is handed the exit code. A phase whose checks are red cannot be verified by argument.
import fs from "node:fs";
import path from "node:path";
import { parse } from "./taskmd.mjs";
import { loadTicket } from "./tickets.mjs";
import { callSeat } from "./seats.mjs";
import { extractJson } from "./review.mjs";
import { appendEvent } from "./report.mjs";
import { runVerification } from "./verifier.mjs";
import { readReport } from "./report.mjs";

export const STATUSES = ["passed", "gaps_found", "human_needed"];

export function phaseTickets(projectRoot, phase) {
  const doc = parse(fs.readFileSync(path.join(projectRoot, "task.md"), "utf8"));
  const want = String(phase);
  return doc.tickets.filter(t => String(t.phase) === want).map(t => {
    let full = null;
    try { full = loadTicket(projectRoot, t.id); } catch { /* a line with no JSON is itself a finding */ }
    return { ...t, acceptance: full?.acceptance || [], action: full?.action || "", allowed_paths: full?.allowed_paths || [], missingTicketFile: !full };
  });
}

// The goal as an outcome, not a task list. PLAN.md owns it; the phase heading is the fallback, and a
// fallback goal is worth saying out loud, because "verified against the heading" is a weaker claim.
export function phaseGoal(projectRoot, phase) {
  const f = path.join(projectRoot, ".sch-loop", "PLAN.md");
  if (fs.existsSync(f)) {
    const text = fs.readFileSync(f, "utf8");
    // `$` is end-of-LINE under the `m` flag that `^` needs, so this lookahead fired on the line break
    // right after the heading and every goal came back empty — the fallback then quietly reported the
    // heading as the goal. `(?![\s\S])` is end of input whatever the flags say.
    const re = new RegExp(`^##+\\s*Phase\\s+${String(phase).replace(".", "\\.")}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|(?![\\s\\S]))`, "m");
    const m = text.match(re);
    const body = m?.[1]?.trim();
    if (body) return { goal: body.split("\n").filter(l => l.trim() && !l.startsWith("|")).slice(0, 6).join("\n"), source: ".sch-loop/PLAN.md" };
  }
  const doc = parse(fs.readFileSync(path.join(projectRoot, "task.md"), "utf8"));
  const ph = doc.phases.find(p => String(p.id) === String(phase));
  return { goal: ph?.name || `Phase ${phase}`, source: "task.md heading (no PLAN.md entry)" };
}

// task.md carries the raw glyph, and only `x` is done. `!` and `?` are the two that matter most here:
// a phase with a blocked or human-gated ticket in it is not a phase anyone may call verified.
export function phaseFiles(projectRoot, tickets) {
  const out = new Set();
  for (const t of tickets) {
    let r = null;
    try { r = readReport(projectRoot, t.id); } catch { /* no report is itself visible: the list comes back short */ }
    for (const a of r?.artifacts || []) out.add(a);
  }
  return [...out];
}

export function unfinished(tickets) {
  return tickets.filter(t => t.status !== "x").map(t => `${t.id} is [${t.status === " " ? "pending" : t.status}]`);
}

export function verifyPrompt({ goal, goalSource, phase, tickets, checks, files }) {
  return [
    `Verify that phase ${phase} actually delivers its goal. Work BACKWARDS from the goal, not forwards from the tickets.`,
    "",
    `GOAL (from ${goalSource}):\n${goal}`,
    "",
    `TICKETS IN THIS PHASE:\n${tickets.map(t => `- ${t.id} [${t.type}] ${t.title}${t.acceptance.length ? `\n    acceptance: ${t.acceptance.join(" | ")}` : ""}`).join("\n")}`,
    "",
    `FILES THE PHASE TOUCHED:\n${files.length ? files.map(f => `- ${f}`).join("\n") : "- (none — that is itself a finding)"}`,
    "",
    `DETERMINISTIC CHECKS ALREADY RUN (you cannot overrule these):\n${checks.map(c => `- ${c.name}: ${c.ok ? "PASSED" : `FAILED (exit ${c.exitCode})`}${c.ok ? "" : `\n    ${String(c.stderr || c.stdout).trim().split("\n").slice(-4).join("\n    ")}`}`).join("\n") || "- (none configured)"}`,
    "",
    "Derive 3 to 7 observable truths a user could check. Every truth must be FALSIFIABLE: you must be able",
    "to name a change to this codebase that would make it false. If no possible implementation could break",
    "it — because the thing it worries about is not separable in this design — it is not a truth about this",
    "codebase and you must not list it at all. Do not invent a truth in order to have something to object",
    "to; a phase that delivers its goal is allowed to pass.",
    "",
    "For each truth, climb the four levels in order and stop at the first that fails:",
    "  exists      — the file is there (read it)",
    "  substantive — it is real, not a stub: no placeholder return, empty array, 'coming soon', or handler that only calls preventDefault",
    "  wired       — it is imported AND called (grep for use, not just import)",
    "  flowing     — real data reaches it; a static fallback is not a data source",
    "",
    "A truth that asserts RUNTIME BEHAVIOUR (a state transition, an ordering or cleanup invariant) cannot be",
    "verified by presence. Either name the one test that exercises it and that is listed as PASSED above, or",
    'mark it "behaviour_unverified". Never call such a truth verified because the code looks right.',
    "",
    '"behaviour_unverified" means "this could be tested and is not". It does not mean "this cannot be',
    'tested at all" — a claim like that is unfalsifiable, so by the rule above it should not be on your list.',
    "",
    "Reply with ONLY this JSON:",
    JSON.stringify({
      truths: [{ truth: "a user can …", level_reached: "exists|substantive|wired|flowing", status: "verified|gap|behaviour_unverified", evidence: "path:line — what you saw, or the test that proves it" }],
      gaps: [{ truth: "…", missing: "the specific thing to add", artifacts: "file — what is wrong" }],
    }),
  ].join("\n");
}

// Fail closed in every direction: an unreadable answer, a truth the seat left unlabelled, a check that
// went red, or a ticket that is not done all mean this phase is NOT verified.
export function decide({ parsed, checks, unfinishedTickets }) {
  if (unfinishedTickets.length) return { status: "gaps_found", why: `not every ticket is done: ${unfinishedTickets.join(", ")}` };
  const redChecks = checks.filter(c => !c.ok);
  if (redChecks.length) return { status: "gaps_found", why: `deterministic checks failed: ${redChecks.map(c => c.name).join(", ")}` };
  if (!parsed || !Array.isArray(parsed.truths) || !parsed.truths.length) return { status: "human_needed", why: "the verifier did not return a readable list of truths" };
  const known = new Set(["verified", "gap", "behaviour_unverified"]);
  const unlabelled = parsed.truths.filter(t => !known.has(t.status));
  if (unlabelled.length) return { status: "human_needed", why: `${unlabelled.length} truth(s) came back with no usable status` };
  if (parsed.truths.some(t => t.status === "gap")) return { status: "gaps_found", why: "at least one truth is a gap" };
  if (parsed.truths.some(t => t.status === "behaviour_unverified")) return { status: "human_needed", why: "a runtime behaviour has no test behind it" };
  return { status: "passed", why: `${parsed.truths.length} truth(s) verified` };
}

export function toMarkdown({ phase, goal, goalSource, status, why, truths = [], gaps = [], checks = [], files = [] }) {
  const verified = truths.filter(t => t.status === "verified").length;
  return [
    `# Phase ${phase} verification`, "",
    `**Goal:** ${goal.replace(/\n/g, " ")}`,
    `**Goal source:** ${goalSource}`,
    `**Status:** ${status}`,
    `**Why:** ${why}`,
    `**Score:** ${verified}/${truths.length} truths`, "",
    "| # | Truth | Level | Status | Evidence |",
    "|---|---|---|---|---|",
    ...truths.map((t, i) => `| ${i + 1} | ${cell(t.truth)} | ${cell(t.level_reached)} | ${cell(t.status)} | ${cell(t.evidence)} |`),
    "",
    "## Deterministic checks", "",
    ...(checks.length ? checks.map(c => `- ${c.ok ? "PASS" : "FAIL"} — ${c.name}`) : ["- (none configured)"]),
    "",
    "## Files the phase touched", "",
    ...(files.length ? files.map(f => `- ${f}`) : ["- (none)"]),
    "",
    ...(gaps.length ? ["## Gaps", "", ...gaps.flatMap(g => [`- truth: ${g.truth}`, `  missing: ${g.missing}`, `  artifacts: ${g.artifacts}`])] : ["## Gaps", "", "- (none)"]),
    "",
  ].join("\n");
}
const cell = v => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export async function verifyPhase({ projectRoot, phase, seat, checks = [], changedFiles = null, runChecks = runVerification, ask = callSeat, timeoutMs = 15 * 60_000 }) {
  const tickets = phaseTickets(projectRoot, phase);
  if (!tickets.length) throw new Error(`no tickets in phase ${phase} — nothing to verify`);
  const { goal, source: goalSource } = phaseGoal(projectRoot, phase);
  const stuck = unfinished(tickets);

  // The seat is handed results, never the chance to run the checks itself.
  const run = checks.length ? await runChecks({ runId: `verify-phase-${phase}`, ticketId: `phase-${phase}`, checks, cwd: projectRoot }) : { checks: [] };
  // The files the phase ACTUALLY touched, taken from each ticket's delivery report. `allowed_paths` is
  // a permission, not a record: a phase whose tickets were allowed to write `src/**` and wrote nothing
  // would otherwise be presented to the verifier as having touched all of it.
  const files = changedFiles ?? phaseFiles(projectRoot, tickets);

  let parsed = null, raw = "";
  if (!stuck.length) {
    try {
      const r = await ask(seat, { prompt: verifyPrompt({ goal, goalSource, phase, tickets, checks: run.checks, files }), system: "You verify that a finished phase delivers its goal. You never change code and you never overrule a deterministic check.", cwd: projectRoot, mode: "review", timeoutMs });
      raw = r.text || "";
      parsed = extractJson(raw);
    } catch (e) { raw = `verifier seat failed: ${e.message}`; }
  }

  const { status, why } = decide({ parsed, checks: run.checks, unfinishedTickets: stuck });
  const md = toMarkdown({ phase, goal, goalSource, status, why, truths: parsed?.truths || [], gaps: parsed?.gaps || [], checks: run.checks, files });
  const dir = path.join(projectRoot, ".sch-loop", "verify");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `phase-${phase}.md`);
  fs.writeFileSync(file, md);
  if (raw && !parsed) fs.writeFileSync(path.join(dir, `phase-${phase}.raw.txt`), raw);
  appendEvent(projectRoot, { type: "phase.verified", phase: String(phase), status, why });
  return { phase: String(phase), status, why, truths: parsed?.truths || [], gaps: parsed?.gaps || [], checks: run.checks, file };
}
