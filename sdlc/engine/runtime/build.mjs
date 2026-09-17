// One ticket, end to end (design §3.6): fences → worktree → build/TDD → check → review → judge →
// Manager → deliver. Code owns the loop; every model call is a bounded phase inside it.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { loadRoles, resolveSpawn, isBypass, isReadOnly } from "./roles.mjs";
import { checkFences } from "./fences.mjs";
import { ensureTicketWorktree, mergeTicket, commitFiles, commitBookkeeping, changedInWorktree, removeTicketWorktree } from "./worktrees.mjs";
import { loadTicket, ticketToBuildSpec } from "./tickets.mjs";
import { runSelfCorrectingTask } from "./self-correct.mjs";
import { runReview, reviewToMarkdown } from "./review.mjs";
import { writeReport, appendEvent } from "./report.mjs";
import { setStatus } from "./taskmd.mjs";
import { notifyOrchestrator } from "./herdr.mjs";
import { contextTokens, sessionTokens } from "./spawn.mjs";

const TDD_TYPES = new Set(["build", "test"]);
const REVIEW_TYPES = new Set(["build", "test", "chore"]);
const NO_EXEC_TYPES = new Set(["human", "decision"]);

export function timeoutFor(config, size) { return (config.timeouts_minutes?.[size || "M"] ?? 30) * 60_000; }

function setTicketStatus(projectRoot, id, glyph) {
  const f = path.join(projectRoot, "task.md");
  fs.writeFileSync(f, setStatus(fs.readFileSync(f, "utf8"), id, glyph));
}
function saveState(projectRoot, patch) {
  const f = path.join(projectRoot, ".sch-loop", "state.json");
  const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  fs.writeFileSync(f, JSON.stringify({ ...s, ...patch, updated_at: new Date().toISOString() }, null, 2) + "\n");
}
const readIf = f => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

// A ticket nobody should execute: stop, mark, notify. Human and decision tickets end here by design.
function haltForHuman(projectRoot, t, why) {
  setTicketStatus(projectRoot, t.id, "?");
  saveState(projectRoot, { current_task: null, last_event: "NEEDS_HUMAN" });
  const env = writeReport(projectRoot, { id: t.id, status: "needs_human", summary: why, what_did_not_work: [], notes_for_next: t.action });
  appendEvent(projectRoot, { type: "ticket.needs_human", id: t.id, why });
  return { decision: "HUMAN", report: env };
}

// `roles` and `config` are injectable so the watchdog reads them once per run (and tests can drive the
// pipeline with stub seats). Absent, they are read from the project on every ticket.
export async function buildTicket({ projectRoot, id, dryRun = false, onEvent, roles: rolesIn, config: configIn }) {
  const config = configIn || loadConfig(projectRoot);
  const roles = rolesIn || loadRoles(projectRoot);
  const t = loadTicket(projectRoot, id);
  const started = Date.now();

  if (NO_EXEC_TYPES.has(t.type)) return haltForHuman(projectRoot, t, `${t.type} ticket — no executor runs this: ${t.title}`);

  // Refuse to start a bypass executor without all three fences (design §3.9).
  const wt = ensureTicketWorktree({ projectRoot, id: t.id, slug: t.slug });
  const fences = checkFences({ projectRoot, cwd: wt.cwd, roles, config });
  if (!fences.ok) {
    const why = `executor is in bypass mode but the fences do not hold:\n- ${fences.failures.join("\n- ")}`;
    appendEvent(projectRoot, { type: "ticket.refused", id: t.id, failures: fences.failures });
    if (!dryRun) setTicketStatus(projectRoot, t.id, "?");
    return { decision: "HUMAN", refused: true, fences, report: writeReport(projectRoot, { id: t.id, status: "refused", summary: why, what_did_not_work: fences.failures }) };
  }
  // Reviewer and judge must not be able to write, whatever permission mode they run in.
  for (const r of ["reviewer", "judge"]) {
    if (!isReadOnly(roles[r])) throw new Error(`roles.json: ${r} must be tool-restricted read-only (add the read_only_tools preset) — it grades work it must not be able to change`);
  }

  if (dryRun) return { decision: "DRY", worktree: wt, fences, spawn: { executor: resolveSpawn(roles.executor), reviewer: resolveSpawn(roles.reviewer), judge: resolveSpawn(roles.judge) } };

  setTicketStatus(projectRoot, t.id, "~");
  saveState(projectRoot, { current_task: t.id, current_role: "executor", attempt: 1, last_event: "TICKET_DISPATCHED" });
  appendEvent(projectRoot, { type: "ticket.start", id: t.id, type_: t.type, branch: wt.branch, worktree: wt.cwd });

  const spec = ticketToBuildSpec(t, wt.cwd);
  const tdd = TDD_TYPES.has(t.type) && config.require_tdd_for_behavior_changes !== false;
  const state = await runSelfCorrectingTask({
    ...spec,
    ticket: tdd ? `${spec.ticket}\n\nTDD IS REQUIRED: write the failing test first and confirm it fails for the intended reason, commit it, then make it pass.` : spec.ticket,
    requirements: spec.requirements.join("\n"),
    builder: roles.executor, judge: roles.judge,
    protectedPaths: config.protected_paths || [],
    // The ticket may ask for fewer attempts than the project allows, never more: a spike worth one
    // shot says so on the ticket, and no ticket can vote itself extra budget. `ticketToBuildSpec`
    // already carries the field, and until now the config silently overwrote it.
    maxAttempts: Math.min(t.maxAttempts ?? Infinity, config.max_executor_attempts ?? 3),
    timeoutMs: timeoutFor(config, t.size), silenceMs: (config.silence_nudge_seconds ?? 120) * 1000 * 4, baseRef: wt.base,
    onEvent,
  });

  const last = state.attempts?.[state.attempts.length - 1] || {};
  const changed = last.workspace?.changedFiles || [];
  const verification = last.verification || null;
  const usage = last.usage || null;

  // Review only after the cheap deterministic gates are green — a fresh-context review of code that
  // does not compile is the most expensive way to learn it does not compile.
  let review = null;
  if (state.managerDecision === "PASS" && REVIEW_TYPES.has(t.type) && config.require_independent_review !== false) {
    saveState(projectRoot, { current_role: "reviewer" });
    const rounds = config.max_review_rounds ?? 3;
    for (let round = 1; round <= rounds; round++) {
      review = await runReview({
        seat: roles.reviewer, verifierSeat: roles.reviewer, cwd: wt.cwd,
        ticket: spec.ticket, acceptance: t.acceptance, mustNot: t.must_not,
        diff: last.workspace?.diff || readIf(path.join(wt.cwd, ".git", "NOTHING")) || "(no diff captured)",
        tests: JSON.stringify(verification?.checks?.map(c => ({ name: c.name, ok: c.ok })) || []),
        standards: readIf(path.join(projectRoot, "CLAUDE.md")).slice(0, 4000),
        timeoutMs: timeoutFor(config, t.size),
      });
      fs.mkdirSync(path.join(projectRoot, ".sch-loop", "reviews"), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, ".sch-loop", "reviews", `${t.id}-r${round}.md`), reviewToMarkdown(review, t.id, round) + "\n");
      appendEvent(projectRoot, { type: "ticket.review", id: t.id, round, verdict: review.verdict, blocking: review.blocking.length });
      if (review.verdict === "APPROVE") break;
      if (round === rounds) { state.managerDecision = "HUMAN"; break; }
      // Scoped re-build: only the blocking findings, nothing else.
      const fix = await runSelfCorrectingTask({
        ...spec,
        ticket: `${spec.ticket}\n\nREVIEW ROUND ${round} REQUESTED CHANGES. Fix ONLY these, change nothing else:\n${review.blocking.map(f => `- [${f.severity}] ${f.file}: ${f.title} — ${f.evidence}`).join("\n")}`,
        requirements: spec.requirements.join("\n"),
        builder: roles.executor, judge: roles.judge,
        protectedPaths: config.protected_paths || [], maxAttempts: 1, baseRef: wt.base,
        timeoutMs: timeoutFor(config, t.size), onEvent,
      });
      if (fix.managerDecision !== "PASS") { state.managerDecision = "HUMAN"; break; }
    }
  }

  const passed = state.managerDecision === "PASS" && (!review || review.verdict === "APPROVE");

  // Deliver: commit exactly the changed files in the worktree, then fail-closed merge into the project.
  let merged = null, committed = null;
  if (passed) {
    // `changed` is project-relative (workspaceEvidence strips the repo prefix) and includes untracked
    // creations, which is exactly what `git add --` wants from the project directory.
    // A TDD executor commits its own RED and GREEN steps, so the worktree is often already clean.
    // Only stage when something is actually outstanding; an empty commit is not a delivery failure.
    const outstanding = changedInWorktree(wt.cwd).uncommitted;
    if (outstanding.length) {
      committed = commitFiles({ cwd: wt.cwd, files: outstanding, message: `${t.type === "test" ? "test" : "feat"}(${t.id}): ${t.title}` });
      // A failed stage used to fall through to a merge of an empty branch: the ticket reported PASS and
      // delivered nothing. Delivery failure is a blocker, never a silent success.
      if (!committed.ok) {
        appendEvent(projectRoot, { type: "ticket.commit_failed", id: t.id, error: committed.error });
        setTicketStatus(projectRoot, t.id, "!");
        const env = writeReport(projectRoot, { id: t.id, status: "blocked", summary: "built and reviewed clean, but the work could not be committed", artifacts: changed, attempts: state.attempts?.length ?? 0, branch: wt.branch, what_did_not_work: [`git commit failed: ${committed.error}`] });
        await notifyOrchestrator(`SCH ! ${t.id} could not commit — branch ${wt.branch} kept`);
        return { decision: "HUMAN", committed, report: env, state, review };
      }
    }
    merged = mergeTicket({ projectRoot, id: t.id, slug: t.slug, message: `merge(${t.id}): ${t.title}` });
    if (!merged.ok) {
      appendEvent(projectRoot, { type: "ticket.merge_failed", id: t.id, conflict: merged.conflict, error: merged.error });
      setTicketStatus(projectRoot, t.id, "!");
      const env = writeReport(projectRoot, { id: t.id, status: "blocked", summary: `built and reviewed clean, but the merge into the project failed`, artifacts: changed, attempts: state.attempts?.length ?? 0, review: review?.stats || null, judge: last.judge || null, tests: verification ? { passed: verification.passed } : null, usage, context_tokens: contextTokens(usage), cost_usd: last.costUsd ?? null, branch: wt.branch, what_did_not_work: [`merge conflict: ${merged.error}`] });
      await notifyOrchestrator(`SCH ! ${t.id} merge conflict — branch ${wt.branch} kept`);
      return { decision: "HUMAN", merged, report: env, state, review };
    }
    removeTicketWorktree({ projectRoot, id: t.id });
  }

  const status = passed ? "done" : (state.status === "needs_decision" || state.managerDecision === "HUMAN" ? "blocked" : "blocked");
  setTicketStatus(projectRoot, t.id, passed ? "x" : "!");
  saveState(projectRoot, { current_task: null, current_role: null, last_event: passed ? "TICKET_DONE" : "TICKET_BLOCKED" });

  const env = writeReport(projectRoot, {
    id: t.id, status, run_id: state.runId,
    summary: passed ? `${t.title} — ${changed.length} file(s), ${state.attempts?.length ?? 0} attempt(s)` : `${t.title} — stopped after ${state.attempts?.length ?? 0} attempt(s)`,
    artifacts: changed, attempts: state.attempts?.length ?? 0,
    tests: verification ? { passed: verification.passed, failed: (verification.checks || []).filter(c => !c.ok).map(c => c.name) } : null,
    review: review ? { verdict: review.verdict, ...review.stats } : null,
    judge: last.judge ? { verdict: last.judge.verdict } : null,
    usage, context_tokens: contextTokens(usage), session_tokens: sessionTokens(usage), cost_usd: last.costUsd ?? null,
    branch: wt.branch, merged_head: merged?.head || null,
    notes_for_next: last.builderMessage ? String(last.builderMessage).split(/SUMMARY:/i)[1]?.trim() || "" : "",
    what_did_not_work: passed ? [] : [
      ...((verification?.checks || []).filter(c => !c.ok).map(c => `check ${c.name} failed`)),
      ...((last.judge?.failures || []).map(f => f.reason).filter(Boolean)),
      ...((review?.blocking || []).map(f => `${f.severity} ${f.file}: ${f.title}`)),
      ...(last.error ? [last.error] : []),
    ],
  });
  // Record the loop's own trail last, so the report and the final task.md glyph are inside the commit.
  // A failure here is logged and never changes the ticket's verdict: the code is already merged, and
  // turning a delivered ticket red because its paperwork would not commit helps nobody.
  const book = commitBookkeeping({ cwd: projectRoot, message: `chore(${t.id}): queue, report and ticket state` });
  if (!book.ok && !book.empty) appendEvent(projectRoot, { type: "ticket.bookkeeping_failed", id: t.id, error: book.error });

  appendEvent(projectRoot, { type: passed ? "ticket.done" : "ticket.blocked", id: t.id, attempts: state.attempts?.length ?? 0, ms: Date.now() - started });
  await notifyOrchestrator(passed ? `SCH ✓ ${t.id} done — ${t.title}` : `SCH ! ${t.id} blocked after ${state.attempts?.length ?? 0} attempts — see .sch-loop/reports/${t.id}.md`);
  return { decision: passed ? "PASS" : "HUMAN", report: env, state, review, merged };
}
