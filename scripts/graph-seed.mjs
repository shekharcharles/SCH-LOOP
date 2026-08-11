#!/usr/bin/env node
// SCH Loop — seed the knowledge graph from work already done.
//
// The graph only knows what a pass records, so a project with sixty completed
// tasks still opens as an empty box. Everything those tasks learned is already on
// disk though — in their notes, their acceptance criteria and the commits they
// produced. This reads that back and loads it, so the graph starts with real
// content instead of nothing.
//
// It records only what is actually written down. Nothing is inferred: a file
// becomes a node because a task said it touched that file, and a decision
// becomes a node because the operator answered it. Anything a pass merely
// implied stays out — a graph that guesses is worse than one that is sparse.
//
//   node scripts/graph-seed.mjs --project pmcms [--dry]

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { open, upsertNode, addEdge, stats } from "./graph.mjs";

const ROOT = process.env.SCH_HOME || join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf("--" + n); return i !== -1 ? args[i + 1] : undefined; };
const project = flag("project");
const dry = args.includes("--dry");
if (!project) { console.error("need --project <id>"); process.exit(1); }

const state = JSON.parse(readFileSync(join(ROOT, "projects", project, "state.json"), "utf8"));
const reg = JSON.parse(readFileSync(join(ROOT, "projects.json"), "utf8"));
const repo = reg.projects.find((p) => p.id === project)?.path;

// A path written in prose: "files/methods.py", "frontend/src/utils/x.js:42".
const PATH_RE = /\b([\w.-]+\/[\w./-]+\.(?:py|js|jsx|ts|tsx|mjs|cjs|json|md|html|css|scss|yaml|yml|sql))\b/g;
// A symbol referred to by name: snake_case or CamelCase with a call or a class.
const SYM_RE = /\b([a-z_][a-z0-9_]{4,}|[A-Z][A-Za-z0-9]{4,})(?=\(|\b\s+(?:is|was|now)\b)/g;

const db = dry ? null : open(project);
const seen = { file: new Set(), symbol: new Set(), decision: 0, lesson: 0, task: 0 };
const put = (n) => (dry ? `${n.kind}:${n.name}` : upsertNode(db, n));
const link = (a, b, k) => { if (!dry) addEdge(db, a, b, k); };

const clip = (s, n = 200) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

for (const t of state.tasks || []) {
  if (t.status === "superseded") continue;
  const text = [t.title, ...(t.ac || []), t.notes || ""].join(" \n ");

  // 1. Decisions the operator actually answered — the most valuable thing here,
  //    because it is the reasoning a future pass cannot re-derive from code.
  if (/^\s*DECISION\b/i.test(t.title) && (t.answers || []).length) {
    const answer = t.answers[t.answers.length - 1].text;
    const id = put({
      kind: "decision", name: t.title.replace(/^\s*DECISION:\s*/i, "").slice(0, 90),
      summary: `ANSWERED "${clip(answer, 80)}" — ${clip(t.question || t.notes, 160)}`,
    });
    seen.decision++;
    for (const [, p] of text.matchAll(PATH_RE)) {
      const f = put({ kind: "file", name: p.split("/").pop(), path: p });
      seen.file.add(p); link(id, f, "relates");
    }
    continue;
  }

  // 2. Completed work: what it was, and which files it landed in.
  if (t.status !== "merged") continue;
  seen.task++;
  const paths = [...new Set([...(t.files || []), ...[...text.matchAll(PATH_RE)].map((m) => m[1])])];
  if (!paths.length) continue;
  const note = put({
    kind: "note", name: t.title.slice(0, 90),
    summary: clip(t.notes || (t.ac || [])[0], 220),
  });
  for (const p of paths) {
    const f = put({ kind: "file", name: p.split("/").pop(), path: p });
    seen.file.add(p);
    link(note, f, "touches");
  }
  // symbols named in the note, attached to the first file mentioned
  const home = paths[0];
  for (const [, s] of (t.notes || "").matchAll(SYM_RE)) {
    if (seen.symbol.has(s)) continue;
    seen.symbol.add(s);
    const sym = put({ kind: "symbol", name: s, path: home, summary: clip(t.notes, 140) });
    link(sym, put({ kind: "file", name: home.split("/").pop(), path: home }), "contains");
  }
}

// 3. Lessons — the project's own CLAUDE.md carries rules learned the hard way.
if (repo && existsSync(join(repo, "CLAUDE.md"))) {
  const md = readFileSync(join(repo, "CLAUDE.md"), "utf8");
  const sec = md.split(/^##\s+Lessons/im)[1];
  if (sec) for (const line of sec.split("\n")) {
    const m = line.match(/^\s*[-*]\s+(.{15,})/);
    if (!m) continue;
    put({ kind: "lesson", name: clip(m[1], 70), summary: clip(m[1], 240) });
    seen.lesson++;
  }
}

// 4. Recent commits give files a reason for existing beyond "a task named it".
if (repo && existsSync(join(repo, ".git"))) {
  try {
    const log = execFileSync("git", ["-C", repo, "log", "-40", "--pretty=%h%x09%s"], { windowsHide: true, encoding: "utf8" });
    for (const line of log.trim().split("\n")) {
      const [sha, subject] = line.split("\t");
      if (!subject || /^(chore|docs)\b/.test(subject)) continue;
      const files = execFileSync("git", ["-C", repo, "show", "--name-only", "--pretty=", sha], { windowsHide: true, encoding: "utf8" })
        .trim().split("\n").filter((f) => f && PATH_RE.test(f));
      if (!files.length) continue;
      const c = put({ kind: "note", name: subject.slice(0, 90), summary: `commit ${sha}` });
      for (const f of files.slice(0, 12)) {
        link(c, put({ kind: "file", name: f.split("/").pop(), path: f }), "touches");
        seen.file.add(f);
      }
    }
  } catch { /* no git, or a shallow clone — the rest still seeds */ }
}

console.log(JSON.stringify({
  mode: dry ? "dry-run (nothing written)" : "seeded",
  fromTasks: seen.task, decisions: seen.decision, lessons: seen.lesson,
  files: seen.file.size, symbols: seen.symbol.size,
  graph: dry ? null : stats(db),
}, null, 2));
