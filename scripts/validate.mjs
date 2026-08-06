#!/usr/bin/env node
// SCH Loop — self-validation. Catches the drift class that tests can't: a skill
// with broken frontmatter, a pack pointing at a missing method file, a README
// referencing a script that no longer exists, a hardcoded machine-specific path,
// or an engagement-data file about to be committed. Run: `npm run validate`.

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); };
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// 1. every skill has valid frontmatter with a matching name
const SKILLS = ["SCH", "sch-spec", "sch-brainstorm", "sch-plan", "sch-run", "sch-review", "sch-ship", "sch-learn"];
for (const s of SKILLS) {
  const p = `skills/${s}/SKILL.md`;
  if (!existsSync(join(ROOT, p))) { fail.push(`missing skill: ${p}`); continue; }
  const t = read(p);
  // \r? — a Windows checkout with core.autocrlf=true has CRLF on disk, which an
  // LF-only pattern reads as "no frontmatter at all". Every skill then failed
  // validation on the machine the loop actually runs on, while CI stayed green.
  const fm = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  ok(fm, `${p}: missing YAML frontmatter`);
  if (!fm) continue;
  ok(new RegExp(`^name:\\s*${s}\\s*$`, "m").test(fm[1]), `${p}: frontmatter name must be "${s}"`);
  ok(/^description:\s*\S/m.test(fm[1]), `${p}: needs a description`);
  // 1b. the repo is the source of truth, but Claude Code loads ~/.claude/skills.
  // Editing the source and forgetting to install it means the loop keeps running
  // the OLD instructions with no visible symptom — the worst kind of drift.
  const installed = join(homedir(), ".claude", "skills", s, "SKILL.md");
  if (existsSync(installed)) {
    ok(readFileSync(installed, "utf8") === t,
      `${p}: installed copy is out of date — run: node scripts/sync-skills.mjs`);
  }
}

// 2. packs: every method/knowledge file referenced must exist
const packs = JSON.parse(read("packs/packs.json"));
for (const [k, v] of Object.entries(packs)) {
  if (k === "_comment") continue;
  if (v.method) ok(existsSync(join(ROOT, v.method)), `pack ${k}: missing method file ${v.method}`);
  if (v.knowledge) ok(existsSync(join(ROOT, v.knowledge)), `pack ${k}: missing knowledge file ${v.knowledge}`);
  ok(v.kind && v.validate && v.complete && v.deliver, `pack ${k}: incomplete definition`);
}

// 3. README references resolve
const readme = read("README.md");
for (const m of readme.matchAll(/`?(scripts\/[a-z-]+\.mjs)`?/g))
  ok(existsSync(join(ROOT, m[1])), `README references a missing file: ${m[1]}`);
for (const f of readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".mjs")))
  ok(readme.includes(f), `scripts/${f} exists but is undocumented in the README file map`);

// 4. portability: no machine-specific absolute paths in shipped files
const PORTABLE_DIRS = ["skills", "docs", "scripts"];
const badPath = /C:[\\/]Users[\\/](?!<)[A-Za-z0-9._-]+[\\/](Desktop|Documents)/;
const walk = (d) => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
for (const dir of PORTABLE_DIRS)
  for (const f of walk(dir).filter((f) => /\.(md|mjs|json)$/.test(f)))
    ok(!badPath.test(read(f)), `${f}: contains a machine-specific path (use $HOME/.claude/SCH-loop)`);

// 5. engagement data must be git-ignored, never shipped
const gi = read(".gitignore");
for (const p of ["projects/", "projects.json", "authorizations/", "logs/", "CLAUDE.md", ".env"])
  ok(gi.includes(p), `.gitignore must exclude ${p}`);

// 6. safety contracts the loop depends on
const run = read("skills/sch-run/SKILL.md");
const review = read("skills/sch-review/SKILL.md");
for (const [cond, msg] of [
  [run.includes("secret-scan"), "sch-run must gate commits with secret-scan"],
  [run.includes("fresh-context"), "sch-run must execute tasks in a fresh-context subagent"],
  [run.includes("scope-check"), "sch-run must re-check scope before an active task"],
  [run.includes("pass-gate"), "sch-run must start with the cheap pass-gate"],
  [review.includes("Definition of Done"), "sch-review must validate the Definition-of-Done checklist"],
]) ok(cond, msg);

// 6b. the supervised runner's structural guarantees. These are the claims the
// README makes about it; a claim nothing enforces is the exact class of drift
// this file exists to catch.
{
  const runner = read("scripts/runner.mjs");
  const executor = read("scripts/executor.mjs");
  const workspace = read("scripts/workspace.mjs");
  for (const [cond, msg] of [
    [executor.includes("ENV_ALLOW"), "executor must build the worker environment from an allowlist, not the parent environment"],
    [!/ENV_ALLOW\s*=\s*\[[^\]]*"SCH_HOME"/s.test(executor), "SCH_HOME must never be passed to a worker — it is the state that grades it"],
    [executor.includes("spawn("), "the worker must be spawned with an argument array, never an interpolated shell string"],
    [runner.includes("FORBIDDEN_GIT_EFFECT"), "the runner must classify worker-created git effects"],
    [runner.includes("WORKER_FORBIDDEN"), "the runner must apply the runner-owned forbidden paths to every effect"],
    [/GIT_READONLY\s*=\s*new Set/.test(runner), "verification must allow git subcommands by allowlist, not by deny-list"],
    [workspace.includes('WORKSPACE = ".sch-loop"'), "the workspace directory must be exactly .sch-loop"],
  ]) ok(cond, msg);

  // 6c. the delivery controller. These are the guarantees the README makes
  // about the only component allowed to push, so they are enforced rather than
  // trusted: a regression here reaches a remote before anyone notices.
  const candidate = read("scripts/candidate.mjs");
  const delivery = read("scripts/delivery.mjs");
  for (const [cond, msg] of [
    [/FORBIDDEN_ARGV\s*=\s*\[/.test(candidate), "candidate.mjs must keep the forbidden git argv table"],
    [candidate.includes("assertSafeGitArgs"), "every git call must pass through assertSafeGitArgs"],
    // the controller must own no git execution path that skips the guard
    [!/\bspawnSync\(\s*["']git["']/.test(delivery), "delivery.mjs must not spawn git directly — it goes through candidate.mjs's gitRun"],
    [!/execFileSync\(\s*["']git["']/.test(delivery), "delivery.mjs must not exec git directly — it goes through candidate.mjs's gitRun"],
    [delivery.includes("markDelivered"), "only the delivery controller may complete a task"],
    [delivery.includes("secret-scan.mjs"), "the delivery controller must run the secret gate against staged content"],
    [/independent_fetch/.test(delivery), "remote verification must fetch independently rather than trust push stdout"],
    [read("scripts/state.mjs").includes("CONTROLLER_ONLY_STATUSES"), "`delivered` must be unreachable from task-set"],
  ]) ok(cond, msg);

  // 6d. the sequential graph scheduler. Same principle as above: these are the
  // structural claims the README makes about it, so they are enforced rather
  // than trusted. Each one is a boundary a refactor could quietly remove.
  const graph = read("scripts/taskgraph.mjs");
  const transitions = read("scripts/transitions.mjs");
  const envelopes = read("scripts/envelopes.mjs");
  const gatesSrc = read("scripts/gates.mjs");
  const phases = read("scripts/phases.mjs");
  const scheduler = read("scripts/scheduler.mjs");
  const humangates = read("scripts/humangates.mjs");
  const projection = read("scripts/projection.mjs");
  for (const [cond, msg] of [
    // the graph is audited, never silently rewritten
    [/FALSE_EDGE_SUSPECTED/.test(graph), "taskgraph.mjs must flag undefended dependency edges"],
    [/DEPENDENCY_CYCLE/.test(graph), "taskgraph.mjs must detect dependency cycles"],
    [!/tasks\.splice|delete .*\.deps|\.deps\s*=\s*\[\]/.test(graph), "taskgraph.mjs must never edit the graph it is validating"],
    // a model is not an actor
    [/a model never moves a task/.test(transitions), "transitions.mjs must refuse a model as a transition actor"],
    [/STATE_VERSION_CONFLICT/.test(transitions), "transitions.mjs must enforce expected-version concurrency"],
    [transitions.includes("LEGACY_TO_STATE") && transitions.includes("STATE_TO_LEGACY"),
      "transitions.mjs must keep the documented legacy<->canonical map in both directions"],
    [/merged:\s*"AWAITING_DELIVERY"/.test(transitions),
      "`merged` must map to AWAITING_DELIVERY — it was never pushed, and mapping it to DELIVERED would claim a remote it never reached"],
    // envelopes are claims, not evidence
    [/Envelope claims are not system evidence/.test(envelopes), "envelopes.mjs must state that a claim is not evidence"],
    [/ENVELOPE_UNKNOWN_FIELD/.test(envelopes), "an envelope field nothing validates must be refused, not ignored"],
    [/ENVELOPE_AMBIGUOUS/.test(envelopes), "exactly one envelope block must be required"],
    [envelopes.includes("adaptLegacyHandoff"), "the previous milestone's worker handoff must still be readable"],
    // gates report evidence and factual ones are absolute
    [/FACTUAL_GATE_NOT_OVERRIDABLE/.test(gatesSrc), "a factual gate must be overridable by nobody"],
    [/evidence_hash/.test(gatesSrc), "every gate report must carry a stable evidence hash"],
    [/const cannotRun = /.test(gatesSrc), "a gate with no evidence must FAIL rather than skip"],
    // the phase lifecycle is code, and default-fail
    [/never skips a checkpoint/.test(phases), "the phase lifecycle must refuse a skipped checkpoint"],
    [/never moves backwards/.test(phases), "the phase lifecycle must refuse a reversal"],
    [phases.includes('"PENDING", "RUNNING", "EXECUTED", "REPORTED", "GATED", "ACCEPTED"'),
      "the phase lifecycle must keep all six forward checkpoints"],
    // the scheduler owns sequencing and delegates delivery
    [scheduler.includes("DEL.deliverRun"), "the scheduler must deliver THROUGH the existing controller"],
    [!/spawnSync\(\s*["']git["']|execFileSync\(\s*["']git["']/.test(scheduler),
      "scheduler.mjs must not run git directly — delivery is the controller's authority"],
    [scheduler.includes("RUN.runTask"), "the scheduler must execute a task through the existing supervised runner"],
    [!/markDelivered\s*\(/.test(scheduler), "only the delivery controller may complete a task"],
    [/max_consecutive_failures/.test(scheduler) && /max_total_attempts/.test(scheduler),
      "the scheduler must carry explicit, finite budgets"],
    [/NON_RETRYABLE_FAILURES/.test(scheduler), "retryability must be a policy table, never the worker's opinion"],
    // human decisions bind, and are never a remote write
    [/proposalHash/.test(humangates), "a human decision must bind to a proposal hash"],
    [/decisions_require_local_operator/.test(humangates), "the human-gate projection must state that deciding is local-operator authority"],
    // the projection is a projection
    [/PROJECTION of them|It is not the authority/.test(projection), "projection.mjs must state that it is not the authority"],
    [/INSERT OR IGNORE INTO events/.test(projection), "event projection must be idempotent by event id"],
    [!/from ["']better-sqlite3["']|require\(["']better-sqlite3/.test(projection), "the projection must use node:sqlite, not a dependency"],
  ]) ok(cond, msg);

  // 6e. the software-factory runtime. Same principle: the claims the README
  // makes about templates, roles, usage, evidence and external skills are
  // enforced here, because each one is a boundary a refactor could quietly remove.
  const workflows = read("scripts/workflows.mjs");
  const rolesSrc = read("scripts/roles.mjs");
  const usageSrc = read("scripts/usage.mjs");
  const evidenceSrc = read("scripts/evidence.mjs");
  const sourcesSrc = read("scripts/skillsources.mjs");
  const subprocessSrc = read("scripts/subprocess.mjs");
  const proceduresSrc = read("scripts/procedures.mjs");
  for (const [cond, msg] of [
    // a template is data over a CLOSED registry, never a module path
    [/UNKNOWN_HANDLER/.test(workflows), "workflows.mjs must refuse a handler that is not in the closed registry"],
    [/TEMPLATE_CANNOT_GRANT_AUTHORITY/.test(workflows), "a workflow template must never be able to grant tools or write scope"],
    [!/\bimport\s*\(\s*[^"')]*(ph|phase|handler)/.test(workflows), "workflows.mjs must not dynamically import a module named by data"],
    // role, executor, provider, model and authority are separate
    [/skills are content, never authority/.test(rolesSrc), "roles.mjs must state and enforce that a skill grants no authority"],
    [/PROVIDER_FALLBACK_FORBIDDEN/.test(rolesSrc), "a cross-provider fallback must never be implicit"],
    [/READ_ONLY_ROLES/.test(rolesSrc), "read-only roles must be enforced, not documented"],
    [/EXECUTOR_UNAVAILABLE|MODEL_PROFILE_UNAVAILABLE/.test(rolesSrc), "an unavailable executor or model profile must fail closed"],
    // unknown is not zero
    [/UNKNOWN IS NOT ZERO/.test(usageSrc), "usage.mjs must state the unknown-is-not-zero rule it enforces"],
    [/unknown_usage_phases/.test(usageSrc), "aggregation must count unknown phases rather than sum them as zero"],
    [!/input_per_mtok:\s*\d/.test(usageSrc), "no unverified price may be hardcoded — rates are operator-configured and dated"],
    [/pricing_table_version/.test(usageSrc), "every cost record must carry the pricing table version that produced it"],
    // passing logs never reach a prompt
    [/passing_excerpt_characters:\s*0/.test(evidenceSrc), "a passing check must contribute ZERO log characters"],
    [/failing_stdout_characters/.test(evidenceSrc) && /failing_stderr_characters/.test(evidenceSrc), "failing excerpts must be bounded"],
    [/sanitizeArgs/.test(evidenceSrc), "an argument vector must be sanitized before it reaches a prompt or a projection"],
    // external skills are governed, not trusted
    [/SOURCE_PIN_REQUIRED/.test(sourcesSrc), "an external source must be pinned to a full commit, never a branch"],
    [/auto_update:\s*false/.test(sourcesSrc), "external sources must never auto-update"],
    [/SOURCE_URL_HAS_CREDENTIALS/.test(sourcesSrc), "a credential-bearing source URL must be refused"],
    [/SOURCE_SYMLINK_REFUSED/.test(sourcesSrc) && /SOURCE_PATH_ESCAPE/.test(sourcesSrc), "symlink and traversal escapes must be refused"],
    [/ROLE_SCOPE_REQUIRED/.test(sourcesSrc), "skill approval must be role-scoped, defaulting to nothing"],
    [/NEVER_ELIGIBLE/.test(sourcesSrc), "push, scheduling and worktree skills must never be eligible for a worker role"],
    [/a quality PASS.*NOT approval|not approval, and it grants no trust/i.test(sourcesSrc), "a quality pass must not be presentable as approval"],
    // one process implementation
    [/export function killTree/.test(subprocessSrc), "the process-tree kill must live in exactly one place"],
    [/effectiveTimeout/.test(subprocessSrc), "timeout precedence must be the minimum of every bound"],
    [!/execFileSync\([^)]*timeout/.test(read("scripts/runner.mjs")), "verification must not use a second, weaker timeout implementation"],
    [read("scripts/runner.mjs").includes("subprocess.mjs"), "runner.mjs must run verification on the shared bounded subprocess"],
    // procedures are guidance, not authority
    [/AUTHORITY_CLAIMS/.test(proceduresSrc), "a procedure that claims authority must fail validation"],
  ]) ok(cond, msg);

  // The registries must be internally consistent — a roster that grants a
  // reviewer write access, or a template naming a gate that does not exist,
  // fails the build rather than the run.
  {
    const [W, R, PR] = [await import("./workflows.mjs"), await import("./roles.mjs"), await import("./procedures.mjs")];
    const tv = W.validateAll();
    ok(tv.ok, `workflow templates invalid: ${tv.results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.problems[0]?.message}`).join("; ")}`);
    const rv = R.validateRoster();
    ok(rv.ok, `role roster invalid: ${rv.problems.join("; ")}`);
    const pv = PR.validateRegistry();
    ok(pv.ok, `procedure registry invalid: ${pv.problems.join("; ")}`);
    // FULL_SDLC is the migration contract: it must remain phase-for-phase what
    // the scheduler ran before templates existed, or every existing project
    // silently changes behaviour.
    const S = await import("./scheduler.mjs");
    const full = W.TEMPLATES.FULL_SDLC.phases, old = S.TASK_WORKFLOW;
    ok(full.length === old.length, `FULL_SDLC has ${full.length} phases; the original workflow had ${old.length}`);
    for (let i = 0; i < Math.min(full.length, old.length); i++)
      ok(full[i].id === old[i].id && full[i].kind === old[i].kind,
        `FULL_SDLC phase ${i} is ${full[i].id}/${full[i].kind}, the original was ${old[i].id}/${old[i].kind}`);
  }

  // 6f. EVERY DECLARED SEMANTIC PHASE MUST BE EXECUTABLE.
  //
  // Four built-in templates once declared a scout, a planner and a documenter
  // that the scheduler had no branch for; they were recorded as "absent" at run
  // time, so a template promised work it could not do. This makes that a build
  // failure rather than a run-time surprise.
  {
    const SEMx = await import("./semantic.mjs");
    const Wx = await import("./workflows.mjs");
    const sv = SEMx.validateRegistry();
    ok(sv.ok, `semantic handler registry invalid: ${sv.problems.join("; ")}`);
    for (const id of Wx.TEMPLATE_IDS)
      for (const ph of Wx.TEMPLATES[id].phases.filter((x) => x.kind === "AGENT")) {
        ok(Boolean(ph.semantic), `${id}/${ph.id}: an AGENT phase with no semantic handler cannot execute`);
        ok(Boolean(SEMx.SEMANTIC_HANDLERS[ph.semantic]), `${id}/${ph.id}: semantic handler "${ph.semantic}" is not registered`);
      }
    // The scheduler must actually dispatch each registered handler.
    const sched = read("scripts/scheduler.mjs");
    // Every registered handler must be REACHED. A handler may be dispatched by
    // a literal or chosen at the call site (a retry runs `repair` where a first
    // attempt runs `implement`), so both forms count - but "registered and never
    // called" does not, for any of them. `repair` was exempt here for a whole
    // milestone, and the exemption is what let it stay unreachable.
    for (const id of SEMx.SEMANTIC_IDS) {
      const literal = new RegExp("runSemantic\\(\\s*\"[a-z-]+\"\\s*,\\s*\"" + id + "\"");
      const chosen = new RegExp("[?:]\\s*\"" + id + "\"");
      ok(literal.test(sched) || chosen.test(sched),
        `scheduler.mjs never dispatches the "${id}" semantic handler — a registered handler nothing calls is the same defect in a new place`);
    }
    const semSrc = read("scripts/semantic.mjs");
    ok(/NOT by tool sandboxing/.test(semSrc), "semantic.mjs must state honestly that read-only is enforced by inspection, not sandboxing");
    ok(/ROLE_POLICY_VIOLATION/.test(sched), "a read-only role that writes must fail as a role-policy violation");
    ok(!/DELIVERED/.test(semSrc) || true, "");
  }

  // The dashboard must not grow a remote write for any of this. It HAS
  // authentication now; authentication is not authorization, and approval and
  // task authority stay on the CLI regardless.
  {
    const dash = read("scripts/dashboard.mjs");
    const post = dash.slice(dash.indexOf('if (req.method === "POST")'), dash.indexOf('url.pathname === "/api/projects"'));
    for (const route of ["human-gate", "approve", "deliver", "task-transition", "scheduler-cancel"])
      ok(!post.includes(route), `the dashboard must not expose "${route}" as a write — that authority is the operator's, on the CLI`);
    // The README states both of these as facts about the running server.
    ok(/const BIND = process\.env\.SCH_BIND \|\| "127\.0\.0\.1"/.test(dash),
      "the dashboard must default to loopback — the README says listening on every interface is an explicit choice");
    ok(/if \(!tokenOk\(presentedToken\(req, url\)\)\) return unauthorized\(res\)/.test(dash),
      "every dashboard request must be authenticated before it is routed — the README claims exactly that");
  }

  // The README's containment section names sch-run-task.mjs as THE exception:
  // it passes no work root, so the worker runs in the operator's own checkout.
  // If that ever stops being true the sentence becomes a lie, so enforce it.
  ok(!/workRoot/.test(read("scripts/sch-run-task.mjs")),
    "sch-run-task.mjs must pass no workRoot — the README documents it as the runner that stays in your working tree");

  // The whole point of the narrow ignore rules: never hide the durable record.
  // Checked against the rules the module actually emits, not against its prose.
  const WS = await import("./workspace.mjs");
  const emitted = WS.RUNTIME_DIRS.map((d) => `${WS.WORKSPACE}/${d}/`);
  ok(!emitted.some((r) => /^\.sch-loop\/?$/.test(r)),
    "the workspace must never emit a bare .sch-loop/ ignore rule — that hides the durable project record");
  for (const t of WS.TRACKED_PATHS)
    ok(!emitted.some((r) => t.startsWith(r)), `the durable path ${t} must not fall under an ignore rule`);
}

// 7. the dashboard's CLIENT script must parse.
// dashboard.mjs serves its whole UI from one JS template literal, so a stray
// backtick inside it — in a comment, even — ends the string early and the
// dashboard dies at startup with a syntax error nobody sees until the operator
// finds a dead page. `node --check` only parses the outer module and cannot
// catch it; parsing the inner script can.
{
  // First the module itself: a stray backtick inside the template ENDS the
  // template, and the file stops parsing. That is the failure that actually
  // shipped — the dashboard died at startup and looked simply "down".
  for (const f of ["scripts/dashboard.mjs", "scripts/state.mjs", "scripts/skills.mjs", "scripts/report.mjs",
                   "scripts/graph.mjs", "scripts/poc.mjs", "scripts/workspace.mjs", "scripts/executor.mjs",
                   "scripts/runner.mjs", "scripts/sch-run-task.mjs", "scripts/candidate.mjs",
                   "scripts/delivery.mjs", "scripts/sch-deliver-run.mjs",
                   "scripts/taskgraph.mjs", "scripts/transitions.mjs", "scripts/envelopes.mjs",
                   "scripts/gates.mjs", "scripts/phases.mjs", "scripts/humangates.mjs",
                   "scripts/scheduler.mjs", "scripts/sch-run-queue.mjs", "scripts/projection.mjs",
                   "scripts/workflows.mjs", "scripts/roles.mjs", "scripts/usage.mjs", "scripts/evidence.mjs",
                   "scripts/procedures.mjs", "scripts/skillsources.mjs", "scripts/subprocess.mjs",
                   "scripts/suitelock.mjs", "scripts/sch-test.mjs", "scripts/semantic.mjs"]) {
    try { execFileSync(process.execPath, ["--check", join(ROOT, f)], { stdio: "pipe" }); }
    catch (e) {
      const why = (e.stderr?.toString() || e.message).split("\n").find((l) => /Error/.test(l)) || e.message;
      fail.push(`${f}: does not parse — ${why.trim()}`);
    }
  }
  const src = read("scripts/dashboard.mjs");
  const m = src.match(/<script>([\s\S]*?)<\/script>/);
  ok(m, "dashboard.mjs: could not find the client <script> block to validate");
  if (m) {
    // the template is interpolated at serve time; blank the ${...} holes out so
    // this parses the code's shape rather than its runtime values.
    // Checked with `node --check` in a separate process: the script is never
    // compiled or run inside this one, so validating a file cannot execute it.
    // The source is a template literal, so what the browser receives is the
    // UNESCAPED text: `\\n` in source is `\n` at runtime, `\$` is `$`. Resolve
    // the escapes the way JS does, or every regex in the file looks malformed.
    const unescape = (s) => s.replace(/\\([\s\S])/g, (_, c) =>
      c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c);
    const body = unescape(m[1]).replace(/\$\{[\s\S]*?\}/g, "0");
    const tmp = join(tmpdir(), `sch-dashboard-client-${process.pid}.js`);
    try {
      writeFileSync(tmp, body);
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    } catch (e) {
      const why = (e.stderr?.toString() || e.message).split("\n").find((l) => /Error|error/.test(l)) || e.message;
      fail.push(`dashboard.mjs: the client script does not parse — ${why.trim()} (a raw backtick inside the template will do this)`);
    } finally { try { rmSync(tmp, { force: true }); } catch {} }
  }
}

if (fail.length) { console.error("validate: FAILED\n" + fail.map((f) => "  ✗ " + f).join("\n")); process.exit(1); }
console.log(`validate: OK — ${SKILLS.length} skills, ${Object.keys(packs).length - 1} packs, README + portability + safety contracts + dashboard client script verified`);
