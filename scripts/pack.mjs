// The per-task capability pack.
//
// A worker is a real `claude -p` process, and that process loads the operator's
// entire global skill catalogue unless told otherwise. This module builds the
// only catalogue SCH wants it to have: a generated plugin directory holding
// exactly the approved skills, beside the task's worktree and never inside the
// repository SCH is about to inspect.
//
// This is capability scoping, not isolation. It inherits every M6 caveat.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const SCHEMA_VERSION = 1;

// Same state root M6 established for worktrees: outside the repository and
// outside SCH_HOME, so a worker that walks up finds neither.
export function packsRoot(env = process.env) {
  if (env.SCH_PACK_ROOT && isAbsolute(env.SCH_PACK_ROOT)) return resolve(env.SCH_PACK_ROOT);
  if (process.platform === "win32")
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "sch-loop", "packs");
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "sch-loop", "packs");
}

const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);

export function packPathFor(projectId, taskId, { root = packsRoot() } = {}) {
  return join(resolve(root), slug(projectId), `task-${slug(taskId)}`);
}

const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 32);

// A skill is instructions, and most real skills split those instructions across
// supporting documents — `references/*.md` is the common shape. Those are
// carried, because a packed skill whose SKILL.md points at a file that is not
// there is a broken skill.
//
// What is never carried is anything that could EXECUTE or could redefine the
// plugin: scripts, binaries, and any nested `.claude-plugin/`. That is the
// surface the generated-manifest rule exists to close, and copying a shell
// script into the worker's reach would reopen it by the side door.
const DOCUMENT_EXT = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv"]);
const EXECUTABLE_EXT = new Set([".sh", ".bash", ".zsh", ".ps1", ".psm1", ".bat", ".cmd",
                                ".js", ".mjs", ".cjs", ".ts", ".py", ".rb", ".pl", ".exe", ".dll", ".so"]);
const REFUSED_DIRS = new Set([".claude-plugin", "hooks", "bin", "scripts"]);

// Fail closed: an extension this build does not recognise is refused, not
// carried. A new file type is not a safe one.
export function carryDecision(relPath) {
  const parts = relPath.split(/[/\\]/);
  if (parts.some((p) => REFUSED_DIRS.has(p)))
    return { carry: false, why: `"${parts.find((p) => REFUSED_DIRS.has(p))}/" can execute or redefine the plugin` };
  const dot = parts[parts.length - 1].lastIndexOf(".");
  const ext = dot < 0 ? "" : parts[parts.length - 1].slice(dot).toLowerCase();
  if (EXECUTABLE_EXT.has(ext)) return { carry: false, why: `${ext} is executable` };
  if (DOCUMENT_EXT.has(ext)) return { carry: true, why: null };
  return { carry: false, why: ext ? `unrecognised extension ${ext}` : "no extension" };
}

export function buildPack({ projectId, taskId, skills = [], root = packsRoot() }) {
  const path = packPathFor(projectId, taskId, { root });
  const refusals = [];
  const entries = [];

  // Verify every skill BEFORE writing anything: a half-built pack is worse than
  // no pack, because the worker would launch with a catalogue nobody approved.
  const staged = [];
  for (const s of skills) {
    let text;
    try { text = readFileSync(s.source_path, "utf8"); }
    catch (e) { return { ok: false, code: "PACK_SKILL_UNREADABLE", message: `${s.skill_id}: ${e.message}` }; }
    if (s.content_hash && hash(text) !== s.content_hash)
      return { ok: false, code: "PACK_HASH_MISMATCH",
        message: `${s.skill_id} changed on disk since it was approved — refusing to pack it` };
    staged.push({ s, text });
  }

  try {
    rmSync(path, { recursive: true, force: true });
    mkdirSync(join(path, ".claude-plugin"), { recursive: true });
    mkdirSync(join(path, "skills"), { recursive: true });

    // GENERATED, never copied. A plugin manifest may register command hooks —
    // the installed caveman plugin registers two — so SCH writes the manifest
    // itself and a source manifest never reaches the worker.
    const manifest = {
      name: `sch-${slug(projectId)}-task-${slug(taskId)}`,
      description: "SCH Loop capability pack: the skills approved for this task.",
    };
    writeFileSync(join(path, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");

    for (const { s, text } of staged) {
      const dest = join(path, "skills", slug(s.skill_id));
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "SKILL.md"), text);

      // Walk the skill's directory and carry its supporting DOCUMENTS, so a
      // SKILL.md that says "read references/foo.md" finds it. Everything that
      // could execute is refused and recorded by name, so "this skill needs its
      // scripts" is a reportable fact rather than a silent degradation.
      const srcDir = s.source_path.replace(/[/\\][^/\\]+$/, "");
      const walk = (rel) => {
        let listing = [];
        try { listing = readdirSync(join(srcDir, rel), { withFileTypes: true }); } catch { return; }
        for (const d of listing) {
          const child = rel ? join(rel, d.name) : d.name;
          if (child === "SKILL.md") continue;                 // already written

          // A symlink's name carries no information about where it points —
          // carryDecision only ever sees `child`, a relative path string — so a
          // symlink named "notes.md" that resolves outside the skill directory
          // (or outside the repository entirely) would sail through the
          // extension check and get read for real. Refuse every symlink,
          // file or directory, before it is asked what it is.
          if (d.isSymbolicLink()) {
            refusals.push({ skill_id: s.skill_id, path: child, why: "symlink — may resolve outside the skill directory" });
            continue;
          }

          const decision = carryDecision(child);
          if (d.isDirectory()) {
            if (!decision.carry && REFUSED_DIRS.has(d.name)) {
              refusals.push({ skill_id: s.skill_id, path: child, why: decision.why });
              continue;
            }
            walk(child);
            continue;
          }
          if (!decision.carry) {
            refusals.push({ skill_id: s.skill_id, path: child, why: decision.why });
            continue;
          }
          mkdirSync(join(dest, child).replace(/[/\\][^/\\]+$/, ""), { recursive: true });
          writeFileSync(join(dest, child), readFileSync(join(srcDir, child)));
        }
      };
      walk("");
      entries.push({ skill_id: s.skill_id, name: s.name, bucket: s.bucket, reason: s.reason,
                     content_hash: s.content_hash ?? hash(text), invocation_id: `${manifest.name}:${slug(s.skill_id)}` });
    }

    writeFileSync(join(path, "pack.json"), JSON.stringify({
      schema_version: SCHEMA_VERSION, project_id: projectId, task_id: taskId,
      built_at: new Date().toISOString(), manifest_name: manifest.name, entries, refusals,
    }, null, 2) + "\n");

    return { ok: true, path, manifest, entries, refusals };
  } catch (e) {
    return { ok: false, code: "PACK_BUILD_FAILED", message: `${path}: ${e.message}` };
  }
}

export function packState({ projectId, taskId, root = packsRoot() }) {
  const path = packPathFor(projectId, taskId, { root });
  if (!existsSync(join(path, ".claude-plugin", "plugin.json"))) return { exists: false, path, skillIds: [] };
  let skillIds = [];
  try { skillIds = readdirSync(join(path, "skills")).filter((d) => statSync(join(path, "skills", d)).isDirectory()); }
  catch { skillIds = []; }
  return { exists: true, path, skillIds };
}

export function removePack({ projectId, taskId, root = packsRoot() }) {
  const path = packPathFor(projectId, taskId, { root });
  if (!existsSync(path)) return { ok: true, removed: false, path };
  try { rmSync(path, { recursive: true, force: true }); } catch { /* reported by the existsSync below */ }
  return { ok: !existsSync(path), removed: !existsSync(path), path };
}
