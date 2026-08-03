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

// --- co-location batching: same files → one subagent, shared ground truth ----
test("task-batch: groups ready tasks that share files, respects deps and caps", () => {
  const home = mkdtempSync(join(tmpdir(), "sch-batch-"));
  const P = "b";
  mkdirSync(join(home, "projects", P), { recursive: true });
  writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 3, projects: [
    { id: P, name: "b", domain: "app-dev", path: home, scope: {} }], authorizations: [] }));
  const S = (...a) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...a],
    { encoding: "utf8", env: { ...process.env, SCH_HOME: home } }).trim();

  S("task-add", "--project", P, "--title", "lead",      "--files", "a.py|b.py");
  S("task-add", "--project", P, "--title", "shares b",  "--files", "b.py|c.py");
  S("task-add", "--project", P, "--title", "elsewhere", "--files", "z.py");
  S("task-add", "--project", P, "--title", "depends on lead", "--files", "a.py", "--deps", "1");
  S("task-add", "--project", P, "--title", "also shares a", "--files", "a.py");

  const r = JSON.parse(S("task-batch", "--project", P, "--with", "1"));
  const ids = r.batch.map((b) => b.id);
  assert.ok(ids.includes(2), "a task sharing b.py must be batched");
  assert.ok(ids.includes(5), "a task sharing a.py must be batched");
  assert.ok(!ids.includes(3), "a task on unrelated files must NOT be batched");
  assert.ok(!ids.includes(4), "a task that depends on the lead must NOT run beside it");
  assert.ok(r.batch.length <= 2, "cap 3 means at most 2 alongside the lead");

  // a lead with neither files nor a phase has nothing to club on — it must say
  // so rather than guessing a batch together
  S("task-add", "--project", P, "--title", "no files recorded");
  const none = JSON.parse(S("task-batch", "--project", P, "--with", "6"));
  assert.equal(none.batch.length, 0);
  assert.match(none.note, /nothing co-located/);

  // the planner already groups related work: same phase + category is a stronger
  // co-location signal than guessing files from a task title
  S("task-add", "--project", P, "--title", "slice A one", "--category", "backend", "--phase-name", "Auth");
  S("task-add", "--project", P, "--title", "slice A two", "--category", "backend", "--phase-name", "Auth");
  S("task-add", "--project", P, "--title", "other slice", "--category", "frontend", "--phase-name", "Watch");
  const byPhase = JSON.parse(S("task-batch", "--project", P, "--with", "7"));
  assert.deepEqual(byPhase.batch.map((b) => b.id), [8], "same phase+category clubs; a different slice does not");
  assert.equal(byPhase.batch[0].why, "same phase");
  rmSync(home, { recursive: true, force: true });
});

// --- knowledge graph: the store the loop stops rediscovering things with -----
test("graph: records facts, finds them by natural phrasing, returns callers", async () => {
  const home = mkdtempSync(join(tmpdir(), "sch-graph-"));
  const g = await import("./scripts/graph.mjs");
  process.env.SCH_HOME = home;                       // graph.mjs reads it at import
  const db = g.open("p");

  const dec = g.upsertNode(db, { kind: "symbol", name: "decryptPayload", path: "frontend/transportCrypto.js",
    line: 42, summary: "AES-GCM decrypt of the response envelope" });
  const key = g.upsertNode(db, { kind: "symbol", name: "getTransportKey", path: "transport_crypto/services.py" });
  const mid = g.upsertNode(db, { kind: "symbol", name: "EncryptedTransportMiddleware", path: "transport_crypto/middleware.py",
    summary: "decrypts request envelope, encrypts JSON response" });
  const ep = g.upsertNode(db, { kind: "endpoint", name: "POST /api/v1/crypto/handshake", summary: "ECDH key agreement" });
  g.addEdge(db, dec, key, "calls");
  g.addEdge(db, mid, key, "calls");
  g.addEdge(db, ep, mid, "handles");

  // an identifier is several words: "payload" must find decryptPayload
  assert.ok(g.search(db, "payload").some((r) => r.name === "decryptPayload"),
    "camelCase must be split so a word inside an identifier is findable");
  // stemming: the question is asked as "encrypted", the summary says "encrypts"
  assert.ok(g.search(db, "encrypted").length, "porter stemming must match encrypts/encrypted");
  // kind filter keeps attack surface separate from code when asked
  assert.deepEqual(g.search(db, "handshake", { kind: "endpoint" }).map((r) => r.kind), ["endpoint"]);

  // the blast radius — what grep answers slowest and a rename depends on
  const { callers } = g.neighbours(db, key, 2);
  const names = callers.map((c) => c.name);
  assert.ok(names.includes("decryptPayload") && names.includes("EncryptedTransportMiddleware"),
    "both callers of getTransportKey must be returned");
  assert.ok(names.includes("POST /api/v1/crypto/handshake"),
    "depth 2 must reach the endpoint that reaches the middleware");

  // re-recording the same fact updates, never duplicates
  g.upsertNode(db, { kind: "symbol", name: "decryptPayload", path: "frontend/transportCrypto.js", summary: "updated" });
  assert.equal(g.search(db, "decryptPayload").filter((r) => r.name === "decryptPayload").length, 1);

  assert.equal(g.stats(db).nodes, 4);
  db.close();
  rmSync(home, { recursive: true, force: true });
});

// "Coverage is the contract" was prose for two engagements: coverage_required
// was set on every offensive pack and nothing computed it, so a report could
// claim complete coverage over cells nobody had touched.
test("coverage: the gate refuses a report while a cell is untested", async () => {
  const home = mkdtempSync(join(tmpdir(), "sch-cov-"));
  const P = "c";
  mkdirSync(join(home, "projects", P), { recursive: true });
  writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 3, projects: [
    { id: P, name: "c", domain: "web-pentest", path: home, client: "ACME",
      scope: { authorized: true, targets: ["app.test"], ref: "R-1" } }], authorizations: [] }));
  const S = (...a) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...a],
    { encoding: "utf8", env: { ...process.env, SCH_HOME: home } }).trim();

  S("coverage-add", "--project", P, "--endpoints", "/login|/transfer", "--classes", "SQLi|XSS", "--roles", "anon");
  assert.equal(JSON.parse(S("coverage-list", "--project", P, "--summary", "true")).total, 4);

  process.env.SCH_HOME = home;
  const R = await import("./scripts/report.mjs");
  assert.throws(() => R.buildReport(P, {}), /COVERAGE INCOMPLETE/, "an untested cell must stop the report");

  // resolve every cell — including the honest outcomes, which count as covered
  S("coverage-set", "--project", P, "--endpoint", "/login", "--class", "SQLi", "--status", "tested-clean");
  S("coverage-set", "--project", P, "--endpoint", "/login", "--class", "XSS", "--status", "tested-clean");
  S("coverage-set", "--project", P, "--endpoint", "/transfer", "--class", "SQLi", "--status", "blocked", "--note", "WAF hard-blocks every position");
  assert.throws(() => S("coverage-set", "--project", P, "--endpoint", "/transfer", "--class", "XSS", "--status", "blocked"),
    /needs --note/, "a blocked cell without a reason is not an answer");
  S("coverage-set", "--project", P, "--endpoint", "/transfer", "--class", "XSS", "--status", "not-applicable", "--note", "no reflection sink on this endpoint");

  const sum = JSON.parse(S("coverage-list", "--project", P, "--summary", "true"));
  assert.equal(sum.pct, 100);
  const rep = R.buildReport(P, {});
  assert.match(readFileSync(rep.md, "utf8"), /WAF hard-blocks every position/, "a blocked cell and its reason must reach the client");
  rmSync(home, { recursive: true, force: true });
});

// Two engagements, 24 validated findings, zero chained — while --parents,
// chainDepth and CHAIN_MAX all worked. Advice in a document is not a commitment.
test("finding-add: a validated medium+ finding spawns its own chain hunt", () => {
  const home = mkdtempSync(join(tmpdir(), "sch-chain-"));
  const P = "h";
  mkdirSync(join(home, "projects", P, ), { recursive: true });
  mkdirSync(join(home, "reports", "evidence"), { recursive: true });
  writeFileSync(join(home, "reports", "evidence", "ssrf.md"), "POST /fetch url=http://169.254.169.254/\nHTTP/1.1 200 — instance metadata");
  writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 3, projects: [
    { id: P, name: "h", domain: "web-pentest", path: home, scope: { authorized: true } }], authorizations: [] }));
  const S = (...a) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...a],
    { encoding: "utf8", env: { ...process.env, SCH_HOME: home } }).trim();
  const read = () => JSON.parse(readFileSync(join(home, "projects", P, "state.json"), "utf8"));

  // medium+ requires a CVSS — the report prioritises on it
  assert.throws(() => S("finding-add", "--project", P, "--title", "SSRF to metadata", "--status", "validated",
    "--severity", "high", "--evidence", "reports/evidence/ssrf.md"), /needs --cvss/);

  S("finding-add", "--project", P, "--title", "SSRF to metadata", "--status", "validated", "--severity", "high",
    "--cvss", "8.6 (AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:N/A:N)", "--evidence", "reports/evidence/ssrf.md",
    "--endpoint", "/fetch", "--category", "WSTG-INPV-19");
  const s = read();
  const chain = s.tasks.find((t) => t.source === "chain");
  assert.ok(chain, "a validated high finding must leave a chain-hunt task behind");
  assert.match(chain.title, /finding #1/);
  // and the finding doubles as a coverage result, without a second command
  assert.equal(s.coverage.find((c) => c.endpoint === "/fetch")?.status, "validated");

  // info findings are noise to chain on
  S("finding-add", "--project", P, "--title", "Version banner", "--status", "validated", "--severity", "info",
    "--evidence", "reports/evidence/ssrf.md");
  assert.equal(read().tasks.filter((t) => t.source === "chain").length, 1);
  rmSync(home, { recursive: true, force: true });
});

// A bank locks accounts. An agent whose context resets cannot count its own
// attempts, so the count has to live where the next pass will read it.
test("session: the recipe survives, and failed attempts are counted toward lockout", () => {
  const home = mkdtempSync(join(tmpdir(), "sch-sess-"));
  const P = "s";
  mkdirSync(join(home, "projects", P), { recursive: true });
  writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 3, projects: [
    { id: P, name: "s", domain: "web-pentest", path: home, scope: { authorized: true } }], authorizations: [] }));
  const S = (...a) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...a],
    { encoding: "utf8", env: { ...process.env, SCH_HOME: home } }).trim();

  S("session-set", "--project", P, "--role", "broker", "--account", "77707711",
    "--recipe", "reports/recon/login-recipe.md", "--landed-on", "/retail-app/dashboard", "--lockout-limit", "3");
  const got = JSON.parse(S("session-get", "--project", P, "--role", "broker"));
  assert.equal(got.account, "77707711");
  assert.equal(got.stale, false, "a session verified just now is fresh");
  assert.equal(JSON.parse(S("session-get", "--project", P, "--role", "broker", "--max-age", "0")).stale, true);

  assert.equal(JSON.parse(S("session-fail", "--project", P, "--role", "broker", "--why", "password field cleared before submit")).attemptsLeft, 2);
  // the SECOND failure exits non-zero — the cap is mechanical, not a rule to remember
  assert.throws(() => S("session-fail", "--project", P, "--role", "broker", "--why", "same again"), /session-fail/);
  assert.equal(JSON.parse(readFileSync(join(home, "projects", P, "state.json"), "utf8")).sessions.broker.failedAttempts, 2,
    "the failure is still recorded even though the command exits non-zero");
  // the recipe is not lost when an attempt fails
  assert.equal(JSON.parse(S("session-get", "--project", P, "--role", "broker")).recipe, "reports/recon/login-recipe.md");
  rmSync(home, { recursive: true, force: true });
});

// Ten tasks each blocked with a copy of "waiting on the login task" asked the
// operator the same question ten times, and each answer moved only its own task.
test("task-set: a blocker naming another task becomes a dependency, not a question", () => {
  const home = mkdtempSync(join(tmpdir(), "sch-dep-"));
  const P = "d";
  mkdirSync(join(home, "projects", P), { recursive: true });
  writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 3, projects: [
    { id: P, name: "d", domain: "web-pentest", path: home, scope: { authorized: true } }], authorizations: [] }));
  const S = (...a) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...a],
    { encoding: "utf8", env: { ...process.env, SCH_HOME: home } }).trim();
  const read = () => JSON.parse(readFileSync(join(home, "projects", P, "state.json"), "utf8"));

  S("task-add", "--project", P, "--title", "BLOCKED: login is failing", "--ac", "x");   // #1, the real blocker
  S("task-add", "--project", P, "--title", "APP-MAP: Cards", "--ac", "x");              // #2, needs a session

  S("task-set", "--project", P, "2", "--status", "blocked", "--notes", "blocked on task 1: needs a logged-in session");
  let t2 = read().tasks.find((t) => t.id === 2);
  assert.equal(t2.status, "queued", "a task waiting on another task must not ask the operator");
  assert.deepEqual(t2.deps, [1], "it must depend on the blocker instead");
  assert.equal(read().tasks.filter((t) => t.status === "blocked").length, 0);

  // not ready while the blocker is open, ready the moment it merges
  assert.equal(JSON.parse(S("task-next", "--project", P)).id, 1);
  S("task-set", "--project", P, "1", "--status", "merged", "--note", "fixed", "--tokens", "100");
  assert.equal(JSON.parse(S("task-next", "--project", P)).id, 2);

  // a genuine operator question still blocks — it names no task, and it stands alone
  const real = "Which of the two test accounts should I use for the transfer flow? "
    + "Option A: the retail account, which has a payee list already set up. "
    + "Option B: the broker account, which has none. Recommended: A.";
  S("task-set", "--project", P, "2", "--status", "blocked", "--brief", real, "--notes", "needs an account choice");
  assert.equal(read().tasks.find((t) => t.id === 2).status, "blocked");
  rmSync(home, { recursive: true, force: true });
});

// Three real questions read, in full, "NEEDS OPERATOR: ... full question in the
// task notes" — a pointer to the text being read. A fourth was incident status
// with nothing to answer. The operator has the dashboard and nothing else.
test("task-set: a question that cannot be understood or answered is refused", () => {
  const home = mkdtempSync(join(tmpdir(), "sch-ask-"));
  const P = "q";
  mkdirSync(join(home, "projects", P), { recursive: true });
  writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 3, projects: [
    { id: P, name: "q", domain: "web-pentest", path: home, scope: { authorized: true } }], authorizations: [] }));
  const S = (...a) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...a],
    { encoding: "utf8", env: { ...process.env, SCH_HOME: home } }).trim();
  const read = () => JSON.parse(readFileSync(join(home, "projects", P, "state.json"), "utf8"));
  S("task-add", "--project", P, "--title", "needs a call", "--ac", "x");

  assert.throws(() => S("task-set", "--project", P, "1", "--status", "blocked", "--notes", "NEEDS OPERATOR: decide."),
    /no readable question/, "a one-liner is not a question the operator can answer");
  assert.throws(() => S("task-set", "--project", P, "1", "--status", "blocked", "--notes",
    "NEEDS OPERATOR: decide whether the third-party handoff gets tested end to end, or reported from our side only. Full question in the task notes."),
    /points at "the task notes"/, "the notes ARE what the operator reads");
  assert.throws(() => S("task-set", "--project", P, "1", "--status", "blocked", "--notes",
    "OUTAGE SCOPE REFINED. Both backend proxy paths now return 503 on the primary host, while the separate API host is healthy. Whoever investigates should look at the upstream proxy configuration rather than only at the auth service."),
    /contains no question/, "an incident report has nothing to answer");

  // --assume does not block at all: the work keeps moving, overridable later
  S("task-set", "--project", P, "1", "--status", "blocked", "--assume", "report from our side only (option c)",
    "--brief", "Should the third-party payout handoff be tested end to end? Option A: get authorization from the other platform's owner. Option B: HDFC tests it internally. Option C: we report only what we proved on this side. Recommended: C — it is actionable now and waits on nobody.");
  const t = read().tasks.find((x) => x.id === 1);
  assert.equal(t.status, "queued", "a decision the loop can make itself must not stop the engagement");
  assert.ok(read().tasks.find((x) => x.id === 1).status !== "blocked", "the status on disk must actually change, not just the returned flag");
  assert.match(t.assumed.choice, /option c/i);
  assert.match(t.notes, /PROCEEDING ON MY OWN CALL/);
  rmSync(home, { recursive: true, force: true });
});

// A finding that only reaches state.json is invisible to every fresh context —
// the graph is what the next pass actually asks.
test("finding-add: the finding, its target and its evidence reach the graph", async () => {
  const home = mkdtempSync(join(tmpdir(), "sch-find-"));
  const P = "f";
  mkdirSync(join(home, "projects", P), { recursive: true });
  writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 3, projects: [
    { id: P, name: "f", domain: "web-pentest", path: home, scope: { authorized: true } }], authorizations: [] }));
  const S = (...a) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...a],
    { encoding: "utf8", env: { ...process.env, SCH_HOME: home } }).trim();

  // a validated finding is refused until the PoC it points at actually exists
  assert.throws(() => S("finding-add", "--project", P, "--title", "IDOR on statement download",
    "--status", "validated", "--evidence", "reports/poc/idor.md"), /evidence .* does not exist/);
  mkdirSync(join(home, "reports", "poc"), { recursive: true });
  writeFileSync(join(home, "reports", "poc", "idor.md"), "GET /api/statements/9911\nHTTP/1.1 200 — other customer's statement");

  S("finding-add", "--project", P, "--title", "IDOR on statement download", "--severity", "high",
    "--cvss", "7.5 (AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N)",
    "--status", "validated", "--target", "api.example.test", "--evidence", "reports/poc/idor.md");

  process.env.SCH_HOME = home;
  const g = await import("./scripts/graph.mjs");
  const db = g.open(P);
  const hits = g.search(db, "IDOR statement", { kind: "finding" });
  assert.equal(hits.length, 1, "the finding must be searchable in the graph");
  const { uses } = g.neighbours(db, hits[0].id, 1);
  const names = uses.map((n) => n.name);
  assert.ok(names.includes("api.example.test"), "the finding must link to the target it was found on");
  assert.ok(names.includes("reports/poc/idor.md"), "the finding must link to the evidence that proves it");
  db.close();
  rmSync(home, { recursive: true, force: true });
});

// --- orphan recovery: an interrupted pass must not strand its task ----------
// building/review only make sense while a pass holds the lock. If the session is
// closed mid-task the status sticks, and task-next only returns `queued`, so the
// task becomes invisible and is silently never built again.
test("pass-gate: requeues tasks stranded by an interrupted pass", () => {
  const home = mkdtempSync(join(tmpdir(), "sch-orphan-"));
  const P = "o";
  mkdirSync(join(home, "projects", P), { recursive: true });
  writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 3, projects: [
    { id: P, name: "o", domain: "app-dev", path: home, scope: {} }], authorizations: [] }));
  const S = (...a) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...a],
    { encoding: "utf8", env: { ...process.env, SCH_HOME: home } }).trim();
  const read = () => JSON.parse(readFileSync(join(home, "projects", P, "state.json"), "utf8"));

  S("task-add", "--project", P, "--title", "interrupted work", "--ac", "x");
  S("lock-acquire", "--project", P, "--ttl", "45", "--holder", "sch-run");
  S("task-set", "--project", P, "1", "--status", "building", "--note", "claimed");

  // while the lock is live the task is left alone — a running pass owns it
  S("pass-gate", "--project", P, "--holder", "sch-run");
  assert.equal(read().tasks[0].status, "building", "a live pass must keep its claim");

  // the session dies: lock released (or expires), task still says building
  S("lock-release", "--project", P);
  assert.equal(read().tasks[0].status, "building");
  assert.equal(S("task-next", "--project", P), "none", "stranded task is invisible to the picker");

  // next pass rescues it
  S("pass-gate", "--project", P);
  const t = read().tasks[0];
  assert.equal(t.status, "queued", "an interrupted task must return to the queue");
  assert.match(t.notes, /interrupted/);
  assert.match(JSON.parse(S("task-next", "--project", P)).title, /interrupted work/);
  rmSync(home, { recursive: true, force: true });
});

// --- graph context attaches on claim, without the loop cooperating ----------
// The graph was wired, the MCP tools connected, the skill said to query first —
// and across a whole build the loop made zero calls. Instructions get skipped,
// so the engine does this itself at the moment of claim.
test("task-set: claiming a task attaches graph context and fills files", () => {
  const home = mkdtempSync(join(tmpdir(), "sch-ctx-"));
  const P = "c";
  mkdirSync(join(home, "projects", P), { recursive: true });
  writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 3, projects: [
    { id: P, name: "c", domain: "app-dev", path: home, scope: {} }], authorizations: [] }));
  const env = { ...process.env, SCH_HOME: home, NODE_NO_WARNINGS: "1" };
  const S = (...a) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...a], { encoding: "utf8", env }).trim();
  const G = (...a) => execFileSync("node", [join(ROOT, "scripts", "graph.mjs"), ...a], { encoding: "utf8", env }).trim();
  const read = () => JSON.parse(readFileSync(join(home, "projects", P, "state.json"), "utf8")).tasks[0];

  G("record", "--project", P, "--kind", "symbol", "--name", "user_allowed_to_upload",
    "--path", "files/methods.py", "--line", "412", "--summary", "single choke point for both upload paths");
  S("task-add", "--project", P, "--title", "Enforce upload quota per user", "--ac", "AC-1: over-quota rejected");

  assert.deepEqual(read().files, [], "nothing attached before the task is claimed");
  S("task-set", "--project", P, "1", "--status", "building", "--note", "claimed");

  const t = read();
  assert.deepEqual(t.files, ["files/methods.py"], "the file it will touch is recorded — this is what clubbing matches on");
  assert.match(t.graphContext.join(" "), /user_allowed_to_upload — files\/methods\.py:412/,
    "the builder is handed the location instead of rediscovering it");
  rmSync(home, { recursive: true, force: true });
});

// --- cost recording cannot be skipped ---------------------------------------
// The engine cannot supply this — only the loop sees what a subagent spent — so
// it is enforced at the merge instead. Asking nicely produced 6 records out of
// 121 tasks, which left "are tokens going down?" permanently unanswerable.
test("task-set: refuses to merge a built task with no cost recorded", () => {
  const home = mkdtempSync(join(tmpdir(), "sch-cost-"));
  const P = "k";
  mkdirSync(join(home, "projects", P), { recursive: true });
  writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 3, projects: [
    { id: P, name: "k", domain: "app-dev", path: home, scope: {} }], authorizations: [] }));
  const env = { ...process.env, SCH_HOME: home, NODE_NO_WARNINGS: "1" };
  const S = (...a) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...a], { encoding: "utf8", env }).trim();
  const read = (i = 0) => JSON.parse(readFileSync(join(home, "projects", P, "state.json"), "utf8")).tasks[i];

  S("task-add", "--project", P, "--title", "built by a subagent", "--ac", "x");
  S("task-set", "--project", P, "1", "--status", "building", "--note", "claimed");
  assert.throws(() => S("task-set", "--project", P, "1", "--status", "merged", "--note", "done"),
    /record what it cost/, "a built task must not merge without its cost");
  assert.equal(read().status, "building", "the refused merge must not have taken effect");

  S("task-set", "--project", P, "1", "--status", "merged", "--note", "done", "--tokens", "84000", "--tool-uses", "31");
  assert.equal(read().status, "merged");
  assert.equal(read().tokens, 84000);

  // honesty is always available; silence is not
  S("task-add", "--project", P, "--title", "genuinely unmeasured", "--ac", "x");
  S("task-set", "--project", P, "2", "--status", "building");
  S("task-set", "--project", P, "2", "--status", "merged", "--tokens", "unknown");
  assert.equal(read(1).status, "merged");
  assert.equal(read(1).tokensUnmeasured, true);

  // a task never built by a subagent is not gated — nothing spent it
  S("task-add", "--project", P, "--title", "never built", "--ac", "x");
  S("task-set", "--project", P, "3", "--status", "merged", "--note", "superseded upstream");
  assert.equal(read(2).status, "merged");
  rmSync(home, { recursive: true, force: true });
});

// --- a spend cap the loop cannot talk past ----------------------------------
// 122 tasks in a day consumed roughly half a weekly allowance. The loop has no
// idea what it spends and will happily exhaust the plan by Tuesday, so the gate
// checks the budget before anything else and refuses to start a pass past it.
test("pass-gate: refuses to start a pass once the daily budget is spent", () => {
  const home = mkdtempSync(join(tmpdir(), "sch-bud-"));
  const P = "b";
  mkdirSync(join(home, "projects", P), { recursive: true });
  writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 3, projects: [
    { id: P, name: "b", domain: "app-dev", path: home, scope: {} }], authorizations: [] }));
  const env = { ...process.env, SCH_HOME: home, NODE_NO_WARNINGS: "1" };
  const S = (...a) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...a], { encoding: "utf8", env }).trim();

  S("budget", "--project", P, "--daily", "200000");
  S("task-add", "--project", P, "--title", "a", "--ac", "x");
  S("task-set", "--project", P, "1", "--status", "building");
  assert.equal(S("pass-gate", "--project", P), "WORK", "under budget the pass proceeds");

  S("task-set", "--project", P, "1", "--status", "merged", "--agent", "builder", "--tokens", "210000", "--tool-uses", "20");
  S("task-add", "--project", P, "--title", "b", "--ac", "x");
  assert.match(S("pass-gate", "--project", P), /^BUDGET/, "over budget the pass must not start");

  // raising the cap resumes work — the operator stays in control
  S("budget", "--project", P, "--daily", "500000");
  assert.equal(S("pass-gate", "--project", P), "WORK");
  // and no cap means no gate, for anyone who does not want one
  S("budget", "--project", P, "--daily", "0");
  assert.equal(S("pass-gate", "--project", P), "WORK");
  rmSync(home, { recursive: true, force: true });
});

// ===========================================================================
// SKILL REGISTRY + CAPABILITY PROFILE (Stage 0)
//
// Every test below runs against FIXTURE skill directories under a temporary
// SCH_HOME. None of them can see, or be broken by, the skills the operator
// actually has installed — SCH_SKILL_ROOTS replaces the discovery roots wholesale.
// ===========================================================================

const SK = await import(join(ROOT, "scripts", "skills.mjs").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));

// A throwaway home + fixture roots. Returns the helpers each test needs.
function skillFixture(name) {
  const home = mkdtempSync(join(tmpdir(), "sch-sk-" + name + "-"));
  const roots = { global: join(home, "fx-global"), repo: join(home, "fx-repo"), command: join(home, "fx-cmd") };
  for (const p of Object.values(roots)) mkdirSync(p, { recursive: true });
  const skill = (root, id, fm, body = "body\n") => {
    mkdirSync(join(roots[root], id), { recursive: true });
    writeFileSync(join(roots[root], id, "SKILL.md"), "---\nname: " + id + "\n" + fm + "\n---\n\n" + body);
  };
  const P = "fx";
  mkdirSync(join(home, "projects", P), { recursive: true });
  writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 3, projects: [
    { id: P, name: "fx", domain: "app-dev", path: home, scope: {} }], authorizations: [] }));
  // the built-in root comes FIRST, so SCH's own skills are discovered as BUILT_IN
  const env = () => ({
    ...process.env, SCH_HOME: home, NODE_NO_WARNINGS: "1",
    SCH_SKILL_ROOTS: ["builtin:" + join(ROOT, "skills"), "global:" + roots.global,
      "repo:" + roots.repo, "command:" + roots.command].join("|"),
  });
  const S = (...a) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...a],
    { encoding: "utf8", env: env() }).trim();
  const J = (...a) => JSON.parse(S(...a));
  return { home, roots, skill, P, S, J, env, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("skills: discovers built-ins, repo-local skills and repo commands", () => {
  const fx = skillFixture("disc");
  fx.skill("repo", "repo-helper", "description: a repo-local helper");
  writeFileSync(join(fx.roots.command, "deploy.md"), "---\nname: deploy\ndescription: deploy it\n---\nrun\n");
  const byId = Object.fromEntries(fx.J("skill-list", "--full", "true").map((s) => [s.id, s]));

  // 1. built-in discovery: SCH's own skills, BUILT_IN by birth
  assert.equal(byId["sch-plan"].source_kind, "builtin");
  assert.equal(byId["sch-plan"].trust, "BUILT_IN");
  assert.deepEqual(byId["sch-plan"].capabilities, ["planning", "task-decomposition"]);
  // 2. repository-local discovery, and NEVER auto-approved
  assert.equal(byId["repo-helper"].source_kind, "repo");
  assert.equal(byId["repo-helper"].trust, "UNREVIEWED");
  // 3. repository-local commands
  assert.equal(byId["deploy"].source_kind, "command");
  fx.done();
});

test("skills: safe global discovery is configured, and stays inside its roots", () => {
  const fx = skillFixture("glob");
  fx.skill("global", "a-global-skill", "description: installed for the user");
  assert.ok(fx.J("skill-list").map((s) => s.id).includes("a-global-skill"));
  assert.equal(fx.J("skill-get", "a-global-skill").trust, "UNREVIEWED",
    "global discovery must never promote a third-party skill");
  const roots = fx.J("skill-discover").roots.map((r) => r.path.toLowerCase());
  for (const s of fx.J("skill-list", "--full", "true"))
    assert.ok(roots.some((r) => s.source_path.toLowerCase().startsWith(r)),
      s.id + " escaped its discovery root: " + s.source_path);
  fx.done();
});

test("skills: a duplicate id is reported, not silently overwritten", () => {
  const fx = skillFixture("dup");
  fx.skill("global", "twin", "description: the global one");
  fx.skill("repo", "twin", "description: the repo one");
  const d = fx.J("skill-discover");
  assert.equal(d.warnings.filter((w) => w.includes('duplicate skill id "twin"')).length, 1);
  assert.equal(fx.J("skill-get", "twin").source_kind, "global", "first root wins, deterministically");
  fx.done();
});

test("skills: the content hash is stable, and a change invalidates approval", () => {
  const fx = skillFixture("hash");
  fx.skill("global", "mutable", "description: v1", "instructions v1\n");
  const h1 = fx.J("skill-get", "mutable").content_hash;
  fx.S("skill-discover");
  assert.equal(fx.J("skill-get", "mutable").content_hash, h1,
    "rediscovering unchanged content must produce the same hash");

  fx.S("skill-trust", "mutable", "--state", "APPROVED", "--why", "read it");
  assert.equal(fx.J("skill-get", "mutable").trust, "APPROVED");

  fx.skill("global", "mutable", "description: v1", "instructions v2 — CHANGED\n");
  fx.S("skill-discover");
  const after = fx.J("skill-get", "mutable");
  assert.notEqual(after.content_hash, h1, "changed content must change the hash");
  assert.equal(after.trust, "UNREVIEWED", "an approval given to the old body is not an approval");
  assert.equal(after.stale_approval, true);
  fx.done();
});

test("skills: trust rejects bad input and refuses to re-badge a built-in", () => {
  const fx = skillFixture("trust");
  assert.throws(() => fx.S("skill-trust", "nope", "--state", "APPROVED"), /unknown skill/);
  fx.skill("global", "thing", "description: x");
  fx.S("skill-discover");
  assert.throws(() => fx.S("skill-trust", "thing", "--state", "SUPER_APPROVED"), /invalid trust state/);
  assert.throws(() => fx.S("skill-trust", "thing", "--state", "BUILT_IN"), /invalid trust state/);
  assert.throws(() => fx.S("skill-trust", "sch-plan", "--state", "BLOCKED"), /built-in/);
  fx.done();
});

// --- recommendation: precedence, trust and conflicts ------------------------
function recFixture() {
  const fx = skillFixture("rec");
  for (const id of ["ui-pro", "ui-alt", "tdd-pro", "override-pro", "phase-pro", "risky"])
    fx.skill("global", id, "description: " + id);
  fx.S("skill-discover");
  for (const id of ["ui-pro", "ui-alt", "tdd-pro", "override-pro", "phase-pro"])
    fx.S("skill-trust", id, "--state", "APPROVED");
  fx.S("profile-set", "--project", fx.P, "--task-type", "frontend", "--recommended", "ui-pro");
  fx.S("profile-set", "--project", fx.P, "--default-skills", "tdd-pro");
  return fx;
}

test("skills: recommendation follows task > phase > task-type > defaults", () => {
  const fx = recFixture();
  const ids = (r, k) => r[k].map((x) => x.skill_id).sort();

  // default-profile fallback: nothing task-specific, the project default applies
  assert.deepEqual(ids(fx.J("skill-recommend", "--project", fx.P), "recommended"), ["tdd-pro"]);

  // task-type profile
  const fe = fx.J("skill-recommend", "--project", fx.P, "--type", "frontend");
  assert.deepEqual(ids(fe, "recommended"), ["tdd-pro", "ui-pro"]);
  assert.match(fe.recommended.find((x) => x.skill_id === "ui-pro").reason, /frontend profile/);

  // phase profile outranks the task-type profile for the same skill
  fx.S("profile-set", "--project", fx.P, "--phase", "2", "--disabled", "ui-pro", "--required", "phase-pro");
  const ph = fx.J("skill-recommend", "--project", fx.P, "--type", "frontend", "--phase", "2");
  assert.deepEqual(ids(ph, "required"), ["phase-pro"]);
  assert.ok(!ids(ph, "recommended").includes("ui-pro"), "the phase profile disabled it");
  assert.ok(ph.excluded.some((x) => x.skill_id === "ui-pro" && /phase 2 profile/.test(x.reason)));

  // the task's own override outranks everything
  fx.S("task-add", "--project", fx.P, "--title", "a frontend job", "--category", "frontend", "--phase", "2");
  fx.S("task-set", "--project", fx.P, "1", "--skill-required", "override-pro", "--skill-disabled", "phase-pro");
  const t = fx.J("skill-recommend", "--project", fx.P, "--task", "1");
  assert.deepEqual(ids(t, "required"), ["override-pro"]);
  assert.ok(t.excluded.some((x) => x.skill_id === "phase-pro" && /task override/.test(x.reason)));

  // affected-file hints answer "what kind of task is this" when nobody said
  assert.equal(fx.J("skill-recommend", "--project", fx.P, "--files", "src/App.tsx").task_type, "frontend");
  fx.done();
});

test("skills: unreviewed, disabled and blocked are never selected autonomously", () => {
  const fx = recFixture();
  fx.S("profile-set", "--project", fx.P, "--task-type", "backend", "--recommended", "risky");
  const auto = fx.J("skill-recommend", "--project", fx.P, "--type", "backend");
  assert.ok(!auto.recommended.some((x) => x.skill_id === "risky"));
  assert.ok(auto.excluded.some((x) => x.skill_id === "risky" && /never selected for autonomous use/.test(x.reason)));
  // interactive use may still offer it, clearly labelled
  const inter = fx.J("skill-recommend", "--project", fx.P, "--type", "backend", "--autonomous", "false");
  assert.ok(inter.optional.some((x) => x.skill_id === "risky" && /approve it/.test(x.reason)));

  // an APPROVED skill is recommended; DISABLED and BLOCKED are excluded
  assert.ok(fx.J("skill-recommend", "--project", fx.P, "--type", "frontend").recommended.some((x) => x.skill_id === "ui-pro"));
  fx.S("skill-trust", "ui-pro", "--state", "DISABLED");
  let r = fx.J("skill-recommend", "--project", fx.P, "--type", "frontend");
  assert.ok(r.excluded.some((x) => x.skill_id === "ui-pro" && /DISABLED/.test(x.reason)));
  fx.S("skill-trust", "ui-pro", "--state", "BLOCKED");
  r = fx.J("skill-recommend", "--project", fx.P, "--type", "frontend");
  assert.ok(r.excluded.some((x) => x.skill_id === "ui-pro" && /BLOCKED/.test(x.reason)));
  fx.done();
});

test("skills: conflicting skills selected together produce a warning", () => {
  const fx = skillFixture("conf");
  fx.skill("global", "left", "description: x\nconflicts_with: [right]");
  fx.skill("global", "right", "description: y");
  fx.S("skill-discover");
  fx.S("skill-trust", "left", "--state", "APPROVED");
  fx.S("skill-trust", "right", "--state", "APPROVED");
  fx.S("profile-set", "--project", fx.P, "--task-type", "frontend", "--recommended", "left|right");
  const r = fx.J("skill-recommend", "--project", fx.P, "--type", "frontend");
  assert.ok(r.warnings.some((w) => /conflict/.test(w)), "a conflict must be surfaced, not silently resolved");
  assert.ok(fx.J("profile-validate", "--project", fx.P).problems.some((p) => /conflicting/.test(p)));
  fx.done();
});

// --- execution modes + the profile as a state contract ----------------------
test("skills: execution modes validate, persist, and PAUSED stops a pass", () => {
  const fx = skillFixture("mode");
  // an existing project with NO profile loads on safe defaults
  assert.equal(fx.J("profile-get", "--project", fx.P).execution_mode, "SINGLE_TASK");
  assert.equal(fx.J("profile-validate", "--project", fx.P).ok, true);

  assert.throws(() => fx.S("profile-set", "--project", fx.P, "--mode", "UNLIMITED"), /invalid --mode/);
  assert.throws(() => fx.S("profile-set", "--project", fx.P, "--mode", "single_task"), /invalid --mode/);

  fx.S("profile-set", "--project", fx.P, "--mode", "SUPERVISED_PHASE");
  assert.equal(fx.J("profile-get", "--project", fx.P).execution_mode, "SUPERVISED_PHASE");
  // persisted on the project record, so it survives the process
  const reg = JSON.parse(readFileSync(join(fx.home, "projects.json"), "utf8"));
  assert.equal(reg.projects[0].capabilities.execution_mode, "SUPERVISED_PHASE");

  // PAUSED means no new work may start — a run contract, not a comment
  fx.S("task-add", "--project", fx.P, "--title", "work", "--ac", "x");
  assert.equal(fx.S("pass-gate", "--project", fx.P), "WORK");
  fx.S("profile-set", "--project", fx.P, "--mode", "PAUSED");
  assert.match(fx.S("pass-gate", "--project", fx.P), /^PAUSED/);
  assert.equal(fx.J("profile-validate", "--project", fx.P).eligibility.eligible, false);
  // resume restores what it was before the pause
  fx.S("profile-set", "--project", fx.P, "--resume", "true");
  assert.equal(fx.J("profile-get", "--project", fx.P).execution_mode, "SUPERVISED_PHASE");
  assert.equal(fx.S("pass-gate", "--project", fx.P), "WORK");
  fx.done();
});

test("skills: an invalid profile is refused, and mutations are audited", () => {
  const fx = skillFixture("valid");
  fx.skill("global", "unapproved", "description: x");
  fx.S("skill-discover");
  // a REQUIRED skill nobody approved is a run permission nobody granted
  assert.throws(() => fx.S("profile-set", "--project", fx.P, "--task-type", "frontend", "--required", "unapproved"),
    /profile REFUSED/);
  // a BLOCKED skill cannot be selected
  fx.S("skill-trust", "unapproved", "--state", "BLOCKED");
  assert.throws(() => fx.S("profile-set", "--project", fx.P, "--task-type", "frontend", "--recommended", "unapproved"),
    /profile REFUSED/);
  // an uninstalled skill is reported rather than accepted as fact
  fx.S("profile-set", "--project", fx.P, "--default-skills", "does-not-exist");
  assert.ok(fx.J("profile-validate", "--project", fx.P).problems.some((p) => /not installed/.test(p)));
  // an unknown project id is refused outright
  assert.throws(() => fx.S("profile-set", "--project", "no-such-project", "--mode", "PAUSED"), /no such project/);

  // every mutating command appends an audit event
  const day = new Date().toISOString().slice(0, 10);
  const log = readFileSync(join(fx.home, "logs", "audit-" + day + ".jsonl"), "utf8");
  for (const cmd of ["skill-discover", "skill-trust", "profile-set"])
    assert.ok(log.includes('"cmd":"' + cmd + '"'), cmd + " must be audited");
  fx.done();
});

test("skills: a path escaping its discovery root is refused", () => {
  const fx = skillFixture("escape");
  const outside = mkdtempSync(join(tmpdir(), "sch-outside-"));
  mkdirSync(join(outside, "sneaky"), { recursive: true });
  writeFileSync(join(outside, "sneaky", "SKILL.md"), "---\nname: sneaky\ndescription: not yours\n---\nx\n");
  let linked = false;
  try {
    // junction: the symlink flavour Windows allows without elevation
    execFileSync("node", ["-e", 'require("fs").symlinkSync(process.argv[1],process.argv[2],"junction")',
      join(outside, "sneaky"), join(fx.roots.global, "sneaky")], { stdio: "pipe" });
    linked = true;
  } catch { /* no symlink permission here — the containment check below still runs */ }
  if (linked) {
    assert.ok(!fx.J("skill-list").map((s) => s.id).includes("sneaky"),
      "a skill symlinked out of its root must not be discovered");
    assert.ok(fx.J("skill-discover").warnings.some((w) => /outside its discovery root/.test(w)));
  }
  // containment is never satisfied by an arbitrary path
  assert.equal(SK.discoveryRoots({ repo: outside, global: false }).some((r) => r.path === outside), false);
  rmSync(outside, { recursive: true, force: true });
  fx.done();
});

test("skills: /SCH routing metadata is complete and case-insensitive", () => {
  const fx = skillFixture("cmd");
  const all = fx.J("sch-commands");
  const names = all.map((c) => c.name);
  for (const n of ["SCH", "status", "project", "spec", "brainstorm", "plan", "skills", "run", "review",
    "learn", "graph", "pause", "resume", "stop", "approve", "dashboard", "doctor"])
    assert.ok(names.includes(n), "/SCH " + n + " must be routable");
  assert.equal(new Set(names).size, names.length, "no duplicate /SCH command");
  for (const c of all) assert.ok(c.summary && c.status, c.name + " needs a status and a summary");
  assert.equal(fx.J("sch-commands", "PLAN").name, "plan");
  assert.equal(fx.J("sch-commands", "Brainstorm").name, "brainstorm");
  assert.ok(fx.J("sch-commands", "nonsense").error);
  // The supervised single-task runner exists and is routable; what must NOT be
  // advertised as working is everything past it — retry, queue continuation, and
  // any target-project commit or push.
  assert.ok(names.includes("run-task"), "the supervised external runner must be routable");
  assert.match(all.find((c) => c.name === "run").note, /automatic retry, queue continuation and any target-project commit\/push are not implemented/);
  assert.match(all.find((c) => c.name === "run-task").note, /VERIFIED is not committed, pushed or done/);
  fx.done();
});

test("skills: capability inference marks a guess as a guess", () => {
  const fx = skillFixture("infer");
  fx.skill("global", "explicit-one", "description: whatever\ncapabilities: [accessibility, ui-review]");
  fx.skill("global", "guessy", "description: a skill about accessibility and WCAG audits");
  fx.skill("global", "opaque", "description: zzzz");
  fx.S("skill-discover");
  const g = (id) => fx.J("skill-get", id);
  assert.deepEqual(g("explicit-one").capabilities, ["accessibility", "ui-review"]);
  assert.equal(g("explicit-one").capabilities_complete, true, "declared metadata is a fact");
  assert.deepEqual(g("guessy").capabilities, ["accessibility"]);
  assert.equal(g("guessy").capabilities_complete, false, "keyword inference is a hint, not a classification");
  assert.deepEqual(g("opaque").capabilities, []);
  assert.equal(g("opaque").capabilities_complete, false, "an unclassifiable skill is preserved, not dropped");
  // a capability provider is mapped by adapter, without its body being read
  assert.deepEqual(SK.ADAPTERS["superpowers-test-driven-development"], ["test-driven-development"]);
  fx.done();
});
