#!/usr/bin/env node
// SCH Loop dashboard — LIVE (SSE), no-flicker, fluid. Zero dependencies.
// Server pushes state over Server-Sent Events whenever state.json changes; the
// client patches only the sections that changed and never touches a section you
// are typing in. Binds 127.0.0.1 and authenticates every request against the
// shared token below; set SCH_BIND (e.g. a Tailscale IP) to reach it from a phone.

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, watch, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { statSync } from "node:fs";
import { loadRegistry, saveRegistry, loadState, mutateState, getProject, event, OFFENSIVE, suggestInterval } from "./state.mjs";
import { projection as capabilityProjection } from "./skills.mjs";
import { runProjection } from "./runner.mjs";
import { deliveryProjection } from "./delivery.mjs";
import { open as openGraph, search as graphSearch, explore as graphExplore, stats as graphStats, logQuery } from "./graph.mjs";
import { projectGraph as taskGraphProjection } from "./taskgraph.mjs";
import { canonicalState } from "./transitions.mjs";
import { schedulerProjection, taskPhases, evaluateCompletion, TASK_WORKFLOW } from "./scheduler.mjs";
import { projection as humanGateProjection } from "./humangates.mjs";
import { dashboardProjection as operationalProjection } from "./projection.mjs";
import { listPhases } from "./phases.mjs";
import { templateProjection as taskTemplateProjection } from "./workflows.mjs";
import { rosterProjection as roleRosterProjection } from "./roles.mjs";
import { projection as procedureProjection } from "./procedures.mjs";
import { projection as externalSkillProjection } from "./skillsources.mjs";
import { aggregate as aggregateUsage, splitByOutcome as splitUsageByOutcome } from "./usage.mjs";

// must resolve the same way state.mjs does, or the dashboard would watch a
// different directory than the one being written to
const ROOT = process.env.SCH_HOME || join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS_DIR = join(ROOT, "projects");
const REGISTRY = join(ROOT, "projects.json");
const PORT = process.env.SCH_PORT || 4600;
// Loopback by default. Listening on every interface is now an explicit choice
// (SCH_BIND=0.0.0.0), not something that happens to whoever starts the server.
// Authentication makes that choice defensible; it does not make it automatic.
const BIND = process.env.SCH_BIND || "127.0.0.1";
const json = (res, b) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };

// ---- data shapes pushed to clients ----
function rollup() {
  const reg = loadRegistry();
  return reg.projects.map((p) => {
    const s = loadState(p.id);
    const c = (st) => s.tasks.filter((t) => t.status === st).length;
    // "delivered" counts as done alongside "merged": the first means the commit
    // reached and was verified on the remote, the second that the in-session
    // loop finished it locally. Both are finished work; only one was pushed.
    const total = s.tasks.filter((t) => t.status !== "superseded").length, done = c("merged") + c("delivered");
    const status = total === 0 ? "new" : (c("stuck") || c("blocked")) ? "attention" : done === total ? "completed" : (c("building") || c("review") || c("changes")) ? "active" : "inprogress";
    // Blockers travel with the rollup so the home page can answer questions from
    // every project at once — the operator is on a phone and should not have to
    // open each project to discover which one is waiting on them.
    // `brief` carries the FULL plain-language question; without it the home page
    // could only show the one-line summary, which is often just a pointer to the
    // brief the operator never got to see.
    const blockers = s.tasks.filter((t) => t.status === "blocked" || t.status === "stuck")
      .map((t) => ({ id: t.id, title: t.title, notes: t.notes || "", brief: t.brief || "", status: t.status }));
    return { id: p.id, name: p.name, domain: p.domain, offensive: OFFENSIVE.has(p.domain), authorized: p.scope?.authorized ?? false, halt: p.scope?.halt ?? false, status, total, done, pending: c("queued"), building: c("building"), review: c("review"), blocked: c("blocked"), stuck: c("stuck"), findings: (s.findings || []).length, inboxNew: s.inbox.filter((i) => i.status === "new").length, pct: total ? Math.round(done / total * 100) : 0, run: s.run || null, blockers };
  });
}
// ---- knowledge graph, cached by file mtime -------------------------------
// The graph is thousands of nodes and every SSE push would otherwise re-open and
// re-query it. Recompute only when the database has actually changed.
const gCache = new Map();
// Build a readable slice of the graph: seed with the most-connected nodes, then
// pull in the neighbours they connect TO. Picking purely by degree selects hubs
// whose neighbours all fall outside the set, leaving dots with no lines.
function coreMap(db, seedCount) {
  // The map shows a CONNECTED core, not everything — 3,000 dots is a hairball.
  // Seed with the most-connected nodes, then pull in the neighbours they are
  // connected TO: picking by degree alone selects hubs whose neighbours all
  // fall outside the set, leaving a map of dots with almost no lines.
  const seeds = db.prepare(`
    SELECT n.id,n.kind,n.name,n.path,
           (SELECT COUNT(*) FROM edge e WHERE e.src=n.id OR e.dst=n.id) AS deg
    FROM node n WHERE deg > 0 ORDER BY deg DESC, n.name LIMIT ?`).all(seedCount);
  const ids = new Set(seeds.map((n) => n.id));
  const edges = db.prepare(`SELECT src,dst,kind FROM edge
                            WHERE src IN (SELECT value FROM json_each(?))
                               OR dst IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify([...ids]), JSON.stringify([...ids]))
    .slice(0, seedCount * 7);
  const extra = [...new Set(edges.flatMap((e) => [e.src, e.dst]))].filter((i) => !ids.has(i)).slice(0, seedCount * 3);
  const core = seeds.concat(extra.length
    ? db.prepare(`SELECT id,kind,name,path,1 AS deg FROM node
                  WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(extra))
    : []);
  const keep = new Set(core.map((n) => n.id));
  const mapEdges = edges.filter((e) => keep.has(e.src) && keep.has(e.dst));
  return { nodes: core, edges: mapEdges };
}

function graphView(project) {
  const p = join(PROJECTS_DIR, project, "graph.db");
  let mtime = 0;
  try { mtime = statSync(p).mtimeMs; } catch { return null; }   // no graph yet
  const hit = gCache.get(project);
  if (hit && hit.mtime === mtime) return hit.view;
  try {
    const db = openGraph(project);
    const s = graphStats(db);
    // newest facts first — this is the "it is learning" feed
    const recent = db.prepare(`SELECT id,kind,name,path,line,summary,updatedAt FROM node
                               ORDER BY updatedAt DESC LIMIT 14`).all();
    const { nodes: core, edges: mapEdges } = coreMap(db, 24);
    const queries = db.prepare("SELECT ts,source,tool,q,hits,ms FROM query_log ORDER BY ts DESC LIMIT 12").all();
    db.close();
    const view = { stats: s, recent, queries, map: { nodes: core, edges: mapEdges } };
    gCache.set(project, { mtime, view });
    return view;
  } catch (e) {
    // a swallowed error here is indistinguishable from "no graph yet" — say it
    console.error(`[graph] ${project}: ${e.message}`);
    return null;
  }
}

const snapshot = (project) => {
  if (!project) return { projects: rollup() };
  if (!getProject(project)) return { error: "gone" };
  const state = loadState(project);
  // recomputed from the live queue every push — the right interval changes as the
  // queue drains or the loop ends up waiting on the operator
  return { project: getProject(project), state, advice: suggestInterval(state), graph: graphView(project),
           supervisor: supervisorView(project), worker: workerView(project),
           spend: spendView(project) };
};

// Is a queue process actually alive for this project? Read directly rather than
// inferred from the last heartbeat, so the buttons reflect the machine and not a
// guess about it. Never throws: a dashboard that 500s because the supervisor
// file is malformed is worse than one that says NOT_RUNNING.
function supervisorView(project) {
  try {
    const p = join(PROJECTS_DIR, project, "supervisor.json");
    const c = JSON.parse(readFileSync(p, "utf8"));
    let alive = false;
    if (c.pid) { try { process.kill(c.pid, 0); alive = true; } catch {} }
    return { intent: c.intent ?? "STOPPED", running: alive, pid: alive ? c.pid : null,
             started_at: c.started_at ?? null,
             // "STARTING" was a lie whenever the queue had exited on its own —
             // which it does at every human gate, and after every completed run.
             // EXITED says the intent was to run and the process is gone, which
             // is the state an operator has to actually respond to.
             state: alive ? "RUNNING" : (c.intent === "RUNNING" ? "EXITED" : c.intent ?? "STOPPED") };
  } catch { return { intent: "STOPPED", running: false, pid: null, started_at: null, state: "STOPPED" }; }
}

// WHAT THE WORKER IS ACTUALLY DOING — the question a progress bar cannot answer.
// The newest run directory holds the prompt SCH built and everything the worker
// printed, so this is the real transcript rather than a summary of it. Capped
// hard: a live tail is for watching, and shipping a megabyte of stdout to a
// phone on every SSE push would cost more than the run.

// The CLI envelope, made readable. `result` is what the model said; the handoff
// block inside it is machinery the operator does not need to read, so it is
// separated rather than deleted.

function modelSplit(mu){
  if(!mu||typeof mu!=="object") return [];
  return Object.entries(mu).map(([model,v])=>({ model,
    output: Number(v&&v.outputTokens)||0, cost_usd: Number(v&&v.costUSD)||0 }))
    .sort((a,b)=>b.cost_usd-a.cost_usd);
}
function pickPrimaryModel(mu){ const b=modelSplit(mu); return b.length?b[0].model:null; }

function readCliShown(raw) {
  const text = String(raw ?? "");
  const trimmed = text.trim();
  let said = text, usage = null;
  if (trimmed.startsWith("{")) {
    try {
      const d = JSON.parse(trimmed);
      if (typeof d.result === "string") {
        said = d.result;
        const u = d.usage ?? {};
        usage = { input: u.input_tokens ?? null, output: u.output_tokens ?? null,
                  cache_read: u.cache_read_input_tokens ?? null,
                  cache_write: u.cache_creation_input_tokens ?? null,
                  cost_usd: d.total_cost_usd ?? null, turns: d.num_turns ?? null,
                  // same rule as the runner: the model that cost the most did
                  // the work. Two different rules produced two different answers
                  // for one run, which is how this was found.
                  model: pickPrimaryModel(d.modelUsage),
                  models: modelSplit(d.modelUsage) };
      }
    } catch { /* not the envelope; show it as-is */ }
  }
  const i = said.indexOf("<<<SCH_HANDOFF_JSON>>>");
  const handoff = i === -1 ? "" : said.slice(i);
  if (i !== -1) said = said.slice(0, i).trim();
  return { said, handoff, usage };
}
const WORKER_TAIL = 6000;
function workerView(project) {
  try {
    const p = getProject(project); if (!p) return null;
    const runs = join(repositoryRootOf(p), ".sch-loop", "runs");
    const dirs = readdirSync(runs).filter((d) => d.startsWith("RUN-")).sort();
    if (!dirs.length) return null;
    const dir = join(runs, dirs[dirs.length - 1]);
    const grab = (f, n) => { try { const s = readFileSync(join(dir, f), "utf8"); return s.length > n ? s.slice(-n) : s; } catch { return ""; } };
    // stdout.log is now the CLI's own JSON envelope. Showing it raw put an
    // escaped wall of "\\n\\\"summary\\\":..." on the page — technically the
    // truth, and unreadable. Unwrap to what the model actually said, and lift
    // the token counts out as facts rather than leaving them buried in it.
    const shown = readCliShown(grab("stdout.log", WORKER_TAIL * 4));
    let meta = {}; try { meta = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")); } catch {}
    const st = (() => { try { return statSync(join(dir, "stdout.log")); } catch { return null; } })();
    return {
      run_id: dirs[dirs.length - 1],
      task_id: meta.task_id ?? null, role: meta.role ?? meta.semantic ?? null,
      updated_at: st ? st.mtime.toISOString() : null,
      said: shown.said.slice(-WORKER_TAIL),
      handoff: (() => { try { return JSON.parse(readFileSync(join(dir, "handoff.json"), "utf8")); }
                        catch { return null; } })(),
      usage: shown.usage,
      stderr: grab("stderr.log", 1500),
      // the instruction half, so "what is it doing" includes what it was asked
      task_prompt: grab("user-prompt.txt", 2500),
    };
  } catch { return null; }
}
function repositoryRootOf(p) { return p.path; }

// SPEND, per task and for the project. Read once from the run records and
// attached to the snapshot, so the token cost of a task is visible in the queue
// rather than only after opening it — the question "what did that cost" should
// never require a click.
//
// Cost per hour is deliberately measured over the WALL CLOCK the project has
// been running, not the sum of worker durations: an operator budgeting a day
// needs the burn rate they will actually be billed at.
function spendView(project) {
  const p = getProject(project); if (!p) return null;
  const runsDir = join(repositoryRootOf(p), ".sch-loop", "runs");
  let dirs = [];
  try { dirs = readdirSync(runsDir).filter((d) => d.startsWith("RUN-")); } catch { return null; }
  const perTask = {};
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, fresh = 0, cost = 0, measured = 0, first = null, last = null;
  let apiMs = 0, ctxWindow = null, ctxLast = null;
  const models = new Map();
  for (const d of dirs) {
    const dir = join(runsDir, d);
    let run = null, u = null;
    try { run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")); } catch { continue; }
    try { u = JSON.parse(readFileSync(join(dir, "usage.json"), "utf8")); } catch {}
    const t = String(run.task_id ?? "");
    const started = run.started_at ? Date.parse(run.started_at) : null;
    if (started) { first = first === null ? started : Math.min(first, started); last = Math.max(last ?? 0, started); }
    if (!u || u.usage_status !== "REPORTED") continue;
    measured++;
    apiMs += Number(u.duration_ms) || 0;
    // the model's own declared window, so "how full was the context" is the
    // model's number rather than an assumption about which model ran
    const win = Number(u.context_window) || null;
    if (win) ctxWindow = Math.max(ctxWindow || 0, win);
    ctxLast = (u.input_tokens || 0) + (u.cache_read_tokens || 0) + (u.cache_write_tokens || 0);
    // "input" means everything the model read: fresh + cache-read + cache-write.
    const freshIn = u.input_tokens || 0, cr = u.cache_read_tokens || 0, cw = u.cache_write_tokens || 0;
    const inn = freshIn + cr + cw, out = u.output_tokens || 0;
    const c = u.reported_cost_usd ?? u.estimated_cost_usd ?? 0;
    input += inn; output += out; cacheRead += cr; cacheWrite += cw; fresh += freshIn; cost += c;
    if (u.model) models.set(u.model, (models.get(u.model) || 0) + c);
    const e = perTask[t] || (perTask[t] = { input: 0, output: 0, cache_read: 0, cost: 0, runs: 0, models: [] });
    e.input += inn; e.output += out; e.cache_read += cr; e.fresh = (e.fresh||0) + freshIn; e.cost += c; e.runs++;
    if (u.model && !e.models.includes(u.model)) e.models.push(u.model);
  }
  const hours = first && last && last > first ? (last - first) / 3600000 : 0;
  // lines changed across everything this project delivered — the "+1883/-69"
  // of a status line, from git rather than from anybody's report of it
  let added = 0, removed = 0;
  // Delivered work lives on its task branches, not on master — diffing master
  // reported "+0/-0" for a project that had shipped seven tasks. Sum each
  // delivered branch against the base it forked from.
  try {
    const root = repositoryRootOf(p);
    const g = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 20 });
    const done = (loadState(project).tasks || []).filter((x) => ["merged", "delivered"].includes(x.status));
    for (const task of done) {
      const branch = task.branch || ("sch/task-" + task.id);
      try {
        const base = g("merge-base", "HEAD", branch).trim();
        for (const ln of g("diff", "--numstat", base + ".." + branch).split("\n")) {
          const m = /^(\d+)\s+(\d+)\s/.exec(ln);
          if (m) { added += +m[1]; removed += +m[2]; }
        }
      } catch { /* branch pruned after delivery: nothing to count */ }
    }
  } catch { /* not a git repo, or git unavailable */ }
  const totalTok = input + output;
  const minutes = hours * 60;
  return {
    input, output, cache_read: cacheRead, cache_write: cacheWrite, fresh, cost,
    cache_hit: input > 0 ? cacheRead / input : null,
    measured_runs: measured, unmeasured_runs: dirs.length - measured,
    hours, cost_per_hour: hours > 0.02 ? cost / hours : null,
    api_ms: apiMs,
    tokens_total: totalTok,
    tokens_per_min: minutes > 0.5 ? totalTok / minutes : null,
    context_window: ctxWindow, context_last: ctxLast,
    lines_added: added, lines_removed: removed,
    by_model: [...models.entries()].map(([m, c]) => ({ model: m, cost: c })).sort((a, b) => b.cost - a.cost),
    per_task: perTask,
  };
}

// One task, every attempt: what it was asked, what it printed, what it decided,
// what it actually changed, and what it cost. Read from the run directories the
// engine already writes — nothing new is recorded to make this view possible.
const MAX_DIFF = 40000, MAX_OUT = 20000;
function taskDetail(project, taskId) {
  const p = getProject(project);
  const root = repositoryRootOf(p);
  const task = (loadState(project).tasks || []).find((t) => t.id === taskId) || null;
  const runsDir = join(root, ".sch-loop", "runs");
  const read = (f, n) => { try { const s = readFileSync(f, "utf8"); return s.length > n ? s.slice(-n) : s; } catch { return ""; } };
  const jread = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

  let dirs = [];
  try { dirs = readdirSync(runsDir).filter((d) => d.startsWith("RUN-")).sort(); } catch {}
  const attempts = [];
  for (const d of dirs) {
    const dir = join(runsDir, d);
    const run = jread(join(dir, "run.json"));
    if (!run || String(run.task_id ?? "") !== String(taskId)) continue;
    const handoff = jread(join(dir, "handoff.json"));
    const usage = jread(join(dir, "usage.json"));
    const worker = jread(join(dir, "worker.json"));
    attempts.push({
      run_id: d, attempt: run.attempt ?? null, role: run.role ?? run.semantic ?? null,
      outcome: run.outcome ?? null, failure: run.failure ?? null,
      started_at: run.started_at ?? null, duration_ms: worker?.duration_ms ?? null,
      // what it was asked, what it printed, what it concluded
      task_prompt: read(join(dir, "user-prompt.txt"), 4000),
      output: read(join(dir, "stdout.log"), MAX_OUT),
      stderr: read(join(dir, "stderr.log"), 2000),
      summary: handoff?.summary ?? null,
      decisions: handoff?.decisions ?? [],
      issues: handoff?.issues ?? [],
      files_reported: handoff?.files_reported_changed ?? [],
      commands: handoff?.commands_reported ?? [],
      tests: handoff?.tests_reported ?? [],
      effects: jread(join(dir, "git-effects.json"))?.counts ?? null,
      usage: usage ? {
        status: usage.usage_status, model: usage.model,
        fresh_input: usage.input_tokens,
        input: (usage.input_tokens || 0) + (usage.cache_read_tokens || 0) + (usage.cache_write_tokens || 0),
        output: usage.output_tokens,
        cache_read: usage.cache_read_tokens, cache_write: usage.cache_write_tokens,
        total: typeof usage.output_tokens === "number"
          ? (usage.input_tokens || 0) + (usage.cache_read_tokens || 0) + (usage.cache_write_tokens || 0) + usage.output_tokens : null,
        cost_usd: usage.reported_cost_usd ?? usage.estimated_cost_usd ?? null,
        characters: usage.characters ?? null,
      } : null,
    });
  }

  // THE DIFF, from git rather than from the worker's account of it. A task's
  // branch against the base it started from is the only honest answer to "what
  // did this actually change".
  let diff = "", diffStat = "", branch = task?.branch || `sch/task-${taskId}`;
  try {
    const g = (...a) => execFileSync("git", ["-C", root, ...a], { windowsHide: true, encoding: "utf8", maxBuffer: 1 << 22 });
    const base = g("merge-base", "HEAD", branch).trim();
    diffStat = g("diff", "--stat", `${base}..${branch}`).trim();
    diff = g("diff", `${base}..${branch}`);
    if (diff.length > MAX_DIFF) diff = diff.slice(0, MAX_DIFF) + `\n… truncated at ${MAX_DIFF} characters`;
  } catch (e) { diffStat = `no diff available (${String(e.message).split("\n")[0]})`; }

  const totals = attempts.reduce((a, x) => ({
    input: a.input + (x.usage?.input ?? 0), output: a.output + (x.usage?.output ?? 0),
    cache_read: a.cache_read + (x.usage?.cache_read ?? 0),
    cost: a.cost + (x.usage?.cost_usd ?? 0),
  }), { input: 0, output: 0, cache_read: 0, cost: 0 });

  return { project, task_id: taskId, title: task?.title ?? null, status: task?.status ?? null,
           ac: task?.ac ?? [], ng: task?.ng ?? [], branch, diff, diff_stat: diffStat,
           attempts, totals };
}

// ---- SSE ----
const clients = new Set();
const send = (c) => { try { c.res.write("data: " + JSON.stringify(snapshot(c.project)) + "\n\n"); } catch {} };
let deb;
const pushAll = () => { clearTimeout(deb); deb = setTimeout(() => clients.forEach(send), 200); };
try { watch(PROJECTS_DIR, { recursive: true }, pushAll); } catch {}
try { watch(REGISTRY, pushAll); } catch {}
setInterval(() => clients.forEach((c) => { try { c.res.write(": ping\n\n"); } catch {} }), 25000); // keep-alive

// CSRF: same-origin headers alone are spoofable by a non-browser client on the
// tailnet. Every mutating form carries this per-process token; a POST without it
// is rejected. Rotates on restart (a stale tab simply reloads).
// AUTHENTICATION, which CSRF is not.
//
// CSRF stops a third-party site driving this dashboard through the operator's
// browser. It does nothing about a client that simply connects - and this server
// can halt a project, disarm scope and answer a blocked question. So every
// request must carry a shared secret, and anything without one is refused
// before it learns that any project exists.
//
// Stored, not rotated per start: a token that changes on every restart cannot be
// bookmarked on a phone, and an operator who has to re-copy a secret hourly ends
// up disabling the check.
const TOKEN_FILE = join(ROOT, "dashboard-token");
function loadOrCreateToken() {
  try {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length >= 32) return t;
  } catch { /* first start */ }
  const t = randomBytes(32).toString("hex");
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, t + String.fromCharCode(10), { mode: 0o600 });
  try { chmodSync(TOKEN_FILE, 0o600); } catch { /* best effort off POSIX */ }
  return t;
}
const TOKEN = loadOrCreateToken();

// Hashed before comparing so the lengths always match: timingSafeEqual throws on
// a length mismatch, and that throw is itself a signal.
const sha = (s) => createHash("sha256").update(String(s)).digest();
const tokenOk = (given) => {
  if (!given) return false;
  try { return timingSafeEqual(sha(given), sha(TOKEN)); } catch { return false; }
};
const cookieToken = (req) => {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "sch_token") return decodeURIComponent(v.join("="));
  }
  return null;
};
const presentedToken = (req, url) => {
  const h = req.headers.authorization ?? "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return url.searchParams.get("token") ?? cookieToken(req);
};
// 401 and NOTHING else. A refusal that names projects or counts tasks has
// already answered the question the caller was not allowed to ask.
const unauthorized = (res) => {
  res.writeHead(401, { "content-type": "text/plain", "www-authenticate": "Bearer" });
  res.end("unauthorized");
};

// A LOGIN PAGE, not a second secret. The passphrase IS the existing token, so
// there is exactly one credential to rotate and the bookmarked ?token= URL keeps
// working. Browsers get a form; scripts and the event stream still get a bare
// 401, because a login page returned to `curl` is just a confusing 200.
//
// The page itself leaks nothing: no project names, no counts, no version. A
// wrong passphrase and an unreachable server look identical from outside.
const wantsHtml = (req) => (req.headers.accept || "").includes("text/html");
const loginPage = (res, failed = false) => {
  res.writeHead(failed ? 401 : 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>SCH·LOOP</title>
<style>
  :root{--bg:#0b0b0b;--fg:#e8e6e3;--dim:#6b6964;--line:#242424;--red:#ff3b30;--panel:#111}
  *{box-sizing:border-box}
  body{margin:0;min-height:100svh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
       font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
       padding:max(20px,env(safe-area-inset-top)) 20px max(20px,env(safe-area-inset-bottom))}
  form{width:100%;max-width:340px}
  h1{font-size:26px;letter-spacing:-.02em;margin:0 0 2px;text-transform:uppercase}
  p{color:var(--dim);font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin:0 0 22px}
  label{display:block;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin-bottom:6px}
  input{width:100%;font:inherit;font-size:16px;padding:12px;background:var(--panel);color:var(--fg);
        border:1px solid var(--line)}
  input:focus{outline:none;border-color:var(--fg)}
  button{width:100%;margin-top:12px;font:inherit;font-weight:700;font-size:13px;letter-spacing:.1em;
         text-transform:uppercase;padding:13px;background:var(--fg);color:#000;border:0;cursor:pointer}
  button:active{opacity:.8}
  .e{margin-top:14px;padding:9px 11px;border-left:2px solid var(--red);color:var(--red);font-size:12px}
</style>
<form method="POST" action="/login">
  <h1>SCH&middot;Loop</h1>
  <p>operations</p>
  <label for="p">Passphrase</label>
  <input id="p" name="passphrase" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Unlock</button>
  ${failed ? '<div class="e">Incorrect passphrase.</div>' : ""}
</form>`);
};

const CSRF = randomUUID();
const sameOrigin = (req) => { const h = req.headers.host, s = req.headers.origin || req.headers.referer; if (!h || !s) return false; try { return new URL(s).host === h; } catch { return false; } };
const forbid = (res) => { res.writeHead(403); res.end("forbidden"); };
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(new URLSearchParams(b))); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }

  // The login form is the ONE route reachable unauthenticated, so it is kept
  // deliberately small: same-origin only, no CSRF token (the caller has no
  // session yet to carry one), and it grants nothing but the same cookie the
  // ?token= URL already grants.
  if (url.pathname === "/login") {
    if (req.method !== "POST") return tokenOk(presentedToken(req, url)) ? (res.writeHead(302, { location: "/" }), res.end()) : loginPage(res);
    if (!sameOrigin(req)) return forbid(res);
    const given = (await body(req)).get("passphrase") || "";
    if (!tokenOk(given.trim())) return loginPage(res, true);
    res.writeHead(303, {
      "set-cookie": `sch_token=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      location: "/",
    });
    return res.end();
  }
  if (url.pathname === "/logout") {
    res.writeHead(303, { "set-cookie": "sch_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0", location: "/login" });
    return res.end();
  }

  // Before anything else, including the event stream.
  // A browser gets the login page; curl, the event stream and every API caller
  // still get a bare 401, because an HTML form returned to a script is noise.
  if (!tokenOk(presentedToken(req, url)))
    return req.method === "GET" && wantsHtml(req) && url.pathname !== "/events" ? loginPage(res) : unauthorized(res);
  // A token that arrived in the query becomes a cookie and leaves the URL, so it
  // stops appearing in browser history, bookmarks and any proxy log.
  if (url.searchParams.get("token")) {
    url.searchParams.delete("token");
    res.writeHead(302, {
      "set-cookie": `sch_token=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      location: url.pathname + (url.searchParams.toString() ? "?" + url.searchParams : ""),
    });
    res.end();
    return;
  }

  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const client = { res, project: url.searchParams.get("project") || null };
    clients.add(client); send(client);
    req.on("close", () => clients.delete(client));
    return;
  }

  if (req.method === "POST") {
    if (!sameOrigin(req)) return forbid(res);
    const p = await body(req);
    if (p.get("csrf") !== CSRF) return forbid(res);
    const back = (id) => { res.writeHead(303, { location: id ? "/?project=" + encodeURIComponent(id) : "/" }); res.end(); };
    // RUN CONTROL. The dashboard owns the operator's intent and nothing else:
    // it never decides what to build, what passes, or what ships. Pause and stop
    // release the scheduler's lease, which the scheduler checks before each
    // task — so the task in flight always finishes and a delivery is never torn
    // in half. There is deliberately no "force kill" button.
    if (url.pathname === "/run") {
      const project = p.get("project"), action = p.get("action");
      if (getProject(project) && ["start", "pause", "resume", "stop"].includes(action)) {
        try {
          const SUP = await import("./supervisor.mjs");
          if (action === "pause") await SUP.pause(project);
          else if (action === "stop") await SUP.stop(project);
          else SUP[action](project, { maxTasks: 50, env: { ...process.env, SCH_CLAUDE_ARGS: process.env.SCH_CLAUDE_ARGS ?? "-p --dangerously-skip-permissions" } });
          mutateState(project, (s) => event(s, `run control: ${action} (dashboard)`));
        } catch (e) { try { mutateState(project, (s) => event(s, `run control ${action} failed: ${e.message}`)); } catch {} }
      }
      return back(project);
    }

    // WHICH MODEL RUNS WHICH ROLE. Stored on the project, applied by roles.mjs
    // at resolve time — the scheduler and the executor learn nothing new.
    if (url.pathname === "/models") {
      const project = p.get("project"), role = p.get("role"), model = p.get("model");
      try {
        const R = await import("./roles.mjs");
        if (getProject(project) && R.ROLE_IDS.includes(role) && R.SELECTABLE_MODELS.includes(model)) {
          const reg = loadRegistry();
          const proj = reg.projects.find((x) => x.id === project);
          if (proj) {
            proj.modelPolicy = proj.modelPolicy || {};
            proj.modelPolicy.models = proj.modelPolicy.models || {};
            // choosing the profile default again clears the override rather than
            // pinning a value that would then stop tracking the profile
            const def = R.modelForRole(role, { }).model;
            if (model === def) delete proj.modelPolicy.models[role];
            else proj.modelPolicy.models[role] = model;
            saveRegistry(reg);
            mutateState(project, (s) => event(s, `model: ${role} -> ${model}`));
          }
        }
      } catch { /* a bad value simply does not apply */ }
      return back(project);
    }

    if (url.pathname === "/inbox") {
      const project = p.get("project"), text = (p.get("text") || "").trim();
      if (project && text && getProject(project)) { mutateState(project, (s) => { s.inbox.unshift({ id: ++s.seq.inbox, text, status: "new", createdAt: new Date().toISOString() }); event(s, `inbox +: ${text.slice(0, 60)}`); }); }
      return back(project);
    }
    if (url.pathname === "/answer") {
      const project = p.get("project"), id = Number(p.get("id")), text = (p.get("text") || "").trim();
      if (getProject(project) && text) {
        mutateState(project, (s) => {
        const t = s.tasks.find((x) => x.id === id);
        if (t) {
          // Preserve the QUESTION — overwriting notes with the answer destroyed the
          // option list, leaving a bare letter the loop could not resolve.
          if (!t.question) t.question = t.notes || "";
          t.answers = [...(t.answers || []), { text, ts: new Date().toISOString() }];
          t.status = "queued"; t.priority = 1;
          t.notes = "ANSWERED: " + text + (t.question ? "\n\nQUESTION ASKED: " + t.question : "");
          t.updatedAt = new Date().toISOString();
          event(s, `task #${id} answered "${text.slice(0, 40)}" -> requeued p1`);
        }
        });
      }
      return back(p.get("back") === "home" ? null : project);
    }
    if (url.pathname === "/inbox-del") {
      const project = p.get("project"), id = Number(p.get("id"));
      if (getProject(project)) {
        mutateState(project, (s) => {
          const item = s.inbox.find((i) => i.id === id);
          if (item) { s.inbox = s.inbox.filter((i) => i.id !== id); event(s, `inbox item #${id} deleted: ${item.text.slice(0, 60)}`); }
        });
      }
      return back(project);
    }
    if (url.pathname === "/task") {
      const project = p.get("project"), id = Number(p.get("id")), action = p.get("action");
      if (getProject(project)) { mutateState(project, (s) => { const t = s.tasks.find((x) => x.id === id); if (t) { if (action === "requeue") t.status = "queued"; else if (action === "bump") { t.phase = 0; t.priority = 1; } else if (action === "hold") t.status = "blocked"; else if (action === "close") t.status = "superseded"; t.updatedAt = new Date().toISOString(); event(s, `dashboard: task #${id} ${action}`); } }); }
      return back(project);
    }
    if (url.pathname === "/scope") {
      const id = p.get("project"), action = p.get("action"); const reg = loadRegistry(); const proj = reg.projects.find((x) => x.id === id);
      if (proj) { proj.scope = proj.scope || { targets: [], outOfScope: [], halt: false }; if (action === "halt") proj.scope.halt = true; else if (action === "resume") proj.scope.halt = false; else if (action === "disarm") proj.scope.authorized = false; else if (action === "arm") proj.scope.authorized = true; saveRegistry(reg); mutateState(id, (s) => { event(s, `dashboard: scope ${action}`); }); }
      return back(id);
    }
    return forbid(res);
  }

  if (url.pathname === "/api/projects") return json(res, rollup());
  if (url.pathname === "/api/models") {
    const project = url.searchParams.get("project");
    if (!getProject(project)) return json(res, { error: "no such project" });
    try {
      const R = await import("./roles.mjs");
      const proj = getProject(project);
      return json(res, {
        choices: R.SELECTABLE_MODELS,
        roles: R.ROLE_IDS.map((id) => ({
          id, purpose: R.ROLES[id].purpose,
          writes: !R.ROLES[id].writes_from_task_policy ? R.ROLES[id].writes.length > 0 : true,
          ...R.modelForRole(id, proj),
        })),
      });
    } catch (e) { return json(res, { error: String(e?.message || e).slice(0, 140) }); }
  }
  if (url.pathname === "/api/limits") {
    try { const L = await import("./limits.mjs"); return json(res, await L.fetchLimits()); }
    catch (e) { return json(res, { available: false, reason: String(e?.message || e).slice(0, 140) }); }
  }
  if (url.pathname === "/api/state") { const s = snapshot(url.searchParams.get("project")); return json(res, s); }

  // EVERYTHING ABOUT ONE TASK. A fresh agent is spawned per task, so per-task is
  // the only grouping that matches reality: its own worker, its own diff, its
  // own token bill. Fetched on demand rather than pushed on the SSE stream —
  // diffs and transcripts are large, and nobody is reading all of them at once.
  if (url.pathname === "/api/task") {
    const project = url.searchParams.get("project"), taskId = url.searchParams.get("task");
    if (!getProject(project) || !taskId) return json(res, { error: "no such task" });
    return json(res, taskDetail(project, Number(taskId)));
  }
  // live search over what the loop knows — the same query the agents make
  // A denser map on demand. The default is a readable core, not the whole graph —
  // but the operator must be able to see more when they want to.
  // Skill registry + capability profile for one project. Fetched once when the
  // project page is built rather than pushed on every SSE tick: this is
  // configuration, it changes when a human changes it, and re-deriving it 5x a
  // minute would cost more than it tells anyone.
  if (url.pathname === "/api/capabilities") {
    const project = url.searchParams.get("project");
    const p = getProject(project);
    if (!p) return json(res, { error: "no such project" });
    try { return json(res, capabilityProjection(p, { taskType: url.searchParams.get("type") })); }
    catch (e) { return json(res, { error: e.message }); }
  }
  // Supervised external runs for one project: what ran, on what, how it went,
  // and whether it is waiting on a person. Bounded by design — stdout and stderr
  // stay on disk and are referenced, never inlined, because they are unbounded
  // and may contain anything the repository or the worker produced.
  if (url.pathname === "/api/runs") {
    const project = url.searchParams.get("project");
    if (!getProject(project)) return json(res, { error: "no such project" });
    try { return json(res, runProjection(project, { limit: Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 10))) })); }
    catch (e) { return json(res, { error: e.message }); }
  }
  // Git delivery transactions for one project: what is being pushed, where it
  // stands, and whether it is waiting on a person to approve it. READ ONLY —
  // approving and delivering are operator authority and stay on the CLI until
  // this dashboard has authentication, which it does not.
  if (url.pathname === "/api/deliveries") {
    const project = url.searchParams.get("project");
    if (!getProject(project)) return json(res, { error: "no such project" });
    try { return json(res, deliveryProjection(project, { limit: Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 10))) })); }
    catch (e) { return json(res, { error: e.message }); }
  }
  // ------------------------------------------------------ the task graph
  //
  // Everything below is READ ONLY, and stays that way until this dashboard has
  // authentication. Claiming a task, approving a delivery and deciding a human
  // gate are authority; a page anyone on the tailnet can open is not the place
  // to exercise it. Each payload says so in its own body rather than relying on
  // whoever adds the next button to remember.
  if (url.pathname === "/api/task-graph") {
    const project = url.searchParams.get("project");
    if (!getProject(project)) return json(res, { error: "no such project" });
    try { return json(res, taskGraphProjection(project, { canonicalState })); }
    catch (e) { return json(res, { error: e.message }); }
  }
  // The sequential scheduler: which one is live, where it is, and why it stopped.
  if (url.pathname === "/api/scheduler") {
    const project = url.searchParams.get("project");
    if (!getProject(project)) return json(res, { error: "no such project" });
    try { return json(res, schedulerProjection(project, { limit: Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 10))) })); }
    catch (e) { return json(res, { error: e.message }); }
  }
  // Every phase of every attempt for one task, with its lifecycle state — the
  // same records a restarted scheduler reads to work out where it was.
  if (url.pathname === "/api/phases") {
    const project = url.searchParams.get("project");
    const task = Number(url.searchParams.get("task"));
    if (!getProject(project)) return json(res, { error: "no such project" });
    if (!Number.isInteger(task)) return json(res, { error: "need ?task=<n>" });
    try {
      const p = taskPhases(project, task);
      return json(res, {
        ...p,
        attempts: p.attempts.map((a) => ({
          ...a,
          phases: listPhases(a.dir).map((x) => ({
            phase_id: x.phase_id, kind: x.kind, role: x.role, state: x.state, outcome: x.outcome,
            failure: x.failure, envelope_type: x.envelope_type, envelope_hash: x.envelope_hash,
            gates: (x.gate_reports ?? []).map((g) => ({ gate_id: g.gate_id, outcome: g.outcome, kind: g.kind })),
            accounting: x.accounting, duration_ms: x.duration_ms,
          })),
        })),
      });
    } catch (e) { return json(res, { error: e.message }); }
  }
  // Gate reports: what was checked, with its evidence, per attempt.
  if (url.pathname === "/api/gates") {
    const project = url.searchParams.get("project");
    const task = Number(url.searchParams.get("task"));
    const only = url.searchParams.get("gate");
    if (!getProject(project)) return json(res, { error: "no such project" });
    if (!Number.isInteger(task)) return json(res, { error: "need ?task=<n>" });
    try {
      const rows = [];
      for (const a of taskPhases(project, task).attempts)
        for (const p of listPhases(a.dir))
          for (const g of p.gate_reports ?? [])
            if (!only || g.gate_id === only) rows.push({ attempt: a.attempt, phase_id: p.phase_id, ...g });
      return json(res, { project, task_id: task, gate: only, reports: rows });
    } catch (e) { return json(res, { error: e.message }); }
  }
  // Typed human decisions. Listing them here is right; deciding them here is not.
  if (url.pathname === "/api/human-gates") {
    const project = url.searchParams.get("project");
    if (!getProject(project)) return json(res, { error: "no such project" });
    try { return json(res, humanGateProjection(project)); }
    catch (e) { return json(res, { error: e.message }); }
  }
  // Deterministic project completion — every clause, with its evidence.
  if (url.pathname === "/api/completion") {
    const project = url.searchParams.get("project");
    if (!getProject(project)) return json(res, { error: "no such project" });
    try { return json(res, evaluateCompletion(project)); }
    catch (e) { return json(res, { error: e.message }); }
  }
  // The SQLite operational projection. A PROJECTION — never the authority — so
  // a read here can never block the scheduler that is writing it (WAL).
  if (url.pathname === "/api/operations") {
    const project = url.searchParams.get("project");
    if (!getProject(project)) return json(res, { error: "no such project" });
    try { return json(res, operationalProjection(project, { limit: Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 20))) })); }
    catch (e) { return json(res, { error: e.message }); }
  }
  // ------------------------------------------- the software-factory runtime
  //
  // ALL READ-ONLY, and one rule governs every payload below: raw prompts never
  // leave the machine. Hashes, sizes and section names travel; the system and
  // user prompt bodies stay on local disk. An unauthenticated page that could
  // print a prompt is an unauthenticated page that prints whatever the
  // repository put in one.
  if (url.pathname === "/api/workflow-templates") {
    try { return json(res, taskTemplateProjection()); } catch (e) { return json(res, { error: e.message }); }
  }
  if (url.pathname === "/api/roles") {
    try { return json(res, roleRosterProjection()); } catch (e) { return json(res, { error: e.message }); }
  }
  if (url.pathname === "/api/procedures") {
    try { return json(res, procedureProjection()); } catch (e) { return json(res, { error: e.message }); }
  }
  // One task's whole workflow, actor lane by actor lane.
  if (url.pathname === "/api/workflow-trace") {
    const project = url.searchParams.get("project");
    const task = Number(url.searchParams.get("task"));
    if (!getProject(project)) return json(res, { error: "no such project" });
    if (!Number.isInteger(task)) return json(res, { error: "need ?task=<n>" });
    try {
      const t = (loadState(project).tasks ?? []).find((x) => x.id === task);
      const attempts = taskPhases(project, task).attempts.map((a) => ({
        attempt: a.attempt, scheduler_id: a.scheduler_id, run_id: a.run_id, completed: a.recovery.completed,
        phases: listPhases(a.dir).map((p) => ({
          phase_id: p.phase_id, kind: p.kind, role: p.role ?? null,
          actor_lane: p.kind === "AGENT" ? "AGENT" : p.kind === "HUMAN" ? "ENGINEER" : p.kind === "GATE" ? "GATE" : "CODE",
          state: p.state, outcome: p.outcome, duration_ms: p.duration_ms,
          envelope_type: p.envelope_type, envelope_hash: p.envelope_hash,
          gates: (p.gate_reports ?? []).map((g) => ({ gate_id: g.gate_id, outcome: g.outcome, kind: g.kind })),
          // sizes and hashes only — never the prompt itself
          prompt_characters: p.accounting?.prompt_characters ?? null,
          output_bytes: p.accounting?.output_bytes ?? null,
        })),
      }));
      return json(res, { project, task_id: task, workflow_id: t?.workflow_id ?? null,
        workflow: t?.workflow_binding ?? null, attempts, raw_prompts_available: false,
        note: "prompt bodies are local-only; this API exposes hashes and sizes" });
    } catch (e) { return json(res, { error: e.message }); }
  }
  // Usage and cost, with UNKNOWN shown as UNKNOWN.
  if (url.pathname === "/api/usage") {
    const project = url.searchParams.get("project");
    if (!getProject(project)) return json(res, { error: "no such project" });
    try {
      const rows = [];
      for (const t of loadState(project).tasks ?? [])
        for (const a of taskPhases(project, t.id).attempts) {
          let meta = null;
          try { meta = JSON.parse(readFileSync(join(a.dir, "attempt.json"), "utf8")); } catch { continue; }
          if (!meta?.run_dir) continue;
          try {
            const u = JSON.parse(readFileSync(join(meta.run_dir, "usage.json"), "utf8"));
            rows.push({ ...u, task_id: t.id, attempt: a.attempt, phase_outcome: a.recovery.completed ? "ACCEPTED" : "FAILED" });
          } catch {}
        }
      return json(res, { project, phases: rows.length, total: aggregateUsage(rows),
        by_task: aggregateUsage(rows, { by: "task_id" }), by_outcome: splitUsageByOutcome(rows),
        note: "UNKNOWN is counted, never summed as zero — a total with unknown phases is incomplete and says so" });
    } catch (e) { return json(res, { error: e.message }); }
  }
  // External skill governance. Listing only: approving, syncing and trusting are
  // operator authority and stay on the CLI while this dashboard has no auth.
  if (url.pathname === "/api/external-skills") {
    try { return json(res, externalSkillProjection()); } catch (e) { return json(res, { error: e.message }); }
  }
  // Everything an operator has to look at, in one place.
  if (url.pathname === "/api/attention") {
    const project = url.searchParams.get("project");
    if (!getProject(project)) return json(res, { error: "no such project" });
    try {
      const items = [];
      const ext = externalSkillProjection();
      for (const s of ext.skills) {
        if (s.trust === "UNREVIEWED" && s.risk_level !== "LOW") items.push({ kind: "SKILL_APPROVAL", detail: `${s.skill_id} is ${s.risk_level} risk and unreviewed`, source: s.source_id });
        if (s.changed_since_review) items.push({ kind: "SKILL_CHANGED", detail: `${s.skill_id} changed since it was reviewed; its approval lapsed`, source: s.source_id });
        if (s.conflicts) items.push({ kind: "SKILL_CONFLICT", detail: `${s.skill_id} has ${s.conflicts} conflict(s) with SCH machinery`, source: s.source_id });
      }
      for (const s of ext.sources) if (s.out_of_date) items.push({ kind: "SOURCE_OUT_OF_DATE", detail: `${s.id} is pinned to ${String(s.pinned_commit).slice(0, 8)} but synced at ${String(s.synced_commit).slice(0, 8)}` });
      const tv = taskTemplateProjection();
      for (const t of loadState(project).tasks ?? []) {
        const b = t.workflow_binding;
        if (b && !tv.templates.some((x) => x.template_id === b.template_id && x.version === b.template_version))
          items.push({ kind: "MALFORMED_TEMPLATE", detail: `task #${t.id} ran ${b.template_id}@${b.template_version}, which no longer exists`, task_id: t.id });
        if (b?.invalidated_approvals) items.push({ kind: "WORKFLOW_APPROVAL_INVALIDATED", detail: `task #${t.id}: its workflow template changed, invalidating template-bound approvals`, task_id: t.id });
      }
      for (const p of roleRosterProjection().model_profiles) if (!p.available)
        items.push({ kind: "MODEL_UNAVAILABLE", detail: `${p.id}: ${p.unavailable_reason}` });
      return json(res, { project, items, count: items.length, generated_at: new Date().toISOString() });
    } catch (e) { return json(res, { error: e.message }); }
  }

  // The workflow definition itself, so a UI never hardcodes the phase list.
  if (url.pathname === "/api/workflow")
    return json(res, { schema_version: 1, workflow: TASK_WORKFLOW.map((p) => ({ id: p.id, kind: p.kind, role: p.role ?? null, output_schema: p.output_schema, gates: p.gates })) });

  if (url.pathname === "/api/graph-map") {
    const project = url.searchParams.get("project");
    const limit = Math.max(24, Math.min(600, Number(url.searchParams.get("limit") || 24)));
    if (!getProject(project)) return json(res, { error: "no such project" });
    try { const db = openGraph(project); const m = coreMap(db, limit); db.close(); return json(res, m); }
    catch (e) { return json(res, { error: e.message }); }
  }
  if (url.pathname === "/api/graph") {
    const project = url.searchParams.get("project"), q = url.searchParams.get("q") || "";
    if (!getProject(project)) return json(res, { error: "no such project" });
    try {
      const db = openGraph(project);
      const t0 = Date.now();
      const rows = q.trim() ? graphExplore(db, q, { depth: 1, limit: 8 }) : [];
      if (q.trim()) logQuery(db, { source: "dash", tool: "explore", q, hits: rows.length, ms: Date.now() - t0 });
      db.close();
      return json(res, rows);
    } catch (e) { return json(res, { error: e.message }); }
  }
  if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE.replace("__CSRF__", CSRF)); return; }
  res.writeHead(404); res.end("not found");
});
server.listen(Number(PORT), BIND, () => {
  // The port ACTUALLY bound, which is not PORT when PORT is 0.
  const p = server.address()?.port ?? PORT;
  console.log(`SCH Loop dashboard (live) on http://${BIND}:${p}`);
  console.log(`open it with: http://${BIND}:${p}/?token=${TOKEN}`);
});

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>SCH·LOOP // OPS</title>
<style>
  :root{color-scheme:dark;--bg:#0a0a0a;--panel:#121212;--panel2:#171717;--line:#282828;--fg:#eaeaea;--dim:#7d7d7d;--red:#ff2a2a;--green:#4af626;--amber:#e3b341;--blue:#58a6ff;}
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--fg);font:clamp(12px,1vw,14px)/1.5 ui-monospace,"JetBrains Mono","Cascadia Code",Consolas,monospace}
  body{padding:clamp(12px,2.2vw,28px);padding:max(env(safe-area-inset-top),clamp(12px,2.2vw,28px)) clamp(12px,2.2vw,28px)}
  body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:9;background:repeating-linear-gradient(0deg,transparent 0 2px,rgba(255,255,255,.015) 2px 3px)}
  .wrap{width:100%;max-width:min(1600px,100%);margin-inline:auto;position:relative;z-index:1}
  a{color:var(--fg);text-decoration:none}
  h1{font-family:"Archivo Black",Inter,system-ui,sans-serif;font-weight:900;text-transform:uppercase;letter-spacing:-.03em;line-height:.92;font-size:clamp(1.7rem,5vw,3.4rem);margin:0 0 .08em}
  h2{font-size:clamp(10px,1vw,12px);text-transform:uppercase;letter-spacing:.14em;color:var(--dim);margin:0;padding:10px 0 6px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  h2::before{content:"[ "}h2 .n{color:var(--dim)}h2 .n::after{content:" ]"}
  .mono{font-variant-numeric:tabular-nums}
  .bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);border-bottom:2px solid var(--red);padding-bottom:9px;margin-bottom:22px}
  .dot{width:8px;height:8px;background:var(--green);display:inline-block;margin-right:6px;animation:blink 1.6s step-end infinite}
  .live{color:var(--green)} .stale{color:var(--red)}
  @keyframes blink{50%{opacity:.25}}
  .sub{color:var(--dim);text-transform:uppercase;letter-spacing:.1em;font-size:11px;margin:0 0 18px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .back{display:inline-flex;align-items:center;gap:6px;background:var(--panel2);border:1px solid var(--line);padding:8px 14px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--fg);transition:border-color .15s,background .15s}
  .back:hover{border-color:var(--red);background:#1d1d1d}
  section{margin-bottom:14px;animation:fade .18s ease}
  @keyframes fade{from{opacity:.55}to{opacity:1}}
  .upd{animation:flash .5s ease}
  @keyframes flash{0%{background:rgba(74,246,38,.05)}100%{background:transparent}}
  /* grids */
  .grid{display:grid;gap:1px;background:var(--line);border:1px solid var(--line)}
  .cards{grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr))}
  .kpis{grid-template-columns:repeat(auto-fit,minmax(84px,1fr))}
  .cell{background:var(--panel);padding:12px 14px}
  .kpi{background:var(--panel);padding:9px 12px}.kpi b{display:block;font-size:clamp(16px,2.4vw,22px);font-weight:800;line-height:1;margin-bottom:2px}.kpi span{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.09em}
  .kpi.active b{color:var(--amber)}.kpi.inprogress b,.kpi.review b{color:var(--blue)}.kpi.completed b{color:var(--green)}.kpi.attention b,.kpi.awaiting b{color:var(--red)}
  .id{color:var(--red);font-size:11px;letter-spacing:.06em}
  .badge{font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:2px 6px;border:1px solid var(--line)}
  .badge::before{content:"["}.badge::after{content:"]"}
  .b-off{color:var(--red);border-color:var(--red)}.b-auth{color:var(--green);border-color:var(--green)}.b-halt{color:#fff;background:var(--red);border-color:var(--red)}
  /* status colors */
  .st{font-size:10px;font-weight:700;letter-spacing:.06em;padding:2px 6px;border:1px solid var(--line);white-space:nowrap}
  .st-building{color:var(--amber)}.st-review,.st-changes{color:var(--blue)}.st-merged,.st-completed{color:var(--green)}
  .st-blocked,.st-stuck,.st-attention{color:var(--red)}.st-queued,.st-new,.st-idle{color:var(--dim)}
  .st-inprogress{color:var(--blue)}.st-active{color:var(--amber)}.st-superseded{color:var(--dim);text-decoration:line-through}
  /* attention */
  .attn{border:1px solid var(--red);border-left:4px solid var(--red);background:rgba(255,42,42,.07);padding:12px 15px}
  .attn>b{color:var(--red);letter-spacing:.1em;display:block;margin-bottom:8px}
  .attn-row{padding:8px 0;border-top:1px solid rgba(255,42,42,.25)}.attn-row:first-of-type{border-top:0}
  /* Decisions the loop took itself: informational, so amber and collapsed — the
     work is already moving and this is a chance to overrule, not a chore. */
  .assumed{border:1px solid var(--line);border-left:4px solid var(--amber);background:var(--panel);margin-top:10px}
  .assumed>summary{cursor:pointer;padding:9px 12px;font-size:11px;color:var(--amber);letter-spacing:.06em;
                   text-transform:uppercase;list-style:none}
  .assumed>summary::-webkit-details-marker{display:none}
  .assumed>summary::before{content:"▸ "} .assumed[open]>summary::before{content:"▾ "}
  .assumed>summary:hover{color:var(--fg)}
  .assumed .attn-row{padding:8px 12px;border-top:1px solid var(--line)}
  .acall{color:var(--green);font-size:12px;margin:3px 0 2px}
  /* A question is READ, on a phone, before a decision. It gets real line breaks
     (the loop writes them; this used to collapse them all into a wall of text),
     a readable measure, and its own scroll if it is long. */
  /* Fill the row. A fixed ch-cap left most of a desktop row empty, which reads as
     broken. Readable line length comes from multi-column on wide screens instead,
     so the text stays scannable without wasting the space. */
  .attn-row .q{opacity:.92;margin:7px 0 11px;line-height:1.62;white-space:pre-wrap;
               font-size:12.5px;padding:11px 14px;background:rgba(0,0,0,.28);
               border-left:2px solid rgba(255,42,42,.4)}
  /* One column, always. Newspaper columns made a decision text run down the left
     and continue on the right — fine for an article you are browsing, wrong for
     a question you must read completely before answering. Cap the measure
     instead: ~80 characters is the readable line length. */
  .attn-row .q{max-width:78ch}
  /* keep a label and its option together rather than orphaned at a column break */
  .attn-row .q .qlabel,.attn-row .q .qopt{break-after:avoid;page-break-after:avoid}
  .attn-row .q .qlabel{color:var(--red);letter-spacing:.06em;font-weight:700}
  .attn-row .q .qopt{color:var(--green);font-weight:700}
  .ans{display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap}.ans input{flex:1;min-width:180px;font-family:inherit;font-size:15px;padding:9px 11px;background:var(--panel);color:var(--fg);border:1px solid var(--line)}.ans input:focus{outline:none;border-color:var(--green)}
  .ans button,.go{font-family:inherit;padding:8px 14px;background:var(--green);color:#000;border:0;font-weight:700;font-size:11px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
  .scope{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--red);padding:12px 15px;font-size:12px;line-height:1.7}.scope b{color:var(--red);letter-spacing:.1em}
  .acts{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap}
  form.inl{display:inline;margin:0}
  .mini{font-family:inherit;padding:6px 11px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:var(--panel2);color:var(--fg);border:1px solid var(--line);cursor:pointer}
  .mini:hover{border-color:var(--fg)}.mini.danger{background:var(--red);border-color:var(--red);color:#fff}.mini.go{border-color:var(--green);color:var(--green)}
  .row-form{display:flex;gap:8px;margin:8px 0}.row-form input{flex:1;min-width:0;font-family:inherit;padding:11px 12px;background:var(--panel);color:var(--fg);border:1px solid var(--line);font-size:16px}.row-form input:focus{outline:none;border-color:var(--red)}
  .row-form button{font-family:inherit;padding:11px 18px;background:var(--red);color:#fff;border:0;font-weight:700;letter-spacing:.1em;text-transform:uppercase;font-size:13px;cursor:pointer}
  .empty{color:var(--dim);padding:12px 14px;border:1px dashed var(--line);text-transform:uppercase;font-size:11px;letter-spacing:.1em}
  .ev{color:var(--dim);font-size:11.5px;padding:4px 0;border-bottom:1px solid var(--line)}.ev b{color:var(--fg)}
  /* phase strip */
  /* project brief + tech stack */
  .brief{background:var(--panel);border:1px solid var(--line);border-left:2px solid var(--green);padding:11px 14px;margin-bottom:10px}
  .bdesc{margin:0 0 8px;font-size:13px;line-height:1.65;color:var(--fg);opacity:.92}
  .stack{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
  .slabel{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);margin-right:4px}
  /* stack as plain selectable text (copy/paste friendly), not chips */
  .stext{font-size:12.5px;color:var(--fg);opacity:.9;user-select:all;line-height:1.6}
  .copy{margin-left:8px;padding:2px 8px;font-size:10px}
  .bdesc{user-select:all}
  .catchip{font-size:9px;text-transform:uppercase;letter-spacing:.06em;padding:1px 5px;border:1px solid var(--line);color:var(--dim)}
  .brief-empty{border-left-color:var(--line);color:var(--dim);font-size:12px}
  .brief-empty code{font-size:11px;color:var(--fg);background:#171717;padding:1px 5px}
  /* LIVE WORK TREE: category › phase › tasks. Everything visible at once.
     The columns are PHASES, not categories: an engagement with one category
     (every pentest) was rendering as a single 340px column with the rest of a
     1600px screen left blank, and 9 phases stacked into one endless scroll. */
  .phase-strip{display:flex;flex-direction:column;gap:10px}
  .cat{border:1px solid var(--line);background:var(--panel);
       display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));align-items:start}
  .cat-h{grid-column:1/-1;display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:8px 11px;
         background:#151515;font-size:11px;text-transform:uppercase;letter-spacing:.1em}
  .cat-n{color:var(--fg);font-weight:700}.cat-c{color:var(--dim);font-size:10px}
  /* each phase is a cell: separated by its own rules, not by the stack order */
  .ph{border-top:1px solid var(--line);border-left:1px solid var(--line);min-width:0}
  .ph-h{display:flex;align-items:center;gap:8px;padding:6px 11px;background:#121212}
  .ph-n{flex:1;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ph-c{font-size:10px;color:var(--dim)}
  .pbar{width:52px;height:3px;background:#222;flex:none}
  .pbar i{display:block;height:100%;background:var(--green)}
  /* one task line */
  .tk{display:flex;align-items:center;gap:8px;padding:5px 11px 5px 14px;font-size:11.5px;border-top:1px solid #1a1a1a}
  .tk-d{width:6px;height:6px;flex:none;background:var(--dim)}
  .tk-id{color:var(--dim);font-size:10px;flex:none}
  .tk-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg);opacity:.9}
  .tk-s{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);flex:none}
  .tk.st-merged .tk-d{background:var(--green)} .tk.st-merged .tk-t{opacity:.5;text-decoration:line-through}
  .tk.st-building .tk-d{background:var(--amber)} .tk.st-review .tk-d,.tk.st-changes .tk-d{background:#58a6ff}
  .tk.st-blocked .tk-d,.tk.st-stuck .tk-d{background:var(--red)}
  .tk.st-blocked .tk-s,.tk.st-stuck .tk-s{color:var(--red)}
  .tk.st-superseded{display:none}
  .donebox>summary{cursor:pointer;padding:4px 11px 4px 14px;font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;border-top:1px solid #1a1a1a;list-style:none}
  .donebox>summary::-webkit-details-marker{display:none}
  .donebox>summary::before{content:"▸ ";color:var(--green)}
  .donebox[open]>summary::before{content:"▾ "}
  .donebox>summary:hover{color:var(--fg)}
  /* .tk sets display:flex, which overrides the browser's hiding of closed
     <details> content — so hide it explicitly when the box is collapsed. */
  .donebox:not([open]) .tk{display:none}
  .tk-none{padding:5px 11px 5px 14px;font-size:10.5px;color:var(--dim);font-style:italic}
  /* RUNNING NOW — pulsing green ring so you can see what the loop is building */
  @keyframes ring{0%,100%{box-shadow:inset 0 0 0 1px rgba(74,246,38,.9),0 0 6px rgba(74,246,38,.25)}
                  50%{box-shadow:inset 0 0 0 1px rgba(74,246,38,.35),0 0 14px rgba(74,246,38,.5)}}
  .tk.running{animation:ring 1.5s ease-in-out infinite;background:rgba(74,246,38,.06)}
  .tk.running .tk-t{opacity:1;color:#fff}
  .tk.running .tk-s{color:var(--green);font-weight:700}
  .tk.running .tk-d{background:var(--green)}
  .ph.running .ph-n{color:var(--green)}
  .cat.running{border-color:rgba(74,246,38,.55)}
  /* a planned submission is history, not a live item — it goes quiet (grey rail)
     but never leaves the page, so you can always re-read what you asked for */
  .ibx{border:1px solid var(--line);border-left:2px solid var(--line);background:var(--panel);margin-bottom:6px}
  .ibx.pending{border-left-color:var(--amber)}
  .ibx-st{font-size:9px;text-transform:uppercase;letter-spacing:.07em;padding:2px 6px;flex:none;border:1px solid}
  .ibx-st.is-sub{color:var(--amber);border-color:var(--amber)}
  .ibx-st.is-add{color:var(--green);border-color:#1f3d18}
  .ibx-n{font-size:10px;color:var(--dim);flex:none}
  .ibx-tk{border-top:1px solid #1a1a1a}
  .ibx-tr{display:flex;align-items:center;gap:8px;padding:4px 11px;font-size:11.5px;border-top:1px solid #151515}
  .ibx-tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg);opacity:.9}
  .ibx-none{padding:7px 11px;font-size:11px;color:var(--dim);font-style:italic;border-top:1px solid #1a1a1a}
  .ibx-h{display:flex;align-items:center;gap:10px;padding:8px 10px;background:#141414;cursor:pointer;list-style:none}
  .ibx-h::-webkit-details-marker{display:none}
  .ibx-h::before{content:"▸";color:var(--dim);flex:none}
  .ibx.pending>.ibx-h::before{color:var(--amber)}
  .ibx[open]>.ibx-h{border-bottom:1px solid var(--line)}
  .ibx[open]>.ibx-h::before{content:"▾"}
  .ibx-h:hover{background:#191919}
  .ibx-id{font-size:10px;letter-spacing:.08em;color:var(--amber);font-weight:700;flex:none}
  .ibx-t{font-size:10px;color:var(--dim);flex:none}
  .ibx-pv{font-size:11.5px;color:var(--dim);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ibx-b{padding:9px 11px;font-size:12.5px;line-height:1.65;white-space:pre-wrap;color:var(--fg);opacity:.92;max-height:240px;overflow-y:auto}
  .ibx-f{padding:0 10px 9px;display:flex;justify-content:flex-end}
  /* tasks planned out of an inbox submission carry its id, so a request is traceable */
  .srcchip{font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:var(--amber);border:1px solid rgba(227,179,65,.5);padding:1px 5px;margin-left:6px}
  .livenow{color:var(--green);text-transform:none;letter-spacing:0;font-size:11px;flex:1;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  @media(prefers-reduced-motion:reduce){.tk.running{animation:none;box-shadow:inset 0 0 0 1px var(--green)}}
  /* LOOP HEALTH — is the loop actually running, or is the page just "live"? */
  .loop{display:flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid var(--line);
        background:var(--panel);font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}
  .loop .lb{width:8px;height:8px;flex:none}
  .loop.ok{border-color:rgba(74,246,38,.4)}.loop.ok .lb{background:var(--green);animation:blink 1.6s step-end infinite}
  .loop.late{border-color:var(--amber)}.loop.late .lb{background:var(--amber)}
  .loop.dead{border-color:var(--red);border-left:4px solid var(--red);background:rgba(255,42,42,.08)}
  .loop.dead .lb{background:var(--red)} .loop.dead b{color:var(--red)}
  .loop .lx{color:var(--dim);text-transform:none;letter-spacing:0;font-size:11px}
  .loop .cmd{color:var(--fg);background:#1c1c1c;padding:1px 7px;border:1px solid var(--line);
             text-transform:none;letter-spacing:0;user-select:all}
  /* WHAT IS HAPPENING NOW — the line that tells idle from dead at a glance */
  .now{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:-10px 0 0;
       padding:8px 12px;border:1px solid var(--line);border-top:0;background:#101010;font-size:11px}
  .now b{text-transform:uppercase;letter-spacing:.1em;flex:none}
  .now .nb{width:8px;height:8px;flex:none}
  .now .nid{color:var(--dim);flex:none}
  .now .nt{flex:1;min-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)}
  .now .nx{color:var(--dim);flex:none}
  .now.working{border-color:rgba(74,246,38,.45);background:rgba(74,246,38,.06)}
  .now.working b{color:var(--green)}
  .now.working .nb{background:var(--green);animation:ring 1.5s ease-in-out infinite;border-radius:50%}
  .now.working .nt{color:#fff}
  .now.idle b{color:var(--dim)} .now.idle .nb{background:var(--dim)} .now.idle .nt{color:var(--dim)}
  .lastev{display:flex;align-items:baseline;gap:8px;padding:5px 12px;border:1px solid var(--line);
          border-top:0;background:#0d0d0d;font-size:10.5px}
  .lastev .lel{color:var(--dim);text-transform:uppercase;letter-spacing:.1em;flex:none}
  .lastev .let{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg);opacity:.85}
  .lastev .lea{color:var(--dim);flex:none}
  .pgw{width:110px;height:5px;background:#222;flex:none;border:1px solid var(--line)}
  .pgw i{display:block;height:100%;background:var(--green)}
  .pgn{color:var(--dim);flex:none;font-size:10px}
  @media(prefers-reduced-motion:reduce){.now.working .nb{animation:none}}
  .advice{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px;margin:-10px 0 10px;
          padding:6px 12px;border:1px solid var(--line);border-top:0;background:#111;font-size:11px}
  .advice b{color:var(--green);text-transform:uppercase;letter-spacing:.08em;flex:none}
  .advice span{color:var(--dim)}
  .advice code{background:#1c1c1c;border:1px solid var(--line);padding:0 5px;color:var(--fg);user-select:all}
  .advice.off{border-color:var(--amber)} .advice.off b{color:var(--amber)}
  .advice .now{color:var(--amber)}
  /* tap-to-answer option buttons — one tap on a phone beats typing the exact word */
  .opts{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:7px}
  .opt{font-family:inherit;font-size:12px;font-weight:700;padding:9px 14px;cursor:pointer;
       background:var(--panel2);color:var(--fg);border:1px solid var(--green);letter-spacing:.04em}
  .opt:hover,.opt:active{background:var(--green);color:#000}
  /* cross-project blockers on the home page */
  .xp{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px}
  .xp a{color:var(--red)}
  /* task table */
  .toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}
  .toolbar input,.toolbar select{font-family:inherit;font-size:12px;padding:7px 10px;background:var(--panel);color:var(--fg);border:1px solid var(--line)}
  .toolbar input{flex:1;min-width:140px}.toolbar input:focus,.toolbar select:focus{outline:none;border-color:var(--red)}
  .tbl-wrap{overflow-x:auto;border:1px solid var(--line)}
  table.t{width:100%;border-collapse:collapse;font-size:12px}
  table.t th{background:var(--panel2);color:var(--dim);text-transform:uppercase;letter-spacing:.08em;font-size:10px;text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap;position:sticky;top:0}
  table.t td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  table.t tbody tr{border-left:3px solid transparent}
  table.t tr.st-building{border-left-color:var(--amber)}table.t tr.st-review,table.t tr.st-changes{border-left-color:var(--blue)}table.t tr.st-merged{border-left-color:var(--green)}table.t tr.st-blocked,table.t tr.st-stuck{border-left-color:var(--red)}table.t tr.st-queued{border-left-color:var(--dim)}
  td.ac{white-space:nowrap}td.ac .mini{padding:4px 8px}
  .skl{margin-top:4px;display:flex;flex-wrap:wrap;gap:4px}.skl span{font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);border:1px solid var(--line);padding:1px 5px}
  .fsev{font-size:10px;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;color:#fff;font-weight:700}
  .f-critical{background:#7c0000}.f-high{background:#ff2a2a}.f-medium{background:#e67e00}.f-low{background:#2a8f6b}.f-info{background:#777}
  .frow{display:flex;gap:8px;align-items:baseline;padding:7px 10px;border-bottom:1px solid var(--line);background:var(--panel)}
  .fwarn{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--red);border:1px solid var(--red);padding:1px 5px}
  .obsbox{border:1px solid var(--line);border-top:0;background:var(--panel)}
  .obsbox>summary{cursor:pointer;padding:7px 10px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;
                  color:var(--dim);list-style:none}
  .obsbox>summary::-webkit-details-marker{display:none}
  .obsbox>summary::before{content:"▸ ";color:var(--amber)}
  .obsbox[open]>summary::before{content:"▾ "}
  .obsbox>summary:hover{color:var(--fg)}
  .bar2{display:inline-block;width:64px;height:8px;background:#222;border:1px solid var(--line);vertical-align:middle;margin-right:6px}.bar2 span{display:block;height:100%;background:var(--green)}
  .pctn{font-size:11px;color:var(--dim)}.in{background:var(--red);color:#fff;padding:1px 7px;font-weight:700;font-size:11px}
  table.projects tbody tr{cursor:pointer}table.projects tbody tr:hover td{background:#181818}
  .chips{display:flex;flex-wrap:wrap;gap:1px;background:var(--line);border:1px solid var(--line)}
  .chip{background:var(--panel);padding:8px 11px;flex:1;min-width:82px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}.chip b{display:block;font-size:clamp(15px,2vw,18px);color:var(--fg);line-height:1;margin-bottom:2px}
  .chip.active b{color:var(--amber)}.chip.inprogress b,.chip.review b{color:var(--blue)}.chip.completed b{color:var(--green)}.chip.attention b,.chip.awaiting b,.chip.failed b{color:var(--red)}
  /* ---- phone project list -------------------------------------------------
     Hidden on desktop, where the nine-column table is the right instrument. */
  #mobsec{display:none}
  .mb-h{display:flex;align-items:baseline;gap:8px;text-transform:uppercase;letter-spacing:.14em;
        font-size:10px;color:var(--dim);padding:14px 12px 6px;border-bottom:1px solid var(--line)}
  .mb-n{color:var(--fg);font-weight:700}
  .mb-r{display:grid;grid-template-columns:1fr auto auto;align-items:center;column-gap:8px;row-gap:5px;
        padding:10px 12px;min-height:44px;text-decoration:none;color:var(--fg);
        border-bottom:1px solid var(--line);border-left:3px solid transparent}
  .mb-r.st-attention,.mb-r.st-blocked{border-left-color:var(--red)}
  .mb-r.st-active{border-left-color:var(--amber)}
  .mb-r.st-inprogress{border-left-color:var(--blue)}
  .mb-r.st-completed{border-left-color:var(--green)}
  .mb-r:active{background:#181818}
  .mb-nm{font-weight:700;font-size:15px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mb-d{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}
  .mb-f{font-size:9px;padding:1px 5px;text-transform:uppercase;letter-spacing:.06em}
  .mb-a{grid-column:3;min-width:20px;height:20px;padding:0 6px;background:var(--red);color:#fff;
        font-weight:700;font-size:11px;display:grid;place-items:center}
  .mb-2{grid-column:1/-1;display:flex;align-items:center;gap:7px;min-width:0}
  .mb-2 .bar2{flex:1 1 auto;width:auto;min-width:40px;margin:0;height:6px}
  /* an untouched project should read as empty, not as a filled grey slab */
  .mb-r.p0 .bar2{opacity:.35}
  .mb-p{font-size:11px;color:var(--dim);min-width:26px;text-align:right;font-variant-numeric:tabular-nums}
  .mb-c{font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums}
  .mb-l{font-size:9.5px;text-transform:uppercase;letter-spacing:.07em;padding:1px 5px;border:1px solid var(--line)}
  .mb-l.l-running{color:var(--green);border-color:var(--green)}
  .mb-l.l-late{color:var(--amber);border-color:var(--amber)}
  .mb-l.l-stopped{color:var(--dim)}
  .mb-2 .st{font-size:9.5px;padding:1px 5px}

  @media(max-width:640px){
    /* A phone gets the purpose-built list; the tables are a desktop instrument. */
    #mobsec{display:block}
    #devsec,#secsec{display:none}
    body{padding-left:max(0px,env(safe-area-inset-left));padding-right:max(0px,env(safe-area-inset-right))}
    #app{padding-bottom:max(16px,env(safe-area-inset-bottom))}
    /* the search stays reachable at a hundred projects */
    .toolbar{position:sticky;top:0;z-index:20;background:var(--bg);padding:6px 0;margin:0}
    .toolbar input{font-size:16px}  /* iOS zooms the page below 16px */
    /* The card layout used flex + space-between, so a long value was pushed off
       the right edge instead of wrapping — every row rendered as a label with an
       apparently empty value. Grid with a fixed label column and a wrapping value
       fixes it; table-layout:fixed stops the table exceeding its container. */
    .tbl-wrap{overflow-x:hidden}
    table.t{table-layout:fixed;width:100%}
    table.t thead{position:absolute;left:-9999px}
    table.t tbody tr{display:block;border:1px solid var(--line);border-left-width:3px;margin-bottom:6px}
    table.t td{display:grid;grid-template-columns:58px minmax(0,1fr);gap:4px 10px;align-items:start;
               border:0;border-bottom:1px solid var(--line);padding:6px 10px;
               white-space:normal;overflow-wrap:break-word}
    table.t td::before{content:attr(data-l);color:var(--dim);text-transform:uppercase;font-size:10px;
                       letter-spacing:.06em;padding-top:2px}
    table.t td>.cellv{min-width:0;display:block}
    table.t td[data-l=""]{grid-template-columns:1fr;justify-items:end}
    table.t td[data-l=""]::before{content:""}
    /* three columns carry little on a phone and tripled every card's height */
    table.t td[data-l="Pri"],table.t td[data-l="Target"]{display:none}
    table.t td[data-l="Activity"]{font-size:11px;color:var(--dim)}
    table.t td[data-l="Activity"]{max-height:3.6em;overflow:hidden}
    /* the work tree already truncates; on a phone let the title wrap instead */
    .tk{align-items:flex-start}
    .tk-t{white-space:normal;overflow:visible;text-overflow:clip;line-height:1.35}
    .now{font-size:11.5px}
    .now .nt{min-width:100%;white-space:normal;order:9}
    .pgw{width:88px}
  }
  /* RUN EVIDENCE — what the worker was actually given, and whether it stayed
     where it was put. Three territory verdicts, three looks: "we looked and
     found nothing", "we could not finish looking" and "it wrote outside its
     worktree" must never render as the same badge. */
  .runrow{border:1px solid var(--line);border-top:0;background:var(--panel);padding:8px 11px}
  .runrow:first-of-type{border-top:1px solid var(--line)}
  .runrow.bad{border-left:4px solid var(--red);background:rgba(255,42,42,.07)}
  .runrow.unsure{border-left:4px solid var(--amber)}
  .runh{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:11px}
  .runh .rid{color:var(--red);letter-spacing:.06em}
  .runh .rout{margin-left:auto;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;font-size:10px}
  .runl{display:grid;grid-template-columns:132px minmax(0,1fr);gap:5px 10px;margin-top:6px;font-size:11.5px}
  .runl>b{font-size:9.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);font-weight:400;padding-top:3px}
  @media(max-width:640px){.runl{grid-template-columns:1fr}.runl>b{padding-top:6px}}
  .b-warn{color:var(--amber);border-color:var(--amber)}
  .terr-clean{color:var(--green);border-color:rgba(74,246,38,.5)}
  .terr-unknown{color:var(--amber);border-color:var(--amber)}
  .terr-bad{color:#fff;background:var(--red);border-color:var(--red)}
  .terr-none{color:var(--dim)}
  .why{color:var(--dim);font-size:11px;margin-top:3px}
  .viol{border-left:2px solid var(--red);background:rgba(0,0,0,.28);padding:7px 10px;margin-top:5px;font-size:11.5px}
  .viol b{color:var(--red)}
  /* PARALLELISM — the queue runs up to max_parallel tasks at once, so one
     "current task" is a lie. One cell per slot: filled ones pulse, spare
     capacity stays dark. */
  .flight{display:flex;flex-wrap:wrap;gap:1px;background:var(--line);border:1px solid var(--line);margin-bottom:8px}
  .fl{background:var(--panel);padding:7px 11px;flex:1;min-width:158px;font-size:11px;display:flex;gap:8px;align-items:baseline}
  .fl .fd{width:7px;height:7px;flex:none;background:var(--green);border-radius:50%;animation:blink 1.6s step-end infinite}
  .fl .ft{color:var(--fg)}
  .fl .fx{margin-left:auto;color:var(--dim);font-size:10px}
  .fl.free{color:var(--dim)}.fl.free .fd{background:#2a2a2a;animation:none}
  @media(prefers-reduced-motion:reduce){.fl .fd{animation:none}}
  /* ---- knowledge graph ---- */
  .gwrap{border:1px solid var(--line);background:var(--panel)}
  .gkinds{display:flex;flex-wrap:wrap;gap:1px;background:var(--line);border-bottom:1px solid var(--line)}
  .gk{font-family:inherit;text-align:left;background:var(--panel);padding:7px 11px;font-size:10px;
      text-transform:uppercase;letter-spacing:.08em;color:var(--dim);flex:1;min-width:76px;
      border:0;border-top:2px solid var(--c);cursor:pointer}
  .gk b{display:block;font-size:15px;color:var(--c);line-height:1.1;margin-bottom:1px}
  .gk:hover{background:#171717} .gk.on{background:#191919;color:var(--fg)}
  .gbar{display:flex;gap:8px;padding:10px 12px 8px}
  .gsearch{flex:1;min-width:0;font-family:inherit;font-size:13px;padding:9px 11px;background:var(--bg);
           color:var(--fg);border:1px solid var(--line)}
  .gsearch:focus{outline:none;border-color:var(--green)}
  .gres{max-height:170px;overflow-y:auto;margin:0 12px}
  .gres:empty{display:none}
  .ghit{border-left:2px solid var(--c);padding:6px 9px;margin-bottom:4px;background:#111;font-size:12px}
  .ghit b{color:var(--fg)}
  .gcal{color:var(--green);font-size:10.5px;margin-top:3px}
  .guse{color:var(--blue);font-size:10.5px;margin-top:2px}
  .gnone{color:var(--dim);font-size:11px;padding:6px 2px}
  .gmapnote{color:var(--dim);font-size:11px;padding:2px 12px 6px;display:flex;flex-wrap:wrap;gap:8px;
            align-items:center}
  .gmapnote b{color:var(--fg)}
  .gdens{display:flex;gap:4px;align-items:center;margin-left:auto}
  .gdb{font-family:inherit;font-size:10.5px;padding:3px 8px;background:var(--bg);color:var(--dim);
       border:1px solid var(--line);cursor:pointer}
  .gdb:hover{color:var(--fg)} .gdb.on{border-color:var(--green);color:var(--green)}
  /* the map gets the room — it was squeezed into half the width with dead space beside it */
  .gcanvas-wrap{position:relative;margin:10px 12px;border:1px solid var(--line);background:#0b0b0b}
  #gcanvas{width:100%;display:block;cursor:grab;touch-action:none}
  #gcanvas:active{cursor:grabbing}
  .ghint{position:absolute;left:10px;bottom:6px;font-size:9.5px;color:var(--dim);pointer-events:none;
         letter-spacing:.04em}
  .gtip{position:absolute;display:none;pointer-events:none;background:#000;border:1px solid var(--green);
        padding:5px 8px;font-size:11px;max-width:200px;z-index:3}
  .gtip b{display:block;color:var(--fg)} .gtip span{color:var(--dim);font-size:10px}
  .gdetail{position:absolute;display:none;right:8px;top:8px;width:min(300px,62%);background:#0d0d0d;
           border:1px solid var(--green);padding:9px 11px;font-size:11.5px;z-index:4;max-height:78%;overflow-y:auto}
  .gd-h{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  .gd-h b{color:var(--green)}
  .gd-x{background:none;border:0;color:var(--dim);cursor:pointer;font-size:12px;padding:0 2px}
  .gd-m{color:var(--dim);font-size:10px;margin:2px 0 6px}
  .gd-b p{margin:0 0 6px;color:var(--fg);opacity:.9}
  .gd-l{color:var(--dim);font-size:10px;margin-top:5px}
  /* two columns of evidence: what it learned, and that it is really being asked */
  .gcols{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);border-top:1px solid var(--line)}
  @media(max-width:820px){.gcols{grid-template-columns:1fr}}
  .gcol{background:var(--panel);padding:9px 12px;min-width:0}
  .gcap{font-size:9.5px;text-transform:uppercase;letter-spacing:.11em;color:var(--dim);margin-bottom:6px}
  .glearn,.gqlog{max-height:210px;overflow-y:auto}
  .gr{border-left:2px solid var(--c);padding:5px 9px;margin-bottom:3px;background:#0f0f0f;font-size:11.5px;
      display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 8px;align-items:baseline}
  .gr-k{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--c);white-space:nowrap}
  .gr-n{color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gr-p{grid-column:2;color:var(--dim);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gr-s{grid-column:2;color:var(--dim);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  @keyframes glearned{0%{background:rgba(74,246,38,.22)}100%{background:#0f0f0f}}
  .gr.fresh{animation:glearned 2.4s ease-out}
  .gql{display:flex;gap:8px;align-items:baseline;padding:4px 6px;border-bottom:1px solid #171717;font-size:11px}
  .gql-t{color:var(--dim);font-size:10px;flex:none}
  .gql-s{color:var(--green);font-size:9px;text-transform:uppercase;letter-spacing:.06em;flex:none}
  .gql.miss .gql-s{color:var(--dim)}
  .gql-q{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg);opacity:.85}
  .gql-h{color:var(--dim);font-size:10px;flex:none}
  @media(prefers-reduced-motion:reduce){.gr.fresh{animation:none}}
  .moretasks{width:100%;margin-top:6px;font-family:inherit;padding:10px;background:var(--panel2);
             color:var(--fg);border:1px solid var(--line);font-size:11px;letter-spacing:.08em;
             text-transform:uppercase;cursor:pointer}
  .moretasks:hover{border-color:var(--red)}

  /* run control + worker transcript */
  .rcw{display:inline-flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}
  .rcs{font-size:9.5px;letter-spacing:.1em;padding:2px 7px;border:1px solid var(--line);color:var(--dim)}
  .rcs.running{color:var(--green);border-color:var(--green)}
  .rcs.paused{color:var(--amber);border-color:var(--amber)}
  .rcs.exited{color:var(--red);border-color:var(--red)}
  .rc{font-family:inherit;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
      padding:7px 13px;min-height:34px;border:1px solid var(--line);background:var(--panel2);color:var(--fg);cursor:pointer}
  .rc.go{background:var(--green);color:#000;border-color:var(--green)}
  .rc.warn{color:var(--amber);border-color:var(--amber)}
  .rc.danger{color:var(--red);border-color:var(--red)}
  .rc:active{opacity:.75}
  .wkw{border:1px solid var(--line);margin:8px 0}
  .wkh{display:flex;gap:8px;align-items:baseline;padding:8px 11px;background:var(--panel2);
       font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
  .wkh b{color:var(--fg)}
  .wkm{font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .wk>summary{cursor:pointer;padding:8px 11px;font-size:11px;color:var(--dim);border-top:1px solid var(--line)}
  .wk>summary:hover{color:var(--fg)}
  .wk pre{margin:0;padding:10px 11px;background:var(--bg);font-size:11.5px;line-height:1.45;
          white-space:pre-wrap;overflow-wrap:anywhere;max-height:46vh;overflow:auto;border-top:1px solid var(--line)}
  .wk.err pre{color:var(--red)}

  /* per-task detail: diff, reasoning, tokens */
  .tdt{color:var(--fg);text-decoration:none;border-bottom:1px dotted var(--dim)}
  .tdt:hover{color:var(--blue);border-bottom-color:var(--blue)}
  .tdrow>td{padding:0!important;border-bottom:0!important}
  .tdslot:empty{display:none}
  .td{border:1px solid var(--line);border-left:3px solid var(--blue);margin:0 0 8px}
  .tdh{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;padding:9px 11px;background:var(--panel2);
       font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}
  .tdh b{color:var(--fg)}
  .tdl{padding:12px;color:var(--dim);font-size:12px}
  .tdu{display:flex;flex-wrap:wrap;gap:1px;background:var(--line);border-bottom:1px solid var(--line)}
  .tdu.tot{border-top:1px solid var(--line)}
  .tk{background:var(--panel);padding:7px 10px;font-size:10.5px;text-transform:uppercase;
      letter-spacing:.06em;color:var(--dim);flex:1;min-width:82px}
  .tk b{display:block;font-size:14px;color:var(--fg);font-variant-numeric:tabular-nums;letter-spacing:0}
  .tk.cost b,.tk.cost{color:var(--green)}
  .tk.mdl,.tk.none{color:var(--dim);text-transform:none;letter-spacing:0}
  .tdk{padding:9px 11px 3px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--amber)}
  .tdul{margin:0;padding:0 11px 9px 26px;font-size:12px;line-height:1.5}
  .tdsum{padding:9px 11px;font-size:12.5px;border-bottom:1px solid var(--line)}
  .tda{border-top:1px solid var(--line)}
  .tda>summary{cursor:pointer;padding:9px 11px;font-size:11px;color:var(--dim)}
  .tda>summary:hover{color:var(--fg)}
  .tda>summary .ok{color:var(--green)}.tda>summary .bad{color:var(--red)}
  pre.dif{font-size:11px}

  .settled{padding:7px 11px;margin:6px 0;border-left:2px solid var(--line);
           color:var(--dim);font-size:11px;letter-spacing:.02em}

  /* One disclosure bar, one look. The activity log and the other collapsibles
     used .box, which had no rules at all — so they rendered as a bare bold line
     with the browser's default triangle next to the styled SYSTEM bar. */
  .sysbox,.box{border:1px solid var(--line);margin:14px 0}
  .sysbox>summary,.box>summary{cursor:pointer;padding:11px 13px;font-size:10.5px;letter-spacing:.12em;
                  text-transform:uppercase;color:var(--dim);background:var(--panel2)}
  .sysbox>summary:hover,.box>summary:hover{color:var(--fg)}
  .sysbox[open]>summary,.box[open]>summary{border-bottom:1px solid var(--line)}
  .sysbox>section,.boxin{padding:0 11px}

  /* ---- diff -------------------------------------------------------------
     Colour carries meaning here, so it is spent ONLY on added and removed
     lines. Context is deliberately quiet: a diff where every line competes is
     a diff nobody reads. Line numbers sit in fixed gutters so the eye tracks
     down one column instead of hunting a leading +/-.                        */
  .dfd>summary{display:flex;align-items:baseline;gap:10px}
  .dfs{color:var(--dim);font-size:10.5px;letter-spacing:.04em;text-transform:none}
  .dfw{border-top:1px solid var(--line);max-height:60vh;overflow:auto;
       font-size:12px;line-height:1.55;background:var(--bg)}
  .dfh{position:sticky;top:0;z-index:2;padding:7px 12px;background:var(--panel2);
       border-bottom:1px solid var(--line);color:var(--fg);font-size:11.5px;font-weight:700}
  .dfhunk{display:grid;grid-template-columns:44px 44px 1fr;gap:0;
          background:#101216;color:var(--dim);font-size:11px;
          border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:3px 0}
  .dfhunk>span:last-child{padding-left:10px}
  .dl{display:grid;grid-template-columns:44px 44px 1fr;gap:0}
  .dfn{text-align:right;padding:0 8px;color:#4a4a4a;font-variant-numeric:tabular-nums;
       user-select:none;border-right:1px solid #1b1b1b}
  .dc{padding:0 10px;white-space:pre-wrap;overflow-wrap:anywhere}
  .dl.ctx .dc{color:#9a9a95}
  .dl.add{background:rgba(46,160,67,.13)}
  .dl.add .dc{color:#7ee787}
  .dl.add .dc::before{content:"+";color:#3fb950;margin-left:-10px;padding-right:4px}
  .dl.del{background:rgba(248,81,73,.12)}
  .dl.del .dc{color:#ffa198}
  .dl.del .dc::before{content:"-";color:#f85149;margin-left:-10px;padding-right:4px}
  .dl.add .dfn,.dl.del .dfn{color:#6a6a6a}

  /* ---- quieter chrome ---------------------------------------------------
     Red was doing three jobs: section borders, headings and real alerts. It
     now means one thing — something needs a person — so an actual alert is
     visible instead of being one more red thing on a red page.              */
  .wkw,.td{border-left-width:1px}
  .td{border-left:1px solid var(--line)}
  h2{color:var(--dim)}
  .loop{align-items:center}

  /* ---- the glance ------------------------------------------------------
     One block, read in under a second: state word, what it is doing, how far
     along, and the controls. Colour is the state, so the page can be judged
     from across a room without reading a single label.                      */
  .hero{border:1px solid var(--line);border-top:3px solid var(--dim);margin:0 0 14px;background:var(--panel)}
  .hero.run{border-top-color:var(--green)}
  .hero.need{border-top-color:var(--red)}
  .hero.hold{border-top-color:var(--amber)}
  .hero.done{border-top-color:var(--green)}
  .hrow{display:flex;align-items:flex-start;gap:14px;padding:15px 16px 12px;flex-wrap:wrap}
  .hmain{flex:1;min-width:0}
  .hhead{font-family:"Archivo Black",Inter,system-ui,sans-serif;font-weight:900;
         font-size:clamp(1.5rem,4.5vw,2.1rem);line-height:1;letter-spacing:-.02em;text-transform:uppercase}
  .hero.run .hhead{color:var(--green)}
  .hero.need .hhead{color:var(--red)}
  .hero.hold .hhead{color:var(--amber)}
  .hero.done .hhead{color:var(--green)}
  .hsub{margin-top:6px;color:var(--dim);font-size:13px;line-height:1.45;
        overflow:hidden;text-overflow:ellipsis}
  .hbar{height:4px;background:#1c1c1c;overflow:hidden}
  .hbar>span{display:block;height:100%;background:var(--green);transition:width .4s ease-out}
  .hfacts{display:flex;flex-wrap:wrap;gap:0 20px;padding:10px 16px 13px;
          font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
  .hfacts b{color:var(--fg);font-size:14px;font-variant-numeric:tabular-nums;letter-spacing:0;margin-right:5px}
  .hfacts .bad b,.hfacts .bad{color:var(--red)}
  .hero .rcw{margin-left:0}
  @media(max-width:640px){
    .hrow{padding:13px 13px 10px}
    .hero .rcw{width:100%;margin-top:4px}
    .hero .rc{flex:1}
    .hfacts{gap:0 14px;padding:9px 13px 12px}
  }

  .spd{display:flex;flex-wrap:wrap;gap:0 18px;align-items:baseline;padding:9px 2px 13px;
       font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--dim)}
  .spd b{color:var(--fg);font-size:14px;font-variant-numeric:tabular-nums;letter-spacing:0;margin-right:5px}
  .spd .cost b{color:var(--green)}
  .spd .mdl,.spd .none{text-transform:none;letter-spacing:0;color:#5d5d5d}
  .tcost{white-space:nowrap}
  .tcv{color:var(--green);font-variant-numeric:tabular-nums}
  .tct{display:block;font-size:10px;color:var(--dim);font-variant-numeric:tabular-nums}
  @media(max-width:640px){ .spd{gap:0 12px} }

  /* account budget — fixed, on every page */
  .limitbar{position:fixed;left:0;right:0;bottom:0;z-index:60;background:var(--panel2);
            border-top:1px solid var(--line);
            padding-bottom:env(safe-area-inset-bottom)}
  .lbin{display:flex;gap:0;align-items:center;max-width:1600px;margin:0 auto;
        padding:7px 14px;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
  .lbseg{display:flex;align-items:center;gap:7px;flex:1;min-width:0}
  .lbseg+.lbseg{margin-left:16px}
  .lbl{color:#5d5d5d;min-width:64px;white-space:nowrap}
  .lbbar{flex:1;min-width:40px;height:6px;background:#1c1c1c;border:1px solid var(--line);overflow:hidden}
  .lbbar>span{display:block;height:100%;background:var(--green);transition:width .5s ease}
  .lbbar.warn>span{background:var(--amber)} .lbbar.crit>span{background:var(--red)}
  .lbv{font-variant-numeric:tabular-nums;color:var(--fg);letter-spacing:0}
  .lbv.warn{color:var(--amber)} .lbv.crit{color:var(--red)}
  .lbr{color:#5d5d5d;letter-spacing:0;white-space:nowrap}
  .lbnone{color:#5d5d5d;text-transform:none;letter-spacing:0}
  .wrap{padding-bottom:52px}
  @media(max-width:640px){ .lbin{padding:6px 11px;font-size:10px} .lbseg+.lbseg{margin-left:11px} .lbr{display:none} }

  .spd .lbl2{color:#5d5d5d;text-transform:uppercase;letter-spacing:.12em;font-size:9.5px;margin-right:2px}

  .spd .dl2 b{margin-right:7px}
  .spd .pl{color:#3fb950} .spd .mi{color:#f85149}

  .hnd .hbody{padding:2px 0 10px}
  .hsum{padding:10px 12px;font-size:13px;line-height:1.5;border-bottom:1px solid var(--line)}
  .hk{padding:11px 12px 4px;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--amber)}
  .hul{margin:0;padding:0 12px 4px 28px;font-size:12.5px;line-height:1.6}
  .hul code{background:var(--panel2);padding:1px 6px;font-size:12px}
  .hx{margin-left:8px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;padding:1px 6px;border:1px solid var(--line)}
  .hx.ok{color:var(--green);border-color:var(--green)} .hx.bad{color:var(--red);border-color:var(--red)}
  .hnx{padding:0 12px 6px;font-size:12.5px;line-height:1.55;color:var(--dim)}
  .hnd>summary .ok{color:var(--green)} .hnd>summary .warn{color:var(--amber)} .hnd>summary .bad{color:var(--red)}

  .mbox{border:1px solid var(--line);margin:10px 0}
  .mhead{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:9px 12px;background:var(--panel2);
         font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--fg)}
  .mhead span{color:var(--dim);letter-spacing:.04em;text-transform:none;font-size:11px}
  .mrow{display:grid;grid-template-columns:130px 1fr auto;gap:10px;align-items:center;
        padding:9px 12px;border-top:1px solid var(--line)}
  .mrow.pinned{border-left:2px solid var(--amber)}
  .mr1 b{font-size:12.5px}
  .mpin{margin-left:7px;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--amber)}
  .mr2{color:var(--dim);font-size:11.5px;line-height:1.4}
  .mr3{display:flex;align-items:center;gap:9px}
  .mr3 select{font-family:inherit;font-size:12px;padding:6px 9px;background:var(--panel);
              color:var(--fg);border:1px solid var(--line);min-height:34px}
  .mnote{font-size:10.5px;color:var(--dim);white-space:nowrap}
  @media(max-width:640px){
    .mrow{grid-template-columns:1fr;gap:5px}
    .mnote{white-space:normal}
  }

  /* a prompt is a document, not a log line */
  .wk pre.docpre{font-size:12.5px;line-height:1.65;padding:14px 16px;max-height:60vh}
</style></head>
<body><div class="wrap" id="app">connecting…</div><div id="limitbar" class="limitbar"></div>
<script>
const DONE=new Set(["merged","delivered"]);
const isDone=(t)=>DONE.has(t.status);
const esc=(s)=>(s??"").toString().replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const qp=(k)=>new URLSearchParams(location.search).get(k);
const OFFSET=new Set(["web-pentest","api-pentest","mobile-android","mobile-ios","red-team-external","red-team-internal","external-network","internal-network"]);
const OFF=(d)=>OFFSET.has(d);
const clock=()=>new Date().toISOString().slice(0,19).replace("T"," ")+" UTC";
const STMAP={queued:["QUEUED","st-queued"],building:["ACTIVE","st-building"],review:["IN PROGRESS","st-review"],changes:["IN PROGRESS","st-changes"],merged:["COMPLETED","st-merged"],blocked:["AWAITING","st-blocked"],stuck:["FAILED","st-stuck"],superseded:["SUPERSEDED","st-superseded"]};
const PSTAT={new:["NEW","st-new"],inprogress:["IN PROGRESS","st-inprogress"],active:["ACTIVE","st-active"],attention:["FAILED / AWAITING","st-attention"],completed:["COMPLETED","st-completed"],idle:["IDLE","st-idle"]};
let taskFilter={q:"",status:"",showSuperseded:false,showAll:false};
const CSRF="__CSRF__";
const csrf='<input type="hidden" name="csrf" value="'+CSRF+'">';

// ---- loop health -----------------------------------------------------------
// "live" in the header means the browser socket is open. It says NOTHING about
// whether the loop is running. sch-run stamps state.run on every pass-gate call,
// so absence/age of that stamp is the only honest signal — render it loudly.
const ago=(ms)=>{const m=Math.round(ms/60000);if(m<1)return"just now";if(m<60)return m+"m ago";
  const h=Math.floor(m/60);if(h<24)return h+"h "+(m%60)+"m ago";return Math.floor(h/24)+"d ago";};
function loopHealth(run){
  if(!run||!run.lastPass) return {cls:"dead",label:"LOOP NEVER RAN",detail:"no pass has ever checked in",dead:true};
  const age=Date.now()-new Date(run.lastPass).getTime();
  const iv=(run.intervalMin||0)*60000;
  const late=iv?age>iv*2:age>45*60000;          // no interval recorded → 45m grace
  const dead=iv?age>iv*4:age>3*60000*60;
  const base="pass #"+(run.passN||0)+" · "+ago(age)+(run.verdict?" · "+run.verdict.toLowerCase():"");
  if(dead)return{cls:"dead",label:"LOOP NOT RUNNING",detail:"last "+base,dead:true};
  if(late)return{cls:"late",label:"LOOP LATE",detail:"last "+base,dead:false};
  return{cls:"ok",label:"LOOP RUNNING",detail:base,dead:false};
}
// What is happening RIGHT NOW. Between passes the loop is alive but idle, which
// previously rendered as "LOOP RUNNING" and nothing else — indistinguishable from
// dead, and read as halted. Say which task is building, or say it is waiting and
// when the next pass is due.
function nowBar(run,st){
  const RUN={building:"BUILDING",review:"IN REVIEW",changes:"FIXING"};
  const t=(st.tasks||[]).find(x=>RUN[x.status]);
  const total=(st.tasks||[]).filter(x=>x.status!=="superseded").length;
  const done=(st.tasks||[]).filter(isDone).length;
  const pct=total?Math.round(done/total*100):0;
  const bar='<span class="pgw"><i style="width:'+pct+'%"></i></span><span class="pgn mono">'+
    done+'/'+total+' · '+pct+'%</span>';

  if(t){
    const since=t.startedAt||t.updatedAt;
    const mins=since?Math.round((Date.now()-new Date(since).getTime())/60000):null;
    return '<div class="now working"><span class="nb"></span>'+
      '<b>'+RUN[t.status]+'</b><span class="nid mono">#'+t.id+'</span>'+
      '<span class="nt">'+esc(t.title)+'</span>'+
      (mins!==null?'<span class="nx mono">'+mins+'m</span>':'')+bar+'</div>';
  }
  // Not every kind of work is a task. Planning, reviewing and indexing all took
  // minutes while this line said "no task building" — which read as stalled.
  if(run&&run.activity){
    const mins=Math.round((Date.now()-new Date(run.activity.since).getTime())/60000);
    return '<div class="now working"><span class="nb"></span><b>WORKING</b>'+
      '<span class="nt">'+esc(run.activity.what)+'</span>'+
      '<span class="nx mono">'+mins+'m</span>'+bar+'</div>';
  }
  // nothing building — say when the next pass is due so idle never looks dead
  let due="";
  if(run&&run.lastPass&&run.intervalMin){
    const next=new Date(run.lastPass).getTime()+run.intervalMin*60000;
    const mins=Math.round((next-Date.now())/60000);
    due=mins>0?"next pass in ~"+mins+"m":"next pass due now";
  }
  const ready=(st.tasks||[]).filter(x=>x.status==="queued").length;
  return '<div class="now idle"><span class="nb"></span><b>WAITING</b>'+
    '<span class="nt">no task building'+(ready?' · '+ready+' ready':'')+'</span>'+
    (due?'<span class="nx">'+due+'</span>':'')+bar+'</div>';
}
// ---- knowledge graph ------------------------------------------------------
// The aim, borrowed from Understand-Anything and worth restating: a graph that
// quietly TEACHES, not one that shows off how complex the codebase is. So:
// colour carries meaning (architectural layer, or kind for non-code facts),
// size carries importance, and everything else stays quiet until you point at it.
const GKIND={endpoint:"#e3b341",param:"#e3b341",role:"#e3b341",host:"#e3b341",
  finding:"#ff2a2a",evidence:"#ff5c4d",decision:"#c77dff",lesson:"#ff8f3f",note:"#8a8a8a"};
// Code nodes are coloured by their top-level directory — the layer they live in.
// Colouring 2,800 symbols all the same green says nothing; this says where.
const LAYER=["#4af626","#58a6ff","#3fd0c9","#ffd166","#f78fb3","#a0e04a","#7aa2ff","#ff9f6e"];
const layerOf=(p)=>((p||"").split("/")[0]||"·");
let LAYERMAP=new Map();
function colourOf(n){
  if(GKIND[n.kind])return GKIND[n.kind];
  const l=layerOf(n.path);
  if(!LAYERMAP.has(l))LAYERMAP.set(l,LAYER[LAYERMAP.size%LAYER.length]);
  return LAYERMAP.get(l);
}
let GSEEN=new Set(), GQ="", GRES="", GKINDFILTER="";
// how many seed nodes the map draws — the density buttons under the map set it.
// GMAP holds the denser map so a live SSE push does not snap it back to 24.
let GDENSITY=24, GMAP=null;

function graphSec(g){
  if(!g) return '<h2>knowledge graph<span class="n mono">empty</span></h2>'+
    '<div class="empty">nothing recorded yet — it fills as the loop works, and a file is indexed the moment it is edited</div>';
  const chips=g.stats.byKind.map(k=>'<button class="gk'+(GKINDFILTER===k.kind?' on':'')+'" '+
    'data-kind="'+esc(k.kind)+'" style="--c:'+(GKIND[k.kind]||"#4af626")+'" '+
    'title="Show only '+esc(k.kind)+'">'+
    '<b class="mono">'+k.n+'</b> '+esc(k.kind)+'</button>').join("");
  const rows=g.recent.map(n=>{
    const isNew=!GSEEN.has(n.id);
    return '<div class="gr'+(isNew?' fresh':'')+'" style="--c:'+colourOf(n)+'">'+
      '<span class="gr-k">'+esc(n.kind)+'</span>'+
      '<span class="gr-n">'+esc(n.name)+'</span>'+
      '<span class="gr-p mono">'+esc(n.path||"")+(n.line?":"+n.line:"")+'</span>'+
      (n.summary?'<span class="gr-s">'+esc(n.summary)+'</span>':'')+'</div>';
  }).join("");
  g.recent.forEach(n=>GSEEN.add(n.id));
  // Proof it is actually being consulted. An agent that claims to use the graph
  // and one that does look identical from outside — only one saves you tokens.
  const qs=(g.queries||[]).map(q=>'<div class="gql'+(q.hits?'':' miss')+'">'+
    '<span class="gql-t mono">'+esc(q.ts.slice(11,19))+'</span>'+
    '<span class="gql-s">'+esc(q.source)+'</span>'+
    '<span class="gql-q">'+esc(q.q)+'</span>'+
    '<span class="gql-h mono">'+q.hits+' hit'+(q.hits===1?'':'s')+' · '+q.ms+'ms</span></div>').join("")
    || '<div class="gnone">no queries yet — the loop asks the graph through the sch_graph_* tools</div>';

  return '<h2>knowledge graph — what the loop knows'+
    '<span class="n mono">'+g.stats.nodes+' facts · '+g.stats.edges+' links</span></h2>'+
    '<div class="gwrap">'+
      '<div class="gkinds">'+chips+'</div>'+
      '<div class="gbar">'+
        '<input id="gq" class="gsearch" placeholder="ask the graph…  (the same query the agents make)" '+
          'value="'+esc(GQ)+'" oninput="GQ=this.value;graphAsk()">'+
        '<button class="mini" title="Reset the map view" onclick="gReset()">reset view</button>'+
      '</div>'+
      // The header counts the whole graph; the map draws a readable slice of it.
      // Without saying so, the two numbers look like a contradiction and the whole
      // panel stops being believable.
      '<div class="gmapnote">showing <b id="gmapn">'+(g.map.nodes.length)+'</b> of '+
        g.stats.nodes+' facts — the most connected core. '+
        'Everything else is reachable by search.'+
        '<span class="gdens">density '+
          [24,60,150].map(n=>'<button class="gdb'+(GDENSITY===n?' on':'')+'" data-dens="'+n+'">'+n+'</button>').join("")+
        '</span>'+
      '</div>'+
      '<div id="gres" class="gres">'+GRES+'</div>'+
      '<div class="gcanvas-wrap">'+
        '<canvas id="gcanvas"></canvas>'+
        '<div id="gtip" class="gtip"></div>'+
        '<div id="gdetail" class="gdetail"></div>'+
        '<div class="ghint">scroll to zoom · drag to pan · drag a node to move it · click to inspect</div>'+
      '</div>'+
      '<div class="gcols">'+
        '<div class="gcol"><div class="gcap">just learned</div><div class="glearn">'+rows+'</div></div>'+
        '<div class="gcol"><div class="gcap">graph queries — proof it is being used</div><div class="gqlog">'+qs+'</div></div>'+
      '</div>'+
    '</div>';
}

let gTimer;
function graphAsk(){
  clearTimeout(gTimer);
  gTimer=setTimeout(()=>{
    const el=document.getElementById("gres"); if(!el)return;
    if(!GQ.trim()){el.innerHTML=GRES="";GHI=null;if(LAST&&LAST.graph)drawGraph(LAST.graph.map);return;}
    fetch("/api/graph?project="+encodeURIComponent(qp("project"))+"&q="+encodeURIComponent(GQ))
      .then(r=>r.json()).then(rows=>{
        if(!Array.isArray(rows)||!rows.length){
          el.innerHTML=GRES='<div class="gnone">no match — nothing recorded about that yet</div>';return;}
        // light up the matches on the map too, so search and picture agree
        GHI=new Set(rows.map(r=>r.id));
        if(LAST&&LAST.graph)drawGraph(LAST.graph.map);
        el.innerHTML=GRES=rows.map(r=>'<div class="ghit" style="--c:'+colourOf(r)+'">'+
          '<span class="gr-k">'+esc(r.kind)+'</span> <b>'+esc(r.name)+'</b> '+
          '<span class="gr-p mono">'+esc(r.path||"")+(r.line?":"+r.line:"")+'</span>'+
          (r.summary?'<div class="gr-s">'+esc(r.summary)+'</div>':'')+
          (r.callers&&r.callers.length?'<div class="gcal">← called by '+r.callers.slice(0,6).map(c=>esc(c.name)).join(", ")+'</div>':'')+
          (r.uses&&r.uses.length?'<div class="guse">→ uses '+r.uses.slice(0,6).map(c=>esc(c.name)).join(", ")+'</div>':'')+
          '</div>').join("");
      }).catch(()=>{});
  },220);
}

// ---- the map ---------------------------------------------------------------
// Canvas, no library: a small force layout with pan, zoom, hover-highlight and a
// detail panel. Everything dims when you point at something, so one relationship
// is legible at a time instead of all 60 at once.
let GSIM=null, GVIEW={x:0,y:0,k:1}, GHOV=null, GSEL=null, GHI=null;
function gReset(){ GVIEW={x:0,y:0,k:1}; GSEL=null; GSIM&&(GSIM.ticks=0); if(LAST&&LAST.graph)drawGraph(LAST.graph.map); }

function drawGraph(map){
  const cv=document.getElementById("gcanvas"); if(!cv||!map||!map.nodes.length)return;
  const dpr=window.devicePixelRatio||1;
  const w=cv.clientWidth||600, h=Math.max(340,Math.min(520,Math.round(cv.clientWidth*0.55)));
  if(cv.width!==Math.round(w*dpr)||cv.height!==Math.round(h*dpr)){
    cv.width=w*dpr; cv.height=h*dpr; cv.style.height=h+"px";
  }
  const ctx=cv.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0);

  const key=map.nodes.map(n=>n.id).join("|");
  if(!GSIM||GSIM.key!==key){
    const P=map.nodes.map((n,i)=>({...n,
      x:w/2+Math.cos(i/map.nodes.length*6.283)*Math.min(w,h)*0.33,
      y:h/2+Math.sin(i/map.nodes.length*6.283)*Math.min(w,h)*0.33,vx:0,vy:0}));
    const idx=new Map(P.map((p,i)=>[p.id,i]));
    const E=map.edges.map(e=>({s:idx.get(e.src),t:idx.get(e.dst),k:e.kind})).filter(e=>e.s!=null&&e.t!=null);
    const deg=new Map(); for(const e of E){deg.set(e.s,(deg.get(e.s)||0)+1);deg.set(e.t,(deg.get(e.t)||0)+1);}
    P.forEach((p,i)=>p.d=deg.get(i)||0);
    // who is adjacent to whom — used to dim everything else on hover
    const adj=new Map(); for(const e of E){
      if(!adj.has(e.s))adj.set(e.s,new Set()); if(!adj.has(e.t))adj.set(e.t,new Set());
      adj.get(e.s).add(e.t); adj.get(e.t).add(e.s);}
    GSIM={key,P,idx,E,adj,ticks:0};
  }
  const {P,E,adj}=GSIM;

  if(GSIM.ticks<200){
    for(let i=0;i<P.length;i++){
      for(let j=i+1;j<P.length;j++){
        const dx=P[j].x-P[i].x,dy=P[j].y-P[i].y,d2=dx*dx+dy*dy||1;
        if(d2<52900){const d=Math.sqrt(d2),f=1500/d2,fx=dx/d*f,fy=dy/d*f;
          P[i].vx-=fx;P[i].vy-=fy;P[j].vx+=fx;P[j].vy+=fy;}
      }
    }
    for(const e of E){const a=P[e.s],b=P[e.t];
      const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1,f=(d-84)*0.014;
      const fx=dx/d*f,fy=dy/d*f;a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy;}
    for(const p of P){
      if(p===GSIM.drag)continue;
      p.vx+=(w/2-p.x)*0.0014; p.vy+=(h/2-p.y)*0.0014;
      p.vx*=0.84; p.vy*=0.84; p.x+=p.vx; p.y+=p.vy;
    }
    GSIM.ticks++;
  }

  const S=(v)=>v*GVIEW.k, TX=(x)=>S(x)+GVIEW.x, TY=(y)=>S(y)+GVIEW.y;
  const focus=GSEL!=null?GSEL:GHOV;
  const near=focus!=null?(adj.get(focus)||new Set()):null;
  const lit=(i)=>focus==null?true:(i===focus||near.has(i));

  ctx.clearRect(0,0,w,h);
  // edges, curved, dimmed unless they touch the focused node
  for(const e of E){
    const a=P[e.s],b=P[e.t], on=focus==null||e.s===focus||e.t===focus;
    ctx.strokeStyle=on?(focus==null?"rgba(130,150,170,.20)":"rgba(74,246,38,.55)"):"rgba(130,150,170,.05)";
    ctx.lineWidth=on&&focus!=null?1.4:1;
    const x1=TX(a.x),y1=TY(a.y),x2=TX(b.x),y2=TY(b.y);
    const mx=(x1+x2)/2,my=(y1+y2)/2,nx=-(y2-y1)*0.12,ny=(x2-x1)*0.12;
    ctx.beginPath();ctx.moveTo(x1,y1);ctx.quadraticCurveTo(mx+nx,my+ny,x2,y2);ctx.stroke();
  }
  // nodes
  ctx.font="10px ui-monospace,Consolas,monospace";
  P.forEach((p,i)=>{
    const r=Math.max(3,Math.min(13,3+Math.sqrt(p.d||1)*1.9))*Math.min(1.6,GVIEW.k);
    const x=TX(p.x),y=TY(p.y);
    if(x<-40||x>w+40||y<-40||y>h+40)return;
    const on=lit(i), hi=GHI&&GHI.has(p.id);
    ctx.globalAlpha=on?1:0.18;
    ctx.fillStyle=colourOf(p);
    ctx.beginPath();ctx.arc(x,y,r,0,6.2832);ctx.fill();
    if(hi){ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,r+3,0,6.2832);ctx.stroke();}
    if(i===GSEL){ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,r+5,0,6.2832);ctx.stroke();}
    // label only where it can be read: big nodes, the focus, or a search hit
    if((p.d>=4&&GVIEW.k>=0.85)||i===focus||hi){
      const label=String(p.name).slice(0,20);
      const tw=ctx.measureText(label).width;
      const lx=(x+r+4+tw>w-4)?x-r-4-tw:x+r+4;
      ctx.fillStyle=on?"rgba(240,240,240,.9)":"rgba(240,240,240,.25)";
      ctx.fillText(label,Math.max(2,lx),Math.min(h-3,Math.max(9,y+3)));
    }
    ctx.globalAlpha=1;
  });
  // Legend along the TOP — at the bottom it collided with the hint line and the
  // two rendered as one unreadable strip. Colour means nothing without it.
  const layers=[...LAYERMAP.entries()].slice(0,7);
  ctx.font="9px ui-monospace,Consolas,monospace";
  let lx=10;
  for(const [name,col] of layers){
    const tw=ctx.measureText(name).width;
    if(lx+tw+22>w-8)break;                       // never wrap into the map
    ctx.fillStyle=col;ctx.beginPath();ctx.arc(lx+4,11,3.5,0,6.2832);ctx.fill();
    ctx.fillStyle="rgba(200,200,200,.62)";ctx.fillText(name,lx+11,14);
    lx+=22+tw;
  }
  if(GSIM.ticks<200)requestAnimationFrame(()=>drawGraph(map));
}

// hit-testing in graph space
function gAt(cv,ev){
  const r=cv.getBoundingClientRect(),mx=ev.clientX-r.left,my=ev.clientY-r.top;
  let best=null,bd=1e9;
  GSIM.P.forEach((p,i)=>{const x=p.x*GVIEW.k+GVIEW.x,y=p.y*GVIEW.k+GVIEW.y;
    const d=(x-mx)**2+(y-my)**2; if(d<bd){bd=d;best=i;}});
  return bd<420?best:null;
}
document.addEventListener("pointerdown",function(e){
  const cv=e.target.closest&&e.target.closest("#gcanvas"); if(!cv||!GSIM)return;
  const i=gAt(cv,e);
  GSIM.pan={x:e.clientX,y:e.clientY,vx:GVIEW.x,vy:GVIEW.y};
  GSIM.dragIdx=i; GSIM.drag=i!=null?GSIM.P[i]:null; GSIM.moved=false;
  cv.setPointerCapture(e.pointerId);
});
document.addEventListener("pointermove",function(e){
  const cv=document.getElementById("gcanvas"); if(!cv||!GSIM)return;
  if(GSIM.pan){
    GSIM.moved=true;
    if(GSIM.drag){
      const r=cv.getBoundingClientRect();
      GSIM.drag.x=(e.clientX-r.left-GVIEW.x)/GVIEW.k;
      GSIM.drag.y=(e.clientY-r.top-GVIEW.y)/GVIEW.k;
      GSIM.drag.vx=GSIM.drag.vy=0;
    }else{
      GVIEW.x=GSIM.pan.vx+(e.clientX-GSIM.pan.x);
      GVIEW.y=GSIM.pan.vy+(e.clientY-GSIM.pan.y);
    }
    if(LAST&&LAST.graph)drawGraph(LAST.graph.map);
    return;
  }
  if(!e.target.closest||!e.target.closest("#gcanvas")){if(GHOV!=null){GHOV=null;gTip(null);} return;}
  const i=gAt(cv,e);
  if(i!==GHOV){GHOV=i;gTip(i!=null?GSIM.P[i]:null,e);if(LAST&&LAST.graph)drawGraph(LAST.graph.map);}
});
document.addEventListener("pointerup",function(e){
  if(!GSIM||!GSIM.pan)return;
  const wasClick=!GSIM.moved&&GSIM.dragIdx!=null;
  GSIM.pan=null;GSIM.drag=null;
  if(wasClick){GSEL=GSIM.dragIdx;gDetail(GSIM.P[GSEL]);if(LAST&&LAST.graph)drawGraph(LAST.graph.map);}
});
document.addEventListener("wheel",function(e){
  const cv=e.target.closest&&e.target.closest("#gcanvas"); if(!cv||!GSIM)return;
  e.preventDefault();
  const r=cv.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
  const k=Math.max(0.35,Math.min(3.5,GVIEW.k*(e.deltaY<0?1.12:0.89)));
  GVIEW.x=mx-(mx-GVIEW.x)*(k/GVIEW.k); GVIEW.y=my-(my-GVIEW.y)*(k/GVIEW.k); GVIEW.k=k;
  if(LAST&&LAST.graph)drawGraph(LAST.graph.map);
},{passive:false});

function gTip(p,ev){
  const t=document.getElementById("gtip"); if(!t)return;
  if(!p){t.style.display="none";return;}
  t.style.display="block";
  t.innerHTML='<b>'+esc(p.name)+'</b><span>'+esc(p.kind)+(p.path?' · '+esc(p.path):'')+'</span>';
  const wrap=t.parentElement.getBoundingClientRect();
  t.style.left=Math.min(wrap.width-190,Math.max(4,p.x*GVIEW.k+GVIEW.x+12))+"px";
  t.style.top=Math.max(4,p.y*GVIEW.k+GVIEW.y-10)+"px";
}
// clicking a node asks the graph about it — the same call an agent makes
function gDetail(p){
  const d=document.getElementById("gdetail"); if(!d)return;
  d.style.display="block";
  // no inline onclick with quotes — this whole script lives inside a template
  // literal, and nested quoting has broken the page three separate times
  d.innerHTML='<div class="gd-h"><b>'+esc(p.name)+'</b>'+
    '<button class="gd-x" title="Close">&#10005;</button></div>'+
    '<div class="gd-m">'+esc(p.kind)+(p.path?' · '+esc(p.path):'')+'</div>'+
    '<div class="gd-b">looking it up…</div>';
  fetch("/api/graph?project="+encodeURIComponent(qp("project"))+"&q="+encodeURIComponent(p.name))
    .then(r=>r.json()).then(rows=>{
      const hit=(rows||[]).find(r=>r.id===p.id)||(rows||[])[0];
      const b=d.querySelector(".gd-b"); if(!b)return;
      if(!hit){b.textContent="nothing more recorded";return;}
      b.innerHTML=(hit.summary?'<p>'+esc(hit.summary)+'</p>':'')+
        (hit.callers&&hit.callers.length?'<div class="gcal">← called by '+hit.callers.slice(0,8).map(c=>esc(c.name)).join(", ")+'</div>':'')+
        (hit.uses&&hit.uses.length?'<div class="guse">→ uses '+hit.uses.slice(0,8).map(c=>esc(c.name)).join(", ")+'</div>':'')+
        (hit.line?'<div class="gd-l mono">'+esc(hit.path)+':'+hit.line+'</div>':'');
    }).catch(()=>{});
}
document.addEventListener("click",function(e){
  const x=e.target.closest&&e.target.closest(".gd-x");
  if(x){GSEL=null;const d=document.getElementById("gdetail");if(d)d.style.display="none";
    if(LAST&&LAST.graph)drawGraph(LAST.graph.map);return;}
});
// filter the map + feed by kind
document.addEventListener("click",function(e){
  const b=e.target.closest&&e.target.closest(".gk[data-kind]"); if(!b)return;
  GKINDFILTER=GKINDFILTER===b.dataset.kind?"":b.dataset.kind;
  GQ=GKINDFILTER?GKINDFILTER:""; const box=document.getElementById("gq");
  if(box)box.value=GQ;
  graphAsk();
});
// density: redraw the map with a bigger connected core
document.addEventListener("click",function(e){
  const b=e.target.closest&&e.target.closest(".gdb[data-dens]"); if(!b)return;
  GDENSITY=Number(b.dataset.dens);
  b.parentNode.querySelectorAll(".gdb").forEach(x=>x.classList.toggle("on",x===b));
  fetch("/api/graph-map?project="+encodeURIComponent(qp("project"))+"&limit="+GDENSITY)
    .then(r=>r.json()).then(m=>{
      if(!m||!m.nodes)return;
      GMAP=GDENSITY===24?null:m;                      // survive the next SSE push
      if(LAST&&LAST.graph)LAST.graph.map=m;
      const n=document.getElementById("gmapn"); if(n)n.textContent=m.nodes.length;
      GSIM=null; drawGraph(m);                        // fresh layout for the new node set
    }).catch(()=>{});
});

// The most recent thing the loop actually did. Without it a quiet moment reads as
// a hung process — this is the line that proves work is still flowing.
function lastBar(st){
  const e=(st.events||[])[0];
  if(!e)return"";
  const mins=Math.round((Date.now()-new Date(e.ts).getTime())/60000);
  const ago=mins<1?"just now":mins<60?mins+"m ago":Math.floor(mins/60)+"h ago";
  return '<div class="lastev"><span class="lel">last</span>'+
    '<span class="let">'+esc(e.msg)+'</span><span class="lea mono">'+ago+'</span></div>';
}
// START / PAUSE / RESUME / STOP. Which buttons exist is decided by what the
// machine is doing, not by what the operator last clicked: a queue that died on
// its own must still offer Start, and one that is running must not offer it
// twice. Pause and stop are never a kill — the task in flight finishes.
function runControls(pid,sup){
  const s=(sup&&sup.state)||"STOPPED";
  const b=(a,l,t,c)=>'<form class="inl" method="POST" action="/run">'+csrf+
    '<input type="hidden" name="project" value="'+esc(pid)+'">'+
    '<input type="hidden" name="action" value="'+a+'">'+
    '<button class="rc '+(c||'')+'" title="'+t+'">'+l+'</button></form>';
  const parts=[];
  if(s==="RUNNING"){
    parts.push(b("pause","Pause","Finish the task in flight, then stop starting new ones","warn"));
    parts.push(b("stop","Stop","Finish the task in flight, then stop. Nothing is killed","danger"));
  }else if(s==="PAUSED"){
    parts.push(b("resume","Resume","Start the queue again from where it stopped","go"));
    parts.push(b("stop","Stop","Leave it stopped","danger"));
  }else{
    parts.push(b("start","Start","Run the queue until it is empty or something needs you","go"));
  }
  return '<span class="rcw"><span class="rcs '+s.toLowerCase()+'">'+s+'</span>'+parts.join("")+'</span>';
}

// PER-TASK DETAIL. A fresh agent runs each task, so this is opened per task and
// fetched on demand: diffs and transcripts are far too large to push to a phone
// on every update.
// esc() escapes & < > — correct for text nodes, NOT for attribute values, which
// can still be closed with a quote. Anything that lands in an attribute goes
// through this one instead. The diff and the worker transcript are arbitrary
// repository and model content, so this is not a theoretical distinction.
const escA=(s)=>esc(s).replace(/"/g,"&quot;").replace(/'/g,"&#39;");

// Delegation rather than inline onclick: no interpolated string ever becomes
// executable markup, whatever a task title or project id happens to contain.
document.addEventListener("click",(e)=>{
  const b=e.target.closest?.("[data-task-toggle]");
  if(!b) return;
  e.preventDefault();
  toggleTask(b.getAttribute("data-project"),Number(b.getAttribute("data-task-toggle")));
});

let TASKOPEN=null;
let TASKCACHE=null;
async function toggleTask(pid,id){
  const el=document.getElementById("taskdetail");
  if(!el) return;
  if(TASKOPEN===id){ TASKOPEN=null; TASKCACHE=null; el.innerHTML=""; return; }
  TASKOPEN=id; el.innerHTML='<div class="tdl">loading task #'+id+'…</div>';
  try{
    const r=await fetch("/api/task?project="+encodeURIComponent(pid)+"&task="+id);
    TASKCACHE=await r.json();
    if(TASKOPEN===id) el.innerHTML=taskDetailView(TASKCACHE);
  }catch(e){ el.innerHTML='<div class="tdl">could not load: '+esc(String(e))+'</div>'; }
}
// A live page redraws constantly; the panel the operator opened must not vanish
// underneath them because a heartbeat arrived.
function repaintTaskDetail(){
  const el=document.getElementById("taskdetail");
  if(el&&TASKOPEN!=null&&TASKCACHE) el.innerHTML=taskDetailView(TASKCACHE);
}
// A unified diff rendered as a diff, not as a wall of text. Line numbers on both
// sides, additions and removals coloured on the LINE rather than by a leading
// character the eye has to hunt for, hunk headers as separators, and the file
// header promoted out of the body so a multi-file change is navigable.
//
// Everything is escaped before it becomes markup: a diff is arbitrary repository
// content and is the least trustworthy string on this page.
function diffView(raw){
  if(!raw) return '<div class="tdl">no diff</div>';
  const out=[]; let ol=0,nl=0,file=null;
  for(const line of String(raw).split("\\n")){
    if(line.startsWith("diff --git")){ file=null; continue; }
    if(line.startsWith("index ")||line.startsWith("new file")||line.startsWith("deleted file")||
       line.startsWith("similarity ")||line.startsWith("rename ")) continue;
    if(line.startsWith("--- ")) { continue; }
    if(line.startsWith("+++ ")){
      file=line.slice(4).replace(/^b\\//,"");
      out.push('<div class="dfh">'+esc(file)+'</div>'); continue;
    }
    const hunk=/^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@(.*)$/.exec(line);
    if(hunk){
      ol=+hunk[1]; nl=+hunk[2];
      out.push('<div class="dfhunk"><span class="dfn"></span><span class="dfn"></span><span>'+esc(hunk[3].trim())+'</span></div>');
      continue;
    }
    if(line.charAt(0)==="\\\\") continue;
    const k=line[0];
    const body=esc(line.slice(1));
    if(k==="+"){ out.push('<div class="dl add"><span class="dfn"></span><span class="dfn">'+(nl++)+'</span><span class="dc">'+body+'</span></div>'); }
    else if(k==="-"){ out.push('<div class="dl del"><span class="dfn">'+(ol++)+'</span><span class="dfn"></span><span class="dc">'+body+'</span></div>'); }
    else if(k===" "||k===undefined||line===""){ out.push('<div class="dl ctx"><span class="dfn">'+(ol++)+'</span><span class="dfn">'+(nl++)+'</span><span class="dc">'+body+'</span></div>'); }
    else { out.push('<div class="dl ctx"><span class="dfn"></span><span class="dfn"></span><span class="dc">'+esc(line)+'</span></div>'); }
  }
  return '<div class="dfw">'+out.join("")+'</div>';
}

const nfmt=(n)=>typeof n==="number"?n.toLocaleString():"—";
function usageRow(u){
  if(!u) return '<span class="tk none">no usage recorded</span>';
  if(u.status!=="REPORTED"||u.input===null||u.input===undefined)
    return '<span class="tk none">tokens not measured — this run predates usage capture</span>';
  return '<span class="tk">in <b>'+nfmt(u.input)+'</b></span>'+
         '<span class="tk">out <b>'+nfmt(u.output)+'</b></span>'+
         '<span class="tk">total <b>'+nfmt(u.total)+'</b></span>'+
         (u.cache_read?'<span class="tk">cached <b>'+nfmt(u.cache_read)+'</b></span>':'')+
         (u.cost_usd!=null?'<span class="tk cost">$'+u.cost_usd.toFixed(4)+'</span>':'')+
         (u.model?'<span class="tk mdl">'+esc(u.model)+'</span>':'');
}
function taskDetailView(d){
  if(!d||d.error) return '<div class="tdl">nothing recorded for this task yet</div>';
  const t=d.totals||{};
  const list=(xs)=>xs&&xs.length?'<ul class="tdul">'+xs.map(x=>'<li>'+esc(typeof x==="string"?x:JSON.stringify(x))+'</li>').join("")+'</ul>':"";
  const att=(a)=>'<details class="tda"><summary>attempt '+(a.attempt??"?")+' · '+esc(a.role||"worker")+
      ' · <span class="'+(["ACCEPTED","COMPLETED","VERIFIED","DELIVERED"].includes(a.outcome)?"ok":
          a.outcome==="NEEDS_DECISION"?"warn":"bad")+'">'+esc(a.outcome||"?")+'</span>'+
      (a.duration_ms?' · '+Math.round(a.duration_ms/1000)+'s':'')+'</summary>'+
    '<div class="tdu">'+usageRow(a.usage)+'</div>'+
    (a.summary?'<div class="tdsum">'+esc(a.summary)+'</div>':'')+
    (a.decisions&&a.decisions.length?'<div class="tdk">decisions it made on its own</div>'+list(a.decisions):'')+
    (a.issues&&a.issues.length?'<div class="tdk">issues it flagged</div>'+list(a.issues):'')+
    (a.commands&&a.commands.length?'<div class="tdk">commands it ran</div>'+list(a.commands):'')+
    (a.tests&&a.tests.length?'<div class="tdk">tests</div>'+list(a.tests):'')+
    '<details class="wk"><summary>Full output — everything it printed</summary><pre>'+esc(a.output||"(empty)")+'</pre></details>'+
    (a.stderr?'<details class="wk err"><summary>Errors</summary><pre>'+esc(a.stderr)+'</pre></details>':'')+
    '<details class="wk"><summary>The task it was given</summary><pre>'+esc(a.task_prompt||"")+'</pre></details>'+
    '</details>';
  return '<div class="td">'+
    '<div class="tdh"><b>TASK #'+d.task_id+'</b><span>'+esc(d.title||"")+'</span></div>'+
    ((t.input||t.output)?'<div class="tdu tot">'+
      '<span class="tk">in <b>'+nfmt(t.input)+'</b></span><span class="tk">out <b>'+nfmt(t.output)+'</b></span>'+
      '<span class="tk">total <b>'+nfmt((t.input||0)+(t.output||0))+'</b></span>'+
      (t.cache_read?'<span class="tk">cached <b>'+nfmt(t.cache_read)+'</b></span>':'')+
      (t.cost?'<span class="tk cost">$'+t.cost.toFixed(4)+'</span>':'')+
      '<span class="tk none">'+d.attempts.length+' attempt(s)</span></div>'
      :'<div class="tdu tot"><span class="tk none">tokens not measured · '+d.attempts.length+' attempt(s)</span></div>')+
    (d.ac&&d.ac.length?'<div class="tdk">acceptance criteria</div>'+list(d.ac):'')+
    '<details class="wk dfd" open><summary>Diff'+(d.diff_stat?' <span class="dfs">'+esc(d.diff_stat.split("\\n").pop().trim())+'</span>':'')+'</summary>'+
      diffView(d.diff)+'</details>'+
    d.attempts.map(att).join("")+
    '</div>';
}

// The transcript. "What is it doing" is answered by what the worker printed and
// what it was asked — not by a spinner.

// The handoff is a contract with named fields — reading it as raw JSON to find
// out what the worker decided is work the page should have done.
function handoffView(h){
  if(!h||typeof h!=="object") return "";
  const li=(xs,f)=>(xs&&xs.length)?'<ul class="hul">'+xs.map(x=>'<li>'+(f?f(x):esc(String(x)))+'</li>').join("")+'</ul>':"";
  const sec=(t,body)=>body?'<div class="hk">'+t+'</div>'+body:"";
  const st=String(h.worker_status||"");
  const cls=st==="COMPLETED"?"ok":st==="BLOCKED"?"warn":"bad";
  return '<details class="wk hnd"><summary>What it reported'+
      ' · <span class="'+cls+'">'+esc(st)+'</span></summary><div class="hbody">'+
    (h.summary?'<div class="hsum">'+esc(h.summary)+'</div>':"")+
    sec("files changed",li(h.files_reported_changed,x=>'<code>'+esc(String(x))+'</code>'))+
    sec("commands it ran",li(h.commands_reported,c=>
      '<code>'+esc(String(c&&c.command!=null?c.command:c))+'</code>'+
      (c&&c.exit_code!=null?'<span class="hx '+(c.exit_code===0?"ok":"bad")+'">exit '+esc(String(c.exit_code))+'</span>':"")))+
    sec("tests",li(h.tests_reported,x=>
      esc(String(x&&x.name!=null?x.name:x))+
      (x&&x.result!=null?'<span class="hx '+(String(x.result).toUpperCase()==="PASSED"?"ok":"bad")+'">'+esc(String(x.result))+'</span>':"")))+
    sec("decisions it made on its own",li(h.decisions))+
    sec("issues it flagged",li(h.issues))+
    sec("lessons",li(h.candidate_lessons))+
    (h.recommended_next_action?sec("recommended next",'<div class="hnx">'+esc(h.recommended_next_action)+'</div>'):"")+
    '</div></details>';
}
function workerPanel(w){
  if(!w) return "";
  const when=w.updated_at?new Date(w.updated_at).toLocaleTimeString():"";
  const box=(t,v,cls,open,doc)=>v?'<details class="wk'+(cls?" "+cls:"")+'"'+(open?" open":"")+'><summary>'+t+'</summary><pre'+(doc?' class="docpre"':'')+'>'+esc(v)+'</pre></details>':"";
  return '<section class="wkw"><div class="wkh">'+
      '<b>LAST WORKER</b><span class="wkm">'+esc(w.run_id||"")+(w.task_id?' · task #'+esc(String(w.task_id)):"")+
      (when?' · '+when:"")+'</span></div>'+
    (w.usage?(()=>{const inn=(w.usage.input||0)+(w.usage.cache_read||0)+(w.usage.cache_write||0);
      return '<div class="tdu">'+usageRow({status:"REPORTED",input:inn,output:w.usage.output,
        total:inn+(w.usage.output||0),cache_read:w.usage.cache_read,
        cost_usd:w.usage.cost_usd,model:w.usage.model})+
        (w.usage.turns?'<span class="tk">turns <b>'+w.usage.turns+'</b></span>':'')+'</div>';})():'')+
    box("What Claude said",w.said)+
    box("Errors",w.stderr,"err")+
    handoffView(w.handoff)+
    box("The task it was given",w.task_prompt,"",false,true)+
    '</section>';
}


// THE GLANCE. One block that answers, without scrolling and without reading:
// is it running, what is it doing right now, how far along, does it need me,
// what has it cost. Previously those five answers were spread across a loop
// bar, a "now" strip, a last-event line, a worker panel and a seven-chip row —
// each individually reasonable, together a page you had to study.
//
// Everything here is derived from state that already exists; nothing new is
// recorded to render it.

// What this project has cost, under its own name. Tokens and money are the
// operator's real constraint, so they sit with the title rather than three
// screens down.
const money=(n)=>n==null?"—":(n<1?"$"+n.toFixed(3):"$"+n.toFixed(2));
function spendStrip(sp){
  if(!sp||!sp.measured_runs) return '<div class="spd"><span class="none">no measured spend yet</span></div>';
  const hit=sp.cache_hit!=null?Math.round(sp.cache_hit*1000)/10:null;
  const m=sp.by_model&&sp.by_model.length?sp.by_model.map(x=>x.model).join(" + "):null;
  const dur=(ms)=>{const mn=Math.round(ms/60000); return mn<60?mn+"m":Math.floor(mn/60)+"h"+String(mn%60).padStart(2,"0")+"m";};
  const k=(n)=>n>=1000?(n/1000).toFixed(1)+"k":String(Math.round(n));
  // one line, the same facts a status line gives: what it cost, how fast it
  // burned, how long it ran, how much it read and wrote, and how well the
  // cache held. Context is the LAST worker against its model's own window.
  const ctx=(sp.context_last&&sp.context_window)
    ?Math.round(sp.context_last/sp.context_window*1000)/10 : null;
  return '<div class="spd">'+
    '<span class="cost"><b>'+money(sp.cost)+'</b>spent</span>'+
    (sp.cost_per_hour!=null?'<span class="cost"><b>'+money(sp.cost_per_hour)+'</b>/hour</span>':'')+
    (sp.hours?'<span><b>'+dur(sp.hours*3600000)+'</b>elapsed</span>':'')+
    (sp.api_ms?'<span><b>'+dur(sp.api_ms)+'</b>api</span>':'')+
    '<span><b>'+k(sp.tokens_total)+'</b>tok</span>'+
    (sp.tokens_per_min!=null?'<span><b>'+k(sp.tokens_per_min)+'</b>tpm</span>':'')+
    (hit!=null?'<span><b>'+hit+'%</b>cache</span>':'')+
    ((sp.lines_added||sp.lines_removed)?'<span class="dl2"><b class="pl">+'+nfmt(sp.lines_added)+'</b><b class="mi">-'+nfmt(sp.lines_removed)+'</b></span>':'')+
    (ctx!=null?'<span><b>'+ctx+'%</b>ctx '+k(sp.context_last)+'/'+k(sp.context_window)+'</span>':'')+
    (m?'<span class="mdl">'+esc(m)+'</span>':'')+
    (sp.unmeasured_runs?'<span class="none">'+sp.unmeasured_runs+' unmeasured</span>':'')+
    '</div>';
}
function heroBar(s,sup,w,pid){
  const ts=s.tasks||[];
  const live=ts.filter(x=>x.status==="building"||x.status==="review"||x.status==="changes");
  const blocked=ts.filter(x=>x.status==="blocked"||x.status==="stuck");
  const done=ts.filter(isDone).length;
  const total=ts.filter(x=>x.status!=="superseded").length;
  const pct=total?Math.round(done/total*100):0;
  const st=(sup&&sup.state)||"STOPPED";

  // The headline is the ANSWER, not the machine's word for its own state.
  let mood="idle", head="IDLE", sub="nothing running";
  if(blocked.length){ mood="need"; head="NEEDS YOU";
    sub=blocked.length+" task"+(blocked.length>1?"s":"")+" waiting on a decision"; }
  else if(st==="RUNNING"&&live.length){ mood="run"; head="BUILDING";
    sub="#"+live[0].id+" "+(live[0].title||""); }
  else if(st==="RUNNING"){ mood="run"; head="RUNNING"; sub="looking for the next task"; }
  else if(st==="PAUSED"){ mood="hold"; head="PAUSED"; sub="the task in flight finishes, then it stops"; }
  else if(done===total&&total){ mood="done"; head="ALL DONE";
    sub=total+" of "+total+" delivered"; }
  else { mood="idle"; head="STOPPED"; sub=(total-done)+" task"+((total-done)===1?"":"s")+" left"; }

  const cost=(w&&w.usage&&w.usage.cost_usd!=null)?"$"+w.usage.cost_usd.toFixed(2):null;
  return '<div class="hero '+mood+'">'+
    '<div class="hrow">'+
      '<div class="hmain"><div class="hhead">'+esc(head)+'</div>'+
        '<div class="hsub">'+esc(sub)+'</div></div>'+
      runControls(pid,sup)+
    '</div>'+
    '<div class="hbar"><span style="width:'+pct+'%"></span></div>'+
    '<div class="hfacts">'+
      '<span><b>'+done+'/'+total+'</b> delivered</span>'+
      '<span><b>'+pct+'%</b></span>'+
      (live.length?'<span><b>'+live.length+'</b> running</span>':'')+
      (blocked.length?'<span class="bad"><b>'+blocked.length+'</b> blocked</span>':'')+
      (cost?'<span><b>'+cost+'</b> last task</span>':'')+
    '</div></div>';
}
function loopBar(run,advice,st,pid,sup){
  // The scheduler is the loop now. Its supervisor state is authoritative; the
  // legacy per-pass heartbeat only describes the old in-session path, and
  // reading it alone made a working queue report "LOOP NEVER RAN".
  const h=(sup&&sup.state==="RUNNING")
    ?{cls:"ok",label:"LOOP RUNNING",detail:"queue running"+(sup.pid?" · pid "+sup.pid:""),dead:false}
    :(sup&&sup.state==="PAUSED")
    ?{cls:"late",label:"LOOP PAUSED",detail:"the task in flight finishes; nothing new starts",dead:false}
    :(sup&&sup.state==="EXITED")
    ?{cls:"late",label:"LOOP STOPPED",detail:"the queue exited — press start to continue",dead:false}
    :(sup&&sup.started_at)
    ?{cls:"dead",label:"LOOP STOPPED",detail:"not running",dead:false}
    :loopHealth(run);
  const m=advice?advice.minutes:30;
  // --project is auto-detected from the folder the terminal is in; showing it
  // makes the command longer than it needs to be.
  let s='<div class="loop '+h.cls+'"><span class="lb"></span><b>'+h.label+'</b>'+
    '<span class="lx">'+esc(h.detail)+'</span>'+runControls(pid,sup)+
    '</div>'+(st&&!h.dead?nowBar(run,st)+lastBar(st):'');
  // The right interval is not a fixed preference — it depends on what the queue
  // looks like right now, so say what it should be and why.
  if(advice && !(sup && sup.started_at)){
    const cur=run&&run.intervalMin?run.intervalMin:0;
    const off=cur&&Math.abs(cur-m)>=10;
    s+='<div class="advice'+(off?' off':'')+'"><b>suggested interval '+m+'m</b>'+
      '<span>'+esc(advice.why)+'</span>'+
      (off?'<span class="now">running at '+cur+'m — restart with <code>/loop '+m+'m /sch-run</code></span>':'')+
      '</div>';
  }
  return s;
}

// ---- tap-to-answer ---------------------------------------------------------
// THE QUESTION IS WHEREVER THE LOOP WROTE IT. It writes the full plain-language
// question — options, consequences, recommendation — into the brief field, and
// leaves a one-line summary in notes. The dashboard only ever rendered notes, so
// the operator read "full question in the task notes" — a pointer to the very
// text they were looking at — and could not answer questions that were, in fact,
// written properly. Show the real thing, and fall back only when there is none.
const questionOf=(t)=>{
  const brief=(t.brief||"").trim(), notes=(t.notes||"").trim();
  if(!brief) return notes||"(no question was written — the loop must rewrite this one)";
  // the note adds nothing when it just points at the brief
  return /see (the )?(task )?notes|full question|in the task notes/i.test(notes)||notes.length<brief.length/3
    ? brief : brief+"\\n\\n"+notes;
};
// A DECISION task carries its options as words. Pull them out so the answer is
// one tap instead of typing the exact token on a phone keyboard.
// Pull the REAL options out of a question. Order matters: a numbered list is an
// explicit answer set, so it wins. The loose slash heuristic runs only when there
// is no numbered list — left to itself it happily turned the prose phrase
// "request/response" into buttons, and a button that sends a meaningless answer
// is worse than no button at all.
function parseOpts(notes){
  const t=(notes||"");
  // 1) numbered options: "1) Keep signing only - ..."  → self-describing value
  const num=[...t.matchAll(/(?:^|\\n|[.;:!?]\\s)\\s*(\\d)\\)\\s+([^\\n]{3,80}?)(?=\\s+[-–—]\\s|[.;]|\\n|\$)/g)];
  if(num.length>=2){
    const seen=new Set();
    return num.filter(m=>!seen.has(m[1])&&seen.add(m[1]))
      .slice(0,5).map(m=>{
        const words=m[2].trim().split(/\\s+/).slice(0,5).join(" ").replace(/[,;:]\$/,"");
        return {label:m[1]+") "+words, value:m[1]+") "+words};
      });
  }
  // 1b) lettered options — "(a) provide such an account, and we test it properly;"
  // The loop writes these at least as often as numbers, and without this the
  // operator had to type the answer by hand on a phone.
  // the cap is generous on purpose: a written option often runs a long clause
  // before its first full stop, and a missing button is worse than a long label
  // (only the first few words are shown anyway)
  // the terminator is a LOOKAHEAD: consuming the "; " that ends option (a) also
  // ate the separator option (b) needs as its lead-in, so only a and c matched
  const alpha=[...t.matchAll(/(?:^|\\n|[.;:!?]\\s|[-–—]\\s)\\s*\\(([a-e])\\)\\s+([^\\n]{3,200}?)(?=\\s+[-–—]\\s|[.;]|\\n|\$)/g)];
  if(alpha.length>=2){
    const seen=new Set();
    return alpha.filter(m=>!seen.has(m[1])&&seen.add(m[1]))
      .slice(0,5).map(m=>{
        const words=m[2].trim().split(/\\s+/).slice(0,6).join(" ").replace(/[,;:]\$/,"");
        return {label:"("+m[1]+") "+words, value:"("+m[1]+") "+words};
      });
  }
  // 2) an explicit one-line list: "OPTIONS: untrack / allow / manual"
  const out=[];
  const m=t.match(/options?[^:\\n]{0,24}:\\s*([^\\n]+)/i);
  if(m)for(const x of m[1].split(/[|\\/,]/))push(x);
  // 3) last resort: inline alternation somewhere in the prose
  if(!out.length)
    for(const g of t.matchAll(/\`?\\b([a-z][a-z0-9-]{1,24})\`?(?:\\s*\\/\\s*\`?([a-z][a-z0-9-]{1,24})\`?){1,4}/g))
      for(const x of g[0].split("/"))push(x);
  function push(x){
    const v=x.replace(/[\`'"]/g,"").trim();
    if(v&&v.length<=24&&!out.includes(v)&&!/^(and|or|the|a|an|of|to)\$/.test(v))out.push(v);
  }
  return out.slice(0,5).map(v=>({label:v,value:v}));
}
// Lay a question out so it can be READ. The loop writes structure, but it also
// runs options together mid-paragraph; on a phone that is an unreadable slab. Put
// every label and every numbered option on its own line. Escape FIRST, then add
// markup — the text is operator/agent-supplied.
function fmtQ(s){
  let t=esc(s||"");
  // 1) 2) 3) each on its own line — but ONLY a real option marker. Matching any
  // digit before ")" turned "(BM/15017, AK/49, BM/910)" into a fake option and
  // ate the closing bracket, so the question read as nonsense. An option marker
  // starts a line or follows sentence-ending punctuation, and is a lone digit.
  t=t.replace(/(^|\\n|[.;:!?]\\s)\\s*(\\d\\))\\s+/g,"$1\\n\\n<span class=\\"qopt\\">$2</span> ");
  // (a) (b) (c) are just as common in a written question as 1) 2) 3)
  t=t.replace(/(^|\\n|[.;:!?]\\s|[-–—]\\s)\\s*(\\([a-e]\\))\\s+/g,"$1\\n\\n<span class=\\"qopt\\">$2</span> ");
  t=t.replace(/(^|\\n|\\s)(THE QUESTION|OPTIONS[^:\\n]{0,24}|WHAT EACH ONE DOES|RECOMMENDATION|RECOMMENDED|QUESTION ASKED|ANSWERED)\\s*:/g,
              "\\n\\n<span class=\\"qlabel\\">$2:</span>\\n");
  t=t.replace(/\\s*(Example:)/g,"\\n    $1");                                       // examples sit under their option
  return t.replace(/\\n{3,}/g,"\\n\\n").trim();
}
// a task planned out of an inbox submission carries its id (source "inbox#6"),
// so you can see what your message became — and filter the table by it
function srcChip(t){
  const m=/^inbox#(\\d+)$/.exec(t.source||"");
  return m?' <span class="srcchip" title="Planned from your inbox submission #'+m[1]+' — type inbox#'+m[1]+' in the filter to see all of them">inbox #'+m[1]+'</span>':'';
}
// one answer block, used by BOTH the project page and the home page. From home,
// stay on home after answering so several projects can be cleared in a row.
function answerBlock(pid,t,home){
  const opts=parseOpts(questionOf(t));
  return '<form class="ans ansform" method="POST" action="/answer">'+csrf+
    (home?'<input type="hidden" name="back" value="home">':'')+
    '<input type="hidden" name="project" value="'+esc(pid)+'"><input type="hidden" name="id" value="'+t.id+'">'+
    (opts.length?'<div class="opts">'+opts.map(o=>'<button type="submit" class="opt" name="text" value="'+esc(o.value)+'" title="Answer: '+esc(o.value)+'">'+esc(o.label)+'</button>').join("")+'</div>':'')+
    '<input type="text" name="text" placeholder="'+(opts.length?'…or type a different answer':'Answer — task resumes at top')+'" autocomplete="off">'+
    '<button title="Submit this answer and put the task back at the front of the queue">Answer &amp; unblock</button></form>';
}

// --- section patcher: write only sections whose HTML changed, and never a
// --- section the user is currently focused in (protects inputs/typing).
const CACHE={};
function set(id,html){
  const el=document.getElementById(id); if(!el)return;
  if(CACHE[id]===html)return;
  // Protect what the user is typing — but only for free-text inputs, and by
  // restoring value+caret after the patch rather than skipping the render.
  // (Skipping the whole section is what previously broke the status filter:
  // focus sat inside the section, so the re-render never happened.)
  const a=document.activeElement;
  const typing = a && el.contains(a) && a.tagName==="INPUT" && a.type!=="hidden";
  const keep = typing ? {id:a.id, v:a.value, s:a.selectionStart, e:a.selectionEnd} : null;
  CACHE[id]=html; el.innerHTML=html;
  if(keep && keep.id){
    const n=document.getElementById(keep.id);
    if(n){ n.value=keep.v; n.focus(); try{ n.setSelectionRange(keep.s,keep.e); }catch{} }
  }
  el.classList.remove("upd"); void el.offsetWidth; el.classList.add("upd");
}

// ---------- HOME ----------
let projQ="";
function homeSkeleton(){
  document.getElementById("app").innerHTML=\`
    <div class="bar"><span><span class="dot"></span><span id="livemark" class="live">live</span></span><span class="mono" id="clk"></span><span id="ucount"></span></div>
    <h1>SCH·LOOP</h1><div class="sub">operations // all projects</div>
    <section id="xattn"></section>
    <section id="pchips"></section>
    <div class="toolbar"><input id="pq" placeholder="search projects…" title="Search by project name, id or domain" value="" oninput="projQ=this.value;reapplyHome()"></div>
    <section id="mobsec"></section>
    <section id="devsec"></section>
    <section id="secsec"></section>\`;
  CACHE.xattn=CACHE.pchips=CACHE.mobsec=CACHE.devsec=CACHE.secsec=undefined;
}
function reapplyHome(){ if(LAST&&LAST.projects)homeApply(LAST.projects); }
function projRows(list){
  const RANK={attention:0,active:1,inprogress:2,new:3,idle:4,completed:5};
  return list.slice().sort((a,b)=>(RANK[a.status]??9)-(RANK[b.status]??9)||a.name.localeCompare(b.name)).map((p,i)=>{
    const[lab,cl]=PSTAT[p.status]||[p.status,""];
    return \`<tr class="\${cl}" onclick="location.href='/?project=\${encodeURIComponent(p.id)}'" title="Open \${esc(p.name)}">
    <td data-l="#" class="id">\${i+1}</td>
    <td data-l="Project"><strong>\${esc(p.name)}</strong> <span class="id">\${esc(p.domain)}</span>\${p.offensive&&p.halt?' <span class="badge b-halt">halt</span>':''}\${p.offensive&&!p.authorized?' <span class="badge b-off">unauthorized</span>':''}</td>
    <td data-l="Status"><span class="st \${cl}">\${lab}</span></td>
    <td data-l="Loop">\${loopCell(p)}</td>
    <td data-l="Progress"><div class="bar2"><span style="width:\${p.pct}%"></span></div><span class="pctn">\${p.pct}%</span></td>
    <td data-l="Done">\${p.done}</td><td data-l="Total">\${p.total}</td><td data-l="Pending">\${p.pending}</td>\${p.offensive?'<td data-l="Findings">'+p.findings+'</td>':''}
    <td data-l="Inbox">\${p.inboxNew?'<span class="in">'+p.inboxNew+'</span>':'0'}</td></tr>\`;}).join("");
}
// ---- phone list ----------------------------------------------------------
// A phone is not a narrow desktop. The desktop table is nine columns wide and
// correct there; folding those nine cells into stacked label/value rows spent a
// whole screen per project, so at 50+ projects the operator scrolled past
// everything that mattered. This is a purpose-built list: two lines per project,
// every project ranked by how much it needs a human, dev and pentest in ONE
// sequence so a blocked engagement can never sit below sixty idle builds.
// Rendered always, shown only under 640px; the tables are hidden there.
// "running" must mean work is actually moving. Ranking by p.status alone put
// projects whose loop reads STOPPED under a RUNNING heading — a band that lies
// is worse than no band, because it is the one an operator trusts to skip.
const URGENCY=[
  {id:"needs", label:"needs you", of:(p)=>p.status==="attention"||p.blocked>0||p.stuck>0||
                                          p.inboxNew>0||(p.blockers||[]).length>0},
  {id:"run",   label:"running",   of:(p)=>p.building>0||p.review>0||loopHealth(p.run).cls==="ok"},
  {id:"idle",  label:"idle",      of:(p)=>p.status!=="completed"},
  {id:"done",  label:"completed", of:()=>true},
];
const bandOf=(p)=>URGENCY.findIndex((b)=>b.of(p));
function projList(list){
  if(!list.length) return '<div class="empty">no project matches</div>';
  const sorted=list.slice().sort((a,b)=>
    bandOf(a)-bandOf(b) ||
    (b.inboxNew+((b.blockers||[]).length))-(a.inboxNew+((a.blockers||[]).length)) ||
    b.pct-a.pct || a.name.localeCompare(b.name));
  let band=-1,out="";
  for(const p of sorted){
    const b=bandOf(p);
    if(b!==band){ band=b;
      out+='<div class="mb-h">'+URGENCY[b].label+'<span class="mb-n">'+sorted.filter(x=>bandOf(x)===b).length+'</span></div>'; }
    const[lab,cl]=PSTAT[p.status]||[p.status,""];
    const h=loopHealth(p.run);
    const loop=h.cls==="ok"?"running":h.cls==="late"?"late":"stopped";
    const flag=(p.offensive&&p.halt)?'<span class="mb-f b-halt">halt</span>'
      :(p.offensive&&!p.authorized)?'<span class="mb-f b-off">unauth</span>':'';
    const alerts=p.inboxNew+((p.blockers||[]).length);
    out+='<a class="mb-r '+cl+(p.pct?'':' p0')+'" href="/?project='+encodeURIComponent(p.id)+'">'+
      '<span class="mb-nm">'+esc(p.name)+'</span>'+
      '<span class="mb-d">'+esc(p.domain)+'</span>'+flag+
      (alerts?'<span class="mb-a">'+alerts+'</span>':'')+
      '<span class="mb-2">'+
        '<span class="bar2"><span style="width:'+p.pct+'%"></span></span>'+
        '<span class="mb-p">'+p.pct+'%</span>'+
        (p.total?'<span class="mb-c">'+p.done+'/'+p.total+'</span>':'')+
        '<span class="st '+cl+'">'+lab+'</span>'+
        '<span class="mb-l l-'+loop+'">'+loop+'</span>'+
      '</span></a>';
  }
  return out;
}

// per-project loop health, compact: this is where you notice a cron that died
function loopCell(p){
  const h=loopHealth(p.run);
  const t=h.label+" — "+h.detail;
  return '<span class="st '+(h.cls==="ok"?"st-merged":h.cls==="late"?"st-building":"st-blocked")+'" title="'+esc(t)+'">'+
    (h.cls==="ok"?"RUNNING":h.cls==="late"?"LATE":"STOPPED")+'</span>';
}
function projTable(title,list,emptyMsg,offensive){
  // "Findings" is a pentest concept — it was rendering as a dead "—" column on
  // every development project.
  const cols=["#","Project","Status","Loop","Progress","Done","Total","Pending"].concat(offensive?["Findings"]:[]).concat(["Inbox"]);
  const rows=projRows(list)||'<tr><td colspan="'+cols.length+'" class="empty">'+emptyMsg+'</td></tr>';
  return '<h2>'+title+'<span class="n mono">'+list.length+'</span></h2>'+
    '<div class="tbl-wrap"><table class="t projects"><thead><tr>'+cols.map(c=>'<th>'+c+'</th>').join("")+'</tr></thead><tbody>'+rows+'</tbody></table></div>';
}
function homeApply(ps){
  document.getElementById("clk").textContent=clock();
  document.getElementById("ucount").textContent="units // "+ps.length;
  // EVERY blocked question, from EVERY project, answerable right here. Opening
  // each project to discover which one is waiting is the main thing that stalls
  // a phone-only operator.
  const xs=ps.flatMap(p=>(p.blockers||[]).map(t=>({p,t})));
  set("xattn",xs.length?'<div class="attn"><b>&#9888; NEEDS YOU — '+xs.length+' across '+
    new Set(xs.map(x=>x.p.id)).size+' project(s)</b>'+
    xs.map(({p,t})=>'<div class="attn-row"><div class="xp"><a href="/?project='+encodeURIComponent(p.id)+'">'+esc(p.name)+'</a> · task #'+t.id+'</div>'+
      '<div><span class="st st-'+t.status+'">'+(t.status==="blocked"?"AWAITING":"FAILED")+'</span> <strong>'+esc(t.title)+'</strong></div>'+
      '<div class="q">'+fmtQ(questionOf(t))+'</div>'+answerBlock(p.id,t,true)+'</div>').join("")+
    '</div>':"");
  const by=(c)=>ps.filter(p=>p.status===c).length;
  set("pchips",'<div class="chips">'+[["active",by("active"),"active"],["in progress",by("inprogress"),"inprogress"],["failed / awaiting",by("attention"),"attention"],["completed",by("completed"),"completed"],["new",by("new"),"new"]].map(([n,v,c])=>\`<div class="chip \${c}"><b class="mono">\${v}</b>\${n}</div>\`).join("")+'</div>');
  // split by kind, then apply the search
  const q=projQ.trim().toLowerCase();
  const match=(p)=>!q||((p.name+" "+p.id+" "+p.domain).toLowerCase().includes(q));
  const dev=ps.filter(p=>!p.offensive&&match(p));
  const sec=ps.filter(p=>p.offensive&&match(p));
  // one sequence for the phone; the split tables below are desktop-only
  set("mobsec",'<div class="mb">'+projList(ps.filter(match))+'</div>');
  set("devsec",projTable("development",dev,q?"no development project matches":"no development projects — run /sch-spec",false));
  set("secsec",projTable("security // pentest",sec,q?"no engagement matches":"no engagements — run /sch-spec with a target",true));
}

// ---------- PROJECT ----------
function projSkeleton(id){
  document.getElementById("app").innerHTML=\`
    <div class="bar"><a class="back" href="/">‹ ALL PROJECTS</a><span><span class="dot"></span><span id="livemark" class="live">live</span></span><span class="mono" id="clk"></span></div>
    <h1 id="pname">…</h1><div class="sub" id="pmeta"></div>
    <section id="spend"></section>
    <section id="attn"></section>
    <section id="scope"></section>
    <section id="loop"></section>
    <section id="worker"></section>
    <section id="chips"></section>
    <section id="phase"></section>
    <form class="row-form" method="POST" action="/inbox">\${csrf}<input type="hidden" name="project" value="\${esc(id)}"><input type="text" name="text" title="Describe a feature, fix or lead — the next loop pass reasons it into the right place in the queue" placeholder="NEW LEAD / TASK / FEATURE — reasoned into the queue next pass" autocomplete="off" required><button title="Send to the inbox — the next loop pass plans it into the queue">Add</button></form>
    <section id="inboxsec"></section>
    <section id="taskdetail"></section>
    <section id="tasksec"></section>
    <section id="findsec"></section>
    <details class="sysbox"><summary>system — graph, scheduler, capabilities, knowledge, activity</summary>
      <section id="brief"></section>
      <section id="queuesec"></section>
      <section id="graphsec"></section>
      <section id="modelsec"></section>
      <section id="capsec"></section>
      <section id="actsec"></section>
    </details>
    <details class="box"><summary>activity log</summary><div class="boxin"></div></details>\`;
  for(const k in CACHE)delete CACHE[k];
}
// every action button carries a tooltip + aria-label so an icon is never mystery meat
const ACT_TIP={bump:"Bump to the front of the queue (priority 1)",hold:"Put on hold — moves to awaiting, loop skips it",
  requeue:"Requeue — put it back in the queue to be retried",close:"Close as superseded — replaced by other tasks, stop showing it"};
function actForm(pid,id,a,l,c){const tip=ACT_TIP[a]||a;
  return \`<form class="inl" method="POST" action="/task">\${csrf}<input type="hidden" name="project" value="\${esc(pid)}"><input type="hidden" name="id" value="\${id}"><input type="hidden" name="action" value="\${a}"><button class="mini \${c||''}" title="\${tip}" aria-label="\${tip}">\${l}</button></form>\`;}

// Per-task spend, straight from the snapshot. "What did that task cost" is the
// question an operator asks about a QUEUE, so it belongs in the queue.
let SPEND=null;
function taskCost(id){
  const e=SPEND&&SPEND.per_task?SPEND.per_task[String(id)]:null;
  if(!e) return '<span class="none">—</span>';
  return '<span class="tcv">'+money(e.cost)+'</span><span class="tct">'+
    nfmt(e.input+e.output)+' tok</span>';
}

// WHICH MODEL DOES WHAT. Roles are the unit an operator reasons about — "what
// writes my code", "what reviews it" — so the control is per role, and the cost
// consequence is stated next to it rather than left to be discovered on a bill.
const MODEL_NOTE={haiku:"cheapest · search and docs",sonnet:"the coding model",
  opus:"most capable · planning and review",inherited:"whatever the session uses"};
function modelsView(d,pid){
  if(!d||d.error) return '<div class="tdl">model policy unavailable</div>';
  const row=(r)=>'<div class="mrow'+(r.source==="project"?" pinned":"")+'">'+
    '<div class="mr1"><b>'+esc(r.id)+'</b>'+
      (r.source==="project"?'<span class="mpin">pinned</span>':'')+'</div>'+
    '<div class="mr2">'+esc(r.purpose)+'</div>'+
    '<form class="mr3" method="POST" action="/models">'+csrf+
      '<input type="hidden" name="project" value="'+escA(pid)+'">'+
      '<input type="hidden" name="role" value="'+escA(r.id)+'">'+
      '<select name="model" onchange="this.form.submit()">'+
        d.choices.map(m=>'<option value="'+escA(m)+'"'+(m===r.model?' selected':'')+'>'+esc(m)+'</option>').join("")+
      '</select>'+
      '<span class="mnote">'+esc(MODEL_NOTE[r.model]||"")+'</span>'+
    '</form></div>';
  return '<div class="mbox"><div class="mhead">MODEL PER ROLE'+
    '<span>changing one takes effect on the next task</span></div>'+
    d.roles.map(row).join("")+'</div>';
}
async function loadModels(pid){
  try{ const r=await fetch("/api/models?project="+encodeURIComponent(pid));
       set("modelsec",modelsView(await r.json(),pid)); }
  catch(e){ /* leave the section empty rather than shout */ }
}
function projApply(id,r){
  if(r.error){location.href="/";return;}
  const p=r.project,s=r.state,sc=p.scope||{},by=(st)=>s.tasks.filter(t=>t.status===st);
  // The queue paints before spend has ever been read, and on an idle project
  // nothing changes afterwards — so the cost column stayed "—" forever even
  // though the numbers were there. Repaint once, the first time spend arrives.
  const hadSpend=!!SPEND; SPEND=r.spend||null;
  if(!hadSpend&&SPEND) setTimeout(()=>{try{reapplyTasks();}catch(e){}},0);
  document.getElementById("clk").textContent=clock();
  document.getElementById("pname").textContent=p.name;
  document.getElementById("pmeta").innerHTML=\`\${esc(p.domain)} · \${esc(p.path)||"no path"} \${OFF(p.domain)?(sc.authorized?'<span class="badge b-auth">authorized</span>':'<span class="badge b-off">unauthorized</span>'):''}\${sc.halt?' <span class="badge b-halt">halt</span>':''}\`;
  set("spend",spendStrip(r.spend));
  set("loop",heroBar(s,r.supervisor,r.worker,id));
  set("worker",workerPanel(r.worker));
  repaintTaskDetail();
  // brief + tech stack — what this project actually is, at a glance
  const stack=(p.stack||[]);
  set("brief",(p.description||stack.length)?'<div class="brief">'+
    (p.description?'<p class="bdesc">'+esc(p.description)+'</p>':'')+
    (stack.length?'<div class="stack"><span class="slabel">stack</span><span class="stext">'+esc(stack.join(", "))+'</span>'+
      '<button class="mini copy" title="Copy the description + stack as plain text" onclick="copyBrief(this)">copy</button></div>':'')+
    '</div>':'<div class="brief brief-empty">No project brief yet — add one: <code>state.mjs project-meta --project '+esc(id)+' --description "…" --stack "Django|React|Postgres"</code></div>');
  // attention
  const attn=s.tasks.filter(t=>t.status==="blocked"||t.status==="stuck");
  var attnHtml="";
  if(attn.length){
    attnHtml='<div class="attn"><b>&#9888; NEEDS YOU — '+attn.length+' task(s)</b>';
    for(const t of attn){
      attnHtml+='<div class="attn-row"><div><span class="st st-'+t.status+'">'+(t.status==="blocked"?"AWAITING":"FAILED")+'</span> <span class="id">TASK #'+t.id+'</span> <strong>'+esc(t.title)+'</strong></div><div class="q">'+fmtQ(questionOf(t))+'</div>'+
        answerBlock(id,t)+
        actForm(id,t.id,"close","&#10005; close (superseded)")+'</div>';
    }
    attnHtml+='</div>';
  }
  // Decisions the loop made on its own rather than stopping to ask. These are
  // FYI, not a queue of chores: the work is already moving. Tap to overrule.
  const assumed=s.tasks.filter(t=>t.assumed&&!isDone(t)&&t.status!=="superseded");
  if(assumed.length){
    attnHtml+='<details class="assumed"><summary>'+assumed.length+' decision'+(assumed.length>1?'s':'')+
      ' the loop made on its own — work is proceeding, tap to change</summary>';
    for(const t of assumed){
      attnHtml+='<div class="attn-row"><div><span class="id">TASK #'+t.id+'</span> <strong>'+esc(t.title)+'</strong></div>'+
        '<div class="acall">proceeding: '+esc(t.assumed.choice)+'</div>'+
        '<div class="q">'+fmtQ(t.assumed.question||"")+'</div>'+answerBlock(id,t)+'</div>';
    }
    attnHtml+='</details>';
  }
  set("attn",attnHtml);
  // scope
  const SCOPE_TIP={halt:"HALT — immediately stop all active work on this engagement",
    resume:"Resume — lift the halt and let active work continue",
    arm:"Arm — authorize active testing against the in-scope targets",
    disarm:"Disarm — revoke authorization; active tasks will be refused"};
  const scForm=(a,l,c)=>\`<form class="inl" method="POST" action="/scope">\${csrf}<input type="hidden" name="project" value="\${esc(id)}"><input type="hidden" name="action" value="\${a}"><button class="mini \${c||''}" title="\${SCOPE_TIP[a]||a}" aria-label="\${SCOPE_TIP[a]||a}">\${l}</button></form>\`;
  set("scope",OFF(p.domain)?\`<div class="scope"><b>SCOPE //</b> \${sc.authorized?'authorized':'NOT authorized'}\${sc.halt?' · <span style="color:var(--red)">HALT</span>':''}<br>TARGETS: \${esc((sc.targets||[]).join(", "))||"(none)"}<br>REF: \${esc(sc.ref)||"(none)"}\${sc.expiry?' · EXPIRES '+esc(sc.expiry):''}<div class="acts">\${sc.halt?scForm("resume","▶ resume","go"):scForm("halt","■ halt","danger")} \${sc.authorized?scForm("disarm","disarm"):scForm("arm","arm","go")}</div></div>\`:"");
  // chips
  const done=s.tasks.filter(isDone).length,total=s.tasks.filter(t=>t.status!=="superseded").length,pct=total?Math.round(done/total*100):0;
  const finds=s.findings||[];
  set("chips","");void ('<div class="chips">'+[["active",by("building").length,"active"],["in progress",by("review").length+by("changes").length,"inprogress"],["queued",by("queued").length,""],["completed",done,"completed"],["awaiting",by("blocked").length,"awaiting"],["failed",by("stuck").length,"failed"],["findings",finds.length,""]].map(([n,v,c])=>\`<div class="chip \${c}"><b class="mono">\${v}</b>\${n}</div>\`).join("")+'</div>');
  // phase strip
  const ph=s.tasks.slice().sort((a,b)=>a.phase-b.phase||a.id-b.id);
  // Phase progress grouped: category (frontend/backend/…) → named phase, each
  // with its own task counts and bar. Falls back to "P<n>" when the planner
  // hasn't set a category/phaseName yet.
  const groups={};
  for(const t of ph){
    const cat=(t.category||"general").toLowerCase();
    const key=t.phaseName||("Phase "+t.phase);
    (groups[cat]=groups[cat]||{})[key]=(groups[cat][key]||[]).concat(t);
  }
  // LIVE WORK TREE: category › phase › every task, all visible. The task the
  // loop is working on right now gets a pulsing green ring so you can see, at a
  // glance, exactly what is building.
  const RUNNING=new Set(["building","review","changes"]);
  let phHtml="";
  for(const cat of Object.keys(groups).sort()){
    const phases=groups[cat];
    const all=Object.values(phases).flat();
    const cd=all.filter(isDone).length;
    const nPh=Object.keys(phases).length;
    const catRunning=all.some(t=>RUNNING.has(t.status));
    const catPct=all.length?Math.round(cd/all.length*100):0;
    phHtml+='<div class="cat'+(catRunning?' running':'')+'"><div class="cat-h"><span class="cat-n">'+esc(cat)+'</span>'+
      '<span class="cat-c mono">'+nPh+' phase'+(nPh>1?'s':'')+' · '+cd+'/'+all.length+' done · '+catPct+'%</span></div>';
    for(const name of Object.keys(phases)){
      const list=phases[name], d=list.filter(isDone).length;
      const phRunning=list.some(t=>RUNNING.has(t.status));
      phHtml+='<div class="ph'+(phRunning?' running':'')+'">'+
        '<div class="ph-h"><span class="ph-n">'+esc(name)+'</span><span class="ph-c mono">'+d+'/'+list.length+'</span>'+
        '<div class="pbar"><i style="width:'+(list.length?Math.round(d/list.length*100):0)+'%"></i></div></div>';
      const sorted=list.sort((a,b)=>(a.priority??3)-(b.priority??3)||a.id-b.id);
      const open=sorted.filter(t=>!isDone(t)), doneList=sorted.filter(isDone);
      const line=(t)=>{const run=RUNNING.has(t.status);
        return '<div class="tk st-'+t.status+(run?' running':'')+'" data-task="'+t.id+'" title="'+esc(t.title)+(t.notes?' — '+esc(t.notes.slice(0,120)):'')+'">'+
          '<span class="tk-d"></span><span class="tk-id mono">#'+t.id+'</span>'+
          '<span class="tk-t">'+esc(t.title)+'</span>'+
          '<span class="tk-s">'+(STMAP[t.status]?STMAP[t.status][0]:t.status)+'</span></div>';};
      // pending work is always visible; completed work collapses out of the way
      phHtml+=open.map(line).join("");
      if(!open.length&&!doneList.length)phHtml+='<div class="tk-none">no tasks</div>';
      if(doneList.length)phHtml+='<details class="donebox"><summary>'+doneList.length+' completed</summary>'+doneList.map(line).join("")+'</details>';
      phHtml+='</div>';
    }
    phHtml+='</div>';
  }
  const nowRunning=ph.filter(t=>RUNNING.has(t.status));
  set("phase",'<h2>work tree — every task, live'+(nowRunning.length?'<span class="livenow">● building: '+esc(nowRunning[0].title)+'</span>':'')+
    '<span class="n mono">'+pct+'% done · '+done+'/'+total+' tasks</span></h2>'+
    (ph.length?'<div class="phase-strip">'+phHtml+'</div>':'<div class="empty">no phases planned yet — run /sch-plan</div>'));
  // knowledge graph — what the loop has learned, live.
  // Guarded: a bug in the graph panel used to abort projApply and leave every
  // section BELOW it (tasks, findings, inbox, activity) permanently blank.
  if(GMAP&&r.graph)r.graph.map=GMAP;   // keep a chosen density across pushes
  try{
    set("graphsec",graphSec(r.graph));
    if(r.graph&&r.graph.map&&r.graph.map.nodes.length)requestAnimationFrame(()=>drawGraph(r.graph.map));
  }catch(err){
    console.error("graph panel failed",err);
    set("graphsec",'<h2>knowledge graph</h2><div class="empty">graph panel failed: '+esc(err.message)+'</div>');
  }
  // tasks
  const stL=(x)=>STMAP[x]||[x.toUpperCase(),""];
  // A BLOCKED task is waiting on an ANSWER. Requeueing it without one just sends
  // it back to be asked again — so offer the answer box, not a requeue button.
  // "stuck" is different: it failed rather than asked, so retrying is valid.
  const rowActs=(t)=>t.status==="queued"?actForm(id,t.id,"bump","▲")+actForm(id,t.id,"hold","⏸")
    :t.status==="stuck"?actForm(id,t.id,"requeue","↻","go")
    :t.status==="blocked"?'<a class="mini go" href="#attn" title="This task is waiting on your answer — requeueing it without one only makes the loop ask again">answer ↑</a>'
    :"";
  let ts=s.tasks.slice().sort((a,b)=>(a.priority??3)-(b.priority??3)||a.phase-b.phase||a.id-b.id);
  // superseded = replaced by smaller/other tasks; hidden unless explicitly shown
  if(!taskFilter.showSuperseded && taskFilter.status!=="superseded")ts=ts.filter(t=>t.status!=="superseded");
  if(taskFilter.status)ts=ts.filter(t=>t.status===taskFilter.status);
  // searching "inbox#6" lists exactly what that submission became
  if(taskFilter.q){const q=taskFilter.q.toLowerCase();ts=ts.filter(t=>(t.title+" "+(t.notes||"")+" "+(t.source||"")+" P"+t.phase).toLowerCase().includes(q));}
  // On a phone each row becomes a card, so the full queue is ~20 screens of
  // scrolling. Show a screenful and let the operator ask for the rest.
  const CAP=(typeof innerWidth!=="undefined"&&innerWidth<=640)?12:400;
  const hidden=Math.max(0,ts.length-CAP);
  const shown=taskFilter.showAll?ts:ts.slice(0,CAP);
  const trows=shown.map(t=>{const[lab,cl]=stL(t.status);return \`<tr class="\${cl}"><td data-l="#" class="id">\${t.id}</td>
    <td data-l="Task"><span class="cellv"><a href="#" class="tdt" data-task-toggle="\${t.id}" data-project="\${escA(id)}" title="Show the diff, the worker's reasoning and its token cost">\${esc(t.title)}</a>\${t.active?' <span class="badge b-off">active</span>':''}\${srcChip(t)}\${(t.skills&&t.skills.length)?'<div class="skl">'+t.skills.map(x=>'<span>'+esc(x)+'</span>').join("")+'</div>':''}</span></td>
    <td data-l="Phase"><span class="cellv">\${t.category?'<span class="catchip">'+esc(t.category)+'</span> ':''}\${esc(t.phaseName||("P"+t.phase))}</span></td><td data-l="Pri">\${t.priority??3}</td>
    <td data-l="Status"><span class="st \${cl}">\${lab}</span></td>
    <td data-l="Cost" class="tcost">\${taskCost(t.id)}</td>
    <td data-l="Target">\${esc(t.target||"—")}</td>
    <td data-l="Activity">\${esc(t.notes||t.branch||"—")}</td>
    <td data-l="" class="ac">\${rowActs(t)}</td></tr>\`;}).join("")||'<tr><td colspan="9" class="empty">no tasks match</td></tr>';
  const statuses=["","queued","building","review","changes","blocked","stuck","merged","superseded"];
  const supN=s.tasks.filter(t=>t.status==="superseded").length;
  set("tasksec",'<h2>tasks<span class="n mono">'+shown.length+' of '+ts.length+' shown</span></h2>'+
    '<div class="toolbar"><input id="tq" placeholder="filter tasks…" title="Filter by task title, note or phase" value="'+esc(taskFilter.q)+'" oninput="taskFilter.q=this.value;reapplyTasks()">'+
    '<select id="ts" title="Show only tasks in this status" onchange="taskFilter.status=this.value;reapplyTasks()">'+statuses.map(x=>'<option value="'+x+'"'+(x===taskFilter.status?' selected':'')+'>'+(x?x:'all statuses')+'</option>').join("")+'</select>'+
    (supN?'<button class="mini" title="Superseded = tasks replaced by other/smaller tasks. Their work still exists elsewhere; hidden by default to keep the queue clean." onclick="taskFilter.showSuperseded=!taskFilter.showSuperseded;reapplyTasks()">'+(taskFilter.showSuperseded?'hide':'show')+' superseded ('+supN+')</button>':'')+'</div>'+
    '<div class="tbl-wrap"><table class="t"><thead><tr><th>#</th><th>Task</th><th>Phase</th><th>Pri</th><th>Status</th><th>Cost</th><th>Target</th><th>Activity</th><th></th></tr></thead><tbody>'+trows+'</tbody></table></div>'+((hidden&&!taskFilter.showAll)?'<button class="moretasks" onclick="taskFilter.showAll=true;reapplyTasks()">show all '+ts.length+' tasks (+'+hidden+' more)</button>':(taskFilter.showAll&&ts.length>CAP)?'<button class="moretasks" onclick="taskFilter.showAll=false;reapplyTasks()">show fewer</button>':''));
  // findings
  const srank=(x)=>["critical","high","medium","low","info"].indexOf((x||"info").toLowerCase());
  const fsev=(x)=>({critical:"f-critical",high:"f-high",medium:"f-medium",low:"f-low"}[(x||"info").toLowerCase()]||"f-info");
  const vf=finds.filter(f=>f.status==="validated").sort((a,b)=>srank(a.severity)-srank(b.severity)||a.id-b.id);
  const cn=finds.filter(f=>f.status==="tested-clean").length;
  // Observations and COVERAGE GAP records were logged and then shown nowhere —
  // nine of them on one engagement, four being cells that could not be tested.
  // An untested cell you cannot see reads exactly like a clean one.
  const ob=finds.filter(f=>!["validated","tested-clean","false-positive"].includes(f.status))
    .sort((a,b)=>srank(a.severity)-srank(b.severity)||a.id-b.id);
  // findings are a pentest concept — never shown on a dev/tool project
  const frow=(f)=>\`<div class="frow"><span class="fsev \${fsev(f.severity)}">\${esc(f.severity||"info")}</span><strong>\${esc(f.title)}</strong> <span class="id">\${esc(f.category||"")}</span>\${(f.parents&&f.parents.length)?' <span class="id">⛓ #'+f.parents.join(",#")+'</span>':''}\${f.target?' <span class="pctn">'+esc(f.target)+'</span>':''}\${(f.status==="validated"&&!f.evidence)?' <span class="fwarn" title="A validated finding with no PoC file cannot go in the report">no PoC</span>':''}</div>\`;
  set("findsec",!OFF(p.domain)?"":'<h2>findings<span class="n mono">'+vf.length+'V / '+cn+'C / '+ob.length+'O</span></h2>'+
    (vf.length?vf.map(frow).join(""):'<div class="empty">no validated findings yet</div>')+
    (ob.length?'<details class="obsbox"><summary>'+ob.length+' observation'+(ob.length>1?'s':'')+' &amp; coverage gaps — recorded, not yet a finding</summary>'+ob.map(frow).join("")+'</details>':''));
  // inbox + activity
  const nb=s.inbox.filter(i=>i.status==="new");
  // Every submission stays on the page — SUBMITTED until a pass plans it, then
  // ADDED with the tasks it became. A receipt that vanished the moment the loop
  // read it left no way to tell "not picked up yet" from "picked up and planned".
  const ibxTasks=(n)=>s.tasks.filter(t=>t.source==="inbox#"+n);
  // Inbox: what you submitted, waiting for the next loop pass to plan it.
  // Full text (so you can re-read what you sent) + delete if you change your mind.
  // Inbox: what you submitted, waiting for the next pass to plan it. Collapsed —
  // a submission is a receipt, not a working surface; the queue is what matters.
  // INBOX #n is the trace id: tasks planned from it are tagged with the same id.
  set("inboxsec",!s.inbox.length?"":'<h2>your submissions'+
    '<span class="n mono">'+nb.length+' submitted · '+(s.inbox.length-nb.length)+' added</span></h2>'+
    s.inbox.map(i=>{
      const pending=i.status==="new", made=ibxTasks(i.id);
      const openN=made.filter(t=>t.status!=="merged"&&t.status!=="superseded").length;
      return '<details class="ibx'+(pending?' pending':'')+'"><summary class="ibx-h">'+
      '<span class="ibx-st '+(pending?'is-sub':'is-add')+'">'+(pending?'submitted':'added')+'</span>'+
      '<span class="ibx-id">INBOX #'+i.id+'</span>'+
      '<span class="ibx-t mono">'+esc(i.createdAt.slice(0,16).replace("T"," "))+'</span>'+
      '<span class="ibx-pv">'+esc(i.text.replace(/\\s+/g," ").slice(0,70))+(i.text.length>70?'…':'')+'</span>'+
      (made.length?'<span class="ibx-n mono">'+made.length+' task'+(made.length>1?'s':'')+
        (openN?' · '+openN+' open':' · all done')+'</span>':'')+'</summary>'+
      '<div class="ibx-b">'+esc(i.text)+'</div>'+
      (made.length?'<div class="ibx-tk">'+made.map(t=>{const[lab,cl]=stL(t.status);
        return '<div class="ibx-tr"><span class="id mono">#'+t.id+'</span><span class="ibx-tt">'+esc(t.title)+
          '</span><span class="st '+cl+'">'+lab+'</span></div>';}).join("")+'</div>'
       :pending?'<div class="ibx-none">not planned yet — the next loop pass reasons it into the queue</div>'
       :'<div class="ibx-none">read by the loop; no separate task was needed</div>')+
      (pending?'<div class="ibx-f"><form class="inl confirm-del" method="POST" action="/inbox-del">'+csrf+
        '<input type="hidden" name="project" value="'+esc(id)+'"><input type="hidden" name="id" value="'+i.id+'">'+
        '<button class="mini danger" title="Delete this submission before the loop plans it">delete</button></form></div>':'')+
      '</details>';}).join(""));
  set("actsec",'<h2>activity<span class="n mono">'+s.events.length+'</span></h2>'+(s.events.slice(0,25).map(e=>\`<div class="ev"><b class="mono">\${e.ts.slice(5,16).replace("T"," ")}</b> — \${esc(e.msg)}</div>\`).join("")||'<div class="empty">no activity</div>'));
}
function reapplyTasks(){ if(LAST&&LAST.project)projApply(qp("project"),LAST); }
// delegated: confirm before deleting an unplanned inbox submission; and never
// submit an empty answer (the option buttons carry their own value, the free-text
// box does not — an empty submit would silently no-op on the server).
document.addEventListener("submit",function(e){
  const f=e.target.closest&&e.target.closest("form.confirm-del");
  if(f&&!confirm("Delete this submission? It has not been planned into tasks yet."))return e.preventDefault();
  const a=e.target.closest&&e.target.closest("form.ansform");
  if(a&&!(e.submitter&&e.submitter.name==="text")){
    const box=a.querySelector('input[name="text"]');
    if(box&&!box.value.trim()){ e.preventDefault(); box.focus(); }
  }
});
// copy the brief + stack as plain text, ready to paste anywhere
function copyBrief(btn){
  const b=btn.closest(".brief"); if(!b)return;
  const d=b.querySelector(".bdesc"), s=b.querySelector(".stext");
  const txt=[(LAST&&LAST.project?LAST.project.name:""), d?d.textContent.trim():"", s?"Stack: "+s.textContent.trim():""].filter(Boolean).join("\\n\\n");
  const done=()=>{const o=btn.textContent;btn.textContent="copied";setTimeout(()=>btn.textContent=o,1200);};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(done).catch(()=>fallback(txt,done));}
  else fallback(txt,done);
}
function fallback(txt,done){
  const ta=document.createElement("textarea");ta.value=txt;ta.style.position="fixed";ta.style.opacity="0";
  document.body.appendChild(ta);ta.select();try{document.execCommand("copy");done();}catch{}document.body.removeChild(ta);
}

// ---- capability profile + skill registry ----------------------------------
// Read-only view of what /SCH knows about this project's skills: what is
// installed, whether anyone approved it, whether it changed since they did, and
// which execution mode the future runner is allowed to use. Trust is changed
// from the CLI on purpose — an approval is a decision, not a tap.
function loadCaps(pj){
  fetch("/api/capabilities?project="+encodeURIComponent(pj))
    .then(r=>r.json()).then(c=>set("capsec",capsSec(c))).catch(()=>{});
}
function capsSec(c){
  if(!c||c.error)return"";
  const n=c.counts||{}, el=c.eligibility||{};
  const pill=(k)=>(n[k]?'<span class="badge">'+k.toLowerCase().replace("_"," ")+' '+n[k]+'</span> ':'');
  let head='<div class="scope"><b>CAPABILITIES //</b> mode <b>'+esc(c.execution_mode||"?")+'</b>'+
    (el.eligible?'':' · <span style="color:var(--red)">'+esc(el.reason||"not eligible")+'</span>')+'<br>'+
    ["BUILT_IN","APPROVED","UNREVIEWED","DISABLED","BLOCKED"].map(pill).join("")+
    '<span class="lx"> discovered '+esc((c.discoveredAt||"").slice(0,16).replace("T"," "))+'</span>';
  const flags=[];
  if((c.stale||[]).length)flags.push((c.stale.length)+' skill(s) CHANGED since approval: '+esc(c.stale.join(", ")));
  for(const x of (c.conflicts||[]))flags.push(esc(x));
  for(const x of (c.needs_approval||[]))flags.push(esc(x));
  if(flags.length)head+='<div class="q">&#9888; '+flags.join("<br>")+'</div>';
  head+='</div>';
  // recommendations per task type, with the reason attached — a recommendation
  // nobody can explain is one nobody should follow
  let recs="";
  for(const t of Object.keys(c.recommendations||{})){
    const r=c.recommendations[t];
    const line=(label,xs)=>xs&&xs.length?'<div><span class="lel">'+label+'</span> '+
      xs.map(x=>'<code title="'+esc(x.reason||"")+'">'+esc(x.skill_id)+'</code>').join(" ")+'</div>':"";
    recs+='<div class="ph"><div class="ph-h"><span class="ph-n">'+esc(t)+'</span></div>'+
      line("required",r.required)+line("recommended",r.recommended)+line("optional",r.optional)+
      line("excluded",r.excluded)+
      ((r.warnings||[]).length?'<div class="q">'+r.warnings.map(esc).join("<br>")+'</div>':"")+'</div>';
  }
  const rows=(c.skills||[]).map(s=>'<div class="ph"><span class="ph-n">'+esc(s.id)+'</span> '+
    '<span class="badge">'+esc(s.trust)+(s.stale_approval?" · stale":"")+'</span> '+
    '<span class="lx">'+esc(s.source_kind)+' · '+esc((s.capabilities||[]).join(", ")||"unclassified")+
    (s.capabilities_complete?"":" (incomplete)")+'</span></div>').join("");
  return head+recs+
    '<details class="box"><summary>'+((c.skills||[]).length)+' discovered skill(s) — trust is set from the CLI: '+
    '<code>state.mjs skill-trust &lt;id&gt; --state APPROVED</code></summary><div class="boxin">'+rows+'</div></details>';
}

// ---- the sequential queue: graph, current execution, attention, gates ------
// Read-only, deliberately. Approving a delivery and deciding a human gate are
// authority, and this page has no authentication — every one of these payloads
// says so, and the CLI command to act is printed instead of a button.
function loadQueue(pj){
  Promise.all([
    fetch("/api/task-graph?project="+encodeURIComponent(pj)).then(r=>r.json()).catch(()=>null),
    fetch("/api/scheduler?project="+encodeURIComponent(pj)).then(r=>r.json()).catch(()=>null),
    fetch("/api/human-gates?project="+encodeURIComponent(pj)).then(r=>r.json()).catch(()=>null),
    fetch("/api/runs?project="+encodeURIComponent(pj)+"&limit=8").then(r=>r.json()).catch(()=>null),
  ]).then(([g,s,h,rp])=>set("queuesec",queueSec(g,s,h,pj,rp))).catch(()=>{});
}
// What the worker was GIVEN. Names, counts and refusals — never a skill body:
// the projection does not send one and this must never ask for one.
function packBits(p){
  if(!p)return '<span class="lx">no pack recorded — this run predates project-local packs</span>';
  const sk=p.skills||[], ref=p.refusals||[];
  return '<span class="badge">'+esc(p.manifest_name||"unnamed pack")+'</span> '+
    '<span class="lx">'+sk.length+' skill(s) carried</span>'+
    (sk.length?'<div class="skl">'+sk.map(x=>'<span>'+esc(x)+'</span>').join("")+'</div>':'')+
    (ref.length?'<div class="why"><span class="badge b-warn">'+ref.length+' file(s) refused</span> '+
      ref.slice(0,6).map(x=>esc(x.path)+(x.why?' — '+esc(x.why):'')).join("<br>")+
      (ref.length>6?'<br>'+(ref.length-6)+' more':'')+'</div>':'');
}
// CLEAN is a finding. INCONCLUSIVE is the absence of one, and the whole point of
// ADR 0007 is that they are not the same answer — so they never share a colour,
// a word or a row style here.
const TERR={CLEAN:["terr-clean","stayed inside its worktree"],
  INCONCLUSIVE:["terr-unknown","the check could NOT see everything — this is not a clean result"],
  VIOLATED:["terr-bad","wrote OUTSIDE its own worktree"],
  UNWATCHED:["terr-none","nothing was watched"]};
function terrBits(t){
  if(!t)return '<span class="badge terr-none">NOT CHECKED</span> <span class="lx">this run predates the territory check</span>';
  const m=TERR[t.verdict]||["terr-none",""];
  let out='<span class="badge '+m[0]+'">'+esc(t.verdict)+'</span> <span class="lx">'+m[1]+
    ' · '+(t.watched||0)+' territory(ies) watched'+((t.excluded||[]).length?', excluding '+t.excluded.map(esc).join(", "):'')+'</span>';
  for(const v of (t.violated||[]))
    out+='<div class="viol"><b>'+esc(v.id)+'</b> — '+v.added+' added, '+v.changed+' changed, '+v.removed+' removed'+
      ((v.paths||[]).length?'<div class="why">'+v.paths.map(esc).join(", ")+'</div>':'')+'</div>';
  for(const u of (t.unknown||[]))
    out+='<div class="why">'+esc(u.id)+': '+esc(u.why||"the check could not complete")+'</div>';
  return out;
}
function runRow(r){
  const t=r.territory;
  const cls=(t&&t.verdict==="VIOLATED")?" bad":(t&&t.verdict==="INCONCLUSIVE")?" unsure":"";
  return '<div class="runrow'+cls+'"><div class="runh"><span class="rid mono">'+esc(r.run_id)+'</span>'+
    '<span>task #'+esc(String(r.task_id))+'</span><span class="lx">attempt '+esc(String(r.attempt))+'</span>'+
    '<span class="rout">'+esc(r.outcome||r.state||"")+'</span></div>'+
    '<div class="runl"><b>CAPABILITY PACK</b><span>'+packBits(r.pack)+'</span>'+
    '<b>TERRITORY</b><span>'+terrBits(t)+'</span></div></div>';
}
function queueSec(g,s,h,pj,rp){
  if((!g||g.error)&&(!s||s.error)&&(!rp||rp.error))return"";
  let out="";
  const runs=(rp&&!rp.error&&rp.runs)?rp.runs:[];
  // A worker that wrote into another task's checkout is worse than anything else
  // on this page, so it goes above everything else on this page.
  // A violation on a task that has since been re-run and delivered is history,
  // not an alarm. Keeping it pinned to the top forever trains the operator to
  // ignore the one banner that must never be ignored, so it is scoped to tasks
  // still open. The evidence stays in the run directory either way — nothing
  // here deletes a record to quieten a warning.
  const doneIds=new Set(((LAST&&LAST.state&&LAST.state.tasks)||[]).filter(isDone).map(t=>String(t.id)));
  const allViol=runs.filter(r=>r.territory&&r.territory.verdict==="VIOLATED");
  const viol=allViol.filter(r=>!doneIds.has(String(r.task_id)));
  const settled=allViol.length-viol.length;
  if(viol.length)out+='<div class="attn"><b>&#9888; A WORKER WROTE OUTSIDE ITS WORKTREE</b>'+
    viol.map(r=>'<div class="attn-row">'+esc(r.run_id)+' · task #'+esc(String(r.task_id))+' — '+
      r.territory.violated.map(v=>esc(v.id)).join(", ")+
      '<div class="why">nothing was reverted; the evidence is kept in the run directory</div></div>').join("")+'</div>';
  if(settled)out+='<div class="settled">'+settled+' earlier territory violation'+(settled>1?'s':'')+
    ' on task'+(settled>1?'s':'')+' since delivered — kept in the run records, not repeated here</div>';
  // --- project graph
  if(g&&!g.error){
    const st=(n)=>'<span class="badge">'+esc(n.state)+'</span>';
    const rows=(g.nodes||[]).map(n=>'<div class="ph"><span class="ph-n">#'+n.id+' '+esc(n.title)+'</span> '+st(n)+
      (n.ready?' <span class="badge">ready</span>':'')+
      (n.depends_on&&n.depends_on.length?' <span class="lx">after '+n.depends_on.map(d=>"#"+d).join(" ")+'</span>':'')+
      (n.delivery?' <span class="lx">'+esc(String(n.delivery.commit).slice(0,8))+' on '+esc(n.delivery.remote)+'/'+esc(n.delivery.branch)+'</span>':'')+
      (!n.ready&&(n.blockers||[]).length?'<div class="lx">'+esc(n.blockers[0].detail)+'</div>':'')+'</div>').join("");
    const v=g.validation||{};
    out+='<div class="scope"><b>PROJECT GRAPH //</b> '+((g.nodes||[]).length)+' task(s), '+((g.edges||[]).length)+' edge(s)'+
      (v.ok?'':' · <span style="color:var(--red)">graph INVALID</span>')+
      ((v.warnings||[]).length?' · <span class="lx">'+(v.warnings.length)+' audit warning(s)</span>':'')+'</div>'+
      ((v.problems||[]).length?'<div class="q">'+v.problems.map(p=>esc(p.code+": "+p.message)).join("<br>")+'</div>':'')+
      ((v.warnings||[]).length?'<details class="box"><summary>false-edge audit: '+(v.warnings.length)+' edge(s) with no defensible reason</summary><div class="boxin">'+
        v.warnings.map(w=>'<div class="ph">'+esc(w.message)+'</div>').join("")+'</div></details>':'')+
      '<details class="box" open><summary>tasks</summary><div class="boxin">'+rows+'</div></details>';
  }
  // --- current execution
  if(s&&!s.error){
    const a=s.active, l=s.lease;
    // current_task is whichever task most recently entered a phase — with
    // several in flight it is the LATEST, not the only one. Say so, and let the
    // slot strip below carry the truth about what is running.
    out+='<div class="scope"><b>SCHEDULER //</b> '+(l?('<b>'+esc(l.scheduler_id)+'</b> live (pid '+esc(String(l.pid))+')'):'none running')+
      (a?' · latest phase <b>'+esc(a.current_phase||"-")+'</b> on task <b>#'+esc(String(a.current_task||"-"))+'</b> attempt '+esc(String(a.current_attempt||"-")):'')+'</div>';
    const hist=(s.schedulers||[]).slice(0,6).map(x=>'<div class="ph"><span class="ph-n">'+esc(x.scheduler_id)+'</span> '+
      '<span class="badge">'+esc(x.state)+'</span> <span class="badge">'+esc(x.stop_reason||"running")+'</span> '+
      '<span class="lx">'+esc(String(x.tasks_delivered||0))+' delivered · '+esc(String(x.total_attempts||0))+' attempt(s)</span>'+
      (x.failure?'<div class="lx">'+esc(x.failure.code+": "+String(x.failure.message).slice(0,200))+'</div>':'')+'</div>').join("");
    if(hist)out+='<details class="box"><summary>recent scheduler runs</summary><div class="boxin">'+hist+'</div></details>';
    const c=s.completion;
    if(c)out+='<div class="scope"><b>COMPLETION //</b> '+(c.complete?'<b>COMPLETE</b>':'not complete')+'</div>'+
      '<details class="box"><summary>completion criteria</summary><div class="boxin">'+
      (c.reasons||[]).map(r=>'<div class="ph">'+(r.passed?"&#10003;":"&#10007;")+' <span class="ph-n">'+esc(r.item)+'</span><div class="lx">'+esc(r.evidence)+'</div></div>').join("")+
      '</div></details>';
  }
  // --- what is running RIGHT NOW, all of it. One slot per unit of allowed
  // parallelism: held slots come from the live task leases, spare capacity is
  // drawn dark so "3 of 4 busy" is a picture rather than a sentence.
  if(rp&&!rp.error){
    const fl=rp.in_flight||[];
    const sch=(s&&!s.error)?s:null;
    // A LIVE queue has spare slots. A stopped one has none — only a limit it
    // used to run with, which is history and is labelled as history.
    const live=(sch&&sch.active&&sch.active.max_parallel)||null;
    const last=(sch&&(sch.schedulers||[])[0]&&(sch.schedulers||[])[0].max_parallel)||null;
    const cells=fl.map(x=>'<div class="fl"><span class="fd"></span><span class="ft">task #'+esc(String(x.task_id))+'</span>'+
      '<span class="fx mono">'+esc(x.run_id||"")+(x.acquired_at?' · '+ago(Date.now()-new Date(x.acquired_at).getTime()):'')+'</span></div>');
    if(live)for(let i=fl.length;i<live;i++)cells.push('<div class="fl free"><span class="fd"></span><span class="ft">idle slot</span></div>');
    out+='<div class="scope"><b>IN FLIGHT //</b> '+fl.length+(live?' of '+live+' slot(s)':'')+' task(s) running at this moment'+
      (live?'':last?' <span class="lx">· no queue is running; the last one allowed '+esc(String(last))+' at once</span>'
                  :' <span class="lx">· no scheduler record, so the limit is unknown</span>')+'</div>'+
      (cells.length?'<div class="flight">'+cells.join("")+'</div>':'<div class="empty">no task is running</div>');
  }
  // --- run evidence: the pack each worker was given, and where it wrote
  if(runs.length)
    out+='<div class="scope"><b>RUN EVIDENCE //</b> the last '+runs.length+' run(s) — what each worker was handed, and whether it stayed in its own worktree</div>'+
      runs.map(runRow).join("");
  // --- attention required
  if(h&&!h.error&&(h.pending||[]).length){
    out+='<div class="q"><b>&#9888; NEEDS A DECISION — the queue is stopped</b><br>'+
      h.pending.map(x=>'<div class="ph"><span class="ph-n">'+esc(x.id)+' ['+esc(x.gate_type)+']'+(x.task_id?' task #'+x.task_id:'')+'</span>'+
        '<div>'+esc(x.question)+'</div>'+
        '<div class="lx">decide: <code>node scripts/state.mjs human-gate-decide --project '+esc(pj)+' --gate '+esc(x.id)+' --decision APPROVED --approver &lt;you&gt;</code></div></div>').join("")+
      '</div>';
  }
  return out;
}

// ---- live stream (SSE) + graceful fallback ----

// THE ACCOUNT'S BUDGET, not this project's bill. Fixed to the bottom of every
// page because it is the number that decides whether to start anything at all.
// Values come from Anthropic's own usage endpoint; SCH never estimates them.
let LIMITS=null;
function limitBar(){
  const el=document.getElementById("limitbar");
  if(!el) return;
  if(!LIMITS||!LIMITS.available){
    el.innerHTML='<div class="lbin"><span class="lbnone">account usage unavailable'+
      (LIMITS&&LIMITS.reason?' — '+esc(LIMITS.reason):'')+'</span></div>';
    return;
  }
  const seg=(label,w)=>{
    if(!w) return '';
    const p=Math.round(w.utilization*10)/10;
    const cls=p>=90?'crit':p>=70?'warn':'';
    return '<span class="lbseg"><span class="lbl">'+label+'</span>'+
      '<span class="lbbar '+cls+'"><span style="width:'+Math.min(100,p)+'%"></span></span>'+
      '<span class="lbv '+cls+'">'+p+'%</span>'+
      (w.resets_at?'<span class="lbr">resets '+esc(untilText(w.resets_at))+'</span>':'')+'</span>';
  };
  el.innerHTML='<div class="lbin">'+seg("session · 5h",LIMITS.five_hour)+seg("weekly · 7d",LIMITS.seven_day)+'</div>';
}
function untilText(iso){
  const ms=Date.parse(iso)-Date.now();
  if(!(ms>0)) return "resetting";
  const m=Math.round(ms/60000);
  if(m<60) return m+"m";
  const h=Math.floor(m/60), rm=m%60;
  if(h<24) return h+"h "+rm+"m";
  return Math.floor(h/24)+"d "+(h%24)+"h";
}
async function loadLimits(){
  try{ const r=await fetch("/api/limits"); LIMITS=await r.json(); }
  catch(e){ LIMITS={available:false,reason:"unreachable"}; }
  limitBar();
}
let LAST=null, curProject=null, es=null;
function connect(){
  const pj=qp("project"); curProject=pj;
  if(pj){projSkeleton(pj);loadCaps(pj);loadModels(pj);loadQueue(pj);setInterval(()=>loadQueue(pj),15000);} else homeSkeleton();
  const url="/events"+(pj?"?project="+encodeURIComponent(pj):"");
  es=new EventSource(url);
  // never swallow silently: an empty catch here hid a render crash that blanked
  // half the page while the connection still looked "live"
  es.onmessage=(m)=>{try{const d=JSON.parse(m.data);LAST=d;apply(d);mark(true);}catch(e){console.error("render failed",e);}};
  es.onerror=()=>{mark(false);};
}
function apply(d){ if(d.projects)homeApply(d.projects); else projApply(curProject,d); }
function mark(ok){const el=document.getElementById("livemark");if(el){el.textContent=ok?"live":"reconnecting…";el.className=ok?"live":"stale";}}
setInterval(()=>{const el=document.getElementById("clk");if(el)el.textContent=clock();},1000);
loadLimits(); setInterval(()=>{ if(!document.hidden) loadLimits(); },300000);
setInterval(limitBar,30000);   // keep the reset countdown honest between fetches
connect();
</script>
</body></html>`;
