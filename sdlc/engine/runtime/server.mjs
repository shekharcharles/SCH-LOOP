import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCLIs, getProviders, saveEndpoint, fetchModels, setProviderPrefs, addProviderModel, probeModel } from "./providers.mjs";
import { startCouncil, listCouncils, getCouncil, reapAbandonedCouncils, cancelCouncil } from "./council.mjs";
import { runSelfCorrectingTask } from "./self-correct.mjs";
import { listVerificationRuns, getVerificationRun, reapAbandonedVerificationRuns } from "./verification-state.mjs";
import { initWorkspace, workflowState } from "./workflow.mjs";
import { readLessons } from "./lessons.mjs";
import { readJsonBody } from "./util.mjs";
import { bus } from "./events.mjs";

const here=path.dirname(fileURLToPath(import.meta.url));
const pub=path.resolve(here,"../dashboard/public");
const defaults=JSON.parse(await fs.readFile(path.resolve(here,"../config/defaults.json"),"utf8"));
await initWorkspace();

function send(res,status,body,type="application/json"){
  // A response without a charset is a response the browser gets to guess about. Every byte this server
  // emits is UTF-8; say so.
  res.writeHead(status,{"content-type":`${type}; charset=utf-8`,"cache-control":"no-store"});
  res.end(type==="application/json"?JSON.stringify(body):body);
}
const body=readJsonBody;
// A dashboard that dies is worse than one that reports a failure. One seat pointed at a model its
// provider rejects used to kill this process outright (ReferenceError inside a child-process handler),
// taking every running Council with it. Log and keep serving.
process.on("uncaughtException", e => console.error("uncaught:", e?.stack || e));
process.on("unhandledRejection", e => console.error("unhandled rejection:", e?.stack || e));

const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,`http://${req.headers.host||"localhost"}`);
  if(req.method==="GET"&&url.pathname==="/api/events"){
    res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache","connection":"keep-alive"});
    res.write(`event: ready\ndata: {}\n\n`);
    const fn=e=>res.write(`data: ${JSON.stringify(e)}\n\n`);
    bus.on("event",fn);req.on("close",()=>bus.off("event",fn));return;
  }
  // A missing favicon was answering 500 and logging a console error on every page load.
  if(url.pathname==="/favicon.ico"){ res.writeHead(204); return res.end(); }
  if(req.method==="GET"&&url.pathname==="/api/status") return send(res,200,{
    workflow:await workflowState(),providers:await getProviders(),
    councils:await listCouncils(),verifications:await listVerificationRuns()
  });
  if(req.method==="GET"&&url.pathname==="/api/providers") return send(res,200,await getProviders());
  if(req.method==="POST"&&url.pathname==="/api/providers/discover") return send(res,200,await discoverCLIs({fresh:true}));
  if(req.method==="POST"&&url.pathname==="/api/providers/endpoints") return send(res,201,await saveEndpoint(await body(req)));
  // Which models this provider can be pinned to, so a Council seat names a model instead of inheriting
  // whatever the CLI defaults to.
  const mm=url.pathname.match(/^\/api\/providers\/(.+)\/models$/);
  if(req.method==="GET"&&mm) return send(res,200,await fetchModels(decodeURIComponent(mm[1])));
  // Include/exclude a provider from the Council, and pin its model. Persisted separately from discovery,
  // which rebuilds CLI entries on every call.
  const mt=url.pathname.match(/^\/api\/providers\/(.+)\/probe$/);
  if(req.method==="POST"&&mt) return send(res,200,await probeModel({id:decodeURIComponent(mt[1]),...(await body(req))}));
  const ma=url.pathname.match(/^\/api\/providers\/(.+)\/models$/);
  if(req.method==="POST"&&ma) return send(res,201,await addProviderModel({id:decodeURIComponent(ma[1]),...(await body(req))}));
  const mp=url.pathname.match(/^\/api\/providers\/(.+)\/prefs$/);
  if(req.method==="POST"&&mp) return send(res,200,await setProviderPrefs({id:decodeURIComponent(mp[1]),...(await body(req))}));
  let m=url.pathname.match(/^\/api\/providers\/([^/]+)\/models$/);
  if(req.method==="GET"&&m) return send(res,200,await fetchModels(decodeURIComponent(m[1])));

  if(req.method==="GET"&&url.pathname==="/api/councils") return send(res,200,await listCouncils());
  m=url.pathname.match(/^\/api\/councils\/([^/]+)$/);
  if(req.method==="GET"&&m) return send(res,200,(await getCouncil(m[1]))||{error:"not found"});
  m=url.pathname.match(/^\/api\/councils\/([^/]+)\/cancel$/);
  if(req.method==="POST"&&m) return send(res,200,{cancelled:cancelCouncil(m[1])});
  if(req.method==="POST"&&url.pathname==="/api/councils"){
    const input=await body(req);send(res,202,{accepted:true});
    startCouncil(input).catch(e=>console.error("Council failed:",e));return;
  }

  if(req.method==="GET"&&url.pathname==="/api/verifications") return send(res,200,await listVerificationRuns());
  m=url.pathname.match(/^\/api\/verifications\/([^/]+)$/);
  if(req.method==="GET"&&m) return send(res,200,(await getVerificationRun(m[1]))||{error:"not found"});
  if(req.method==="POST"&&url.pathname==="/api/verifications"){
    const input=await body(req);
    if(!input.cwd) input.cwd=process.env.SCH_PROJECT_ROOT||process.cwd();
    send(res,202,{accepted:true});
    runSelfCorrectingTask(input).catch(e=>console.error("Verification loop failed:",e));return;
  }
  if(req.method==="GET"&&url.pathname==="/api/lessons") return send(res,200,await readLessons());

  let file=url.pathname==="/"?"index.html":url.pathname.slice(1);
  file=path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const target=path.join(pub,file);
  const ext=path.extname(target);
  const type={".html":"text/html",".js":"text/javascript",".css":"text/css"}[ext]||"text/plain";
  return send(res,200,await fs.readFile(target,"utf8"),type);
 }catch(e){if(!res.headersSent)send(res,500,{error:e.message});else res.end();}
});
server.listen(defaults.dashboard.port,defaults.dashboard.host,async ()=>{
  console.log(`SCH-LOOP v2 dashboard: http://${defaults.dashboard.host}:${defaults.dashboard.port}`);
  const reaped=await reapAbandonedCouncils().catch(e=>{console.error("council reap failed:",e.message);return 0;});
  if(reaped) console.log(`reaped ${reaped} council session(s) abandoned by a previous run`);
  const reapedRuns=await reapAbandonedVerificationRuns().catch(e=>{console.error("verification reap failed:",e.message);return 0;});
  if(reapedRuns) console.log(`reaped ${reapedRuns} verification run(s) abandoned by a previous run`);
});
