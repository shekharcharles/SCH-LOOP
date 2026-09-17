import path from "node:path";
import fs from "node:fs/promises";
import { SCH, ensureLayout, readJson, writeJson, writeText, makeId } from "./util.mjs";
import { emit } from "./events.mjs";

const STATE=()=>path.join(SCH,"workflow.json");
export const PHASES=["brainstorm","spec","plan","tickets","build","council","build","review","ship","learn"];

export async function workflowState(){
  await ensureLayout();
  return await readJson(STATE(),{
    version:2,phase:"brainstorm",history:[],artifacts:{},
    phaseStartedAt:null,
    recommendedNext:"/sch brainstorm"
  });
}
export async function recordPhase({phase,status="completed",artifact,summary}){
  const s=await workflowState();
  const now=new Date().toISOString();
  // When this phase was ENTERED, not merely when the record was last touched. Without it the dashboard
  // cannot answer the only question a lifecycle diagram is asked — is this moving, or has it been sitting
  // here for forty minutes? Stamped on the transition, so it survives restarts and re-reads.
  if(s.phase!==phase || !s.phaseStartedAt) s.phaseStartedAt=now;
  s.phase=phase; s.updatedAt=now;
  s.history.push({phase,status,at:s.updatedAt,artifact,summary});
  if(artifact) s.artifacts[phase]=artifact;
  const firstBuild=s.history.filter(x=>x.phase==="build").length===1;
  const next={
    brainstorm:"/sch spec", spec:"/sch plan", plan:"/sch tickets",
    tickets:"/sch build", build:firstBuild?"/sch council":"/sch review",
    council:"/sch build", review:"/sch ship", ship:"/sch learn", learn:"done"
  }[phase]||"/sch status";
  s.recommendedNext=next;
  await writeJson(STATE(),s);
  emit("workflow.state",{state:s});
  return s;
}
export async function initWorkspace(){
  await ensureLayout();
  const cfg=path.join(SCH,"config.md");
  try{await fs.access(cfg);}catch{
    await writeText(cfg,`# SCH-LOOP Repository Configuration

- Workflow: brainstorm → spec → plan → tickets → build → council → build → review → ship → learn
- Canonical task queue: .sch-loop/tasks/queue.md
- Council debates are read-only and advisory until promoted through the normal workflow.
- Dashboard runtime state and provider secrets are local-only.
`);
  }
  return await workflowState();
}
