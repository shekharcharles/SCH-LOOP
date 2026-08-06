// The control plane.
//
// The dashboard can halt a project, answer a blocked question and disarm scope.
// Before this it listened on every interface and asked nobody who they were, so
// these tests exist to keep "no unauthenticated dashboard writes" a fact rather
// than a sentence in the README.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, ROOT } from "./helpers.mjs";

const NL = String.fromCharCode(10);

// A run directory as the runner leaves one behind: run.json plus whichever
// sidecar files that run produced. Written by hand rather than by running a
// worker, because these tests are about what the DASHBOARD does with the record,
// not about how the record came to exist — and a real run needs a model.
function writeRun(fx, id, run, sidecars = {}) {
  const dir = join(fx.wsDir(), "runs", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify({ run_id: id, attempt: 1, ...run }, null, 2));
  for (const [name, body] of Object.entries(sidecars))
    writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
  return dir;
}

// A live task lease, exactly as `acquireLease` writes one: this process's pid, so
// the liveness check ("is the owner still there?") answers yes.
function writeLease(fx, taskId, runId) {
  const dir = join(fx.wsDir(), "locks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `task-${taskId}.json`), JSON.stringify({
    project_id: fx.P, task_id: String(taskId), run_id: runId, pid: process.pid,
    acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600000).toISOString(),
  }, null, 2));
}

const getJSON = async (d, fx, path) =>
  (await fetch(d.base + path, { headers: { authorization: `Bearer ${tokenOf(fx)}` } })).json();

// Start the real server on an ephemeral port with a throwaway SCH_HOME, and wait
// for it to say where it is listening.
async function dashboard(fx, extraEnv = {}) {
  const child = spawn(process.execPath, [join(ROOT, "scripts", "dashboard.mjs")], {
    env: { ...process.env, SCH_HOME: fx.home, SCH_PORT: "0", SCH_BIND: "127.0.0.1", NODE_NO_WARNINGS: "1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("the dashboard never reported a port: " + buf)), 15000);
    child.stdout.on("data", (d) => {
      buf += d;
      const m = buf.match(/:(\d+)\b/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    child.on("exit", (c) => { clearTimeout(t); reject(new Error(`exited ${c}: ${buf}`)); });
  });
  return { child, port, base: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

const tokenOf = (fx) => readFileSync(join(fx.home, "dashboard-token"), "utf8").trim();

test("an unauthenticated request is refused and reveals nothing", async () => {
  const fx = fixture("dash-401");
  const d = await dashboard(fx);
  try {
    const r = await fetch(d.base + "/");
    assert.equal(r.status, 401);
    const body = await r.text();
    assert.ok(!body.includes(fx.P), "a refusal must not leak which projects exist");
  } finally { d.stop(); fx.done(); }
});

test("a wrong token is refused", async () => {
  const fx = fixture("dash-wrong");
  const d = await dashboard(fx);
  try {
    const r = await fetch(d.base + "/", { headers: { authorization: "Bearer not-the-token" } });
    assert.equal(r.status, 401);
  } finally { d.stop(); fx.done(); }
});

test("the right token is admitted", async () => {
  const fx = fixture("dash-ok");
  const d = await dashboard(fx);
  try {
    const r = await fetch(d.base + "/", { headers: { authorization: `Bearer ${tokenOf(fx)}` } });
    assert.equal(r.status, 200);
  } finally { d.stop(); fx.done(); }
});

test("a write without a token is refused even with a valid CSRF shape", async () => {
  const fx = fixture("dash-write");
  const d = await dashboard(fx);
  try {
    const r = await fetch(d.base + "/scope", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: d.base, host: `127.0.0.1:${d.port}` },
      body: new URLSearchParams({ project: fx.P, action: "halt", csrf: "anything" }).toString(),
      redirect: "manual",
    });
    assert.equal(r.status, 401, "halting a project must require authentication");
  } finally { d.stop(); fx.done(); }
});

test("a token in the query sets a cookie, and the cookie alone then works", async () => {
  const fx = fixture("dash-cookie");
  const d = await dashboard(fx);
  try {
    const r = await fetch(`${d.base}/?token=${tokenOf(fx)}`, { redirect: "manual" });
    const cookie = r.headers.get("set-cookie") ?? "";
    assert.match(cookie, /sch_token=/, "the phone link must be usable once, then stop being needed");
    const jar = cookie.split(";")[0];
    const again = await fetch(d.base + "/", { headers: { cookie: jar } });
    assert.equal(again.status, 200);
  } finally { d.stop(); fx.done(); }
});

test("the token file is created once and survives a restart", async () => {
  const fx = fixture("dash-persist");
  const a = await dashboard(fx);
  const first = tokenOf(fx);
  a.stop();
  const b = await dashboard(fx);
  try {
    assert.equal(tokenOf(fx), first, "a token that rotates on restart cannot be bookmarked");
    assert.ok(existsSync(join(fx.home, "dashboard-token")));
  } finally { b.stop(); fx.done(); }
});

test("the run projection shows what the worker was given, never the skill bodies", async () => {
  const { RUN } = await import("./helpers.mjs");
  const fx = fixture("dash-pack");
  try {
    const p = RUN.runProjection(fx.P, { limit: 5 });
    assert.ok(Array.isArray(p.runs), "a projection must always answer with a run list");
    for (const r of p.runs) {
      if (!r.pack) continue;
      assert.equal(typeof r.pack.manifest_name, "string");
      assert.ok(Array.isArray(r.pack.skills));
      assert.ok(!JSON.stringify(r.pack).includes("SKILL.md content"),
        "a pack summary carries names, never instructions");
    }
  } finally { fx.done(); }
});

// ---------------------------------------------------------------- the pack
//
// Three milestones put things in the run record that no screen ever showed. The
// tests below are about the WIRE: what the dashboard is willing to say about a
// pack, a territory and a queue running more than one task at a time.

test("the runs endpoint names the pack a worker was given, and its refusals, without carrying a body", async () => {
  const fx = fixture("dash-pack-api");
  const d = await dashboard(fx);
  try {
    writeRun(fx, "RUN-aaaa", {
      task_id: "1", state: "finished", outcome: "VERIFIED",
      pack: {
        manifest_name: "proj-task-1", path: "/packs/proj-task-1",
        entries: [
          // A body in the record must NOT reach the wire: the projection names
          // fields, it does not spread whatever the runner happened to write.
          { skill_id: "test-driven-development", name: "TDD", bucket: "required", body: "CANARY-SKILL-BODY" },
          { skill_id: "systematic-debugging", name: "Debugging", bucket: "recommended" },
        ],
        refusals: [{ skill_id: "test-driven-development", path: "scripts/setup.sh", why: "executable — packs carry documents only" }],
      },
    });
    const p = await getJSON(d, fx, "/api/runs?project=" + fx.P);
    const r = p.runs.find((x) => x.run_id === "RUN-aaaa");
    assert.ok(r, "the run must be in the projection");
    assert.equal(r.pack.manifest_name, "proj-task-1");
    assert.deepEqual(r.pack.skills, ["test-driven-development", "systematic-debugging"]);
    assert.equal(r.pack.refusals.length, 1);
    assert.equal(r.pack.refusals[0].path, "scripts/setup.sh");
    assert.ok(!JSON.stringify(p).includes("CANARY-SKILL-BODY"),
      "a skill body in the record must never reach the wire");
  } finally { d.stop(); fx.done(); }
});

// --------------------------------------------------------------- territory

test("territory tells CLEAN, INCONCLUSIVE and VIOLATED apart on the wire", async () => {
  const fx = fixture("dash-territory");
  const d = await dashboard(fx);
  try {
    writeRun(fx, "RUN-c001", { task_id: "1", state: "finished", outcome: "VERIFIED" }, {
      "territory.json": { watched: 2, ok: true, checked_at: "2026-08-06T10:00:00.000Z",
        results: [{ id: "repo:main", same: true, inconclusive: false, added: [], removed: [], changed: [], excluded: [".git"] }],
        violated: [], unknown: [] },
    });
    writeRun(fx, "RUN-c002", { task_id: "2", state: "finished", outcome: "VERIFIED" }, {
      "territory.json": { watched: 1, ok: true, checked_at: "2026-08-06T10:05:00.000Z",
        results: [{ id: "repo:main", same: false, inconclusive: true, why: "the walk stopped at 20000 entries", added: [], removed: [], changed: [], truncated: true }],
        violated: [],
        unknown: [{ id: "repo:main", inconclusive: true, why: "the walk stopped at 20000 entries", added: [], removed: [], changed: [] }] },
    });
    writeRun(fx, "RUN-c003", { task_id: "3", state: "finished", outcome: "NEEDS_DECISION",
      failure: { code: "OUTSIDE_WORKTREE_WRITE", message: "the worker changed files OUTSIDE its own worktree" } }, {
      "territory.json": { watched: 2, ok: false, checked_at: "2026-08-06T10:10:00.000Z",
        results: [], violated: [{ id: "worktree:proj-task-9", same: false, inconclusive: false,
          added: ["src/stolen.js"], removed: [], changed: ["README.md"] }], unknown: [] },
    });
    const p = await getJSON(d, fx, "/api/runs?project=" + fx.P);
    const by = Object.fromEntries(p.runs.map((r) => [r.run_id, r.territory]));
    assert.equal(by["RUN-c001"].verdict, "CLEAN");
    assert.equal(by["RUN-c002"].verdict, "INCONCLUSIVE",
      "a check that could not see everything must never be reported as clean");
    assert.equal(by["RUN-c003"].verdict, "VIOLATED");
    assert.equal(by["RUN-c002"].unknown[0].why, "the walk stopped at 20000 entries");
    assert.equal(by["RUN-c003"].violated[0].id, "worktree:proj-task-9");
    assert.deepEqual(by["RUN-c003"].violated[0].paths, ["src/stolen.js", "README.md"]);
    // A run with no territory record at all is a fourth thing, and must not
    // borrow the clean badge either.
    writeRun(fx, "RUN-c004", { task_id: "4", state: "finished", outcome: "VERIFIED" });
    const p2 = await getJSON(d, fx, "/api/runs?project=" + fx.P);
    assert.equal(p2.runs.find((r) => r.run_id === "RUN-c004").territory, null);
  } finally { d.stop(); fx.done(); }
});

// -------------------------------------------------------------- parallelism

test("every task in flight is reported, not just one", async () => {
  const fx = fixture("dash-parallel");
  const d = await dashboard(fx);
  try {
    writeRun(fx, "RUN-p001", { task_id: "1", state: "active" });
    writeRun(fx, "RUN-p002", { task_id: "2", state: "active" });
    writeLease(fx, 1, "RUN-p001");
    writeLease(fx, 2, "RUN-p002");
    const p = await getJSON(d, fx, "/api/runs?project=" + fx.P);
    assert.equal(p.in_flight.length, 2, "two leased tasks are two tasks in flight");
    assert.deepEqual(p.in_flight.map((x) => x.task_id).sort(), ["1", "2"]);
    assert.deepEqual(p.in_flight.map((x) => x.run_id).sort(), ["RUN-p001", "RUN-p002"]);
  } finally { d.stop(); fx.done(); }
});

test("a stale lease is not a task in flight", async () => {
  const fx = fixture("dash-parallel-stale");
  const d = await dashboard(fx);
  try {
    mkdirSync(join(fx.wsDir(), "locks"), { recursive: true });
    writeFileSync(join(fx.wsDir(), "locks", "task-7.json"), JSON.stringify({
      project_id: fx.P, task_id: "7", run_id: "RUN-old", pid: process.pid,
      expires_at: new Date(Date.now() - 60000).toISOString(),
    }));
    const p = await getJSON(d, fx, "/api/runs?project=" + fx.P);
    assert.deepEqual(p.in_flight, [], "an expired lease means the worker is gone, not busy");
  } finally { d.stop(); fx.done(); }
});

test("the scheduler projection carries how many tasks the queue was allowed to run at once", async () => {
  const fx = fixture("dash-max-parallel");
  const d = await dashboard(fx);
  try {
    const dir = join(fx.wsDir(), "scheduler", "runs", "SCHED-abc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "scheduler.json"), JSON.stringify({
      scheduler_id: "SCHED-abc", project_id: fx.P, state: "STOPPED", stop_reason: "MAX_TASKS_REACHED",
      max_parallel: 3, tasks: [], tasks_delivered: 2, total_attempts: 4,
      started_at: "2026-08-06T09:00:00.000Z", ended_at: "2026-08-06T09:40:00.000Z", duration_ms: 2400000,
    }, null, 2));
    const p = await getJSON(d, fx, "/api/scheduler?project=" + fx.P);
    assert.equal(p.schedulers[0].max_parallel, 3,
      "a queue that ran three at a time must not be reported as a single-file queue");
  } finally { d.stop(); fx.done(); }
});

// ------------------------------------------------------------------ the page

test("the page renders the pack, the territory verdicts and the in-flight list", async () => {
  const fx = fixture("dash-page");
  const d = await dashboard(fx);
  try {
    const html = await (await fetch(d.base + "/", { headers: { authorization: `Bearer ${tokenOf(fx)}` } })).text();
    for (const marker of ["CAPABILITY PACK", "TERRITORY", "INCONCLUSIVE", "IN FLIGHT", "refused"])
      assert.ok(html.includes(marker), `the page must render "${marker}"`);
    assert.ok(html.includes("/api/runs?project="), "the page must actually fetch the run projection");
    // The verdicts must not be rendered by one shared branch: "inconclusive" and
    // "clean" looking the same on screen is the bug this milestone exists to fix.
    assert.ok(html.includes("terr-unknown") && html.includes("terr-clean") && html.includes("terr-bad"),
      "clean, inconclusive and violated must each have their own visual class");
  } finally { d.stop(); fx.done(); }
});
