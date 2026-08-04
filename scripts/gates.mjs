#!/usr/bin/env node
// SCH Loop — the named gate registry.
//
// WHY THIS EXISTS
// "It passed" was previously a boolean somewhere in a function. A boolean tells
// an operator nothing at 3am: passed WHAT, against WHICH evidence, and would it
// still pass? So a gate here returns a REPORT — every item it checked, whether
// that item passed, and a reference to the evidence it read — and the report is
// hashed so "the same gate on the same evidence" is a checkable claim rather
// than a hope.
//
// TWO KINDS, AND THE DIFFERENCE IS ABSOLUTE:
//
//   FACTUAL  — states something about the world. The diff is what it is; the
//              secret is there or it is not; the commit is on the remote or it
//              is not. NOBODY overrides these. Not an agent, not the operator.
//   POLICY   — states something about a rule we chose. A person may override
//              their own rule, on the record, with a reason.
//
// A gate does not DO the work. Everything expensive already happened in the
// runner, the delivery controller or a verification command; a gate reads the
// evidence those produced and decides. That is why a gate is cheap, repeatable,
// and cannot disagree with the thing it is grading.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const now = () => new Date().toISOString();
const clamp = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));

export const OUTCOMES = ["PASS", "FAIL", "SKIP"];

// ------------------------------------------------------------- report shape

// Stable hash of what was checked, so a later run can say "the evidence changed"
// instead of "it passed last time".
const stable = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
};

export function report(gate, checks, { outcome = null, note = "", startedAt, evidence = {} }) {
  const decided = outcome ?? (checks.length === 0 ? "SKIP" : checks.every((c) => c.passed) ? "PASS" : "FAIL");
  const body = { gate_id: gate.id, gate_version: gate.version, checks, evidence };
  return {
    schema_version: SCHEMA_VERSION,
    gate_id: gate.id, gate_version: gate.version, kind: gate.kind,
    overridable: gate.kind === "POLICY",
    outcome: decided,
    note: clamp(note, 1000),
    checks: checks.map((c) => ({ item: clamp(c.item, 400), passed: Boolean(c.passed), evidence: clamp(c.evidence ?? "", 600) })),
    evidence_hash: createHash("sha256").update(stable(body)).digest("hex"),
    started_at: startedAt, ended_at: now(),
  };
}

// A gate that could not run is not a gate that passed. Recorded as FAIL with the
// reason, never as SKIP — SKIP is for "this project does not use this gate".
const cannotRun = (gate, why, startedAt) =>
  report(gate, [{ item: gate.id, passed: false, evidence: why }], { outcome: "FAIL", note: why, startedAt });

const artifact = (p) => "artifact://" + String(p ?? "").replace(/\\/g, "/");
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

// ------------------------------------------------------------------ the gates
//
// `ctx` is whatever the phase engine has gathered so far. A gate that needs
// something absent says so and FAILS — default-fail is the entire design.

export const GATES = {

  // --- readiness ------------------------------------------------------------

  "project-workspace-valid": {
    id: "project-workspace-valid", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      const w = ctx.workspace;
      if (!w) return cannotRun(this, "no workspace validation was performed", t0);
      const checks = [{ item: `${ctx.project_id}: .sch-loop workspace`, passed: (w.problems ?? []).length === 0,
        evidence: (w.problems ?? []).map((p) => `${p.code}: ${p.message}`).join("; ") || `valid at ${w.dir}` }];
      return report(this, checks, { startedAt: t0, evidence: { root: w.root, dir: w.dir } });
    },
  },

  "task-ready": {
    id: "task-ready", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      const r = ctx.readiness;
      if (!r) return cannotRun(this, "readiness was not computed", t0);
      const checks = r.blockers.length
        ? r.blockers.map((b) => ({ item: b.code, passed: false, evidence: b.detail }))
        : [{ item: `task #${r.task_id} is ${r.state} with every dependency satisfied`, passed: true, evidence: "no blockers" }];
      return report(this, checks, { startedAt: t0, evidence: { state: r.state } });
    },
  },

  "dependency-graph-valid": {
    id: "dependency-graph-valid", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      const v = ctx.graph_validation;
      if (!v) return cannotRun(this, "the graph was not validated", t0);
      const checks = v.problems.length
        ? v.problems.map((p) => ({ item: p.code, passed: false, evidence: p.message }))
        : [{ item: `${v.tasks} task(s), ${v.edges} edge(s)`, passed: true, evidence: `no structural problems${v.warnings.length ? ` (${v.warnings.length} audit warning(s))` : ""}` }];
      return report(this, checks, { startedAt: t0, evidence: { warnings: v.warnings.map((w) => w.code) } });
    },
  },

  "skills-approved": {
    id: "skills-approved", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      // "No skill problem was reported" is only evidence if something actually
      // looked. An absent preflight is an absent check, and an absent check
      // fails — that is what default-fail means.
      if (!Array.isArray(ctx.preflight_failures)) return cannotRun(this, "preflight did not run, so no skill was checked for approval", t0);
      const f = ctx.preflight_failures.filter((x) => ["SKILL_NOT_APPROVED", "SKILL_HASH_STALE"].includes(x.code));
      const sel = ctx.skills?.selected ?? [];
      const checks = f.length
        ? f.map((x) => ({ item: x.code, passed: false, evidence: x.message }))
        : sel.length
          ? sel.map((s) => ({ item: s.skill_id, passed: true, evidence: `${s.trust} @ ${String(s.content_hash).slice(0, 12)} (${s.bucket}: ${s.reason})` }))
          : [{ item: "no skill selected", passed: true, evidence: "the recommendation engine selected none for this task type" }];
      return report(this, checks, { startedAt: t0 });
    },
  },

  "executor-ready": {
    id: "executor-ready", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      if (!Array.isArray(ctx.preflight_failures)) return cannotRun(this, "preflight did not run, so nothing checked the executor or the task policy", t0);
      const f = ctx.preflight_failures.filter((x) => ["ENVIRONMENT_MISSING", "TASK_INELIGIBLE", "WORKSPACE_INVALID", "PATH_POLICY_MISSING", "UNSAFE_VERIFICATION_COMMAND", "DEPENDENCY_INCOMPLETE", "LEASE_CONFLICT", "POLICY_VIOLATION"].includes(x.code));
      const checks = f.length
        ? f.map((x) => ({ item: x.code, passed: false, evidence: x.message }))
        : [{ item: "executor + task policy", passed: true, evidence: ctx.executor_id ?? "resolved" }];
      return report(this, checks, { startedAt: t0 });
    },
  },

  "prompt-budget-valid": {
    id: "prompt-budget-valid", version: 1, kind: "POLICY",
    evaluate(ctx) {
      const t0 = now();
      const m = ctx.prompt_manifest;
      if (!m) return cannotRun(this, "no prompt manifest was recorded for this attempt", t0);
      const limit = ctx.prompt_limit ?? m.limit_characters;
      const checks = [{ item: `prompt ${m.total_characters}/${limit} characters`, passed: m.total_characters <= limit,
        evidence: `${m.sections.filter((s) => s.included).length} section(s) included, ${m.compacted.length} compacted` }];
      return report(this, checks, { startedAt: t0, evidence: { unit: m.unit } });
    },
  },

  // --- what the worker actually did ----------------------------------------

  "handoff-valid": {
    id: "handoff-valid", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      const e = ctx.envelope_result;
      if (!e) return cannotRun(this, "no envelope was parsed for this phase", t0);
      if (!e.ok) return report(this, [{ item: e.failure.code, passed: false, evidence: e.failure.message }], { startedAt: t0 });
      const checks = [
        { item: `envelope ${e.envelope_type}`, passed: true, evidence: `hash ${String(e.hash).slice(0, 16)}${e.adapted ? " (adapted from the legacy worker handoff)" : ""}` },
        { item: `agent status ${e.envelope.status}`, passed: e.envelope.status === "SUCCESS", evidence: clamp(e.envelope.summary, 300) },
      ];
      return report(this, checks, { startedAt: t0, evidence: { envelope_hash: e.hash } });
    },
  },

  "worker-effects-contained": {
    id: "worker-effects-contained", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      const fx = ctx.effects;
      if (!fx) return cannotRun(this, "repository effects were not inspected", t0);
      const checks = [
        { item: "no path outside the task policy", passed: (fx.rejected_paths ?? []).length === 0,
          evidence: (fx.rejected_paths ?? []).map((r) => `${r.path} (${r.why})`).join("; ") || `${(fx.paths ?? []).length} path(s), all in policy` },
        { item: "nothing staged, committed or pushed by the worker", passed: (fx.git_effects ?? []).length === 0,
          evidence: (fx.git_effects ?? []).map((e) => `${e.kind}: ${e.detail}`).join("; ") || "the working tree carries the change, unstaged" },
      ];
      return report(this, checks, { startedAt: t0, evidence: { counts: fx.counts } });
    },
  },

  "changed-paths-allowed": {
    id: "changed-paths-allowed", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      const fx = ctx.effects;
      if (!fx) return cannotRun(this, "repository effects were not inspected", t0);
      const rejected = new Map((fx.rejected_paths ?? []).map((r) => [r.path, r.why]));
      const checks = (fx.paths ?? []).map((p) => ({
        item: p.path, passed: !rejected.has(p.path),
        evidence: rejected.get(p.path) ?? `${p.kind}, allowed by policy`,
      }));
      for (const [path, why] of rejected) if (!(fx.paths ?? []).some((p) => p.path === path)) checks.push({ item: path, passed: false, evidence: why });
      if (!checks.length) checks.push({ item: "no path changed", passed: true, evidence: "the worker changed nothing" });
      return report(this, checks, { startedAt: t0, evidence: { artifact: ctx.effects_artifact ? artifact(ctx.effects_artifact) : null } });
    },
  },

  "forbidden-git-effects-absent": {
    id: "forbidden-git-effects-absent", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      const fx = ctx.effects;
      if (!fx) return cannotRun(this, "repository effects were not inspected", t0);
      const kinds = fx.git_effects ?? [];
      const checks = kinds.length
        ? kinds.map((e) => ({ item: e.kind, passed: false, evidence: e.detail }))
        : [{ item: "HEAD, branch, index, stash, remotes and config unchanged", passed: true, evidence: "no forbidden git effect observed after the worker exited" }];
      return report(this, checks, { startedAt: t0 });
    },
  },

  // --- did it work ----------------------------------------------------------

  "required-verification-passed": {
    id: "required-verification-passed", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      const v = ctx.verification;
      if (!v) return cannotRun(this, "the required verification did not run", t0);
      const checks = (v.results ?? []).map((r) => ({
        item: `${r.id}: ${r.display ?? ""}`.trim(), passed: r.result === "PASSED",
        evidence: `${r.result}, exit ${r.exit_code}${r.timed_out ? " (timed out)" : ""}${r.duration_ms !== undefined ? `, ${r.duration_ms}ms` : ""}`,
      }));
      if (!checks.length) checks.push({ item: "verification", passed: false, evidence: "no verification command was recorded — a task with no proof is not verified" });
      return report(this, checks, { startedAt: t0, evidence: { passed: v.passed, failed: v.failed } });
    },
  },

  "secret-scan-passed": {
    id: "secret-scan-passed", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      const paths = (ctx.effects?.paths ?? []).map((p) => p.path).filter(Boolean);
      if (!ctx.repo_root) return cannotRun(this, "no repository root to scan", t0);
      if (!paths.length) return report(this, [{ item: "no changed path to scan", passed: true, evidence: "the worker changed nothing" }], { startedAt: t0 });
      let out = "", code = 0;
      try {
        out = execFileSync(process.execPath, [join(REPO, "scripts", "secret-scan.mjs"), "--paths", ...paths],
          { cwd: ctx.repo_root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) { code = e.status ?? 1; out = String(e.stdout ?? "") + String(e.stderr ?? ""); }
      const checks = [{ item: `${paths.length} changed path(s)`, passed: code === 0, evidence: clamp(out.trim() || "clean", 600) }];
      return report(this, checks, { startedAt: t0, evidence: { scanner: "scripts/secret-scan.mjs" } });
    },
  },

  // --- delivery -------------------------------------------------------------

  "verified-diff-unchanged": {
    id: "verified-diff-unchanged", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      const c = ctx.candidate_comparison;
      if (!c) return cannotRun(this, "the verified candidate was never compared against the current tree", t0);
      const checks = [{ item: "the tree about to be delivered is the tree that was verified", passed: Boolean(c.same),
        evidence: c.same ? `diff hash ${String(c.verified_diff_hash ?? "").slice(0, 16)} unchanged` : (c.differences ?? []).map((d) => `${d.path}: ${d.why}`).join("; ") || "the content hash changed" }];
      return report(this, checks, { startedAt: t0 });
    },
  },

  "delivery-approval-valid": {
    id: "delivery-approval-valid", version: 1, kind: "POLICY",
    evaluate(ctx) {
      const t0 = now();
      const a = ctx.approval;
      if (!a) return cannotRun(this, "no approval state was read for this delivery", t0);
      const ok = a.state === "APPROVED" || a.state === "NO_APPROVAL_REQUIRED";
      const checks = [{ item: `delivery approval: ${a.state}`, passed: ok,
        evidence: a.state === "APPROVED" ? `approved by ${a.approver ?? "(unrecorded)"} at ${a.at ?? "(unrecorded)"}` : (a.why ?? a.state) }];
      return report(this, checks, { startedAt: t0 });
    },
  },

  "outgoing-commit-safe": {
    id: "outgoing-commit-safe", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      const tx = ctx.transaction;
      if (!tx) return cannotRun(this, "no delivery transaction to inspect", t0);
      const outgoing = tx.outgoing ?? tx.outgoing_commits ?? [];
      const incoming = tx.incoming ?? tx.incoming_commits ?? [];
      const mine = tx.commit?.hash ?? null;
      const unrelated = outgoing.filter((c) => (c.hash ?? c) !== mine);
      const checks = [
        { item: "exactly one outgoing commit, and it is this task's", passed: outgoing.length === 1 && unrelated.length === 0,
          evidence: outgoing.length ? outgoing.map((c) => `${String(c.hash ?? c).slice(0, 8)} ${clamp(c.subject ?? "", 80)}`).join("; ") : "nothing outgoing" },
        { item: "no incoming commit to merge or rebase over", passed: incoming.length === 0,
          evidence: incoming.length ? `${incoming.length} incoming` : "the remote has not moved" },
      ];
      return report(this, checks, { startedAt: t0 });
    },
  },

  "remote-commit-present": {
    id: "remote-commit-present", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      const tx = ctx.transaction;
      if (!tx) return cannotRun(this, "no delivery transaction to inspect", t0);
      const v = tx.remote_verification ?? null;
      const clean = Boolean(v) && (v.problems ?? []).length === 0 && v.independent_fetch === true;
      const checks = [{ item: "the commit exists on the remote branch, proved by an independent fetch", passed: clean,
        evidence: v
          ? (clean
              ? `${String(v.commit ?? v.remote_head).slice(0, 12)} on ${v.remote_ref ?? `${tx.remote}/${tx.remote_branch}`}, range ${v.pushed_range ?? "?"}`
              : (v.problems ?? []).join("; ") || "the verification fetch was not independent")
          : "the delivery never reached remote verification" }];
      return report(this, checks, { startedAt: t0 });
    },
  },

  "task-completion-valid": {
    id: "task-completion-valid", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      const t = ctx.task;
      if (!t) return cannotRun(this, "no task record to check", t0);
      const d = t.delivery ?? null;
      const checks = [
        { item: "the task carries delivery provenance", passed: Boolean(d?.commit && d?.remote && d?.branch),
          evidence: d ? `${String(d.commit).slice(0, 8)} on ${d.remote}/${d.branch} (delivery ${d.delivery_id})` : "no provenance" },
        { item: "the task state is DELIVERED", passed: ctx.task_state === "DELIVERED", evidence: `state is ${ctx.task_state}` },
      ];
      return report(this, checks, { startedAt: t0 });
    },
  },

  // --- the project ----------------------------------------------------------

  "project-completion-valid": {
    id: "project-completion-valid", version: 1, kind: "FACTUAL",
    evaluate(ctx) {
      const t0 = now();
      const c = ctx.completion;
      if (!c) return cannotRun(this, "project completion was not evaluated", t0);
      const checks = c.reasons.map((r) => ({ item: r.item, passed: r.passed, evidence: r.evidence }));
      return report(this, checks, { startedAt: t0 });
    },
  },
};

export const GATE_IDS = Object.keys(GATES);
export const isFactual = (id) => GATES[id]?.kind === "FACTUAL";

// --------------------------------------------------------------- evaluation

// Run a named set. Every gate runs — stopping at the first failure hides the
// other three things that are also wrong, and an operator reading one line at
// 3am deserves the whole list.
export function evaluate(ids, ctx) {
  const reports = [];
  for (const id of ids) {
    const g = GATES[id];
    if (!g) {
      reports.push({ schema_version: SCHEMA_VERSION, gate_id: id, gate_version: 0, kind: "FACTUAL", overridable: false,
        outcome: "FAIL", note: `no gate named "${id}" is registered`, checks: [], evidence_hash: null, started_at: now(), ended_at: now() });
      continue;
    }
    try { reports.push(g.evaluate(ctx)); }
    catch (e) { reports.push(cannotRun(g, `the gate threw: ${e.message}`, now())); }
  }
  const failed = reports.filter((r) => r.outcome === "FAIL");
  return {
    schema_version: SCHEMA_VERSION,
    outcome: failed.length ? "FAIL" : "PASS",
    passed: reports.filter((r) => r.outcome === "PASS").map((r) => r.gate_id),
    failed: failed.map((r) => r.gate_id),
    // A failed FACTUAL gate is the end of the conversation. Recorded explicitly
    // so no caller has to re-derive which of its failures were negotiable.
    factual_failures: failed.filter((r) => r.kind === "FACTUAL").map((r) => r.gate_id),
    policy_failures: failed.filter((r) => r.kind === "POLICY").map((r) => r.gate_id),
    reports,
  };
}

// An override is a POLICY act on a POLICY gate. Attempting it on a factual gate
// is refused loudly — "the secret is not there because I said so" is not a
// decision anyone gets to make.
export function override(gateId, { approver, reason }) {
  const g = GATES[gateId];
  if (!g) return { ok: false, failure: { code: "UNKNOWN_GATE", message: `no gate named "${gateId}"` } };
  if (g.kind === "FACTUAL")
    return { ok: false, failure: { code: "FACTUAL_GATE_NOT_OVERRIDABLE", message:
      `"${gateId}" states a fact about the repository or the remote. It cannot be overridden by anyone — change the world, then run it again.` } };
  if (!approver || !reason) return { ok: false, failure: { code: "OVERRIDE_INCOMPLETE", message: "an override needs an approver and a reason" } };
  return { ok: true, override: { gate_id: gateId, gate_version: g.version, approver, reason: clamp(reason, 500), at: now() } };
}
