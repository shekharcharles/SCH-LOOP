// .sch-loop/roles.json — which CLI plays which role, and the exact argv. Nothing here
// is hard-coded: the engine reads the file, inserts `model_arg` only when a model is set,
// and locates the executable the way providers.mjs does (Windows .cmd shims included).
import fs from "node:fs";
import path from "node:path";
import { locate } from "./providers.mjs";

export const ROLES = ["executor", "reviewer", "judge", "council"];

export function loadRoles(projectRoot) {
  const f = path.join(projectRoot, ".sch-loop", "roles.json");
  if (!fs.existsSync(f)) throw new Error(`no roles.json at ${f} — run sch-setup`);
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const k of ["executor", "reviewer", "judge"]) if (!r[k]?.spawn?.length) throw new Error(`roles.json: ${k}.spawn must be a non-empty argv array`);
  if (!Array.isArray(r.council)) r.council = [];
  return r;
}

// {exe, args} for one role spec. `model` overrides the spec's model; null/"cli-default" = no model flag.
export function resolveSpawn(spec, { model } = {}) {
  const [exe, ...args] = spec.spawn;
  const m = model ?? spec.model;
  const modelArgs = m && m !== "cli-default" && Array.isArray(spec.model_arg)
    ? spec.model_arg.map(a => a.replace("{model}", m))
    : [];
  return { exe, args: [...args, ...modelArgs], provider: spec.provider || exe, model: m || null };
}

// Presets are argv fragments a dashboard toggle adds or removes; used by sch-setup and the Roles page.
export function applyPreset(spec, presets, name, on) {
  const frag = presets?.[spec.provider]?.[name];
  if (!frag) throw new Error(`no preset ${name} for provider ${spec.provider}`);
  const has = frag.every(a => spec.spawn.includes(a));
  if (on && !has) return { ...spec, spawn: [...spec.spawn, ...frag] };
  if (!on && has) { const s = [...spec.spawn]; for (const a of frag) { const i = s.indexOf(a); if (i > 0) s.splice(i, 1); } return { ...spec, spawn: s }; }
  return spec;
}

const BYPASS = [/^--dangerously-skip-permissions$/, /^--dangerously-bypass-approvals-and-sandbox$/, /^bypassPermissions$/];
export function isBypass(spec) { return spec.spawn.some(a => BYPASS.some(r => r.test(a))); }
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
export function isReadOnly(spec) {
  const i = spec.spawn.indexOf("--disallowedTools");
  if (i >= 0) { const rest = spec.spawn.slice(i + 1).filter(a => !a.startsWith("-")); return WRITE_TOOLS.every(t => rest.includes(t)); }
  if (spec.spawn.includes("--sandbox") && spec.spawn.includes("read-only")) return true;
  return false;
}

export function councilSeats(roles) {
  return roles.council.filter(s => s.enabled !== false);
}

const _exe = new Map();
export async function locateExe(exe) {
  if (path.isAbsolute(exe)) return exe;
  if (!_exe.has(exe)) _exe.set(exe, await locate(exe));
  const p = _exe.get(exe);
  if (!p) throw new Error(`executable not found on PATH: ${exe}`);
  return p;
}
