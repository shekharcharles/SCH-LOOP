#!/usr/bin/env node
// SCH Loop — self-validation. Catches the drift class that tests can't: a skill
// with broken frontmatter, a pack pointing at a missing method file, a README
// referencing a script that no longer exists, a hardcoded machine-specific path,
// or an engagement-data file about to be committed. Run: `npm run validate`.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); };
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// 1. every skill has valid frontmatter with a matching name
const SKILLS = ["sch-spec", "sch-plan", "sch-run", "sch-review", "sch-ship", "sch-learn"];
for (const s of SKILLS) {
  const p = `skills/${s}/SKILL.md`;
  if (!existsSync(join(ROOT, p))) { fail.push(`missing skill: ${p}`); continue; }
  const t = read(p);
  const fm = t.match(/^---\n([\s\S]*?)\n---\n/);
  ok(fm, `${p}: missing YAML frontmatter`);
  if (!fm) continue;
  ok(new RegExp(`^name:\\s*${s}\\s*$`, "m").test(fm[1]), `${p}: frontmatter name must be "${s}"`);
  ok(/^description:\s*\S/m.test(fm[1]), `${p}: needs a description`);
  // 1b. the repo is the source of truth, but Claude Code loads ~/.claude/skills.
  // Editing the source and forgetting to install it means the loop keeps running
  // the OLD instructions with no visible symptom — the worst kind of drift.
  const installed = join(homedir(), ".claude", "skills", s, "SKILL.md");
  if (existsSync(installed)) {
    ok(readFileSync(installed, "utf8") === t,
      `${p}: installed copy is out of date — run: node scripts/sync-skills.mjs`);
  }
}

// 2. packs: every method/knowledge file referenced must exist
const packs = JSON.parse(read("packs/packs.json"));
for (const [k, v] of Object.entries(packs)) {
  if (k === "_comment") continue;
  if (v.method) ok(existsSync(join(ROOT, v.method)), `pack ${k}: missing method file ${v.method}`);
  if (v.knowledge) ok(existsSync(join(ROOT, v.knowledge)), `pack ${k}: missing knowledge file ${v.knowledge}`);
  ok(v.kind && v.validate && v.complete && v.deliver, `pack ${k}: incomplete definition`);
}

// 3. README references resolve
const readme = read("README.md");
for (const m of readme.matchAll(/`?(scripts\/[a-z-]+\.mjs)`?/g))
  ok(existsSync(join(ROOT, m[1])), `README references a missing file: ${m[1]}`);
for (const f of readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".mjs")))
  ok(readme.includes(f), `scripts/${f} exists but is undocumented in the README file map`);

// 4. portability: no machine-specific absolute paths in shipped files
const PORTABLE_DIRS = ["skills", "docs", "scripts"];
const badPath = /C:[\\/]Users[\\/](?!<)[A-Za-z0-9._-]+[\\/](Desktop|Documents)/;
const walk = (d) => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
for (const dir of PORTABLE_DIRS)
  for (const f of walk(dir).filter((f) => /\.(md|mjs|json)$/.test(f)))
    ok(!badPath.test(read(f)), `${f}: contains a machine-specific path (use $HOME/.claude/SCH-loop)`);

// 5. engagement data must be git-ignored, never shipped
const gi = read(".gitignore");
for (const p of ["projects/", "projects.json", "authorizations/", "logs/", "CLAUDE.md", ".env"])
  ok(gi.includes(p), `.gitignore must exclude ${p}`);

// 6. safety contracts the loop depends on
const run = read("skills/sch-run/SKILL.md");
const review = read("skills/sch-review/SKILL.md");
for (const [cond, msg] of [
  [run.includes("secret-scan"), "sch-run must gate commits with secret-scan"],
  [run.includes("fresh-context"), "sch-run must execute tasks in a fresh-context subagent"],
  [run.includes("scope-check"), "sch-run must re-check scope before an active task"],
  [run.includes("pass-gate"), "sch-run must start with the cheap pass-gate"],
  [review.includes("Definition of Done"), "sch-review must validate the Definition-of-Done checklist"],
]) ok(cond, msg);

if (fail.length) { console.error("validate: FAILED\n" + fail.map((f) => "  ✗ " + f).join("\n")); process.exit(1); }
console.log(`validate: OK — ${SKILLS.length} skills, ${Object.keys(packs).length - 1} packs, README + portability + safety contracts verified`);
