#!/usr/bin/env node
// SCH Loop dashboard — LIVE (SSE), no-flicker, fluid. Zero dependencies.
// Server pushes state over Server-Sent Events whenever state.json changes; the
// client patches only the sections that changed and never touches a section you
// are typing in. Binds 0.0.0.0 (Tailscale). Set SCH_BIND to a Tailscale IP to
// hide it from the local LAN.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadRegistry, saveRegistry, loadState, getProject, event, saveState, OFFENSIVE, suggestInterval } from "./state.mjs";

// must resolve the same way state.mjs does, or the dashboard would watch a
// different directory than the one being written to
const ROOT = process.env.SCH_HOME || join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS_DIR = join(ROOT, "projects");
const REGISTRY = join(ROOT, "projects.json");
const PORT = process.env.SCH_PORT || 4600;
const BIND = process.env.SCH_BIND || "0.0.0.0";
const json = (res, b) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };

// ---- data shapes pushed to clients ----
function rollup() {
  const reg = loadRegistry();
  return reg.projects.map((p) => {
    const s = loadState(p.id);
    const c = (st) => s.tasks.filter((t) => t.status === st).length;
    const total = s.tasks.filter((t) => t.status !== "superseded").length, done = c("merged");
    const status = total === 0 ? "new" : (c("stuck") || c("blocked")) ? "attention" : done === total ? "completed" : (c("building") || c("review") || c("changes")) ? "active" : "inprogress";
    // Blockers travel with the rollup so the home page can answer questions from
    // every project at once — the operator is on a phone and should not have to
    // open each project to discover which one is waiting on them.
    const blockers = s.tasks.filter((t) => t.status === "blocked" || t.status === "stuck")
      .map((t) => ({ id: t.id, title: t.title, notes: t.notes || "", status: t.status }));
    return { id: p.id, name: p.name, domain: p.domain, offensive: OFFENSIVE.has(p.domain), authorized: p.scope?.authorized ?? false, halt: p.scope?.halt ?? false, status, total, done, pending: c("queued"), building: c("building"), review: c("review"), blocked: c("blocked"), stuck: c("stuck"), findings: (s.findings || []).length, inboxNew: s.inbox.filter((i) => i.status === "new").length, pct: total ? Math.round(done / total * 100) : 0, run: s.run || null, blockers };
  });
}
const snapshot = (project) => {
  if (!project) return { projects: rollup() };
  if (!getProject(project)) return { error: "gone" };
  const state = loadState(project);
  // recomputed from the live queue every push — the right interval changes as the
  // queue drains or the loop ends up waiting on the operator
  return { project: getProject(project), state, advice: suggestInterval(state) };
};

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
const CSRF = randomUUID();
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
    if (p.get("csrf") !== CSRF) return forbid(res);
    const back = (id) => { res.writeHead(303, { location: id ? "/?project=" + encodeURIComponent(id) : "/" }); res.end(); };
    if (url.pathname === "/inbox") {
      const project = p.get("project"), text = (p.get("text") || "").trim();
      if (project && text && getProject(project)) { const s = loadState(project); s.inbox.unshift({ id: ++s.seq.inbox, text, status: "new", createdAt: new Date().toISOString() }); event(s, `inbox +: ${text.slice(0, 60)}`); saveState(project, s); }
      return back(project);
    }
    if (url.pathname === "/answer") {
      const project = p.get("project"), id = Number(p.get("id")), text = (p.get("text") || "").trim();
      if (getProject(project) && text) {
        const s = loadState(project); const t = s.tasks.find((x) => x.id === id);
        if (t) {
          // Preserve the QUESTION — overwriting notes with the answer destroyed the
          // option list, leaving a bare letter the loop could not resolve.
          if (!t.question) t.question = t.notes || "";
          t.answers = [...(t.answers || []), { text, ts: new Date().toISOString() }];
          t.status = "queued"; t.priority = 1;
          t.notes = "ANSWERED: " + text + (t.question ? "\n\nQUESTION ASKED: " + t.question : "");
          t.updatedAt = new Date().toISOString();
          event(s, `task #${id} answered "${text.slice(0, 40)}" -> requeued p1`);
          saveState(project, s);
        }
      }
      return back(p.get("back") === "home" ? null : project);
    }
    if (url.pathname === "/inbox-del") {
      const project = p.get("project"), id = Number(p.get("id"));
      if (getProject(project)) {
        const s = loadState(project);
        const item = s.inbox.find((i) => i.id === id);
        if (item) { s.inbox = s.inbox.filter((i) => i.id !== id); event(s, `inbox item #${id} deleted: ${item.text.slice(0, 60)}`); saveState(project, s); }
      }
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
    return forbid(res);
  }

  if (url.pathname === "/api/projects") return json(res, rollup());
  if (url.pathname === "/api/state") { const s = snapshot(url.searchParams.get("project")); return json(res, s); }
  if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE.replace("__CSRF__", CSRF)); return; }
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
  /* LIVE WORK TREE: category › phase › tasks. Everything visible at once. */
  .phase-strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:10px;align-items:start}
  .cat{border:1px solid var(--line);background:var(--panel)}
  .cat-h{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:8px 11px;
         background:#151515;border-bottom:1px solid var(--line);font-size:11px;text-transform:uppercase;letter-spacing:.1em}
  .cat-n{color:var(--fg);font-weight:700}.cat-c{color:var(--dim);font-size:10px}
  .ph{border-top:1px solid var(--line)}
  .ph:first-of-type{border-top:0}
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
  .ibx{border:1px solid var(--line);border-left:2px solid var(--amber);background:var(--panel);margin-bottom:6px}
  .ibx-h{display:flex;align-items:center;gap:10px;padding:8px 10px;background:#141414;cursor:pointer;list-style:none}
  .ibx-h::-webkit-details-marker{display:none}
  .ibx-h::before{content:"▸";color:var(--amber);flex:none}
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
  .bar2{display:inline-block;width:64px;height:8px;background:#222;border:1px solid var(--line);vertical-align:middle;margin-right:6px}.bar2 span{display:block;height:100%;background:var(--green)}
  .pctn{font-size:11px;color:var(--dim)}.in{background:var(--red);color:#fff;padding:1px 7px;font-weight:700;font-size:11px}
  table.projects tbody tr{cursor:pointer}table.projects tbody tr:hover td{background:#181818}
  .chips{display:flex;flex-wrap:wrap;gap:1px;background:var(--line);border:1px solid var(--line)}
  .chip{background:var(--panel);padding:8px 11px;flex:1;min-width:82px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}.chip b{display:block;font-size:clamp(15px,2vw,18px);color:var(--fg);line-height:1;margin-bottom:2px}
  .chip.active b{color:var(--amber)}.chip.inprogress b,.chip.review b{color:var(--blue)}.chip.completed b{color:var(--green)}.chip.attention b,.chip.awaiting b,.chip.failed b{color:var(--red)}
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
let taskFilter={q:"",status:"",showSuperseded:false};
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
function loopBar(run,advice){
  const h=loopHealth(run);
  const m=advice?advice.minutes:30;
  // --project is auto-detected from the folder the terminal is in; showing it
  // makes the command longer than it needs to be.
  let s='<div class="loop '+h.cls+'"><span class="lb"></span><b>'+h.label+'</b>'+
    '<span class="lx">'+esc(h.detail)+'</span>'+
    (h.dead?'<span class="lx">start it:</span><span class="cmd">/loop '+m+'m /sch-run</span>':'')+
    '</div>';
  // The right interval is not a fixed preference — it depends on what the queue
  // looks like right now, so say what it should be and why.
  if(advice){
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
// A DECISION task carries its options as words. Pull them out so the answer is
// one tap instead of typing the exact token on a phone keyboard.
function parseOpts(notes){
  const t=(notes||"");
  const out=[];
  // explicit list: "OPTIONS: sign | encrypt | https-only"
  const m=t.match(/options?\\s*[:\\-]\\s*([^\\n]+)/i);
  if(m)for(const x of m[1].split(/[|\\/,]/))push(x);
  // inline alternation: "sign / encrypt / https-only" or \`sign\` / \`encrypt\`
  for(const g of t.matchAll(/\`?\\b([a-z][a-z0-9-]{1,24})\`?(?:\\s*\\/\\s*\`?([a-z][a-z0-9-]{1,24})\`?){1,4}/g)){
    for(const x of g[0].split("/"))push(x);
  }
  function push(x){
    const v=x.replace(/[\`'"]/g,"").trim();
    if(v&&v.length<=24&&!out.includes(v)&&!/^(and|or|the|a|an|of|to)$/.test(v))out.push(v);
  }
  return out.slice(0,5);
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
  const opts=parseOpts(t.notes);
  return '<form class="ans ansform" method="POST" action="/answer">'+csrf+
    (home?'<input type="hidden" name="back" value="home">':'')+
    '<input type="hidden" name="project" value="'+esc(pid)+'"><input type="hidden" name="id" value="'+t.id+'">'+
    (opts.length?'<div class="opts">'+opts.map(o=>'<button type="submit" class="opt" name="text" value="'+esc(o)+'" title="Answer: '+esc(o)+'">'+esc(o)+'</button>').join("")+'</div>':'')+
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
    <section id="devsec"></section>
    <section id="secsec"></section>\`;
  CACHE.xattn=CACHE.pchips=CACHE.devsec=CACHE.secsec=undefined;
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
      '<div class="q">'+esc(t.notes||"(open the project)")+'</div>'+answerBlock(p.id,t,true)+'</div>').join("")+
    '</div>':"");
  const by=(c)=>ps.filter(p=>p.status===c).length;
  set("pchips",'<div class="chips">'+[["active",by("active"),"active"],["in progress",by("inprogress"),"inprogress"],["failed / awaiting",by("attention"),"attention"],["completed",by("completed"),"completed"],["new",by("new"),"new"]].map(([n,v,c])=>\`<div class="chip \${c}"><b class="mono">\${v}</b>\${n}</div>\`).join("")+'</div>');
  // split by kind, then apply the search
  const q=projQ.trim().toLowerCase();
  const match=(p)=>!q||((p.name+" "+p.id+" "+p.domain).toLowerCase().includes(q));
  const dev=ps.filter(p=>!p.offensive&&match(p));
  const sec=ps.filter(p=>p.offensive&&match(p));
  set("devsec",projTable("development",dev,q?"no development project matches":"no development projects — run /sch-spec",false));
  set("secsec",projTable("security // pentest",sec,q?"no engagement matches":"no engagements — run /sch-spec with a target",true));
}

// ---------- PROJECT ----------
function projSkeleton(id){
  document.getElementById("app").innerHTML=\`
    <div class="bar"><a class="back" href="/">‹ ALL PROJECTS</a><span><span class="dot"></span><span id="livemark" class="live">live</span></span><span class="mono" id="clk"></span></div>
    <h1 id="pname">…</h1><div class="sub" id="pmeta"></div>
    <section id="loop"></section>
    <section id="brief"></section>
    <section id="attn"></section>
    <section id="scope"></section>
    <section id="chips"></section>
    <form class="row-form" method="POST" action="/inbox">\${csrf}<input type="hidden" name="project" value="\${esc(id)}"><input type="text" name="text" title="Describe a feature, fix or lead — the next loop pass reasons it into the right place in the queue" placeholder="NEW LEAD / TASK / FEATURE — reasoned into the queue next pass" autocomplete="off" required><button title="Send to the inbox — the next loop pass plans it into the queue">Add</button></form>
    <section id="inboxsec"></section>
    <section id="phase"></section>
    <section id="tasksec"></section>
    <section id="findsec"></section>
    <details class="box"><summary>activity log</summary><div class="boxin"><section id="actsec"></section></div></details>\`;
  for(const k in CACHE)delete CACHE[k];
}
// every action button carries a tooltip + aria-label so an icon is never mystery meat
const ACT_TIP={bump:"Bump to the front of the queue (priority 1)",hold:"Put on hold — moves to awaiting, loop skips it",
  requeue:"Requeue — put it back in the queue to be retried",close:"Close as superseded — replaced by other tasks, stop showing it"};
function actForm(pid,id,a,l,c){const tip=ACT_TIP[a]||a;
  return \`<form class="inl" method="POST" action="/task">\${csrf}<input type="hidden" name="project" value="\${esc(pid)}"><input type="hidden" name="id" value="\${id}"><input type="hidden" name="action" value="\${a}"><button class="mini \${c||''}" title="\${tip}" aria-label="\${tip}">\${l}</button></form>\`;}
function projApply(id,r){
  if(r.error){location.href="/";return;}
  const p=r.project,s=r.state,sc=p.scope||{},by=(st)=>s.tasks.filter(t=>t.status===st);
  document.getElementById("clk").textContent=clock();
  document.getElementById("pname").textContent=p.name;
  document.getElementById("pmeta").innerHTML=\`\${esc(p.domain)} · \${esc(p.path)||"no path"} \${OFF(p.domain)?(sc.authorized?'<span class="badge b-auth">authorized</span>':'<span class="badge b-off">unauthorized</span>'):''}\${sc.halt?' <span class="badge b-halt">halt</span>':''}\`;
  set("loop",loopBar(s.run,r.advice));
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
      attnHtml+='<div class="attn-row"><div><span class="st st-'+t.status+'">'+(t.status==="blocked"?"AWAITING":"FAILED")+'</span> <span class="id">TASK #'+t.id+'</span> <strong>'+esc(t.title)+'</strong></div><div class="q">'+esc(t.notes||"(open the task)")+'</div>'+
        answerBlock(id,t)+
        actForm(id,t.id,"close","&#10005; close (superseded)")+'</div>';
    }
    attnHtml+='</div>';
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
  const done=by("merged").length,total=s.tasks.filter(t=>t.status!=="superseded").length,pct=total?Math.round(done/total*100):0;
  const finds=s.findings||[];
  set("chips",'<div class="chips">'+[["active",by("building").length,"active"],["in progress",by("review").length+by("changes").length,"inprogress"],["queued",by("queued").length,""],["completed",done,"completed"],["awaiting",by("blocked").length,"awaiting"],["failed",by("stuck").length,"failed"],["findings",finds.length,""]].map(([n,v,c])=>\`<div class="chip \${c}"><b class="mono">\${v}</b>\${n}</div>\`).join("")+'</div>');
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
    const cd=all.filter(t=>t.status==="merged").length;
    const nPh=Object.keys(phases).length;
    const catRunning=all.some(t=>RUNNING.has(t.status));
    const catPct=all.length?Math.round(cd/all.length*100):0;
    phHtml+='<div class="cat'+(catRunning?' running':'')+'"><div class="cat-h"><span class="cat-n">'+esc(cat)+'</span>'+
      '<span class="cat-c mono">'+nPh+' phase'+(nPh>1?'s':'')+' · '+cd+'/'+all.length+' done · '+catPct+'%</span></div>';
    for(const name of Object.keys(phases)){
      const list=phases[name], d=list.filter(t=>t.status==="merged").length;
      const phRunning=list.some(t=>RUNNING.has(t.status));
      phHtml+='<div class="ph'+(phRunning?' running':'')+'">'+
        '<div class="ph-h"><span class="ph-n">'+esc(name)+'</span><span class="ph-c mono">'+d+'/'+list.length+'</span>'+
        '<div class="pbar"><i style="width:'+(list.length?Math.round(d/list.length*100):0)+'%"></i></div></div>';
      const sorted=list.sort((a,b)=>(a.priority??3)-(b.priority??3)||a.id-b.id);
      const open=sorted.filter(t=>t.status!=="merged"), doneList=sorted.filter(t=>t.status==="merged");
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
  // tasks
  const stL=(x)=>STMAP[x]||[x.toUpperCase(),""];
  const rowActs=(t)=>t.status==="queued"?actForm(id,t.id,"bump","▲")+actForm(id,t.id,"hold","⏸"):(t.status==="blocked"||t.status==="stuck")?actForm(id,t.id,"requeue","↻","go"):"";
  let ts=s.tasks.slice().sort((a,b)=>(a.priority??3)-(b.priority??3)||a.phase-b.phase||a.id-b.id);
  // superseded = replaced by smaller/other tasks; hidden unless explicitly shown
  if(!taskFilter.showSuperseded && taskFilter.status!=="superseded")ts=ts.filter(t=>t.status!=="superseded");
  if(taskFilter.status)ts=ts.filter(t=>t.status===taskFilter.status);
  // searching "inbox#6" lists exactly what that submission became
  if(taskFilter.q){const q=taskFilter.q.toLowerCase();ts=ts.filter(t=>(t.title+" "+(t.notes||"")+" "+(t.source||"")+" P"+t.phase).toLowerCase().includes(q));}
  const trows=ts.map(t=>{const[lab,cl]=stL(t.status);return \`<tr class="\${cl}"><td data-l="#" class="id">\${t.id}</td>
    <td data-l="Task"><strong>\${esc(t.title)}</strong>\${t.active?' <span class="badge b-off">active</span>':''}\${srcChip(t)}\${(t.skills&&t.skills.length)?'<div class="skl">'+t.skills.map(x=>'<span>'+esc(x)+'</span>').join("")+'</div>':''}</td>
    <td data-l="Phase">\${t.category?'<span class="catchip">'+esc(t.category)+'</span> ':''}\${esc(t.phaseName||("P"+t.phase))}</td><td data-l="Pri">\${t.priority??3}</td>
    <td data-l="Status"><span class="st \${cl}">\${lab}</span></td>
    <td data-l="Target">\${esc(t.target||"—")}</td>
    <td data-l="Activity">\${esc(t.notes||t.branch||"—")}</td>
    <td data-l="" class="ac">\${rowActs(t)}</td></tr>\`;}).join("")||'<tr><td colspan="8" class="empty">no tasks match</td></tr>';
  const statuses=["","queued","building","review","changes","blocked","stuck","merged","superseded"];
  const supN=s.tasks.filter(t=>t.status==="superseded").length;
  set("tasksec",'<h2>tasks<span class="n mono">'+ts.length+' shown / '+total+'</span></h2>'+
    '<div class="toolbar"><input id="tq" placeholder="filter tasks…" title="Filter by task title, note or phase" value="'+esc(taskFilter.q)+'" oninput="taskFilter.q=this.value;reapplyTasks()">'+
    '<select id="ts" title="Show only tasks in this status" onchange="taskFilter.status=this.value;reapplyTasks()">'+statuses.map(x=>'<option value="'+x+'"'+(x===taskFilter.status?' selected':'')+'>'+(x?x:'all statuses')+'</option>').join("")+'</select>'+
    (supN?'<button class="mini" title="Superseded = tasks replaced by other/smaller tasks. Their work still exists elsewhere; hidden by default to keep the queue clean." onclick="taskFilter.showSuperseded=!taskFilter.showSuperseded;reapplyTasks()">'+(taskFilter.showSuperseded?'hide':'show')+' superseded ('+supN+')</button>':'')+'</div>'+
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
  // Inbox: what you submitted, waiting for the next loop pass to plan it.
  // Full text (so you can re-read what you sent) + delete if you change your mind.
  // Inbox: what you submitted, waiting for the next pass to plan it. Collapsed —
  // a submission is a receipt, not a working surface; the queue is what matters.
  // INBOX #n is the trace id: tasks planned from it are tagged with the same id.
  set("inboxsec",nb.length?'<h2>inbox — waiting to be planned by the next loop pass<span class="n mono">'+nb.length+'</span></h2>'+
    nb.map(i=>'<details class="ibx"><summary class="ibx-h"><span class="ibx-id">INBOX #'+i.id+'</span>'+
      '<span class="ibx-t mono">submitted '+esc(i.createdAt.slice(0,16).replace("T"," "))+'</span>'+
      '<span class="ibx-pv">'+esc(i.text.replace(/\\s+/g," ").slice(0,70))+(i.text.length>70?'…':'')+'</span></summary>'+
      '<div class="ibx-b">'+esc(i.text)+'</div>'+
      '<div class="ibx-f"><form class="inl confirm-del" method="POST" action="/inbox-del">'+csrf+
      '<input type="hidden" name="project" value="'+esc(id)+'"><input type="hidden" name="id" value="'+i.id+'">'+
      '<button class="mini danger" title="Delete this submission before the loop plans it">delete</button></form></div>'+
      '</details>').join(""):"");
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
