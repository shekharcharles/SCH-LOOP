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

// The page, in the SCH-LOOP console language: near-black ground, red as the structural accent, terminal
// green for live-and-good, monospace throughout, scanlines, bracketed labels. Lifted from the v2
// operations dashboard so the two look like one product rather than two.
const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>SCH·LOOP // OPS</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap">
<style>
  :root{color-scheme:dark;--bg:#0a0a0a;--panel:#121212;--panel2:#171717;--line:#282828;--fg:#eaeaea;--dim:#7d7d7d;--red:#ff2a2a;--green:#4af626;--amber:#e3b341;--blue:#58a6ff;}
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--fg);font:clamp(12px,1vw,14px)/1.5 ui-monospace,"JetBrains Mono","Cascadia Code",Consolas,monospace}
  body{padding:max(env(safe-area-inset-top),clamp(12px,2.2vw,28px)) clamp(12px,2.2vw,28px) 96px}
  body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:9;background:repeating-linear-gradient(0deg,transparent 0 2px,rgba(255,255,255,.015) 2px 3px)}
  .wrap{width:100%;max-width:min(1400px,100%);margin-inline:auto;position:relative;z-index:1}
  a{color:var(--fg);text-decoration:none}

  h1{font-family:"Archivo Black",Inter,system-ui,sans-serif;font-weight:900;text-transform:uppercase;letter-spacing:-.03em;line-height:.92;font-size:clamp(1.7rem,5vw,3.4rem);margin:0 0 .08em}
  h2{font-size:clamp(10px,1vw,12px);text-transform:uppercase;letter-spacing:.14em;color:var(--dim);margin:0;padding:14px 0 6px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  h2::before{content:"[ "}h2 .n{color:var(--dim)}h2 .n::after{content:" ]"}
  .bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);border-bottom:2px solid var(--red);padding-bottom:9px;margin-bottom:22px}
  .bar a{color:var(--dim)} .bar a:hover{color:var(--fg)} .bar a.on{color:var(--green)}
  .dot{width:8px;height:8px;background:var(--green);display:inline-block;margin-right:6px;animation:blink 1.6s step-end infinite}
  @keyframes blink{50%{opacity:.25}}
  .sub{color:var(--dim);text-transform:uppercase;letter-spacing:.1em;font-size:11px;margin:0 0 22px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .sub code{color:var(--fg);text-transform:none;letter-spacing:0}

  .grid{display:grid;gap:1px;background:var(--line);border:1px solid var(--line)}
  .cards{grid-template-columns:repeat(auto-fill,minmax(min(340px,100%),1fr))}
  .kpis{grid-template-columns:repeat(auto-fit,minmax(90px,1fr))}
  .cell{background:var(--panel);padding:13px 15px;display:block}
  a.cell:hover{background:var(--panel2)}
  .kpi{background:var(--panel);padding:10px 12px}
  .kpi b{display:block;font-size:clamp(16px,2.4vw,22px);font-weight:800;line-height:1;margin-bottom:2px}
  .kpi span{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.09em}
  .kpi.good b{color:var(--green)}.kpi.warn b{color:var(--amber)}.kpi.bad b{color:var(--red)}.kpi.info b{color:var(--blue)}
  .pname{font-family:"Archivo Black",Inter,system-ui,sans-serif;font-weight:900;text-transform:uppercase;font-size:15px;letter-spacing:.01em;margin-bottom:3px}
  .ppath{font-size:10.5px;color:var(--dim);word-break:break-all;margin-bottom:8px}
  .pgoal{font-size:11.5px;color:var(--dim);margin-bottom:9px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .prog{height:4px;background:var(--line);margin:8px 0 6px}.prog i{display:block;height:100%;background:var(--green)}
  .pfoot{display:flex;gap:10px;flex-wrap:wrap;font-size:10.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.07em}
  .st{font-size:10px;font-weight:700;letter-spacing:.06em;padding:2px 6px;border:1px solid var(--line);white-space:nowrap;text-transform:uppercase}
  .st-run{color:var(--green);border-color:var(--green)}.st-idle{color:var(--dim)}.st-bad{color:var(--red);border-color:var(--red)}.st-wait{color:var(--amber);border-color:var(--amber)}

  .seats{display:flex;gap:8px;flex-wrap:wrap;margin:2px 0 4px}
  .cli{font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:5px 10px;border:1px solid var(--line);background:var(--panel)}
  .cli.on{color:var(--green);border-color:var(--green)}
  .cli.off{color:var(--dim);text-decoration:line-through}

  .seat{border:1px solid var(--line);background:var(--panel);margin-bottom:14px}
  .seat.locked{border-left:3px solid var(--red)}
  .seat>header{display:flex;align-items:baseline;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);background:var(--panel2);flex-wrap:wrap}
  .seat>header b{font-family:"Archivo Black",Inter,system-ui,sans-serif;font-weight:900;text-transform:uppercase;letter-spacing:.02em;font-size:14px}
  .tag{font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:2px 6px;border:1px solid var(--line);color:var(--dim)}
  .tag::before{content:"["}.tag::after{content:"]"}
  .tag.must{color:var(--red);border-color:var(--red)}
  .tag.inherited{color:var(--blue);border-color:var(--blue)}
  .tag.own{color:var(--green);border-color:var(--green)}
  .seat>header .sp{margin-left:auto}
  .seat>.body{padding:12px 14px}
  .seat.dim>.body{opacity:.62}

  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
  .fld{display:flex;flex-direction:column;gap:5px;min-width:0}
  .fld>label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
  .fld.grow{flex:1 1 320px}
  select,input[type=text]{font-family:inherit;font-size:12px;padding:8px 10px;background:var(--bg);color:var(--fg);border:1px solid var(--line);min-width:170px}
  input[type=text]{width:100%}
  select:focus,input:focus{outline:none;border-color:var(--red)}
  select:disabled,input:disabled{opacity:.5;cursor:not-allowed}

  .flags{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
  .flag{display:inline-flex;align-items:center;gap:7px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);border:1px solid var(--line);background:var(--bg);padding:6px 10px;cursor:pointer;user-select:none}
  .flag:hover{border-color:var(--fg);color:var(--fg)}
  .flag input{appearance:none;width:9px;height:9px;border:1px solid var(--dim);background:transparent;margin:0}
  .flag input:checked{background:var(--green);border-color:var(--green)}
  .flag:has(input:checked){color:var(--green);border-color:var(--green)}

  .argv{margin-top:12px;padding:9px 12px;background:var(--bg);border:1px solid var(--line);border-left:2px solid var(--green);font-size:11.5px;color:var(--dim);white-space:pre-wrap;word-break:break-all}
  .argv.bad{border-left-color:var(--red);color:var(--red)}

  .cn{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 14px;border-top:1px solid var(--line)}
  .cn:first-of-type{border-top:0}
  .cn b{min-width:96px;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
  .cn.off{opacity:.45}
  .cn .argv{flex:1 1 260px;margin:0}

  .ph{margin:10px 0 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
  .ph b{color:var(--fg)}
  .tk{display:flex;gap:10px;align-items:baseline;padding:5px 0;border-top:1px solid var(--line);font-size:11.5px;flex-wrap:wrap}
  .tk .g{width:12px;flex:none} .tk .tid{color:var(--red);width:58px;flex:none} .tk .ty{color:var(--dim);width:66px;flex:none}
  .tk .ti{flex:1 1 220px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tk .mt{color:var(--dim);font-size:10.5px}
  .tk.done .g{color:var(--green)} .tk.run .g{color:var(--amber)} .tk.bad .g{color:var(--red)}
  .ev{color:var(--dim);font-size:11.5px;padding:4px 0;border-bottom:1px solid var(--line)}.ev b{color:var(--fg)}

  .actions{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;gap:10px;align-items:center;
           padding:12px clamp(12px,2.2vw,28px);background:var(--bg);border-top:2px solid var(--red)}
  button{font-family:inherit;padding:10px 18px;border:0;font-weight:700;font-size:11px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}
  button.save{background:var(--green);color:#000}
  button.ghost{background:var(--panel2);color:var(--fg);border:1px solid var(--line)}
  button.ghost:hover{border-color:var(--fg)}
  button.mini{padding:5px 10px;font-size:10px;background:var(--panel2);color:var(--fg);border:1px solid var(--line)}
  button.mini:hover{border-color:var(--fg)}
  .msg{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
  .msg.bad{color:var(--red)} .msg.good{color:var(--green)}
  .empty{color:var(--dim);padding:12px 14px;border:1px dashed var(--line);text-transform:uppercase;font-size:11px;letter-spacing:.1em}
</style></head><body><div class="wrap">

<div class="bar">
  <span><span class="dot"></span><span style="color:var(--green)">sch·loop</span></span>
  <a href="/" id="navhome">projects</a>
  <a href="/settings" id="navset">global settings</a>
  <span id="where" style="margin-left:auto"></span>
</div>
<div id="view"></div>
</div>
<div class="actions" id="actions" style="display:none"><button class="save" id="save">Save</button><button class="ghost" id="reload">Reload</button><span id="msg" class="msg"></span></div>
<script>
let S = null, MODE = "home", PID = null;
const $ = s => document.querySelector(s);
const el = (t, a = {}, kids = []) => { const n = document.createElement(t); for (const [k, v] of Object.entries(a)) { if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else if (v !== false && v != null) n.setAttribute(k, v); } for (const c of [].concat(kids)) if (c != null) n.append(c); return n; };
const installed = () => (S.seats || []).filter(s => s.available).map(s => s.provider);
const dur = ms => ms == null ? "—" : ms < 90000 ? Math.round(ms/1000)+"s" : ms < 3600000 ? Math.round(ms/60000)+"m" : Math.floor(ms/3600000)+"h"+String(Math.round(ms%3600000/60000)).padStart(2,"0");
const clock = at => at ? new Date(at).toTimeString().slice(0,5) : "—";

// A seat set to a CLI that is not installed must still SHOW that CLI, or the dropdown falls back to its
// first option and the page reports a configuration nobody chose.
function providerOptions(current) {
  const names = [...new Set([...installed(), current].filter(Boolean))];
  return names.map(p => el("option", p === current ? { value: p, selected: "selected" } : { value: p }, p + (installed().includes(p) ? "" : " — not installed")));
}
const presetsFor = p => Object.keys((S.presets || {})[p] || {}).filter(k => k !== "base" && k !== "model_arg");
const hasPreset = (spawn, frag) => { const j = spawn.join(" "); return frag.every(f => j.includes(f)); };
function togglePreset(seat, name, on) {
  const frag = (S.presets[seat.provider] || {})[name] || [];
  if (!frag.length) return;
  if (on) { if (!hasPreset(seat.spawn, frag)) seat.spawn = [...seat.spawn, ...frag]; }
  else { const j = seat.spawn.join("\\u0000"); seat.spawn = j.split(frag.join("\\u0000")).join("").split("\\u0000").filter(Boolean); }
}

function seatCard(key, seat, title, note, locked, origin, onCustomise, onInherit) {
  if (!seat) return el("div", { class: "seat" }, [el("header", {}, [el("b", {}, title), el("span", { class: "tag must" }, "not configured")])]);
  const models = (S.seats.find(s => s.provider === seat.provider) || {}).models || [];
  const argv = S.resolved[key] || "";
  const inherited = origin === "global";
  const head = [el("b", {}, title), el("span", { class: "tag" + (locked ? " must" : "") }, note)];
  if (origin) head.push(el("span", { class: "tag " + (inherited ? "inherited" : "own") }, inherited ? "inherited" : "this project"));
  if (onCustomise && inherited) head.push(el("span", { class: "sp" }, el("button", { class: "mini", onclick: onCustomise }, "customise for this project")));
  if (onInherit && !inherited) head.push(el("span", { class: "sp" }, el("button", { class: "mini", onclick: onInherit }, "use the global default")));

  const dis = inherited || false;
  return el("div", { class: "seat" + (locked ? " locked" : "") + (dis ? " dim" : "") }, [
    el("header", {}, head),
    el("div", { class: "body" }, [
      el("div", { class: "row" }, [
        el("div", { class: "fld" }, [el("label", {}, "CLI"),
          el("select", { disabled: dis || false, onchange: e => { seat.provider = e.target.value; seat.spawn = [...((S.presets[seat.provider] || {}).base || [seat.provider])]; seat.model = null; render(); } }, providerOptions(seat.provider))]),
        el("div", { class: "fld" }, [el("label", {}, "Model"),
          el("select", { disabled: dis || false, onchange: e => { seat.model = e.target.value || null; render(); } },
            [el("option", seat.model ? { value: "" } : { value: "", selected: "selected" }, "provider default"),
             ...models.map(m => el("option", m === seat.model ? { value: m, selected: "selected" } : { value: m }, m))])]),
        el("div", { class: "fld grow" }, [el("label", {}, "Spawn argv"),
          el("input", { type: "text", disabled: dis || false, value: seat.spawn.join(" "), onchange: e => { seat.spawn = e.target.value.trim().split(/\\s+/).filter(Boolean); render(); } })]),
      ]),
      el("div", { class: "flags" }, presetsFor(seat.provider).map(name => {
        const on = hasPreset(seat.spawn, S.presets[seat.provider][name]);
        const cb = el("input", on ? { type: "checkbox", checked: "checked" } : { type: "checkbox" });
        if (dis) cb.disabled = true;
        cb.addEventListener("change", e => { togglePreset(seat, name, e.target.checked); render(); });
        return el("label", { class: "flag" }, [cb, name.replace(/_/g, " ")]);
      })),
      el("div", { class: "argv" + (/^(unresolvable|not configured)/.test(argv) ? " bad" : "") }, argv),
    ]),
  ]);
}

function councilBlock(roles, editable) {
  return el("div", { class: "seat" }, (roles.council || []).map((c, i) => {
    const on = el("input", c.enabled !== false ? { type: "checkbox", checked: "checked" } : { type: "checkbox" });
    if (!editable) on.disabled = true;
    on.addEventListener("change", e => { c.enabled = e.target.checked; render(); });
    const models = (S.seats.find(s => s.provider === c.provider) || {}).models || [];
    return el("div", { class: "cn" + (c.enabled === false ? " off" : "") }, [
      el("label", { class: "flag" }, [on, "seat"]),
      el("b", {}, c.role),
      el("select", { disabled: !editable || false, onchange: e => { c.provider = e.target.value; c.spawn = [...((S.presets[c.provider] || {}).base || [c.provider])]; c.model = null; render(); } }, providerOptions(c.provider)),
      el("select", { disabled: !editable || false, onchange: e => { c.model = e.target.value || null; render(); } },
        [el("option", { value: "" }, "default"), ...models.map(m => el("option", m === c.model ? { value: m, selected: "selected" } : { value: m }, m))]),
      el("span", { class: "argv" }, S.resolved["council." + i] || ""),
    ]);
  }));
}

// ---------------------------------------------------------------- views ----
function renderHome() {
  $("#where").textContent = S.home;
  const v = $("#view"); v.replaceChildren();
  v.append(el("h1", {}, "Projects"), el("div", { class: "sub" }, S.projects.length + " registered · a project appears here when you run setup in it"));
  v.append(el("h2", {}, ["Installed", el("span", { class: "n" }, installed().length + " of " + S.seats.length)]));
  v.append(el("div", { class: "seats" }, S.seats.map(s => el("span", { class: "cli " + (s.available ? "on" : "off") }, s.provider + (s.available ? " ✓" : "")))));

  v.append(el("h2", {}, ["Projects", el("span", { class: "n" }, S.projects.filter(p => p.running).length + " running")]));
  if (!S.projects.length) { v.append(el("div", { class: "empty" }, "no projects yet — run setup in one")); return; }
  v.append(el("div", { class: "grid cards" }, S.projects.map(p => {
    const pct = p.tickets ? Math.round((p.done / p.tickets) * 100) : 0;
    const state = p.running ? ["st st-run", "running"] : p.blocked ? ["st st-bad", p.blocked + " blocked"] : p.needsHuman ? ["st st-wait", "needs you"] : ["st st-idle", "idle"];
    return el("a", { class: "cell", href: "/p/" + p.id }, [
      el("div", { class: "pname" }, p.name),
      el("div", { class: "ppath" }, p.root),
      p.goal ? el("div", { class: "pgoal" }, p.goal) : null,
      el("div", { class: "prog" }, el("i", { style: "width:" + pct + "%" })),
      el("div", { class: "pfoot" }, [
        el("span", { class: state[0] }, state[1]),
        el("span", {}, p.done + "/" + p.tickets + " tickets"),
        el("span", {}, p.stagesDone + "/" + p.stagesTotal + " spec"),
        p.cost ? el("span", {}, "$" + p.cost.toFixed(2)) : null,
        p.current ? el("span", { style: "color:var(--amber)" }, p.current.id) : null,
      ]),
    ]);
  })));
}

function renderSettings() {
  $("#where").textContent = S.file;
  const v = $("#view"); v.replaceChildren();
  v.append(el("h1", {}, "Global"), el("div", { class: "sub" }, ["defaults every project inherits until it chooses its own · writes ", el("code", {}, S.file)]));
  if (!S.roles) { v.append(el("div", { class: "empty" }, "no defaults yet — run setup in a project and they are seeded from it")); return; }
  v.append(el("h2", {}, ["Installed", el("span", { class: "n" }, installed().length + " of " + S.seats.length)]));
  v.append(el("div", { class: "seats" }, S.seats.map(s => el("span", { class: "cli " + (s.available ? "on" : "off") }, s.provider + (s.available ? " ✓" : "")))));
  v.append(el("h2", {}, ["Seats", el("span", { class: "n" }, "machine-wide")]));
  v.append(seatCard("executor", S.roles.executor, "Executor", "writes code", false));
  v.append(seatCard("reviewer", S.roles.reviewer, "Reviewer", "must be read-only", true));
  v.append(seatCard("judge", S.roles.judge, "Judge", "must be read-only", true));
  v.append(el("h2", {}, ["Council", el("span", { class: "n" }, "gated · convened on a red ticket")]));
  v.append(councilBlock(S.roles, true));
  $("#actions").style.display = "flex";
}

function renderProject() {
  const pr = S.progress, P = S.project;
  $("#where").textContent = P.root;
  const v = $("#view"); v.replaceChildren();
  v.append(el("h1", {}, P.name));
  v.append(el("div", { class: "sub" }, [pr && pr.goal ? pr.goal.replace(/^#\\s*Goal\\s*/i, "").trim().split(/\\r?\\n/).filter(Boolean)[0] : "no goal set"]));

  if (pr) {
    const t = pr.totals;
    v.append(el("h2", {}, ["Now", el("span", { class: "n" }, pr.live.running ? "running" : "idle")]));
    if (pr.current) {
      v.append(el("div", { class: "seat" }, el("div", { class: "body" }, [
        el("div", { class: "ph" }, [el("span", {}, "phase " + pr.current.phase), el("b", {}, pr.current.phaseName)]),
        el("div", { class: "ph" }, [el("span", { style: "color:var(--red)" }, pr.current.id), el("b", {}, pr.current.title),
          el("span", {}, "since " + clock(pr.current.startedAt) + " · " + dur(pr.current.ms))]),
      ])));
    } else v.append(el("div", { class: "empty" }, "nothing building right now"));

    v.append(el("div", { class: "grid kpis" }, [
      el("div", { class: "kpi good" }, [el("b", {}, t.done + "/" + t.tickets), el("span", {}, "tickets")]),
      el("div", { class: "kpi" }, [el("b", {}, dur(t.specMs)), el("span", {}, "spec")]),
      el("div", { class: "kpi" }, [el("b", {}, dur(t.buildMs)), el("span", {}, "build")]),
      el("div", { class: "kpi info" }, [el("b", {}, t.reviews), el("span", {}, "reviews")]),
      el("div", { class: "kpi" }, [el("b", {}, "$" + t.costUsd.toFixed(2)), el("span", {}, "cost")]),
      el("div", { class: "kpi" + (t.blocked ? " bad" : "") }, [el("b", {}, t.blocked), el("span", {}, "blocked")]),
      el("div", { class: "kpi" + (t.needsHuman ? " warn" : "") }, [el("b", {}, t.needsHuman), el("span", {}, "needs you")]),
    ]));

    v.append(el("h2", {}, ["Specification", el("span", { class: "n" }, dur(t.specMs))]));
    v.append(el("div", { class: "seat" }, el("div", { class: "body" }, pr.stages.map(x =>
      el("div", { class: "tk " + (x.complete ? "done" : "") }, [
        el("span", { class: "g" }, x.complete ? "✔" : "·"),
        el("span", { class: "ti" }, x.id), el("span", { class: "mt" }, x.written != null ? x.written + " tickets" : x.complete ? (x.chars || 0).toLocaleString() + " chars" : x.why),
        el("span", { class: "mt" }, dur(x.ms)),
      ])))));

    for (const ph of pr.phases) {
      v.append(el("h2", {}, ["Phase " + ph.id + " — " + ph.name, el("span", { class: "n" }, ph.done + "/" + ph.total + " · " + dur(ph.buildMs) + (ph.cost ? " · $" + ph.cost.toFixed(2) : ""))]));
      v.append(el("div", { class: "seat" }, el("div", { class: "body" }, ph.tickets.map(tk => {
        const cls = tk.status === "x" ? "done" : tk.running ? "run" : (tk.status === "!" || tk.status === "?") ? "bad" : "";
        const glyph = { " ": "·", "~": "▶", x: "✔", "!": "✖", "?": "?" }[tk.status] || "?";
        const bits = [];
        if (tk.startedAt) bits.push(clock(tk.startedAt) + "→" + (tk.endedAt ? clock(tk.endedAt) : "…"));
        if (tk.ms != null) bits.push(dur(tk.ms));
        if (tk.attempts) bits.push(tk.attempts + " att");
        if (tk.files) bits.push(tk.files + "f");
        if (tk.review) bits.push(tk.review);
        if (tk.cost) bits.push("$" + tk.cost.toFixed(2));
        if (!tk.startedAt && tk.gate) bits.push("waits for you");
        return el("div", { class: "tk " + cls }, [
          el("span", { class: "g" }, glyph), el("span", { class: "tid" }, tk.id), el("span", { class: "ty" }, tk.type),
          el("span", { class: "ti" }, tk.title), el("span", { class: "mt" }, bits.join("  ")),
        ]);
      }))));
    }
  }

  v.append(el("h2", {}, ["Seats", el("span", { class: "n" }, "blue = inherited from global")]));
  const own = S.own || {};
  const customise = seat => () => { S.own = { ...own, [seat]: JSON.parse(JSON.stringify(S.roles[seat])) }; S.source[seat] = "project"; render(); };
  const inherit = seat => () => { const n = { ...S.own }; delete n[seat]; S.own = n; render(); };
  v.append(seatCard("executor", S.roles.executor, "Executor", "writes code", false, S.source.executor, customise("executor"), inherit("executor")));
  v.append(seatCard("reviewer", S.roles.reviewer, "Reviewer", "must be read-only", true, S.source.reviewer, customise("reviewer"), inherit("reviewer")));
  v.append(seatCard("judge", S.roles.judge, "Judge", "must be read-only", true, S.source.judge, customise("judge"), inherit("judge")));
  v.append(el("h2", {}, ["Council", el("span", { class: "n" }, S.source.council === "global" ? "inherited" : "this project")]));
  v.append(councilBlock(S.roles, S.source.council === "project"));

  if (pr && S.log.length) {
    v.append(el("h2", {}, ["Log", el("span", { class: "n" }, "last " + S.log.length)]));
    v.append(el("div", { class: "seat" }, el("div", { class: "body" }, S.log.slice().reverse().map(e =>
      el("div", { class: "ev" }, [el("b", {}, clock(e.at) + "  "), e.type + (e.id ? " " + e.id : "") + (e.stage ? " " + e.stage : "")])))));
  }
  $("#actions").style.display = "flex";
}

function render() { MODE === "home" ? renderHome() : MODE === "settings" ? renderSettings() : renderProject(); }

async function load() {
  const p = location.pathname;
  MODE = p === "/settings" ? "settings" : p.startsWith("/p/") ? "project" : "home";
  PID = MODE === "project" ? decodeURIComponent(p.slice(3)) : null;
  $("#navhome").className = MODE === "home" ? "on" : "";
  $("#navset").className = MODE === "settings" ? "on" : "";
  $("#actions").style.display = MODE === "home" ? "none" : "flex";
  $("#msg").className = "msg"; $("#msg").textContent = "loading…";
  try {
    const url = MODE === "settings" ? "/api/settings" : MODE === "project" ? "/api/project/" + encodeURIComponent(PID) : "/api/home";
    S = await (await fetch(url)).json();
    if (S.error) throw new Error(S.error);
    render(); $("#msg").textContent = "";
  } catch (e) { $("#msg").className = "msg bad"; $("#msg").textContent = "could not load: " + e.message; }
}
$("#reload").addEventListener("click", load);
$("#save").addEventListener("click", async () => {
  const url = MODE === "settings" ? "/api/settings" : "/api/project/" + encodeURIComponent(PID);
  const payload = MODE === "settings" ? S.roles : (S.own || {});
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const j = await r.json();
  const m = $("#msg");
  if (!r.ok) { m.className = "msg bad"; m.textContent = j.error; return; }
  S = j; render(); m.className = "msg good"; m.textContent = "saved";
});
load();
</script></body></html>`;
