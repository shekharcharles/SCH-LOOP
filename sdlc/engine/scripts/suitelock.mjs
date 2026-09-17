#!/usr/bin/env node
// SCH Loop — the full-test-suite lease.
//
// WHY THIS EXISTS, from a real incident
// Two complete regression suites were started minutes apart. `node --test`
// buffers its output, so both files stayed at zero bytes and neither looked
// alive. A ten-minute verification timeout in one of them — legitimate, just
// slow — was then read as a hang, because zero CPU for thirty seconds looks
// identical to a hang when you cannot see progress. The diagnosis was wrong, and
// the wrong diagnosis produced a rewrite of proven code.
//
// Two suites should never have been running. This makes that structural rather
// than remembered:
//
//     one full suite at a time, per repository, with a visible holder.
//
// It is a LEASE, not a mutex: it records who holds it, since when, and with what
// PID, so a stale one left by a killed process is recoverable with evidence
// instead of being either obeyed forever or ignored blindly.

import { mkdirSync, existsSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

export const SCHEMA_VERSION = 1;

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
export const lockDir = () => join(process.env.SCH_HOME || REPO, ".locks");
export const lockPath = () => join(lockDir(), "test-suite.json");

// Generous: a full suite legitimately takes minutes, and expiring a live one is
// worse than waiting for a dead one.
export const DEFAULT_TTL_MS = 60 * 60 * 1000;

const now = () => new Date().toISOString();
const pidAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; } };

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function read() {
  try { return JSON.parse(readFileSync(lockPath(), "utf8")); } catch { return null; }
}

// Is somebody genuinely running a full suite right now? Distinguishes the three
// answers that matter: nobody, somebody alive, and a corpse.
export function status() {
  const held = read();
  if (!held) return { held: false, state: "FREE" };
  const expired = !held.expires_at || new Date(held.expires_at).getTime() < Date.now();
  const alive = held.pid && pidAlive(held.pid);
  if (alive && !expired)
    return { held: true, state: "ACTIVE", lease: held,
      running_for_ms: Date.now() - new Date(held.acquired_at).getTime() };
  return { held: false, state: expired ? "STALE_EXPIRED" : "STALE_DEAD", lease: held,
    why: expired ? `the lease expired at ${held.expires_at}` : `pid ${held.pid} is gone` };
}

// Take it, or refuse and say who has it. Never steals a live lease.
export function acquire({ label = "full suite", command = null, ttlMs = DEFAULT_TTL_MS } = {}) {
  const s = status();
  if (s.state === "ACTIVE")
    return { ok: false, failure: { code: "SUITE_ALREADY_RUNNING", message:
      `a full test suite is already running: ${s.lease.label} (pid ${s.lease.pid}, started ${s.lease.acquired_at}, ${Math.round(s.running_for_ms / 1000)}s ago).\n` +
      `  Two complete suites at once is how a slow test gets misread as a hang. Wait for it, or stop it:\n` +
      `    node scripts/sch-test.mjs --status` }, held: s.lease };

  const lease = {
    schema_version: SCHEMA_VERSION,
    lease_id: "SUITE-" + randomBytes(5).toString("hex").toUpperCase(),
    label, command, pid: process.pid, ppid: process.ppid ?? null,
    acquired_at: now(), expires_at: new Date(Date.now() + ttlMs).toISOString(),
    host: process.env.COMPUTERNAME || process.env.HOSTNAME || null,
    recovered_from: s.state.startsWith("STALE") ? { ...s.lease, why: s.why } : null,
  };
  writeAtomic(lockPath(), JSON.stringify(lease, null, 2));
  return { ok: true, lease, recovered: lease.recovered_from };
}

export function release(leaseId = null) {
  const held = read();
  if (!held) return { released: false, reason: "no lease held" };
  if (leaseId && held.lease_id !== leaseId) return { released: false, reason: "SUITE_LEASE_LOST — a different lease is held" };
  try { unlinkSync(lockPath()); return { released: true, lease_id: held.lease_id }; }
  catch (e) { return { released: false, reason: e.message }; }
}

// A focused run must not start while a full suite is active — the two compete
// for the same temporary directories and the same CPU, which is how a focused
// run "proves" something the full suite then contradicts.
export function focusedAllowed() {
  const s = status();
  if (s.state !== "ACTIVE") return { ok: true };
  return { ok: false, failure: { code: "FULL_SUITE_ACTIVE", message:
    `the full suite (${s.lease.label}, pid ${s.lease.pid}) is running. Focused tests must not run beside it.` } };
}
