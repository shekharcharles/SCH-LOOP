#!/usr/bin/env node
// SCH Loop — the agent executor boundary.
//
// The orchestrator must not know how to talk to Claude. It knows how to talk to
// an EXECUTOR: prepare, execute, cancel. Today exactly one exists
// (ClaudeCliExecutor, a fresh external `claude` process per attempt); a Codex or
// OpenCode executor is a new class here and no change at all in runner.mjs.
// That is the only reason this file is separate from the runner.
//
// Everything in here is deliberately hostile to its own child process:
//   * arguments are an array — never an interpolated shell string;
//   * the environment is an ALLOWLIST, so the worker cannot read the operator's
//     cloud, GitHub or database credentials just because the parent shell had them;
//   * the prompt goes over stdin, so it never appears in the process list;
//   * SCH owns the timeout, the cancellation and the kill — not the worker;
//   * a task that has not been granted the network gets proxy variables aimed at
//     a dead port — a speed bump for proxy-honouring clients, NOT a boundary;
//   * stdout/stderr are capped, and truncation is recorded rather than hidden.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join, isAbsolute, delimiter, dirname } from "node:path";

export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;   // 20 min — SCH's, not the worker's
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB per stream
const KILL_GRACE_MS = 5000;
const CANCEL_POLL_MS = 250;

// ------------------------------------------------------- environment safety

// The ONLY variables a worker inherits. Anything not named here is dropped, so
// adding a new credential to your shell can never silently widen what the worker
// can see. Matched case-insensitively: Windows environment names are.
export const ENV_ALLOW = [
  // executable discovery + OS runtime
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "PROGRAMW6432",
  "TEMP", "TMP", "TMPDIR",
  // user identity + home (Claude CLI reads its config from the home directory)
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "USER", "USERNAME", "LOGNAME", "SHELL",
  // terminal / locale behaviour
  "TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "NO_COLOR", "CI",
  "NUMBER_OF_PROCESSORS", "OS", "PROCESSOR_ARCHITECTURE",
  // the user's EXISTING Claude authentication mechanism — passed through so the
  // worker can authenticate the way the operator already does, never logged and
  // never written into any artifact.
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  // node runtime
  "NODE_NO_WARNINGS",
];

// A worker must not be able to authenticate to a remote. `credential.helper` is
// `manager` on this operator's machine, which means the Windows Credential
// Manager vault is one `git push` away from any process running as them.
//
// This removes the AMBIENT credential helper — it does not stop a worker that
// deliberately re-adds one with `git -c credential.helper=manager` or `git config --local`.
// For that reason, SCH inspects the repository after every run and fails it on
// FORBIDDEN_GIT_EFFECT if a worker committed or pushed — detection after the
// fact, not prevention.
//
// This is set on the ENVIRONMENT, never in the worktree's git config: the
// delivery controller runs in that same worktree and still has to push.
export const GIT_CREDENTIAL_STRIP = Object.freeze({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
});

// ------------------------------------------------------------ NETWORK POLICY
//
// WHAT THIS IS, SAID BEFORE ANYTHING ELSE: it is not a network boundary, and
// nothing here prevents a worker from reaching the internet.
//
// There is no per-process network restriction available on Windows and POSIX
// alike without a new dependency or administrator rights. Windows Firewall
// filters per executable and needs elevation; `unshare -n`, nftables and cgroups
// need root; macOS `sandbox-exec` is deprecated and absent elsewhere. SCH has
// none of those, so it does not claim one.
//
// What it CAN do is refuse to hand the worker a working proxy route: the
// standard proxy variables are pointed at a closed loopback port. That stops
// clients which honour them — curl, wget, git-over-http, npm, pip, python
// requests, Go's default transport. It does NOT stop, and is not intended to
// stop: a raw socket, ssh, a DNS query, or any client that ignores the
// variables (Node's own `fetch` did, through v22). A worker that can write three
// lines of JavaScript has all of those. Treat this as a speed bump for the
// accidental fetch and as a recorded declaration of intent — never as
// containment.
//
// The model endpoint is EXEMPT BY CONSTRUCTION. The worker IS an HTTP client to
// the model API, so a policy that covered it would end every run before it
// started. That exemption is itself an open route out.
export const NETWORK_DENY_PROXY = "http://127.0.0.1:9";   // discard port — nothing serves HTTP there

// The hosts a denied worker must still reach, or it cannot talk to its model.
// Derived from the operator's OWN provider configuration, which is already on
// the allowlist above — never guessed.
function exemptHosts(parent = process.env) {
  const hosts = ["localhost", "127.0.0.1", "::1",
    // the model API, its auth/refresh and its telemetry: all under these two,
    // and all reached by the CLI itself rather than by the task.
    ".anthropic.com", ".claude.ai"];
  const base = parent.ANTHROPIC_BASE_URL;
  if (base) { try { hosts.push(new URL(base).hostname); } catch { /* an unparseable base URL is the operator's problem, not a crash */ } }
  const on = (v) => v !== undefined && v !== "" && !/^(0|false)$/i.test(String(v));
  if (on(parent.CLAUDE_CODE_USE_BEDROCK)) hosts.push(".amazonaws.com");
  if (on(parent.CLAUDE_CODE_USE_VERTEX)) hosts.push(".googleapis.com");
  return [...new Set(hosts)];
}

// The environment fragment a network policy contributes. `allow` contributes
// nothing — the absence of a mechanism, not a weaker one. Anything else,
// including a missing value, is treated as `deny`: this fails closed.
export function networkEnv(policy = "deny", parent = process.env) {
  if (policy === "allow") return {};
  const exempt = exemptHosts(parent).join(",");
  const env = {};
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) env[k] = NETWORK_DENY_PROXY;
  env.NO_PROXY = exempt;
  // curl reads `http_proxy` in lower case ONLY (a CGI-era rule), and several
  // other clients look at one case or the other. Windows environment lookup is
  // case-insensitive, so the upper-case names already answer both there and a
  // duplicate would just be noise in the child's environment block.
  if (process.platform !== "win32")
    for (const [k, v] of Object.entries(env)) env[k.toLowerCase()] = v;
  return env;
}

// What may be written down about it. Says what it does in the words the README
// uses, so an auditor reading the run never has to infer the strength.
export const networkEvidence = (policy, env) => ({
  policy: policy === "allow" ? "allow" : "deny",
  mechanism: policy === "allow" ? "none" : "proxy-environment-variables",
  effect: policy === "allow"
    ? "the worker's network access is unrestricted"
    : "clients that honour proxy environment variables cannot connect; raw sockets, DNS, ssh and clients that ignore the variables are unaffected",
  variables: Object.keys(env).filter((k) => /proxy/i.test(k)).sort(),
  exempt: policy === "allow" ? [] : (env.NO_PROXY ?? "").split(",").filter(Boolean),
});

// Values that must never reach an artifact, a log or a diagnostic even though
// they are legitimately passed to the child.
const SECRET_NAMES = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)$/i;

const upper = (s) => String(s).toUpperCase();

// PATH is the only allowlisted value that names places to load EXECUTABLE CODE
// from, and until now it was handed to the child verbatim. A NON-ABSOLUTE entry
// there is resolved against the CHILD'S working directory — and for a
// verification command that directory is the worktree the worker just finished
// writing. So an operator whose PATH contains `node_modules/.bin` or `.` lets a
// worker decide what SCH's own `npm test` means, by writing a file.
//
// Absolute entries only. That is not a sandbox and does not pretend to be one:
// it removes one specific way a worker's OUTPUT becomes SCH's next INPUT.
//
// Measured on Windows (Node 24 / libuv) rather than assumed: a bare executable
// name is NOT searched for in the child's cwd, and an EMPTY PATH entry is
// ignored — but a literal "." IS honoured and resolves against the child's cwd.
// POSIX `execvp` treats an empty entry as the cwd outright. Both forms go.
//
// Consequence, stated because it is a real behaviour change: an operator who
// deliberately puts a relative directory on PATH loses it inside SCH's children.
const absolutePathEntries = (value) =>
  String(value).split(delimiter).filter((e) => e !== "" && isAbsolute(e)).join(delimiter);

// Explicit construction: start empty, copy what is allowed, then add the run
// identity. SCH_HOME is deliberately absent — a worker must not be able to find,
// let alone edit, the operational state that grades it.
export function buildEnv(parent = process.env, extra = {}) {
  const allow = new Set(ENV_ALLOW.map(upper));
  const env = {};
  for (const [k, v] of Object.entries(parent))
    if (allow.has(upper(k)) && v !== undefined) env[k] = upper(k) === "PATH" ? absolutePathEntries(v) : v;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = String(v);
  return env;
}

// What may be written down about the environment: names only for secrets.
export const redactEnv = (env) =>
  Object.fromEntries(Object.keys(env).sort().map((k) => [k, SECRET_NAMES.test(k) ? "[redacted]" : env[k]]));

// ------------------------------------------------------ executable discovery

// Resolve a command to a real file. A bare name is looked up on PATH (honouring
// PATHEXT on Windows) so the run records the exact file it started, not a name
// that might resolve differently later.
//
// The same absolute-only rule as `buildEnv`, one level up: this joins each PATH
// entry with the command name and stats it, so a relative entry is resolved
// against SCH'S OWN cwd — the managed repository — and a file sitting there
// would decide which `claude` SCH launches.
// Node refuses to spawn a .cmd/.bat without a shell (the CVE-2024-27980
// hardening), and this executor will not take a shell — an interpolated command
// string is exactly the injection surface the whole file is built to avoid.
//
// npm's Windows shim is a two-line batch file that calls one quoted path, so we
// read the target out of it and spawn that directly. Real executable, array
// arguments, no shell. If the shim is not the shape we expect, the original path
// is returned unchanged and the caller fails loudly rather than silently running
// something else.
function unwrapWindowsShim(p) {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(p)) return p;
  try {
    const text = readFileSync(p, "utf8");
    const m = text.match(/"%(?:dp0|~dp0)%\\?([^"]+\.exe)"/i) || text.match(/"([A-Za-z]:\\[^"]+\.exe)"/);
    if (!m) return p;
    const target = m[1].includes(":") ? m[1] : join(dirname(p), m[1]);
    return statSync(target).isFile() ? target : p;
  } catch { return p; }
}

export function resolveExecutable(cmd, env = process.env) {
  if (!cmd) return null;
  const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
  if (cmd.includes("/") || cmd.includes("\\") || isAbsolute(cmd)) return isFile(cmd) ? cmd : null;
  const exts = process.platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  // ORDER MATTERS ON WINDOWS, and getting it wrong fails at spawn, not here.
  //
  // npm-style installers ship BOTH `claude` (a #!/bin/sh shim for Git Bash/MSYS)
  // and `claude.cmd` in the same directory. `statSync().isFile()` is true for the
  // extensionless shim, so trying "" first resolved to a shell script that
  // CreateProcess cannot execute — every worker died with ENOENT in ~3ms and the
  // scheduler reported AGENT_PROTOCOL_ERROR, three attempts deep, with no clue
  // that the executable was the problem.
  //
  // So on Windows the PATHEXT candidates come first and the bare name is the
  // fallback; elsewhere the bare name is the only candidate and this is a no-op.
  const order = process.platform === "win32" ? [...exts, ""] : ["", ...exts];
  for (const dir of String(env.PATH || "").split(delimiter).filter((d) => d !== "" && isAbsolute(d)))
    for (const ext of order) {
      const p = join(dir, cmd + ext);
      if (isFile(p)) return unwrapWindowsShim(p);
    }
  return null;
}

// --------------------------------------------------------- executor contract

// The provider-neutral interface. A new provider implements these four members
// and nothing in the orchestrator changes.
export class AgentExecutor {
  get id() { throw new Error("executor must declare an id"); }
  capabilities() { return { fresh_context: false, streaming: false, cancellable: false, structured_handoff: false }; }
  // Cheap, side-effect-free "could this run at all" check.
  async prepare() { return { ok: true, problems: [] }; }
  async execute() { throw new Error("executor must implement execute()"); }
  cancel() { /* optional */ }
}

// A bounded sink: keeps the first N bytes, counts everything, and says so.
function sink(limit) {
  const chunks = []; let kept = 0, total = 0, truncated = false;
  return {
    push(buf) {
      total += buf.length;
      if (kept >= limit) { truncated = true; return; }
      const room = limit - kept;
      if (buf.length > room) { chunks.push(buf.subarray(0, room)); kept += room; truncated = true; }
      else { chunks.push(buf); kept += buf.length; }
    },
    get text() { return Buffer.concat(chunks).toString("utf8"); },
    get evidence() { return { bytes_total: total, bytes_kept: kept, truncated, limit }; },
  };
}

// Kill the child AND its descendants. Honest about platform difference:
//   Windows — `taskkill /T /F` walks the real process tree.
//   POSIX   — the child is its own process-group leader (detached), so a signal
//             to -pid reaches the group. A grandchild that calls setsid escapes
//             on both platforms; nothing here pretends otherwise.
function killTree(child) {
  const pid = child.pid;
  const evidence = { pid: pid ?? null, method: null, ok: false, detail: "" };
  if (!pid) { evidence.detail = "no pid — process never started"; return evidence; }
  try {
    if (process.platform === "win32") {
      evidence.method = "taskkill /T /F";
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "pipe" });
    } else {
      evidence.method = "SIGTERM to process group, SIGKILL after grace";
      try { process.kill(-pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      const until = Date.now() + KILL_GRACE_MS;
      while (Date.now() < until && child.exitCode === null && child.signalCode === null) { /* bounded wait */ }
      try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    }
    evidence.ok = true;
  } catch (e) {
    // taskkill exits non-zero when the tree is already gone — that is success.
    const msg = String(e.stderr || e.message || "");
    evidence.ok = /not found|no running instance|nicht gefunden/i.test(msg);
    evidence.detail = msg.split("\n")[0].slice(0, 200);
  }
  return evidence;
}

// -------------------------------------------------------- Claude CLI worker

// One attempt = one fresh external process. There is no session, no reuse and no
// continuation: that IS the fresh-context guarantee, and it is structural rather
// than a sentence in a prompt.
export class ClaudeCliExecutor extends AgentExecutor {
  constructor({ executable = null, baseArgs = null, timeoutMs = DEFAULT_TIMEOUT_MS,
                maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, env = process.env } = {}) {
    super();
    this.configured = executable ?? env.SCH_CLAUDE_EXECUTABLE ?? "claude";
    // `--output-format json` is not optional machinery, it is the only way the
    // CLI reports token counts and cost at all. It is appended rather than
    // required of the operator, so SCH_CLAUDE_ARGS stays about the operator's
    // choices (permissions, model) and never has to remember SCH's plumbing.
    const wanted = baseArgs ?? (env.SCH_CLAUDE_ARGS ? env.SCH_CLAUDE_ARGS.split(" ").filter(Boolean) : ["-p"]);
    this.baseArgs = wanted.includes("--output-format") ? wanted : [...wanted, "--output-format", "json"];
    this.timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = Number(maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES;
    this.parentEnv = env;
    this._child = null;
    this._cancelReason = null;
  }

  get id() { return "claude-cli"; }
  capabilities() {
    return {
      fresh_context: true, streaming: false, cancellable: true, structured_handoff: true,
      // Said plainly because the runner's guarantees depend on it: process-tree
      // cleanup is best-effort on POSIX for a grandchild that leaves the group.
      process_tree_cleanup: process.platform === "win32" ? "taskkill-tree" : "process-group",
    };
  }

  async prepare() {
    const problems = [];
    const exe = resolveExecutable(this.configured, this.parentEnv);
    if (!exe) problems.push({ code: "ENVIRONMENT_MISSING", message: `Claude executable "${this.configured}" not found — set SCH_CLAUDE_EXECUTABLE to its full path` });
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 6 * 60 * 60 * 1000)
      problems.push({ code: "POLICY_VIOLATION", message: `invalid timeout ${this.timeoutMs}ms — must be between 1s and 6h` });
    if (!Number.isFinite(this.maxOutputBytes) || this.maxOutputBytes < 1024)
      problems.push({ code: "POLICY_VIOLATION", message: `invalid output limit ${this.maxOutputBytes} bytes` });
    return { ok: problems.length === 0, problems, executable: exe };
  }

  cancel(reason = "operator cancelled") {
    this._cancelReason = reason;
    if (this._child) killTree(this._child);
  }

  // Resolves with a terminal record whatever happens — a spawn failure, a
  // timeout and a clean exit are all outcomes, never exceptions.
  async execute({ cwd, prompt, identity = {}, extraArgs = [], network = "deny", isCancelled = () => false, onEvent = () => {} } = {}) {
    const prep = await this.prepare();
    // One argv, built once: the record and the spawn must never disagree about
    // what this process was launched with.
    const argv = [...this.baseArgs, ...(Array.isArray(extraArgs) ? extraArgs.map(String) : [])];
    const started = Date.now();
    const base = {
      executable: prep.executable ?? this.configured, args: argv.slice(),
      cwd, pid: null, started_at: new Date(started).toISOString(), ended_at: null, duration_ms: 0,
      stdout: "", stderr: "", exit_code: null, signal: null,
      timed_out: false, cancelled: false, cleanup: null,
      stdout_evidence: null, stderr_evidence: null,
      // Filled in below from the environment actually handed to the child. The
      // run record used to recompute this from a DIFFERENT extra object, so
      // worker.json described an environment no process ever received — a wrong
      // answer to "did this worker have GH_TOKEN?", on the one surface that
      // question is asked. Names only: values are never recorded here.
      environment_names: [],
      // The network policy this worker ran under and, in plain words, what that
      // did and did not do. Recorded whatever the outcome: "was this task
      // permitted to reach the network?" must be answerable from the run.
      network: null,
    };
    const netEnv = networkEnv(network, this.parentEnv);
    base.network = networkEvidence(network, netEnv);
    if (!prep.ok) {
      return { ...base, ended_at: new Date().toISOString(), ok: false, failure: prep.problems[0] };
    }

    const env = buildEnv(this.parentEnv, {
      ...GIT_CREDENTIAL_STRIP, ...netEnv,
      SCH_RUN_ID: identity.run_id, SCH_PROJECT_ID: identity.project_id, SCH_TASK_ID: identity.task_id,
      // Which attempt this is. A repair worker that cannot tell it is a repair
      // has no way to read the failure evidence it was given differently from
      // the original task — and a scheduler cannot prove "a fresh process per
      // attempt" without something in the child that names the attempt.
      SCH_ATTEMPT: identity.attempt,
      // Which semantic phase this worker is. The worker does not act on it — SCH
      // decides everything — but a test fixture needs to tell a scout run from a
      // builder run, and a run record that names its phase is easier to read.
      SCH_PHASE: identity.phase_id,
      SCH_SEMANTIC: identity.semantic,
    });
    base.environment_names = Object.keys(env).sort();

    const out = sink(this.maxOutputBytes), err = sink(this.maxOutputBytes);
    let child;
    try {
      child = spawn(prep.executable, argv, {
        cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        // POSIX: own process group so the whole tree can be signalled at once.
        detached: process.platform !== "win32",
      });
    } catch (e) {
      return { ...base, ended_at: new Date().toISOString(), ok: false,
        failure: { code: "AGENT_PROCESS_FAILURE", message: `could not start ${prep.executable}: ${e.message}` } };
    }
    this._child = child;
    base.pid = child.pid ?? null;
    onEvent("run.worker_started", { executable: prep.executable, args: this.baseArgs, pid: base.pid, cwd });

    // The prompt is never an argument: arguments are world-readable in the
    // process list, and a task brief is not.
    try { child.stdin.end(String(prompt ?? "")); } catch { /* child already gone */ }

    let accepting = true;
    child.stdout.on("data", (b) => { if (accepting) out.push(b); });
    child.stderr.on("data", (b) => { if (accepting) err.push(b); });

    const result = await new Promise((done) => {
      let settled = false;
      const finish = (extra) => {
        if (settled) return; settled = true;
        clearTimeout(timer); clearInterval(poll);
        done(extra);
      };
      const stop = (why, extra) => {
        accepting = false;                                    // stop accepting worker output FIRST
        const cleanup = killTree(child);
        finish({ ...extra, cleanup, reason: why });
      };
      const timer = setTimeout(() => { onEvent("run.worker_timed_out", { after_ms: this.timeoutMs }); stop("timeout", { timed_out: true }); }, this.timeoutMs);
      const poll = setInterval(() => {
        let want = false;
        try { want = !!isCancelled(); } catch { want = false; }
        if (want || this._cancelReason) {
          onEvent("run.worker_cancelled", { reason: this._cancelReason ?? "cancellation requested" });
          stop("cancelled", { cancelled: true });
        }
      }, CANCEL_POLL_MS);

      child.on("error", (e) => finish({ spawn_error: e.message }));
      child.on("close", (code, signal) => finish({ exit_code: code, signal }));
    });

    // A killed child still emits `close`; give it a bounded moment so exit_code
    // and signal are recorded rather than lost to the race with our own kill.
    if (result.cleanup && result.exit_code === undefined) {
      await new Promise((r) => { const t = setTimeout(r, 1500); child.once("close", () => { clearTimeout(t); r(); }); });
    }
    this._child = null;

    const ended = Date.now();
    const rec = {
      ...base,
      ended_at: new Date(ended).toISOString(), duration_ms: ended - started,
      stdout: out.text, stderr: err.text,
      stdout_evidence: out.evidence, stderr_evidence: err.evidence,
      exit_code: result.exit_code ?? child.exitCode ?? null,
      signal: result.signal ?? child.signalCode ?? null,
      timed_out: !!result.timed_out, cancelled: !!result.cancelled,
      cleanup: result.cleanup ?? null,
    };
    if (result.spawn_error)
      return { ...rec, ok: false, failure: { code: "AGENT_PROCESS_FAILURE", message: result.spawn_error } };
    if (rec.timed_out) return { ...rec, ok: false, failure: { code: "AGENT_TIMEOUT", message: `worker exceeded ${this.timeoutMs}ms and was terminated` } };
    if (rec.cancelled) return { ...rec, ok: false, failure: { code: "CANCELLED", message: this._cancelReason ?? "run cancelled" } };
    if (rec.exit_code !== 0)
      return { ...rec, ok: false, failure: { code: "AGENT_PROCESS_FAILURE", message: `worker exited ${rec.exit_code}${rec.signal ? ` (signal ${rec.signal})` : ""}` } };
    onEvent("run.worker_exited", { exit_code: rec.exit_code, duration_ms: rec.duration_ms });
    return { ...rec, ok: true, failure: null };
  }
}
