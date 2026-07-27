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
