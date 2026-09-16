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

const PROTECTED = [/(^|[\\/])\.sch-loop[\\/]private([\\/]|$)/, /(^|[\\/])\.env(\.|$)/, /\.pem$/, /(^|[\\/])\.claude[\\/](sch|hooks)([\\/]|$)/];
const CURATED = [/(^|[\\/])task\.md$/, /(^|[\\/])CLAUDE\.md$/, /(^|[\\/])\.sch-loop[\\/](PRD|PLAN|ARCHITECTURE|BRAINSTORM)\.md$/];
const SHRINK_RATIO = 0.4, FLOOR_LINES = 40;

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
      const oldN = lines(fs.readFileSync(target, "utf8")), newN = lines(d.tool_input.content || "");
      if (oldN >= FLOOR_LINES && newN < oldN * SHRINK_RATIO) deny(`Write would shrink ${rel} from ${oldN} to ${newN} lines. Use Edit for scoped changes.`);
    }
    const stateFile = path.join(root, ".sch-loop", "state.json");
    if (fs.existsSync(stateFile)) {
      const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (st.current_task) {
        const tf = path.join(root, ".sch-loop", "tickets", `${st.current_task}.json`);
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
