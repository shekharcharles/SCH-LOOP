#!/usr/bin/env node
// SCH Loop — brownfield evidence collector.
//
// WHY THIS EXISTS
// `sch-spec` interviews an operator about a product that does not exist yet. Ask
// it to adopt a repository that DOES exist and it interviews you anyway: it
// never reads the code, never runs the build, and never reports what it found.
// The operator's ask was the opposite — understand the repo, show me what is
// broken and unused, verify it, then tell me what you understood.
//
// WHAT THIS IS NOT
// It is not the understanding. It is the EVIDENCE the understanding must be
// built from. Every number here came from a command that ran or a file that was
// read; nothing is inferred. The skill that consumes this may not claim anything
// this file does not support, which is the whole point of separating them:
// "this repo has no tests" is a finding when a test command exited non-zero,
// and a guess when a model looked at the folder names.
//
//   node scripts/onboard.mjs --project <id> [--json]
//
// Writes <repo>/.sch-loop/onboard/evidence.json and prints a summary.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getProject } from "./state.mjs";
import { open as openGraph } from "./graph.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const now = () => new Date().toISOString();

// Directories whose contents are somebody else's code. Counting them tells the
// operator how big node_modules is, which is never the question being asked.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt",
  "vendor", "target", "__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache",
  ".pytest_cache", ".idea", ".vscode", ".sch-loop", ".codegraph", ".turbo", "bin", "obj",
]);

const LANG = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".go": "Go", ".rs": "Rust",
  ".java": "Java", ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".c": "C", ".h": "C",
  ".cpp": "C++", ".hpp": "C++", ".swift": "Swift", ".kt": "Kotlin", ".scala": "Scala",
  ".sql": "SQL", ".sh": "Shell", ".css": "CSS", ".scss": "CSS", ".html": "HTML",
  ".vue": "Vue", ".svelte": "Svelte", ".md": "Markdown", ".json": "JSON", ".yml": "YAML", ".yaml": "YAML",
};
const CODE_LANGS = new Set(["TypeScript", "JavaScript", "Python", "Go", "Rust", "Java", "Ruby",
  "PHP", "C#", "C", "C++", "Swift", "Kotlin", "Scala", "Vue", "Svelte"]);

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      // Dot-directories are tooling, not the product — and naming them one at a
      // time never keeps up. Scanning .sch-engine here reported a vendored copy
      // of this engine as 32k lines of the operator's own application.
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && (!e.name.startsWith(".") || e.name === ".github")) stack.push(abs); continue; }
      if (e.name.startsWith(".")) continue;
      if (!e.isFile()) continue;
      out.push(abs);
      // A repository big enough to blow this cap is one where the shape matters
      // more than the tail, and the cap is reported rather than hidden.
      if (out.length >= 20000) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------- inventory

function inventory(root) {
  const files = walk(root);
  const byLang = {};
  let codeFiles = 0, codeLines = 0, totalBytes = 0;
  const todos = [];
  const big = [];

  for (const abs of files) {
    const rel = relative(root, abs).replace(/\\/g, "/");
    const lang = LANG[extname(abs).toLowerCase()] ?? "other";
    let size = 0;
    try { size = statSync(abs).size; } catch {}
    totalBytes += size;
    const rec = (byLang[lang] ??= { files: 0, lines: 0 });
    rec.files++;

    // Reading every file is the expensive part, so only source is read, and
    // only up to a size where "lines" still means something.
    if (!CODE_LANGS.has(lang) || size > 2 * 1024 * 1024) continue;
    let text = "";
    try { text = readFileSync(abs, "utf8"); } catch { continue; }
    const lines = text.split("\n").length;
    rec.lines += lines; codeFiles++; codeLines += lines;
    if (lines >= 800) big.push({ path: rel, lines });
    let n = 0;
    for (const m of text.matchAll(/\b(TODO|FIXME|HACK|XXX)\b[:\s]?(.{0,90})/g)) {
      if (n++ >= 5) break;                       // a per-file cap, so one bad file cannot flood the report
      todos.push({ path: rel, marker: m[1], text: m[2].trim() });
    }
  }
  return {
    files_scanned: files.length,
    truncated: files.length >= 20000,
    code_files: codeFiles, code_lines: codeLines, total_bytes: totalBytes,
    by_language: Object.fromEntries(Object.entries(byLang).sort((a, b) => (b[1].lines - a[1].lines) || (b[1].files - a[1].files))),
    largest_files: big.sort((a, b) => b.lines - a.lines).slice(0, 25),
    markers: { total: todos.length, sample: todos.slice(0, 40) },
  };
}

// ------------------------------------------------------- how it says it runs

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

function manifests(root) {
  const found = [];
  const pkg = readJson(join(root, "package.json"));
  if (pkg) found.push({ kind: "node", file: "package.json", name: pkg.name ?? null,
    scripts: pkg.scripts ?? {}, dependencies: Object.keys(pkg.dependencies ?? {}).length,
    devDependencies: Object.keys(pkg.devDependencies ?? {}).length,
    packageManager: pkg.packageManager ?? null });
  for (const f of ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"])
    if (existsSync(join(root, f))) found.push({ kind: "python", file: f });
  for (const [f, k] of [["go.mod", "go"], ["Cargo.toml", "rust"], ["pom.xml", "java"],
                        ["build.gradle", "java"], ["Gemfile", "ruby"], ["composer.json", "php"]])
    if (existsSync(join(root, f))) found.push({ kind: k, file: f });
  const infra = ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "Makefile",
                 ".github/workflows", "Procfile", "vercel.json", "netlify.toml"]
    .filter((f) => existsSync(join(root, f)));
  const docs = ["README.md", "readme.md", "CONTRIBUTING.md", "ARCHITECTURE.md", "docs",
                "CLAUDE.md", "AGENTS.md", "PRD.md"].filter((f) => existsSync(join(root, f)));
  return { manifests: found, infra, docs };
}

// ------------------------------------------------------------- does it work

// The one question a brownfield report must answer with a command rather than
// an opinion: does this thing build, and do its tests pass RIGHT NOW? A repo
// whose baseline is already red changes every plan that follows.
function runCheck(root, label, exe, args, timeout = 240000) {
  const started = Date.now();
  try {
    const out = execFileSync(exe, args, { cwd: root, encoding: "utf8", timeout,
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 24 });
    return { label, command: `${exe} ${args.join(" ")}`, exit_code: 0, ms: Date.now() - started, tail: out.slice(-2000) };
  } catch (e) {
    const tail = String(e.stdout ?? "") + String(e.stderr ?? "");
    return { label, command: `${exe} ${args.join(" ")}`,
      exit_code: e.status ?? (e.killed ? "TIMEOUT" : "ERROR"), ms: Date.now() - started,
      tail: (tail || String(e.message)).slice(-2000) };
  }
}

function baseline(root, m, { run = true } = {}) {
  const checks = [];
  if (!run) return { ran: false, why: "--no-run", checks };
  const node = m.manifests.find((x) => x.kind === "node");
  if (node) {
    const pm = /pnpm/.test(node.packageManager ?? "") ? "pnpm" : /yarn/.test(node.packageManager ?? "") ? "yarn" : "npm";
    const exe = process.platform === "win32" ? pm + ".cmd" : pm;
    // Only commands the repo itself declares. Inventing a build command and
    // reporting its failure would be reporting our own mistake as their defect.
    for (const s of ["typecheck", "lint", "test", "build"])
      if (node.scripts?.[s]) checks.push(runCheck(root, s, exe, ["run", s, "--if-present"]));
  }
  if (m.manifests.some((x) => x.kind === "python") && existsSync(join(root, "pyproject.toml")))
    checks.push(runCheck(root, "test", process.platform === "win32" ? "python" : "python3", ["-m", "pytest", "-q"]));
  if (m.manifests.some((x) => x.kind === "go")) checks.push(runCheck(root, "test", "go", ["test", "./..."]));
  if (m.manifests.some((x) => x.kind === "rust")) checks.push(runCheck(root, "test", "cargo", ["test"]));
  return { ran: true, checks };
}

// --------------------------------------------------------- dead & broken code

// Dead code is claimed ONLY from a tool that was actually run. Nothing is
// installed to make that happen: a report is not worth mutating the operator's
// machine for, and a missing tool is reported as a gap in the evidence rather
// than filled in by the model's impression of which files "look unused".
function deadCode(root, m) {
  const out = { tools_run: [], tools_missing: [], findings: [] };
  const have = (exe, args) => {
    try { execFileSync(exe, args, { cwd: root, stdio: "ignore", windowsHide: true, timeout: 20000 }); return true; }
    catch (e) { return e.status !== undefined && e.status !== 127 && !/ENOENT/.test(String(e.message)); }
  };
  const node = m.manifests.find((x) => x.kind === "node");
  if (node) {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    if (existsSync(join(root, "node_modules", "knip"))) {
      const r = runCheck(root, "knip", npx, ["knip", "--reporter", "json"], 180000);
      out.tools_run.push("knip"); out.findings.push(r);
    } else out.tools_missing.push("knip (unused files/exports/deps for JS/TS) — `npm i -D knip`");
    if (existsSync(join(root, "node_modules", "ts-prune"))) {
      const r = runCheck(root, "ts-prune", npx, ["ts-prune"], 120000);
      out.tools_run.push("ts-prune"); out.findings.push(r);
    } else if (!out.tools_run.includes("knip")) out.tools_missing.push("ts-prune (unused exports for TS) — `npm i -D ts-prune`");
    void have;
  }
  if (m.manifests.some((x) => x.kind === "python")) {
    const r = runCheck(root, "vulture", process.platform === "win32" ? "python" : "python3", ["-m", "vulture", ".", "--min-confidence", "80"], 120000);
    if (r.exit_code === "ERROR" || /No module named/.test(r.tail)) out.tools_missing.push("vulture (dead code for Python) — `pip install vulture`");
    else { out.tools_run.push("vulture"); out.findings.push(r); }
  }
  return out;
}

// What the graph already knows, which is cheaper than any scan: a file nobody
// imports. Reported as a QUESTION, never as a verdict — entry points, routes,
// migrations and test files are all legitimately unimported.
function unreferencedFiles(projectId) {
  try {
    const db = openGraph(projectId);
    const rows = db.prepare(`
      SELECT n.path FROM node n
      WHERE n.kind = 'file' AND n.path IS NOT NULL AND n.path != ''
        AND NOT EXISTS (SELECT 1 FROM edge e WHERE e.dst = n.id AND e.kind = 'imports')
      LIMIT 200`).all();
    const total = db.prepare("SELECT COUNT(*) c FROM node WHERE kind='file'").get()?.c ?? 0;
    return { indexed_files: total, never_imported: rows.map((r) => r.path),
             caveat: "entry points, route files, migrations and tests are legitimately unimported — this is a list to ASK about, not to delete" };
  } catch (e) { return { error: e.message, note: "graph not indexed yet — run scripts/graph-index.mjs --project <id> --all" }; }
}

function gitFacts(root) {
  const g = (...a) => { try { return execFileSync("git", ["-C", root, ...a], { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 22 }).trim(); } catch { return ""; } };
  if (!g("rev-parse", "--is-inside-work-tree")) return { repo: false };
  const churn = g("log", "--since=6.months", "--name-only", "--pretty=format:")
    .split("\n").filter(Boolean).reduce((m, f) => (m[f] = (m[f] ?? 0) + 1, m), {});
  return {
    repo: true,
    branch: g("rev-parse", "--abbrev-ref", "HEAD"),
    commits: Number(g("rev-list", "--count", "HEAD")) || 0,
    last_commit: g("log", "-1", "--format=%cI  %an  %s"),
    contributors: Number(g("shortlog", "-sn", "--all", "--no-merges").split("\n").filter(Boolean).length) || 0,
    dirty_files: g("status", "--porcelain").split("\n").filter(Boolean).length,
    // Churn is where the risk lives: the files that change most are the ones a
    // change is most likely to break, and they deserve the reader's attention.
    hottest_files: Object.entries(churn).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([path, changes]) => ({ path, changes })),
  };
}

export function collect(projectId, { run = true } = {}) {
  const p = getProject(projectId);
  if (!p) throw new Error(`no such project "${projectId}"`);
  if (!p.path || !existsSync(p.path)) throw new Error(`project path does not exist: ${p.path}`);
  const root = p.path;
  const m = manifests(root);
  const ev = {
    schema_version: 1,
    project: projectId, path: root, collected_at: now(),
    git: gitFacts(root),
    inventory: inventory(root),
    ...m,
    baseline: baseline(root, m, { run }),
    dead_code: deadCode(root, m),
    graph: unreferencedFiles(projectId),
  };
  const dir = join(root, ".sch-loop", "onboard");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "evidence.json"), JSON.stringify(ev, null, 2));
  return { ...ev, evidence_path: join(dir, "evidence.json") };
}

if (process.argv[1] && process.argv[1].endsWith("onboard.mjs")) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf("--" + n); return i === -1 ? undefined : argv[i + 1]; };
  const project = flag("project") ?? argv.find((a) => !a.startsWith("--"));
  if (!project) { console.error("error: need --project <id>"); process.exit(2); }
  const ev = collect(project, { run: !argv.includes("--no-run") });
  if (argv.includes("--json")) { console.log(JSON.stringify(ev, null, 2)); process.exit(0); }

  const i = ev.inventory;
  const line = (k, v) => console.log("  " + String(k).padEnd(22) + v);
  console.log(`\nonboard evidence — ${ev.project}  (${ev.path})`);
  line("code", `${i.code_files} files, ${i.code_lines.toLocaleString()} lines${i.truncated ? " (scan capped at 20k files)" : ""}`);
  line("languages", Object.entries(i.by_language).filter(([l, v]) => l !== "other" && v.lines > 0).slice(0, 5).map(([l, v]) => `${l} ${v.lines.toLocaleString()}`).join(", ") || "none detected");
  line("git", ev.git.repo ? `${ev.git.commits} commits, ${ev.git.contributors} contributors, ${ev.git.dirty_files} dirty` : "not a git repository");
  line("manifests", ev.manifests.map((x) => x.file).join(", ") || "none");
  line("docs", ev.docs.join(", ") || "none");
  line("markers", `${i.markers.total} TODO/FIXME/HACK`);
  for (const c of ev.baseline.checks) line(`baseline: ${c.label}`, c.exit_code === 0 ? `PASS (${c.ms}ms)` : `FAIL exit=${c.exit_code}`);
  // "no command found" and "we did not look" are different facts, and printing
  // the first when the second is true is how a report lies without lying.
  if (!ev.baseline.checks.length) line("baseline", ev.baseline.ran ? "no declared build/test command found" : "NOT RUN (--no-run) — baseline unknown");
  line("dead-code tools", ev.dead_code.tools_run.join(", ") || "none available");
  for (const t of ev.dead_code.tools_missing) line("", "missing: " + t);
  line("never imported", ev.graph.error ? ev.graph.note : `${ev.graph.never_imported.length} of ${ev.graph.indexed_files} indexed files`);
  console.log(`\nwritten: ${ev.evidence_path}\n`);
}
