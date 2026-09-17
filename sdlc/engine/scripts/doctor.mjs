#!/usr/bin/env node
// SCH Loop — doctor. Checks that what the repo DECLARES is actually WIRED UP on
// this machine.
//
// `npm run validate` checks the repo is internally consistent. It cannot see the
// machine, so it missed the class of bug where a safety gate exists, is
// documented, is tested — and was simply never registered in the live settings
// file. That gate then silently protects nothing.
//
//   node scripts/doctor.mjs           # report
//   node scripts/doctor.mjs --fix     # also install missing hooks + env from the
//                                     # template, and sync the skills (backs up first)

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE = join(homedir(), ".claude");
const SETTINGS = join(CLAUDE, "settings.json");
const TEMPLATE = join(ROOT, "docs", "settings.template.json");
const fix = process.argv.includes("--fix");

const problems = [], fixed = [], notes = [];
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

// A hook is identified by the script it runs, not by its exact command string —
// quoting and shell wrappers differ between machines.
const hookKey = (cmd) => (String(cmd).match(/([a-z0-9-]+\.(mjs|sh|js))/i) || [])[1] || null;
const hookKeys = (settings) => {
  const out = new Map();
  for (const [ev, groups] of Object.entries(settings?.hooks ?? {}))
    for (const g of groups ?? [])
      for (const h of g.hooks ?? []) {
        const k = hookKey(h.command);
        if (k) out.set(k, { ev, matcher: g.matcher ?? "*" });
      }
  return out;
};

// 1. installed skills match the repo -----------------------------------------
try {
  execFileSync("node", [join(ROOT, "scripts", "sync-skills.mjs"), "--check"], { stdio: "pipe" });
} catch {
  problems.push("installed skills in ~/.claude/skills are OUT OF DATE — the loop is running older instructions");
  if (fix) { execFileSync("node", [join(ROOT, "scripts", "sync-skills.mjs")], { stdio: "pipe" }); fixed.push("installed the current skills"); }
}

// 2. every hook the template declares is registered live ----------------------
const tpl = readJson(TEMPLATE), live = readJson(SETTINGS);
if (!tpl) problems.push(`cannot read ${TEMPLATE}`);
else if (!live) problems.push(`cannot read ${SETTINGS} — is it valid JSON?`);
else {
  const want = hookKeys(tpl), have = hookKeys(live);
  const missing = [...want].filter(([k]) => !have.has(k));
  for (const [k, meta] of missing)
    problems.push(`hook NOT REGISTERED: ${k} (${meta.ev}${meta.matcher !== "*" ? " / " + meta.matcher : ""}) — declared in the template, absent from your settings.json, so it protects nothing`);

  if (fix && missing.length) {
    copyFileSync(SETTINGS, SETTINGS + ".bak-" + Date.now());
    live.hooks = live.hooks ?? {};
    for (const [ev, groups] of Object.entries(tpl.hooks ?? {}))
      for (const g of groups ?? [])
        for (const h of g.hooks ?? []) {
          const k = hookKey(h.command);
          if (!k || have.has(k)) continue;
          live.hooks[ev] = live.hooks[ev] ?? [];
          live.hooks[ev].unshift({ matcher: g.matcher ?? "*", hooks: [h] });
          fixed.push(`registered ${k} on ${ev}`);
        }
    writeFileSync(SETTINGS, JSON.stringify(live, null, 2));
  }

  // the reverse direction matters too: a hook this machine relies on but the
  // template omits means a fresh install silently loses it
  const extra = [...have].filter(([k]) => !want.has(k) && existsSync(join(ROOT, "scripts", k)));
  for (const [k] of extra)
    problems.push(`hook ${k} is registered here but MISSING FROM the template — a fresh install would not get it`);
}

// 3. env the loop depends on ---------------------------------------------------
if (live && !(live.env?.SCH_NOTIFY_WEBHOOK || process.env.SCH_NOTIFY_WEBHOOK))
  notes.push("SCH_NOTIFY_WEBHOOK not set — blocked questions reach the dashboard but not your phone");

// 4. the engine is where everything expects it ---------------------------------
const expected = join(CLAUDE, "SCH-loop");
if (ROOT.toLowerCase() !== expected.toLowerCase())
  problems.push(`engine is at ${ROOT} but hooks and docs assume ${expected}`);

// 5. no second copy of the engine to drift against -----------------------------
for (const d of [join(homedir(), "Desktop", "loop", "SCH-loop"), join(homedir(), "SCH-loop")])
  if (existsSync(d) && d.toLowerCase() !== ROOT.toLowerCase())
    problems.push(`a SECOND copy of the engine exists at ${d} — edits there are invisible to the loop`);

// 6. every registered hook's script actually exists -----------------------------
if (live) for (const [k, meta] of hookKeys(live)) {
  const local = join(ROOT, "scripts", k);
  if (k.startsWith("secret-scan") || k.startsWith("dashboard-ctl") || k.startsWith("sync-skills"))
    if (!existsSync(local)) problems.push(`hook ${k} (${meta.ev}) points at a script that does not exist`);
}

// 7. the dashboard is reachable -------------------------------------------------
const port = process.env.SCH_PORT || 4600;
try {
  const r = await fetch(`http://127.0.0.1:${port}/api/projects`, { signal: AbortSignal.timeout(1500) });
  if (!r.ok) notes.push(`dashboard on ${port} answered ${r.status}`);
} catch { notes.push(`dashboard not running on ${port} — it starts with your next Claude session (SessionStart hook)`); }

// 8. every project's path still exists -------------------------------------------
const reg = readJson(join(ROOT, "projects.json"));
for (const p of reg?.projects ?? [])
  if (p.path && !existsSync(p.path)) problems.push(`project "${p.id}" points at a missing folder: ${p.path}`);

// ---- report -------------------------------------------------------------------
for (const f of fixed) console.log("  fixed   " + f);
for (const n of notes) console.log("  note    " + n);
for (const p of problems.filter((p) => !fixed.length || !fixed.some((f) => p.includes(f.split(" ").pop())))) console.log("  GAP     " + p);

const open = fix ? problems.length - fixed.length : problems.length;
if (open > 0) { console.log(`\ndoctor: ${open} gap(s)${fix ? " left" : " — run: node scripts/doctor.mjs --fix"}`); process.exit(1); }
console.log("\ndoctor: OK — everything the repo declares is wired up on this machine");
