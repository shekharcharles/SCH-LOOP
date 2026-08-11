#!/usr/bin/env node
// SCH Loop — usage, cost and latency accounting.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE:
//
//     UNKNOWN IS NOT ZERO.
//
// A dashboard that shows "$0.00" for a phase whose cost nobody reported is
// lying, and it lies in the most expensive possible direction — it makes an
// unmeasured system look free. Every field here is `null` with an explicit
// `usage_status` beside it, and aggregation carries the unknown count forward
// instead of summing nulls into a confident total.
//
// SECOND RULE: characters are not tokens. The Claude CLI does not report usage
// to SCH today, so `usage_status` is UNKNOWN for real runs. Character counts are
// recorded SEPARATELY and labelled as characters. Dividing them by four and
// calling the result "tokens" would be inventing a measurement.
//
// THIRD RULE: prices are not guesses. The pricing table below is versioned and
// dated and deliberately EMPTY of rates this engine cannot verify. An estimate
// is only produced when a rate was actually configured; otherwise the cost is
// UNKNOWN and says so.

import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;

export const USAGE_STATUSES = ["REPORTED", "ESTIMATED", "UNKNOWN"];
export const COST_STATUSES = ["REPORTED", "ESTIMATED", "UNKNOWN"];

// ----------------------------------------------------------- pricing tables
//
// Versioned and dated. NO RATES ARE SHIPPED: this engine has no verified,
// current price list, and hardcoding a stale one would produce confident wrong
// numbers in a cost report somebody might act on. An operator who wants
// estimates configures rates and the table version travels with every record,
// so a historical estimate can always be re-derived from the rates that made it.
export const PRICING_TABLES = {
  "none@2026-08-04": {
    id: "none@2026-08-04", dated: "2026-08-04",
    note: "No rates are configured. Cost is reported as UNKNOWN rather than estimated from prices this engine cannot verify.",
    rates: {},   // model id -> { input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, currency }
  },
};
export const DEFAULT_PRICING_TABLE = "none@2026-08-04";

export function pricingTable(id = DEFAULT_PRICING_TABLE, { project = null } = {}) {
  // A project may supply its own dated table. It must be dated and identified;
  // an anonymous rate list produces records nobody can audit.
  const custom = project?.pricing;
  if (custom?.id && custom?.dated && custom?.rates) return { ...custom, source: "project" };
  return { ...(PRICING_TABLES[id] ?? PRICING_TABLES[DEFAULT_PRICING_TABLE]), source: "built-in" };
}

// ------------------------------------------------------------ the record

// The empty record: every quantity absent, every status honest. Everything else
// in this file starts from here, so a field can only become a number by
// somebody actually supplying one.
export const emptyUsage = () => ({
  schema_version: SCHEMA_VERSION,
  usage_status: "UNKNOWN", cost_status: "UNKNOWN",
  provider: null, model: null,
  input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null,
  estimated_cost_usd: null, reported_cost_usd: null, pricing_table_version: null,
  duration_ms: 0, queue_duration_ms: null, tool_duration_ms: null, process_duration_ms: null,
  output_bytes: 0,
  // Characters ARE measured, and are labelled as what they are. They live
  // beside the token fields, never inside them.
  characters: { prompt: null, system_prompt: null, user_prompt: null, output: null,
    note: "character counts, not tokens — no tokenizer is used and none is implied" },
  unknown_reason: "the executor reported no usage; the Claude CLI does not surface token counts to SCH",
});

// Build a usage record from whatever is actually known.
//
// `reported` is provider truth. `estimated` is our arithmetic, and is only
// attempted when a rate exists. Neither one is ever fabricated from the other.
export function buildUsage({
  provider = null, model = null, reported = null, characters = null,
  durationMs = 0, processDurationMs = null, queueDurationMs = null, toolDurationMs = null,
  outputBytes = 0, project = null, pricingTableId = DEFAULT_PRICING_TABLE,
} = {}) {
  const u = emptyUsage();
  u.provider = provider ?? null;
  u.model = model ?? null;
  u.duration_ms = Number(durationMs) || 0;
  u.process_duration_ms = processDurationMs === null ? null : Number(processDurationMs);
  u.queue_duration_ms = queueDurationMs === null ? null : Number(queueDurationMs);
  u.tool_duration_ms = toolDurationMs === null ? null : Number(toolDurationMs);
  u.output_bytes = Number(outputBytes) || 0;
  if (characters) u.characters = { ...u.characters, ...characters };

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const anyReported = reported && ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]
    .some((k) => num(reported[k]) !== null);

  if (anyReported) {
    u.usage_status = "REPORTED";
    u.unknown_reason = null;
    for (const k of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]) u[k] = num(reported[k]);
    // the model's declared window, recorded so "how full was it" is the
    // provider's number and never an assumption about which model ran
    if (num(reported.context_window) !== null) u.context_window = num(reported.context_window);
    if (num(reported.num_turns) !== null) u.turns = num(reported.num_turns);
    if (num(reported.cost_usd) !== null) {
      u.reported_cost_usd = num(reported.cost_usd);
      u.cost_status = "REPORTED";
    }
  }

  // An estimate needs BOTH a token count and a rate. Missing either leaves the
  // cost UNKNOWN — which is the truthful answer, not an inconvenience.
  if (u.cost_status !== "REPORTED") {
    const table = pricingTable(pricingTableId, { project });
    const rate = u.model ? table.rates?.[u.model] : null;
    u.pricing_table_version = table.id;
    if (rate && u.usage_status === "REPORTED") {
      const per = (tok, r) => (tok === null || r === undefined ? 0 : (tok / 1_000_000) * r);
      u.estimated_cost_usd = Number((
        per(u.input_tokens, rate.input_per_mtok) + per(u.output_tokens, rate.output_per_mtok) +
        per(u.cache_read_tokens, rate.cache_read_per_mtok) + per(u.cache_write_tokens, rate.cache_write_per_mtok)
      ).toFixed(6));
      u.cost_status = "ESTIMATED";
    } else {
      u.cost_status = "UNKNOWN";
      u.estimated_cost_usd = null;
      u.unknown_reason = u.unknown_reason ??
        (rate ? "usage was not reported, so no cost can be derived" : `no rate for model "${u.model ?? "unknown"}" in pricing table ${table.id}`);
    }
  }
  return u;
}

// --------------------------------------------------------------- aggregation

// Sum what is known; COUNT what is not. A total that quietly excluded four
// unknown phases is a number that will be quoted as if it were complete.
export function aggregate(records, { by = null } = {}) {
  const rows = records.filter(Boolean);
  const sum = (k) => rows.reduce((n, r) => n + (Number.isFinite(Number(r[k])) ? Number(r[k]) : 0), 0);
  const known = (k) => rows.filter((r) => Number.isFinite(Number(r[k]))).length;

  const base = {
    schema_version: SCHEMA_VERSION,
    phases: rows.length,
    usage_status: rows.length === 0 ? "UNKNOWN"
      : rows.every((r) => r.usage_status === "REPORTED") ? "REPORTED"
      : rows.some((r) => r.usage_status !== "UNKNOWN") ? "PARTIAL" : "UNKNOWN",
    input_tokens: known("input_tokens") ? sum("input_tokens") : null,
    output_tokens: known("output_tokens") ? sum("output_tokens") : null,
    reported_cost_usd: known("reported_cost_usd") ? Number(sum("reported_cost_usd").toFixed(6)) : null,
    estimated_cost_usd: known("estimated_cost_usd") ? Number(sum("estimated_cost_usd").toFixed(6)) : null,
    duration_ms: sum("duration_ms"),
    output_bytes: sum("output_bytes"),
    // The honesty fields. A consumer that ignores these is choosing to.
    unknown_usage_phases: rows.filter((r) => r.usage_status === "UNKNOWN").length,
    unknown_cost_phases: rows.filter((r) => r.cost_status === "UNKNOWN").length,
    complete: rows.length > 0 && rows.every((r) => r.usage_status === "REPORTED" && r.cost_status !== "UNKNOWN"),
    pricing_tables: [...new Set(rows.map((r) => r.pricing_table_version).filter(Boolean))],
  };
  if (!by) return base;

  const groups = {};
  for (const r of rows) {
    const key = r[by] ?? "(unattributed)";
    (groups[key] = groups[key] ?? []).push(r);
  }
  return { ...base, grouped_by: by, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, aggregate(v)])) };
}

// Failed phases are aggregated SEPARATELY. Money spent on work that did not land
// is the number an operator most needs and the one a blended total hides.
export const splitByOutcome = (records) => ({
  succeeded: aggregate(records.filter((r) => r.phase_outcome === "ACCEPTED")),
  failed: aggregate(records.filter((r) => r.phase_outcome && r.phase_outcome !== "ACCEPTED")),
});

// -------------------------------------------------------------- budget gate

// A budget decision may only rest on a number somebody stands behind: provider
// truth, or an estimate an operator explicitly approved as a basis. An UNKNOWN
// cost never silently passes a budget check.
export function budgetCheck(usage, { maxUsd = null, allowEstimates = false } = {}) {
  if (maxUsd === null || !Number.isFinite(Number(maxUsd)))
    return { ok: true, reason: "no cost budget configured" };
  if (usage.cost_status === "REPORTED")
    return { ok: Number(usage.reported_cost_usd) <= Number(maxUsd), basis: "REPORTED",
      reason: `reported ${usage.reported_cost_usd} against a ${maxUsd} ceiling` };
  if (usage.cost_status === "ESTIMATED" && allowEstimates)
    return { ok: Number(usage.estimated_cost_usd) <= Number(maxUsd), basis: "ESTIMATED",
      reason: `estimated ${usage.estimated_cost_usd} against a ${maxUsd} ceiling (estimates explicitly allowed as a basis)` };
  if (usage.cost_status === "ESTIMATED")
    return { ok: false, basis: "ESTIMATED_NOT_ALLOWED", needs_decision: true,
      reason: "cost is an estimate and estimates are not an approved basis for this budget — approve them, or supply reported usage" };
  return { ok: false, basis: "UNKNOWN", needs_decision: true,
    reason: `cost is UNKNOWN (${usage.unknown_reason ?? "no reason recorded"}) and UNKNOWN is not zero — a budget cannot be checked against it` };
}

export const usageHash = (u) => createHash("sha256").update(JSON.stringify({
  usage_status: u.usage_status, cost_status: u.cost_status, model: u.model,
  input_tokens: u.input_tokens, output_tokens: u.output_tokens,
})).digest("hex");
