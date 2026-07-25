#!/usr/bin/env node
// SCH Loop dashboard — LIVE (SSE), no-flicker, fluid. Zero dependencies.
// Server pushes state over Server-Sent Events whenever state.json changes; the
// client patches only the sections that changed and never touches a section you
// are typing in. Binds 0.0.0.0 (Tailscale). Set SCH_BIND to a Tailscale IP to
// hide it from the local LAN.

import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { loadRegistry, saveRegistry, loadState, getProject, event, saveState, OFFENSIVE } from "./state.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS_DIR = join(ROOT, "projects");
const REGISTRY = join(ROOT, "projects.json");
const PORT = process.env.SCH_PORT || 4600;
const BIND = process.env.SCH_BIND || "0.0.0.0";
const json = (res, b) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };

// ---- skill catalog (categorized) ----
const DESIGN = new Set(["impeccable", "taste-skill", "taste-skill-v1", "redesign-skill", "design-dna", "stitch-skill", "soft-skill", "minimalist-skill", "brutalist-skill", "brandkit", "image-to-code-skill", "gpt-tasteskill"]);
const categorize = (n) => n.startsWith("gsap-") || n === "motion-design" ? "Motion / GSAP" : n.startsWith("threejs-") ? "3D / Three.js" : n.startsWith("imagegen-") ? "Image generation" : DESIGN.has(n) ? "Design & UI" : "Other";
const CAT_ORDER = ["Design & UI", "Motion / GSAP", "Image generation", "3D / Three.js", "Other"];
function skillCatalog() {
  const root = join(homedir(), ".claude", "skills");
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith("sch-")) continue;
    const f = join(root, name, "SKILL.md");
    if (!existsSync(f)) continue;
    let desc = "";
    try { desc = (readFileSync(f, "utf8").slice(0, 1200).match(/^description:\s*(.+)$/m)?.[1] || "").slice(0, 130); } catch {}
    out.push({ name, desc, cat: categorize(name), legacy: name.endsWith("-v1") });
  }
  return out.sort((a, b) => CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat) || a.name.localeCompare(b.name));
}

// ---- data shapes pushed to clients ----
function rollup() {
  const reg = loadRegistry();
  return reg.projects.map((p) => {
    const s = loadState(p.id);
    const c = (st) => s.tasks.filter((t) => t.status === st).length;
    const total = s.tasks.filter((t) => t.status !== "superseded").length, done = c("merged");
    const status = total === 0 ? "new" : (c("stuck") || c("blocked")) ? "attention" : done === total ? "completed" : (c("building") || c("review") || c("changes")) ? "active" : "inprogress";
    return { id: p.id, name: p.name, domain: p.domain, offensive: OFFENSIVE.has(p.domain), authorized: p.scope?.authorized ?? false, halt: p.scope?.halt ?? false, status, total, done, pending: c("queued"), building: c("building"), review: c("review"), blocked: c("blocked"), stuck: c("stuck"), findings: (s.findings || []).length, inboxNew: s.inbox.filter((i) => i.status === "new").length, pct: total ? Math.round(done / total * 100) : 0 };
  });
}
const snapshot = (project) => project ? (getProject(project) ? { project: getProject(project), state: loadState(project) } : { error: "gone" }) : { projects: rollup() };

// ---- SSE ----
const clients = new Set();
const send = (c) => { try { c.res.write("data: " + JSON.stringify(snapshot(c.project)) + "\n\n"); } catch {} };
let deb;
const pushAll = () => { clearTimeout(deb); deb = setTimeout(() => clients.forEach(send), 200); };
try { watch(PROJECTS_DIR, { recursive: true }, pushAll); } catch {}
try { watch(REGISTRY, pushAll); } catch {}
setInterval(() => clients.forEach((c) => { try { c.res.write(": ping\n\n"); } catch {} }), 25000); // keep-alive

const sameOrigin = (req) => { const h = req.headers.host, s = req.headers.origin || req.headers.referer; if (!h || !s) return false; try { return new URL(s).host === h; } catch { return false; } };
const forbid = (res) => { res.writeHead(403); res.end("forbidden"); };
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(new URLSearchParams(b))); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }

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
    const back = (id) => { res.writeHead(303, { location: id ? "/?project=" + encodeURIComponent(id) : "/" }); res.end(); };
    if (url.pathname === "/inbox") {
      const project = p.get("project"), text = (p.get("text") || "").trim();
      if (project && text && getProject(project)) { const s = loadState(project); s.inbox.unshift({ id: ++s.seq.inbox, text, status: "new", createdAt: new Date().toISOString() }); event(s, `inbox +: ${text.slice(0, 60)}`); saveState(project, s); }
      return back(project);
    }
    if (url.pathname === "/answer") {
      const project = p.get("project"), id = Number(p.get("id")), text = (p.get("text") || "").trim();
      if (getProject(project) && text) { const s = loadState(project); const t = s.tasks.find((x) => x.id === id); if (t) { t.answers = [...(t.answers || []), { text, ts: new Date().toISOString() }]; t.status = "queued"; t.priority = 1; t.notes = "ANSWERED: " + text; t.updatedAt = new Date().toISOString(); event(s, `task #${id} answered -> requeued p1`); saveState(project, s); } }
      return back(project);
    }
    if (url.pathname === "/task") {
      const project = p.get("project"), id = Number(p.get("id")), action = p.get("action");
      if (getProject(project)) { const s = loadState(project); const t = s.tasks.find((x) => x.id === id); if (t) { if (action === "requeue") t.status = "queued"; else if (action === "bump") { t.phase = 0; t.priority = 1; } else if (action === "hold") t.status = "blocked"; else if (action === "close") t.status = "superseded"; t.updatedAt = new Date().toISOString(); event(s, `dashboard: task #${id} ${action}`); saveState(project, s); } }
      return back(project);
    }
    if (url.pathname === "/scope") {
      const id = p.get("project"), action = p.get("action"); const reg = loadRegistry(); const proj = reg.projects.find((x) => x.id === id);
      if (proj) { proj.scope = proj.scope || { targets: [], outOfScope: [], halt: false }; if (action === "halt") proj.scope.halt = true; else if (action === "resume") proj.scope.halt = false; else if (action === "disarm") proj.scope.authorized = false; else if (action === "arm") proj.scope.authorized = true; saveRegistry(reg); const s = loadState(id); event(s, `dashboard: scope ${action}`); saveState(id, s); }
      return back(id);
    }
    if (url.pathname === "/skills") {
      const id = p.get("project"); const reg = loadRegistry(); const proj = reg.projects.find((x) => x.id === id);
      if (proj) { proj.requiredSkills = p.getAll("skills").filter(Boolean); saveRegistry(reg); const s = loadState(id); event(s, `required skills: ${proj.requiredSkills.join(", ") || "(none)"}`); saveState(id, s); }
      return back(id);
    }
    return forbid(res);
  }

  if (url.pathname === "/api/skills") return json(res, skillCatalog());
  if (url.pathname === "/api/projects") return json(res, rollup());
  if (url.pathname === "/api/state") { const s = snapshot(url.searchParams.get("project")); return json(res, s); }
  if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); return; }
  res.writeHead(404); res.end("not found");
});
server.listen(PORT, BIND, () => console.log(`SCH Loop dashboard (live) on http://${BIND}:${PORT}`));

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
  h1{font-family:"Archivo Black",Inter,system-ui,sans-serif;font-weight:900;text-transform:uppercase;letter-spacing:-.03em;line-height:.92;font-size:clamp(1.7rem,5vw,3.4rem);margin:.15em 0 .05em}
  h2{font-size:clamp(10px,1vw,12px);text-transform:uppercase;letter-spacing:.14em;color:var(--dim);margin:0;padding:10px 0 6px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  h2::before{content:"[ "}h2 .n{color:var(--dim)}h2 .n::after{content:" ]"}
  .mono{font-variant-numeric:tabular-nums}
  .bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);border-bottom:2px solid var(--red);padding-bottom:8px;margin-bottom:8px}
  .dot{width:8px;height:8px;background:var(--green);display:inline-block;margin-right:6px;animation:blink 1.6s step-end infinite}
  .live{color:var(--green)} .stale{color:var(--red)}
  @keyframes blink{50%{opacity:.25}}
  .sub{color:var(--dim);text-transform:uppercase;letter-spacing:.1em;font-size:11px;margin:0 0 12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
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
  .attn-row .q{opacity:.9;margin:5px 0 9px;line-height:1.55}
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
  /* uniform grid — equal cells, no ragged flex-wrap */
  .phase-strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1px;background:var(--line);border:1px solid var(--line)}
  .pp .t{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pp{font-size:11px;padding:7px 10px;background:var(--panel);text-transform:uppercase;letter-spacing:.03em;min-width:0}
  .pp .d{display:inline-block;width:7px;height:7px;margin-right:6px}
  .pp.st-merged .d,.pp.st-completed .d{background:var(--green)}.pp.st-building .d{background:var(--amber)}.pp.st-review .d,.pp.st-changes .d{background:var(--blue)}.pp.st-queued .d{background:var(--dim)}.pp.st-blocked .d,.pp.st-stuck .d{background:var(--red)}
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
  .bar2{display:inline-block;width:64px;height:8px;background:#222;border:1px solid var(--line);vertical-align:middle;margin-right:6px}.bar2 span{display:block;height:100%;background:var(--green)}
  .pctn{font-size:11px;color:var(--dim)}.in{background:var(--red);color:#fff;padding:1px 7px;font-weight:700;font-size:11px}
  table.projects tbody tr{cursor:pointer}table.projects tbody tr:hover td{background:#181818}
  .chips{display:flex;flex-wrap:wrap;gap:1px;background:var(--line);border:1px solid var(--line)}
  .chip{background:var(--panel);padding:8px 11px;flex:1;min-width:82px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}.chip b{display:block;font-size:clamp(15px,2vw,18px);color:var(--fg);line-height:1;margin-bottom:2px}
  .chip.active b{color:var(--amber)}.chip.inprogress b,.chip.review b{color:var(--blue)}.chip.completed b{color:var(--green)}.chip.attention b,.chip.awaiting b,.chip.failed b{color:var(--red)}
  /* collapsible skill picker */
  details.box{border:1px solid var(--line);background:var(--panel);margin-bottom:8px}
  details.box>summary{cursor:pointer;padding:9px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);user-select:none}
  details.box[open]>summary{color:var(--fg);border-bottom:1px solid var(--line)}
  .boxin{padding:12px 14px}
  .sk-chip{background:var(--green);color:#000;font-size:10px;font-weight:700;padding:2px 8px;letter-spacing:.05em;text-transform:uppercase}
  .sk-sel{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
  .sk-search{width:100%;font-family:inherit;font-size:14px;padding:9px 11px;background:var(--bg);color:var(--fg);border:1px solid var(--line);margin-bottom:8px}.sk-search:focus{outline:none;border-color:var(--green)}
  .sk-list{max-height:300px;overflow-y:auto;border:1px solid var(--line);margin-bottom:8px}
  .sk-cat>summary{cursor:pointer;padding:7px 10px;background:#141414;font-size:11px;text-transform:uppercase;letter-spacing:.08em;display:flex;gap:8px;align-items:center}
  .sk-cn{font-weight:700;flex:1}.sk-cc{color:var(--dim)}
  .sk-all{font-family:inherit;font-size:9px;text-transform:uppercase;padding:2px 7px;background:#222;color:var(--fg);border:1px solid var(--line);cursor:pointer}.sk-all:hover{border-color:var(--green);color:var(--green)}
  .sk-item{display:flex;align-items:baseline;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line);cursor:pointer;font-size:12px}.sk-item:hover{background:#171717}
  .sk-item input{accent-color:#4af626}.sk-n{font-weight:700}.sk-d{color:var(--dim);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sk-lg{font-size:9px;color:var(--red);border:1px solid var(--red);padding:0 4px;margin-left:4px}
  .sk-save{font-family:inherit;padding:9px 16px;background:var(--green);color:#000;border:0;font-weight:700;font-size:11px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
  @media(max-width:640px){
    table.t thead{position:absolute;left:-9999px}
    table.t tbody tr{display:block;border:1px solid var(--line);border-left-width:3px;margin-bottom:6px}
    table.t td{display:flex;justify-content:space-between;gap:12px;border:0;border-bottom:1px solid var(--line);padding:6px 10px}
    table.t td::before{content:attr(data-l);color:var(--dim);text-transform:uppercase;font-size:10px;letter-spacing:.06em}
    table.t td[data-l=""]{justify-content:flex-end}table.t td[data-l=""]::before{content:""}
  }
</style></head>
<body><div class="wrap" id="app">connecting…</div>
<script>
const esc=(s)=>(s??"").toString().replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const qp=(k)=>new URLSearchParams(location.search).get(k);
const OFFSET=new Set(["web-pentest","api-pentest","mobile-android","mobile-ios","red-team-external","red-team-internal","external-network","internal-network"]);
const OFF=(d)=>OFFSET.has(d);
const clock=()=>new Date().toISOString().slice(0,19).replace("T"," ")+" UTC";
const STMAP={queued:["QUEUED","st-queued"],building:["ACTIVE","st-building"],review:["IN PROGRESS","st-review"],changes:["IN PROGRESS","st-changes"],merged:["COMPLETED","st-merged"],blocked:["AWAITING","st-blocked"],stuck:["FAILED","st-stuck"],superseded:["SUPERSEDED","st-superseded"]};
const PSTAT={new:["NEW","st-new"],inprogress:["IN PROGRESS","st-inprogress"],active:["ACTIVE","st-active"],attention:["FAILED / AWAITING","st-attention"],completed:["COMPLETED","st-completed"],idle:["IDLE","st-idle"]};
let SKILLS=null, taskFilter={q:"",status:"",showSuperseded:false};

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
function homeSkeleton(){
  document.getElementById("app").innerHTML=\`
    <div class="bar"><span><span class="dot"></span><span id="livemark" class="live">live</span></span><span class="mono" id="clk"></span><span id="ucount"></span></div>
    <h1>SCH·LOOP</h1><div class="sub">operations // all projects</div>
    <section id="pchips"></section>
    <section id="ptable"></section>\`;
  CACHE.pchips=CACHE.ptable=undefined;
}
function homeApply(ps){
  document.getElementById("clk").textContent=clock();
  document.getElementById("ucount").textContent="units // "+ps.length;
  const by=(c)=>ps.filter(p=>p.status===c).length;
  set("pchips",'<div class="chips">'+[["active",by("active"),"active"],["in progress",by("inprogress"),"inprogress"],["failed / awaiting",by("attention"),"attention"],["completed",by("completed"),"completed"],["new",by("new"),"new"]].map(([n,v,c])=>\`<div class="chip \${c}"><b class="mono">\${v}</b>\${n}</div>\`).join("")+'</div>');
  const RANK={attention:0,active:1,inprogress:2,new:3,idle:4,completed:5};
  const rows=ps.slice().sort((a,b)=>(RANK[a.status]??9)-(RANK[b.status]??9)||a.name.localeCompare(b.name)).map((p,i)=>{const[lab,cl]=PSTAT[p.status]||[p.status,""];return \`<tr class="\${cl}" onclick="location.href='/?project=\${encodeURIComponent(p.id)}'">
    <td data-l="#" class="id">\${i+1}</td>
    <td data-l="Project"><strong>\${esc(p.name)}</strong> <span class="id">\${esc(p.domain)}</span>\${p.offensive&&p.halt?' <span class="badge b-halt">halt</span>':''}</td>
    <td data-l="Status"><span class="st \${cl}">\${lab}</span></td>
    <td data-l="Progress"><div class="bar2"><span style="width:\${p.pct}%"></span></div><span class="pctn">\${p.pct}%</span></td>
    <td data-l="Done">\${p.done}</td><td data-l="Total">\${p.total}</td><td data-l="Pending">\${p.pending}</td><td data-l="Find">\${p.findings}</td>
    <td data-l="Inbox">\${p.inboxNew?'<span class="in">'+p.inboxNew+'</span>':'0'}</td></tr>\`;}).join("")||'<tr><td colspan="9" class="empty">no projects — run /sch-spec</td></tr>';
  set("ptable",'<div class="tbl-wrap"><table class="t projects"><thead><tr><th>#</th><th>Project</th><th>Status</th><th>Progress</th><th>Done</th><th>Total</th><th>Pending</th><th>Find</th><th>Inbox</th></tr></thead><tbody>'+rows+'</tbody></table></div>');
}

// ---------- PROJECT ----------
function projSkeleton(id){
  document.getElementById("app").innerHTML=\`
    <div class="bar"><a class="back" href="/">‹ ALL PROJECTS</a><span><span class="dot"></span><span id="livemark" class="live">live</span></span><span class="mono" id="clk"></span></div>
    <h1 id="pname">…</h1><div class="sub" id="pmeta"></div>
    <section id="attn"></section>
    <section id="scope"></section>
    <section id="chips"></section>
    <form class="row-form" method="POST" action="/inbox"><input type="hidden" name="project" value="\${esc(id)}"><input type="text" name="text" placeholder="NEW LEAD / TASK / FEATURE — reasoned into the queue next pass" autocomplete="off" required><button>Add</button></form>
    <section id="inboxsec"></section>
    <section id="phase"></section>
    <section id="tasksec"></section>
    <section id="findsec"></section>
    <details class="box"><summary>activity log</summary><div class="boxin"><section id="actsec"></section></div></details>\`;
  for(const k in CACHE)delete CACHE[k];
}
function actForm(pid,id,a,l,c){return \`<form class="inl" method="POST" action="/task"><input type="hidden" name="project" value="\${esc(pid)}"><input type="hidden" name="id" value="\${id}"><input type="hidden" name="action" value="\${a}"><button class="mini \${c||''}">\${l}</button></form>\`;}
function projApply(id,r){
  if(r.error){location.href="/";return;}
  const p=r.project,s=r.state,sc=p.scope||{},by=(st)=>s.tasks.filter(t=>t.status===st);
  document.getElementById("clk").textContent=clock();
  document.getElementById("pname").textContent=p.name;
  document.getElementById("pmeta").innerHTML=\`\${esc(p.domain)} · \${esc(p.path)||"no path"} \${OFF(p.domain)?(sc.authorized?'<span class="badge b-auth">authorized</span>':'<span class="badge b-off">unauthorized</span>'):''}\${sc.halt?' <span class="badge b-halt">halt</span>':''}\`;
  // attention
  const attn=s.tasks.filter(t=>t.status==="blocked"||t.status==="stuck");
  var attnHtml="";
  if(attn.length){
    attnHtml='<div class="attn"><b>&#9888; NEEDS YOU — '+attn.length+' task(s)</b>';
    for(const t of attn){
      attnHtml+='<div class="attn-row"><div><span class="st st-'+t.status+'">'+(t.status==="blocked"?"AWAITING":"FAILED")+'</span> <span class="id">TASK #'+t.id+'</span> <strong>'+esc(t.title)+'</strong></div><div class="q">'+esc(t.notes||"(open the task)")+'</div>'+
        '<form class="ans" method="POST" action="/answer"><input type="hidden" name="project" value="'+esc(id)+'"><input type="hidden" name="id" value="'+t.id+'"><input type="text" name="text" placeholder="Answer — task resumes at top" autocomplete="off" required><button>Answer &amp; unblock</button></form>'+
        actForm(id,t.id,"close","&#10005; close (superseded)")+'</div>';
    }
    attnHtml+='</div>';
  }
  set("attn",attnHtml);
  // scope
  const scForm=(a,l,c)=>\`<form class="inl" method="POST" action="/scope"><input type="hidden" name="project" value="\${esc(id)}"><input type="hidden" name="action" value="\${a}"><button class="mini \${c||''}">\${l}</button></form>\`;
  set("scope",OFF(p.domain)?\`<div class="scope"><b>SCOPE //</b> \${sc.authorized?'authorized':'NOT authorized'}\${sc.halt?' · <span style="color:var(--red)">HALT</span>':''}<br>TARGETS: \${esc((sc.targets||[]).join(", "))||"(none)"}<br>REF: \${esc(sc.ref)||"(none)"}\${sc.expiry?' · EXPIRES '+esc(sc.expiry):''}<div class="acts">\${sc.halt?scForm("resume","▶ resume","go"):scForm("halt","■ halt","danger")} \${sc.authorized?scForm("disarm","disarm"):scForm("arm","arm","go")}</div></div>\`:"");
  // chips
  const done=by("merged").length,total=s.tasks.filter(t=>t.status!=="superseded").length,pct=total?Math.round(done/total*100):0;
  const finds=s.findings||[];
  set("chips",'<div class="chips">'+[["active",by("building").length,"active"],["in progress",by("review").length+by("changes").length,"inprogress"],["queued",by("queued").length,""],["completed",done,"completed"],["awaiting",by("blocked").length,"awaiting"],["failed",by("stuck").length,"failed"],["findings",finds.length,""]].map(([n,v,c])=>\`<div class="chip \${c}"><b class="mono">\${v}</b>\${n}</div>\`).join("")+'</div>');
  // phase strip
  const ph=s.tasks.slice().sort((a,b)=>a.phase-b.phase||a.id-b.id);
  set("phase",'<h2>phase progress<span class="n mono">'+pct+'% done</span></h2><div class="phase-strip">'+(ph.length?ph.map(t=>\`<div class="pp st-\${t.status}" title="\${esc(t.title)} · \${t.status}"><span class="t"><span class="d"></span>P\${t.phase} \${esc(t.title)}</span><span class="t" style="opacity:.6;padding-left:13px">\${t.status}</span></div>\`).join(""):'<div class="empty">no phases</div>')+'</div>');
  // tasks
  const stL=(x)=>STMAP[x]||[x.toUpperCase(),""];
  const rowActs=(t)=>t.status==="queued"?actForm(id,t.id,"bump","▲")+actForm(id,t.id,"hold","⏸"):(t.status==="blocked"||t.status==="stuck")?actForm(id,t.id,"requeue","↻","go"):"";
  let ts=s.tasks.slice().sort((a,b)=>(a.priority??3)-(b.priority??3)||a.phase-b.phase||a.id-b.id);
  // superseded = replaced by smaller/other tasks; hidden unless explicitly shown
  if(!taskFilter.showSuperseded && taskFilter.status!=="superseded")ts=ts.filter(t=>t.status!=="superseded");
  if(taskFilter.status)ts=ts.filter(t=>t.status===taskFilter.status);
  if(taskFilter.q){const q=taskFilter.q.toLowerCase();ts=ts.filter(t=>(t.title+" "+(t.notes||"")+" P"+t.phase).toLowerCase().includes(q));}
  const trows=ts.map(t=>{const[lab,cl]=stL(t.status);return \`<tr class="\${cl}"><td data-l="#" class="id">\${t.id}</td>
    <td data-l="Task"><strong>\${esc(t.title)}</strong>\${t.active?' <span class="badge b-off">active</span>':''}\${(t.skills&&t.skills.length)?'<div class="skl">'+t.skills.map(x=>'<span>'+esc(x)+'</span>').join("")+'</div>':''}</td>
    <td data-l="Phase">P\${t.phase}</td><td data-l="Pri">\${t.priority??3}</td>
    <td data-l="Status"><span class="st \${cl}">\${lab}</span></td>
    <td data-l="Target">\${esc(t.target||"—")}</td>
    <td data-l="Activity">\${esc(t.notes||t.branch||"—")}</td>
    <td data-l="" class="ac">\${rowActs(t)}</td></tr>\`;}).join("")||'<tr><td colspan="8" class="empty">no tasks match</td></tr>';
  const statuses=["","queued","building","review","changes","blocked","stuck","merged","superseded"];
  const supN=s.tasks.filter(t=>t.status==="superseded").length;
  set("tasksec",'<h2>tasks<span class="n mono">'+ts.length+' shown / '+total+'</span></h2>'+
    '<div class="toolbar"><input id="tq" placeholder="filter tasks…" value="'+esc(taskFilter.q)+'" oninput="taskFilter.q=this.value;reapplyTasks()">'+
    '<select id="ts" onchange="taskFilter.status=this.value;reapplyTasks()">'+statuses.map(x=>'<option value="'+x+'"'+(x===taskFilter.status?' selected':'')+'>'+(x?x:'all statuses')+'</option>').join("")+'</select>'+
    (supN?'<button class="mini" onclick="taskFilter.showSuperseded=!taskFilter.showSuperseded;reapplyTasks()">'+(taskFilter.showSuperseded?'hide':'show')+' superseded ('+supN+')</button>':'')+'</div>'+
    '<div class="tbl-wrap"><table class="t"><thead><tr><th>#</th><th>Task</th><th>Phase</th><th>Pri</th><th>Status</th><th>Target</th><th>Activity</th><th></th></tr></thead><tbody>'+trows+'</tbody></table></div>');
  // findings
  const srank=(x)=>["critical","high","medium","low","info"].indexOf((x||"info").toLowerCase());
  const fsev=(x)=>({critical:"f-critical",high:"f-high",medium:"f-medium",low:"f-low"}[(x||"info").toLowerCase()]||"f-info");
  const vf=finds.filter(f=>f.status==="validated").sort((a,b)=>srank(a.severity)-srank(b.severity)||a.id-b.id);
  const cn=finds.filter(f=>f.status==="tested-clean").length;
  // findings are a pentest concept — never shown on a dev/tool project
  set("findsec",!OFF(p.domain)?"":'<h2>findings<span class="n mono">'+vf.length+'V / '+cn+'C</span></h2>'+(vf.length?vf.map(f=>\`<div class="frow"><span class="fsev \${fsev(f.severity)}">\${esc(f.severity||"info")}</span><strong>\${esc(f.title)}</strong> <span class="id">\${esc(f.category||"")}</span>\${(f.parents&&f.parents.length)?' <span class="id">⛓ #'+f.parents.join(",#")+'</span>':''}\${f.target?' <span class="pctn">'+esc(f.target)+'</span>':''}</div>\`).join(""):'<div class="empty">no validated findings yet</div>'));
  // inbox + activity
  const nb=s.inbox.filter(i=>i.status==="new");
  set("inboxsec",nb.length?'<h2>inbox<span class="n mono">'+nb.length+'</span></h2>'+nb.map(i=>\`<div class="frow">\${esc(i.text)}</div>\`).join(""):"");
  set("actsec",'<h2>activity<span class="n mono">'+s.events.length+'</span></h2>'+(s.events.slice(0,25).map(e=>\`<div class="ev"><b class="mono">\${e.ts.slice(5,16).replace("T"," ")}</b> — \${esc(e.msg)}</div>\`).join("")||'<div class="empty">no activity</div>'));
  // keep skill picker selection in sync (only when not focused)
}
function reapplyTasks(){ if(LAST&&LAST.project)projApply(qp("project"),LAST); }

// skills picker — plain string concat (no nested templates) + event delegation

// ---- live stream (SSE) + graceful fallback ----
let LAST=null, curProject=null, es=null;
function connect(){
  const pj=qp("project"); curProject=pj;
  if(pj)projSkeleton(pj); else homeSkeleton();
  const url="/events"+(pj?"?project="+encodeURIComponent(pj):"");
  es=new EventSource(url);
  es.onmessage=(m)=>{try{const d=JSON.parse(m.data);LAST=d;apply(d);mark(true);}catch{}};
  es.onerror=()=>{mark(false);};
}
function apply(d){ if(d.projects)homeApply(d.projects); else projApply(curProject,d); }
function mark(ok){const el=document.getElementById("livemark");if(el){el.textContent=ok?"live":"reconnecting…";el.className=ok?"live":"stale";}}
setInterval(()=>{const el=document.getElementById("clk");if(el)el.textContent=clock();},1000);
connect();
</script>
</body></html>`;
