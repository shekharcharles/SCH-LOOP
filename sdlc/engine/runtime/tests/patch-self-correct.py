import io, sys, os
os.chdir(os.path.join(os.path.dirname(__file__), ".."))

def patch(path, pairs):
    s = open(path, encoding="utf8").read()
    for old, new in pairs:
        if old not in s:
            print("MISSING in", path, ":", old[:70].replace("\n", "\\n")); sys.exit(1)
        s = s.replace(old, new, 1)
    open(path, "w", encoding="utf8", newline="\n").write(s)

patch("self-correct.mjs", [
('import { invokeModel } from "./providers.mjs";',
 'import { callSeat } from "./seats.mjs";\nimport { contextTokens } from "./spawn.mjs";'),

('- Finish by stating only a compact factual summary of files changed and checks you ran.`;',
 '- Finish with a line "FILES CHANGED:" followed by one repository-relative path per line, then a line "SUMMARY:" with one factual sentence. The list is checked against git; a mismatch fails the attempt.`;'),

('''export function scopeCheck(workspace,allowedPaths){
  if(!allowedPaths?.length) return {
    name:"scope-containment",ok:false,error:"allowedPaths missing; fail closed",changedFiles:workspace.changedFiles
  };
  const violations=workspace.changedFiles.filter(f=>!underAllowed(f,allowedPaths));
  return {name:"scope-containment",ok:violations.length===0,violations,changedFiles:workspace.changedFiles};
}''',
r'''function globRe(g){ return new RegExp("^"+String(g).replaceAll("\\","/").replace(/[.+^${}()|[\]]/g,"\\$&").replace(/\*\*\//g,"(?:.*/)?").replace(/\*\*/g,".*").replace(/\*/g,"[^/]*")+"$","i"); }
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
}'''),

('''  verificationChecks=[], cwd=ROOT, maxAttempts=DEFAULT_MAX_ATTEMPTS,
  allowedPaths=[], tags=[]
}) {''',
'''  verificationChecks=[], cwd=ROOT, maxAttempts=DEFAULT_MAX_ATTEMPTS,
  allowedPaths=[], protectedPaths=[], tags=[], timeoutMs, silenceMs, onEvent
}) {'''),

('''  if(!builder?.providerId) throw new Error("builder required");
  if(!judge?.providerId) throw new Error("judge required");''',
'''  if(!builder?.providerId && !builder?.spawn) throw new Error("builder required");
  if(!judge?.providerId && !judge?.spawn) throw new Error("judge required");'''),

('''    const builderMessage=await invokeModel({
      providerId:builder.providerId,model:builder.model,
      system:"You are the bounded implementation Builder in SCH-LOOP. You modify code but never judge completion.",
      prompt:builderPrompt({ticket,requirements,lessons,priorRejection,passingRequirements}),
      cwd,mode:"build"
    });''',
'''    let built;
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
    const builderMessage=built.text;'''),

('''    const workspace=await workspaceEvidence(cwd);
    const scope=scopeCheck(workspace,allowedPaths);

    state.phase="verifier"; await writeJson(path.join(runDir,"state.json"),state);
    emit("verification.state",{runId,ticketId,state});
    const verification=await runVerification({runId,ticketId,checks:verificationChecks,cwd});
    verification.checks.unshift(scope);
    verification.passed=verification.passed && scope.ok;''',
'''    const workspace=await workspaceEvidence(cwd);
    const scope=scopeCheck(workspace,allowedPaths,protectedPaths);
    const claims=claimsCheck(builderMessage,workspace.changedFiles);

    state.phase="verifier"; await writeJson(path.join(runDir,"state.json"),state);
    emit("verification.state",{runId,ticketId,state});
    const verification=await runVerification({runId,ticketId,checks:verificationChecks,cwd});
    verification.checks.unshift(scope,claims);
    verification.passed=verification.passed && scope.ok && claims.ok;'''),

('''    const judged=await runJudge({
      providerId:judge.providerId,model:judge.model,requirements,''',
'''    const judged=await runJudge({
      seat:judge,requirements,cwd,'''),

('''    const rec={attempt,builderMessage:String(builderMessage),workspace:{changedFiles:workspace.changedFiles,status:workspace.status},verification,judge:judged.parsed};''',
'''    const rec={attempt,builderMessage:String(builderMessage),workspace:{changedFiles:workspace.changedFiles,status:workspace.status},verification,judge:judged.parsed,
      usage:built.usage||null,contextTokens:contextTokens(built.usage),costUsd:built.cost??null,sessionId:built.sessionId||null,model:built.model||null,durationMs:built.durationMs??null};'''),
])

patch("judge.mjs", [
('import { invokeModel } from "./providers.mjs";', 'import { callSeat } from "./seats.mjs";'),
('''export async function runJudge({providerId, model, requirements, output, verification, evidenceNotes}) {
  const prompt = buildJudgePrompt({requirements,output,verification,evidenceNotes});
  const raw = await invokeModel({
    providerId, model,
    system:"You are a strict independent verification judge. You report only; you never repair.",
    prompt,
    mode:"review"
  });''',
'''export async function runJudge({seat, providerId, model, requirements, output, verification, evidenceNotes, cwd}) {
  const prompt = buildJudgePrompt({requirements,output,verification,evidenceNotes});
  const { text: raw } = await callSeat(seat || {providerId, model}, {
    system:"You are a strict independent verification judge. You report only; you never repair.",
    prompt, cwd, mode:"review"
  });'''),
])
print("patched self-correct.mjs judge.mjs")
