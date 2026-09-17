#!/usr/bin/env node
// SCH Loop — per-project run control: start, pause, resume, stop.
//
// WHY THIS EXISTS
// The queue runner is a foreground process you had to launch from a terminal and
// babysit: it exits at every human gate, and resuming meant typing the command
// again. An operator with fifty projects and a phone cannot do that, so the loop
// was only ever as autonomous as the person watching it.
//
// This owns the process, not the work. It spawns `sch-run-queue.mjs` detached,
// remembers the operator's INTENT, and re-spawns while that intent is RUNNING
// and there is work to do. Nothing here decides what to build, what passes, or
// what ships — the scheduler and its gates keep every one of those decisions.
//
// STOPPING IS NEVER A KILL. Pause and stop release the scheduler's lease, which
// the scheduler checks before each task; it finishes the task in flight and
// exits with SCHEDULER_LEASE_LOST. A delivery mid-transaction is never torn in
// half. That is why there is no "force" here: the graceful path is the only one.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SCH_HOME || join(HERE, "..");

// RUNNING is the only intent that re-spawns. PAUSED and STOPPED differ in
// meaning to the operator, not to the machine: both let the current task finish
// and start nothing new. Keeping them distinct is what makes the dashboard
// honest — "I paused this" and "I stopped this" are different answers to "why is
// nothing happening", and a supervisor that collapsed them would lose that.
export const INTENTS = ["RUNNING", "PAUSED", "STOPPED"];

const ctlPath = (projectId) => join(ROOT, "projects", projectId, "supervisor.json");
const logPath = (projectId) => join(ROOT, "projects", projectId, "supervisor.log");

export function readControl(projectId) {
  try { return JSON.parse(readFileSync(ctlPath(projectId), "utf8")); }
  catch { return { intent: "STOPPED", pid: null, started_at: null, max_tasks: null, last_exit: null }; }
}

function writeControl(projectId, patch) {
  const p = ctlPath(projectId);
  mkdirSync(dirname(p), { recursive: true });
  const next = { ...readControl(projectId), ...patch, updated_at: new Date().toISOString() };
  writeFileSync(p, JSON.stringify(next, null, 2));
  return next;
}

// A recorded PID is a claim, not a fact — the process may have exited, and on a
// long-lived machine the number may since belong to something else entirely.
// Signal 0 asks the OS whether we may signal it, which answers "does this pid
// exist and is it ours" without touching it.
export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function status(projectId) {
  const c = readControl(projectId);
  const running = isAlive(c.pid);
  return {
    project: projectId,
    intent: c.intent ?? "STOPPED",
    process: running ? "RUNNING" : "NOT_RUNNING",
    pid: running ? c.pid : null,
    started_at: c.started_at ?? null,
    last_exit: c.last_exit ?? null,
    // What the operator actually wants to know, in one word.
    state: running ? "RUNNING" : (c.intent === "RUNNING" ? "EXITED" : c.intent ?? "STOPPED"),
  };
}

// Detached, with its own log. If SCH held the pipes the queue would die with the
// dashboard that started it, and a run must outlive the page that launched it.
// START MEANS START. An operator who adds work on the dashboard and presses
// Start expects that work to run; before this, the inbox was never read by the
// autonomous path and the queue reported PROJECT_COMPLETED in 74ms with the
// request still sitting there. Planning happens FIRST, in its own process, so a
// planner that fails cannot take the queue down with it — and so the queue
// still runs when there is nothing to plan.
export function start(projectId, { maxTasks = 50, env = process.env, planInbox = true } = {}) {
  const c = readControl(projectId);
  if (isAlive(c.pid)) return { ok: true, already: true, ...status(projectId) };

  if (planInbox) {
    try {
      const log = logPath(projectId);
      mkdirSync(dirname(log), { recursive: true });
      const fd = openSync(log, "a");
      const child = spawn(process.execPath,
        [join(HERE, "run-with-inbox.mjs"), "--project", projectId, "--max-tasks", String(maxTasks)],
        { cwd: HERE, detached: true, windowsHide: true, stdio: ["ignore", fd, fd],
          env: { ...env, SCH_HOME: ROOT } });
      child.unref();
      writeControl(projectId, { intent: "RUNNING", pid: child.pid, started_at: new Date().toISOString(),
                                max_tasks: maxTasks, last_exit: null });
      return { ok: true, already: false, ...status(projectId) };
    } catch { /* fall through to the plain queue below */ }
  }

  const log = logPath(projectId);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  const child = spawn(process.execPath,
    [join(HERE, "sch-run-queue.mjs"), "--project", projectId, "--max-tasks", String(maxTasks)],
    // windowsHide matters BECAUSE of detached: on Windows a detached child gets
    // its own console window, so every start flashed a black box on the desktop
    // — and one per click, since the queue exits at each gate. Every other spawn
    // in this engine already sets it; this one was new and did not.
    { cwd: HERE, detached: true, windowsHide: true, stdio: ["ignore", fd, fd],
      env: { ...env, SCH_HOME: ROOT } });
  child.unref();

  writeControl(projectId, { intent: "RUNNING", pid: child.pid, started_at: new Date().toISOString(),
                            max_tasks: maxTasks, last_exit: null });
  return { ok: true, already: false, ...status(projectId) };
}

// Releasing the lease IS the stop. Import lazily so this module stays usable
// (for status) in an environment where the scheduler's own deps are unhappy.
async function releaseLease(projectId) {
  try {
    const [WS, S, ST] = await Promise.all([
      import("./workspace.mjs"), import("./scheduler.mjs"), import("./state.mjs")]);
    const p = ST.getProject(projectId);
    if (!p) return { released: false, reason: "no such project" };
    const wsDir = WS.resolveWorkspaceDir(WS.repositoryRoot(p.path) ?? p.path, { mustExist: true });
    const live = S.liveSchedulerLease(wsDir);
    if (!live) return { released: false, reason: "no live scheduler" };
    return { ...S.releaseSchedulerLease(wsDir, live.scheduler_id), scheduler_id: live.scheduler_id };
  } catch (e) { return { released: false, reason: e.message }; }
}

export async function pause(projectId) {
  const r = await releaseLease(projectId);
  writeControl(projectId, { intent: "PAUSED" });
  return { ok: true, ...status(projectId), lease: r,
           note: "the task in flight finishes; nothing new starts" };
}

export async function stop(projectId) {
  const r = await releaseLease(projectId);
  writeControl(projectId, { intent: "STOPPED" });
  return { ok: true, ...status(projectId), lease: r,
           note: "the task in flight finishes; nothing new starts" };
}

export function resume(projectId, opts = {}) {
  const c = readControl(projectId);
  return start(projectId, { maxTasks: c.max_tasks ?? 50, ...opts });
}

// ------------------------------------------------------------------- CLI

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("supervisor.mjs")) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n) => { const i = rest.indexOf("--" + n); return i === -1 ? undefined : rest[i + 1]; };
  const project = flag("project") ?? rest[0];
  const die = (m) => { console.error("error: " + m); process.exit(2); };
  if (!project) die("need --project <id>");
  const show = (o) => console.log(JSON.stringify(o, null, 2));
  const maxTasks = Number(flag("max-tasks") ?? 50);
  const run = {
    start: () => show(start(project, { maxTasks })),
    resume: () => show(resume(project, { maxTasks })),
    pause: async () => show(await pause(project)),
    stop: async () => show(await stop(project)),
    status: () => show(status(project)),
  }[cmd];
  if (!run) die(`unknown command "${cmd ?? ""}" — start | pause | resume | stop | status`);
  await run();
}
