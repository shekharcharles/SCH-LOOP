import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ROOT = process.env.SCH_HOME ? path.resolve(process.env.SCH_HOME) : process.cwd();
export const SCH = path.join(ROOT, ".sch-loop");
export const PRIVATE = path.join(SCH, "private");
export const RUNTIME = path.join(SCH, "runtime");
export const COUNCILS = path.join(SCH, "council");

export async function ensureLayout() {
  const dirs = [
    SCH, PRIVATE, RUNTIME, COUNCILS,
    path.join(SCH,"discovery"), path.join(SCH,"specs"), path.join(SCH,"plans"),
    path.join(SCH,"tasks"), path.join(SCH,"runs"), path.join(SCH,"evidence"),
    path.join(SCH,"reviews"), path.join(SCH,"releases"), path.join(SCH,"reports"),
    path.join(SCH,"handoffs"), path.join(SCH,"learning")
  ];
  for (const d of dirs) await fs.mkdir(d,{recursive:true});
  try { await fs.chmod(PRIVATE,0o700); } catch {}
}

export async function readJson(p, fallback=null) {
  try { return JSON.parse(await fs.readFile(p,"utf8")); } catch { return fallback; }
}
//: One in-flight write per path. Concurrent writers to the same file are not merely a rename hazard on
//: Windows (`EPERM`/`ENOENT` when two renames target one destination) — they also LOSE UPDATES, because
//: each caller serialises a whole state object it read earlier. The Council is the only component that
//: writes concurrently, via `Promise.all` over its seats, and it hit both failures in succession.
//: Chaining per path makes each write see the previous one's result and removes the rename race outright.
const _writeQueue = new Map();

export function writeJson(p, v, mode=null) {
  const previous = _writeQueue.get(p) || Promise.resolve();
  const next = previous.catch(()=>{}).then(()=>_writeJsonNow(p,v,mode));
  _writeQueue.set(p, next);
  next.finally(()=>{ if(_writeQueue.get(p)===next) _writeQueue.delete(p); });
  return next;
}

async function _writeJsonNow(p, v, mode=null) {
  await fs.mkdir(path.dirname(p),{recursive:true});
  // The random suffix is load-bearing, not decoration. `pid + Date.now()` collides whenever two writers
  // in ONE process persist within the same millisecond — which is precisely what the Council does, since
  // it runs its seats through Promise.all. Both wrote the same temp file, the first rename moved it, and
  // the second failed `ENOENT: rename ...state.json.<pid>.<ms>.tmp`, killing the whole session in the
  // proposal phase. Nothing else in the runtime writes concurrently, so only the Council ever hit it.
  const tmp = `${p}.${process.pid}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(v,null,2)+"\n","utf8");
  await fs.rename(tmp,p);
  if (mode) try { await fs.chmod(p,mode); } catch {}
}
export async function writeText(p, v) {
  await fs.mkdir(path.dirname(p),{recursive:true});
  await fs.writeFile(p,String(v).trimEnd()+"\n","utf8");
}
// Decode ONCE, over the whole body. `s += chunk` decodes each chunk independently, so any multi-byte
// character that straddles a chunk boundary is torn into replacement characters — measured: an em dash in
// a Council question arrived as U+FFFD and was written to disk that way, permanently. Node picks the
// boundary, so the corruption depends on payload size and appears at random. Lives here rather than in
// `server.mjs` because importing that module starts a listener, and a reader nobody can test in isolation
// is how this survived unnoticed.
export async function readJsonBody(req, limit=2_000_000) {
  const chunks=[]; let n=0;
  for await (const c of req) { chunks.push(c); n+=c.length; if(n>limit) throw new Error("body too large"); }
  const s=Buffer.concat(chunks).toString("utf8");
  return s?JSON.parse(s):{};
}
export function makeId(prefix) {
  const t = new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
  return `${t}-${prefix}-${crypto.randomBytes(3).toString("hex")}`;
}
export function safe(v){ return String(v).replace(/[^a-zA-Z0-9._-]/g,"-").slice(0,100); }
export function exists(p){ return fssync.existsSync(p); }
export function redactedProvider(p){
  const x = structuredClone(p);
  if (x.apiKey) x.apiKey = "***";
  if (x.token) x.token = "***";
  return x;
}
