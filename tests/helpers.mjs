// Shared fixtures for the runner tests.
//
// Every test gets: a throwaway SCH_HOME, a throwaway git repository, a
// registered project pointing at it, and a fake Claude executable. Nothing
// touches the operator's real registry, real skills, real repositories or the
// network, and no real model is ever invoked.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FAKE_CLAUDE = join(ROOT, "tests", "fixtures", "fake-claude.mjs");
export const url = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:");

export const WS = await import(url(join(ROOT, "scripts", "workspace.mjs")));
export const RUN = await import(url(join(ROOT, "scripts", "runner.mjs")));
export const EXEC = await import(url(join(ROOT, "scripts", "executor.mjs")));
export const STATE = await import(url(join(ROOT, "scripts", "state.mjs")));
export const CAND = await import(url(join(ROOT, "scripts", "candidate.mjs")));
export const DEL = await import(url(join(ROOT, "scripts", "delivery.mjs")));

export const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Secrets that exist in the PARENT process and must never reach the worker.
// Shaped like the real thing so the assertions mean something, but ASSEMBLED at
// runtime: a literal credential pattern in a committed file is exactly what
// secret-scan blocks, and the gate is right to block it.
export const SECRET_ENV = {
  AWS_SECRET_ACCESS_KEY: ["wJalrXUtnFEMI", "K7MDENGbPxRfiCY", "EXAMPLEKEY"].join(""),
  GITHUB_TOKEN: ["gh" + "p", "0".repeat(36) + "ab"].join("_"),
  DATABASE_PASSWORD: "hunter2-not-for-the-worker",
  OPENAI_API_KEY: ["sk-", "unrelated-provider-key-", "0".repeat(12)].join(""),
  SCH_HOME_LOOKALIKE: "should-not-travel",
};

let n = 0;

// A registered project on a real git repository with one commit.
export function fixture(name, { register = true, commit = true } = {}) {
  const tag = `${name}-${process.pid}-${++n}`;
  const home = mkdtempSync(join(tmpdir(), "sch-home-" + tag + "-"));
  const repo = mkdtempSync(join(tmpdir(), "sch-repo-" + tag + "-"));
  const P = "proj";

  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.js"), "// app\n");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  if (commit) { git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "initial"); }

  mkdirSync(join(home, "projects", P), { recursive: true });
  if (register)
    writeFileSync(join(home, "projects.json"), JSON.stringify({
      version: 3, projects: [{ id: P, name: "fixture", domain: "app-dev", path: repo, scope: {} }], authorizations: [],
    }, null, 2));
  else writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 3, projects: [], authorizations: [] }));

  // Only SCH's own built-in skills are discoverable: the operator's installed
  // skills can neither influence nor break a test.
  process.env.SCH_HOME = home;
  process.env.SCH_SKILL_ROOTS = "builtin:" + join(ROOT, "skills");
  for (const [k, v] of Object.entries(SECRET_ENV)) process.env[k] = v;

  const cli = (...a) => execFileSync("node", [join(ROOT, "scripts", "state.mjs"), ...a],
    { encoding: "utf8", env: { ...process.env, SCH_HOME: home, NODE_NO_WARNINGS: "1" } }).trim();

  return {
    home, repo, P, cli,
    state: () => JSON.parse(readFileSync(join(home, "projects", P, "state.json"), "utf8")),
    wsDir: () => join(repo, ".sch-loop"),
    bare: null,
    done: function () { for (const d of [home, repo, this.bare].filter(Boolean)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } },
  };
}

// Initialize the workspace and commit what it created, so the working tree is
// clean — exactly the state a run requires.
export function initWorkspace(fx) {
  fx.cli("workspace-init", "--project", fx.P);
  git(fx.repo, "add", "-A");
  git(fx.repo, "commit", "-q", "-m", "sch workspace");
  return fx.wsDir();
}

// A task that is eligible for a run: queued, no deps, with a path policy and a
// required verification command.
export function addTask(fx, {
  title = "do the thing", allow = "src/**", forbid = "src/secret.js",
  verify = `${process.execPath.replace(/\\/g, "/")} -e 0`, ...rest
} = {}) {
  const args = ["task-add", "--project", fx.P, "--title", title, "--ac", "AC-1: it works",
    "--allow", allow, "--verify", verify];
  if (forbid) args.push("--forbid", forbid);
  for (const [k, v] of Object.entries(rest)) args.push("--" + k, String(v));
  return Number(fx.cli(...args));
}

// An executor bound to the fake Claude, driven by a behaviour file.
export function fakeExecutor(fx, behaviour, opts = {}) {
  const path = join(fx.home, `behaviour-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(behaviour, null, 2));
  return new EXEC.ClaudeCliExecutor({
    executable: process.execPath, baseArgs: [FAKE_CLAUDE, path],
    timeoutMs: opts.timeoutMs ?? 60000, maxOutputBytes: opts.maxOutputBytes ?? 1024 * 1024,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
}

export const run = (fx, taskId, executor, extra = {}) =>
  RUN.runTask({ projectId: fx.P, taskId, executor, env: { ...process.env, ...(extra.env ?? {}) }, ...extra });

export const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

// ------------------------------------------------------------- delivery

// A LOCAL BARE REMOTE. Every delivery test pushes to a directory on this
// machine: no network, no GitHub, no credential, and a real `git push` with
// real rejection semantics rather than a mock that always agrees.
export function withRemote(fx, { branch = "main" } = {}) {
  const bare = mkdtempSync(join(tmpdir(), "sch-remote-"));
  execFileSync("git", ["init", "--bare", "-q", "-b", branch, bare], { stdio: "ignore" });
  git(fx.repo, "remote", "add", "origin", bare);
  git(fx.repo, "push", "-q", "origin", `${branch}:${branch}`);
  git(fx.repo, "branch", `--set-upstream-to=origin/${branch}`, branch);
  fx.bare = bare;
  return bare;
}

// A second working copy of the same bare remote — how another person's commit
// arrives on the remote in an incoming-commit test.
export function otherClone(bare, name = "other") {
  const dir = mkdtempSync(join(tmpdir(), `sch-${name}-`));
  execFileSync("git", ["clone", "-q", bare, dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "other@t"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "other"], { stdio: "ignore" });
  return dir;
}

// Run a task to VERIFIED so there is something deliverable, without asserting
// on the run itself — the delivery tests are about what happens next.
export async function verifiedRun(fx, taskId, behaviour) {
  const rec = await run(fx, taskId, fakeExecutor(fx, behaviour));
  if (rec.outcome !== "VERIFIED") throw new Error(`fixture expected VERIFIED, got ${rec.outcome}: ${rec.failure?.message}`);
  return rec;
}

// Approve a delivery the way an operator actually does.
//
// An approval signs a TRANSACTION — its diff hash, branch, remote and message —
// so the transaction has to exist first. That is what the operator flow looks
// like too: run the delivery, it stops at APPROVAL_REQUIRED having written down
// exactly what it intends, and only then is there something to sign.
export function approve(fx, runId, extra = {}) {
  if (!DEL.readTransaction(DEL.deliveryPathFor(join(fx.repo, ".sch-loop"), runId)))
    DEL.deliverRun({ projectId: fx.P, runId });
  return DEL.approveDelivery(fx.P, runId, { approver: "test-operator", why: "fixture", ...extra });
}
export const deliver = (fx, runId, extra = {}) => DEL.deliverRun({ projectId: fx.P, runId, ...extra });

// Record every git argv SCH runs, so a test can assert on what was NOT run.
export function recordGit() {
  const calls = [];
  CAND.setGitAudit((args) => calls.push(args.join(" ")));
  return { calls, stop: () => CAND.gitAuditOff() };
}
