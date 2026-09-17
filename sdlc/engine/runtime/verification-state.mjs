import fs from "node:fs/promises";
import path from "node:path";
import { SCH, ensureLayout, readJson, writeJson } from "./util.mjs";

export async function listVerificationRuns(){
  await ensureLayout();
  const runsDir=path.join(SCH,"runs");
  const names=await fs.readdir(runsDir).catch(()=>[]);
  const out=[];
  for(const n of names){
    const s=await readJson(path.join(runsDir,n,"state.json"));
    if(s?.schemaVersion===2 && Array.isArray(s.attempts) && s.ticketId) out.push(s);
  }
  return out.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
}
export async function getVerificationRun(id){
  return await readJson(path.join(SCH,"runs",id,"state.json"));
}

// Same failure as an abandoned Council, in the other half of the console: a self-correcting loop runs
// in-process, so a `running` record found at startup belongs to a process that no longer exists and
// nothing will ever move it. Four such records were sitting in the Verification view claiming to be live.
// Settled once on boot, before the first read, so the console never shows a dead run as live.
export async function reapAbandonedVerificationRuns(){
  await ensureLayout();
  const runsDir=path.join(SCH,"runs");
  const names=await fs.readdir(runsDir).catch(()=>[]);
  let reaped=0;
  for(const n of names){
    const p=path.join(runsDir,n,"state.json");
    const s=await readJson(p);
    if(s?.status!=="running") continue;
    s.status="failed";
    s.error="abandoned — the server restarted while this run was in flight";
    s.updatedAt=new Date().toISOString();
    await writeJson(p,s);
    reaped++;
  }
  return reaped;
}
