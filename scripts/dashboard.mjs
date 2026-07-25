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
// Recent audit-log lines (what the loop actually did) — for the Logs tab.
function auditTail(n = 60) {
  const dir = join(ROOT, "logs");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().slice(-2);
  const out = [];
  for (const f of files) {
    try {
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch {}
      }
    } catch {}
  }
  return out.slice(-n).reverse();
}

// Daily completed-task counts → the velocity chart.
function velocity(state) {
  const by = {};
  for (const t of state.tasks) {
    if (t.status !== "merged" || !t.updatedAt) continue;
    const d = t.updatedAt.slice(0, 10);
    by[d] = (by[d] || 0) + 1;
  }
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    days.push({ d, n: by[d] || 0 });
  }
  return days;
}

const snapshot = (project) => {
  if (!project) return { projects: rollup() };
  const p = getProject(project);
  if (!p) return { error: "gone" };
  const state = loadState(project);
  return {
    project: p, state,
    velocity: velocity(state),
    audit: auditTail(60).filter((e) => !e.project || e.project === project || !e.flags?.project || e.flags.project === project),
    run: { lock: state.lock ?? null, dashboardTime: new Date().toISOString() },
  };
};

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
  /* Terminal core, premium polish. Mono is reserved for data + measurement;
     prose and labels use the system UI face so hierarchy reads at a glance. */
  :root{
    color-scheme:dark;
    --bg:#08090a; --panel:#101214; --panel2:#161a1d; --line:#242a2e; --line2:#323a40;
    --fg:#e8ecef; --dim:#98a3aa; --faint:#6b757c;
    --red:#ff3b30; --amber:#f0b429; --blue:#4c9aff; --green:#3ddc84; --violet:#a78bfa;
    --mono:ui-monospace,"JetBrains Mono","Cascadia Code",Consolas,monospace;
    --ui:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
    --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:36px;
    --shadow:0 8px 24px -12px rgba(0,0,0,.8);
    --ease:cubic-bezier(.16,1,.3,1);
  }
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 var(--ui);-webkit-font-smoothing:antialiased}
  body{padding:clamp(12px,2vw,24px) clamp(12px,2.4vw,32px);padding-top:max(env(safe-area-inset-top),12px)}
  .wrap{width:100%;max-width:1680px;margin-inline:auto}
  a{color:inherit;text-decoration:none}
  .mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
  .num{font-family:var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.02em}

  /* ---- top bar ---- */
  .bar{display:flex;align-items:center;gap:var(--s4);flex-wrap:wrap;padding-bottom:var(--s3);
       border-bottom:1px solid var(--line);margin-bottom:var(--s4)}
  .back{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border:1px solid var(--line);
        border-radius:7px;font-size:12px;color:var(--dim);transition:all .18s var(--ease)}
  .back:hover{border-color:var(--line2);color:var(--fg);background:var(--panel)}
  .status{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dim)}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(61,220,132,.15)}
  .dot.off{background:var(--red);box-shadow:0 0 0 3px rgba(255,59,48,.15)}
  .spacer{flex:1}
  .clk{font-size:12px;color:var(--faint)}

  /* ---- headline ---- */
  h1{font-size:clamp(1.5rem,3.2vw,2.4rem);font-weight:800;letter-spacing:-.035em;line-height:1.05;margin:0 0 6px}
  .sub{display:flex;gap:var(--s3);flex-wrap:wrap;align-items:center;color:var(--dim);font-size:13px;margin-bottom:var(--s4)}
  .path{font-family:var(--mono);font-size:12px;color:var(--faint)}

  /* ---- badges / chips ---- */
  .badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:3px 9px;
         border-radius:999px;border:1px solid var(--line2);color:var(--dim);letter-spacing:.01em}
  .badge.on{color:var(--green);border-color:rgba(61,220,132,.4);background:rgba(61,220,132,.08)}
  .badge.off{color:var(--red);border-color:rgba(255,59,48,.4);background:rgba(255,59,48,.08)}
  .badge.warn{color:var(--amber);border-color:rgba(240,180,41,.4);background:rgba(240,180,41,.08)}

  /* status pills — a dot carries the state, no heavy colored borders */
  .st{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:3px 9px;
      border-radius:999px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);white-space:nowrap}
  .st::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
  .st-queued{color:var(--faint)} .st-building{color:var(--amber)} .st-review,.st-changes{color:var(--blue)}
  .st-merged,.st-completed{color:var(--green)} .st-blocked,.st-stuck,.st-attention{color:var(--red)}
  .st-superseded{color:var(--faint);text-decoration:line-through} .st-active{color:var(--amber)}
  .st-inprogress{color:var(--blue)} .st-new,.st-idle{color:var(--faint)}
  .st-building::before{animation:pulse 1.6s var(--ease) infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}

  /* ---- KPI strip ---- */
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:1px;background:var(--line);
        border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:var(--s4)}
  .kpi{background:var(--panel);padding:12px 14px}
  .kpi b{display:block;font-family:var(--mono);font-size:23px;font-weight:700;line-height:1.1;letter-spacing:-.03em}
  .kpi span{font-size:11px;color:var(--dim);letter-spacing:.02em}
  .kpi.k-active b{color:var(--amber)} .kpi.k-inprogress b{color:var(--blue)}
  .kpi.k-completed b{color:var(--green)} .kpi.k-awaiting b,.kpi.k-failed b{color:var(--red)}

  /* ---- tabs ---- */
  .tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:var(--s4);overflow-x:auto;scrollbar-width:none}
  .tabs::-webkit-scrollbar{display:none}
  .tab{padding:10px 16px;font-size:13px;font-weight:600;color:var(--dim);border:0;background:none;cursor:pointer;
       border-bottom:2px solid transparent;white-space:nowrap;transition:color .18s var(--ease),border-color .18s var(--ease)}
  .tab:hover{color:var(--fg)}
  .tab[aria-selected=true]{color:var(--fg);border-bottom-color:var(--red)}
  .tab .cnt{font-family:var(--mono);font-size:11px;color:var(--faint);margin-left:6px}
  .tab[aria-selected=true] .cnt{color:var(--red)}

  /* ---- panels / cards ---- */
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px}
  .card+.card{margin-top:var(--s3)}
  .card h2{font-size:12px;font-weight:700;color:var(--dim);letter-spacing:.06em;text-transform:uppercase;
           margin:0;padding:12px 16px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:var(--s3)}
  .card .body{padding:var(--s4)}
  .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:var(--s3);align-items:start}

  /* ---- attention (needs you) ---- */
  .attn{border:1px solid rgba(255,59,48,.45);background:linear-gradient(180deg,rgba(255,59,48,.09),rgba(255,59,48,.03));
        border-radius:10px;padding:var(--s4);margin-bottom:var(--s4)}
  .attn h2{color:var(--red);font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin:0 0 var(--s3);display:flex;align-items:center;gap:8px}
  .attn-row+.attn-row{margin-top:var(--s4);padding-top:var(--s4);border-top:1px solid rgba(255,59,48,.2)}
  .attn .q{margin:8px 0 12px;color:var(--fg);opacity:.92;line-height:1.6}
  .ans{display:flex;gap:8px;flex-wrap:wrap}
  .ans input{flex:1;min-width:220px;font:inherit;font-size:15px;padding:10px 13px;background:var(--bg);color:var(--fg);
             border:1px solid var(--line2);border-radius:7px}
  .ans input:focus{outline:none;border-color:var(--green);box-shadow:0 0 0 3px rgba(61,220,132,.12)}

  /* ---- buttons ---- */
  button{font:inherit}
  .btn{padding:9px 15px;border-radius:7px;border:1px solid var(--line2);background:var(--panel2);color:var(--fg);
       font-size:12px;font-weight:600;cursor:pointer;transition:all .18s var(--ease)}
  .btn:hover{border-color:var(--fg);background:#1d2226}
  .btn.primary{background:var(--green);border-color:var(--green);color:#062b15}
  .btn.primary:hover{filter:brightness(1.08)}
  .btn.danger{background:var(--red);border-color:var(--red);color:#fff}
  .btn.ghost{background:transparent}
  .btn.sm{padding:5px 10px;font-size:11px}
  form.inl{display:inline}

  /* ---- table ---- */
  .tbl-wrap{overflow-x:auto}
  table.t{width:100%;border-collapse:collapse;font-size:13px}
  table.t th{position:sticky;top:0;z-index:1;background:var(--panel2);color:var(--dim);font-size:11px;font-weight:600;
             letter-spacing:.05em;text-transform:uppercase;text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);white-space:nowrap}
  table.t td{padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}
  table.t tbody tr{cursor:pointer;transition:background .14s var(--ease)}
  table.t tbody tr:hover td{background:var(--panel2)}
  table.t tbody tr[aria-selected=true] td{background:#1a2026}
  .tid{font-family:var(--mono);font-size:12px;color:var(--faint)}
  .ttl{font-weight:600}
  .meta{color:var(--dim);font-size:12px}
  .skl{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
  .skl span{font-size:10px;color:var(--dim);border:1px solid var(--line2);border-radius:5px;padding:1px 6px}

  /* ---- toolbar ---- */
  .toolbar{display:flex;gap:var(--s2);flex-wrap:wrap;padding:var(--s3) var(--s4);border-bottom:1px solid var(--line)}
  .toolbar input,.toolbar select{font:inherit;font-size:13px;padding:8px 11px;background:var(--bg);color:var(--fg);
                                 border:1px solid var(--line2);border-radius:7px}
  .toolbar input{flex:1;min-width:160px}
  .toolbar input:focus,.toolbar select:focus{outline:none;border-color:var(--blue)}

  /* ---- detail drawer ---- */
  .drawer{position:fixed;inset:0;z-index:50;display:none}
  .drawer[open]{display:block}
  .drawer .scrim{position:absolute;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(2px);animation:fade .2s var(--ease)}
  .drawer .sheet{position:absolute;top:0;right:0;bottom:0;width:min(560px,100%);background:var(--panel);
                 border-left:1px solid var(--line);box-shadow:var(--shadow);overflow-y:auto;animation:slide .28s var(--ease)}
  @keyframes slide{from{transform:translateX(24px);opacity:.4}to{transform:none;opacity:1}}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  .sheet header{position:sticky;top:0;background:var(--panel);border-bottom:1px solid var(--line);padding:var(--s4);
                display:flex;align-items:flex-start;gap:var(--s3)}
  .sheet header h3{margin:0;font-size:16px;font-weight:700;line-height:1.35;flex:1}
  .sheet .body{padding:var(--s4)}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:8px var(--s4);font-size:13px;margin-bottom:var(--s4)}
  .kv dt{color:var(--dim)} .kv dd{margin:0;font-family:var(--mono);font-size:12.5px;word-break:break-word}
  .sec{margin-top:var(--s4)}
  .sec h4{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px}
  .sec ul{margin:0;padding-left:18px}.sec li{margin-bottom:4px;font-size:13px}
  .note{background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:11px 13px;font-size:13px;line-height:1.6;white-space:pre-wrap}

  /* ---- charts (svg, no deps) ---- */
  .chart{width:100%;height:96px;display:block}
  .chart .bar{fill:var(--green);opacity:.85}
  .chart .bar.zero{fill:var(--line2);opacity:1}
  .prog{height:7px;border-radius:999px;background:var(--panel2);overflow:hidden;border:1px solid var(--line)}
  .prog i{display:block;height:100%;background:var(--green);transition:width .5s var(--ease)}
  .phase-row{display:flex;align-items:center;gap:var(--s3);padding:8px 0;border-bottom:1px solid var(--line);font-size:13px}
  .phase-row:last-child{border-bottom:0}
  .phase-row .pn{font-family:var(--mono);font-size:11px;color:var(--faint);width:32px;flex:none}
  .phase-row .pt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  /* ---- findings ---- */
  .fsev{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:5px;color:#fff;flex:none}
  .f-critical{background:#a11}.f-high{background:var(--red)}.f-medium{background:#e07b00}.f-low{background:#1f9d63}.f-info{background:#5b6670}
  .frow{display:flex;gap:var(--s3);align-items:center;padding:11px 14px;border-bottom:1px solid var(--line);cursor:pointer}
  .frow:hover{background:var(--panel2)}

  /* ---- logs ---- */
  .log{font-family:var(--mono);font-size:12px;line-height:1.75;padding:10px 14px;border-bottom:1px solid var(--line);display:flex;gap:var(--s3)}
  .log time{color:var(--faint);flex:none}
  .log .k{color:var(--blue);flex:none}
  .log.refused .k{color:var(--red)}
  .log.inscope .k{color:var(--green)}

  /* ---- skills ---- */
  .sk-cat{border-bottom:1px solid var(--line)}
  .sk-cat>summary{cursor:pointer;padding:10px 14px;font-size:12px;font-weight:600;color:var(--dim);display:flex;align-items:center;gap:10px}
  .sk-cat>summary:hover{color:var(--fg)}
  .sk-cn{flex:1}.sk-cc{font-family:var(--mono);font-size:11px;color:var(--faint)}
  .sk-item{display:flex;gap:10px;align-items:baseline;padding:8px 14px 8px 28px;font-size:13px;cursor:pointer;border-top:1px solid var(--line)}
  .sk-item:hover{background:var(--panel2)}
  .sk-item input{accent-color:var(--green);margin:0}
  .sk-n{font-weight:600;flex:none}
  .sk-d{color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sk-chip{font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;background:rgba(61,220,132,.12);
           color:var(--green);border:1px solid rgba(61,220,132,.35)}
  .sk-sel{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:var(--s3)}

  .empty{color:var(--dim);font-size:13px;padding:var(--s5) var(--s4);text-align:center}
  .empty b{display:block;color:var(--fg);font-size:14px;margin-bottom:4px}
  .scope-line{display:flex;gap:10px;font-size:13px;padding:5px 0}
  .scope-line dt{color:var(--dim);min-width:104px;flex:none}
  .scope-line dd{margin:0;font-family:var(--mono);font-size:12.5px;word-break:break-word}

  @media(max-width:720px){
    table.t thead{position:absolute;left:-9999px}
    table.t tbody tr{display:block;border:1px solid var(--line);border-radius:9px;margin-bottom:8px;background:var(--panel)}
    table.t td{display:flex;justify-content:space-between;gap:16px;border:0;border-bottom:1px solid var(--line);padding:9px 13px}
    table.t td:last-child{border-bottom:0}
    table.t td::before{content:attr(data-l);color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em;flex:none}
    .kv{grid-template-columns:1fr;gap:2px}.kv dt{margin-top:8px}
  }
  @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head>
<body><div class="wrap" id="app"><div class="empty"><b>Connecting…</b>waiting for the loop</div></div>
<div class="drawer" id="drawer"><div class="scrim" onclick="closeDrawer()"></div><div class="sheet" id="sheet"></div></div>
<script>
const esc=(s)=>(s??"").toString().replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const qp=(k)=>new URLSearchParams(location.search).get(k);
const OFFSET=new Set(["web-pentest","api-pentest","mobile-android","mobile-ios","red-team-external","red-team-internal","external-network","internal-network"]);
const OFF=(d)=>OFFSET.has(d);
const STMAP={queued:["Queued","st-queued"],building:["Active","st-building"],review:["In review","st-review"],changes:["Changes","st-changes"],merged:["Completed","st-merged"],blocked:["Awaiting you","st-blocked"],stuck:["Failed","st-stuck"],superseded:["Superseded","st-superseded"]};
const PSTAT={new:["New","st-new"],inprogress:["In progress","st-inprogress"],active:["Active","st-active"],attention:["Needs you","st-attention"],completed:["Completed","st-completed"],idle:["Idle","st-idle"]};
const stL=(s)=>STMAP[s]||[s,""];
const ago=(iso)=>{if(!iso)return "—";const d=(Date.now()-new Date(iso))/1000;if(d<60)return "just now";if(d<3600)return Math.floor(d/60)+"m ago";if(d<86400)return Math.floor(d/3600)+"h ago";return Math.floor(d/86400)+"d ago";};
const pill=(s)=>{const[l,c]=stL(s);return '<span class="st '+c+'">'+l+'</span>';};

let LAST=null,curProject=null,TAB=sessionStorage.getItem("schTab")||"overview",SKILLS=null;
let filt={q:"",status:""},openTask=null,openFind=null;

// patch a region only if its markup changed and the user isn't typing inside it
const CACHE={};
function set(id,html){const el=document.getElementById(id);if(!el)return;
  if(CACHE[id]===html)return;if(el.contains(document.activeElement))return;CACHE[id]=html;el.innerHTML=html;}

/* ============================ HOME ============================ */
function homeSkeleton(){
  document.getElementById("app").innerHTML=\`
    <div class="bar"><span class="status"><span class="dot" id="dot"></span><span id="livemark">live</span></span>
      <span class="spacer"></span><span class="clk mono" id="clk"></span></div>
    <h1>SCH·Loop</h1><div class="sub" id="hsub">operations control</div>
    <div class="kpis" id="pchips"></div>
    <div class="card"><h2>Projects<span class="mono" id="pcount"></span></h2><div class="tbl-wrap" id="ptable"></div></div>\`;
  for(const k in CACHE)delete CACHE[k];
}
function homeApply(ps){
  document.getElementById("clk").textContent=new Date().toLocaleTimeString();
  const by=(c)=>ps.filter(p=>p.status===c).length;
  document.getElementById("pcount").textContent=ps.length;
  set("pchips",[["Active",by("active"),"k-active"],["In progress",by("inprogress"),"k-inprogress"],["Needs you",by("attention"),"k-awaiting"],["Completed",by("completed"),"k-completed"],["New",by("new"),""]]
    .map(([n,v,c])=>'<div class="kpi '+c+'"><b>'+v+'</b><span>'+n+'</span></div>').join(""));
  const RANK={attention:0,active:1,inprogress:2,new:3,idle:4,completed:5};
  const rows=ps.slice().sort((a,b)=>(RANK[a.status]??9)-(RANK[b.status]??9)||a.name.localeCompare(b.name)).map((p,i)=>{
    const[lab,cl]=PSTAT[p.status]||[p.status,""];
    return '<tr onclick="location.href=\\'/?project='+encodeURIComponent(p.id)+'\\'">'+
      '<td data-l="#" class="tid">'+(i+1)+'</td>'+
      '<td data-l="Project"><span class="ttl">'+esc(p.name)+'</span><div class="meta">'+esc(p.domain)+(p.offensive?(p.authorized?' · <span class="badge on">authorized</span>':' · <span class="badge off">unauthorized</span>'):'')+(p.halt?' · <span class="badge off">halt</span>':'')+'</div></td>'+
      '<td data-l="Status"><span class="st '+cl+'">'+lab+'</span></td>'+
      '<td data-l="Progress"><div class="prog" style="min-width:90px"><i style="width:'+p.pct+'%"></i></div><div class="meta num">'+p.done+'/'+p.total+' · '+p.pct+'%</div></td>'+
      '<td data-l="Pending" class="num">'+p.pending+'</td>'+
      '<td data-l="Findings" class="num">'+p.findings+'</td>'+
      '<td data-l="Inbox" class="num">'+(p.inboxNew?'<span class="badge warn">'+p.inboxNew+'</span>':'0')+'</td></tr>';
  }).join("")||'<tr><td colspan="7"><div class="empty"><b>No projects yet</b>Run /sch-spec in a project folder to create one.</div></td></tr>';
  set("ptable",'<table class="t"><thead><tr><th>#</th><th>Project</th><th>Status</th><th>Progress</th><th>Pending</th><th>Findings</th><th>Inbox</th></tr></thead><tbody>'+rows+'</tbody></table>');
}

/* ========================== PROJECT ========================== */
function projSkeleton(id){
  document.getElementById("app").innerHTML=\`
    <div class="bar"><a class="back" href="/">← All projects</a>
      <span class="status"><span class="dot" id="dot"></span><span id="livemark">live</span></span>
      <span class="spacer"></span><span class="clk mono" id="clk"></span></div>
    <h1 id="pname">…</h1><div class="sub" id="pmeta"></div>
    <div id="attn"></div>
    <div class="kpis" id="chips"></div>
    <div class="tabs" role="tablist" id="tabs"></div>
    <div id="tabbody"></div>\`;
  for(const k in CACHE)delete CACHE[k];
}
function tabs(counts){
  const defs=[["overview","Overview",""],["tasks","Tasks",counts.tasks],["findings","Findings",counts.findings],["skills","Skills",counts.skills],["logs","Activity",counts.logs]];
  return defs.map(([k,l,c])=>'<button class="tab" role="tab" aria-selected="'+(TAB===k)+'" onclick="setTab(\\''+k+'\\')">'+l+(c!==""&&c!==undefined?'<span class="cnt">'+c+'</span>':'')+'</button>').join("");
}
function setTab(t){TAB=t;sessionStorage.setItem("schTab",t);delete CACHE.tabbody;delete CACHE.tabs;if(LAST)projApply(curProject,LAST);}

function projApply(id,r){
  if(r.error){location.href="/";return;}
  const p=r.project,s=r.state,sc=p.scope||{},by=(st)=>s.tasks.filter(t=>t.status===st);
  const live=s.tasks.filter(t=>t.status!=="superseded");
  const done=by("merged").length,total=live.length,pct=total?Math.round(done/total*100):0;
  const finds=s.findings||[],vf=finds.filter(f=>f.status==="validated");
  document.getElementById("clk").textContent=new Date().toLocaleTimeString();
  document.getElementById("pname").textContent=p.name;
  document.getElementById("pmeta").innerHTML='<span>'+esc(p.domain)+'</span><span class="path">'+esc(p.path||"no path")+'</span>'+
    (OFF(p.domain)?(sc.authorized?'<span class="badge on">authorized</span>':'<span class="badge off">unauthorized</span>'):'')+
    (sc.halt?'<span class="badge off">HALT</span>':'')+(r.run&&r.run.lock?'<span class="badge warn">pass running</span>':'');

  /* needs-you */
  const attn=s.tasks.filter(t=>t.status==="blocked"||t.status==="stuck");
  let a="";
  if(attn.length){
    a='<div class="attn"><h2>⚠ Needs you — '+attn.length+' task'+(attn.length>1?"s":"")+'</h2>';
    for(const t of attn){
      a+='<div class="attn-row"><div>'+pill(t.status)+' <span class="tid">#'+t.id+'</span> <b>'+esc(t.title)+'</b></div>'+
         '<div class="q">'+esc(t.notes||"(open the task for detail)")+'</div>'+
         '<form class="ans" method="POST" action="/answer"><input type="hidden" name="project" value="'+esc(id)+'"><input type="hidden" name="id" value="'+t.id+'">'+
         '<input type="text" name="text" placeholder="Type your answer — the task resumes at the top of the queue" autocomplete="off" required>'+
         '<button class="btn primary">Answer &amp; unblock</button></form>'+
         '<div style="margin-top:8px"><button class="btn ghost sm" onclick="showTask('+t.id+')">Open detail</button> '+
         taskForm(id,t.id,"close",'<button class="btn ghost sm">Close (superseded)</button>')+'</div></div>';
    }
    a+='</div>';
  }
  set("attn",a);

  set("chips",[["Active",by("building").length,"k-active"],["In review",by("review").length+by("changes").length,"k-inprogress"],
    ["Queued",by("queued").length,""],["Completed",done,"k-completed"],["Awaiting",by("blocked").length,"k-awaiting"],
    ["Failed",by("stuck").length,"k-failed"],["Findings",finds.length,""]]
    .map(([n,v,c])=>'<div class="kpi '+c+'"><b>'+v+'</b><span>'+n+'</span></div>').join(""));

  set("tabs",tabs({tasks:total,findings:vf.length,skills:(p.requiredSkills||[]).length,logs:(r.audit||[]).length}));
  set("tabbody",TAB==="overview"?viewOverview(id,p,s,r,{done,total,pct,vf,finds})
    :TAB==="tasks"?viewTasks(id,s)
    :TAB==="findings"?viewFindings(s,finds,vf)
    :TAB==="skills"?viewSkills(id,p)
    :viewLogs(s,r));
  if(TAB==="skills")renderSkills(id,p.requiredSkills||[]);
  if(openTask)drawTask(id,s);
  if(openFind)drawFinding(s);
}

/* ---- overview ---- */
function viewOverview(id,p,s,r,m){
  const sc=p.scope||{};
  const scopeCard=OFF(p.domain)?'<div class="card"><h2>Engagement scope</h2><div class="body">'+
    '<dl style="margin:0">'+
    '<div class="scope-line"><dt>Status</dt><dd>'+(sc.authorized?'authorized':'NOT authorized')+(sc.halt?' · HALT':'')+'</dd></div>'+
    '<div class="scope-line"><dt>Targets</dt><dd>'+(esc((sc.targets||[]).join(", "))||"—")+'</dd></div>'+
    '<div class="scope-line"><dt>Out of scope</dt><dd>'+(esc((sc.outOfScope||[]).join(", "))||"—")+'</dd></div>'+
    '<div class="scope-line"><dt>Authorization</dt><dd>'+(esc(sc.ref)||"—")+(sc.expiry?' · expires '+esc(sc.expiry):'')+'</dd></div>'+
    '</dl><div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">'+
    scopeForm(id,sc.halt?"resume":"halt",'<button class="btn '+(sc.halt?'primary':'danger')+'">'+(sc.halt?"Resume":"HALT all active work")+'</button>')+
    scopeForm(id,sc.authorized?"disarm":"arm",'<button class="btn">'+(sc.authorized?"Disarm":"Arm")+'</button>')+
    '</div></div></div>':"";
  const ph=s.tasks.filter(t=>t.status!=="superseded").sort((a,b)=>a.phase-b.phase||a.id-b.id).slice(0,14)
    .map(t=>'<div class="phase-row"><span class="pn">P'+t.phase+'</span><span class="pt">'+esc(t.title)+'</span>'+pill(t.status)+'</div>').join("")
    ||'<div class="empty"><b>Nothing planned</b>Run /sch-plan to build the queue.</div>';
  const nb=s.inbox.filter(i=>i.status==="new");
  return '<div class="cols">'+
    '<div><div class="card"><h2>Progress<span class="mono">'+m.pct+'%</span></h2><div class="body">'+
      '<div class="prog"><i style="width:'+m.pct+'%"></i></div>'+
      '<div class="meta" style="margin-top:8px">'+m.done+' of '+m.total+' tasks complete · '+(m.total-m.done)+' remaining</div>'+
      '<div style="margin-top:18px"><h4 style="font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px">Completed per day (14d)</h4>'+chart(r.velocity||[])+'</div>'+
    '</div></div>'+scopeCard+'</div>'+
    '<div><div class="card"><h2>Phases</h2><div class="body" style="padding-top:4px">'+ph+'</div></div>'+
    '<div class="card"><h2>Add a lead or task</h2><div class="body">'+
      '<form class="ans" method="POST" action="/inbox"><input type="hidden" name="project" value="'+esc(id)+'">'+
      '<input type="text" name="text" placeholder="A feature, a fix, a lead — planned into the queue next pass" autocomplete="off" required>'+
      '<button class="btn primary">Add</button></form>'+
      (nb.length?'<div style="margin-top:14px"><h4 style="font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px">Waiting to be planned ('+nb.length+')</h4>'+
        nb.map(i=>'<div class="note" style="margin-bottom:6px">'+esc(i.text)+'<div class="meta" style="margin-top:6px">'+ago(i.createdAt)+'</div></div>').join("")+'</div>':"")+
    '</div></div></div></div>';
}
function chart(v){
  if(!v.length)return '<div class="empty">No data yet</div>';
  const max=Math.max(1,...v.map(d=>d.n)),W=100/v.length;
  return '<svg class="chart" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="Tasks completed per day">'+
    v.map((d,i)=>{const h=d.n?Math.max(1.5,d.n/max*26):1;return '<rect class="bar'+(d.n?'':' zero')+'" x="'+(i*W+W*0.15).toFixed(2)+'" y="'+(29-h).toFixed(2)+'" width="'+(W*0.7).toFixed(2)+'" height="'+h.toFixed(2)+'" rx="0.4"><title>'+d.d+': '+d.n+'</title></rect>';}).join("")+
    '</svg><div class="meta" style="display:flex;justify-content:space-between;margin-top:4px"><span>'+v[0].d.slice(5)+'</span><span>'+v[v.length-1].d.slice(5)+'</span></div>';
}

/* ---- tasks ---- */
function viewTasks(id,s){
  let ts=s.tasks.slice().sort((a,b)=>(a.priority??3)-(b.priority??3)||a.phase-b.phase||a.id-b.id);
  if(filt.status)ts=ts.filter(t=>t.status===filt.status);
  if(filt.q){const q=filt.q.toLowerCase();ts=ts.filter(t=>((t.title||"")+" "+(t.notes||"")+" "+(t.target||"")+" P"+t.phase).toLowerCase().includes(q));}
  const opts=["","queued","building","review","changes","blocked","stuck","merged","superseded"]
    .map(x=>'<option value="'+x+'"'+(x===filt.status?" selected":"")+'>'+(x?stL(x)[0]:"All statuses")+'</option>').join("");
  const rows=ts.map(t=>'<tr onclick="showTask('+t.id+')" aria-selected="'+(openTask===t.id)+'">'+
    '<td data-l="#" class="tid">'+t.id+'</td>'+
    '<td data-l="Task"><span class="ttl">'+esc(t.title)+'</span>'+(t.active?' <span class="badge warn">active</span>':'')+
      (t.notes?'<div class="meta" style="margin-top:3px">'+esc(t.notes.slice(0,110))+(t.notes.length>110?'…':'')+'</div>':'')+
      ((t.skills&&t.skills.length)?'<div class="skl">'+t.skills.map(x=>'<span>'+esc(x)+'</span>').join("")+'</div>':'')+'</td>'+
    '<td data-l="Phase" class="num">P'+t.phase+'</td>'+
    '<td data-l="Priority" class="num">'+(t.priority??3)+'</td>'+
    '<td data-l="Status">'+pill(t.status)+'</td>'+
    '<td data-l="Updated" class="meta">'+ago(t.updatedAt)+'</td>'+
    '<td data-l="">'+rowActions(id,t)+'</td></tr>').join("")
    ||'<tr><td colspan="7"><div class="empty"><b>No matching tasks</b>Clear the filter to see the full queue.</div></td></tr>';
  return '<div class="card"><div class="toolbar">'+
    '<input id="tq" placeholder="Filter by title, note, target or phase…" value="'+esc(filt.q)+'" oninput="filt.q=this.value;refilter()">'+
    '<select onchange="filt.status=this.value;refilter()">'+opts+'</select></div>'+
    '<div class="tbl-wrap"><table class="t"><thead><tr><th>#</th><th>Task</th><th>Phase</th><th>Pri</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
}
function refilter(){delete CACHE.tabbody;if(LAST)projApply(curProject,LAST);}
function taskForm(pid,tid,action,inner){return '<form class="inl" method="POST" action="/task" onclick="event.stopPropagation()"><input type="hidden" name="project" value="'+esc(pid)+'"><input type="hidden" name="id" value="'+tid+'"><input type="hidden" name="action" value="'+action+'">'+inner+'</form>';}
function scopeForm(pid,action,inner){return '<form class="inl" method="POST" action="/scope"><input type="hidden" name="project" value="'+esc(pid)+'"><input type="hidden" name="action" value="'+action+'">'+inner+'</form>';}
function rowActions(id,t){
  if(t.status==="queued")return taskForm(id,t.id,"bump",'<button class="btn sm" title="Move to the front of the queue">Bump</button>')+" "+taskForm(id,t.id,"hold",'<button class="btn sm ghost" title="Put on hold">Hold</button>');
  if(t.status==="blocked"||t.status==="stuck")return taskForm(id,t.id,"requeue",'<button class="btn sm">Requeue</button>');
  return "";
}

/* ---- task detail drawer ---- */
function showTask(tid){openTask=tid;openFind=null;if(LAST)drawTask(curProject,LAST.state);document.getElementById("drawer").setAttribute("open","");}
function closeDrawer(){openTask=openFind=null;document.getElementById("drawer").removeAttribute("open");delete CACHE.tabbody;if(LAST)projApply(curProject,LAST);}
function drawTask(id,s){
  const t=s.tasks.find(x=>x.id===openTask);if(!t)return closeDrawer();
  const list=(arr)=>arr&&arr.length?'<ul>'+arr.map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul>':'<div class="meta">None</div>';
  document.getElementById("sheet").innerHTML=
    '<header><div style="flex:1"><div class="tid">TASK #'+t.id+' · phase '+t.phase+' · priority '+(t.priority??3)+'</div>'+
    '<h3>'+esc(t.title)+'</h3><div style="margin-top:6px">'+pill(t.status)+(t.active?' <span class="badge warn">active tooling</span>':'')+'</div></div>'+
    '<button class="btn ghost sm" onclick="closeDrawer()">Close</button></header><div class="body">'+
    '<dl class="kv"><dt>Target</dt><dd>'+(esc(t.target)||"—")+'</dd>'+
    '<dt>Branch</dt><dd>'+(esc(t.branch)||"—")+'</dd>'+
    '<dt>Source</dt><dd>'+esc(t.source||"plan")+'</dd>'+
    '<dt>Depends on</dt><dd>'+((t.deps&&t.deps.length)?t.deps.map(d=>"#"+d).join(", "):"—")+'</dd>'+
    '<dt>Created</dt><dd>'+(t.createdAt||"").slice(0,16).replace("T"," ")+'</dd>'+
    '<dt>Updated</dt><dd>'+(t.updatedAt||"").slice(0,16).replace("T"," ")+' ('+ago(t.updatedAt)+')</dd></dl>'+
    (t.notes?'<div class="sec"><h4>Current note / question</h4><div class="note">'+esc(t.notes)+'</div></div>':'')+
    '<div class="sec"><h4>Acceptance criteria</h4>'+list(t.ac)+'</div>'+
    '<div class="sec"><h4>Non-goals</h4>'+list(t.ng)+'</div>'+
    ((t.skills&&t.skills.length)?'<div class="sec"><h4>Skills actually used</h4><div class="skl">'+t.skills.map(x=>'<span>'+esc(x)+'</span>').join("")+'</div></div>':'')+
    ((t.answers&&t.answers.length)?'<div class="sec"><h4>Your answers</h4>'+t.answers.map(a=>'<div class="note" style="margin-bottom:6px">'+esc(a.text)+'<div class="meta" style="margin-top:6px">'+ago(a.ts)+'</div></div>').join("")+'</div>':'')+
    ((t.status==="blocked"||t.status==="stuck")?'<div class="sec"><h4>Answer &amp; unblock</h4>'+
      '<form class="ans" method="POST" action="/answer"><input type="hidden" name="project" value="'+esc(id)+'"><input type="hidden" name="id" value="'+t.id+'">'+
      '<input type="text" name="text" placeholder="Your decision — the task resumes at the top" autocomplete="off" required><button class="btn primary">Send</button></form></div>':'')+
    '<div class="sec" style="display:flex;gap:8px;flex-wrap:wrap">'+rowActions(id,t)+
      (t.status!=="superseded"?taskForm(id,t.id,"close",'<button class="btn ghost sm">Close as superseded</button>'):'')+'</div>'+
    '</div>';
}

/* ---- findings ---- */
function viewFindings(s,finds,vf){
  if(!finds.length)return '<div class="card"><div class="empty"><b>No findings yet</b>Validated issues and tested-clean coverage will appear here as the engagement runs.</div></div>';
  const rank=(x)=>["critical","high","medium","low","info"].indexOf((x||"info").toLowerCase());
  const sev=(x)=>"f-"+(["critical","high","medium","low"].includes((x||"").toLowerCase())?x.toLowerCase():"info");
  const clean=finds.filter(f=>f.status==="tested-clean");
  const rows=vf.slice().sort((a,b)=>rank(a.severity)-rank(b.severity)||a.id-b.id)
    .map(f=>'<div class="frow" onclick="showFinding('+f.id+')"><span class="fsev '+sev(f.severity)+'">'+esc(f.severity||"info")+'</span>'+
      '<div style="flex:1;min-width:0"><div class="ttl">'+esc(f.title)+'</div><div class="meta">'+esc(f.category||"")+(f.target?' · '+esc(f.target):'')+
      ((f.parents&&f.parents.length)?' · chained from #'+f.parents.join(", #"):'')+'</div></div>'+
      (f.cvss?'<span class="mono meta">'+esc(f.cvss.split(" ")[0])+'</span>':'')+'</div>').join("")
      ||'<div class="empty"><b>No validated findings</b>Coverage is being recorded — see tested-clean below.</div>';
  return '<div class="card"><h2>Validated findings<span class="mono">'+vf.length+'</span></h2>'+rows+'</div>'+
    '<div class="card"><h2>Controls that held (tested-clean)<span class="mono">'+clean.length+'</span></h2>'+
    (clean.length?clean.map(f=>'<div class="log"><span class="k">clean</span><span>'+esc(f.category?f.category+" — ":"")+esc(f.title)+'</span></div>').join(""):'<div class="empty">Nothing recorded yet</div>')+'</div>';
}
function showFinding(fid){openFind=fid;openTask=null;if(LAST)drawFinding(LAST.state);document.getElementById("drawer").setAttribute("open","");}
function drawFinding(s){
  const f=(s.findings||[]).find(x=>x.id===openFind);if(!f)return closeDrawer();
  const sev=(x)=>"f-"+(["critical","high","medium","low"].includes((x||"").toLowerCase())?x.toLowerCase():"info");
  document.getElementById("sheet").innerHTML=
    '<header><div style="flex:1"><div class="tid">FINDING #'+f.id+(f.chainDepth?' · chain depth '+f.chainDepth:'')+'</div>'+
    '<h3>'+esc(f.title)+'</h3><div style="margin-top:6px"><span class="fsev '+sev(f.severity)+'">'+esc(f.severity||"info")+'</span></div></div>'+
    '<button class="btn ghost sm" onclick="closeDrawer()">Close</button></header><div class="body">'+
    '<dl class="kv"><dt>Category</dt><dd>'+(esc(f.category)||"—")+'</dd>'+
    '<dt>CVSS</dt><dd>'+(esc(f.cvss)||"—")+'</dd>'+
    '<dt>Target</dt><dd>'+(esc(f.target)||"—")+'</dd>'+
    '<dt>Phase</dt><dd>'+(f.phase||"—")+'</dd>'+
    '<dt>Status</dt><dd>'+esc(f.status)+'</dd>'+
    '<dt>Chained from</dt><dd>'+((f.parents&&f.parents.length)?f.parents.map(p=>"#"+p).join(", "):"—")+'</dd>'+
    '<dt>Evidence</dt><dd>'+(esc(f.evidence)||"—")+'</dd></dl>'+
    (f.notes?'<div class="sec"><h4>Detail</h4><div class="note">'+esc(f.notes)+'</div></div>':'')+'</div>';
}

/* ---- skills ---- */
function viewSkills(id,p){
  return '<div class="card"><h2>Design skills for UI tasks</h2><div class="body">'+
    '<p class="meta" style="margin:0 0 14px">The loop picks the best-fit skill for each UI task — it does not run all of them. Backend, infra and recon tasks are never gated by these.</p>'+
    '<div id="skillin"><div class="empty">Loading skills…</div></div></div></div>';
}
async function renderSkills(id,selected){
  const host=document.getElementById("skillin");if(!host)return;
  if(!SKILLS){try{SKILLS=await(await fetch("/api/skills")).json();}catch{SKILLS=[];}}
  const sel=new Set(selected||[]);
  const sig=JSON.stringify([...sel].sort())+"|"+SKILLS.length;
  if(host.dataset.sig===sig||host.contains(document.activeElement))return;
  host.dataset.sig=sig;
  const cats=[...new Set(SKILLS.map(s=>s.cat))];
  let list="";
  for(const c of cats){
    const items=SKILLS.filter(s=>s.cat===c),on=items.filter(s=>sel.has(s.name)).length;
    list+='<details class="sk-cat" data-c="'+esc(c)+'"'+((c==="Design & UI"||on)?" open":"")+'><summary><span class="sk-cn">'+esc(c)+'</span><span class="sk-cc">'+on+'/'+items.length+'</span>'+
      '<button type="button" class="btn sm ghost" data-cat="'+esc(c)+'" data-on="1">All</button><button type="button" class="btn sm ghost" data-cat="'+esc(c)+'" data-on="0">None</button></summary>'+
      items.map(s=>'<label class="sk-item" data-n="'+esc(s.name)+' '+esc(s.desc).toLowerCase()+'"><input type="checkbox" name="skills" value="'+esc(s.name)+'"'+(sel.has(s.name)?" checked":"")+'>'+
        '<span class="sk-n">'+esc(s.name)+'</span><span class="sk-d">'+esc(s.desc)+'</span></label>').join("")+'</details>';
  }
  host.innerHTML='<div class="sk-sel">'+(sel.size?[...sel].map(x=>'<span class="sk-chip">'+esc(x)+'</span>').join(""):'<span class="meta">None selected — the loop may skip your design skills on UI work.</span>')+'</div>'+
    '<input type="text" id="skq" class="toolbar-input" placeholder="Search skills…" oninput="filterSkills()" style="width:100%;font:inherit;font-size:14px;padding:9px 12px;background:var(--bg);color:var(--fg);border:1px solid var(--line2);border-radius:7px;margin-bottom:12px">'+
    '<form method="POST" action="/skills"><input type="hidden" name="project" value="'+esc(id)+'">'+
    '<div style="border:1px solid var(--line);border-radius:8px;max-height:340px;overflow-y:auto" id="sklist">'+list+'</div>'+
    '<button class="btn primary" style="margin-top:12px">Save required skills</button></form>';
}
function filterSkills(){const q=(document.getElementById("skq")?.value||"").toLowerCase().trim();
  document.querySelectorAll("#sklist .sk-cat").forEach(cat=>{let n=0;
    cat.querySelectorAll(".sk-item").forEach(el=>{const h=!q||el.dataset.n.includes(q);el.style.display=h?"":"none";if(h)n++;});
    cat.style.display=n?"":"none";if(q&&n)cat.open=true;});}
document.addEventListener("click",e=>{const b=e.target.closest&&e.target.closest("[data-cat]");if(!b)return;e.preventDefault();
  document.querySelectorAll('#sklist .sk-cat[data-c="'+b.dataset.cat+'"] input[type=checkbox]').forEach(cb=>cb.checked=b.dataset.on==="1");});

/* ---- logs ---- */
function viewLogs(s,r){
  const run=r.run||{};
  const audit=(r.audit||[]).map(e=>{
    const kind=e.kind==="scope-check"?(e.decision==="IN-SCOPE"?"inscope":"refused"):"";
    const what=e.kind==="scope-check"?('scope '+e.decision+' — '+esc(e.target||"")):(esc(e.cmd||e.kind||"")+(e.flags&&e.flags.project?' · '+esc(e.flags.project):""));
    return '<div class="log '+kind+'"><time>'+(e.ts||"").slice(11,19)+'</time><span class="k">'+esc(e.kind||"")+'</span><span>'+what+'</span></div>';
  }).join("")||'<div class="empty">No audit entries yet</div>';
  const ev=s.events.slice(0,40).map(e=>'<div class="log"><time>'+(e.ts||"").slice(5,16).replace("T"," ")+'</time><span>'+esc(e.msg)+'</span></div>').join("")
    ||'<div class="empty">No activity yet</div>';
  return '<div class="cols"><div class="card"><h2>Loop activity<span class="mono">'+s.events.length+'</span></h2>'+ev+'</div>'+
    '<div><div class="card"><h2>Run state</h2><div class="body">'+
      '<dl class="kv"><dt>Pass</dt><dd>'+(run.lock?"running (held by "+esc(run.lock.holder||"loop")+", "+ago(run.lock.ts)+")":"idle")+'</dd>'+
      '<dt>Dashboard</dt><dd>live via SSE</dd></dl></div></div>'+
    '<div class="card"><h2>Audit log<span class="mono">'+(r.audit||[]).length+'</span></h2>'+audit+'</div></div></div>';
}

/* ---- live stream ---- */
let es=null;
function connect(){
  const pj=qp("project");curProject=pj;
  pj?projSkeleton(pj):homeSkeleton();
  es=new EventSource("/events"+(pj?"?project="+encodeURIComponent(pj):""));
  es.onmessage=(m)=>{try{const d=JSON.parse(m.data);LAST=d;d.projects?homeApply(d.projects):projApply(curProject,d);mark(true);}catch{}};
  es.onerror=()=>mark(false);
}
function mark(ok){const d=document.getElementById("dot"),l=document.getElementById("livemark");
  if(d)d.className="dot"+(ok?"":" off");if(l)l.textContent=ok?"live":"reconnecting…";}
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeDrawer();});
setInterval(()=>{const c=document.getElementById("clk");if(c)c.textContent=new Date().toLocaleTimeString();},1000);
connect();
</script>
</body></html>`;
