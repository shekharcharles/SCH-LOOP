#!/usr/bin/env node
// SCH Loop — the delivery candidate: what was verified, expressed as identity.
//
// A run that says VERIFIED is a claim about a moment. Between that moment and a
// push, a file can be edited, a build can rewrite a generated file, an operator
// can fix a typo. So "deliver the verified run" is only meaningful if the thing
// verified can be recognised again — by content, not by description.
//
// This module is that recognition. It is shared by the runner (which records the
// candidate the instant verification passes) and the delivery controller (which
// recomputes it immediately before staging and refuses to proceed on any drift).
// It lives apart from both so neither has to import the other.
//
// Everything here is arg-vector git and pure hashing: no state, no network, no
// mutation of any repository.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as WS from "./workspace.mjs";

export const SCHEMA_VERSION = 1;
const ZERO = "0000000000000000000000000000000000000000";
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------- git plumbing

// Argv shapes SCH must never produce against a managed project. Checked on
// EVERY call rather than trusted to code review: `git add -A` is one careless
// edit away from staging an operator's unrelated work into a pushed commit.
// The ONE merge SCH performs, carved out of the blanket refusal above and kept
// deliberately unusable for anything else.
//
// A task's dependencies are code it is expected to build on. Constructing that
// starting tree requires merging each delivered dependency's branch into the
// task's fresh branch. That is not the thing the blanket rule protects against:
// nothing is integrated into the operator's branches, no conflict is resolved
// silently (a conflict aborts and stops the task), and the result lives only in
// a disposable per-task checkout.
//
// The shape is pinned exactly: `merge --no-ff -m <msg> sch/task-<n>`. Any other
// merge - a different flag, a fast-forward, an operator branch, a bare `merge` -
// is still refused.
const DEP_BRANCH = /^sch\/task-\d+$/;
const isDependencyIntegration = (a) =>
  (a.length === 5 && a[0] === "merge" && a[1] === "--no-ff" && a[2] === "-m" && DEP_BRANCH.test(a[4]))
  // Aborting only ever restores the tree to what it was. Refusing it would
  // leave a conflicted checkout behind on the one path that must clean up.
  || (a.length === 2 && a[0] === "merge" && a[1] === "--abort");

const FORBIDDEN_ARGV = [
  [(a) => a[0] === "add" && a.slice(1).some((x) => ["-A", "--all", "--no-ignore-removal", "-u", "--update"].includes(x)),
    "git add -A / --all / -u stages files nobody approved"],
  [(a) => a[0] === "add" && a.slice(1).some((x) => x === "." || x === ":/" || x === "*"),
    "git add . stages files nobody approved"],
  [(a) => a[0] === "add" && !a.includes("--"),
    "every `git add` must separate its pathspecs with `--`"],
  [(a) => a[0] === "commit" && a.slice(1).some((x) => ["-a", "--all", "-am", "--amend"].includes(x)),
    "git commit -a / --amend is never used by the delivery controller"],
  [(a) => ["push", "fetch"].includes(a[0]) && a.some((x) => ["--force", "-f", "--force-with-lease", "--mirror", "--prune", "--delete"].includes(x)),
    "force, mirror, prune and delete are never used against a remote"],
  [(a) => a[0] === "push" && (a.includes("--all") || a.includes("--tags") || a.includes("--follow-tags")),
    "pushing all branches or tags is never correct here"],
  [(a) => a[0] === "push" && a.slice(1).some((x) => !x.startsWith("-") && (x.includes("*") || x.startsWith(":"))),
    "a wildcard refspec, or one that deletes a remote ref, is never used"],
  [(a) => a[0] === "reset" && a.includes("--hard"),
    "git reset --hard destroys work the operator may not have finished"],
  [(a) => ["rebase", "cherry-pick", "revert", "filter-branch", "merge", "clean", "stash"].includes(a[0]) && !isDependencyIntegration(a),
    "rebase, cherry-pick, revert, filter-branch, merge, clean and stash are never run automatically"],
  [(a) => a[0] === "worktree" && !["add", "remove", "list", "prune"].includes(a[1]),
    "git worktree is only ever used to add, remove, list or prune a task's checkout"],
];

export function assertSafeGitArgs(args) {
  const a = args.map(String);
  for (const [test, why] of FORBIDDEN_ARGV)
    if (test(a)) throw new Error(`REFUSED git ${a.join(" ")} — ${why}`);
  return true;
}

// Every git invocation SCH makes against a managed project, in order. Tests
// assert on this rather than on a promise that the forbidden forms are unused.
let AUDIT = null;
export const setGitAudit = (fn) => { AUDIT = fn; };
export const gitAuditOff = () => { AUDIT = null; };

// Arg-vector only. No shell, ever — a branch name and a path are both
// attacker-influenced input as far as this code is concerned.
export function gitRun(cwd, args, { input = null, maxBytes = 16 * 1024 * 1024, env = process.env } = {}) {
  assertSafeGitArgs(args);
  if (AUDIT) AUDIT(args.map(String));
  const r = spawnSync("git", args, {
    cwd, input: input ?? undefined, maxBuffer: maxBytes, windowsHide: true, encoding: "utf8",
    // No interactive credential prompt can block a delivery forever, and no
    // optional lock is taken on a read.
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return {
    ok: r.status === 0, code: r.status, signal: r.signal ?? null,
    stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""),
    args: args.map(String), error: r.error ? r.error.message : null,
  };
}
export const gitOut = (cwd, ...args) => { const r = gitRun(cwd, args); return r.ok ? r.stdout.trim() : null; };

// A remote URL can carry credentials; only the redacted form is ever recorded.
export const redactRemote = (url) =>
  String(url ?? "").replace(/\/\/[^/@\s]*@/, "//[redacted]@").replace(/:\/\/[^/]*:[^@/]*@/, "://[redacted]@");
export const hasCredentials = (url) => /\/\/[^/@\s]*:[^@/\s]*@/.test(String(url ?? ""));

// --------------------------------------------------------------- porcelain

// `git status --porcelain=v2 -z`, parsed. This is the only status view that
// carries both the file modes and the blob ids, which is what makes a candidate
// provable rather than merely describable.
export function parseV2(raw) {
  const parts = String(raw ?? "").split("\0");
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const k = e[0];
    if (k === "1" || k === "2") {
      const f = e.split(" ");
      const rename = k === "2";
      const pathFrom = rename ? 9 : 8;
      out.push({
        kind: k, xy: f[1], mode_head: f[3], mode_index: f[4], mode_worktree: f[5],
        blob_head: f[6], blob_index: f[7], score: rename ? f[8] : null,
        // A path may contain spaces, so it is everything from its field onward.
        path: f.slice(pathFrom).join(" "),
        from: rename ? (parts[++i] ?? null) : null,
      });
    } else if (k === "u") {
      const f = e.split(" ");
      out.push({ kind: "u", xy: f[1], path: f.slice(10).join(" "), from: null });
    } else if (k === "?" || k === "!") {
      out.push({ kind: k, xy: k === "?" ? "??" : "!!", path: e.slice(2), from: null });
    }
  }
  return out;
}

// The blob a file's CURRENT worktree content would hash to. Batched, always
// after `--` so a filename beginning with `-` is read as a filename.
function worktreeBlobs(repoRoot, paths) {
  if (!paths.length) return {};
  const r = gitRun(repoRoot, ["hash-object", "--", ...paths]);
  if (!r.ok) return Object.fromEntries(paths.map((p) => [p, null]));
  const lines = r.stdout.trim().split("\n");
  return Object.fromEntries(paths.map((p, i) => [p, lines[i] ?? null]));
}

// THE CANDIDATE: every effect in the working tree, as content identity.
// Computed identically at verification time and again immediately before
// staging, so "the diff has not changed" is a comparison of two hashes rather
// than an act of faith. Ignored runtime artifacts are excluded — they are SCH's
// own evidence, they are never delivered, and they change constantly.
export function worktreeManifest(repoRoot) {
  const raw = gitRun(repoRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  if (!raw.ok) return { ok: false, error: raw.stderr || raw.error, entries: [] };
  const rows = parseV2(raw.stdout).filter((e) => e.kind !== "!" && !WS.isRuntimePath(e.path));
  const present = rows.filter((e) => !(e.kind === "1" && e.mode_worktree === "000000"));
  const blobs = worktreeBlobs(repoRoot, present.map((e) => e.path));
  const entries = rows.map((e) => {
    const deleted = e.kind === "1" && e.mode_worktree === "000000";
    const untracked = e.kind === "?";
    return {
      path: e.path,
      status: deleted ? "D" : untracked ? "A" : e.kind === "2" ? "R" : e.blob_head === ZERO ? "A" : "M",
      from: e.from ?? null,
      // Modes are meaningful for TRACKED files, where a file becoming executable
      // is a real change. For an untracked file git assigns the mode at `git add`
      // time, so there is nothing honest to record about it beforehand.
      mode_head: untracked ? null : (e.mode_head === "000000" ? null : e.mode_head),
      mode_worktree: untracked || deleted ? null : e.mode_worktree,
      blob: deleted ? null : (blobs[e.path] ?? null),
      unmerged: e.kind === "u",
    };
  });
  return { ok: true, entries: sortEntries(entries) };
}

// The same identity, read back out of the INDEX after staging. Directly
// comparable with the worktree manifest — that comparability is the whole
// reason both are {path, status, blob} rather than diff text.
export function stagedManifest(repoRoot) {
  const raw = gitRun(repoRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  if (!raw.ok) return { ok: false, error: raw.stderr || raw.error, entries: [] };
  const entries = [];
  for (const e of parseV2(raw.stdout)) {
    if ((e.kind !== "1" && e.kind !== "2") || e.xy[0] === "." || WS.isRuntimePath(e.path)) continue;
    const rec = {
      path: e.path,
      status: e.mode_index === "000000" ? "D" : e.blob_head === ZERO ? "A" : "M",
      from: e.from ?? null,
      mode_index: e.mode_index === "000000" ? null : e.mode_index,
      blob: e.blob_index === ZERO ? null : e.blob_index,
    };
    if (e.kind === "2") {
      // Git detects renames only once both sides are in the index, and collapses
      // them into ONE entry. The worktree saw a deletion and an untracked file,
      // so expand the rename back into those two — otherwise the source path
      // looks like a candidate file that was never staged.
      entries.push({ path: e.from, status: "D", from: null, mode_index: null, blob: null });
      entries.push({ ...rec, status: "A", from: e.from });
    } else entries.push(rec);
  }
  return { ok: true, entries: sortEntries(entries) };
}

const sortEntries = (xs) => xs.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// ------------------------------------------------------- canonical hashing

// Sorted keys, sorted entries, no timestamps, no machine paths. The same content
// produces the same bytes on any machine and in any process.
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}
export const canonicalHash = (v) => sha(canonical(v));

// ------------------------------------------------------------- the binding

// What a delivery is bound to. Drift in ANY of these between verification and
// staging means the thing that was verified is not the thing about to be
// pushed, and the delivery stops rather than guessing which one was meant.
export function computeCandidate({ repoRoot, projectId, taskId, runId, baseline = null, verification = null, promptManifest = null, policy = null, outcome = null, verifiedAt = null }) {
  const manifest = worktreeManifest(repoRoot);
  if (!manifest.ok)
    return { ok: false, failure: { code: "INTERNAL_STATE_CONFLICT", message: `cannot read the working tree: ${manifest.error}` } };

  const head = gitOut(repoRoot, "rev-parse", "HEAD");
  const branch = gitOut(repoRoot, "rev-parse", "--abbrev-ref", "HEAD");
  const diffText = gitRun(repoRoot, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--binary", "HEAD", "--"]);

  // Three hashes, three questions:
  //   effects  — did the SHAPE of the change move (paths, kinds, modes)?
  //   diff     — did the CONTENT move (blob identity per path)?
  //   evidence — did what was actually tested, and its result, move?
  const effects = manifest.entries.map((e) => ({
    path: e.path, status: e.status, from: e.from,
    mode_head: e.mode_head, mode_worktree: e.mode_worktree, unmerged: e.unmerged,
  }));
  const contents = manifest.entries.map((e) => ({ path: e.path, status: e.status, from: e.from, blob: e.blob }));
  const evidence = (verification?.results ?? []).map((r) => ({
    id: r.id, executable: r.executable, args: r.args ?? [], exit_code: r.exit_code, result: r.result,
  }));

  return {
    ok: true,
    candidate: {
      schema_version: SCHEMA_VERSION,
      project_id: projectId, task_id: String(taskId), run_id: runId,
      // Identity of the repository this candidate belongs to, as a hash: the
      // real path is machine-specific and does not belong in a portable record.
      repository_identity: sha(WS.real(repoRoot).replace(/\\/g, "/").toLowerCase()),
      baseline_head: baseline?.repository?.head ?? null,
      head, branch,
      allowed_paths: policy?.allowed ?? [],
      forbidden_paths: policy?.forbidden ?? [],
      control_category: policy?.controlCategory ?? null,
      changed_paths: manifest.entries.map((e) => e.path),
      deletions: manifest.entries.filter((e) => e.status === "D").map((e) => e.path),
      renames: manifest.entries.filter((e) => e.status === "R").map((e) => ({ from: e.from, to: e.path })),
      untracked: manifest.entries.filter((e) => e.mode_head === null && e.status === "A").map((e) => ({ path: e.path, blob: e.blob })),
      mode_changes: manifest.entries.filter((e) => e.mode_head && e.mode_worktree && e.mode_head !== e.mode_worktree)
        .map((e) => ({ path: e.path, from: e.mode_head, to: e.mode_worktree })),
      submodules: manifest.entries.filter((e) => e.mode_worktree === "160000" || e.mode_head === "160000").map((e) => e.path),
      entries: manifest.entries,
      verification_results: evidence,
      skill_hashes: baseline?.capability_profile?.skill_hashes ?? {},
      prompt_manifest_hash: promptManifest ? canonicalHash(promptManifest) : null,
      outcome, verified_at: verifiedAt,
      verified_effects_hash: canonicalHash(effects),
      verified_diff_hash: canonicalHash(contents),
      verification_evidence_hash: canonicalHash(evidence),
      // Supplementary evidence only. The gate is the content manifest above:
      // diff TEXT can move with a git config change while the content is
      // identical, and that is a fact worth seeing, not a reason to refuse.
      diff_text_hash: diffText.ok ? sha(diffText.stdout) : null,
    },
  };
}

// Which of the three bindings drifted, in the language of the failure taxonomy.
export function compareCandidates(verified, current) {
  const drift = [];
  if (verified.baseline_head !== current.baseline_head || verified.head !== current.head)
    drift.push({ code: "BASELINE_HEAD_CHANGED", message: `HEAD was ${verified.head} when this was verified and is ${current.head} now` });
  if (verified.branch !== current.branch)
    drift.push({ code: "BRANCH_CHANGED", message: `the branch was "${verified.branch}" when this was verified and is "${current.branch}" now` });
  if (verified.verification_evidence_hash !== current.verification_evidence_hash)
    drift.push({ code: "VERIFIED_DIFF_CHANGED", message: "the deterministic verification evidence differs from what was recorded — re-run verification" });
  if (verified.verified_diff_hash !== current.verified_diff_hash) {
    const was = new Set(verified.changed_paths), is = new Set(current.changed_paths);
    const added = [...is].filter((p) => !was.has(p));
    const gone = [...was].filter((p) => !is.has(p));
    const detail = added.length || gone.length
      ? `${added.length ? `now also changed: ${added.join(", ")}. ` : ""}${gone.length ? `no longer changed: ${gone.join(", ")}. ` : ""}`
      : "the same paths, but their content differs. ";
    drift.push({ code: "VERIFIED_DIFF_CHANGED", message: `the working tree no longer matches what was verified. ${detail}Re-run verification before delivering.` });
  } else if (verified.verified_effects_hash !== current.verified_effects_hash) {
    drift.push({ code: "VERIFIED_DIFF_CHANGED", message: "file modes or rename structure changed since verification — re-run verification before delivering" });
  }
  return drift;
}

// Does the INDEX now hold exactly the candidate, and nothing else? Compared as
// content identity, so this is a proof rather than a path-name coincidence.
export function compareStaged(candidate, staged) {
  const problems = [];
  const want = new Map(candidate.entries.map((e) => [e.path, e]));
  const got = new Map(staged.entries.map((e) => [e.path, e]));

  for (const p of got.keys())
    if (!want.has(p)) problems.push({ code: "UNEXPECTED_STAGED_FILE", message: `"${p}" is staged but is not part of the verified candidate` });
  for (const p of want.keys())
    if (!got.has(p)) problems.push({ code: "STAGED_PATH_MISMATCH", message: `"${p}" is part of the verified candidate but is not staged` });

  for (const [p, w] of want) {
    const s = got.get(p);
    if (!s) continue;
    if (w.status === "D" && s.status !== "D")
      problems.push({ code: "STAGED_DIFF_MISMATCH", message: `"${p}" was deleted in the candidate but is staged as ${s.status}` });
    else if (w.status !== "D" && w.blob !== s.blob)
      problems.push({ code: "STAGED_DIFF_MISMATCH", message: `"${p}" staged as blob ${s.blob ?? "(none)"} but the verified content is ${w.blob ?? "(none)"}` });
    // Mode is only comparable for a file that was already tracked: git assigns
    // an untracked file's mode at `git add` time, so there is nothing to compare.
    if (w.mode_worktree && s.mode_index && w.mode_worktree !== s.mode_index)
      problems.push({ code: "STAGED_DIFF_MISMATCH", message: `"${p}" staged with mode ${s.mode_index} but the verified mode is ${w.mode_worktree}` });
  }
  return problems;
}
