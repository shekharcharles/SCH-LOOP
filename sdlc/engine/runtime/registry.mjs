// Global state: which projects exist, and the seat defaults they inherit when they have not chosen
// their own. Lives in ~/.sch-loop so one dashboard can see every project on the machine.
//
// Inheritance is PER SEAT, WHOLE. A project either uses the global Executor exactly, or it has its own
// complete Executor. It never inherits a spawn argv while overriding the model, because that produces
// argv like `codex exec --sandbox read-only --model opus` — a command that cannot run, assembled from
// two seats that were each individually fine. The UI copies a global seat down when you customise it,
// so what you edit is always a coherent whole.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Read the env var on every call, never once at import. Frozen at load, two modules that imported this
// at different times disagreed about where global state lived — the dashboard wrote to one home and read
// from another, and the project it had just registered was missing from its own listing.
export const home = () => process.env.SCH_GLOBAL_HOME || path.join(os.homedir(), ".sch-loop");
export const projectsFile = () => path.join(home(), "projects.json");
export const globalRolesFile = () => path.join(home(), "roles.json");

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n"); };

export const SEATS = ["executor", "reviewer", "judge"];

// A project is known by its absolute path; the id is a stable slug of it so a URL can name one.
export const idFor = root => path.resolve(root).replace(/[\\/:]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();

export function listProjects() {
  const rows = readJson(projectsFile(), []);
  return (Array.isArray(rows) ? rows : []).map(p => ({
    ...p,
    id: p.id || idFor(p.root),
    exists: fs.existsSync(path.join(p.root, ".sch-loop")),
  }));
}

export function registerProject(root, extra = {}) {
  const abs = path.resolve(root);
  if (rejects(abs)) return { id: idFor(abs), root: abs, name: path.basename(abs), skipped: "scratch directory" };
  const rows = readJson(projectsFile(), []).filter(p => path.resolve(p.root) !== abs);
  const row = { id: idFor(abs), root: abs, name: extra.name || path.basename(abs), registeredAt: new Date().toISOString(), ...extra };
  rows.push(row);
  writeJson(projectsFile(), rows);
  return row;
}

export function forgetProject(id) {
  const rows = readJson(projectsFile(), []);
  const kept = rows.filter(p => (p.id || idFor(p.root)) !== id);
  writeJson(projectsFile(), kept);
  return rows.length - kept.length;
}

export const projectById = id => listProjects().find(p => p.id === id) || null;

// A directory under the OS temp folder is a test fixture, not somebody's project. Registering one is
// how fourteen throwaway directories ended up on a real operator's dashboard.
export const isScratch = root => {
  const t = path.resolve(os.tmpdir()).toLowerCase();
  return path.resolve(root).toLowerCase().startsWith(t + path.sep);
};

// One rule, used by both the register guard and the pruner. Only the DEFAULT registry needs protecting
// from throwaway directories — it is the one an operator actually looks at. When SCH_GLOBAL_HOME points
// somewhere explicit the registry is already isolated, and the rule would only be in the tests' way.
// The two used to decide this separately, so a project the register accepted the pruner then deleted.
export const rejects = root => isScratch(root) && !process.env.SCH_GLOBAL_HOME;

// A registered directory that is gone, or was never a real project, cannot be built and is noise that
// grows forever. Pruning is explicit rather than a side effect of listing, so a read never mutates.
export function pruneMissing() {
  const rows = readJson(projectsFile(), []);
  const kept = rows.filter(p => fs.existsSync(path.join(p.root, ".sch-loop")) && !rejects(p.root));
  if (kept.length !== rows.length) writeJson(projectsFile(), kept);
  return rows.length - kept.length;
}

export const globalRoles = () => readJson(globalRolesFile(), null);
export function saveGlobalRoles(roles) { writeJson(globalRolesFile(), roles); return globalRolesFile(); }

// What a project's seats actually are once defaults are applied, and where each one came from. The
// provenance is half the point: a page that shows a value without saying whether it is this project's
// or everyone's cannot be used to change one safely.
export function resolveRoles(projectRoles, defaults = globalRoles()) {
  const out = { _comment: projectRoles?._comment, _presets: projectRoles?._presets || defaults?._presets, source: {} };
  for (const seat of SEATS) {
    if (projectRoles?.[seat]) { out[seat] = projectRoles[seat]; out.source[seat] = "project"; }
    else if (defaults?.[seat]) { out[seat] = defaults[seat]; out.source[seat] = "global"; }
    else { out[seat] = null; out.source[seat] = "missing"; }
  }
  if (Array.isArray(projectRoles?.council) && projectRoles.council.length) { out.council = projectRoles.council; out.source.council = "project"; }
  else if (Array.isArray(defaults?.council)) { out.council = defaults.council; out.source.council = "global"; }
  else { out.council = []; out.source.council = "missing"; }
  return out;
}

// Seed the global defaults from a project's own roles the first time anything asks for them, so a
// machine that has run setup once already has sensible defaults rather than an empty page.
export function ensureGlobalRoles(seedFrom = null) {
  const existing = globalRoles();
  if (existing) return existing;
  if (!seedFrom) return null;
  const seeded = { ...seedFrom, _comment: "Machine-wide defaults. A project inherits a seat from here unless it defines its own." };
  saveGlobalRoles(seeded);
  return seeded;
}
