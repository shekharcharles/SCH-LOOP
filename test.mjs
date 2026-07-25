#!/usr/bin/env node
// SCH Loop — engine tests. Covers the safety-critical logic: the scope gate,
// standing authorizations, skill gate, queue ordering, chain depth, corrupt-state
// recovery, the write lock, and the secret scanner. Run: `npm test`.
//
// No framework by design (zero deps) — plain assertions, one file.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { inScope, authForTarget, clientMatch, nextReady, isDesignTask, addTask, addFinding, suggestInterval, CHAIN_MAX } =
  await import(join(ROOT, "scripts", "state.mjs").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));

// ---------- scope gate (the safety-critical one) ----------
const proj = (scope) => ({ scope });
const FUTURE = "2099-01-01", PAST = "2000-01-01";

test("inScope: allows an authorized in-scope target", () => {
  assert.equal(inScope(proj({ authorized: true, targets: ["app.example.com"], outOfScope: [], expiry: FUTURE }), "app.example.com/login"), true);
});
test("inScope: refuses when not authorized", () => {
  assert.equal(inScope(proj({ authorized: false, targets: ["app.example.com"], outOfScope: [], expiry: FUTURE }), "app.example.com"), false);
});
test("inScope: refuses an out-of-scope host even if listed in targets", () => {
  assert.equal(inScope(proj({ authorized: true, targets: ["example.com"], outOfScope: ["admin.example.com"], expiry: FUTURE }), "admin.example.com"), false);
});
test("inScope: refuses a target not in the allowlist", () => {
  assert.equal(inScope(proj({ authorized: true, targets: ["app.example.com"], outOfScope: [], expiry: FUTURE }), "evil.com"), false);
});
test("inScope: fails closed when the authorization has expired", () => {
  assert.equal(inScope(proj({ authorized: true, targets: ["app.example.com"], outOfScope: [], expiry: PAST }), "app.example.com"), false);
});
test("inScope: HALT stops everything", () => {
  assert.equal(inScope(proj({ authorized: true, halt: true, targets: ["app.example.com"], outOfScope: [], expiry: FUTURE }), "app.example.com"), false);
});
test("inScope: empty/undefined scope is refused", () => {
  assert.equal(inScope({}, "app.example.com"), false);
  assert.equal(inScope(proj({ authorized: true, targets: [], outOfScope: [], expiry: FUTURE }), "app.example.com"), false);
});

// ---------- standing authorizations ----------
const reg = {
  authorizations: [
    { ref: "A", clientDomains: ["acme-bank.com"], scopeDomains: ["uat.acme-bank.com"], outOfScope: ["prod.acme-bank.com"], expiry: FUTURE },
    { ref: "OLD", clientDomains: ["old.com"], scopeDomains: ["uat.old.com"], outOfScope: [], expiry: PAST },
  ],
};
test("authForTarget: matches a shared asset, refuses out-of-scope + expired", () => {
  assert.equal(authForTarget(reg, "uat.acme-bank.com")?.ref, "A");
  assert.equal(authForTarget(reg, "prod.acme-bank.com"), null);
  assert.equal(authForTarget(reg, "uat.old.com"), null);          // expired
  assert.equal(authForTarget(reg, "someoneelse.com"), null);
});
test("clientMatch: routes by client pattern but never matches an unknown org", () => {
  assert.equal(clientMatch(reg, "anything.acme-bank.com")?.ref, "A");
  assert.equal(clientMatch(reg, "unknown-org.com"), null);
});

// ---------- queue ordering ----------
const mkState = () => ({ tasks: [], inbox: [], events: [], findings: [], seq: { task: 0, inbox: 0, event: 0, finding: 0 } });
test("nextReady: priority beats phase, deps gate readiness", () => {
  const s = mkState();
  const a = addTask(s, { phase: 1, priority: 3, title: "low prio, early phase" });
  addTask(s, { phase: 5, priority: 1, title: "hot" });
  assert.equal(nextReady(s).title, "hot", "priority 1 must win");
  const s2 = mkState();
  const dep = addTask(s2, { phase: 1, title: "dep" });
  addTask(s2, { phase: 2, priority: 1, title: "blocked-by-dep", deps: [dep.id] });
  assert.equal(nextReady(s2).title, "dep", "task with unmet dep must stay hidden");
  dep.status = "merged";
  assert.equal(nextReady(s2).title, "blocked-by-dep", "unblocks once dep merged");
  assert.equal(a.status, "queued");
});
test("nextReady: superseded/blocked tasks are never returned", () => {
  const s = mkState();
  addTask(s, { title: "x" }).status = "superseded";
  addTask(s, { title: "y" }).status = "blocked";
  assert.equal(nextReady(s), null);
});

// ---------- chaining ----------
test("addFinding: chain depth increments from parents", () => {
  const s = mkState();
  const root = addFinding(s, { title: "SSRF", status: "validated" });
  const c1 = addFinding(s, { title: "metadata creds", status: "validated", parents: [root.id] });
  const c2 = addFinding(s, { title: "s3 read", status: "validated", parents: [c1.id] });
  assert.equal(root.chainDepth, 0);
  assert.equal(c1.chainDepth, 1);
  assert.equal(c2.chainDepth, 2);
  assert.ok(CHAIN_MAX >= 3);
});

// ---------- design-task classification (drives the skill gate) ----------
test("isDesignTask: UI work gated, backend/infra not", () => {
  for (const t of ["UI-2 App shell: top bar", "Responsive + accessibility pass", "Home page redesign"])
    assert.equal(isDesignTask({ title: t }), true, t);
  for (const t of ["Live SMTP delivery (verify send)", "nginx: gate bare /media location", "Per-role upload limits"])
    assert.equal(isDesignTask({ title: t }), false, t);
});

// ---------- corrupt-state recovery + write lock (CLI-level) ----------
const cli = (cwd, ...args) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...args], { cwd, encoding: "utf8", env: { ...process.env, SCH_TEST_ROOT: cwd } });

test("secret-scan: blocks a staged secret, passes clean code", () => {
  const dir = mkdtempSync(join(tmpdir(), "sch-scan-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(dir, "ok.js"), "const k = process.env.API_KEY; // your_key_here\n");
  git("add", "ok.js");
  execFileSync("node", [join(ROOT, "scripts", "secret-scan.mjs")], { cwd: dir, stdio: "ignore" }); // exit 0 or throws
  writeFileSync(join(dir, "leak.js"), 'const k = "AKIA1234567890ABCDEF";\n');
  git("add", "leak.js");
  assert.throws(() => execFileSync("node", [join(ROOT, "scripts", "secret-scan.mjs")], { cwd: dir, stdio: "ignore" }),
    "staged AWS key must block the commit");
  rmSync(dir, { recursive: true, force: true });
});

test("secret-scan: blocks sensitive files (.env, CLAUDE.md)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sch-scan2-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(dir, ".env"), "SECRET=abc\n");
  git("add", "-f", ".env");
  assert.throws(() => execFileSync("node", [join(ROOT, "scripts", "secret-scan.mjs")], { cwd: dir, stdio: "ignore" }));
  rmSync(dir, { recursive: true, force: true });
});

test("secret-scan hook: FAILS CLOSED when the scanner can't run", () => {
  const dir = mkdtempSync(join(tmpdir(), "sch-failclosed-"));
  // not a git repo at all → the scanner errors; the hook must still block, not allow
  assert.throws(() => execFileSync("node", [join(ROOT, "scripts", "secret-scan-hook.mjs")], {
    cwd: dir, input: JSON.stringify({ tool_input: { command: "git commit -m x" } }),
    stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, PATH: "" },
  }), "a scanner failure must block the commit, never allow it");
  rmSync(dir, { recursive: true, force: true });
});

test("secret-scan hook: blocks git commit, allows other commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "sch-hook-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(dir, "leak.js"), 'key="AKIA1234567890ABCDEF"\n');
  git("add", "leak.js");
  const hook = join(ROOT, "scripts", "secret-scan-hook.mjs");
  assert.throws(() => execFileSync("node", [hook], { cwd: dir, input: JSON.stringify({ tool_input: { command: "git commit -m x" } }), stdio: ["pipe", "ignore", "ignore"] }),
    "hook must block a commit with a staged secret");
  execFileSync("node", [hook], { cwd: dir, input: JSON.stringify({ tool_input: { command: "ls -la" } }), stdio: ["pipe", "ignore", "ignore"] }); // must not throw
  rmSync(dir, { recursive: true, force: true });
});

// --- pass-gate: the two interval scenarios -------------------------------
// 1) a task finishes long before the next alarm → the SAME pass must be able to
//    keep working instead of sleeping out the rest of the interval.
// 2) the alarm fires while a task is still running → the new pass must refuse.
test("pass-gate: own pass continues, a second pass is refused", () => {
  const home = mkdtempSync(join(tmpdir(), "sch-gate-"));
  const P = "gp";
  mkdirSync(join(home, "projects", P), { recursive: true });
  writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 3, projects: [
    { id: P, name: "gate", domain: "app-dev", path: home, scope: {} }], authorizations: [] }));
  const S = (...a) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...a],
    { encoding: "utf8", env: { ...process.env, SCH_HOME: home } }).trim();

  S("task-add", "--project", P, "--title", "job A", "--ac", "x");
  assert.equal(S("pass-gate", "--project", P, "--interval", "30"), "WORK");
  assert.match(S("lock-acquire", "--project", P, "--ttl", "45", "--holder", "sch-run"), /ACQUIRED/);

  // scenario 2 — a different pass wakes mid-task and must back off
  assert.equal(S("pass-gate", "--project", P), "BUSY");
  // scenario 1 — the pass that HOLDS the lock keeps going
  assert.equal(S("pass-gate", "--project", P, "--holder", "sch-run"), "WORK");

  S("task-set", "--project", P, "1", "--status", "merged");
  assert.equal(S("pass-gate", "--project", P, "--holder", "sch-run"), "IDLE",
    "queue drained → the continuing pass must stop, not spin");

  // continuing must NOT inflate the pass counter — it is still one wake-up
  const st = JSON.parse(readFileSync(join(home, "projects", P, "state.json"), "utf8"));
  assert.equal(st.run.passN, 2, "two real wake-ups (initial + the refused one), not five");
  rmSync(home, { recursive: true, force: true });
});

// --- interval advice: the right interval depends on WHY the loop would be idle
test("suggestInterval: matches the reason the loop would be stopped", () => {
  const t = (status, deps = []) => ({ id: Math.random(), status, deps });
  const st = (tasks, inbox = []) => ({ tasks, inbox });

  assert.equal(suggestInterval(st([])).minutes, 30, "empty queue → wake rarely");
  assert.equal(suggestInterval(st(Array.from({ length: 8 }, () => t("queued")))).minutes, 30,
    "deep ready queue → a pass batches anyway, short interval only adds BUSY wakes");
  assert.equal(suggestInterval(st([t("queued"), t("queued")])).minutes, 15,
    "shallow queue → the pass ends early, so waking sooner does real work");
  assert.equal(suggestInterval(st([t("blocked"), t("merged")])).minutes, 10,
    "waiting on the operator → pick their answer up quickly");
  // a blocked task must not shorten the interval while there is still real work
  assert.equal(suggestInterval(st([t("blocked"), ...Array.from({ length: 6 }, () => t("queued"))])).minutes, 30,
    "blocked but plenty ready → keep batching");
});

// --- a question must be born blocked ----------------------------------------
// Three real operator questions once sat in the queue as "queued" because the
// follow-up task-set that blocks them was never issued. Queued means invisible in
// the dashboard's NEEDS YOU banner, so they could not be answered from a phone at
// all — the exact failure the whole design exists to prevent.
test("addTask: a DECISION task cannot be created unblocked", () => {
  const s = { tasks: [], inbox: [], events: [], findings: [], seq: { task: 0, inbox: 0, event: 0, finding: 0 } };
  assert.equal(addTask(s, { title: "DECISION: which auth method?" }).status, "blocked");
  assert.equal(addTask(s, { title: "decision: lower case still counts" }).status, "blocked");
  assert.equal(addTask(s, { title: "Build the login form" }).status, "queued");
  // an explicit status is still honoured for everything else
  assert.equal(addTask(s, { title: "Retry me", status: "stuck" }).status, "stuck");
  assert.equal(addTask(s, { title: "Bad status falls back", status: "nonsense" }).status, "queued");
});
