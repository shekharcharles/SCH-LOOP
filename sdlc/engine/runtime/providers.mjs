import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { PRIVATE, ensureLayout, readJson, writeJson, redactedProvider } from "./util.mjs";
import { killTree } from "../scripts/subprocess.mjs";
const execFileP = promisify(execFile);

const REGISTRY = path.join(PRIVATE,"providers.json");
const SECRETS = path.join(PRIVATE,"provider-secrets.json");

// Modes:
// - build: coding agent may modify the workspace.
// - review: agent must be constrained to read-only/plan behavior where supported.
// HTTP-compatible providers are text-only and therefore naturally non-mutating.
// `buildArgs`/`reviewArgs` return FLAGS ONLY. The prompt is delivered on stdin (see runProcess) because
// passing it in argv breaks on Windows: an npm CLI is a .cmd, Node needs `shell:true` to spawn one, and
// with a shell Node concatenates arguments unescaped. Both CLIs read a prompt from stdin — verified:
// `claude -p` answers, `codex exec` prints "Reading prompt from stdin...".
const PROMPT_ON_STDIN = true;

//: How long a single CLI invocation may take. Overridable, because the right value depends on the seat:
//: a proposal returns in a minute, a chair synthesising five phases of debate can take many. Raised from
//: a hardcoded 180s after a Council completed proposals, critiques, rebuttals and the adversarial
//: challenge and then died in synthesis with "CLI timed out" — four phases of real work discarded at the
//: last step.
const CLI_TIMEOUT_MS = Number(process.env.SCH_CLI_TIMEOUT_MS || 900000);
const CLI_PROFILES = [
  {
    id:"claude", label:"Claude Code", commands:["claude"],
    buildArgs:(model)=>["-p", ...(model&&model!=="cli-default"?["--model",model]:[])],
    reviewArgs:(model)=>["-p","--tools","Read,Glob,Grep", ...(model&&model!=="cli-default"?["--model",model]:[])]
  },
  {
    id:"codex", label:"Codex CLI", commands:["codex"],
    buildArgs:(model)=>["exec","--sandbox","workspace-write","--skip-git-repo-check", ...(model&&model!=="cli-default"?["--model",model]:[])],
    reviewArgs:(model)=>["exec","--sandbox","read-only","--skip-git-repo-check", ...(model&&model!=="cli-default"?["--model",model]:[])]
  },
  {
    id:"gemini", label:"Gemini CLI", commands:["gemini"],
    buildArgs:(model)=>["--approval-mode","auto_edit", ...(model&&model!=="cli-default"?["--model",model]:[])],
    reviewArgs:(model)=>["--approval-mode","plan", ...(model&&model!=="cli-default"?["--model",model]:[])]
  },
  {
    id:"opencode", label:"OpenCode", commands:["opencode"],
    buildArgs:(model)=>["run","--auto", ...(model&&model!=="cli-default"?["--model",model]:[])],
    reviewArgs:(model)=>["run","--agent","plan", ...(model&&model!=="cli-default"?["--model",model]:[])]
  },
  {id:"antigravity", label:"Antigravity CLI", commands:["antigravity"], buildArgs:()=>["-p"], reviewArgs:null},
  {id:"qwen", label:"Qwen Code", commands:["qwen","qwen-code"], buildArgs:()=>["-p"], reviewArgs:null},
  {id:"aider", label:"Aider", commands:["aider"], buildArgs:()=>["--message"], reviewArgs:null},
  {id:"cursor-agent", label:"Cursor Agent", commands:["cursor-agent"], buildArgs:()=>[], reviewArgs:null},
  {id:"lord", label:"Lord CLI / custom alias", commands:["lord"], buildArgs:()=>[], reviewArgs:null},
  {id:"omipi", label:"Omipi/Omi CLI / custom alias", commands:["omipi","omi","omi-cli"], buildArgs:()=>[], reviewArgs:null}
];

export async function locate(cmd) {
  const detector = process.platform === "win32" ? "where.exe" : "which";
  try {
    const {stdout} = await execFileP(detector,[cmd],{timeout:3000,windowsHide:true});
    const hits = stdout.trim().split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if (!hits.length) return null;
    if (process.platform !== "win32") return hits[0];
    // Windows: `where.exe` lists the extensionless shim FIRST for anything installed by npm — that file
    // is a bash script, and `spawn()` cannot execute it. Taking hits[0] made every CLI provider fail
    // with `spawn <path> ENOENT` at build time while discovery reported the provider as available:
    // detection said yes, execution said no. Prefer an executable extension.
    const executable = hits.find(h => /\.(cmd|bat|exe)$/i.test(h));
    if (executable) return executable;
    const sibling = hits[0] + ".cmd";
    return existsSync(sibling) ? sibling : hits[0];
  } catch { return null; }
}
async function version(command) {
  try {
    const {stdout,stderr} = await execFileP(command,["--version"],
      {timeout:2500,windowsHide:true,shell:process.platform==="win32"&&/\.(cmd|bat)$/i.test(command)});
    return (stdout||stderr).trim().split(/\r?\n/)[0].slice(0,200);
  } catch { return "detected"; }
}
//: Discovery spawns `where.exe` plus a `--version` probe for each of ten CLI profiles — about 2 seconds
//: of subprocesses. `getProviders()` calls it, the dashboard calls THAT on every SSE event, and a running
//: Council emits events constantly, so the page spent its life waiting on process spawns. Installed CLIs
//: do not change mid-session; the Rediscover button clears this deliberately.
let _cliCache = {at: 0, value: null};
const CLI_CACHE_MS = 60000;

export function invalidateCliCache(){ _cliCache = {at: 0, value: null}; }

export async function discoverCLIs({fresh=false}={}) {
  if(!fresh && _cliCache.value && Date.now()-_cliCache.at < CLI_CACHE_MS) return _cliCache.value;
  const value = await _discoverCLIsNow();
  _cliCache = {at: Date.now(), value};
  return value;
}

async function _discoverCLIsNow() {
  // Probed in PARALLEL. This loop used to await `locate` then `version` per profile, serially, with a
  // 4s version timeout each — three installed CLIs cost up to twelve seconds, and the dashboard blocked
  // its first paint on exactly that. Ten profiles resolve together now.
  const found = await Promise.all(CLI_PROFILES.map(async p => {
    for (const c of p.commands) {
      const hit = await locate(c);
      if (hit) return {p, used: c, path: hit};
    }
    return null;
  }));
  const live = found.filter(Boolean);
  const versions = await Promise.all(live.map(f => version(f.path)));
  return live.map((f, i) => ({
    id:`cli:${f.p.id}`, type:"cli", label:f.p.label, command:f.used, path:f.path,
    version:versions[i], enabled:true,
    capabilities:{build:!!f.p.buildArgs, review:!!f.p.reviewArgs}
  }));
}

//: Per-provider overrides an operator sets in the dashboard: whether it may sit on the Council, and
//: which model it uses when it does. Kept in its own file rather than on the discovered record, because
//: discovery REBUILDS the CLI entries on every call — writing the toggle onto them would lose it the
//: moment a CLI was re-detected.
const PREFS = path.join(PRIVATE,"provider-prefs.json");

export async function setProviderPrefs({id, enabled, model, models}) {
  await ensureLayout();
  if(!id) throw new Error("provider id required");
  const prefs = await readJson(PREFS,{});
  const entry = prefs[id] || {};
  if(enabled !== undefined) entry.enabled = !!enabled;
  // MULTIPLE models per provider. One Claude seat is not the same conversation as another: opus and
  // fable reason differently, and the point of a Council is disagreement. A single `model` field forced
  // one seat per provider and quietly capped the panel at the number of installed CLIs. `models` is the
  // selected set; `model` is kept as the first of them so anything reading the old field still works.
  if(models !== undefined) {
    entry.models = Array.isArray(models) ? models.filter(Boolean) : [];
    entry.model = entry.models[0] || null;
  }
  if(model !== undefined && models === undefined) {
    entry.model = model || null;
    entry.models = model ? [model] : [];
  }
  prefs[id] = entry;
  await writeJson(PREFS,prefs,0o600);
  return {id, ...entry};
}

//: Answer "does this model name actually work" before a Council seat is spent on it. There is no
//: catalogue to consult — neither CLI can list its models — so the only honest check is to call it.
//: Measured why this matters: of three Codex names supplied by hand, one returned 400.
export async function probeModel({id, model}) {
  const providers = await getProviders({includeSecrets:true});
  const p = providers.find(x => x.id === id);
  if(!p) throw new Error("provider not found");
  const started = Date.now();
  try {
    const out = await invokeModel({providerId:id, model, prompt:"Reply with exactly one word: PONG",
                                   mode:"review", cwd:process.cwd()});
    return {ok:true, ms:Date.now()-started, sample:String(out).trim().slice(-120)};
  } catch (e) {
    return {ok:false, ms:Date.now()-started, error:String(e.message||e).slice(0,300)};
  }
}

export async function addProviderModel({id, model}) {
  await ensureLayout();
  if(!id || !model) throw new Error("provider id and model required");
  const prefs = await readJson(PREFS,{});
  const entry = prefs[id] || {};
  entry.custom = [...new Set([...(entry.custom||[]), String(model).trim()])].filter(Boolean);
  prefs[id] = entry;
  await writeJson(PREFS,prefs,0o600);
  return {id, custom: entry.custom};
}

export async function getProviders({includeSecrets=false}={}) {
  await ensureLayout();
  const saved = await readJson(REGISTRY,{providers:[]});
  const prefs = await readJson(PREFS,{});
  const clis = await discoverCLIs();
  const byId = new Map();
  for(const p of [...clis,...saved.providers]) {
    const pref = prefs[p.id] || {};
    byId.set(p.id,{...p,
      enabled: pref.enabled === undefined ? p.enabled : pref.enabled,
      model:   pref.model ?? p.model ?? null,
      models:  pref.models ?? (pref.model ? [pref.model] : [])});
  }
  let list=[...byId.values()];
  if(includeSecrets){
    const sec=await readJson(SECRETS,{});
    list=list.map(p=>({...p, apiKey:sec[p.id]||undefined}));
  } else list=list.map(redactedProvider);
  return list;
}
export async function saveEndpoint(input) {
  await ensureLayout();
  const allowedTypes=["openai-compatible","anthropic-compatible"];
  if(!allowedTypes.includes(input.type)) throw new Error("unsupported endpoint type");
  if(!/^https?:\/\//i.test(input.baseUrl||"")) throw new Error("baseUrl must be http(s)");
  const id=input.id || `endpoint:${Date.now().toString(36)}`;
  const registry=await readJson(REGISTRY,{providers:[]});
  const entry={
    id,type:input.type,label:input.label||id,
    baseUrl:String(input.baseUrl).replace(/\/+$/,""),
    modelsPath:input.modelsPath||"/v1/models",
    invokePath:input.invokePath || (input.type==="anthropic-compatible"?"/v1/messages":"/v1/chat/completions"),
    enabled:true,addedAt:new Date().toISOString(),
    capabilities:{build:false,review:true}
  };
  registry.providers=registry.providers.filter(p=>p.id!==id);
  registry.providers.push(entry);
  await writeJson(REGISTRY,registry,0o600);
  if(input.apiKey){
    const sec=await readJson(SECRETS,{});
    sec[id]=input.apiKey;
    await writeJson(SECRETS,sec,0o600);
  }
  return redactedProvider(entry);
}
function headers(p){
  const h={"content-type":"application/json"};
  if(p.type==="anthropic-compatible"){
    if(p.apiKey) h["x-api-key"]=p.apiKey;
    h["anthropic-version"]="2023-06-01";
  } else if(p.apiKey) h.authorization=`Bearer ${p.apiKey}`;
  return h;
}
export async function fetchModels(providerId){
  const providers=await getProviders({includeSecrets:true});
  const p=providers.find(x=>x.id===providerId);
  if(!p) throw new Error("provider not found");
  if(p.type==="cli") return cliModels(p);
  const r=await fetch(p.baseUrl+p.modelsPath,{headers:headers(p),signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error(`model discovery failed: ${r.status} ${await r.text()}`);
  const j=await r.json();
  const raw=Array.isArray(j)?j:(j.data||j.models||[]);
  return raw.map(x=>typeof x==="string"?{id:x,label:x}:{id:x.id||x.name||x.model,label:x.display_name||x.displayName||x.name||x.id}).filter(x=>x.id);
}
function cliProfile(provider){ return CLI_PROFILES.find(x=>x.id===provider.id.replace(/^cli:/,"")); }

//: The model each CLI will actually use, so a Council seat can be pinned to one rather than to whatever
//: the CLI happens to default to. Previously every CLI reported a single "cli-default", which made
//: "which model argued this seat" unanswerable in the transcript — the one question a multi-model council
//: exists to answer. `cli-default` stays FIRST in every list: it is the only value guaranteed to work if
//: a vendor renames an alias, and it is what the runtime already passes through untouched.
//: SEED lists only. Neither `claude` nor `codex` can enumerate its own models (`codex models` is not a
//: command; `--model` just takes a string), so something has to be written down — but a written-down
//: list is wrong the day a vendor ships a name, and mine already was: it omitted Claude's `fable` and
//: every 5.6 variant of Codex. Operators can add any model through the dashboard, and those are stored
//: per provider in prefs and merged in below, so this list is a convenience and never a limit.
const CLI_MODELS = {
  //: VERIFIED by invoking each one, not copied from anywhere. `gpt-5.6` is deliberately absent: it
  //: returns 400 invalid_request_error on this account. `luna`/`sol`/`terra` are absent too — those are
  //: models on the LiteLLM proxy, and I had wrongly carried them across to the Codex CLI.
  claude:   ["opus", "sonnet", "haiku", "fable"],
  codex:    ["gpt-5.5", "gpt-5.4-mini"],
  gemini:   ["gemini-3.5-pro", "gemini-3.1-pro", "gemini-3-flash"],
  opencode: [],                        // discovered live below — it proxies whatever its config exposes
};

async function cliModels(provider){
  const key = provider.id.replace(/^cli:/, "");
  const prefs = await readJson(PREFS,{});
  const custom = prefs[provider.id]?.custom || [];
  const out = [{id:"cli-default", label:`${provider.label} default`}];
  // OpenCode fronts a model proxy, so ask it rather than guessing. Failure is not fatal: the caller
  // still gets cli-default, which is what the previous behaviour returned in every case.
  if(key === "opencode"){
    try{
      const {stdout} = await execFileP(provider.path||provider.command,["models"],
                                       {timeout:15000,windowsHide:true,shell:process.platform==="win32"});
      for(const line of stdout.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).slice(0,80)){
        const id=line.split(/\s+/)[0];
        if(id && !id.startsWith("-")) out.push({id,label:id});
      }
    }catch{ /* keep cli-default only */ }
    for(const id of custom) if(!out.some(m=>m.id===id)) out.push({id,label:`${id} (added)`});
    return out;
  }
  for(const id of CLI_MODELS[key]||[]) out.push({id,label:id});
  for(const id of custom) if(!out.some(m=>m.id===id)) out.push({id,label:`${id} (added)`});
  return out;
}
function runProcess(command,args,cwd,stdinText){
  return new Promise((resolve,reject)=>{
    // Node 18.20+/20.12+/22+ refuse to spawn a .cmd/.bat without a shell (the CVE-2024-27980 argument
    // -injection hardening), which surfaces as `spawn EINVAL`. Every npm-installed CLI on Windows IS a
    // .cmd, so without this the whole provider layer is unusable on Windows under a current Node.
    const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    // The PROMPT goes on stdin, never in argv. With `shell:true` Node concatenates arguments without
    // escaping (it warns DEP0190 about exactly this), so a multi-kilobyte multi-line prompt passed as an
    // argument reaches the CLI mangled — measured: the Builder made no change and the Judge then failed
    // with "judge did not return JSON". Only flags and a model name travel through the shell now, and
    // those contain no whitespace or newlines.
    const child=spawn(command,args,{cwd,windowsHide:true,
                                    stdio:[stdinText==null?"ignore":"pipe","pipe","pipe"],
                                    env:process.env, shell:needsShell});
    if(stdinText!=null){
      child.stdin.on("error",()=>{});     // a CLI that closes stdin early must not crash the run
      child.stdin.end(stdinText);
    }
    let out="",err="";
    child.stdout.on("data",d=>out+=d); child.stderr.on("data",d=>err+=d);
    // 180s was too short for the one call that matters most. A Council's synthesis prompt carries the
    // question, every proposal, every critique, every rebuttal AND the adversarial challenge — measured
    // at ~15k characters on a two-seat session — so the chair is structurally the slowest seat and the
    // only one that had run out of time. Every earlier phase fits comfortably; the verdict never
    // returned, and the session recorded `status: failed` after four phases of real work.
    // `child.kill()` killed the wrong process. `needsShell` is true for every npm-installed `.cmd` on
    // Windows, so the pid here is cmd.exe: killing it left the provider CLI running, streaming, and
    // holding API credentials, while this side reported a clean timeout. Measured once as a 900s council
    // seat whose orphan outlived the run. `killTree` walks the real tree (`taskkill /T /F`), and is the
    // same helper executor.mjs, sch-test.mjs and validate.mjs already use — this was the one caller that
    // missed the merge. The message carries the kill evidence because a timeout with no evidence of what
    // died is what made the first one take three runs to understand.
    const timer=setTimeout(()=>{
      const kill=killTree(child);
      reject(new Error(`CLI timed out after ${CLI_TIMEOUT_MS}ms [${command}] `
        +`stdout=${out.length}B kill=${kill.method}:${kill.ok}`
        +`${kill.detail?` (${kill.detail})`:""}`
        +`${err.trim()?` stderr=${err.trim().slice(-400)}`:""}`));
    },CLI_TIMEOUT_MS);
    child.on("error",e=>{clearTimeout(timer);reject(e);});
    child.on("close",code=>{
      clearTimeout(timer);
      if(code===0) resolve(out.trim()||err.trim());
      // `provider` is not in scope here — it never was. The line only runs when a CLI exits non-zero, so
      // it sat unnoticed until a Council seat was pointed at a model the provider rejects: the CLI exited
      // 1, this threw ReferenceError inside a child-process event handler, and the whole dashboard
      // process died mid-session. A failing model must fail its seat, never the console.
      // BOTH streams, because the reason is not reliably on either. Measured: `codex --model
      // gpt-5.6-codex` prints its startup banner to stderr and the decisive line — "The 'gpt-5.6-codex'
      // model is not supported when using Codex with a ChatGPT account" — to stdout. Reporting stderr
      // alone showed the operator a banner and no reason, so a permanently unusable model looked like an
      // intermittent glitch. Tail rather than head: a CLI's last words are the failure, the first are
      // boilerplate.
      else reject(new Error(`${command} exited ${code}: ${[err.trim(), out.trim()].filter(Boolean).join("\n").slice(-4000)}`));
    });
  });
}
export async function invokeModel({providerId,model,prompt,system,cwd=process.cwd(),mode="review"}) {
  const providers=await getProviders({includeSecrets:true});
  const p=providers.find(x=>x.id===providerId);
  if(!p) throw new Error(`provider not found: ${providerId}`);
  const full = `${system?`SYSTEM:\n${system}\n\n`:""}USER:\n${prompt}`;
  if(p.type==="cli"){
    const profile=cliProfile(p);
    if(!profile) throw new Error("CLI profile unavailable");
    const argFn=mode==="build"?profile.buildArgs:profile.reviewArgs;
    if(!argFn) throw new Error(`${p.label} has no structurally configured ${mode} adapter; use a supported CLI or compatible HTTP endpoint for review`);
    return await runProcess(p.path||p.command,argFn(model),cwd,full);
  }
  if(mode==="build") throw new Error("HTTP-compatible providers are text-only in SCH-LOOP v2 and cannot be selected as code-modifying builders");
  if(p.type==="anthropic-compatible"){
    const body={model,max_tokens:4096,system:system||undefined,messages:[{role:"user",content:prompt}]};
    const r=await fetch(p.baseUrl+p.invokePath,{method:"POST",headers:headers(p),body:JSON.stringify(body),signal:AbortSignal.timeout(180000)});
    if(!r.ok) throw new Error(`provider invoke failed: ${r.status} ${await r.text()}`);
    const j=await r.json();
    return (j.content||[]).map(x=>x.text||"").join("\n").trim() || JSON.stringify(j);
  }
  const body={model,messages:[...(system?[{role:"system",content:system}]:[]),{role:"user",content:prompt}],temperature:0.2};
  const r=await fetch(p.baseUrl+p.invokePath,{method:"POST",headers:headers(p),body:JSON.stringify(body),signal:AbortSignal.timeout(180000)});
  if(!r.ok) throw new Error(`provider invoke failed: ${r.status} ${await r.text()}`);
  const j=await r.json();
  return j.choices?.[0]?.message?.content ?? j.output_text ?? JSON.stringify(j);
}
