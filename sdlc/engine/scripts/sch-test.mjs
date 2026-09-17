#!/usr/bin/env node
// SCH Loop — run the test suite under a lease, with a visible outer bound.
//
//   node scripts/sch-test.mjs                 # the FULL suite, under the lease
//   node scripts/sch-test.mjs --focused a b   # named files, refused while a full suite runs
//   node scripts/sch-test.mjs --status        # who holds the lease, and for how long
//   node scripts/sch-test.mjs --release       # recover a lease left by a killed run
//
// Three things this fixes, all of which actually happened:
//   * two full suites at once (the lease refuses the second);
//   * a suite with no visible progress (a heartbeat line every 30s);
//   * a suite with no outer bound (an explicit timeout that kills the tree).

import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as LOCK from "./suitelock.mjs";
import { killTree } from "./subprocess.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const has = (n) => argv.includes("--" + n);
const flag = (n) => { const i = argv.indexOf("--" + n); return i === -1 ? undefined : argv[i + 1]; };

const DEFAULT_OUTER_MS = 30 * 60 * 1000;

if (has("status")) {
  const s = LOCK.status();
  console.log(JSON.stringify({
    ...s, running_for_seconds: s.running_for_ms ? Math.round(s.running_for_ms / 1000) : null,
    note: s.state === "ACTIVE" ? "a full suite is running — do not start another and do not start focused tests"
      : s.state.startsWith("STALE") ? "a lease was left behind by a process that is gone; the next run recovers it"
      : "no suite is running",
  }, null, 2));
  process.exit(0);
}
if (has("release")) { console.log(JSON.stringify(LOCK.release(), null, 2)); process.exit(0); }

const focused = has("focused");
const files = focused ? argv.slice(argv.indexOf("--focused") + 1).filter((a) => !a.startsWith("--")) : [];
if (focused && !files.length) { console.error("error: --focused needs at least one test file"); process.exit(2); }

// A focused run beside a live full suite is refused, not queued.
if (focused) {
  const allowed = LOCK.focusedAllowed();
  if (!allowed.ok) { console.error("error: " + allowed.failure.message); process.exit(3); }
}

let lease = null;
if (!focused) {
  const got = LOCK.acquire({ label: "npm test (full regression suite)", command: "node --test test.mjs tests/*.test.mjs" });
  if (!got.ok) { console.error("error: " + got.failure.message); process.exit(4); }
  lease = got.lease;
  if (got.recovered) console.error(`[suite] recovered a stale lease from pid ${got.recovered.pid} (${got.recovered.why})`);
  console.error(`[suite] lease ${lease.lease_id} acquired (pid ${process.pid})`);
}

const outerMs = Number(flag("timeout-ms")) > 0 ? Number(flag("timeout-ms")) : DEFAULT_OUTER_MS;
const args = ["--test", ...(focused ? files : ["test.mjs", "tests/*.test.mjs"])];

const started = Date.now();
const child = spawn(process.execPath, args, { cwd: REPO, stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
  detached: process.platform !== "win32" });

// VISIBLE PROGRESS. `node --test` buffers, so a healthy run and a hung one look
// identical from outside — which is exactly the confusion that started all this.
const heartbeat = setInterval(() => {
  console.error(`[suite] still running, ${Math.round((Date.now() - started) / 1000)}s elapsed (outer bound ${Math.round(outerMs / 1000)}s)`);
}, 30000);
heartbeat.unref?.();

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`[suite] OUTER TIMEOUT after ${Math.round(outerMs / 1000)}s — killing the process tree`);
  console.error("[suite] " + JSON.stringify(killTree(child)));
}, outerMs);

const done = (code) => {
  clearTimeout(timer); clearInterval(heartbeat);
  if (lease) console.error("[suite] " + JSON.stringify(LOCK.release(lease.lease_id)));
  console.error(`[suite] finished in ${Math.round((Date.now() - started) / 1000)}s, exit ${code}${timedOut ? " (outer timeout)" : ""}`);
  process.exit(timedOut ? 124 : (code ?? 1));
};
child.on("close", (code) => done(code));
child.on("error", (e) => { console.error("[suite] failed to start: " + e.message); done(1); });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { killTree(child); done(130); });
