#!/usr/bin/env node
// SCH Loop — install the skills where Claude Code actually loads them.
//
// The repo is the source of truth (SCH_HOME/skills/), but Claude Code only reads
// ~/.claude/skills/. They were plain copies with nothing keeping them in step, so
// every edit to the source silently failed to take effect — the loop kept running
// the older instructions. This copies source -> installed and reports drift.
//
//   node scripts/sync-skills.mjs           # install (copy source over installed)
//   node scripts/sync-skills.mjs --check   # report only; exit 1 if out of sync

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
const DST = join(homedir(), ".claude", "skills");
const check = process.argv.includes("--check");

const walk = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  return e.isDirectory() ? walk(p, base) : [relative(base, p)];
});

let drift = 0, copied = 0;
for (const name of readdirSync(SRC)) {
  const srcDir = join(SRC, name);
  if (!statSync(srcDir).isDirectory()) continue;
  for (const rel of walk(srcDir)) {
    const from = join(srcDir, rel), to = join(DST, name, rel);
    const want = readFileSync(from, "utf8");
    const have = existsSync(to) ? readFileSync(to, "utf8") : null;
    if (have === want) continue;
    drift++;
    console.log(`${have === null ? "missing" : "stale  "}  ${name}/${rel}`);
    if (!check) { mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, want); copied++; }
  }
}

if (check) {
  console.log(drift ? `sync-skills: ${drift} file(s) OUT OF SYNC — run: node scripts/sync-skills.mjs` : "sync-skills: installed skills match source");
  process.exit(drift ? 1 : 0);
}
console.log(copied ? `sync-skills: installed ${copied} file(s) to ${DST}` : "sync-skills: already up to date");
