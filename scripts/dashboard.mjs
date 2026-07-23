#!/usr/bin/env node
// SCH Loop dashboard — one pane for all projects. Zero dependencies. Binds
// 0.0.0.0 so your Tailscale IP reaches it from any device. Root shows the
// project list (pick one); a project view shows its queues + scope + an inbox
// box. The loop for that project reads the inbox at the top of every pass.
//
//   node scripts/dashboard.mjs        # http://<tailscale-ip>:4600

import { createServer } from "node:http";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadRegistry, saveRegistry, loadState, getProject, event, saveState, OFFENSIVE } from "./state.mjs";

// Catalog of installed skills the operator can require for a project.
// Read once per request from ~/.claude/skills/<name>/SKILL.md frontmatter.
function skillCatalog() {
  const root = join(homedir(), ".claude", "skills");
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const f = join(root, name, "SKILL.md");
    if (!existsSync(f)) continue;
    let desc = "";
    try {
      const t = readFileSync(f, "utf8").slice(0, 1200);
      desc = (t.match(/^description:\s*(.+)$/m)?.[1] || "").slice(0, 140);
    } catch { /* ignore */ }
    out.push({ name, desc });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const PORT = process.env.SCH_PORT || 4600;
const json = (res, b) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };

// CSRF guard: state-changing POSTs (scope arm/halt, task, inbox) must originate
// from the dashboard itself. A cross-site page can auto-submit a form to our
// endpoints (even over Tailscale, via the user's own browser), so we reject any
// POST whose Origin/Referer host is not our own. Same-origin dashboard forms
// send a matching Origin, so the UI is unaffected. Also require a present
// Origin/Referer — a state change with neither is not a legitimate UI action.
function sameOrigin(req) {
  const host = req.headers.host;
  const src = req.headers.origin || req.headers.referer;
  if (!host || !src) return false;
  try { return new URL(src).host === host; } catch { return false; }
}
const forbid = (res) => { res.writeHead(403, { "content-type": "text/plain" }); res.end("forbidden: cross-origin request rejected"); };

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }

  // Every state-changing POST must be same-origin (CSRF protection).
  if (req.method === "POST" && !sameOrigin(req)) { forbid(res); return; }

  if (req.method === "POST" && url.pathname === "/inbox") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const project = params.get("project"); const text = (params.get("text") || "").trim();
      if (project && text && getProject(project)) {
        const s = loadState(project);
        s.inbox.unshift({ id: ++s.seq.inbox, text, status: "new", createdAt: new Date().toISOString() });
        event(s, `inbox +: ${text.slice(0, 60)}`); saveState(project, s);
      }
      res.writeHead(303, { location: project ? "/?project=" + encodeURIComponent(project) : "/" });
      res.end();
    });
    return;
  }
  // Task actions from the phone: requeue a blocked/stuck task, bump a queued
  // task to the front, or pause one. Whitelisted actions only.
  // Answer a blocked task's question straight from the dashboard: records the
  // answer on the task and requeues it at priority 1 so the loop resumes with it.
  if (req.method === "POST" && url.pathname === "/answer") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = new URLSearchParams(body);
      const project = p.get("project"), id = Number(p.get("id")), text = (p.get("text") || "").trim();
      if (getProject(project) && text) {
        const s = loadState(project); const t = s.tasks.find((x) => x.id === id);
        if (t) {
          t.answers = [...(t.answers || []), { text, ts: new Date().toISOString() }];
          t.status = "queued"; t.priority = 1; t.updatedAt = new Date().toISOString();
          event(s, `task #${id} answered from dashboard -> requeued (p1): ${text.slice(0, 80)}`);
          saveState(project, s);
        }
      }
      res.writeHead(303, { location: "/?project=" + encodeURIComponent(project) }); res.end();
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/task") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = new URLSearchParams(body);
      const project = p.get("project"), id = Number(p.get("id")), action = p.get("action");
      if (getProject(project)) {
        const s = loadState(project); const t = s.tasks.find((x) => x.id === id);
        if (t) {
          if (action === "requeue") t.status = "queued";
          else if (action === "bump") t.phase = 0;          // sort puts phase 0 first
          else if (action === "hold") t.status = "blocked";
          else if (action === "close") t.status = "superseded"; // replaced/decomposed — stop nagging
          t.updatedAt = new Date().toISOString();
          event(s, `dashboard: task #${id} ${action}`); saveState(project, s);
        }
      }
      res.writeHead(303, { location: "/?project=" + encodeURIComponent(project) }); res.end();
    });
    return;
  }
  // Scope actions from the phone: HALT/resume (always safe) and arm/disarm
  // authorization. HALT is the kill switch; the loop stops all active work.
  if (req.method === "POST" && url.pathname === "/scope") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = new URLSearchParams(body);
      const id = p.get("project"), action = p.get("action");
      const reg = loadRegistry(); const proj = reg.projects.find((x) => x.id === id);
      if (proj) {
        proj.scope = proj.scope || { authorized: false, targets: [], outOfScope: [], roe: "", ref: "", halt: false };
        if (action === "halt") proj.scope.halt = true;
        else if (action === "resume") proj.scope.halt = false;
        else if (action === "disarm") proj.scope.authorized = false;
        else if (action === "arm") proj.scope.authorized = true;
        saveRegistry(reg);
        const s = loadState(id); event(s, `dashboard: scope ${action}`); saveState(id, s);
      }
      res.writeHead(303, { location: "/?project=" + encodeURIComponent(id) }); res.end();
    });
    return;
  }
  // Save the project's required skills (checkbox picker).
  if (req.method === "POST" && url.pathname === "/skills") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = new URLSearchParams(body);
      const id = p.get("project");
      const reg = loadRegistry(); const proj = reg.projects.find((x) => x.id === id);
      if (proj) {
        proj.requiredSkills = p.getAll("skills").filter(Boolean);
        saveRegistry(reg);
        const s = loadState(id);
        event(s, `required skills set: ${proj.requiredSkills.join(", ") || "(none)"}`);
        saveState(id, s);
      }
      res.writeHead(303, { location: "/?project=" + encodeURIComponent(id) }); res.end();
    });
    return;
  }
  if (url.pathname === "/api/skills") return json(res, skillCatalog());
  if (url.pathname === "/api/projects") {
    // registry + a small per-project rollup for the picker
    const reg = loadRegistry();
    const rollup = reg.projects.map((p) => {
      const s = loadState(p.id);
      const c = (st) => s.tasks.filter((t) => t.status === st).length;
      const total = s.tasks.filter(t=>t.status!=="superseded").length, done = c("merged"), building = c("building"), review = c("review"), changes = c("changes"), queued = c("queued"), blocked = c("blocked"), stuck = c("stuck");
      const pending = queued, findings = (s.findings || []).length, inboxNew = s.inbox.filter((i) => i.status === "new").length;
      // project-level status category
      let status = "idle";
      if (total === 0) status = "new";
      else if (stuck || blocked) status = "attention";     // failed / awaiting
      else if (done === total) status = "completed";
      else if (building || review || changes) status = "active";
      else status = "inprogress";                          // queued work pending
      return { id: p.id, name: p.name, domain: p.domain, offensive: OFFENSIVE.has(p.domain), authorized: p.scope?.authorized ?? false, halt: p.scope?.halt ?? false,
        status, total, done, pending, building, review, blocked, stuck, findings, inboxNew,
        pct: total ? Math.round(done / total * 100) : 0 };
    });
    return json(res, rollup);
  }
  if (url.pathname === "/api/state") {
    const id = url.searchParams.get("project");
    const p = getProject(id);
    if (!p) return json(res, { error: "no such project" });
    return json(res, { project: p, state: loadState(id) });
  }
  if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); return; }
  res.writeHead(404); res.end("not found");
});

// Bind address. Default 0.0.0.0 (localhost + LAN + Tailscale). On an untrusted
// network (office / client / public wifi) set SCH_BIND to your Tailscale IP so
// the dashboard is reachable over the tailnet but NOT to the local LAN.
const BIND = process.env.SCH_BIND || "0.0.0.0";
server.listen(PORT, BIND, () => console.log(`SCH Loop dashboard on http://${BIND}:${PORT}  (Tailscale IP reaches it from any device)`));

// ---- UI: Tactical Telemetry (industrial-brutalist), responsive desktop + mobile ----
const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SCH·LOOP // OPS</title>
<style>
  :root{--bg:#0a0a0a;--panel:#101010;--line:#282828;--fg:#eaeaea;--dim:#7d7d7d;--red:#ff2a2a;--green:#4af626;}
  *{box-sizing:border-box}
  html{color-scheme:dark}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:13px/1.4 ui-monospace,"JetBrains Mono","IBM Plex Mono","Cascadia Code",Consolas,monospace;
    padding:clamp(12px,3vw,28px);-webkit-font-smoothing:antialiased}
  /* CRT scanlines — subtle, kept legible */
  body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:9;
    background:repeating-linear-gradient(0deg,transparent 0 2px,rgba(255,255,255,.02) 2px 3px)}
  .wrap{max-width:1240px;margin-inline:auto;position:relative;z-index:1}
  a{color:var(--fg);text-decoration:none}
  h1{font-family:"Archivo Black",Inter,system-ui,sans-serif;font-weight:900;text-transform:uppercase;
    letter-spacing:-.03em;line-height:.9;font-size:clamp(2rem,6vw,3.6rem);margin:6px 0 2px}
  h2{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--dim);
    margin:26px 0 0;padding:6px 0;border-top:1px solid var(--line);display:flex;justify-content:space-between}
  h2::before{content:"[ "}h2 .n::after{content:" ]"}
  .mono{font-variant-numeric:tabular-nums}
  /* top status strip */
  .bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;font-size:11px;letter-spacing:.1em;
    text-transform:uppercase;color:var(--dim);border-bottom:2px solid var(--red);padding-bottom:8px}
  .dot{width:8px;height:8px;background:var(--green);display:inline-block;margin-right:6px;animation:blink 1.6s step-end infinite}
  @keyframes blink{50%{opacity:.25}}
  .sub{color:var(--dim);text-transform:uppercase;letter-spacing:.1em;font-size:11px;margin:2px 0 16px}
  /* razor-grid: 1px dividers via gap over line-colored bg */
  .grid{display:grid;gap:1px;background:var(--line);border:1px solid var(--line)}
  .cards{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
  .kpis{grid-template-columns:repeat(auto-fit,minmax(84px,1fr))}
  .cell{background:var(--panel);padding:12px 14px}
  .cell.link{cursor:pointer;transition:background .12s}.cell.link:hover{background:#171717}
  .row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
  .id{color:var(--red);font-size:11px;letter-spacing:.06em}
  .ttl{font-weight:700}
  .meta{color:var(--dim);font-size:11px;margin-top:5px;letter-spacing:.04em;text-transform:uppercase}
  .kpi{background:var(--panel);padding:10px 12px}.kpi b{display:block;font-size:22px;font-weight:800;line-height:1}
  .kpi span{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.1em}
  .badge{font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:2px 6px;border:1px solid var(--line)}
  .badge::before{content:"["}.badge::after{content:"]"}
  .b-off{color:var(--red);border-color:var(--red)}.b-auth{color:var(--green);border-color:var(--green)}
  .b-halt{color:#fff;background:var(--red);border-color:var(--red)}
  .st-queued{color:var(--dim)}.st-building{color:#e3b341}.st-review{color:#58a6ff}.st-changes{color:#f0883e}
  .st-merged{color:var(--green)}.st-blocked{color:var(--red)}.st-stuck{color:var(--red)}
  .scope{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--red);
    padding:12px 14px;margin-bottom:12px;font-size:12px;line-height:1.7}
  .scope b{color:var(--red);letter-spacing:.1em}
  .fsev{font-size:10px;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;color:#fff;font-weight:700}
  .f-critical{background:#7c0000}.f-high{background:#ff2a2a}.f-medium{background:#e67e00}.f-low{background:#2a8f6b}.f-info{background:#777}
  .frow{display:flex;gap:8px;align-items:baseline;padding:7px 10px;border-bottom:1px solid var(--line);background:var(--panel)}
  .phase-strip{display:flex;flex-wrap:wrap;gap:1px;background:var(--line);border:1px solid var(--line);margin-bottom:4px}
  .pp{font-size:11px;padding:6px 10px;background:var(--panel);flex:1;min-width:130px;text-transform:uppercase;letter-spacing:.04em}
  .pp .d{display:inline-block;width:7px;height:7px;margin-right:6px}
  .pp.st-merged .d{background:var(--green)}.pp.st-building .d{background:#e3b341}.pp.st-review .d{background:#58a6ff}
  .pp.st-queued .d{background:var(--dim)}.pp.st-blocked .d,.pp.st-stuck .d{background:var(--red)}.pp.st-changes .d{background:#f0883e}
  .chips{display:flex;flex-wrap:wrap;gap:1px;background:var(--line);border:1px solid var(--line);margin-bottom:4px}
  .chip{background:var(--panel);padding:8px 11px;flex:1;min-width:82px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}
  .chip b{display:block;font-size:18px;color:var(--fg);line-height:1;margin-bottom:2px}
  .chip.st-building b{color:#e3b341}.chip.st-review b{color:#58a6ff}.chip.st-merged b{color:var(--green)}.chip.st-blocked b,.chip.st-stuck b{color:var(--red)}
  .tbl-wrap{overflow-x:auto;border:1px solid var(--line);margin-bottom:8px}
  table.tasks{width:100%;border-collapse:collapse;font-size:12px}
  table.tasks th{background:var(--panel);color:var(--dim);text-transform:uppercase;letter-spacing:.08em;font-size:10px;text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
  table.tasks td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  table.tasks tbody tr{border-left:3px solid transparent}
  table.tasks tr.st-building{border-left-color:#e3b341}table.tasks tr.st-review,table.tasks tr.st-changes{border-left-color:#58a6ff}
  table.tasks tr.st-merged{border-left-color:var(--green)}table.tasks tr.st-blocked,table.tasks tr.st-stuck{border-left-color:var(--red)}table.tasks tr.st-queued{border-left-color:var(--dim)}
  .st{font-size:10px;font-weight:700;letter-spacing:.06em;padding:2px 6px;border:1px solid var(--line);white-space:nowrap}
  .st.st-building{color:#e3b341}.st.st-review,.st.st-changes{color:#58a6ff}.st.st-merged{color:var(--green)}.st.st-blocked,.st.st-stuck{color:var(--red)}.st.st-queued{color:var(--dim)}
  td.ac{white-space:nowrap} td.ac .mini{padding:4px 8px}
  table.projects tbody tr{cursor:pointer}table.projects tbody tr:hover td{background:#171717}
  .st.ps-active{color:#e3b341}.st.ps-inprogress{color:#58a6ff}.st.ps-attention{color:var(--red)}.st.ps-completed{color:var(--green)}.st.ps-new,.st.ps-idle{color:var(--dim)}
  table.projects tr.ps-active{border-left-color:#e3b341}table.projects tr.ps-inprogress{border-left-color:#58a6ff}table.projects tr.ps-attention{border-left-color:var(--red)}table.projects tr.ps-completed{border-left-color:var(--green)}table.projects tr.ps-new,table.projects tr.ps-idle{border-left-color:var(--dim)}
  .chip.ps-active b{color:#e3b341}.chip.ps-inprogress b{color:#58a6ff}.chip.ps-attention b{color:var(--red)}.chip.ps-completed b{color:var(--green)}
  .bar2{display:inline-block;width:70px;height:8px;background:#222;border:1px solid var(--line);vertical-align:middle;margin-right:6px}
  .bar2 span{display:block;height:100%;background:var(--green)}
  .pctn{font-size:11px;color:var(--dim)}
  .in{background:var(--red);color:#fff;padding:1px 7px;font-weight:700;font-size:11px}
  .attn{border:1px solid var(--red);border-left:4px solid var(--red);background:rgba(255,42,42,.08);padding:10px 14px;margin-bottom:12px}
  .attn>b{color:var(--red);letter-spacing:.1em;display:block;margin-bottom:6px;font-size:12px}
  .attn-row{padding:5px 0;border-top:1px solid rgba(255,42,42,.25);font-size:12px;line-height:1.5}
  .attn-row:first-of-type{border-top:0}
  .attn-row .q{color:var(--fg);opacity:.85;margin:4px 0 8px;line-height:1.55}
  .ans{display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap}
  .ans input{flex:1;min-width:180px;font-family:inherit;font-size:14px;padding:8px 10px;background:var(--panel);color:var(--fg);border:1px solid var(--line)}
  .ans input:focus{outline:none;border-color:var(--green)}
  .ans button{font-family:inherit;padding:8px 14px;background:var(--green);color:#000;border:0;font-weight:700;font-size:11px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
  .skillbox{border:1px solid var(--line);background:var(--panel);padding:12px 14px;margin-bottom:8px}
  .sk-sel{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
  .sk-chip{background:var(--green);color:#000;font-size:10px;font-weight:700;padding:2px 8px;letter-spacing:.05em;text-transform:uppercase}
  .sk-search{width:100%;font-family:inherit;font-size:14px;padding:9px 11px;background:var(--bg);color:var(--fg);border:1px solid var(--line);margin-bottom:8px}
  .sk-search:focus{outline:none;border-color:var(--green)}
  .sk-list{max-height:260px;overflow-y:auto;border:1px solid var(--line);margin-bottom:8px}
  .sk-item{display:flex;align-items:baseline;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line);cursor:pointer;font-size:12px}
  .sk-item:hover{background:#171717}
  .sk-item input{accent-color:#4af626;flex:0 0 auto}
  .sk-n{font-weight:700;flex:0 0 auto}
  .sk-d{color:var(--dim);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sk-save{font-family:inherit;padding:9px 16px;background:var(--green);color:#000;border:0;font-weight:700;font-size:11px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
  .skl{margin-top:4px;display:flex;flex-wrap:wrap;gap:4px}
  .skl span{font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);border:1px solid var(--line);padding:1px 5px}
  @media(max-width:640px){
    table.tasks thead{position:absolute;left:-9999px}
    table.tasks tbody tr{display:block;border:1px solid var(--line);border-left-width:3px;margin-bottom:6px}
    table.tasks td{display:flex;justify-content:space-between;gap:12px;border:0;border-bottom:1px solid var(--line);padding:6px 10px}
    table.tasks td::before{content:attr(data-l);color:var(--dim);text-transform:uppercase;font-size:10px;letter-spacing:.06em;flex:0 0 auto}
    table.tasks td[data-l=""]{justify-content:flex-end}table.tasks td[data-l=""]::before{content:""}
  }
  .acts{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap}
  form.inl{display:inline;margin:0}
  .mini{font-family:inherit;padding:7px 12px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
    background:#181818;color:var(--fg);border:1px solid var(--line);cursor:pointer}
  .mini:hover{border-color:var(--fg)}.mini.danger{background:var(--red);border-color:var(--red);color:#fff}
  .mini.go{border-color:var(--green);color:var(--green)}
  .inbox-form{display:flex;gap:8px;margin:14px 0}
  .inbox-form input{flex:1;min-width:0;font-family:inherit;padding:11px 12px;background:var(--panel);color:var(--fg);
    border:1px solid var(--line);font-size:15px}
  .inbox-form input:focus{outline:none;border-color:var(--red)}
  .inbox-form button{font-family:inherit;padding:11px 18px;background:var(--red);color:#fff;border:0;
    font-weight:700;letter-spacing:.1em;text-transform:uppercase;font-size:13px;cursor:pointer}
  .empty{color:var(--dim);padding:12px 14px;border:1px dashed var(--line);text-transform:uppercase;font-size:11px;letter-spacing:.1em}
  .ev{color:var(--dim);font-size:11px;padding:4px 0;border-bottom:1px solid var(--line);letter-spacing:.03em}
  .ev b{color:var(--fg)}
  .back{display:inline-block;color:var(--red);text-transform:uppercase;letter-spacing:.1em;font-size:11px;margin-bottom:4px}
</style></head>
<body><div class="wrap"><div id="app">LOADING…</div></div>
<script>
const esc=(s)=>(s??"").replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const qp=(k)=>new URLSearchParams(location.search).get(k);
const OFFSET=new Set(["web-pentest","api-pentest","mobile-android","mobile-ios","red-team-external","red-team-internal","external-network","internal-network"]);const OFF=(d)=>OFFSET.has(d);
const clock=()=>new Date().toISOString().slice(0,19).replace("T"," ")+" UTC";

function pbadges(p){let b=[];if(p.offensive)b.push('<span class="badge b-off">offensive</span>');
  if(p.offensive)b.push(p.authorized?'<span class="badge b-auth">authorized</span>':'<span class="badge b-off">unauthorized</span>');
  if(p.halt)b.push('<span class="badge b-halt">halt</span>');return b.join(" ");}

const PSTAT={new:["NEW","ps-new"],inprogress:["IN PROGRESS","ps-inprogress"],active:["ACTIVE","ps-active"],attention:["FAILED / AWAITING","ps-attention"],completed:["COMPLETED","ps-completed"],idle:["IDLE","ps-idle"]};
const RANK={attention:0,active:1,inprogress:2,new:3,idle:4,completed:5};
async function projectList(){
  const ps=(await (await fetch("/api/projects")).json()).sort((a,b)=>(RANK[a.status]??9)-(RANK[b.status]??9)||a.name.localeCompare(b.name));
  const by=(cat)=>ps.filter(p=>p.status===cat).length;
  const chips=[["active",by("active"),"ps-active"],["in progress",by("inprogress"),"ps-inprogress"],["failed / awaiting",by("attention"),"ps-attention"],["completed",by("completed"),"ps-completed"],["new",by("new"),"ps-new"]]
    .map(([n,v,c])=>\`<div class="chip \${c}"><b class="mono">\${v}</b>\${n}</div>\`).join("");
  const rows=ps.length?ps.map((p,i)=>{const[lab,cl]=PSTAT[p.status]||[p.status,""];return \`<tr class="\${cl}" onclick="location.href='/?project=\${encodeURIComponent(p.id)}'">
    <td data-l="#" class="id">\${i+1}</td>
    <td data-l="Project"><strong>\${esc(p.name)}</strong> <span class="id">\${esc(p.domain)}</span>\${p.offensive&&p.halt?' <span class="badge b-halt">halt</span>':''}</td>
    <td data-l="Status"><span class="st \${cl}">\${lab}</span></td>
    <td data-l="Progress"><div class="bar2"><span style="width:\${p.pct}%"></span></div><span class="pctn">\${p.pct}%</span></td>
    <td data-l="Done">\${p.done}</td>
    <td data-l="Total">\${p.total}</td>
    <td data-l="Pending">\${p.pending}</td>
    <td data-l="Findings">\${p.findings}</td>
    <td data-l="Inbox">\${p.inboxNew?'<span class="in">'+p.inboxNew+'</span>':'0'}</td></tr>\`;}).join(""):'<tr><td colspan="9" class="empty">no projects — run /sch-spec to create one</td></tr>';
  document.getElementById("app").innerHTML=\`
    <div class="bar"><span><span class="dot"></span>online</span><span class="mono">\${clock()}</span><span>units // \${ps.length}</span></div>
    <h1>SCH·LOOP</h1><div class="sub">operations // all projects</div>
    <div class="chips">\${chips}</div>
    <div class="tbl-wrap"><table class="tasks projects"><thead><tr><th>#</th><th>Project</th><th>Status</th><th>Progress</th><th>Done</th><th>Total</th><th>Pending</th><th>Find</th><th>Inbox</th></tr></thead><tbody>\${rows}</tbody></table></div>\`;
}

function actForm(pid,id,action,label,cls){return \`<form class="inl" method="POST" action="/task">
  <input type="hidden" name="project" value="\${esc(pid)}"><input type="hidden" name="id" value="\${id}">
  <input type="hidden" name="action" value="\${action}"><button class="mini \${cls||''}">\${label}</button></form>\`;}

async function projectView(id){
  const r=await (await fetch("/api/state?project="+encodeURIComponent(id))).json();
  if(r.error){location.href="/";return;}
  const p=r.project,s=r.state,by=st=>s.tasks.filter(t=>t.status===st),sc=p.scope||{};
  const scForm=(action,label,cls)=>\`<form class="inl" method="POST" action="/scope">
    <input type="hidden" name="project" value="\${esc(id)}"><input type="hidden" name="action" value="\${action}"><button class="mini \${cls||''}">\${label}</button></form>\`;
  const scopeCtl=(sc.halt?scForm("resume","▶ resume","go"):scForm("halt","■ halt","danger"))+" "+(sc.authorized?scForm("disarm","disarm"):scForm("arm","arm auth","go"));
  const scopeBox=OFF(p.domain)?\`<div class="scope"><b>SCOPE //</b> \${sc.authorized?'authorized':'NOT authorized'}\${sc.halt?' · <span style="color:var(--red)">HALT SET</span>':''}<br>
    TARGETS: \${esc((sc.targets||[]).join(", "))||"(none)"}<br>OUT-OF-SCOPE: \${esc((sc.outOfScope||[]).join(", "))||"(none)"}<br>REF: \${esc(sc.ref)||"(none)"}
    <div class="acts">\${scopeCtl}</div></div>\`:"";
  const srank=(x)=>["critical","high","medium","low","info"].indexOf((x||"info").toLowerCase());
  const fsev=(x)=>({critical:"f-critical",high:"f-high",medium:"f-medium",low:"f-low"}[(x||"info").toLowerCase()]||"f-info");
  const finds=s.findings||[];
  const vfind=finds.filter(f=>f.status==="validated").sort((a,b)=>srank(a.severity)-srank(b.severity)||a.id-b.id);
  const cleanN=finds.filter(f=>f.status==="tested-clean").length;
  const findHtml=vfind.length?vfind.map(f=>\`<div class="frow"><span class="fsev \${fsev(f.severity)}">\${esc(f.severity||"info")}</span><strong>\${esc(f.title)}</strong> <span class="id">\${esc(f.category||"")}</span>\${(f.parents&&f.parents.length)?' <span class="id">⛓ from #'+f.parents.join(",#")+'</span>':''}\${f.target?' <span class="meta">'+esc(f.target)+'</span>':''}</div>\`).join(""):'<div class="empty">no validated findings yet</div>';
  // phase progress: tasks in phase order with a status dot — recon done? what's left?
  const phases=s.tasks.slice().sort((a,b)=>a.phase-b.phase||a.id-b.id);
  const phaseHtml=phases.length?phases.map(t=>\`<div class="pp st-\${t.status}"><span class="d"></span>P\${t.phase} \${esc(t.title)} · \${t.status}</div>\`).join(""):'<div class="empty">no phases planned yet</div>';
  const done=by("merged").length,total=s.tasks.filter(t=>t.status!=="superseded").length,pct=total?Math.round(done/total*100):0;
  // attention banner: surface tasks that need the operator (awaiting answer / failed)
  const attn=s.tasks.filter(t=>t.status==="blocked"||t.status==="stuck");
  const attHtml=attn.length?\`<div class="attn"><b>⚠ NEEDS YOU — \${attn.length} task(s) awaiting / failed</b>\${attn.map(t=>\`<div class="attn-row">
      <div><span class="st st-\${t.status}">\${t.status==="blocked"?"AWAITING":"FAILED"}</span> <strong>\${esc(t.title)}</strong></div>
      <div class="q">\${esc(t.notes||"(no detail — open the task)")}</div>
      <form class="ans" method="POST" action="/answer"><input type="hidden" name="project" value="\${esc(id)}"><input type="hidden" name="id" value="\${t.id}">
        <input type="text" name="text" placeholder="Answer this — task resumes at top of queue" autocomplete="off" required><button>Answer &amp; unblock</button></form>
      <form class="inl" method="POST" action="/task"><input type="hidden" name="project" value="\${esc(id)}"><input type="hidden" name="id" value="\${t.id}"><input type="hidden" name="action" value="close"><button class="mini">✕ close (superseded)</button></form>
    </div>\`).join("")}</div>\`:"";
  // status model → the five states the operator watches
  const STMAP={queued:["QUEUED","st-queued"],building:["ACTIVE","st-building"],review:["IN PROGRESS","st-review"],changes:["IN PROGRESS","st-changes"],merged:["COMPLETED","st-merged"],blocked:["AWAITING","st-blocked"],stuck:["FAILED","st-stuck"],superseded:["SUPERSEDED","st-superseded"]};
  const stL=(x)=>STMAP[x]||[String(x).toUpperCase(),""];
  const chips=[["active",by("building").length,"st-building"],["in progress",by("review").length+by("changes").length,"st-review"],["queued",by("queued").length,"st-queued"],["completed",done,"st-merged"],["awaiting",by("blocked").length,"st-blocked"],["failed",by("stuck").length,"st-stuck"],["findings",finds.length,""]]
    .map(([n,v,c])=>\`<div class="chip \${c}"><b class="mono">\${v}</b>\${n}</div>\`).join("");
  const rowActs=(t)=>t.status==="queued"?actForm(id,t.id,"bump","▲")+actForm(id,t.id,"hold","⏸"):(t.status==="blocked"||t.status==="stuck")?actForm(id,t.id,"requeue","↻","go"):"";
  const trows=s.tasks.slice().sort((a,b)=>(a.priority??3)-(b.priority??3)||a.phase-b.phase||a.id-b.id).map(t=>{const[lab,cl]=stL(t.status);return \`<tr class="\${cl}">
    <td data-l="#" class="id">\${t.id}</td>
    <td data-l="Task"><strong>\${esc(t.title)}</strong>\${t.active?' <span class="badge b-off">active</span>':''}\${(t.skills&&t.skills.length)?'<div class="skl">'+t.skills.map(x=>'<span>'+esc(x)+'</span>').join("")+'</div>':''}</td>
    <td data-l="Phase">P\${t.phase}</td>
    <td data-l="Pri">\${t.priority??3}</td>
    <td data-l="Status"><span class="st \${cl}">\${lab}</span></td>
    <td data-l="Target">\${esc(t.target||"—")}</td>
    <td data-l="Activity">\${esc(t.notes||t.branch||"—")}</td>
    <td data-l="" class="ac">\${rowActs(t)}</td></tr>\`;}).join("")||'<tr><td colspan="8" class="empty">no tasks planned yet</td></tr>';
  document.getElementById("app").innerHTML=\`
    <div class="bar"><span><span class="dot"></span>online</span><span class="mono">\${clock()}</span><a class="back" href="/">« all units</a></div>
    <h1>\${esc(p.name)}</h1><div class="sub">\${esc(p.domain)} · \${esc(p.path)||"no path"} \${pbadges({offensive:OFF(p.domain),authorized:sc.authorized,halt:sc.halt})}</div>
    \${attHtml}
    \${scopeBox}
    <div class="chips">\${chips}</div>
    <h2>phase progress<span class="n mono">\${pct}% done</span></h2>
    <div class="phase-strip">\${phaseHtml}</div>
    <form class="inbox-form" method="POST" action="/inbox"><input type="hidden" name="project" value="\${esc(id)}">
      <input type="text" name="text" placeholder="NEW LEAD / TASK — reasoned into the queue next pass" autocomplete="off" required><button>Add</button></form>
    \${s.inbox.filter(i=>i.status==="new").length?'<h2>inbox<span class="n mono">'+s.inbox.filter(i=>i.status==="new").length+'</span></h2><div>'+s.inbox.filter(i=>i.status==="new").map(i=>\`<div class="frow">\${esc(i.text)}</div>\`).join("")+'</div>':''}
    <h2>required skills<span class="n mono">\${(p.requiredSkills||[]).length} selected</span></h2>
    <div class="skillbox">
      <div class="sk-sel">\${(p.requiredSkills||[]).length?(p.requiredSkills).map(x=>'<span class="sk-chip">'+esc(x)+'</span>').join(""):'<span class="empty">none required — the loop may skip your design skills</span>'}</div>
      <input type="text" id="skq" class="sk-search" placeholder="Search skills… (type to filter)" autocomplete="off" oninput="filterSkills()">
      <form method="POST" action="/skills" id="skform"><input type="hidden" name="project" value="\${esc(id)}">
        <div class="sk-list" id="sklist">loading…</div>
        <button class="sk-save">Save required skills</button>
      </form>
    </div>
    <h2>tasks<span class="n mono">\${total}</span></h2>
    <div class="tbl-wrap"><table class="tasks"><thead><tr><th>#</th><th>Task</th><th>Phase</th><th>Pri</th><th>Status</th><th>Target</th><th>Activity</th><th></th></tr></thead><tbody>\${trows}</tbody></table></div>
    <h2>findings<span class="n mono">\${vfind.length}V / \${cleanN}C</span></h2>
    <div>\${findHtml}</div>
    <h2>activity<span class="n mono">\${s.events.length}</span></h2>
    <div>\${s.events.slice(0,25).map(e=>\`<div class="ev"><b class="mono">\${e.ts.slice(5,16).replace("T"," ")}</b> — \${esc(e.msg)}</div>\`).join("")||'<div class="empty">no activity</div>'}</div>\`;
}
// skill picker: catalog fetched once, rendered with checkboxes + live search
let SKILLS=null;
async function renderSkills(selected){
  const box=document.getElementById("sklist"); if(!box)return;
  if(!SKILLS){try{SKILLS=await (await fetch("/api/skills")).json();}catch{SKILLS=[];}}
  const sel=new Set(selected||[]);
  box.innerHTML=SKILLS.map(s=>\`<label class="sk-item" data-n="\${esc(s.name)} \${esc(s.desc).toLowerCase()}">
    <input type="checkbox" name="skills" value="\${esc(s.name)}"\${sel.has(s.name)?" checked":""}>
    <span class="sk-n">\${esc(s.name)}</span><span class="sk-d">\${esc(s.desc)}</span></label>\`).join("")
    ||'<div class="empty">no skills found in ~/.claude/skills</div>';
  filterSkills();
}
function filterSkills(){
  const q=(document.getElementById("skq")?.value||"").toLowerCase().trim();
  document.querySelectorAll("#sklist .sk-item").forEach(el=>{
    el.style.display=!q||el.dataset.n.includes(q)?"":"none";
  });
}
async function refresh(){
  // don't wipe the DOM while the user is typing in an input (the add-idea box)
  const ae=document.activeElement;
  if(ae&&(ae.tagName==="INPUT"||ae.tagName==="TEXTAREA"))return;
  const id=qp("project");
  if(id){await projectView(id);const pr=await (await fetch("/api/state?project="+encodeURIComponent(id))).json();renderSkills(pr.project?.requiredSkills||[]);}
  else await projectList();
}
refresh();setInterval(refresh,5000);
</script>
</body></html>`;
