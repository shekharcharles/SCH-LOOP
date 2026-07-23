#!/usr/bin/env node
// SCH Loop dashboard — one pane for all projects. Zero dependencies. Binds
// 0.0.0.0 so your Tailscale IP reaches it from any device. Root shows the
// project list (pick one); a project view shows its queues + scope + an inbox
// box. The loop for that project reads the inbox at the top of every pass.
//
//   node scripts/dashboard.mjs        # http://<tailscale-ip>:4600

import { createServer } from "node:http";
import { loadRegistry, saveRegistry, loadState, getProject, event, saveState, OFFENSIVE } from "./state.mjs";

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
  if (url.pathname === "/api/projects") {
    // registry + a small per-project rollup for the picker
    const reg = loadRegistry();
    const rollup = reg.projects.map((p) => {
      const s = loadState(p.id);
      const c = (st) => s.tasks.filter((t) => t.status === st).length;
      return { id: p.id, name: p.name, domain: p.domain, offensive: OFFENSIVE.has(p.domain), authorized: p.scope?.authorized ?? false, halt: p.scope?.halt ?? false, queued: c("queued"), building: c("building"), review: c("review"), done: c("merged"), inboxNew: s.inbox.filter((i) => i.status === "new").length };
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

server.listen(PORT, "0.0.0.0", () => console.log(`SCH Loop dashboard on http://0.0.0.0:${PORT}  (reach it at your Tailscale IP)`));

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

async function projectList(){
  const ps=await (await fetch("/api/projects")).json();
  const cards=ps.length?ps.map(p=>\`<a class="cell link" href="/?project=\${encodeURIComponent(p.id)}">
    <div class="row"><span class="ttl">\${esc(p.name)}</span> <span class="id">\${esc(p.domain)}</span></div>
    <div style="margin:8px 0 6px">\${pbadges(p)}</div>
    <div class="meta">Q:\${p.queued} · BUILD:\${p.building} · REVIEW:\${p.review} · DONE:\${p.done} · INBOX:\${p.inboxNew}</div></a>\`).join(""):'<div class="empty">no projects — run /sch-spec</div>';
  document.getElementById("app").innerHTML=\`
    <div class="bar"><span><span class="dot"></span>online</span><span class="mono">\${clock()}</span><span>units // \${ps.length}</span></div>
    <h1>SCH·LOOP</h1><div class="sub">operations // select unit</div>
    <div class="grid cards">\${cards}</div>\`;
}

function actForm(pid,id,action,label,cls){return \`<form class="inl" method="POST" action="/task">
  <input type="hidden" name="project" value="\${esc(pid)}"><input type="hidden" name="id" value="\${id}">
  <input type="hidden" name="action" value="\${action}"><button class="mini \${cls||''}">\${label}</button></form>\`;}
function taskCard(t,pid){
  let acts="";
  if(t.status==="queued")acts=actForm(pid,t.id,"bump","▲ bump")+actForm(pid,t.id,"hold","⏸ hold");
  else if(t.status==="blocked"||t.status==="stuck")acts=actForm(pid,t.id,"requeue","↻ requeue","go");
  return \`<div class="cell"><div class="row"><span class="id">UNIT/\${t.id}</span>
    <span class="badge st-\${t.status}">\${t.status}</span><span class="ttl">\${esc(t.title)}</span>\${t.active?' <span class="badge b-off">active</span>':''}</div>
    <div class="meta">PH:\${t.phase}\${t.target?" · "+esc(t.target):""} · \${t.ac.length} OBJ\${t.branch?" · "+esc(t.branch):""} · SRC:\${t.source}</div>\${acts?'<div class="acts">'+acts+'</div>':''}</div>\`;
}
function lane(title,arr,render,em){return \`<h2>\${title}<span class="n mono">\${arr.length}</span></h2>\${arr.length?'<div class="grid cards">'+arr.map(render).join("")+'</div>':'<div class="empty">'+em+'</div>'}\`;}

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
  const kpi=[["queue",by("queued").length],["build",by("building").length],["review",by("review").length],["done",by("merged").length],["inbox",s.inbox.filter(i=>i.status==="new").length]]
    .map(([n,v])=>\`<div class="kpi"><b class="mono">\${v}</b><span>\${n}</span></div>\`).join("");
  document.getElementById("app").innerHTML=\`
    <div class="bar"><span><span class="dot"></span>online</span><span class="mono">\${clock()}</span><a class="back" href="/">« all units</a></div>
    <h1>\${esc(p.name)}</h1><div class="sub">\${esc(p.domain)} · \${esc(p.path)||"no path"} \${pbadges({offensive:OFF(p.domain),authorized:sc.authorized,halt:sc.halt})}</div>
    \${scopeBox}
    <div class="grid kpis">\${kpi}</div>
    <form class="inbox-form" method="POST" action="/inbox"><input type="hidden" name="project" value="\${esc(id)}">
      <input type="text" name="text" placeholder="NEW IDEA / FEATURE / LEAD — planned next pass" autocomplete="off" required><button>Add</button></form>
    \${lane("inbox",s.inbox.filter(i=>i.status==="new"),i=>\`<div class="cell">\${esc(i.text)}<div class="meta">\${i.createdAt.slice(0,16).replace("T"," ")}</div></div>\`,"empty")}
    \${lane("in review",by("review"),t=>taskCard(t,id),"nothing in review")}
    \${lane("building",by("building"),t=>taskCard(t,id),"idle")}
    \${lane("queue",by("queued"),t=>taskCard(t,id),"queue empty")}
    \${lane("blocked // stuck",s.tasks.filter(t=>t.status==="blocked"||t.status==="stuck"),t=>taskCard(t,id),"none")}
    \${lane("done",by("merged").slice(-12).reverse(),t=>taskCard(t,id),"nothing done yet")}
    <h2>activity<span class="n mono">\${s.events.length}</span></h2>
    <div>\${s.events.slice(0,25).map(e=>\`<div class="ev"><b class="mono">\${e.ts.slice(5,16).replace("T"," ")}</b> — \${esc(e.msg)}</div>\`).join("")||'<div class="empty">no activity</div>'}</div>\`;
}
async function refresh(){const id=qp("project");id?projectView(id):projectList();}
refresh();setInterval(refresh,5000);
</script>
</body></html>`;
