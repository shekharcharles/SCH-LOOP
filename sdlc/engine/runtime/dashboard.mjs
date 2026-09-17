// The Roles page: pick which installed CLI fills each seat, which model it uses, and which flags it
// spawns with. Nothing about a model or a flag is hard-coded in engine code — `roles.json` is the whole
// truth and this is an editor for it.
//
// Deliberately small. The v2 dashboard is a different thing for a different era, and porting it would
// bring councils, provider registries and verification runs along with it. What was actually missing was
// the one page that answers "who is doing what here", so that is what this is.
//
// It binds to loopback only and writes exactly one file. A local editor for a config file does not need
// authentication; it needs to be unable to reach anything but the config file.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { probeSeats, PRESETS } from "./setup.mjs";
import { loadRoles } from "./roles.mjs";
import { resolveSpawn } from "./spawn-index.mjs";

export const ROLE_SEATS = ["executor", "reviewer", "judge"];

const rolesFile = projectRoot => path.join(projectRoot, ".sch-loop", "roles.json");

export function readRoles(projectRoot) {
  return JSON.parse(fs.readFileSync(rolesFile(projectRoot), "utf8"));
}

// Everything the page needs to render, in one call: what is installed, what each seat is set to, and
// what each seat would actually spawn. The last one matters — a roles page that shows a model dropdown
// but not the resulting argv hides the thing most likely to be wrong.
export async function state(projectRoot) {
  const roles = readRoles(projectRoot);
  const seats = await probeSeats();
  const resolved = {};
  for (const r of ROLE_SEATS) {
    try { const { exe, args } = resolveSpawn(roles[r]); resolved[r] = [exe, ...args].join(" "); }
    catch (e) { resolved[r] = `unresolvable: ${e.message}`; }
  }
  roles.council?.forEach((c, i) => {
    try { const { exe, args } = resolveSpawn(c); resolved[`council.${i}`] = [exe, ...args].join(" "); }
    catch (e) { resolved[`council.${i}`] = `unresolvable: ${e.message}`; }
  });
  return { seats, roles, resolved, presets: PRESETS };
}

// A seat must be spawnable and, for reviewer and judge, unable to write. That rule is enforced in
// build.mjs at dispatch time; enforcing it here too means the dashboard cannot be used to create a
// configuration the engine will then refuse to run.
export function validateRoles(roles) {
  const errs = [];
  for (const r of ROLE_SEATS) {
    const seat = roles[r];
    if (!seat) { errs.push(`${r} is missing`); continue; }
    if (!Array.isArray(seat.spawn) || !seat.spawn.length) errs.push(`${r}.spawn must be a non-empty argv array`);
    if (seat.model != null && typeof seat.model !== "string") errs.push(`${r}.model must be a string or null`);
  }
  if (!Array.isArray(roles.council)) errs.push("council must be an array");
  else roles.council.forEach((c, i) => {
    if (!c.role) errs.push(`council[${i}].role is required`);
    if (!Array.isArray(c.spawn) || !c.spawn.length) errs.push(`council[${i}].spawn must be a non-empty argv array`);
  });
  // Mirrors the check buildTicket makes before it will dispatch anything.
  for (const r of ["reviewer", "judge"]) {
    const spawn = (roles[r]?.spawn || []).join(" ");
    const readOnly = /--disallowedTools[\s\S]*\bWrite\b/.test(spawn) || /--sandbox\s+read-only/.test(spawn);
    if (!readOnly) errs.push(`${r} must be read-only — it grades work it must not be able to change. Add the read-only preset.`);
  }
  return errs;
}

export function saveRoles(projectRoot, roles) {
  const errs = validateRoles(roles);
  if (errs.length) throw new Error(errs.join("; "));
  const f = rolesFile(projectRoot);
  fs.writeFileSync(f, JSON.stringify(roles, null, 2) + "\n");
  return f;
}

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body, null, 2)); };
const body = req => new Promise((resolve, reject) => { let s = ""; req.on("data", d => (s += d)); req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch (e) { reject(e); } }); });

export function createServer(projectRoot) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(PAGE);
      }
      if (req.method === "GET" && req.url === "/api/state") return json(res, 200, await state(projectRoot));
      if (req.method === "POST" && req.url === "/api/roles") {
        const next = await body(req);
        try { saveRoles(projectRoot, next); } catch (e) { return json(res, 400, { error: e.message }); }
        return json(res, 200, await state(projectRoot));
      }
      json(res, 404, { error: "not found" });
    } catch (e) { json(res, 500, { error: e.message }); }
  });
}

export function serve(projectRoot, { port = 4319, host = "127.0.0.1" } = {}) {
  return new Promise(resolve => {
    const server = createServer(projectRoot);
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}` }));
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SCH-LOOP Roles</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#272b34; --fg:#e6e8ec; --dim:#98a0ad; --accent:#7aa2f7; --bad:#f7768e; --good:#9ece6a; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --panel:#fff; --line:#e2e5ea; --fg:#1a1d23; --dim:#5c6570; } }
  * { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; padding:24px 16px 96px; }
  .wrap { max-width:960px; margin:0 auto } h1 { font-size:20px; margin:0 0 4px } .sub { color:var(--dim); margin:0 0 20px }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:14px }
  .row { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end }
  label { display:block; font-size:12px; color:var(--dim); margin-bottom:4px }
  select,input { background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:7px; padding:7px 9px; font:inherit; min-width:170px }
  input[type=text] { width:100% } .grow { flex:1 1 320px }
  h2 { font-size:15px; margin:0 0 12px; display:flex; gap:8px; align-items:center }
  .pill { font-size:11px; color:var(--dim); border:1px solid var(--line); border-radius:999px; padding:1px 8px }
  .argv { font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--dim); background:var(--bg); border:1px solid var(--line); border-radius:7px; padding:8px 10px; margin-top:10px; overflow-x:auto; white-space:pre-wrap; word-break:break-all }
  .flags { display:flex; gap:14px; flex-wrap:wrap; margin-top:10px } .flags label { display:flex; gap:6px; align-items:center; font-size:13px; color:var(--fg); margin:0 }
  button { background:var(--accent); color:#0b0d11; border:0; border-radius:8px; padding:9px 16px; font:inherit; font-weight:600; cursor:pointer }
  button.ghost { background:transparent; color:var(--fg); border:1px solid var(--line) }
  .bar { display:flex; gap:10px; align-items:center; position:sticky; bottom:0; background:var(--bg); padding:14px 0; border-top:1px solid var(--line); margin-top:4px }
  .msg { font-size:13px } .bad { color:var(--bad) } .good { color:var(--good) }
  .seatlist { display:flex; gap:8px; flex-wrap:wrap } .seat { border:1px solid var(--line); border-radius:7px; padding:6px 10px; font-size:13px }
  .seat.off { opacity:.45 } .cn { display:flex; gap:10px; align-items:center; padding:9px 0; border-top:1px solid var(--line); flex-wrap:wrap }
</style></head><body><div class="wrap">
<h1>SCH-LOOP Roles</h1>
<p class="sub">Which CLI fills each seat, which model it uses, and what it spawns with. Saved to <code>.sch-loop/roles.json</code>.</p>
<div class="card"><h2>Installed</h2><div id="seats" class="seatlist">probing which CLIs are on PATH…</div></div>
<div id="roles"></div>
<div class="card"><h2>Council <span class="pill">gated: convened on a red ticket</span></h2><div id="council"></div></div>
<div class="bar"><button id="save">Save</button><button class="ghost" id="reload">Reload</button><span id="msg" class="msg"></span></div>
</div><script>
let S = null;
const $ = s => document.querySelector(s);
const el = (t, a = {}, kids = []) => { const n = document.createElement(t); for (const [k, v] of Object.entries(a)) { if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); } for (const c of [].concat(kids)) n.append(c); return n; };
const installed = () => S.seats.filter(s => s.available).map(s => s.provider);

// A seat configured for a CLI that is not installed must still SHOW that CLI. Listing only installed
// ones made the dropdown fall back to its first option, so the critic seat read "claude" while its argv
// said antigravity -- the page misreporting the very configuration it exists to show.
function providerOptions(current) {
  const names = [...new Set([...installed(), current].filter(Boolean))];
  return names.map(p => {
    const missing = !installed().includes(p);
    return el("option", p === current ? { value: p, selected: "selected" } : { value: p }, p + (missing ? " — not installed" : ""));
  });
}

function presetsFor(provider) { return Object.keys(S.presets[provider] || {}).filter(k => k !== "base" && k !== "model_arg"); }
function hasPreset(spawn, frag) { const j = spawn.join(" "); return frag.every(f => j.includes(f)); }
function togglePreset(seat, name, on) {
  const frag = S.presets[seat.provider]?.[name] || [];
  if (!frag.length) return;
  if (on) { if (!hasPreset(seat.spawn, frag)) seat.spawn = [...seat.spawn, ...frag]; }
  else { const j = seat.spawn.join("\\u0000"); seat.spawn = j.split(frag.join("\\u0000")).join("").split("\\u0000").filter(Boolean); }
}

function seatCard(key, seat, title, note) {
  const models = S.seats.find(s => s.provider === seat.provider)?.models || [];
  const provider = el("select", { onchange: e => { seat.provider = e.target.value; seat.spawn = [...(S.presets[seat.provider]?.base || [seat.provider])]; seat.model = null; render(); } },
    providerOptions(seat.provider));
  const model = el("select", { onchange: e => { seat.model = e.target.value || null; render(); } },
    [el("option", seat.model ? { value: "" } : { value: "", selected: "selected" }, "(provider default)"),
     ...models.map(m => el("option", m === seat.model ? { value: m, selected: "selected" } : { value: m }, m))]);
  const custom = el("input", { type: "text", value: seat.spawn.join(" "), onchange: e => { seat.spawn = e.target.value.trim().split(/\\s+/).filter(Boolean); render(); } });
  const flags = el("div", { class: "flags" }, presetsFor(seat.provider).map(name => {
    const on = hasPreset(seat.spawn, S.presets[seat.provider][name]);
    const cb = el("input", on ? { type: "checkbox", checked: "checked" } : { type: "checkbox" });
    cb.addEventListener("change", e => { togglePreset(seat, name, e.target.checked); render(); });
    return el("label", {}, [cb, name.replace(/_/g, " ")]);
  }));
  return el("div", { class: "card" }, [
    el("h2", {}, [title, el("span", { class: "pill" }, note)]),
    el("div", { class: "row" }, [
      el("div", {}, [el("label", {}, "CLI"), provider]),
      el("div", {}, [el("label", {}, "Model"), model]),
      el("div", { class: "grow" }, [el("label", {}, "Spawn argv"), custom]),
    ]),
    flags,
    el("div", { class: "argv" }, S.resolved[key] || ""),
  ]);
}

function render() {
  $("#seats").replaceChildren(...S.seats.map(s => el("div", { class: "seat" + (s.available ? "" : " off") }, s.provider + (s.available ? " ✓" : " — not installed"))));
  $("#roles").replaceChildren(
    seatCard("executor", S.roles.executor, "Executor", "writes code"),
    seatCard("reviewer", S.roles.reviewer, "Reviewer", "must be read-only"),
    seatCard("judge", S.roles.judge, "Judge", "must be read-only"));
  $("#council").replaceChildren(...S.roles.council.map((c, i) => {
    const on = el("input", c.enabled !== false ? { type: "checkbox", checked: "checked" } : { type: "checkbox" });
    on.addEventListener("change", e => { c.enabled = e.target.checked; render(); });
    const prov = el("select", { onchange: e => { c.provider = e.target.value; c.spawn = [...(S.presets[c.provider]?.base || [c.provider])]; c.model = null; render(); } },
      providerOptions(c.provider));
    const models = S.seats.find(s => s.provider === c.provider)?.models || [];
    const model = el("select", { onchange: e => { c.model = e.target.value || null; render(); } },
      [el("option", { value: "" }, "(default)"), ...models.map(m => el("option", m === c.model ? { value: m, selected: "selected" } : { value: m }, m))]);
    return el("div", { class: "cn" }, [on, el("strong", {}, c.role), prov, model, el("span", { class: "argv" }, S.resolved["council." + i] || "")]);
  }));
}

async function load() {
  $("#msg").className = "msg"; $("#msg").textContent = "loading…";
  try { S = await (await fetch("/api/state")).json(); render(); $("#msg").textContent = ""; }
  catch (e) { $("#msg").className = "msg bad"; $("#msg").textContent = "could not load: " + e.message; }
}
$("#reload").addEventListener("click", load);
$("#save").addEventListener("click", async () => {
  const r = await fetch("/api/roles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(S.roles) });
  const j = await r.json();
  const m = $("#msg");
  if (!r.ok) { m.className = "msg bad"; m.textContent = j.error; return; }
  S = j; render(); m.className = "msg good"; m.textContent = "Saved to .sch-loop/roles.json";
});
load();
</script></body></html>`;
