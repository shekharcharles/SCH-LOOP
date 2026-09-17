#!/usr/bin/env node
// SCH-LOOP fence 2 of 3: PreToolUse guard for Write | Edit | MultiEdit.
// Blocks (exit 2, reason on stderr):
//   1. any write outside the project directory
//   2. any write to a protected path
//   3. a whole-file Write that shrinks a curated file below 40% (GSD #973 pattern)
//   4. when a ticket is active, any write outside its allowed_paths
// Fails OPEN on its own errors (a broken guard must not wedge every edit) — except
// rule 1, which is checked before anything that can throw.

import fs from "node:fs";
import path from "node:path";

// Every pattern here is case-INSENSITIVE, and that flag is load-bearing: the paths these are tested
// against are lowercased first (Windows and macOS filesystems are case-insensitive, so a differently
// cased path is the same real file). Without `i`, `CLAUDE.md` and `PRD|PLAN|ARCHITECTURE|BRAINSTORM`
// could never match anything — measured: the CLAUDE.md guard was dead from the day it was written,
// and only `task.md` worked, because it happens to be lowercase already.
const PROTECTED = [/(^|[\\/])\.sch-loop[\\/]private([\\/]|$)/i, /(^|[\\/])\.env(\.|$)/i, /\.pem$/i, /(^|[\\/])\.claude[\\/](sch|hooks)([\\/]|$)/i];
const CURATED = [/(^|[\\/])task\.md$/i, /(^|[\\/])CLAUDE\.md$/i, /(^|[\\/])\.sch-loop[\\/](PRD|PLAN|ARCHITECTURE|BRAINSTORM)\.md$/i];
// The floor exists so a stub being legitimately rewritten does not trip the ratio. 40 lines is the
// right floor for arbitrary prose, but CURATED is a short, explicit allowlist of files whose whole
// purpose is to accumulate — a 30-line CLAUDE.md cut to one line is destructive at that size too.
const SHRINK_RATIO = 0.4, FLOOR_LINES = 10;
// task.md is a queue, not prose: a whole-file Write that drops tickets is destructive at any size, and
// the 40-line floor let an eight-line queue be erased without a word. Count the ticket lines instead.
const TICKET_LINE = /^- \[[ ~x!?]\] T\d/;
const ticketLines = t => String(t || "").split("\n").filter(l => TICKET_LINE.test(l)).length;

const norm = p => path.resolve(p).replace(/\\/g, "/").toLowerCase();
const lines = t => t ? t.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === "")).length : 0;
const globToRe = g => new RegExp("^" + g.replace(/\\/g, "/").replace(/[.+^${}()|[\]]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$", "i");
const deny = msg => { process.stderr.write(`[sch write-guard] BLOCKED: ${msg}\n`); process.exit(2); };

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => raw += c);
process.stdin.on("end", () => {
  let d; try { d = JSON.parse(raw); } catch { process.exit(0); }
  if (!["Write", "Edit", "MultiEdit"].includes(d.tool_name)) process.exit(0);
  const fp = d.tool_input?.file_path; if (typeof fp !== "string" || !fp) process.exit(0);
  const root = norm(process.env.CLAUDE_PROJECT_DIR || d.cwd || process.cwd());
  const target = norm(path.isAbsolute(fp) ? fp : path.join(d.cwd || process.cwd(), fp));
  if (target !== root && !target.startsWith(root + "/")) deny(`${fp} is outside the project (${root})`);
  const rel = target.slice(root.length + 1);
  try {
    if (PROTECTED.some(r => r.test(rel))) deny(`${rel} is a protected path`);
    if (d.tool_name === "Write" && CURATED.some(r => r.test(rel)) && fs.existsSync(target)) {
      const before = fs.readFileSync(target, "utf8"), after = d.tool_input.content || "";
      if (/(^|[\\/])task\.md$/.test(rel)) {
        const oldT = ticketLines(before), newT = ticketLines(after);
        if (newT < oldT) deny(`Write would drop ${oldT - newT} of ${oldT} tickets from ${rel}. Use Edit, or the engine's task-status / insert commands.`);
      }
      const oldN = lines(before), newN = lines(after);
      if (oldN >= FLOOR_LINES && newN < oldN * SHRINK_RATIO) deny(`Write would shrink ${rel} from ${oldN} to ${newN} lines. Use Edit for scoped changes.`);
    }
    const stateFile = path.join(root, ".sch-loop", "state.json");
    if (fs.existsSync(stateFile)) {
      const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (st.current_task) {
        // Tickets are stored as `<id>-<slug>.json`. Looking only for `<id>.json` made this whole
        // branch a silent no-op: the path boundary was never enforced, and the guard reported success.
        const dir = path.join(root, ".sch-loop", "tickets");
        const hit = fs.existsSync(dir) ? fs.readdirSync(dir).find(f => f === `${st.current_task}.json` || (f.startsWith(`${st.current_task}-`) && f.endsWith(".json"))) : null;
        const tf = hit ? path.join(dir, hit) : path.join(dir, `${st.current_task}.json`);
        if (fs.existsSync(tf)) {
          const t = JSON.parse(fs.readFileSync(tf, "utf8"));
          const allowed = Array.isArray(t.allowed_paths) ? t.allowed_paths : [];
          const inLoop = rel.startsWith(".sch-loop/") || rel === "task.md";
          if (allowed.length && !inLoop && !allowed.some(g => globToRe(g).test(rel))) deny(`${rel} is outside allowed_paths of ${st.current_task}: ${allowed.join(", ")}`);
        }
      }
    }
  } catch (e) { process.stderr.write(`[sch write-guard] warn: ${e.message}\n`); }
  process.exit(0);
});
