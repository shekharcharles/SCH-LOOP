import fs from "node:fs/promises";
import path from "node:path";
import { COUNCILS, ROOT, ensureLayout, makeId, writeJson, writeText, readJson } from "./util.mjs";
import { callSeat as askSeat } from "./seats.mjs";
import { emit } from "./events.mjs";

const ROLE_PROMPTS={
 architect:"Evaluate architecture, boundaries, coupling, migration, maintainability, interfaces and long-term consequences.",
 security:"Threat-model the decision. Evaluate trust boundaries, authorization, secrets, attack surface, abuse, fail-closed behavior and auditability.",
 implementer:"Evaluate concrete implementation complexity, repository fit, dependencies, migration effort and developer ergonomics.",
 tester:"Try to falsify every proposal. Identify invariants, negative tests, concurrency/recovery cases and acceptance evidence.",
 sre:"Evaluate durability, restartability, idempotency, observability, cancellation, budgets, failure recovery and operational cost.",
 performance:"Evaluate latency, throughput, token/model cost, concurrency and bottlenecks. Distinguish measurement from speculation.",
 minimalist:"Challenge unnecessary components and abstractions. Find the simplest design preserving required safety and outcomes.",
 historian:"Use prior decisions, handoffs, failures and repository precedent. Identify repeated mistakes or conflicting constraints.",
 "devils-advocate":"Attack the emerging consensus. Find shared assumptions and construct the strongest opposing case.",
 skeptic:"Assume the plan is wrong. Name the assumption that has not been tested and the evidence that would settle it.",
 pragmatist:"Find the shortest path to a working result. Prefer what the repository already has over anything new.",
 critic:"Judge the work against the acceptance criteria only. Say plainly which criteria are unmet and why.",
 chair:"Synthesize without majority voting. Score evidence and tradeoffs, preserve dissent, list unknowns and reversal conditions."
};
const SCORE={correctness:25,security:20,maintainability:15,testability:15,complexity:10,performance:5,reversibility:5,evidence:5};

// A seat MUST terminate. Measured: an HTTP seat sat `status: running` for twenty-five minutes against an
// `AbortSignal.timeout(180000)` that never fired — the same model answered in thirteen seconds when
// re-invoked from a fresh process, so the stall was in the long-lived server's connection, not upstream.
// One unbounded seat wedges the whole session (Promise.all) and the console shows RUNNING forever, which
// is worse than a failure: an operator cannot tell a working council from a dead one. Every provider type
// routes through here, so the deadline lives here rather than in each branch of `invokeModel`. The losing
// promise is left dangling on purpose — reclaiming it is undici's problem, and the session must not wait.
const SEAT_TIMEOUT_MS=Number(process.env.SCH_SEAT_TIMEOUT_MS||900000);

// Councils that are running RIGHT NOW in this process, so the operator can stop one. Without this the
// only way to abandon a wrong question — wrong seats, wrong model, a fifteen-minute chair on a typo —
// was to kill the dashboard, which takes every other session with it.
const LIVE=new Map();

// The smallest number of answering seats that is still a council rather than one model with an audience.
export const MIN_SEATS=2;

// Run one debate phase for one seat, letting that seat drop out instead of ending the council.
// Cancellation is not a seat failure: an operator stopping the session must still stop it.
async function tolerate(fn){
  try{ return await fn(); }
  catch(e){ if(/cancelled by the operator/.test(e.message)) throw e; return null; }
}

function withDeadline(promise,ms,label,signal){
  let timer,onAbort;
  const loser=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(`${label} exceeded ${Math.round(ms/1000)}s and was abandoned`)),ms);
    if(signal){
      onAbort=()=>reject(new Error("cancelled by the operator"));
      if(signal.aborted) onAbort(); else signal.addEventListener("abort",onAbort,{once:true});
    }
  });
  return Promise.race([promise,loser]).finally(()=>{
    clearTimeout(timer);
    if(signal&&onAbort) signal.removeEventListener("abort",onAbort);
  });
}

async function persist(dir,state){
  state.updatedAt=new Date().toISOString();
  await writeJson(path.join(dir,"state.json"),state);
  emit("council.state",{councilId:state.id,state});
}
const seatLabel=s=>`${s.role} on ${s.providerId||s.provider||(s.spawn&&s.spawn[0])||"seat"}${s.model?`/${s.model}`:""}`;

async function callSeat(state,dir,seat,phase,prompt){
  const key=`${phase}:${seat.role}`;
  state.agents[key]={role:seat.role,providerId:seat.providerId,model:seat.model,status:"running",startedAt:new Date().toISOString()};
  await persist(dir,state);
  emit("council.agent",{councilId:state.id,phase,role:seat.role,status:"running",providerId:seat.providerId,model:seat.model});
  try{
    const output=await withDeadline(
      askSeat(seat,{prompt,system:ROLE_PROMPTS[seat.role]||`Act as ${seat.role}.`,cwd:ROOT,mode:"review",timeoutMs:SEAT_TIMEOUT_MS}),
      SEAT_TIMEOUT_MS,seatLabel(seat),LIVE.get(state.id)?.signal).then(r=>typeof r==="string"?r:r.text);
    state.agents[key]={...state.agents[key],status:"completed",completedAt:new Date().toISOString(),output};
    emit("council.agent",{councilId:state.id,phase,role:seat.role,status:"completed"});
    return output;
  }catch(e){
    // A cancelled seat did not fail — the operator stopped it. Recording it as `failed` puts an
    // operator's own decision in the same bucket as a broken provider, and the Learning view then
    // counts deliberate stops as engine faults.
    const status=LIVE.get(state.id)?.signal.aborted?"cancelled":"failed";
    state.agents[key]={...state.agents[key],status,completedAt:new Date().toISOString(),error:e.message};
    emit("council.agent",{councilId:state.id,phase,role:seat.role,status,error:e.message});
    throw e;
  }finally{ await persist(dir,state); }
}

export async function startCouncil({question,seats,chair,context={}}){
  await ensureLayout();
  if(!question?.trim()) throw new Error("question required");
  if(!Array.isArray(seats)||seats.length<2) throw new Error("at least two council seats required");
  // A chair is anything callSeat can reach: a roles.json argv, a registry provider, or a test transport.
  if(!chair||(!chair.providerId&&!chair.spawn&&typeof chair.call!=="function")) throw new Error("chair must carry spawn argv, providerId, or call()");
  const id=makeId("council"), dir=path.join(COUNCILS,id);
  await fs.mkdir(path.join(dir,"transcript"),{recursive:true});
  const state={
    schemaVersion:2,id,question,status:"running",phase:"context",
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
    context,seats,chair,score:SCORE,agents:{},proposals:{},critiques:{},rebuttals:{},challenge:null,verdict:null
  };
  await writeText(path.join(dir,"question.md"),`# Council Question\n\n${question}`);
  await writeJson(path.join(dir,"request.json"),{question,seats,chair,context});
  await persist(dir,state);
  LIVE.set(id,new AbortController());

  try{
    state.phase="proposal"; await persist(dir,state);
    // One unreachable seat must not end the debate. On a machine where codex is installed but not logged
    // in, `Promise.all` rejects on that seat and throws away every proposal already paid for, so a council
    // would never convene at all. Seats that answer carry on; the council fails only when too few remain.
    const settled=await Promise.allSettled(seats.map(async seat=>{
      const out=await callSeat(state,dir,seat,"proposal",
`Question:\n${question}\n\nFrozen context:\n${JSON.stringify(context,null,2)}\n\nGive an independent proposal. Do not assume peer opinions. State recommendation, reasons, risks, assumptions, evidence, and what would falsify your position.`);
      state.proposals[seat.role]=out;
      await writeText(path.join(dir,"transcript",`01-proposal-${seat.role}.md`),out);
      return [seat.role,out];
    }));
    const proposals=settled.filter(x=>x.status==="fulfilled").map(x=>x.value);
    state.absentSeats=seats.filter(s=>!(s.role in state.proposals)).map(s=>s.role);
    if(state.absentSeats.length) emit("council.seats_absent",{councilId:id,roles:state.absentSeats});
    if(proposals.length<MIN_SEATS) throw new Error(`only ${proposals.length} of ${seats.length} seats answered; a council needs at least ${MIN_SEATS}`);
    seats=seats.filter(s=>s.role in state.proposals);
    const anonymous=Object.fromEntries(proposals.map(([r,o],i)=>[`P${i+1}`,o]));

    state.phase="critique"; await persist(dir,state);
    for(const seat of seats){
      const out=await tolerate(()=>callSeat(state,dir,seat,"critique",
`Question:\n${question}\n\nPeer proposals are anonymized:\n${JSON.stringify(anonymous,null,2)}\n\nCritique the proposals. Identify strongest and weakest arguments, unsupported assumptions, missing evidence and failure cases.`));
      if(out==null) continue;
      state.critiques[seat.role]=out;
      await writeText(path.join(dir,"transcript",`02-critique-${seat.role}.md`),out);
    }

    state.phase="rebuttal"; await persist(dir,state);
    for(const seat of seats){
      const out=await tolerate(()=>callSeat(state,dir,seat,"rebuttal",
`Question:\n${question}\n\nYour original proposal:\n${state.proposals[seat.role]}\n\nAll critiques:\n${JSON.stringify(state.critiques,null,2)}\n\nRebut, amend or withdraw your proposal. Explicitly acknowledge valid criticism.`));
      if(out==null) continue;
      state.rebuttals[seat.role]=out;
      await writeText(path.join(dir,"transcript",`03-rebuttal-${seat.role}.md`),out);
    }

    state.phase="challenge"; await persist(dir,state);
    let challenger=seats.find(s=>s.role==="devils-advocate")||seats.at(-1);
    // The challenge sharpens a verdict; it is not what makes one valid. A dead challenger costs the
    // council its adversarial pass, not the calls already spent on proposals, critiques and rebuttals.
    state.challenge=await tolerate(()=>callSeat(state,dir,challenger,"challenge",
`Question:\n${question}\n\nProposals:\n${JSON.stringify(state.proposals,null,2)}\n\nRebuttals:\n${JSON.stringify(state.rebuttals,null,2)}\n\nAttack the emerging consensus and shared assumptions. Construct the strongest credible counter-case.`))
      ??"(no adversarial challenge: the challenger seat did not answer)";
    await writeText(path.join(dir,"transcript","04-adversarial-challenge.md"),state.challenge);

    state.phase="synthesis"; await persist(dir,state);
    state.verdict=await callSeat(state,dir,{role:"chair",...chair},"synthesis",
`Question:\n${question}\n\nScoring weights:\n${JSON.stringify(SCORE,null,2)}\n\nProposals:\n${JSON.stringify(state.proposals,null,2)}\n\nCritiques:\n${JSON.stringify(state.critiques,null,2)}\n\nRebuttals:\n${JSON.stringify(state.rebuttals,null,2)}\n\nAdversarial challenge:\n${state.challenge}\n\nProduce the final verdict. Do NOT use simple majority vote. Include: VERDICT, SCORECARD, RATIONALE, MATERIAL DISSENT, UNKNOWNS, REVERSAL CONDITIONS, REQUIRED EVIDENCE/NEXT ACTION.`);
    await writeText(path.join(dir,"verdict.md"),state.verdict);
    state.status="completed"; await persist(dir,state);
    emit("council.completed",{councilId:id});
    return state;
  }catch(e){
    state.status=LIVE.get(id)?.signal.aborted?"cancelled":"failed";
    state.error=e.message; await persist(dir,state); throw e;
  }finally{ LIVE.delete(id); }
}

// Stop a council the operator no longer wants. Only sessions live in THIS process can be stopped, which
// is every session that can legitimately still be running — `reapAbandonedCouncils` has already settled
// the rest at boot. Returns false rather than throwing when there is nothing to stop, so a double-click
// on CANCEL is not an error.
export function cancelCouncil(id){
  const ac=LIVE.get(id);
  if(!ac||ac.signal.aborted) return false;
  ac.abort();
  emit("council.cancelled",{councilId:id});
  return true;
}

export async function listCouncils(){
  await ensureLayout();
  const names=await fs.readdir(COUNCILS).catch(()=>[]);
  const out=[];
  for(const n of names){
    const s=await readJson(path.join(COUNCILS,n,"state.json"));
    if(s) out.push(s);
  }
  return out.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
}
export async function getCouncil(id){ return await readJson(path.join(COUNCILS,id,"state.json")); }

// A council only ever runs inside this process, so a `running` record found at startup belongs to a
// process that is gone. Left alone it is a permanent lie: the console shows RUNNING, the seat rows show
// RUNNING, and no code path will ever move it. Reaped once on boot, before the first read.
export async function reapAbandonedCouncils(){
  await ensureLayout();
  const names=await fs.readdir(COUNCILS).catch(()=>[]);
  let reaped=0;
  for(const n of names){
    const dir=path.join(COUNCILS,n);
    const s=await readJson(path.join(dir,"state.json"));
    if(!s||s.status!=="running") continue;
    s.status="failed";
    s.error=`abandoned in the ${s.phase} phase — the server restarted while it was running`;
    for(const [k,a] of Object.entries(s.agents||{})){
      if(a.status==="running") s.agents[k]={...a,status:"failed",completedAt:new Date().toISOString(),error:"abandoned by a server restart"};
    }
    await persist(dir,s);
    reaped++;
  }
  return reaped;
}
