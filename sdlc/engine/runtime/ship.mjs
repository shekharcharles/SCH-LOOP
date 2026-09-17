// Ship: the last gate before work leaves the machine. Re-runs the release checks, then opens a pull
// request. Nothing here trusts a report — every gate is a command whose exit code is read.
//
// The order matters. Cheap, local, refusable gates run first and stop the whole thing; the PR is the last
// step, because it is the only one that is visible to other people and the only one that is awkward to
// undo. `dryRun` runs every gate and stops before the push, which is how this is tested.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "./taskmd.mjs";
import { appendEvent } from "./report.mjs";

const pexec = promisify(execFile);
const git = (cwd, args) => pexec("git", args, { cwd, encoding: "utf8", windowsHide: true });

// Patterns worth stopping a release for. Deliberately short: a long list is a long list of false
// positives, and a gate people routinely override is not a gate.
export const SECRET_PATTERNS = [
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "generic assigned secret", re: /\b(?:api[_-]?key|secret|passwd|password|token)\s*[:=]\s*["'][^"'\s]{16,}["']/i },
];

export function scanSecrets(diff) {
  const hits = [];
  for (const line of String(diff).split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const p of SECRET_PATTERNS) if (p.re.test(line)) hits.push({ pattern: p.name, line: line.slice(0, 80) });
  }
  return hits;
}

export function readVerify(projectRoot, phase) {
  const f = path.join(projectRoot, ".sch-loop", "verify", `phase-${phase}.md`);
  if (!fs.existsSync(f)) return { ok: false, why: `no phase verification at .sch-loop/verify/phase-${phase}.md — run verify first` };
  const text = fs.readFileSync(f, "utf8");
  const m = text.match(/^\*\*Status:\*\*\s*(\w+)/m);
  if (!m) return { ok: false, why: "the phase verification file has no Status line" };
  if (m[1] !== "passed") return { ok: false, why: `phase verification is ${m[1]}, not passed` };
  return { ok: true, why: "phase verification passed", file: f };
}

export function readQueue(projectRoot, phase) {
  const doc = parse(fs.readFileSync(path.join(projectRoot, "task.md"), "utf8"));
  const tickets = doc.tickets.filter(t => String(t.phase) === String(phase));
  if (!tickets.length) return { ok: false, why: `no tickets in phase ${phase}` };
  const open = tickets.filter(t => t.status !== "x");
  if (open.length) return { ok: false, why: `${open.length} ticket(s) in phase ${phase} are not done: ${open.map(t => t.id).join(", ")}` };
  return { ok: true, why: `${tickets.length} ticket(s) done`, tickets };
}

// Every gate is a plain async () => {ok, why}. Keeping them uniform is what lets the report say which one
// stopped the release without a branch per gate.
export function gates({ projectRoot, phase, base, checks, branch }) {
  return [
    // First, because it is the likeliest operator mistake and because every later gate describes it
    // badly: a pull request from `main` into `main` shows up downstream as "no changes against main",
    // which sends the reader looking for missing work instead of a missing branch.
    { name: "branch", run: async () => branch === base ? { ok: false, why: `HEAD is ${base}; ship from a branch, not from the base itself` } : { ok: true, why: `on ${branch}` } },
    { name: "queue", run: async () => readQueue(projectRoot, phase) },
    { name: "phase verification", run: async () => readVerify(projectRoot, phase) },
    {
      name: "working tree is clean", run: async () => {
        const { stdout } = await git(projectRoot, ["status", "--porcelain", "-uall", "--", "."]);
        const dirty = stdout.split("\n").filter(Boolean);
        return dirty.length ? { ok: false, why: `${dirty.length} uncommitted change(s): ${dirty.slice(0, 5).map(l => l.slice(3)).join(", ")}` } : { ok: true, why: "clean" };
      },
    },
    {
      name: "there is something to ship", run: async () => {
        const { stdout } = await git(projectRoot, ["diff", "--name-only", `${base}...HEAD`, "--", "."]);
        const files = stdout.split("\n").filter(Boolean);
        return files.length ? { ok: true, why: `${files.length} file(s) changed against ${base}`, files } : { ok: false, why: `no changes against ${base}` };
      },
    },
    {
      name: "no secrets in the diff", run: async () => {
        const { stdout } = await git(projectRoot, ["diff", `${base}...HEAD`, "--", "."]);
        const hits = scanSecrets(stdout);
        return hits.length ? { ok: false, why: `${hits.length} possible secret(s): ${hits.map(h => h.pattern).join(", ")}` } : { ok: true, why: "none found" };
      },
    },
    ...checks.map(c => ({
      name: c.name || `${c.command} ${(c.args || []).join(" ")}`,
      run: async () => {
        try { await pexec(c.command, c.args || [], { cwd: projectRoot, encoding: "utf8", windowsHide: true, timeout: c.timeoutMs || 300_000, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(c.command) }); return { ok: true, why: "exit 0" }; }
        catch (e) { return { ok: false, why: `exit ${e.code ?? "?"}: ${String(e.stderr || e.stdout || e.message).trim().split("\n").slice(-3).join(" ")}` }; }
      },
    })),
  ];
}

export function toMarkdown({ phase, decision, base, branch, results, prUrl, at }) {
  return [
    `# Release — phase ${phase}`, "",
    `**Decision:** ${decision}`,
    `**Base:** ${base}`,
    `**Branch:** ${branch}`,
    prUrl ? `**Pull request:** ${prUrl}` : "**Pull request:** (not opened)",
    `**At:** ${at}`, "",
    "| Gate | Result | Detail |",
    "|---|---|---|",
    ...results.map(r => `| ${r.name} | ${r.ok ? "GO" : "NO-GO"} | ${String(r.why).replace(/\|/g, "\\|")} |`),
    "",
    "## Rollback", "",
    prUrl ? `1. Close the pull request: \`gh pr close ${prUrl}\`` : "1. Nothing was pushed.",
    `2. Delete the branch: \`git push origin --delete ${branch}\` and \`git branch -D ${branch}\``,
    `3. The base branch \`${base}\` was never written to, so nothing needs reverting there.`,
    "",
  ].join("\n");
}

export async function ship({ projectRoot, phase, base = "main", checks = [], dryRun = false, remote = "origin", title, body, runGh = ghPr }) {
  const at = new Date().toISOString();
  const { stdout: head } = await git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = head.trim();
  const results = [];
  for (const g of gates({ projectRoot, phase, base, checks, branch })) {
    let r;
    try { r = await g.run(); } catch (e) { r = { ok: false, why: `gate threw: ${e.message}` }; }
    results.push({ name: g.name, ...r });
    if (!r.ok) break;   // the first NO-GO stops the release; running the rest only costs time
  }
  const ok = results.every(r => r.ok);
  let prUrl = null, decision;
  if (!ok) decision = "NO-GO";
  else if (dryRun) decision = "GO (dry run — nothing pushed)";
  else {
    try {
      prUrl = await runGh({ projectRoot, branch, base, remote, title: title || `Phase ${phase}`, body: body || `Phase ${phase} — every gate green.\n\nGates: ${results.map(r => r.name).join(", ")}` });
      decision = "GO";
    } catch (e) {
      results.push({ name: "pull request", ok: false, why: e.message });
      decision = "NO-GO";
    }
  }

  const dir = path.join(projectRoot, ".sch-loop", "releases");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `phase-${phase}-${at.replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(file, toMarkdown({ phase, decision, base, branch, results, prUrl, at }));
  appendEvent(projectRoot, { type: "phase.shipped", phase: String(phase), decision, prUrl });
  return { decision, ok: decision.startsWith("GO"), prUrl, branch, base, results, file };
}

async function ghPr({ projectRoot, branch, base, remote, title, body }) {
  await pexec("git", ["push", "-u", remote, branch], { cwd: projectRoot, encoding: "utf8", windowsHide: true });
  const { stdout } = await pexec("gh", ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body], {
    cwd: projectRoot, encoding: "utf8", windowsHide: true, shell: process.platform === "win32",
  });
  const url = stdout.trim().split("\n").filter(l => l.startsWith("http")).pop();
  if (!url) throw new Error(`gh pr create printed no URL: ${stdout.trim().slice(-200)}`);
  return url;
}
