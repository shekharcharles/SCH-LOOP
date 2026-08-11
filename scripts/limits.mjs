#!/usr/bin/env node
// SCH Loop — the operator's real budget: Anthropic's own 5-hour and 7-day
// utilisation, not SCH's guess at it.
//
// WHY THIS EXISTS
// SCH could measure what IT spent, which answers "what did this project cost"
// and not "how much of my week is left". The second question is the one that
// decides whether a queue should run tonight, and it can only be answered by
// the account.
//
// CREDENTIALS
// Read from the Claude Code credential file, used as a Bearer token, and never
// written anywhere: not into a run directory, not into an event, not into the
// dashboard payload, not into a log line. The only thing that leaves this
// module is percentages and reset timestamps.
//
// THIS IS AN UNDOCUMENTED ENDPOINT. It is the same one the claude.ai client
// uses, and it can change or disappear without notice. Every failure here is
// non-fatal by construction: a missing token, an expired token, a network
// failure and a changed response shape all return `available: false` with a
// reason. Nothing about SCH's operation depends on it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// The windows move in percent-points over hours; there is nothing to gain from
// asking often, and a 429 from an undocumented endpoint is a good way to lose
// access to it. Every open tab shares this one cache, and a 429 backs off hard
// rather than retrying into the wall.
const CACHE_MS = 5 * 60_000;
const BACKOFF_MS = 15 * 60_000;
const TIMEOUT_MS = 8_000;

let cache = { at: 0, value: null };

function credentialsPath() {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json")
    : join(homedir(), ".claude", ".credentials.json");
}

// Returns the token or null. Never logs it, never returns it to a caller that
// is going to serialise it.
function readToken() {
  try {
    const raw = JSON.parse(readFileSync(credentialsPath(), "utf8"));
    const o = raw?.claudeAiOauth;
    if (!o?.accessToken) return null;
    if (o.expiresAt && Date.now() > Number(o.expiresAt)) return null;   // expired: let Claude Code refresh it
    return o.accessToken;
  } catch { return null; }
}

const pct = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null);

function normalizeWindow(w) {
  if (!w || typeof w !== "object") return null;
  const u = pct(w.utilization);
  if (u === null) return null;
  return {
    utilization: u,
    resets_at: typeof w.resets_at === "string" ? w.resets_at : null,
    // present on some plans, null on others — reported only when real
    used_dollars: typeof w.used_dollars === "number" ? w.used_dollars : null,
    limit_dollars: typeof w.limit_dollars === "number" ? w.limit_dollars : null,
  };
}

export async function fetchLimits({ force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;

  const token = readToken();
  if (!token) {
    const v = { available: false, reason: "no usable Claude Code credential on this machine" };
    cache = { at: Date.now(), value: v };
    return v;
  }

  let body;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: "Bearer " + token,
        accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      // 429 means we asked too often: hold the LAST GOOD answer if we have one,
      // say plainly that it is stale, and stop asking for a while.
      const rateLimited = res.status === 429;
      const keep = rateLimited && cache.value?.available ? cache.value : null;
      const v = keep
        ? { ...keep, stale: true, reason: "rate limited; showing the last reading" }
        : { available: false, reason: `usage endpoint returned ${res.status}` };
      cache = { at: Date.now() + (rateLimited ? BACKOFF_MS - CACHE_MS : 0), value: v };
      return v;
    }
    body = await res.json();
  } catch (e) {
    // Never cache a transient network failure for long.
    return { available: false, reason: "usage endpoint unreachable: " + String(e?.message || e).slice(0, 120) };
  }

  const five = normalizeWindow(body?.five_hour);
  const week = normalizeWindow(body?.seven_day);
  if (!five && !week) {
    const v = { available: false, reason: "usage response had no recognisable windows" };
    cache = { at: Date.now(), value: v };
    return v;
  }

  const value = {
    available: true,
    fetched_at: new Date().toISOString(),
    five_hour: five,
    seven_day: week,
    // per-model windows exist on some plans; surfaced when present because
    // "which model ate the week" is exactly what routing needs to know
    by_model: [
      ["opus", body?.seven_day_opus], ["sonnet", body?.seven_day_sonnet],
    ].map(([m, w]) => ({ model: m, ...(normalizeWindow(w) || {}) }))
     .filter((x) => typeof x.utilization === "number"),
  };
  cache = { at: Date.now(), value };
  return value;
}

if (process.argv[1] && process.argv[1].endsWith("limits.mjs")) {
  fetchLimits({ force: true }).then((v) => console.log(JSON.stringify(v, null, 2)));
}
