import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

// util.mjs resolves ROOT at import time, so both roots are pinned before anything loads.
// The engine home holds the provider registry, lessons and run state; the project being
// verified is a separate directory and is passed to the loop as `cwd`. Without this split,
// running the CLI from a project resolves the provider registry under that project, where
// it does not exist.
const ENGINE_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.SCH_PROJECT_ROOT ||= process.cwd();
// State belongs to the PROJECT, not to the engine. `util.mjs` derives `.sch-loop/` from SCH_HOME at
// import time, so pointing it at the engine put run state, evidence and lessons under the engine copy
// while reports and reviews were written under the project — two halves of one ticket's evidence in
// two different trees, and the engine snapshot is gitignored, so half of it was invisible.
process.env.SCH_HOME ||= process.env.SCH_PROJECT_ROOT;

const { discoverCLIs, getProviders } = await import("./providers.mjs");
const { workflowState, initWorkspace } = await import("./workflow.mjs");
const { listCouncils, startCouncil, getCouncil } = await import("./council.mjs");
const { runSelfCorrectingTask, workspaceEvidence, scopeCheck } = await import("./self-correct.mjs");
const { runVerification } = await import("./verifier.mjs");
const { runJudge } = await import("./judge.mjs");
const { makeId, SCH } = await import("./util.mjs");
const { buildTicket } = await import("./build.mjs");
const { run: runWatchdog, heartbeatStatus } = await import("./watchdog.mjs");
const { verifyPhase } = await import("./verify-phase.mjs");
const { ship } = await import("./ship.mjs");
const { notify, unread, markAllRead, orchestratorTarget } = await import("./notify.mjs");
const { STAGES, stageById, stageReport, nextStage, runStage, runTicketsStage, setGoal, goal } = await import("./stages.mjs");
const { summary: progressSummary, render: renderProgress, events: readEvents, renderLog } = await import("./progress.mjs");
const { parse: parseTaskMd, next: nextTicket, setStatus, insert: insertTask } = await import("./taskmd.mjs");
const { writeTicket, loadTicket, validateTicket, TICKET_TYPES } = await import("./tickets.mjs");
const { loadRoles, resolveSpawn, isBypass, isReadOnly, councilSeats } = await import("./roles.mjs");
const { loadConfig } = await import("./config.mjs");
const { checkFences } = await import("./fences.mjs");
const fsSync = await import("node:fs");

// Everything below operates on the PROJECT (the repo being built), never on the engine home.
const PROJECT = () => path.resolve(process.env.SCH_PROJECT_ROOT || process.cwd());
const readTaskMd = () => fsSync.readFileSync(path.join(PROJECT(), "task.md"), "utf8");
const writeTaskMd = (t) => fsSync.writeFileSync(path.join(PROJECT(), "task.md"), t);

// Commands run at module top level, so a rejection surfaces here rather than at a call site. Report the
// message; the stack is noise to a skill reading this output.
process.on("unhandledRejection", (e) => {
  console.error(JSON.stringify({ error: e?.message || String(e) }, null, 2));
  process.exit(1);
});

const [cmd, ...rest] = process.argv.slice(2);
const out = (v) => console.log(JSON.stringify(v, null, 2));

async function loadSpec(arg) {
  if (!arg) throw new Error("spec required: a JSON file path, or - to read stdin");
  const raw = arg === "-"
    ? await new Response(process.stdin).text()
    : await fs.readFile(path.resolve(arg), "utf8");
  return JSON.parse(raw);
}

// Seats are resolved against the live registry so no model string is hardcoded here.
async function resolveSeats(spec) {
  const providers = (await getProviders()).filter(p => p.enabled);
  const pick = (id) => {
    const p = providers.find(x => x.id === id);
    if (!p) throw new Error(`unknown or disabled provider ${id}; run: node runtime/cli.mjs providers`);
    return p;
  };
  const builderId = spec.builder?.providerId || providers.find(p => p.capabilities?.build)?.id;
  if (!builderId) throw new Error("no build-capable provider registered");
  const builder = pick(builderId);

  // The trust rule is that the component which produced the work cannot approve it. A judge on the
  // same provider as the builder is only allowed when the caller asks for it explicitly.
  const judgeId = spec.judge?.providerId
    || providers.find(p => p.id !== builderId && p.capabilities?.review)?.id;
  if (!judgeId) throw new Error("no second provider registered: cannot seat an independent judge");
  const judge = pick(judgeId);

  return {
    builder: { providerId: builder.id, model: spec.builder?.model || builder.model },
    judge: { providerId: judge.id, model: spec.judge?.model || judge.model }
  };
}

// Seats are spread across distinct providers before any provider is reused: a council whose seats all
// sit on one model is one model arguing with itself, which is the failure the phase exists to avoid.
function seatRoles(roles, providers) {
  const usable = providers.filter(p => p.capabilities?.review);
  if (!usable.length) throw new Error("no review-capable provider registered");
  return roles.map((role, i) => {
    const p = usable[i % usable.length];
    return { role, providerId: p.id, model: p.model };
  });
}

// Chair preference is fresh-provider first, but never at the cost of reachability. Registration proves a
// local CLI exists (the registry carries its resolved path and version); it proves nothing about a remote
// endpoint. Measured: preferring the one unused provider seated the chair on an HTTP endpoint that was
// down, and a council whose seven seats had all completed died in synthesis with `fetch failed`. A chair
// sharing a provider with a seat is a smaller loss than discarding every phase of the debate.
function pickChair(seats, providers) {
  const used = new Set(seats.map(s => s.providerId));
  const review = providers.filter(p => p.capabilities?.review);
  const p = review.find(x => x.type === "cli" && !used.has(x.id))
    || review.find(x => x.type === "cli")
    || review[0];
  if (!p) throw new Error("no review-capable provider registered to chair the council");
  return { providerId: p.id, model: p.model };
}

function summarize(state) {
  const last = state.attempts?.[state.attempts.length - 1];
  return {
    runId: state.runId,
    ticketId: state.ticketId,
    status: state.status,
    managerDecision: state.managerDecision,
    attempts: state.attempts?.length ?? 0,
    maxAttempts: state.maxAttempts,
    verificationPassed: last?.verification?.passed ?? null,
    failedChecks: (last?.verification?.checks || []).filter(c => !c.ok).map(c => c.name),
    judgeVerdict: last?.judge?.verdict ?? null,
    judgeFailures: (last?.judge?.failures || []).map(f => f.reason).filter(Boolean),
    changedFiles: last?.workspace?.changedFiles ?? [],
    runDir: path.join(SCH, "runs", state.runId || ""),
    evidenceDir: path.join(SCH, "evidence", state.runId || "", state.ticketId || "")
  };
}

if (cmd === "doctor") {
  await initWorkspace();
  out({ node: process.version, platform: process.platform, engineHome: ENGINE_HOME, clis: await discoverCLIs() });
} else if (cmd === "providers") {
  out(await getProviders());
} else if (cmd === "status") {
  out({ workflow: await workflowState(), councils: await listCouncils() });
} else if (cmd === "build") {
  const spec = await loadSpec(rest[0]);
  const { builder, judge } = await resolveSeats(spec);
  const state = await runSelfCorrectingTask({
    ticketId: spec.ticketId,
    ticket: spec.ticket,
    requirements: spec.requirements,
    allowedPaths: spec.allowedPaths,
    verificationChecks: spec.verificationChecks || [],
    maxAttempts: spec.maxAttempts ?? 3,
    tags: spec.tags || [],
    cwd: path.resolve(spec.cwd || process.env.SCH_PROJECT_ROOT),
    builder,
    judge
  });
  out({ seats: { builder, judge }, ...summarize(state) });
  process.exit(state.managerDecision === "PASS" ? 0 : 1);
} else if (cmd === "verify") {
  // Same gate as one build attempt, minus the Builder: deterministic checks and scope containment
  // first, then an independent judge that cannot override a failed check.
  const spec = await loadSpec(rest[0]);
  const { judge } = await resolveSeats(spec);
  const cwd = path.resolve(spec.cwd || process.env.SCH_PROJECT_ROOT);
  const runId = makeId("verify");
  const ticketId = spec.ticketId || "adhoc";

  const workspace = await workspaceEvidence(cwd);
  const scope = scopeCheck(workspace, spec.allowedPaths);
  const verification = await runVerification({ runId, ticketId, checks: spec.verificationChecks || [], cwd });
  verification.checks.unshift(scope);
  verification.passed = verification.passed && scope.ok;

  const judged = await runJudge({
    providerId: judge.providerId,
    model: judge.model,
    requirements: spec.requirements,
    output: `GIT STATUS\n${workspace.status}\n\nCHANGED FILES\n${workspace.changedFiles.join("\n")}\n\nACTUAL GIT DIFF\n${workspace.diff}`,
    verification,
    evidenceNotes: spec.evidenceNotes || ""
  });

  const passed = verification.passed && judged.parsed.verdict === "PASS";
  out({
    runId, ticketId, judgeSeat: judge, verificationPassed: verification.passed,
    failedChecks: verification.checks.filter(c => !c.ok).map(c => c.name),
    judgeVerdict: judged.parsed.verdict,
    judgeFailures: (judged.parsed.failures || []).map(f => f.reason).filter(Boolean),
    changedFiles: workspace.changedFiles,
    decision: passed ? "PASS" : "FAIL",
    evidenceDir: path.join(SCH, "evidence", runId, ticketId)
  });
  process.exit(passed ? 0 : 1);
} else if (cmd === "council") {
  const spec = await loadSpec(rest[0]);
  const providers = (await getProviders()).filter(p => p.enabled);
  const seats = spec.seats?.length
    ? spec.seats
    : seatRoles(spec.roles?.length ? spec.roles : ["architect", "security", "minimalist"], providers);
  if (seats.length < 2) throw new Error("a council needs at least two seats");
  const chair = spec.chair?.providerId ? spec.chair : pickChair(seats, providers);

  let state;
  try {
    state = await startCouncil({ question: spec.question, seats, chair, context: spec.context || {} });
  } catch (e) {
    // Every completed phase is already on disk. Say where, because a council that reached synthesis and
    // lost its chair still holds the proposals, critiques, rebuttals and challenge that were paid for.
    console.error(JSON.stringify({
      error: e.message,
      seats: seats.map(s => `${s.role}=${s.providerId}/${s.model}`),
      chair: `${chair.providerId}/${chair.model}`,
      recover: `partial transcripts are under ${path.join(SCH, "council")}; run: cli.mjs status`
    }, null, 2));
    process.exit(1);
  }
  console.error(`council ${state.id}: ${state.status}`);
  console.log(state.verdict || "");
  console.error(JSON.stringify({
    councilId: state.id, status: state.status,
    seats: seats.map(s => `${s.role}=${s.providerId}/${s.model}`),
    chair: `${chair.providerId}/${chair.model}`,
    dir: path.join(SCH, "council", state.id)
  }, null, 2));
  process.exit(state.status === "completed" ? 0 : 1);
} else if (cmd === "council-show") {
  const state = await getCouncil(rest[0]);
  if (!state) throw new Error(`no council ${rest[0]}`);
  out(state);
} else if (cmd === "setup") {
  const { setupProject } = await import("./setup.mjs");
  const r = await setupProject({ projectRoot: PROJECT(), force: rest.includes("--force") });
  out(r);
  // A setup that produced an unrunnable project must not exit 0. It used to report a tidy list of
  // written files for a project with no engine, no hooks and no skills in it.
  process.exit(r.ok ? 0 : 1);
} else if (cmd === "seats") {
  const { probeSeats } = await import("./setup.mjs");
  out(await probeSeats());
} else if (cmd === "run") {
  // The dispatch loop. Runs every dispatchable ticket in task.md order until something needs a human.
  const max = rest.includes("--max") ? Number(rest[rest.indexOf("--max") + 1]) : Infinity;
  const r = await runWatchdog({ projectRoot: PROJECT(), maxTickets: max });
  out({ done: r.done, blocked: r.blocked, results: r.results.map(x => ({ id: x.id, decision: x.decision })) });
  process.exit(r.blocked.length || r.results.some(x => x.decision === "FAULT") ? 1 : 0);
} else if (cmd === "ticket") {
  // ticket <id> — run exactly one ticket through the full pipeline.
  const id = rest[0];
  if (!id) throw new Error("usage: ticket <id> [--dry-run]");
  const r = await buildTicket({ projectRoot: PROJECT(), id, dryRun: rest.includes("--dry-run") });
  out({ id, decision: r.decision, refused: r.refused || false, fences: r.fences?.failures || [], report: r.report ? { status: r.report.status, artifacts: r.report.artifacts, what_did_not_work: r.report.what_did_not_work } : null, spawn: r.spawn || undefined });
  process.exit(r.decision === "PASS" || r.decision === "DRY" ? 0 : 1);
} else if (cmd === "next") {
  out(nextTicket(parseTaskMd(readTaskMd())));
} else if (cmd === "tasks") {
  out(parseTaskMd(readTaskMd()).tickets.map(({ line, ...t }) => t));
} else if (cmd === "task-status") {
  writeTaskMd(setStatus(readTaskMd(), rest[0], rest[1] ?? " "));
  out({ id: rest[0], status: rest[1] });
} else if (cmd === "insert") {
  // insert '<ticket json>' — validates, assigns a suffix id, writes tickets/<id>.json and the task.md line.
  const spec = await loadSpec(rest[0]);
  const t = writeTicket(PROJECT(), spec);
  out({ id: t.id, slug: t.slug, file: t.file });
} else if (cmd === "ticket-show") {
  out(loadTicket(PROJECT(), rest[0]));
} else if (cmd === "ticket-validate") {
  const spec = await loadSpec(rest[0]);
  const errs = validateTicket(spec);
  out({ ok: errs.length === 0, errors: errs, types: TICKET_TYPES });
  process.exit(errs.length ? 1 : 0);
} else if (cmd === "roles") {
  const roles = loadRoles(PROJECT());
  const show = (name, s) => ({ role: name, provider: s.provider || null, model: s.model || "(provider default)", argv: [s.spawn[0], ...resolveSpawn(s).args].join(" "), bypass: isBypass(s), readOnly: isReadOnly(s) });
  out({
    executor: show("executor", roles.executor), reviewer: show("reviewer", roles.reviewer), judge: show("judge", roles.judge),
    council: councilSeats(roles).map(s => show(s.role || "seat", s)),
  });
} else if (cmd === "fences") {
  const roles = loadRoles(PROJECT());
  out(checkFences({ projectRoot: PROJECT(), cwd: PROJECT(), roles, config: loadConfig(PROJECT()) }));
} else if (cmd === "heartbeat") {
  out(heartbeatStatus(PROJECT()));
} else if (cmd === "progress") {
  // One screen: is it running, what is specified, what is built, what it cost. Read from durable state.
  const root = PROJECT();
  const s = progressSummary(root);
  if (rest.includes("--json")) out(s); else console.log(renderProgress(s));
} else if (cmd === "log") {
  // The event stream as sentences, for a person watching it happen. `--follow` tails it.
  const root = PROJECT();
  const n = rest.includes("-n") ? Number(rest[rest.indexOf("-n") + 1]) : 30;
  console.log(renderLog(readEvents(root, { limit: n })));
  if (rest.includes("--follow") || rest.includes("-f")) {
    let seen = readEvents(root).length;
    setInterval(() => {
      const all = readEvents(root);
      if (all.length > seen) { console.log(renderLog(all.slice(seen))); seen = all.length; }
    }, 1000);
  }
} else if (cmd === "dashboard") {
  // The Roles page. Loopback only, and it writes exactly one file.
  const { serve } = await import("./dashboard.mjs");
  const port = rest.includes("--port") ? Number(rest[rest.indexOf("--port") + 1]) : 4319;
  const { url } = await serve(PROJECT(), { port });
  console.error(`SCH-LOOP roles dashboard: ${url}
editing ${path.join(PROJECT(), ".sch-loop", "roles.json")}
ctrl-c to stop`);
} else if (cmd === "stages") {
  const root = PROJECT();
  const n = nextStage(root);
  out({ goal: goal(root), stages: stageReport(root), next: n ? n.id : "tickets" });
} else if (cmd === "stage") {
  // Drive one lifecycle stage: brainstorm | prd | architecture | plan, or `next`.
  const root = PROJECT();
  const want = rest[0];
  if (!want) throw new Error(`usage: stage <${STAGES.map(s => s.id).join("|")}|next> [--goal "..."] [--force]`);
  const stage = want === "next" ? nextStage(root) : stageById(want);
  if (!stage) {
    if (want === "next") { out({ done: true, next: "tickets", hint: "the front half is complete — run sch-tickets" }); process.exit(0); }
    throw new Error(`unknown stage ${want}; one of ${STAGES.map(s => s.id).join(", ")}`);
  }
  const gi = rest.indexOf("--goal");
  const r = await runStage({
    projectRoot: root, engineRoot: ENGINE_HOME, stage,
    seat: loadRoles(root).reviewer, config: loadConfig(root),
    goalText: gi >= 0 ? rest[gi + 1] : null, force: rest.includes("--force"),
  });
  out(r);
} else if (cmd === "plan-to-tickets") {
  // The seam between the plan and the queue: the one stage whose output is data, so every ticket is
  // validated as it is written and a rejection is named rather than dropped.
  const root = PROJECT();
  const r = await runTicketsStage({
    projectRoot: root, engineRoot: ENGINE_HOME,
    seat: loadRoles(root).reviewer, config: loadConfig(root), force: rest.includes("--force"),
  });
  out(r);
  process.exit(r.ok || r.skipped ? 0 : 1);
} else if (cmd === "goal") {
  const root = PROJECT();
  if (rest.length) out({ file: setGoal(root, rest.join(" ")), goal: goal(root) });
  else out({ goal: goal(root) });
} else if (cmd === "notifications") {
  // What the loop told the orchestrator. The durable log is the notification; Herdr is a second sink.
  const root = PROJECT();
  if (rest.includes("--read")) { out({ marked_read: markAllRead(root) }); }
  else {
    const level = rest.includes("--level") ? rest[rest.indexOf("--level") + 1] : null;
    const rows = unread(root, { level });
    out({ unread: rows.length, target: orchestratorTarget(loadConfig(root)), notifications: rows });
  }
} else if (cmd === "notify-test") {
  // Prove the configured transport actually delivers, without running a ticket to find out.
  const root = PROJECT();
  const config = loadConfig(root);
  const r = await notify(root, rest.join(" ") || "SCH — transport test", { config, level: "info" });
  out({ ...r, hint: r.target ? undefined : "set orchestrator_agent in .sch-loop/config.md or SCH_ORCHESTRATOR_AGENT to enable out-of-band delivery" });
  process.exit(r.recorded ? 0 : 1);
} else if (cmd === "config") {
  out(loadConfig(PROJECT()));
} else if (cmd === "verify-phase") {
  // Goal-backward verification of a finished phase. The reviewer seat judges; it never runs the checks.
  const phase = rest[0];
  if (!phase) throw new Error("usage: verify-phase <n> [--check <argv...>]");
  const roles = loadRoles(PROJECT());
  const config = loadConfig(PROJECT());
  const argv = rest.includes("--check") ? rest.slice(rest.indexOf("--check") + 1) : (config.phase_verify_check || ["npm", "test"]);
  const r = await verifyPhase({ projectRoot: PROJECT(), phase, seat: roles.reviewer, checks: argv.length ? [{ name: argv.join(" "), command: argv[0], args: argv.slice(1) }] : [] });
  out({ phase: r.phase, status: r.status, why: r.why, truths: r.truths.length, gaps: r.gaps.length, file: r.file });
  process.exit(r.status === "passed" ? 0 : 1);
} else if (cmd === "ship") {
  const phase = rest[0];
  if (!phase) throw new Error("usage: ship <n> [--dry-run] [--base <branch>]");
  const config = loadConfig(PROJECT());
  const base = rest.includes("--base") ? rest[rest.indexOf("--base") + 1] : (config.base_branch || "main");
  const argv = config.phase_verify_check || ["npm", "test"];
  const r = await ship({
    projectRoot: PROJECT(), phase, base, dryRun: rest.includes("--dry-run"),
    checks: argv.length ? [{ name: argv.join(" "), command: argv[0], args: argv.slice(1) }] : [],
  });
  out({ decision: r.decision, prUrl: r.prUrl, branch: r.branch, base: r.base, gates: r.results.map(x => ({ name: x.name, ok: x.ok, why: x.why })), file: r.file });
  process.exit(r.ok ? 0 : 1);
} else {
  console.log(`Commands:
  run [--max N]            dispatch every ready ticket in task.md order
  ticket <id> [--dry-run]  run one ticket through fences → build → review → judge → deliver
  next | tasks             what runs next | every ticket parsed from task.md
  task-status <id> <glyph> set a status glyph ( ~ x ! ? )
  insert <spec.json|->     add a ticket (suffix id, task.md line, tickets/<id>.json)
  ticket-show <id> | ticket-validate <spec.json|->
  setup [--force] | seats  onboard this project | which CLIs are installed
  roles | fences | config | heartbeat
  dashboard [--port N]     roles page: which CLI, which model, which flags per seat
  progress [--json]        one screen: what is specified, what is built, what it cost
  log [-n N] [--follow]    the event stream, as sentences
  stages                   which lifecycle stages are done, and what runs next
  stage <id|next> [--goal] brainstorm | prd | architecture | plan
  plan-to-tickets          turn PLAN.md into task.md and the ticket JSONs
  goal [text]              read or set what this project is for
  notifications [--read]   what the loop told the orchestrator (--level info|warn|error)
  notify-test [text]       prove the configured transport delivers
  verify-phase <n>         goal-backward check that a finished phase delivers its goal
  ship <n> [--dry-run]     release gates, then open the pull request
  doctor | providers | status
  build <spec.json|-> | verify <spec.json|-> | council <spec.json|-> | council-show <id>`);
}
