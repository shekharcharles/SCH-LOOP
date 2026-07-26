#!/usr/bin/env node
// SCH Loop — secret-scan commit gate. Run in a project BEFORE committing.
// Blocks the commit if staged changes contain secrets or sensitive files, so the
// loop can never push an API key, private key, .env, or CLAUDE.md to GitHub.
//
//   node <SCH_HOME>/scripts/secret-scan.mjs            # scans `git diff --cached`
//   node <SCH_HOME>/scripts/secret-scan.mjs --all      # scans whole working tree
//
// exit 0 = clean (safe to commit) · exit 1 = BLOCKED (findings printed)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const arg = process.argv.slice(2);
const ALL = arg.includes("--all");
// git with a fixed arg array — no shell, so filenames can't inject.
const git = (...a) => { try { return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } };

// Files that must never be committed (by name / glob-ish).
const BLOCK_FILES = [
  /(^|\/)\.env(\..*)?$/i, /(^|\/)CLAUDE\.md$/i, /(^|\/)\.aws\/credentials$/i,
  /\.pem$/i, /\.p12$/i, /\.pfx$/i, /(^|\/)id_rsa$/i, /(^|\/)id_dsa$/i, /(^|\/)id_ecdsa$/i, /(^|\/)id_ed25519$/i,
  /(^|\/)credentials\.json$/i, /(^|\/)service-account.*\.json$/i, /(^|\/)\.npmrc$/i, /(^|\/)\.pypirc$/i,
  /secrets?\.(ya?ml|json|env|txt)$/i, /(^|\/)\.git-credentials$/i,
];

// Secret content patterns (name → regex). Kept high-signal to limit false positives.
const PATTERNS = [
  ["Private key block", /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["AWS secret access key", /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+]{40}/i],
  ["GCP / Google API key", /\bAIza[0-9A-Za-z\-_]{35}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["Stripe secret key", /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["Private key (PKCS8)", /\bMII[A-Za-z0-9+/]{40,}/],
  ["Generic API key/secret assignment", /\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|bearer)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-\.]{16,}['"]?/i],
  ["Slack/Discord webhook", /https:\/\/(hooks\.slack\.com|discord(app)?\.com\/api\/webhooks)\/[A-Za-z0-9\/_-]+/i],
];
// Lines that are obviously placeholders — don't flag these.
const ALLOW = [/example|placeholder|your[_-]?key|xxxx|changeme|dummy|<[^>]+>|process\.env\.|os\.environ|import\.meta\.env/i];

const findings = [];

const scanLine = (file, text) => {
  if (ALLOW.some((re) => re.test(text))) return;
  for (const [name, re] of PATTERNS) if (re.test(text)) { findings.push({ file, why: name, sample: text.trim().slice(0, 80) }); return; }
};

// 1) filenames vs the block list.
// A staged DELETION of a blocked file is the fix, not the offence — it is exactly
// how a tracked CLAUDE.md gets untracked. Blocking it made the gate unescapable:
// the only commit that could remove the file was the one commit it refused.
const staged = ALL ? git("ls-files").split("\n").map((s) => ["A", s.trim()])
  : git("diff", "--cached", "--name-status").split("\n").map((l) => {
      const [st, ...rest] = l.split(/\t/);
      return [(st || "").trim()[0] || "", rest.join("\t").trim()];
    });
const files = staged.filter(([st, f]) => f && st !== "D").map(([, f]) => f);
const removed = staged.filter(([st, f]) => f && st === "D").map(([, f]) => f);
for (const f of files) for (const re of BLOCK_FILES) if (re.test(f)) findings.push({ file: f, why: "sensitive file must not be committed" });
for (const f of removed) for (const re of BLOCK_FILES) if (re.test(f)) console.log(`secret-scan: allowing removal of ${f} from the repo`);

// 2) added content
if (ALL) {
  for (const f of files) {
    let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }   // fs read — no shell
    if (t.length > 2_000_000) continue;                                      // skip huge/binary
    for (const line of t.split("\n")) scanLine(f, line);
  }
} else {
  let curFile = "?";
  for (const line of git("diff", "--cached", "--unified=0").split("\n")) {
    const fm = line.match(/^\+\+\+ b\/(.+)$/); if (fm) { curFile = fm[1]; continue; }
    if (line.startsWith("+") && !line.startsWith("+++")) scanLine(curFile, line.slice(1));
  }
}

// LINE-ENDING GUARD. An edit can silently rewrite a file to CRLF, turning a
// 39-line change into a 1,087-line diff that buries the real change and makes
// review impossible. A builder ran the right check — `git diff --ignore-all-space`
// collapsing the diff — and concluded there was no corruption, when that collapse
// is precisely the proof of it. So the commit gate checks instead of the agent.
if (!ALL && !findings.length) {
  try {
    const raw = git("diff", "--cached", "--numstat").trim().split("\n").filter(Boolean);
    const ign = git("diff", "--cached", "--ignore-all-space", "--numstat").trim().split("\n").filter(Boolean);
    const sum = (rows) => rows.reduce((n, l) => { const [a, d] = l.split(/\s+/); return n + (Number(a) || 0) + (Number(d) || 0); }, 0);
    const rawN = sum(raw), ignN = sum(ign);
    // a real change survives ignoring whitespace; a line-ending rewrite does not
    // The ratio is the signal, not the size. A first threshold of 200 lines
    // missed a real flip that showed as 135 raw against 17 ignored — the change
    // was small, the corruption was total. Judge by how much survives ignoring
    // whitespace, with a low floor so a genuinely tiny diff cannot trip it.
    if (rawN >= 40 && ignN * 4 < rawN) {
      console.error(`secret-scan: BLOCKED — line endings were rewritten.\n` +
        `  staged diff is ${rawN} lines, but only ${ignN} once whitespace is ignored.\n` +
        `  An edit flipped CRLF/LF and buried the real change. Convert back, e.g.\n` +
        `    perl -pi -e 's/\\r\\n/\\n/g' <the files you edited>\n` +
        `  then re-stage. (Check with: git diff --cached --ignore-all-space --stat)`);
      process.exit(1);
    }
  } catch { /* not a git repo, or no staged diff — nothing to check */ }
}

if (!findings.length) { console.log("secret-scan: CLEAN — safe to commit"); process.exit(0); }
console.error("secret-scan: BLOCKED — " + findings.length + " issue(s). Do NOT commit:");
for (const f of findings) console.error(`  ✗ ${f.file} — ${f.why}${f.sample ? "  [" + f.sample + "]" : ""}`);
console.error("Fix: remove the secret (use env vars), add the file to .gitignore, and re-stage. Never --force past this.");
process.exit(1);
