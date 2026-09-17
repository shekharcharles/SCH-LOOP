#!/usr/bin/env node
// SCH Loop — selective evidence compaction.
//
// WHY THIS EXISTS
// A passing test suite produces thousands of lines saying nothing happened.
// Feeding that into the next agent's prompt costs money to make its job harder:
// the signal it needs is "unit-tests passed", and the rest is noise the model
// must read past. A FAILING suite is the opposite — the excerpt is the entire
// point, and truncating it in the middle of a stack trace is worse than omitting
// it, because a half stack trace reads like a whole one.
//
// So:
//   PASSING  → one line and an artifact reference. Zero log characters.
//   FAILING  → bounded excerpts, classified, with the full artifact still on disk.
//
// Everything omitted is RECORDED. An agent that was not told something should be
// able to find out that it was not told, and so should the operator reading the
// manifest afterwards.

import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;

// Defaults straight from the milestone contract. `passing_excerpt_characters: 0`
// is not a typo — a passing check contributes no log text at all.
export const LIMITS = {
  passing_excerpt_characters: 0,
  failing_stdout_characters: 4000,
  failing_stderr_characters: 8000,
  max_failed_checks: 10,
  max_previous_attempt_summaries: 1,
};

export const FAILURE_CLASSES = [
  "TEST_FAILURE", "LINT_FAILURE", "FORMAT_FAILURE", "TYPE_FAILURE",
  "BUILD_FAILURE", "TIMEOUT", "ENVIRONMENT_MISSING", "CANCELLED", "UNCLASSIFIED",
];

const sha = (s) => createHash("sha256").update(String(s ?? "")).digest("hex");
const artifactRef = (p) => "artifact://" + String(p ?? "").replace(/\\/g, "/").replace(/^\/+/, "");

// Classify a deterministic failure from what the process actually did. Best
// effort and honest about it: UNCLASSIFIED is a real answer, not a fallback to
// guessing.
export function classify(result) {
  if (result.timed_out || result.outcome === "TIMEOUT") return "TIMEOUT";
  if (result.cancelled || result.outcome === "CANCELLED") return "CANCELLED";
  if (result.spawn_error) return "ENVIRONMENT_MISSING";
  const hay = `${result.id ?? ""} ${result.display ?? ""} ${(result.args ?? []).join(" ")}`.toLowerCase();
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  if (/\blint\b|eslint|ruff|clippy/.test(hay)) return "LINT_FAILURE";
  if (/\bfmt\b|format|prettier|gofmt/.test(hay)) return "FORMAT_FAILURE";
  if (/tsc|typecheck|type-check|mypy|flow/.test(hay)) return "TYPE_FAILURE";
  if (/\bbuild\b|webpack|vite build|compile/.test(hay)) return "BUILD_FAILURE";
  if (/\btest\b|jest|vitest|pytest|mocha/.test(hay) || /assertionerror|expect\(|✖|failing tests/.test(text)) return "TEST_FAILURE";
  return "UNCLASSIFIED";
}

// Keep the END of a log, not the beginning: the assertion that failed is at the
// bottom, and the first 4000 characters of a test run are the banner.
function tail(text, limit) {
  const s = String(text ?? "");
  if (limit <= 0) return { text: "", omitted_characters: s.length, kept: 0 };
  if (s.length <= limit) return { text: s, omitted_characters: 0, kept: s.length };
  const keptText = s.slice(s.length - limit);
  return { text: `… [${s.length - limit} earlier characters omitted]\n` + keptText, omitted_characters: s.length - limit, kept: limit };
}

// ---------------------------------------------------------- passing evidence

// One compact record per passing check. Note what is NOT here: stdout, stderr,
// duration breakdowns, warnings. The artifact reference is how anybody who wants
// them gets them.
export function compactPassing(result, { artifactPath = null } = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    check_id: result.id ?? "(unnamed)",
    outcome: "PASS",
    exit_code: result.exit_code ?? 0,
    duration_ms: result.duration_ms ?? 0,
    artifact: artifactPath ? artifactRef(artifactPath) : null,
    evidence_hash: sha(`${result.id}|${result.exit_code}|${result.stdout ?? ""}|${result.stderr ?? ""}`),
    // Said explicitly so nobody wonders whether the logs were lost.
    logs_omitted: true,
    omitted_characters: String(result.stdout ?? "").length + String(result.stderr ?? "").length,
    note: "a passing check contributes no log text to any prompt; the full record is in the artifact",
  };
}

// ---------------------------------------------------------- failing evidence

export function compactFailing(result, { artifactPath = null, limits = LIMITS, affectedFiles = null } = {}) {
  const out = tail(result.stdout, limits.failing_stdout_characters);
  const err = tail(result.stderr, limits.failing_stderr_characters);
  return {
    schema_version: SCHEMA_VERSION,
    check_id: result.id ?? "(unnamed)",
    outcome: "FAIL",
    failure_class: classify(result),
    executable: result.executable ?? null,
    // The argument vector, sanitized: an argument that looks like a credential
    // never reaches a prompt, an event or a projection.
    args: sanitizeArgs(result.args ?? []),
    exit_code: result.exit_code ?? null,
    timed_out: Boolean(result.timed_out),
    duration_ms: result.duration_ms ?? 0,
    stdout_excerpt: out.text,
    stderr_excerpt: err.text,
    // Only when deterministically known. Guessing which files a failure blames
    // is how a repairer gets sent to the wrong place.
    affected_files: Array.isArray(affectedFiles) ? affectedFiles : null,
    artifact: artifactPath ? artifactRef(artifactPath) : null,
    evidence_hash: sha(`${result.id}|${result.exit_code}|${result.stdout ?? ""}|${result.stderr ?? ""}`),
    omitted: {
      stdout_characters: out.omitted_characters,
      stderr_characters: err.omitted_characters,
      note: out.omitted_characters || err.omitted_characters
        ? "the excerpt keeps the END of the log, where the failure is; the full text is in the artifact"
        : "nothing omitted",
    },
  };
}

// A credential-shaped FLAG, whose value is the argument that follows it.
const CREDENTIAL_FLAG = /^--?[A-Za-z0-9_-]*(token|password|passwd|secret|api[-_]?key|auth|bearer|credential)[A-Za-z0-9_-]*$/i;
// A credential-bearing URL: scheme://user:pass@host.
const CREDENTIAL_URL = /:\/\/[^/@\s]+:[^@/\s]+@/;

export function sanitizeArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const s = String(args[i]);
    // `--token=abc`
    const inline = s.match(/^(--?[A-Za-z0-9_-]*(?:token|password|passwd|secret|key|auth|bearer|credential)[A-Za-z0-9_-]*)=(.+)$/i);
    if (inline) { out.push(`${inline[1]}=[redacted]`); continue; }
    if (CREDENTIAL_URL.test(s)) { out.push(s.replace(CREDENTIAL_URL, "://[redacted]@")); continue; }
    // `--token SECRET` — redacting the flag while printing its value is the
    // mistake this branch exists to not make.
    if (CREDENTIAL_FLAG.test(s)) {
      out.push(s);
      if (i + 1 < args.length && !String(args[i + 1]).startsWith("-")) { out.push("[redacted]"); i += 1; }
      continue;
    }
    out.push(s);
  }
  return out;
}

// ------------------------------------------------------- a whole verification

// Turn one `runVerification` result into the compact form the rest of the system
// carries around. Passing checks collapse to one line each; failing checks keep
// bounded excerpts, capped in NUMBER as well as in size.
export function compactVerification(verification, { runDir = null, limits = LIMITS } = {}) {
  const results = verification?.results ?? [];
  const pass = results.filter((r) => (r.outcome ?? r.result) === "PASSED");
  const failAll = results.filter((r) => (r.outcome ?? r.result) !== "PASSED");
  const fail = failAll.slice(0, limits.max_failed_checks);

  const art = (r) => (runDir ? `${runDir}/verification/${r.id}.json` : null);
  return {
    schema_version: SCHEMA_VERSION,
    total: results.length,
    passed: pass.length,
    failed: failAll.length,
    all_passed: Boolean(verification?.all_passed),
    passing: pass.map((r) => compactPassing(r, { artifactPath: art(r) })),
    failing: fail.map((r) => compactFailing(r, { artifactPath: art(r), limits })),
    omitted: {
      failed_checks: Math.max(0, failAll.length - fail.length),
      passing_log_characters: pass.reduce((n, r) => n + String(r.stdout ?? "").length + String(r.stderr ?? "").length, 0),
      note: failAll.length > fail.length
        ? `${failAll.length - fail.length} further failing check(s) omitted at the ${limits.max_failed_checks} cap; all are on disk`
        : "no failing check omitted",
    },
    evidence_hash: sha(results.map((r) => `${r.id}:${r.outcome ?? r.result}:${r.exit_code}`).join("|")),
  };
}

// ------------------------------------------------------- prompt-ready text

// The ONLY place compact evidence becomes prompt text. Passing checks are one
// line each with no logs. `max_previous_attempt_summaries` is applied by the
// caller, which knows how many attempts there were.
export function renderForPrompt(compact, { includePassing = true } = {}) {
  const lines = [];
  if (includePassing && compact.passing.length)
    lines.push(`PASSED (${compact.passing.length}): ` + compact.passing.map((c) => `${c.check_id} (${c.duration_ms}ms)`).join(", "));
  for (const f of compact.failing) {
    lines.push(`\nFAILED ${f.check_id} [${f.failure_class}] exit ${f.exit_code}${f.timed_out ? " (timed out)" : ""}`);
    if (f.affected_files?.length) lines.push(`  files: ${f.affected_files.join(", ")}`);
    if (f.stderr_excerpt.trim()) lines.push("  stderr:\n" + indent(f.stderr_excerpt));
    else if (f.stdout_excerpt.trim()) lines.push("  stdout:\n" + indent(f.stdout_excerpt));
  }
  if (compact.omitted.failed_checks) lines.push(`\n[${compact.omitted.failed_checks} further failing check(s) omitted]`);
  const text = lines.join("\n");
  return {
    text,
    characters: text.length,
    manifest: {
      unit: "characters", note: "character counts, not tokens",
      passing_checks: compact.passing.length, failing_checks: compact.failing.length,
      passing_log_characters_omitted: compact.omitted.passing_log_characters,
      failed_checks_omitted: compact.omitted.failed_checks,
    },
  };
}

const indent = (s) => String(s).split("\n").map((l) => "    " + l).join("\n");
