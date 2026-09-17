// One dashboard, one port. Home lists every project on this machine and what each is doing; a project
// page shows its progress and its seats; a settings page holds the machine-wide defaults every project
// inherits until it chooses otherwise.
//
// It binds to loopback only and writes exactly two kinds of file: a project's roles.json, and the
// machine-wide defaults. A local editor for config does not need authentication; it needs to be unable
// to reach anything but the config.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { probeSeats, PRESETS } from "./setup.mjs";
import { resolveSpawn } from "./spawn-index.mjs";
import { summary as progressSummary, events as readEvents } from "./progress.mjs";
import { PAGE } from "./dashboard-page.mjs";
import { tree as fileTree, readFile as readProjectFile } from "./files.mjs";
import { listProjects, projectById, registerProject, forgetProject, pruneMissing, globalRoles, saveGlobalRoles, resolveRoles, ensureGlobalRoles, SEATS, home } from "./registry.mjs";

export const ROLE_SEATS = SEATS;

// Probing PATH shells out to find every CLI and reads their model catalogues. That is seconds of work,
// and it was being redone on every single page load — each navigation sat on a blank screen waiting for
// it. What is installed does not change while you are looking at a settings page.
let _seats = { at: 0, value: null };
const SEATS_TTL_MS = 60_000;
async function seatsCached(force = false) {
  if (!force && _seats.value && Date.now() - _seats.at < SEATS_TTL_MS) return _seats.value;
  _seats = { at: Date.now(), value: await probeSeats() };
  return _seats.value;
}

const rolesFile = projectRoot => path.join(projectRoot, ".sch-loop", "roles.json");
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

export function readRoles(projectRoot) {
  const r = readJson(rolesFile(projectRoot));
  if (!r) throw new Error(`no roles.json in ${projectRoot} — run setup there first`);
  return r;
}

// What each seat would actually spawn. A roles page that shows a model dropdown but not the resulting
// argv hides the thing most likely to be wrong.
function resolvedArgv(roles) {
  const out = {};
  for (const r of SEATS) {
    if (!roles?.[r]) { out[r] = "not configured"; continue; }
    try { const { exe, args } = resolveSpawn(roles[r]); out[r] = [exe, ...args].join(" "); }
    catch (e) { out[r] = `unresolvable: ${e.message}`; }
  }
  (roles?.council || []).forEach((c, i) => {
    try { const { exe, args } = resolveSpawn(c); out[`council.${i}`] = [exe, ...args].join(" "); }
    catch (e) { out[`council.${i}`] = `unresolvable: ${e.message}`; }
  });
  return out;
}

// A seat must be spawnable, and reviewer and judge must be unable to write. buildTicket enforces that at
// dispatch; enforcing it here too means the page cannot save a configuration the engine will refuse.
export function validateRoles(roles, { partial = false } = {}) {
  const errs = [];
  for (const r of SEATS) {
    const seat = roles[r];
    if (!seat) { if (!partial) errs.push(`${r} is missing`); continue; }
    if (!Array.isArray(seat.spawn) || !seat.spawn.length) errs.push(`${r}.spawn must be a non-empty argv array`);
    if (seat.model != null && typeof seat.model !== "string") errs.push(`${r}.model must be a string or null`);
  }
  if (roles.council != null && !Array.isArray(roles.council)) errs.push("council must be an array");
  else for (const [i, c] of (roles.council || []).entries()) {
    if (!c.role) errs.push(`council[${i}].role is required`);
    if (!Array.isArray(c.spawn) || !c.spawn.length) errs.push(`council[${i}].spawn must be a non-empty argv array`);
  }
  for (const r of ["reviewer", "judge"]) {
    const seat = roles[r];
    if (!seat) continue;
    const spawn = (seat.spawn || []).join(" ");
    const readOnly = /--disallowedTools[\s\S]*\bWrite\b/.test(spawn) || /--sandbox\s+read-only/.test(spawn);
    if (!readOnly) errs.push(`${r} must be read-only — it grades work it must not be able to change. Add the read-only preset.`);
  }
  return errs;
}

export function saveRoles(projectRoot, roles) {
  const errs = validateRoles(roles, { partial: true });
  if (errs.length) throw new Error(errs.join("; "));
  const f = rolesFile(projectRoot);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(roles, null, 2) + "\n");
  return f;
}

// ---- the three views' data ------------------------------------------------------------------------

export async function homeState({ fresh = false } = {}) {
  const seats = await seatsCached(fresh);
  const pruned = pruneMissing();
  const projects = listProjects().map(p => {
    let s = null;
    try { s = progressSummary(p.root); } catch { /* a project whose state is unreadable still lists */ }
    return {
      id: p.id, name: p.name, root: p.root, exists: p.exists,
      goal: s?.goal ? s.goal.replace(/^#\s*Goal\s*/i, "").trim().split(/\r?\n/).filter(Boolean)[0] : null,
      running: !!s?.live?.running, current: s?.current ? { id: s.current.id, title: s.current.title, phase: s.current.phase } : null,
      done: s?.totals?.done ?? 0, tickets: s?.totals?.tickets ?? 0,
      blocked: s?.totals?.blocked ?? 0, needsHuman: s?.totals?.needsHuman ?? 0,
      cost: s?.totals?.costUsd ?? 0, lastActivityAt: s?.totals?.lastActivityAt || null,
      stagesDone: (s?.stages || []).filter(x => x.complete).length,
      stagesTotal: (s?.stages || []).length,
    };
  });
  return { seats, projects, pruned, home: home(), hasGlobal: !!globalRoles() };
}

export async function settingsState({ fresh = false } = {}) {
  const seats = await seatsCached(fresh);
  const roles = globalRoles();
  return { seats, presets: PRESETS, roles, resolved: roles ? resolvedArgv(roles) : {}, home: home(), file: path.join(home(), "roles.json") };
}

export async function projectState(id) {
  const p = projectById(id);
  if (!p) return null;
  const seats = await seatsCached();
  const own = readJson(rolesFile(p.root));
  const effective = resolveRoles(own);
  let progress = null;
  try { progress = progressSummary(p.root); } catch { /* unreadable state is reported as null */ }
  return {
    project: { id: p.id, name: p.name, root: p.root },
    seats, presets: PRESETS,
    roles: effective, source: effective.source, own,
    resolved: resolvedArgv(effective),
    progress,
    log: (() => { try { return readEvents(p.root, { limit: 40 }); } catch { return []; } })(),
  };
}

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body, null, 2)); };
const body = req => new Promise((resolve, reject) => { let s = ""; req.on("data", d => (s += d)); req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch (e) { reject(e); } }); });

export function createServer(defaultProjectRoot = null) {
  // A project passed on the command line is registered, so opening the dashboard from a project always
  // shows that project rather than an empty list.
  if (defaultProjectRoot && fs.existsSync(path.join(defaultProjectRoot, ".sch-loop"))) {
    try { registerProject(defaultProjectRoot); ensureGlobalRoles(readJson(rolesFile(defaultProjectRoot))); } catch {}
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;

      if (req.method === "GET" && (p === "/" || p.startsWith("/p/") || p === "/settings")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(PAGE);
      }
      if (req.method === "GET" && p === "/api/home") return json(res, 200, await homeState({ fresh: url.searchParams.has("fresh") }));
      if (req.method === "GET" && p === "/api/settings") return json(res, 200, await settingsState({ fresh: url.searchParams.has("fresh") }));
      // The files of one project. The tree arrives once and is filtered in the page; a file arrives
      // one at a time. Both go through files.mjs, which owns the "inside the project" rule.
      if (req.method === "GET" && p.startsWith("/api/files/")) {
        const proj = projectById(decodeURIComponent(p.slice("/api/files/".length)));
        if (!proj) return json(res, 404, { error: "unknown project" });
        try { return json(res, 200, fileTree(proj.root)); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === "GET" && p.startsWith("/api/file/")) {
        const proj = projectById(decodeURIComponent(p.slice("/api/file/".length)));
        if (!proj) return json(res, 404, { error: "unknown project" });
        try { return json(res, 200, readProjectFile(proj.root, url.searchParams.get("path") || "")); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === "GET" && p.startsWith("/api/project/")) {
        const st = await projectState(decodeURIComponent(p.slice("/api/project/".length)));
        return st ? json(res, 200, st) : json(res, 404, { error: "unknown project" });
      }
      if (req.method === "POST" && p === "/api/settings") {
        const next = await body(req);
        const errs = validateRoles(next, { partial: true });
        if (errs.length) return json(res, 400, { error: errs.join("; ") });
        saveGlobalRoles(next);
        return json(res, 200, await settingsState());
      }
      if (req.method === "POST" && p.startsWith("/api/project/")) {
        const id = decodeURIComponent(p.slice("/api/project/".length));
        const proj = projectById(id);
        if (!proj) return json(res, 404, { error: "unknown project" });
        const next = await body(req);
        try { saveRoles(proj.root, next); } catch (e) { return json(res, 400, { error: e.message }); }
        return json(res, 200, await projectState(id));
      }
      if (req.method === "POST" && p === "/api/forget") {
        const { id } = await body(req);
        return json(res, 200, { forgot: forgetProject(id) });
      }
      json(res, 404, { error: "not found" });
    } catch (e) { json(res, 500, { error: e.message }); }
  });
}

export function serve(projectRoot = null, { port = 4319, host = "127.0.0.1" } = {}) {
  return new Promise(resolve => {
    const server = createServer(projectRoot);
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}` }));
  });
}
