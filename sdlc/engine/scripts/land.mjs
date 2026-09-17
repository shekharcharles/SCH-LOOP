#!/usr/bin/env node
// SCH Loop — put delivered work where the operator can see it.
//
// WHY THIS EXISTS
// Every task branches from the default branch, receives its dependency's work
// through `deps`, and delivers to its own `sch/task-N` branch. Nothing ever
// merges back. After seven delivered tasks the operator opened the project
// folder and found a README — the application existed only on a branch nobody
// had told them about.
//
// WHAT IT IS NOT
// It is not part of delivery, and it never runs on its own. Landing changes the
// branch the operator works on, so it is a decision they make, the same way
// delivery approval is. It refuses rather than guesses:
//
//   * a dirty working tree is never stashed, reset, or worked around
//   * a merge that conflicts is left conflicted for a person, never auto-resolved
//   * nothing is force-pushed, amended or rebased, here or anywhere
//   * it lands the delivered TIP only — a chain, not a pile of merges

import { execFileSync } from "node:child_process";
import { loadState, getProject, mutateState, event } from "./state.mjs";

const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 22 }).trim();

export function landingPlan(projectId) {
  const p = getProject(projectId);
  if (!p) return { ok: false, reason: `no such project "${projectId}"` };
  const root = p.path;

  let branch, dirty;
  try {
    branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
    dirty = git(root, "status", "--porcelain");
  } catch (e) { return { ok: false, reason: "not a git repository: " + String(e.message).split("\n")[0] }; }

  const delivered = (loadState(projectId).tasks || [])
    .filter((t) => ["merged", "delivered"].includes(t.status));
  if (!delivered.length) return { ok: false, reason: "nothing has been delivered yet" };

  const tip = delivered[delivered.length - 1];
  const tipBranch = tip.branch || `sch/task-${tip.id}`;
  let exists = true;
  try { git(root, "rev-parse", "--verify", tipBranch); } catch { exists = false; }
  if (!exists) {
    try { git(root, "rev-parse", "--verify", "origin/" + tipBranch); } catch {
      return { ok: false, reason: `neither ${tipBranch} nor origin/${tipBranch} exists — the branch was pruned` };
    }
  }

  let ahead = 0, files = [];
  try {
    const ref = exists ? tipBranch : "origin/" + tipBranch;
    ahead = Number(git(root, "rev-list", "--count", `${branch}..${ref}`)) || 0;
    files = git(root, "diff", "--name-only", `${branch}..${ref}`).split("\n").filter(Boolean);
  } catch { /* reported as zero */ }

  return {
    ok: true, root, branch, tip_task: tip.id, tip_branch: exists ? tipBranch : "origin/" + tipBranch,
    commits_ahead: ahead, files,
    dirty: dirty ? dirty.split("\n").filter(Boolean) : [],
    would_change: ahead > 0,
  };
}

export function land(projectId, { dryRun = false } = {}) {
  const plan = landingPlan(projectId);
  if (!plan.ok) return plan;
  if (!plan.would_change) return { ...plan, landed: false, note: `${plan.branch} already contains the delivered work` };
  if (plan.dirty.length)
    return { ...plan, ok: false, landed: false,
             reason: `the working tree is not clean — commit or stash first. Nothing here will do it for you:\n  ${plan.dirty.join("\n  ")}` };
  if (dryRun) return { ...plan, landed: false, dry_run: true };

  try {
    // --no-ff so the landing is one reviewable commit rather than a silent
    // fast-forward that leaves no record of the decision.
    const out = git(plan.root, "merge", "--no-ff", "--no-edit", plan.tip_branch,
      "-m", `land: task #${plan.tip_task} (${plan.tip_branch}) into ${plan.branch}`);
    const head = git(plan.root, "rev-parse", "HEAD");
    mutateState(projectId, (s) => event(s, `landed ${plan.tip_branch} into ${plan.branch} (${head.slice(0, 8)})`));
    return { ...plan, landed: true, commit: head, output: out.split("\n").slice(-3).join("\n") };
  } catch (e) {
    const msg = String(e.stdout || e.message || e);
    return { ...plan, ok: false, landed: false,
             reason: "merge did not complete — resolve it yourself; nothing was reset or forced:\n" + msg.slice(0, 600) };
  }
}

if (process.argv[1] && process.argv[1].endsWith("land.mjs")) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf("--" + n); return i === -1 ? undefined : argv[i + 1]; };
  const project = flag("project") ?? argv[0];
  if (!project) { console.error("error: need --project <id>"); process.exit(2); }
  const r = land(project, { dryRun: argv.includes("--dry-run") });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok === false ? 1 : 0);
}
