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
  const done=by("merged").length,total=s.tasks.length,pct=total?Math.round(done/total*100):0;
  // status model → the five states the operator watches
  const STMAP={queued:["QUEUED","st-queued"],building:["ACTIVE","st-building"],review:["IN PROGRESS","st-review"],changes:["IN PROGRESS","st-changes"],merged:["COMPLETED","st-merged"],blocked:["AWAITING","st-blocked"],stuck:["FAILED","st-stuck"]};
  const stL=(x)=>STMAP[x]||[String(x).toUpperCase(),""];
  const chips=[["active",by("building").length,"st-building"],["in progress",by("review").length+by("changes").length,"st-review"],["queued",by("queued").length,"st-queued"],["completed",done,"st-merged"],["awaiting",by("blocked").length,"st-blocked"],["failed",by("stuck").length,"st-stuck"],["findings",finds.length,""]]
    .map(([n,v,c])=>\`<div class="chip \${c}"><b class="mono">\${v}</b>\${n}</div>\`).join("");
  const rowActs=(t)=>t.status==="queued"?actForm(id,t.id,"bump","▲")+actForm(id,t.id,"hold","⏸"):(t.status==="blocked"||t.status==="stuck")?actForm(id,t.id,"requeue","↻","go"):"";
  const trows=s.tasks.slice().sort((a,b)=>(a.priority??3)-(b.priority??3)||a.phase-b.phase||a.id-b.id).map(t=>{const[lab,cl]=stL(t.status);return \`<tr class="\${cl}">
    <td data-l="#" class="id">\${t.id}</td>
    <td data-l="Task"><strong>\${esc(t.title)}</strong>\${t.active?' <span class="badge b-off">active</span>':''}</td>
    <td data-l="Phase">P\${t.phase}</td>
    <td data-l="Pri">\${t.priority??3}</td>
    <td data-l="Status"><span class="st \${cl}">\${lab}</span></td>
    <td data-l="Target">\${esc(t.target||"—")}</td>
    <td data-l="Activity">\${esc(t.notes||t.branch||"—")}</td>
    <td data-l="" class="ac">\${rowActs(t)}</td></tr>\`;}).join("")||'<tr><td colspan="8" class="empty">no tasks planned yet</td></tr>';
  document.getElementById("app").innerHTML=\`
    <div class="bar"><span><span class="dot"></span>online</span><span class="mono">\${clock()}</span><a class="back" href="/">« all units</a></div>
    <h1>\${esc(p.name)}</h1><div class="sub">\${esc(p.domain)} · \${esc(p.path)||"no path"} \${pbadges({offensive:OFF(p.domain),authorized:sc.authorized,halt:sc.halt})}</div>
    \${scopeBox}
    <div class="chips">\${chips}</div>
    <h2>phase progress<span class="n mono">\${pct}% done</span></h2>
    <div class="phase-strip">\${phaseHtml}</div>
    <form class="inbox-form" method="POST" action="/inbox"><input type="hidden" name="project" value="\${esc(id)}">
      <input type="text" name="text" placeholder="NEW LEAD / TASK — reasoned into the queue next pass" autocomplete="off" required><button>Add</button></form>
    \${s.inbox.filter(i=>i.status==="new").length?'<h2>inbox<span class="n mono">'+s.inbox.filter(i=>i.status==="new").length+'</span></h2><div>'+s.inbox.filter(i=>i.status==="new").map(i=>\`<div class="frow">\${esc(i.text)}</div>\`).join("")+'</div>':''}
    <h2>tasks<span class="n mono">\${total}</span></h2>
    <div class="tbl-wrap"><table class="tasks"><thead><tr><th>#</th><th>Task</th><th>Phase</th><th>Pri</th><th>Status</th><th>Target</th><th>Activity</th><th></th></tr></thead><tbody>\${trows}</tbody></table></div>
    <h2>findings<span class="n mono">\${vfind.length}V / \${cleanN}C</span></h2>
    <div>\${findHtml}</div>
    <h2>activity<span class="n mono">\${s.events.length}</span></h2>
    <div>\${s.events.slice(0,25).map(e=>\`<div class="ev"><b class="mono">\${e.ts.slice(5,16).replace("T"," ")}</b> — \${esc(e.msg)}</div>\`).join("")||'<div class="empty">no activity</div>'}</div>\`;
}
async function refresh(){const id=qp("project");id?projectView(id):projectList();}
refresh();setInterval(refresh,5000);
</script>
</body></html>`;
