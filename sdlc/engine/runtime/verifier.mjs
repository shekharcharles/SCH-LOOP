import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT, SCH, ensureLayout, writeJson, writeText } from "./util.mjs";

// Resolve a bare command to a real path so the shell is needed only for a `.cmd`/`.bat` shim.
// Windows lists the extensionless npm shim first — that file is a bash script `spawn()` cannot run —
// so an executable extension is preferred, exactly as providers.mjs does for the same reason.
// Exported because every spawn site in this engine needs it and each one that re-derived the rule got
// it subtly wrong. `ship.mjs` guarded on the BARE command name ending in `.cmd`, which `npm` never does,
// and died with `spawn npm ENOENT` — the third time this exact quirk was rediscovered here.
const _exeCache = new Map();
export function resolveExecutable(command) {
  if (process.platform !== "win32" || /[\\/]/.test(command)) return command;
  if (_exeCache.has(command)) return _exeCache.get(command);
  let hit = command;
  try {
    const out = execFileSync("where.exe", [command], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    const hits = out.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    hit = hits.find(h => /\.(exe|com|cmd|bat)$/i.test(h)) || hits[0] || command;
  } catch { /* not on PATH: let spawn report it */ }
  _exeCache.set(command, hit);
  return hit;
}

function runProcess(command, args=[], cwd=ROOT, timeoutMs=120000) {
  return new Promise((resolve) => {
    // Every npm-installed CLI on Windows is a `.cmd` shim, and Node 18.20+/20.12+/22+ refuse to spawn
    // one without a shell (the CVE-2024-27980 hardening), which surfaces as `spawn npm ENOENT`.
    //
    // The shell is used ONLY for a resolved `.cmd`/`.bat`, never for a real executable. With
    // `shell:true` Node concatenates arguments unescaped (it warns DEP0190 about exactly this), so a
    // check like `node -e "…quotes…"` is mangled into a syntax error — measured, on the first docs
    // ticket, as a verify command that could not fail honestly because it never ran.
    const { command: resolved, shell: needsShell } = spawnSafe(command);
    const child = spawn(resolved, args, {
      cwd, windowsHide:true, stdio:["ignore","pipe","pipe"], env:process.env, shell:needsShell
    });
    let stdout="", stderr="";
    const startedAt = new Date().toISOString();
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        ok:false, command, args, startedAt, completedAt:new Date().toISOString(),
        exitCode:null, timedOut:true, stdout, stderr
      });
    }, timeoutMs);
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    child.on("error", err => {
      clearTimeout(timer);
      resolve({
        ok:false, command, args, startedAt, completedAt:new Date().toISOString(),
        exitCode:null, timedOut:false, stdout, stderr:stderr + "\n" + err.message
      });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({
        ok:code===0, command, args, startedAt, completedAt:new Date().toISOString(),
        exitCode:code, timedOut:false, stdout, stderr
      });
    });
  });
}

// The one answer to "how do I spawn this command on this platform": a resolved executable, and a shell
// only when the resolved path is a `.cmd`/`.bat` shim. With `shell:true` Node concatenates arguments
// unescaped, so it is never turned on for a real executable.
export function spawnSafe(command) {
  const resolved = resolveExecutable(command);
  return { command: resolved, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved) };
}

export async function runVerification({runId, ticketId, checks=[], cwd=ROOT}) {
  await ensureLayout();
  const dir = path.join(SCH, "evidence", runId, ticketId);
  await fs.mkdir(dir, {recursive:true});
  const results = [];
  for (let i=0;i<checks.length;i++) {
    const c = checks[i];
    if (!c?.command) {
      results.push({name:c?.name||`check-${i+1}`, ok:false, error:"missing command"});
      continue;
    }
    const result = await runProcess(c.command, c.args||[], cwd, c.timeoutMs||120000);
    const entry = {name:c.name||`${c.command} ${(c.args||[]).join(" ")}`, ...result};
    results.push(entry);
    await writeText(path.join(dir, `${String(i+1).padStart(2,"0")}-${(c.name||c.command).replace(/[^a-zA-Z0-9._-]/g,"-")}.log`),
`COMMAND: ${c.command} ${(c.args||[]).join(" ")}
EXIT: ${result.exitCode}
TIMED_OUT: ${result.timedOut}

STDOUT
${result.stdout}

STDERR
${result.stderr}`);
  }
  const summary = {
    runId, ticketId, generatedAt:new Date().toISOString(),
    passed:results.every(x=>x.ok),
    checks:results
  };
  await writeJson(path.join(dir, "verification.json"), summary);
  return summary;
}
