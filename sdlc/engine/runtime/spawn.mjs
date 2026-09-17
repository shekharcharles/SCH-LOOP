// One role process, watched. Prompt on stdin, argv from roles.json, no shell string ever.
// Reads Claude's `--output-format stream-json` lines when present (one JSON per event) and
// falls back to plain text for CLIs that do not stream. Liveness signals (design §3.14):
// heartbeat = last event age, loop = same tool sequence repeated, silence = no output.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { killTree } from "../scripts/subprocess.mjs";
import { locateExe } from "./roles.mjs";

const sig = (name, input) => `${name}:${createHash("sha1").update(JSON.stringify(input ?? {})).digest("hex").slice(0, 10)}`;

// True when the last `window * repeats` signatures are the same window repeated `repeats` times.
export function isLooping(sigs, window = 4, repeats = 3) {
  const n = window * repeats;
  if (sigs.length < n) return false;
  const tail = sigs.slice(-n);
  const first = tail.slice(0, window).join("|");
  for (let r = 1; r < repeats; r++) if (tail.slice(r * window, (r + 1) * window).join("|") !== first) return false;
  return true;
}

export function parseStreamLine(line) {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try { return JSON.parse(t); } catch { return null; }
}

export async function runRole({ exe, args = [], cwd, prompt, env = process.env, timeoutMs = 30 * 60_000, silenceMs = 0,
  onEvent = null, loopWindow = 4, loopRepeats = 3, maxBytes = 4 * 1024 * 1024 }) {
  const command = await locateExe(exe);
  const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const startedAt = Date.now();
  const events = [], sigs = [];
  let stdout = "", stderr = "", text = "", usage = null, cost = null, sessionId = null, model = null, buf = "";
  let outcome = null, kill = null, lastEventAt = Date.now();

  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], shell: needsShell });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);

    let settled = false;
    const done = (o, code) => {
      if (settled) return; settled = true;
      clearTimeout(hard); clearInterval(quiet);
      const out = { outcome: outcome ?? o, exitCode: code, text: text || stdout.trim(), stdout, stderr, usage, cost, sessionId, model,
        events, lastEventAt: new Date(lastEventAt).toISOString(), durationMs: Date.now() - startedAt, kill, command, args };
      resolve(out);
    };
    const terminate = (why) => { outcome = why; kill = killTree(child); setTimeout(() => done(why, null), 1500).unref?.(); };
    const hard = setTimeout(() => terminate("TIMEOUT"), timeoutMs);
    const quiet = silenceMs > 0 ? setInterval(() => { if (Date.now() - lastEventAt > silenceMs) terminate("SILENT"); }, 1000) : null;
    quiet?.unref?.();

    const note = (ev) => { events.push({ at: new Date().toISOString(), ...ev }); if (onEvent) { try { onEvent(ev); } catch {} } };
    const handle = (obj) => {
      lastEventAt = Date.now();
      if (obj.type === "system" && obj.subtype === "init") { sessionId = obj.session_id || null; note({ type: "init" }); return; }
      if (obj.type === "assistant") {
        model = obj.message?.model || model;
        for (const c of obj.message?.content || []) {
          if (c.type === "tool_use") { sigs.push(sig(c.name, c.input)); note({ type: "tool", tool: c.name }); }
          else if (c.type === "text" && c.text) { note({ type: "text", chars: c.text.length }); }
        }
        if (isLooping(sigs, loopWindow, loopRepeats)) { note({ type: "loop", window: sigs.slice(-loopWindow) }); terminate("LOOP"); }
        return;
      }
      if (obj.type === "result" || obj.usage) {
        if (typeof obj.result === "string") text = obj.result;
        usage = obj.usage || usage; cost = obj.total_cost_usd ?? cost; sessionId = obj.session_id || sessionId;
        note({ type: "result" });
      }
    };

    child.stdout.on("data", (d) => {
      const s = String(d);
      if (stdout.length < maxBytes) stdout += s;
      lastEventAt = Date.now();
      buf += s;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const obj = parseStreamLine(line);
        if (obj) handle(obj); else if (line.trim()) note({ type: "line" });
      }
    });
    child.stderr.on("data", (d) => { if (stderr.length < maxBytes) stderr += String(d); lastEventAt = Date.now(); });
    child.on("error", (e) => { stderr += `\n${e.message}`; done("ERROR", null); });
    child.on("close", (code) => { if (buf.trim()) { const o = parseStreamLine(buf); if (o) handle(o); } done(code === 0 ? "PASSED" : "FAILED", code); });
  });
}

// Peak context-window occupancy: the largest single turn, not the session total.
//
// The obvious version of this — summing the top-level input + cache_read + cache_creation — is what this
// used to do, and it is wrong in a way that looks plausible. In an agentic session the API reports
// `cache_read_input_tokens` CUMULATIVELY: the same cached prefix is counted once per turn. A ticket whose
// window never exceeded 52k reported 547k, and one that took fewer turns reported 99k for the same amount
// of real work. Measured across every ticket the lab has run, the two numbers have no relationship:
//
//   reported by the old sum   99k – 547k, tracking turn COUNT
//   actual peak window        44k –  52k, tracking the work
//
// The §3.7 context policy compares against this number, so as written the gate was reading a billing
// total and calling it window pressure. `usage.iterations[]` carries the per-message figures; the top
// level is only correct when there was a single turn.
export function contextTokens(usage) {
  if (!usage) return null;
  const turn = u => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const its = Array.isArray(usage.iterations) ? usage.iterations : [];
  return its.length ? Math.max(...its.map(turn)) : turn(usage);
}

// What the session cost to run, which is a different question from what it had to hold at once. Kept
// separate and named for what it is, so neither is ever quietly used for the other.
export function sessionTokens(usage) {
  if (!usage) return null;
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
}

export const RATE_LIMIT_RE = /rate.?limit|overloaded|too many requests|\b429\b|quota/i;
