#!/usr/bin/env node
// SCH Loop — the ONE bounded subprocess implementation.
//
// WHY THIS EXISTS
// There were two ways to run a child process in this engine and they disagreed.
// The executor spawned workers, owned the clock and killed the whole process
// TREE. Verification used `execFileSync(..., { timeout })`, which signals only
// the direct child — so `npm test` spawning four workers left four survivors,
// and the parent could sit on their still-open pipes. Two cleanup
// implementations means one of them is wrong and nobody knows which.
//
// This is the single implementation. Both callers use it.
//
// TIMEOUT PRECEDENCE, which is the part that actually bit:
//
//     effective = min(command, phase remaining, task remaining,
//                     scheduler remaining, operator ceiling)
//
// A DEFAULT MUST NEVER OUTRANK A SMALLER CALLER CEILING. `verifyRecord` stamps
// every command with a 10-minute default, and the old code preferred it over an
// explicit 2-second operator limit — a run that asked for two seconds waited ten
// minutes and looked, convincingly, like a hang.
//
// PLATFORM HONESTY. Windows: `taskkill /T /F` walks the real tree. POSIX: the
// child leads its own process group, so a signal to -pid reaches the group. A
// grandchild that calls setsid escapes on both, and nothing here pretends
// otherwise. This is containment, not a sandbox.

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 5000;
const POST_KILL_WAIT_MS = 3000;   // after the tree is killed, how long we still wait for `close`

export const OUTCOMES = ["PASSED", "FAILED", "TIMEOUT", "CANCELLED", "ERROR"];

// ------------------------------------------------------- timeout precedence

// Every bound the system knows about, reduced to one number. `null`/`undefined`
// means "this layer has no opinion"; a layer that has one can only ever make the
// window SMALLER.
export function effectiveTimeout({ command = null, phaseRemaining = null, taskRemaining = null,
                                   schedulerRemaining = null, operatorCeiling = null, fallback = DEFAULT_TIMEOUT_MS } = {}) {
  const layers = [
    ["command", command], ["phase_remaining", phaseRemaining], ["task_remaining", taskRemaining],
    ["scheduler_remaining", schedulerRemaining], ["operator_ceiling", operatorCeiling],
  ].filter(([, v]) => Number.isFinite(Number(v)) && Number(v) > 0).map(([k, v]) => [k, Number(v)]);

  if (!layers.length)
    return { effective_ms: Math.max(1, Number(fallback)), decided_by: "fallback", considered: {} };

  // Ties go to the FIRST layer in the list above, which is deliberate: when a
  // command asks for exactly what the ceiling allows, the command is the honest
  // explanation.
  const [name, ms] = layers.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { effective_ms: Math.max(1, ms), decided_by: name, considered: Object.fromEntries(layers) };
}

// ------------------------------------------------------------- process tree

// Kill the child AND its descendants, and say how.
export function killTree(child, { platform = process.platform } = {}) {
  const pid = child?.pid;
  const evidence = { pid: pid ?? null, method: null, ok: false, detail: "", at: new Date().toISOString() };
  if (!pid) { evidence.detail = "no pid — the process never started"; return evidence; }
  try {
    if (platform === "win32") {
      evidence.method = "taskkill /T /F";
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "pipe" });
    } else {
      evidence.method = "SIGTERM to process group, SIGKILL after grace";
      try { process.kill(-pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
      const until = Date.now() + KILL_GRACE_MS;
      while (Date.now() < until && child.exitCode === null && child.signalCode === null) { /* bounded */ }
      try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    }
    evidence.ok = true;
  } catch (e) {
    // taskkill exits non-zero when the tree is already gone — that is success.
    const msg = String(e.stderr || e.message || "");
    evidence.ok = /not found|no running instance|nicht gefunden/i.test(msg);
    evidence.detail = msg.split("\n")[0].slice(0, 200);
  }
  return evidence;
}

// ----------------------------------------------------------- bounded output

function sink(limit) {
  const chunks = []; let kept = 0, total = 0, truncated = false;
  return {
    push(buf) {
      total += buf.length;
      if (kept >= limit) { truncated = true; return; }
      const room = limit - kept;
      if (buf.length > room) { chunks.push(buf.subarray(0, room)); kept += room; truncated = true; }
      else { chunks.push(buf); kept += buf.length; }
    },
    get text() { return Buffer.concat(chunks).toString("utf8"); },
    get evidence() { return { bytes_total: total, bytes_kept: kept, truncated, limit }; },
  };
}

// ------------------------------------------------------------------- run

// One process. Resolves with a terminal record whatever happens — a spawn
// failure, a timeout and a clean exit are all outcomes, never exceptions.
//
// `exe` + `args` only. There is no shell, ever: a filename with a space is one
// argument and a filename beginning with `-` is still a filename.
export function runProcess({
  exe, args = [], cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
  isCancelled = () => false, onStart = null, id = null,
}) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const out = sink(maxBytes), err = sink(maxBytes);

    let child = null;
    try {
      child = spawn(exe, args, {
        cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        detached: process.platform !== "win32",   // POSIX: own group, so the TREE is signallable
      });
    } catch (e) {
      return resolve(record({
        id, exe, args, cwd, startedAt, t0, outcome: "ERROR", exitCode: null, signal: null,
        out, err, cleanup: null, timeoutMs,
        error: `cannot start "${exe}": ${e.message}`,
      }));
    }
    if (onStart) { try { onStart(child); } catch {} }

    let settled = false, outcome = null, cleanup = null, error = null;
    const finish = (o, code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearInterval(cancelPoll);
      resolve(record({ id, exe, args, cwd, startedAt, t0, outcome: outcome ?? o, exitCode: code, signal, out, err, cleanup, timeoutMs, error }));
    };

    // The abandon path. Once the tree is killed we wait a BOUNDED moment for the
    // child to report, then settle regardless — waiting forever on a pipe that
    // may never close is the exact failure this module exists to remove.
    const terminate = (why) => {
      outcome = why;
      cleanup = killTree(child);
      const abandon = setTimeout(() => {
        if (cleanup) cleanup.abandoned_after_ms = POST_KILL_WAIT_MS;
        finish(why, null, "SIGKILL");
      }, POST_KILL_WAIT_MS);
      abandon.unref?.();
    };

    const timer = setTimeout(() => terminate("TIMEOUT"), Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    const cancelPoll = setInterval(() => {
      let c = false;
      try { c = isCancelled(); } catch {}
      if (c && !settled && !outcome) terminate("CANCELLED");
    }, 250);
    cancelPoll.unref?.();

    child.stdout?.on("data", (b) => out.push(b));
    child.stderr?.on("data", (b) => err.push(b));
    child.on("error", (e) => {
      error = e.code === "ENOENT" ? `executable not found: ${exe}` : `${exe}: ${e.message}`;
      outcome = outcome ?? "ERROR";
      finish("ERROR", null, null);
    });
    child.on("close", (code, signal) => finish(code === 0 ? "PASSED" : "FAILED", code, signal));
  });
}

function record({ id, exe, args, cwd, startedAt, t0, outcome, exitCode, signal, out, err, cleanup, timeoutMs, error }) {
  const ended = Date.now();
  return {
    schema_version: SCHEMA_VERSION,
    id: id ?? null, executable: exe, args: [...args], cwd: cwd ?? null,
    // The argument vector as a human reads it. Display only — what RAN is `args`.
    display: [exe, ...args].map((a) => (/\s/.test(String(a)) ? JSON.stringify(String(a)) : String(a))).join(" "),
    outcome, exit_code: exitCode, signal: signal ?? null,
    timed_out: outcome === "TIMEOUT", cancelled: outcome === "CANCELLED",
    spawn_error: error ?? null,
    timeout_ms: timeoutMs,
    started_at: startedAt, ended_at: new Date(ended).toISOString(), duration_ms: ended - t0,
    stdout: out.text, stderr: err.text,
    stdout_evidence: out.evidence, stderr_evidence: err.evidence,
    output_bytes: out.evidence.bytes_total + err.evidence.bytes_total,
    // Present only when SCH had to kill something. Its absence means the process
    // ended on its own.
    cleanup: cleanup ?? null,
  };
}

// A stable hash of what was run and what came back — the evidence identity a
// gate report or a compacted result can point at.
export const processHash = (rec) => createHash("sha256").update(JSON.stringify({
  executable: rec.executable, args: rec.args, outcome: rec.outcome,
  exit_code: rec.exit_code, stdout: rec.stdout, stderr: rec.stderr,
})).digest("hex");
