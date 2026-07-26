#!/usr/bin/env node
// SCH Loop — keep the graph current, automatically.
//
// Running an "init" by hand is a step people forget, and a graph that is a week
// stale is worse than no graph: it answers confidently and wrongly. So indexing
// is not a command the operator runs — it is a hook that fires when a file is
// edited, and a sweep that runs when a pass finishes.
//
//   graph-index.mjs --file <path>        index one file (what the hook calls)
//   graph-index.mjs --project <id> --all index the whole project once
//   graph-index.mjs --project <id> --changed  index what git says changed
//
// The symbol extraction here is deliberately shallow — declarations only, by
// pattern. Phase 2 swaps in vendored tree-sitter for real ASTs behind this exact
// CLI, so the hook and every caller stay unchanged.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { open, upsertNode, addEdge } from "./graph.mjs";

const ROOT = process.env.SCH_HOME || join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf("--" + n); return i !== -1 ? args[i + 1] : undefined; };
const has = (n) => args.includes("--" + n);

const LANG = { py: "python", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", go: "go", rs: "rust", java: "java", rb: "ruby", php: "php" };

// Declarations only. Anything cleverer with a regex is a lie a real parser will
// correct in phase 2; better to record less and be right.
const DECL = [
  [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, "function"],
  [/^\s*class\s+([A-Za-z_]\w*)/gm, "class"],
  [/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, "function"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm, "function"],
  [/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm, "class"],
  [/^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm, "type"],
  [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, "function"],
];

// Which registered project owns this path?
function projectFor(abs) {
  const reg = JSON.parse(readFileSync(join(ROOT, "projects.json"), "utf8"));
  const p = abs.replace(/\\/g, "/").toLowerCase();
  return reg.projects
    .filter((x) => x.path && p.startsWith(x.path.replace(/\\/g, "/").toLowerCase()))
    .sort((a, b) => b.path.length - a.path.length)[0] || null;   // deepest match wins
}

export function indexFile(db, repoRoot, abs) {
  if (!existsSync(abs)) return 0;
  let st; try { st = statSync(abs); } catch { return 0; }
  if (!st.isFile() || st.size > 400_000) return 0;               // skip bundles/blobs
  const rel = relative(repoRoot, abs).replace(/\\/g, "/");
  if (/(^|\/)(node_modules|\.git|dist|build|static\/js|\.codegraph|venv|__pycache__)\//.test(rel)) return 0;
  const ext = rel.split(".").pop().toLowerCase();
  const lang = LANG[ext];
  if (!lang) return 0;

  let src; try { src = readFileSync(abs, "utf8"); } catch { return 0; }
  const fileId = upsertNode(db, { kind: "file", name: rel.split("/").pop(), path: rel, lang });

  const lineOf = (idx) => src.slice(0, idx).split("\n").length;
  let n = 0;
  const seen = new Set();
  for (const [re, what] of DECL) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const name = m[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const id = upsertNode(db, { kind: "symbol", name, path: rel, lang, line: lineOf(m.index),
        summary: `${what} in ${rel}` });
      addEdge(db, fileId, id, "contains");
      n++;
    }
  }
  return n;
}

// ---- entry -----------------------------------------------------------------
try {
  let project = flag("project"), repoRoot, files = [];

  if (flag("file")) {
    const abs = resolve(flag("file"));
    const p = projectFor(abs);
    if (!p) process.exit(0);                    // not part of a tracked project — silently ignore
    project = p.id; repoRoot = p.path; files = [abs];
  } else {
    if (!project) { console.error("need --project or --file"); process.exit(1); }
    const reg = JSON.parse(readFileSync(join(ROOT, "projects.json"), "utf8"));
    const p = reg.projects.find((x) => x.id === project);
    if (!p?.path) { console.error("project has no path"); process.exit(1); }
    repoRoot = p.path;
    if (has("changed")) {
      const out = execFileSync("git", ["-C", repoRoot, "diff", "--name-only", "HEAD~1", "HEAD"], { encoding: "utf8" });
      files = out.trim().split("\n").filter(Boolean).map((f) => join(repoRoot, f));
    } else {
      const out = execFileSync("git", ["-C", repoRoot, "ls-files"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      files = out.trim().split("\n").filter(Boolean).map((f) => join(repoRoot, f));
    }
  }

  const db = open(project);
  let syms = 0, done = 0;
  for (const f of files) { const c = indexFile(db, repoRoot, f); if (c) { syms += c; done++; } }
  if (!flag("file")) console.log(JSON.stringify({ project, filesIndexed: done, symbols: syms }));
} catch (e) {
  // A hook must never break the edit that triggered it.
  if (!flag("file")) console.error("graph-index: " + e.message);
  process.exit(0);
}
