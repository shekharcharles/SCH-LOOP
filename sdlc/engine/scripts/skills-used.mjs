#!/usr/bin/env node
// SCH Loop — which skills were ACTUALLY used?
//
// The dashboard's per-task skill list is self-reported by the agent. This reads
// the ground truth instead: Claude Code writes every real Skill invocation into
// its session transcripts (~/.claude/projects/<encoded-cwd>/<session>.jsonl).
// If a skill shows up here, it genuinely ran.
//
//   node scripts/skills-used.mjs                 # all sessions, grouped
//   node scripts/skills-used.mjs --dir pmcms     # only transcript dirs matching "pmcms"
//   node scripts/skills-used.mjs --since 2h      # last 2 hours (m/h/d)
//   node scripts/skills-used.mjs --list          # one line per invocation

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(homedir(), ".claude", "projects");
const f = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) f[a.slice(2)] = (process.argv[i + 1]?.startsWith("--") ?? true) ? true : process.argv[++i];
}

const sinceMs = (() => {
  if (!f.since || f.since === true) return 0;
  const m = String(f.since).match(/^(\d+)([mhd])$/);
  if (!m) return 0;
  return Date.now() - Number(m[1]) * { m: 6e4, h: 36e5, d: 864e5 }[m[2]];
})();

if (!existsSync(ROOT)) { console.error("no transcripts at " + ROOT); process.exit(1); }

const hits = [];
for (const dir of readdirSync(ROOT)) {
  if (f.dir && f.dir !== true && !dir.toLowerCase().includes(String(f.dir).toLowerCase())) continue;
  const dpath = join(ROOT, dir);
  let files = [];
  try { files = readdirSync(dpath).filter((x) => x.endsWith(".jsonl")); } catch { continue; }
  for (const file of files) {
    const fp = join(dpath, file);
    if (sinceMs && statSync(fp).mtimeMs < sinceMs) continue;
    let text = "";
    try { text = readFileSync(fp, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.includes('"name":"Skill"')) continue;
      const skill = line.match(/"skill":"([^"]+)"/)?.[1];
      if (!skill) continue;
      const ts = line.match(/"timestamp":"([^"]+)"/)?.[1] ?? "";
      if (sinceMs && ts && new Date(ts).getTime() < sinceMs) continue;
      hits.push({ dir, skill, ts, args: line.match(/"args":"([^"]*)"/)?.[1] ?? "" });
    }
  }
}

if (!hits.length) { console.log("no Skill invocations found" + (f.since !== undefined ? ` in the last ${f.since}` : "")); process.exit(0); }

if (f.list) {
  hits.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  for (const h of hits) console.log(`${(h.ts || "").slice(0, 19).replace("T", " ")}  ${h.dir}  ${h.skill}${h.args ? " " + h.args : ""}`);
  process.exit(0);
}

// grouped: dir -> skill -> {count, last}
const byDir = {};
for (const h of hits) {
  (byDir[h.dir] ??= {});
  const e = (byDir[h.dir][h.skill] ??= { count: 0, last: "" });
  e.count++;
  if (h.ts > e.last) e.last = h.ts;
}
for (const [dir, skills] of Object.entries(byDir)) {
  console.log(`\n${dir}`);
  Object.entries(skills)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([s, e]) => console.log(`   ${String(e.count).padStart(3)}x  ${s.padEnd(34)} last: ${(e.last || "?").slice(0, 19).replace("T", " ")}`));
}
console.log(`\ntotal invocations: ${hits.length}`);
