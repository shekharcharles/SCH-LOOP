#!/usr/bin/env node
// SCH Loop — dashboard lifecycle, driven by Claude Code SessionStart/SessionEnd
// hooks. Ref-counts live sessions: the dashboard starts on the first session and
// stops only when the LAST one ends. Concurrent sessions keep it up. Stale
// sessions (a crash where SessionEnd never fired) are pruned by TTL so it can
// never wedge.
//
//   node scripts/dashboard-ctl.mjs start   (SessionStart hook)
//   node scripts/dashboard-ctl.mjs stop    (SessionEnd hook)
//   node scripts/dashboard-ctl.mjs status
// Session id comes from argv[3] or the hook's stdin JSON (session_id).

import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REG = join(ROOT, ".sessions.json");
const PORT = Number(process.env.SCH_PORT || 4600);
const TTL_MS = 12 * 60 * 60 * 1000;             // prune sessions older than 12h

const portOpen = (p) => new Promise((r) => {
  const s = net.connect(p, "127.0.0.1");
  s.on("connect", () => { s.destroy(); r(true); });
  s.on("error", () => r(false));
  setTimeout(() => { s.destroy(); r(false); }, 500);
});
const load = () => { try { return JSON.parse(readFileSync(REG, "utf8")); } catch { return {}; } };
const save = (o) => { try { writeFileSync(REG, JSON.stringify(o)); } catch {} };
const prune = (o) => { const now = Date.now(); for (const k of Object.keys(o)) if (now - o[k] > TTL_MS) delete o[k]; return o; };

function startDashboard() {
  try {
    if (process.platform === "win32") {
      spawn("wscript.exe", [join(ROOT, "sch-dashboard-hidden.vbs")], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("node", [join(ROOT, "scripts", "dashboard.mjs")], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {}
}
function stopDashboard() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("cmd", ["/c", `netstat -ano | findstr :${PORT}`], { encoding: "utf8" });
      const pids = new Set();
      for (const l of out.split("\n")) { const m = l.match(/LISTENING\s+(\d+)/); if (m) pids.add(m[1]); }
      for (const p of pids) { try { execFileSync("taskkill", ["/F", "/PID", p], { stdio: "ignore" }); } catch {} }
    } else {
      const out = execFileSync("bash", ["-c", `lsof -ti:${PORT}`], { encoding: "utf8" });
      for (const p of out.split("\n").filter(Boolean)) { try { process.kill(+p); } catch {} }
    }
  } catch {}
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
if (cmd === "status") { const r = prune(load()); console.log(`sessions: ${Object.keys(r).length} · dashboard: ${await portOpen(PORT) ? "up" : "down"}`); process.exit(0); }

const id = await sid();
const reg = prune(load());
if (cmd === "start") {
  reg[id] = Date.now(); save(reg);
  if (!(await portOpen(PORT))) startDashboard();
} else if (cmd === "stop") {
  delete reg[id]; save(reg);
  if (Object.keys(reg).length === 0) stopDashboard();
}
