// .sch-loop/config.md — a markdown file whose top block is `key: value` lines.
// Values: strings, numbers, true/false, [a, b], { K: 1, L: 2 }, and `- item` lists under a key.
import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
  max_executor_attempts: 3, max_review_rounds: 3, council_mode: "gated", council_minimum_seats: 2,
  context_soft_limit: 100000, context_hard_limit: 130000,
  timeouts_minutes: { XS: 5, S: 15, M: 30, L: 60 }, silence_nudge_seconds: 120,
  rate_limit_backoff_minutes: [1, 2, 4, 8], protected_paths: [], transport: "herdr",
  executor_permission: "bypass", loop: "sdlc",
};

function scalar(v) {
  const s = String(v).trim().replace(/^["']|["']$/g, "");
  if (s === "true") return true; if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
function value(v) {
  const s = v.trim();
  if (s.startsWith("[") && s.endsWith("]")) return s.slice(1, -1).split(",").map(x => x.trim()).filter(Boolean).map(scalar);
  if (s.startsWith("{") && s.endsWith("}")) return Object.fromEntries(s.slice(1, -1).split(",").map(x => x.trim()).filter(Boolean).map(kv => { const i = kv.indexOf(":"); return [kv.slice(0, i).trim(), scalar(kv.slice(i + 1))]; }));
  return scalar(s);
}

export function parseConfig(text) {
  const out = {}; let listKey = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^## /.test(line)) break;                       // notes section starts; config block over
    if (listKey && /^\s+- /.test(line)) { out[listKey].push(scalar(line.replace(/^\s+- /, ""))); continue; }
    listKey = null;
    const m = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!m) continue;
    if (m[2] === "") { out[m[1]] = []; listKey = m[1]; continue; }
    out[m[1]] = value(m[2]);
  }
  return out;
}

export function loadConfig(projectRoot) {
  const f = path.join(projectRoot, ".sch-loop", "config.md");
  const parsed = fs.existsSync(f) ? parseConfig(fs.readFileSync(f, "utf8")) : {};
  return { ...DEFAULTS, ...parsed };
}
