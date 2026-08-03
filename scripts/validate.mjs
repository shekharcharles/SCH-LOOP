#!/usr/bin/env node
// SCH Loop — self-validation. Catches the drift class that tests can't: a skill
// with broken frontmatter, a pack pointing at a missing method file, a README
// referencing a script that no longer exists, a hardcoded machine-specific path,
// or an engagement-data file about to be committed. Run: `npm run validate`.

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); };
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// 1. every skill has valid frontmatter with a matching name
const SKILLS = ["SCH", "sch-spec", "sch-brainstorm", "sch-plan", "sch-run", "sch-review", "sch-ship", "sch-learn"];
for (const s of SKILLS) {
  const p = `skills/${s}/SKILL.md`;
  if (!existsSync(join(ROOT, p))) { fail.push(`missing skill: ${p}`); continue; }
  const t = read(p);
  // \r? — a Windows checkout with core.autocrlf=true has CRLF on disk, which an
  // LF-only pattern reads as "no frontmatter at all". Every skill then failed
  // validation on the machine the loop actually runs on, while CI stayed green.
  const fm = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
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

// 6b. the supervised runner's structural guarantees. These are the claims the
// README makes about it; a claim nothing enforces is the exact class of drift
// this file exists to catch.
{
  const runner = read("scripts/runner.mjs");
  const executor = read("scripts/executor.mjs");
  const workspace = read("scripts/workspace.mjs");
  for (const [cond, msg] of [
    [executor.includes("ENV_ALLOW"), "executor must build the worker environment from an allowlist, not the parent environment"],
    [!/ENV_ALLOW\s*=\s*\[[^\]]*"SCH_HOME"/s.test(executor), "SCH_HOME must never be passed to a worker — it is the state that grades it"],
    [executor.includes("spawn("), "the worker must be spawned with an argument array, never an interpolated shell string"],
    [runner.includes("FORBIDDEN_GIT_EFFECT"), "the runner must classify worker-created git effects"],
    [runner.includes("WORKER_FORBIDDEN"), "the runner must apply the runner-owned forbidden paths to every effect"],
    [/GIT_READONLY\s*=\s*new Set/.test(runner), "verification must allow git subcommands by allowlist, not by deny-list"],
    [workspace.includes('WORKSPACE = ".sch-loop"'), "the workspace directory must be exactly .sch-loop"],
  ]) ok(cond, msg);

  // 6c. the delivery controller. These are the guarantees the README makes
  // about the only component allowed to push, so they are enforced rather than
  // trusted: a regression here reaches a remote before anyone notices.
  const candidate = read("scripts/candidate.mjs");
  const delivery = read("scripts/delivery.mjs");
  for (const [cond, msg] of [
    [/FORBIDDEN_ARGV\s*=\s*\[/.test(candidate), "candidate.mjs must keep the forbidden git argv table"],
    [candidate.includes("assertSafeGitArgs"), "every git call must pass through assertSafeGitArgs"],
    // the controller must own no git execution path that skips the guard
    [!/\bspawnSync\(\s*["']git["']/.test(delivery), "delivery.mjs must not spawn git directly — it goes through candidate.mjs's gitRun"],
    [!/execFileSync\(\s*["']git["']/.test(delivery), "delivery.mjs must not exec git directly — it goes through candidate.mjs's gitRun"],
    [delivery.includes("markDelivered"), "only the delivery controller may complete a task"],
    [delivery.includes("secret-scan.mjs"), "the delivery controller must run the secret gate against staged content"],
    [/independent_fetch/.test(delivery), "remote verification must fetch independently rather than trust push stdout"],
    [read("scripts/state.mjs").includes("CONTROLLER_ONLY_STATUSES"), "`delivered` must be unreachable from task-set"],
  ]) ok(cond, msg);

  // The whole point of the narrow ignore rules: never hide the durable record.
  // Checked against the rules the module actually emits, not against its prose.
  const WS = await import("./workspace.mjs");
  const emitted = WS.RUNTIME_DIRS.map((d) => `${WS.WORKSPACE}/${d}/`);
  ok(!emitted.some((r) => /^\.sch-loop\/?$/.test(r)),
    "the workspace must never emit a bare .sch-loop/ ignore rule — that hides the durable project record");
  for (const t of WS.TRACKED_PATHS)
    ok(!emitted.some((r) => t.startsWith(r)), `the durable path ${t} must not fall under an ignore rule`);
}

// 7. the dashboard's CLIENT script must parse.
// dashboard.mjs serves its whole UI from one JS template literal, so a stray
// backtick inside it — in a comment, even — ends the string early and the
// dashboard dies at startup with a syntax error nobody sees until the operator
// finds a dead page. `node --check` only parses the outer module and cannot
// catch it; parsing the inner script can.
{
  // First the module itself: a stray backtick inside the template ENDS the
  // template, and the file stops parsing. That is the failure that actually
  // shipped — the dashboard died at startup and looked simply "down".
  for (const f of ["scripts/dashboard.mjs", "scripts/state.mjs", "scripts/skills.mjs", "scripts/report.mjs",
                   "scripts/graph.mjs", "scripts/poc.mjs", "scripts/workspace.mjs", "scripts/executor.mjs",
                   "scripts/runner.mjs", "scripts/sch-run-task.mjs", "scripts/candidate.mjs",
                   "scripts/delivery.mjs", "scripts/sch-deliver-run.mjs"]) {
    try { execFileSync(process.execPath, ["--check", join(ROOT, f)], { stdio: "pipe" }); }
    catch (e) {
      const why = (e.stderr?.toString() || e.message).split("\n").find((l) => /Error/.test(l)) || e.message;
      fail.push(`${f}: does not parse — ${why.trim()}`);
    }
  }
  const src = read("scripts/dashboard.mjs");
  const m = src.match(/<script>([\s\S]*?)<\/script>/);
  ok(m, "dashboard.mjs: could not find the client <script> block to validate");
  if (m) {
    // the template is interpolated at serve time; blank the ${...} holes out so
    // this parses the code's shape rather than its runtime values.
    // Checked with `node --check` in a separate process: the script is never
    // compiled or run inside this one, so validating a file cannot execute it.
    // The source is a template literal, so what the browser receives is the
    // UNESCAPED text: `\\n` in source is `\n` at runtime, `\$` is `$`. Resolve
    // the escapes the way JS does, or every regex in the file looks malformed.
    const unescape = (s) => s.replace(/\\([\s\S])/g, (_, c) =>
      c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c);
    const body = unescape(m[1]).replace(/\$\{[\s\S]*?\}/g, "0");
    const tmp = join(tmpdir(), `sch-dashboard-client-${process.pid}.js`);
    try {
      writeFileSync(tmp, body);
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    } catch (e) {
      const why = (e.stderr?.toString() || e.message).split("\n").find((l) => /Error|error/.test(l)) || e.message;
      fail.push(`dashboard.mjs: the client script does not parse — ${why.trim()} (a raw backtick inside the template will do this)`);
    } finally { try { rmSync(tmp, { force: true }); } catch {} }
  }
}

if (fail.length) { console.error("validate: FAILED\n" + fail.map((f) => "  ✗ " + f).join("\n")); process.exit(1); }
console.log(`validate: OK — ${SKILLS.length} skills, ${Object.keys(packs).length - 1} packs, README + portability + safety contracts + dashboard client script verified`);
