import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SCH, ROOT, ensureLayout, makeId, writeJson, writeText } from "./util.mjs";
import { callSeat } from "./seats.mjs";
import { contextTokens } from "./spawn.mjs";
import { runVerification } from "./verifier.mjs";
import { runJudge } from "./judge.mjs";
import { appendLesson, relevantLessons } from "./lessons.mjs";
import { emit } from "./events.mjs";

const execFileP = promisify(execFile);
export const DEFAULT_MAX_ATTEMPTS = 3;

export function decideManager({verificationPassed, judgeVerdict, attempt, maxAttempts}) {
  if (verificationPassed && judgeVerdict === "PASS") return "PASS";
  return attempt < maxAttempts ? "RETRY" : "HUMAN";
}

// Exported so a test can assert the contract it states matches the gate that checks it.
export function builderPrompt({ticket, requirements, lessons, priorRejection, passingRequirements=[]}) {
  return `You are the BUILDER. Your job is to implement this bounded ticket in the current repository.

TICKET
${ticket}

REQUIREMENTS
${requirements}

RELEVANT LESSONS
${lessons.length ? lessons.map(x=>`- ${x.failure} → ${x.preventiveRule}`).join("\n") : "(none)"}

PROTECTED REQUIREMENTS THAT ALREADY PASSED
${passingRequirements.length ? passingRequirements.join("\n") : "(none yet)"}

LAST REJECTION
${priorRejection || "(first attempt)"}

Rules:
- Modify only what the ticket requires.
- Never approve or grade your own work.
- Do not declare PASS.
- On retry, fix only the specific failed requirements.
- Do not rewrite already-passing areas unless strictly necessary.
- If fixing a failed item risks invalidating a passing item, stop and return NEEDS_DECISION with the conflict.
- If requirements conflict or are impossible, stop and return NEEDS_DECISION.
- Finish with a line "FILES CHANGED:" followed by one path per line, then a line "SUMMARY:" with one
  factual sentence. Write each path RELATIVE TO YOUR WORKING DIRECTORY — the same form \`git status\`
  prints when run from where you are, e.g. \`src/todo.mjs\`, never \`sdlc/lab/src/todo.mjs\`. The list is
  compared to git's own answer and a mismatch fails the attempt.`;
}

async function git(cwd,args){
  try {
    const {stdout} = await execFileP("git",args,{cwd,timeout:15000,windowsHide:true,maxBuffer:20_000_000});
    return stdout;
  } catch(e) {
    return e.stdout || "";
  }
}
// `baseRef` is the commit the ticket's worktree started from. It matters because TDD REQUIRES the
// executor to commit (a RED commit, then a GREEN one): against HEAD that work is invisible, the change
// list comes back empty, and a ticket that did everything right is failed for doing nothing. Diffing
// against the base counts committed and uncommitted work alike. Without a base, this falls back to
// HEAD, which is correct only for an executor that never commits.
export async function workspaceEvidence(cwd, baseRef){
  // Two things are load-bearing here.
  //
  // 1. `--relative`: git reports paths from the REPOSITORY root, but a ticket's allowedPaths (and the
  //    builder's own FILES CHANGED claim) are written relative to the PROJECT. Without it, a project
  //    that is a subfolder of its repo fails scope containment on every file.
  // 2. UNTRACKED files must be counted as changes. `git diff` lists only tracked modifications, so a
  //    builder that CREATES a file — the most common way to escape a path boundary — was invisible to
  //    both the scope check and the claims check. `status --porcelain -uall` sees creations.
  const base = baseRef || "HEAD";
  const [diff,names,status,head,branch,prefix] = await Promise.all([
    git(cwd,["diff","--no-ext-diff","--binary","--relative",base]),
    git(cwd,["diff","--name-only","--relative",base]),
    git(cwd,["status","--porcelain","-uall"]),
    git(cwd,["rev-parse","HEAD"]),
    git(cwd,["branch","--show-current"]),
    git(cwd,["rev-parse","--show-prefix"])
  ]);
  const pre = prefix.trim();                    // "" at the repo root, "proj/" in a subfolder project
  const committed = names.split(/\r?\n/).filter(Boolean).map(p=>p.replaceAll("\\","/"));
  const changedFiles=[...new Set([...committed, ...status.split(/\r?\n/).filter(Boolean).flatMap(l=>{
    const body=l.slice(3).trim().replace(/^"|"$/g,"");
    // A rename is "old -> new"; both sides matter for scope, the new side for the claim.
    return body.split(" -> ").map(p=>p.replaceAll("\\","/"));
  }).filter(p=>!pre||p.startsWith(pre)).map(p=>pre?p.slice(pre.length):p).filter(Boolean)])];
  return {
    branch:branch.trim(), head:head.trim(), changedFiles, committed, base,
    status:status.trim(), diff
  };
}
function underAllowed(file, allowedPaths){
  if(!allowedPaths?.length) return false;
  const f=file.replaceAll("\\","/").replace(/^\.\/+/,"");
  return allowedPaths.some(p=>{
    const a=String(p).replaceAll("\\","/").replace(/^\.\/+/,"").replace(/\/+$/,"");
    return f===a || f.startsWith(a+"/");
  });
}
function globRe(g){ return new RegExp("^"+String(g).replaceAll("\\","/").replace(/[.+^${}()|[\]]/g,"\\$&").replace(/\*\*\//g,"(?:.*/)?").replace(/\*\*/g,".*").replace(/\*/g,"[^/]*")+"$","i"); }
function underGlob(file, globs){ const f=file.replaceAll("\\","/").replace(/^\.\/+/,""); return (globs||[]).some(g=>underAllowed(f,[g])||globRe(g).test(f)); }
export function scopeCheck(workspace,allowedPaths,protectedPaths=[]){
  if(!allowedPaths?.length) return {
    name:"scope-containment",ok:false,error:"allowedPaths missing; fail closed",changedFiles:workspace.changedFiles
  };
  const violations=workspace.changedFiles.filter(f=>!underGlob(f,allowedPaths));
  const protectedHits=workspace.changedFiles.filter(f=>underGlob(f,protectedPaths));
  return {name:"scope-containment",ok:violations.length===0&&protectedHits.length===0,violations,protectedHits,changedFiles:workspace.changedFiles};
}
// SSSF gate: the builder's own FILES CHANGED claim must equal git's answer. Missing or wrong = the
// builder does not know what it did, which is exactly when a judge must not trust its summary.
export function claimsCheck(builderMessage, changedFiles){
  const m=String(builderMessage).match(/FILES CHANGED:\s*([\s\S]*?)(?:\n\s*SUMMARY:|$)/i);
  const claimed=m?m[1].split(/\r?\n/).map(x=>x.replace(/^[-*\s]+/,"").trim().replaceAll("\\","/")).filter(x=>x&&!/^\(/.test(x)):[];
  const actual=[...new Set(changedFiles.map(f=>f.replaceAll("\\","/")))];
  const missing=actual.filter(f=>!claimed.includes(f)), extra=claimed.filter(f=>!actual.includes(f));
  return {name:"diff-matches-claims",ok:!!m&&missing.length===0&&extra.length===0,claimed,actual,missing,extra,error:m?undefined:"no FILES CHANGED: block in builder output"};
}

export async function runSelfCorrectingTask({
  ticketId, ticket, requirements, builder, judge,
  verificationChecks=[], cwd=ROOT, maxAttempts=DEFAULT_MAX_ATTEMPTS,
  allowedPaths=[], protectedPaths=[], tags=[], timeoutMs, silenceMs, onEvent, baseRef
}) {
  await ensureLayout();
  if(!ticketId) throw new Error("ticketId required");
  // What counts as a seat is decided in exactly one place — seats.mjs — and this guard has to agree with
  // it. It used to demand providerId or spawn while callSeat had supported a `call` transport all along,
  // so a seat the dispatcher could reach was rejected at the door.
  const seatable = s => !!(s && (typeof s.call === "function" || s.spawn || s.providerId));
  if(!seatable(builder)) throw new Error("builder required: a seat needs spawn argv, providerId, or call()");
  if(!seatable(judge)) throw new Error("judge required: a seat needs spawn argv, providerId, or call()");
  if(!allowedPaths.length) throw new Error("allowedPaths required: SCH-LOOP v2 fails closed on path scope");
  if(maxAttempts < 1 || maxAttempts > 5) throw new Error("maxAttempts must be 1..5");

  const runId=makeId("self-correct");
  const runDir=path.join(SCH,"runs",runId);
  await fs.mkdir(runDir,{recursive:true});
  const starting=await workspaceEvidence(cwd,baseRef);
  const state={
    schemaVersion:2,kind:"self-correcting-build",runId,ticketId,status:"running",phase:"builder",
    maxAttempts,attempt:0,attempts:[],createdAt:new Date().toISOString(),
    managerDecision:null,allowedPaths,startingGit:{branch:starting.branch,head:starting.head,status:starting.status}
  };
  await writeJson(path.join(runDir,"state.json"),state);
  emit("verification.state",{runId,ticketId,state});

  let priorRejection="", passingRequirements=[];

  for(let attempt=1;attempt<=maxAttempts;attempt++){
    state.attempt=attempt; state.phase="builder"; state.managerDecision=null;
    await writeJson(path.join(runDir,"state.json"),state);
    emit("verification.state",{runId,ticketId,state});

    const lessons=await relevantLessons({ticketId,paths:allowedPaths,tags});
    let built;
    try{
      built=await callSeat(builder,{
        system:"You are the bounded implementation Builder in SCH-LOOP. You modify code but never judge completion.",
        prompt:builderPrompt({ticket,requirements,lessons,priorRejection,passingRequirements}),
        cwd,mode:"build",timeoutMs,silenceMs,onEvent
      });
    }catch(e){
      // A dead builder is an attempt, not a crash: the watchdog's recovery ladder lives on this record.
      const run=e.run||{};
      const manager=attempt<maxAttempts?"RETRY":"HUMAN";
      state.attempts.push({attempt,builderMessage:"",manager,reason:`builder-${(run.outcome||"ERROR").toLowerCase()}`,error:e.message,events:run.events||[]});
      priorRejection=`Previous attempt ${attempt} ended with ${run.outcome||"ERROR"}: ${e.message}`;
      state.phase="manager";state.managerDecision=manager;
      if(attempt>=maxAttempts) state.status="needs_decision";
      await writeJson(path.join(runDir,"state.json"),state);
      emit("verification.state",{runId,ticketId,state});
      if(attempt>=maxAttempts) return state;
      continue;
    }
    const builderMessage=built.text;

    if(/NEEDS_DECISION/i.test(String(builderMessage))){
      state.status="needs_decision";state.phase="manager";state.managerDecision="HUMAN";
      state.attempts.push({attempt,builderMessage:String(builderMessage),manager:"HUMAN",reason:"builder-needs-decision"});
      await writeJson(path.join(runDir,"state.json"),state);
      emit("verification.state",{runId,ticketId,state}); return state;
    }

    const workspace=await workspaceEvidence(cwd,baseRef);
    const scope=scopeCheck(workspace,allowedPaths,protectedPaths);
    const claims=claimsCheck(builderMessage,workspace.changedFiles);

    state.phase="verifier"; await writeJson(path.join(runDir,"state.json"),state);
    emit("verification.state",{runId,ticketId,state});
    const verification=await runVerification({runId,ticketId,checks:verificationChecks,cwd});
    verification.checks.unshift(scope,claims);
    verification.passed=verification.passed && scope.ok && claims.ok;
    await writeJson(path.join(SCH,"evidence",runId,ticketId,"verification.json"),verification);

    state.phase="judge"; await writeJson(path.join(runDir,"state.json"),state);
    emit("verification.state",{runId,ticketId,state});
    const judged=await runJudge({
      seat:judge,requirements,cwd,
      output:`GIT STATUS\n${workspace.status}\n\nCHANGED FILES\n${workspace.changedFiles.join("\n")}\n\nACTUAL GIT DIFF\n${workspace.diff}`,
      verification,
      evidenceNotes:`Builder final message (not trusted as evidence):\n${String(builderMessage)}`
    });

    const passed=(judged.parsed.checks||[]).filter(x=>x.status==="PASS").map(x=>x.requirement);
    passingRequirements=[...new Set([...passingRequirements,...passed])];
    const rec={attempt,builderMessage:String(builderMessage),workspace:{changedFiles:workspace.changedFiles,status:workspace.status},verification,judge:judged.parsed,
      usage:built.usage||null,contextTokens:contextTokens(built.usage),costUsd:built.cost??null,sessionId:built.sessionId||null,model:built.model||null,durationMs:built.durationMs??null};

    // MANAGER IS CODE. This is the only place that can accept/retry/escalate.
    const manager = decideManager({verificationPassed:verification.passed, judgeVerdict:judged.parsed.verdict, attempt, maxAttempts});
    if(manager==="PASS"){
      rec.manager="PASS";state.attempts.push(rec);
      state.status="completed";state.phase="manager";state.managerDecision="PASS";
      await writeText(path.join(runDir,"accepted-diff.patch"),workspace.diff);
      await writeJson(path.join(runDir,"state.json"),state);
      emit("verification.state",{runId,ticketId,state});return state;
    }

    rec.manager=manager;
    state.attempts.push(rec);

    for(const f of judged.parsed.failures||[]){
      if(!f.reason)continue;
      await appendLesson({
        source:"judge-rejection",ticketId,category:"verification",
        failure:f.reason,preventiveRule:f.preventiveRule||`Prevent recurrence of ${f.requirement||f.id}`,
        paths:allowedPaths,tags
      });
    }
    if(!scope.ok){
      await appendLesson({
        source:"deterministic-scope-rejection",ticketId,category:"scope",
        failure:`Changed paths outside allowed scope: ${(scope.violations||[]).join(", ")}`,
        preventiveRule:"Restrict every ticket mutation to its explicit allowedPaths.",
        paths:allowedPaths,tags:["scope"]
      });
    }

    priorRejection=JSON.stringify(judged.parsed,null,2);
    state.phase="manager";state.managerDecision=manager;
    await writeJson(path.join(runDir,"state.json"),state);
    emit("verification.state",{runId,ticketId,state});

    if(attempt>=maxAttempts){
      state.status="needs_decision";
      await writeText(path.join(runDir,"escalation.md"),
`# Human escalation

Ticket: ${ticketId}
Attempts: ${attempt}/${maxAttempts}
Manager decision: HUMAN

Last judge verdict:
${priorRejection}

Changed files:
${workspace.changedFiles.join("\n")}
`);
      await writeJson(path.join(runDir,"state.json"),state);
      emit("verification.state",{runId,ticketId,state});return state;
    }
  }
}
