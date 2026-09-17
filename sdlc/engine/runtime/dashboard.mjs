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
  return { seats, roles, resolved, presets: PRESETS, projectRoot };
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

// The page, in the SCH-LOOP console language: near-black ground, red as the structural accent,
// terminal green for "this is live and good", monospace throughout, scanlines, bracketed labels.
// Lifted from the v2 operations dashboard so the two look like one product rather than two.
const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>SCH·LOOP // ROLES</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap">
<style>
  :root{color-scheme:dark;--bg:#0a0a0a;--panel:#121212;--panel2:#171717;--line:#282828;--fg:#eaeaea;--dim:#7d7d7d;--red:#ff2a2a;--green:#4af626;--amber:#e3b341;--blue:#58a6ff;}
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--fg);font:clamp(12px,1vw,14px)/1.5 ui-monospace,"JetBrains Mono","Cascadia Code",Consolas,monospace}
  body{padding:max(env(safe-area-inset-top),clamp(12px,2.2vw,28px)) clamp(12px,2.2vw,28px) 96px}
  /* the room is lit by a screen */
  body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:9;background:repeating-linear-gradient(0deg,transparent 0 2px,rgba(255,255,255,.015) 2px 3px)}
  .wrap{width:100%;max-width:min(1200px,100%);margin-inline:auto;position:relative;z-index:1}

  h1{font-family:"Archivo Black",Inter,system-ui,sans-serif;font-weight:900;text-transform:uppercase;letter-spacing:-.03em;line-height:.92;font-size:clamp(1.7rem,5vw,3.4rem);margin:0 0 .08em}
  h2{font-size:clamp(10px,1vw,12px);text-transform:uppercase;letter-spacing:.14em;color:var(--dim);margin:0;padding:10px 0 6px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  h2::before{content:"[ "}h2 .n{color:var(--dim)}h2 .n::after{content:" ]"}
  .bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);border-bottom:2px solid var(--red);padding-bottom:9px;margin-bottom:22px}
  .dot{width:8px;height:8px;background:var(--green);display:inline-block;margin-right:6px;animation:blink 1.6s step-end infinite}
  @keyframes blink{50%{opacity:.25}}
  .sub{color:var(--dim);text-transform:uppercase;letter-spacing:.1em;font-size:11px;margin:0 0 22px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .sub code{color:var(--fg)}

  /* hairline grid: 1px gaps over the line colour, the v2 card idiom */
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
  .seat>.body{padding:12px 14px}

  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
  .fld{display:flex;flex-direction:column;gap:5px;min-width:0}
  .fld>label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
  .fld.grow{flex:1 1 320px}
  select,input[type=text]{font-family:inherit;font-size:12px;padding:8px 10px;background:var(--bg);color:var(--fg);border:1px solid var(--line);min-width:170px}
  input[type=text]{width:100%}
  select:focus,input:focus{outline:none;border-color:var(--red)}

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

  .actions{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;gap:10px;align-items:center;
           padding:12px clamp(12px,2.2vw,28px);background:var(--bg);border-top:2px solid var(--red)}
  button{font-family:inherit;padding:10px 18px;border:0;font-weight:700;font-size:11px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}
  button.save{background:var(--green);color:#000}
  button.ghost{background:var(--panel2);color:var(--fg);border:1px solid var(--line)}
  button.ghost:hover{border-color:var(--fg)}
  .msg{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
  .msg.bad{color:var(--red)} .msg.good{color:var(--green)}
  .empty{color:var(--dim);padding:12px 14px;border:1px dashed var(--line);text-transform:uppercase;font-size:11px;letter-spacing:.1em}
</style></head><body><div class="wrap">

<div class="bar"><span><span class="dot"></span><span style="color:var(--green)">roles</span></span><span id="where"></span></div>
<h1>SCH·LOOP</h1>
<div class="sub">seats // which CLI, which model, which flags &nbsp;·&nbsp; writes <code>.sch-loop/roles.json</code></div>

<h2>Installed<span class="n" id="nseats"></span></h2>
<div class="seats" id="seats"><span class="empty">probing PATH…</span></div>

<div id="roles"></div>

<h2>Council<span class="n">gated · convened on a red ticket</span></h2>
<div class="seat" id="council"></div>

</div>
<div class="actions"><button class="save" id="save">Save</button><button class="ghost" id="reload">Reload</button><span id="msg" class="msg"></span></div>
<script>
let S = null;
const $ = s => document.querySelector(s);
const el = (t, a = {}, kids = []) => { const n = document.createElement(t); for (const [k, v] of Object.entries(a)) { if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else if (v !== false && v != null) n.setAttribute(k, v); } for (const c of [].concat(kids)) if (c != null) n.append(c); return n; };
const installed = () => S.seats.filter(s => s.available).map(s => s.provider);

// A seat set to a CLI that is not installed must still SHOW that CLI. Listing only installed ones made
// the dropdown fall back to its first option, so a seat read "claude" while its argv said something else.
function providerOptions(current) {
  const names = [...new Set([...installed(), current].filter(Boolean))];
  return names.map(p => el("option", p === current ? { value: p, selected: "selected" } : { value: p }, p + (installed().includes(p) ? "" : " — not installed")));
}
const presetsFor = p => Object.keys(S.presets[p] || {}).filter(k => k !== "base" && k !== "model_arg");
const hasPreset = (spawn, frag) => { const j = spawn.join(" "); return frag.every(f => j.includes(f)); };
function togglePreset(seat, name, on) {
  const frag = S.presets[seat.provider]?.[name] || [];
  if (!frag.length) return;
  if (on) { if (!hasPreset(seat.spawn, frag)) seat.spawn = [...seat.spawn, ...frag]; }
  else { const j = seat.spawn.join("\\u0000"); seat.spawn = j.split(frag.join("\\u0000")).join("").split("\\u0000").filter(Boolean); }
}

function seatCard(key, seat, title, note, locked) {
  const models = S.seats.find(s => s.provider === seat.provider)?.models || [];
  const argv = S.resolved[key] || "";
  return el("div", { class: "seat" + (locked ? " locked" : "") }, [
    el("header", {}, [el("b", {}, title), el("span", { class: "tag" + (locked ? " must" : "") }, note)]),
    el("div", { class: "body" }, [
      el("div", { class: "row" }, [
        el("div", { class: "fld" }, [el("label", {}, "CLI"),
          el("select", { onchange: e => { seat.provider = e.target.value; seat.spawn = [...(S.presets[seat.provider]?.base || [seat.provider])]; seat.model = null; render(); } }, providerOptions(seat.provider))]),
        el("div", { class: "fld" }, [el("label", {}, "Model"),
          el("select", { onchange: e => { seat.model = e.target.value || null; render(); } },
            [el("option", seat.model ? { value: "" } : { value: "", selected: "selected" }, "provider default"),
             ...models.map(m => el("option", m === seat.model ? { value: m, selected: "selected" } : { value: m }, m))])]),
        el("div", { class: "fld grow" }, [el("label", {}, "Spawn argv"),
          el("input", { type: "text", value: seat.spawn.join(" "), onchange: e => { seat.spawn = e.target.value.trim().split(/\\s+/).filter(Boolean); render(); } })]),
      ]),
      el("div", { class: "flags" }, presetsFor(seat.provider).map(name => {
        const on = hasPreset(seat.spawn, S.presets[seat.provider][name]);
        const cb = el("input", on ? { type: "checkbox", checked: "checked" } : { type: "checkbox" });
        cb.addEventListener("change", e => { togglePreset(seat, name, e.target.checked); render(); });
        return el("label", { class: "flag" }, [cb, name.replace(/_/g, " ")]);
      })),
      el("div", { class: "argv" + (/^unresolvable/.test(argv) ? " bad" : "") }, argv),
    ]),
  ]);
}

function render() {
  $("#where").textContent = S.projectRoot || "";
  $("#nseats").textContent = installed().length + " of " + S.seats.length;
  $("#seats").replaceChildren(...S.seats.map(s => el("span", { class: "cli " + (s.available ? "on" : "off") }, s.provider + (s.available ? " ✓" : ""))));
  $("#roles").replaceChildren(
    seatCard("executor", S.roles.executor, "Executor", "writes code", false),
    seatCard("reviewer", S.roles.reviewer, "Reviewer", "must be read-only", true),
    seatCard("judge", S.roles.judge, "Judge", "must be read-only", true));
  $("#council").replaceChildren(...S.roles.council.map((c, i) => {
    const on = el("input", c.enabled !== false ? { type: "checkbox", checked: "checked" } : { type: "checkbox" });
    on.addEventListener("change", e => { c.enabled = e.target.checked; render(); });
    const models = S.seats.find(s => s.provider === c.provider)?.models || [];
    return el("div", { class: "cn" + (c.enabled === false ? " off" : "") }, [
      el("label", { class: "flag" }, [on, "seat"]),
      el("b", {}, c.role),
      el("select", { onchange: e => { c.provider = e.target.value; c.spawn = [...(S.presets[c.provider]?.base || [c.provider])]; c.model = null; render(); } }, providerOptions(c.provider)),
      el("select", { onchange: e => { c.model = e.target.value || null; render(); } },
        [el("option", { value: "" }, "default"), ...models.map(m => el("option", m === c.model ? { value: m, selected: "selected" } : { value: m }, m))]),
      el("span", { class: "argv" }, S.resolved["council." + i] || ""),
    ]);
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
  S = j; render(); m.className = "msg good"; m.textContent = "saved to .sch-loop/roles.json";
});
load();
</script></body></html>`;
