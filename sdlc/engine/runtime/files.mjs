// Reading a project's files from the dashboard.
//
// The loop writes 48,000 characters of specification and then the page showed you a character count.
// This is the other half: the tree, and one file at a time, as text the page can render.
//
// Two rules hold the whole thing up:
//   · nothing outside the project root is readable, whatever the query string says;
//   · a file that looks like a credential is not served at all, even from inside the root.
// Both are enforced here rather than in the page, because the page is a convenience and this is the
// boundary. A local server still has the operator's whole disk within reach of one `../`.
import fs from "node:fs";
import path from "node:path";

// Directories that are machinery rather than work. Skipping them is not cosmetic: node_modules alone
// is tens of thousands of entries, and a tree that takes four seconds is a tree nobody opens twice.
export const SKIP_DIRS = new Set([
  ".git", "node_modules", ".worktrees", ".venv", "venv", "__pycache__", ".pytest_cache",
  "dist", "build", "out", "coverage", ".next", ".turbo", ".cache", ".idea", ".vscode",
]);

// Paths, not names: the engine installs a copy of itself into every project, and a tree that lists it
// buries the four documents the loop actually wrote under forty modules the operator already has.
export const SKIP_PATHS = new Set([
  ".sch-loop/runtime", ".sch-loop/scripts", ".sch-loop/hooks", ".sch-loop/skills",
  ".sch-loop/worktrees", ".sch-loop/debug", ".sch-loop/private", ".claude/sch",
]);

// The documents the loop itself produced, in the order it produced them. They are the reason to open
// a project at all, so they are named rather than found.
export const LOOP_DOCS = [
  ".sch-loop/GOAL.md", ".sch-loop/BRAINSTORM.md", ".sch-loop/PRD.md",
  ".sch-loop/ARCHITECTURE.md", ".sch-loop/PLAN.md", "task.md",
];

// A dashboard that renders any file will happily render the one with the API key in it. These never
// leave the disk. The list is deliberately about shape, not location — a .env is a .env anywhere.
export const SECRET_RE = /(^|[\\/])(\.env(\..*)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|\.netrc|\.npmrc|\.pypirc|credentials|secrets?\.(json|ya?ml|toml))$|\.(pem|key|p12|pfx|jks|keystore|ppk)$/i;

export const MAX_BYTES = 512 * 1024;   // a file bigger than this is not being read, it is being scrolled
export const MAX_ENTRIES = 4000;       // a tree bigger than this is a mistake, and saying so beats hanging

const LANG = {
  md: "markdown", markdown: "markdown", mdx: "markdown",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", pyi: "python",
  json: "json", jsonc: "json",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", cfg: "ini", conf: "ini",
  sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell", bat: "shell", cmd: "shell",
  html: "html", htm: "html", xml: "xml", svg: "xml",
  css: "css", scss: "css", less: "css",
  sql: "sql", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  rb: "ruby", php: "php", lua: "lua", r: "r", pl: "perl",
  diff: "diff", patch: "diff", txt: "text", log: "text", csv: "text",
};

export function langOf(rel) {
  const base = path.basename(rel).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "shell";
  if (base === "makefile") return "shell";
  if (base === ".gitignore" || base === ".npmignore" || base === ".dockerignore") return "text";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return LANG[ext] || "text";
}

export const isSecret = rel => SECRET_RE.test(rel.replace(/\\/g, "/"));

// The one place that turns "whatever arrived in the query string" into an absolute path, and the only
// place allowed to decide a path is inside the project. Symlinks are resolved first: a link inside the
// root that points at ~/.ssh is still a path outside the root, and only realpath sees that.
export function resolveInside(root, rel) {
  const base = fs.realpathSync(path.resolve(root));
  const abs = path.resolve(base, rel || ".");
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { /* a path that does not exist yet cannot escape either */ }
  const inside = real === base || real.startsWith(base + path.sep);
  if (!inside) throw new Error("outside the project");
  return real;
}

const posix = rel => rel.split(path.sep).join("/");

// A flat list, not a nested one. The page builds the shape it wants; a flat list filters, sorts and
// searches in one pass, and it is the same list whether the tree is opened at the root or deep inside.
export function tree(root) {
  const base = fs.realpathSync(path.resolve(root));
  const out = [];
  let truncated = false;

  const walk = (dir, depth) => {
    if (truncated || depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_ENTRIES) { truncated = true; return; }
      const abs = path.join(dir, e.name);
      const rel = posix(path.relative(base, abs));
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || SKIP_PATHS.has(rel)) continue;
        out.push({ path: rel, dir: true });
        walk(abs, depth + 1);
      } else if (e.isFile()) {
        if (isSecret(rel)) continue;
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { /* a file that vanished mid-walk lists as empty */ }
        out.push({ path: rel, dir: false, size, lang: langOf(rel) });
      }
    }
  };
  walk(base, 0);
  const have = new Set(out.filter(e => !e.dir).map(e => e.path));
  return { root: base, entries: out, truncated, docs: LOOP_DOCS.filter(d => have.has(d)) };
}

const looksBinary = buf => {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
};

export function readFile(root, rel) {
  if (!rel) throw new Error("no file given");
  if (isSecret(rel)) throw new Error("that file is not served — it looks like a credential");
  const abs = resolveInside(root, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error("that is a directory");
  if (st.size > MAX_BYTES) {
    return { path: posix(rel), lang: langOf(rel), bytes: st.size, truncated: true, text: "",
      why: `${Math.round(st.size / 1024)} KB is past the ${MAX_BYTES / 1024} KB the viewer reads. Open it in an editor.` };
  }
  const buf = fs.readFileSync(abs);
  if (looksBinary(buf)) {
    return { path: posix(rel), lang: "binary", bytes: st.size, truncated: true, text: "",
      why: "Binary file. Nothing to read here." };
  }
  return {
    path: posix(rel), lang: langOf(rel), bytes: st.size, truncated: false,
    mtime: st.mtime.toISOString(),
    text: buf.toString("utf8").replace(/\r\n/g, "\n"),
  };
}
