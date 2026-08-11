#!/usr/bin/env node
// SCH Loop — dashboard lifecycle, driven by Claude Code SessionStart/SessionEnd
// hooks. Ref-counts live sessions: the dashboard starts on the first session and
// stops only when the LAST one ends. Concurrent sessions keep it up.
//
//   node scripts/dashboard-ctl.mjs start   (SessionStart hook)
//   node scripts/dashboard-ctl.mjs stop    (SessionEnd hook)
//   node scripts/dashboard-ctl.mjs status
// Session id comes from argv[3] or the hook's stdin JSON (session_id).
//
// FOUR THINGS THIS GETS RIGHT, each of which used to be wrong:
//
//  1. A CRASHED SESSION LEAKS A REFERENCE. SessionEnd never fires on a SIGKILL,
//     a closed lid or a power cut, so that id sits in the registry forever and
//     the count never reaches zero. Entries expire, and expiry is evaluated on
//     every call — so the next real session to end takes the dashboard with it
//     rather than being outvoted by ghosts.
//
//  2. SIMULTANEOUS STARTS ARE A RACE. Five terminals opening at once could all
//     see the port closed inside the probe window and all spawn; four then died
//     silently on EADDRINUSE. An atomic lock file decides the winner, and the
//     dashboard itself now exits cleanly when it loses.
//
//  3. STOP KILLED BY PORT. It asked the OS what was LISTENING and killed it,
//     which is whatever holds the port — not necessarily this dashboard. The
//     dashboard writes its own pidfile; stop reads that and kills only what is
//     written there. No pidfile means nothing to stop, and it says so.
//
//  4. THE DEFAULT WAS LOOPBACK. An auto-started dashboard on 127.0.0.1 cannot
//     be reached from a phone. Bind and port come from the environment and are
//     reported by `status`, so what the hook launches is what you can open.

import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync, closeSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REG = join(ROOT, ".sessions.json");
const PIDFILE = join(ROOT, "dashboard.pid");
const LOCK = join(ROOT, ".dashboard-start.lock");
const PORT = Number(process.env.SCH_PORT || 4600);
const BIND = process.env.SCH_BIND || "127.0.0.1";
// A session that has not been heard from in this long is gone. Long enough to
// survive a laptop lid; short enough that one crash does not pin the dashboard
// up for the rest of the day.
const TTL_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;

// Probe the address the dashboard actually binds to. Probing loopback while the
// dashboard listens on a LAN address reports "down" for a dashboard that is up,
// and the hook then starts a second one.
const portOpen = (p, host) => new Promise((r) => {
  const s = net.connect(p, host === "0.0.0.0" ? "127.0.0.1" : host);
  const done = (v) => { try { s.destroy(); } catch {} r(v); };
  s.on("connect", () => done(true));
  s.on("error", () => done(false));
  setTimeout(() => done(false), 500);
});

const load = () => { try { return JSON.parse(readFileSync(REG, "utf8")); } catch { return {}; } };
const save = (o) => { try { writeFileSync(REG, JSON.stringify(o)); } catch {} };
const prune = (o) => { const now = Date.now(); for (const k of Object.keys(o)) if (!(now - o[k] < TTL_MS)) delete o[k]; return o; };

function readPidfile() {
  try {
    const d = JSON.parse(readFileSync(PIDFILE, "utf8"));
    if (!d?.pid) return null;
    // A recorded pid is a claim, not a fact: the process may have exited, and on
    // a long-lived machine the number may since belong to something else.
    try { process.kill(d.pid, 0); } catch { return null; }
    return d;
  } catch { return null; }
}

// Only one process may spawn a dashboard. `wx` fails if the file exists, which
// is the whole mechanism — it is atomic on every platform we run on.
function takeStartLock() {
  try { const fd = openSync(LOCK, "wx"); closeSync(fd); return true; }
  catch {
    // A lock left behind by a process that died mid-spawn must not wedge every
    // future session. Anything older than a spawn could possibly take is stale.
    try { if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) { unlinkSync(LOCK); const fd = openSync(LOCK, "wx"); closeSync(fd); return true; } } catch {}
    return false;
  }
}
const releaseStartLock = () => { try { unlinkSync(LOCK); } catch {} };

function startDashboard() {
  try {
    const env = { ...process.env, SCH_PORT: String(PORT), SCH_BIND: BIND };
    if (process.platform === "win32") {
      // wscript gives us no pid, which is exactly why the dashboard writes its
      // own pidfile rather than us guessing from the outside.
      spawn("wscript.exe", [join(ROOT, "sch-dashboard-hidden.vbs")], { detached: true, stdio: "ignore", windowsHide: true, env }).unref();
    } else {
      spawn(process.execPath, [join(ROOT, "scripts", "dashboard.mjs")], { detached: true, stdio: "ignore", env }).unref();
    }
  } catch {}
}

function stopDashboard() {
  const d = readPidfile();
  if (!d) return { stopped: false, why: "no live dashboard recorded in dashboard.pid" };
  // Refuse to stop a dashboard that is not the one this invocation manages —
  // two engine homes, or a deliberately-launched second instance on another
  // port, must never end up killing each other.
  if (d.port && Number(d.port) !== PORT)
    return { stopped: false, why: `dashboard.pid holds pid ${d.pid} on port ${d.port}, not ${PORT} — leaving it alone` };
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/F", "/PID", String(d.pid)], { stdio: "ignore", windowsHide: true });
    else process.kill(d.pid);
    try { unlinkSync(PIDFILE); } catch {}
    return { stopped: true, pid: d.pid };
  } catch (e) { return { stopped: false, why: e.message }; }
}

async function sid() {
  if (process.argv[3]) return process.argv[3];
  // read hook stdin (JSON with session_id); fall back to a random id
  try {
    const chunks = []; for await (const c of process.stdin) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString())?.session_id || "sess-" + Date.now();
  } catch { return "sess-" + Date.now(); }
}

const cmd = process.argv[2];

if (cmd === "status") {
  const r = prune(load());
  const d = readPidfile();
  const up = d ? true : await portOpen(PORT, BIND);
  console.log(`sessions: ${Object.keys(r).length} · dashboard: ${up ? "up" : "down"}` +
    (d ? ` (pid ${d.pid}) http://${d.bind}:${d.port}` : ` · would bind ${BIND}:${PORT}`));
  process.exit(0);
}

const id = await sid();
const reg = prune(load());

if (cmd === "start") {
  reg[id] = Date.now(); save(reg);
  if (readPidfile() || await portOpen(PORT, BIND)) process.exit(0);   // already serving
  if (!takeStartLock()) process.exit(0);                              // another session is starting one
  try { startDashboard(); } finally { setTimeout(releaseStartLock, 4000).unref?.(); }
} else if (cmd === "stop") {
  delete reg[id]; save(reg);
  // Expired ids were dropped above, so a crashed session cannot outvote a real
  // one indefinitely — the next genuine close still ends the dashboard.
  if (Object.keys(reg).length === 0) {
    const r = stopDashboard();
    if (!r.stopped && r.why) console.error("dashboard-ctl: " + r.why);
  }
} else {
  console.error(`unknown command "${cmd ?? ""}" — start | stop | status`);
  process.exit(2);
}
