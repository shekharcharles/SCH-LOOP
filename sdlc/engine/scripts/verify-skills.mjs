#!/usr/bin/env node
// SCH Loop — HARD GATE: were this project's required skills actually invoked?
//
// Reads Claude Code's own session transcripts (ground truth — the agent cannot
// fake them) and checks them against the project's requiredSkills. sch-run must
// pass this before completing a task; sch-review rejects the task if it fails.
//
//   node scripts/verify-skills.mjs --project pmcms --since 60
//   node scripts/verify-skills.mjs --project pmcms --since 60 --any   (any one is enough)
//
// exit 0 = PASS, exit 1 = FAIL (missing skills listed)

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getProject } from "./state.mjs";

const TRANSCRIPTS = join(homedir(), ".claude", "projects");
const f = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) f[a.slice(2)] = (process.argv[i + 1]?.startsWith("--") ?? true) ? true : process.argv[++i];
}
if (!f.project) { console.error("need --project <id>"); process.exit(1); }

const proj = getProject(f.project);
if (!proj) { console.error("no such project: " + f.project); process.exit(1); }
const required = proj.requiredSkills ?? [];
if (!required.length) { console.log("PASS — no required skills configured for " + f.project); process.exit(0); }

const sinceMs = Date.now() - (Number(f.since) || 120) * 60000;   // default: last 2h

// Collect skills invoked since the cutoff, across all transcripts (a project can
// be driven from more than one cwd, so we don't restrict by directory).
const invoked = new Set();
if (existsSync(TRANSCRIPTS)) {
  for (const dir of readdirSync(TRANSCRIPTS)) {
    const dpath = join(TRANSCRIPTS, dir);
    let files = [];
    try { files = readdirSync(dpath).filter((x) => x.endsWith(".jsonl")); } catch { continue; }
    for (const file of files) {
      const fp = join(dpath, file);
      try { if (statSync(fp).mtimeMs < sinceMs) continue; } catch { continue; }
      let text = "";
      try { text = readFileSync(fp, "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (!line.includes('"name":"Skill"')) continue;
        const skill = line.match(/"skill":"([^"]+)"/)?.[1];
        if (!skill) continue;
        const ts = line.match(/"timestamp":"([^"]+)"/)?.[1];
        if (ts && new Date(ts).getTime() < sinceMs) continue;
        invoked.add(skill);
        invoked.add(skill.split(":").pop());   // tolerate plugin:skill vs bare name
      }
    }
  }
}

const missing = required.filter((s) => !invoked.has(s) && !invoked.has(s.split(":").pop()));
const ok = f.any ? missing.length < required.length : missing.length === 0;

console.log(`required : ${required.join(", ")}`);
console.log(`invoked  : ${[...invoked].filter((s) => required.some((r) => r === s || r.split(":").pop() === s)).join(", ") || "(none of the required)"}`);
if (ok) { console.log(`PASS — required skill(s) verified in transcript (window ${Number(f.since) || 120}m)`); process.exit(0); }
console.log(`FAIL — NOT invoked: ${missing.join(", ")}`);
console.log("Invoke them with the Skill tool and redo the work — do not mark the task complete.");
process.exit(1);
