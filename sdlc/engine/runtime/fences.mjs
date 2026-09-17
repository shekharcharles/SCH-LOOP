// The three fences a bypass-permissions executor must have (design §3.9). Any missing → refuse to start.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isBypass } from "./roles.mjs";

const gitDir = cwd => { try { return execFileSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8", windowsHide: true }).trim(); } catch { return null; } };
const toplevel = cwd => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true }).trim(); } catch { return null; } };

export function isWorktree(cwd) {
  const g = gitDir(cwd);
  return !!g && /[\\/]worktrees[\\/]/.test(path.resolve(cwd, g));
}

export function checkFences({ projectRoot, cwd, roles, config }) {
  const failures = [];
  const bypass = isBypass(roles.executor);
  if (!bypass) return { ok: true, bypass, failures: [], note: "executor is not in bypass mode; fences advisory" };

  // 1. worktree per ticket: the executor cwd must be a linked worktree, not the main checkout
  if (!isWorktree(cwd)) failures.push(`fence 1: executor cwd ${cwd} is not a git worktree (main checkout would be edited directly)`);

  // 2 + 3. hooks registered in the PROJECT's .claude/settings.json and present on disk
  const settingsFile = path.join(projectRoot, ".claude", "settings.json");
  let hooks = [];
  try { hooks = JSON.parse(fs.readFileSync(settingsFile, "utf8")).hooks?.PreToolUse || []; } catch { failures.push(`fence 2/3: cannot read ${settingsFile}`); }
  const cmds = hooks.flatMap(h => (h.hooks || []).map(x => x.command || ""));
  for (const [n, name, matcher] of [[2, "write-guard.mjs", /Write|Edit/], [3, "destructive-bash.mjs", /Bash/]]) {
    const entry = hooks.find(h => matcher.test(h.matcher || "") && (h.hooks || []).some(x => (x.command || "").includes(name)));
    if (!entry) failures.push(`fence ${n}: ${name} not registered under PreToolUse in ${settingsFile}`);
    if (!fs.existsSync(path.join(projectRoot, ".claude", "hooks", name))) failures.push(`fence ${n}: ${name} missing on disk`);
  }
  if (!cmds.length) failures.push("fence 2/3: no PreToolUse hooks at all");
  if (!(config?.protected_paths || []).length) failures.push("fence 2: config.md protected_paths is empty");

  return { ok: failures.length === 0, bypass, failures, toplevel: toplevel(cwd) };
}
