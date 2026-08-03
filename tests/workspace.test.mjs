// The canonical per-project `.sch-loop/` workspace: initialization, the
// manifest, what is tracked vs ignored, and every containment escape it refuses.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { fixture, git, WS, ROOT } from "./helpers.mjs";

test("workspace: init creates the canonical directory and a versioned manifest", () => {
  const fx = fixture("ws-init");
  const r = JSON.parse(fx.cli("workspace-init", "--project", fx.P));
  assert.equal(r.workspace, join(WS.real(fx.repo), ".sch-loop"), "exactly .sch-loop, lowercase, at the repository root");
  assert.equal(r.created, true);
  assert.equal(r.manifest.schema_version, WS.MANIFEST_SCHEMA_VERSION);
  assert.equal(r.manifest.project_id, fx.P);
  // Portable: a machine-specific absolute path must never enter tracked metadata.
  assert.equal(r.manifest.repository_root, ".");
  const text = readFileSync(join(fx.repo, ".sch-loop", "project.yaml"), "utf8");
  assert.match(text, /^schema_version: 1$/m);
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]|^\/(home|Users|tmp)/m, "no absolute path in the manifest");
  for (const d of WS.INIT_DIRS) assert.ok(existsSync(join(fx.repo, ".sch-loop", d)), d);
  fx.done();
});

test("workspace: init is idempotent and preserves existing planning files", () => {
  const fx = fixture("ws-idem");
  fx.cli("workspace-init", "--project", fx.P);
  const before = readFileSync(join(fx.repo, ".sch-loop", "project.yaml"), "utf8").match(/created_at: (\S+)/)[1];
  writeFileSync(join(fx.repo, ".sch-loop", "SPEC.md"), "# my spec\nhand-written\n");
  mkdirSync(join(fx.repo, ".sch-loop", "decisions"), { recursive: true });
  writeFileSync(join(fx.repo, ".sch-loop", "decisions", "0001.md"), "decided\n");

  const second = JSON.parse(fx.cli("workspace-init", "--project", fx.P));
  assert.equal(second.created, false, "a second init is not a fresh creation");
  assert.equal(readFileSync(join(fx.repo, ".sch-loop", "SPEC.md"), "utf8"), "# my spec\nhand-written\n");
  assert.equal(readFileSync(join(fx.repo, ".sch-loop", "decisions", "0001.md"), "utf8"), "decided\n");
  assert.equal(readFileSync(join(fx.repo, ".sch-loop", "project.yaml"), "utf8").match(/created_at: (\S+)/)[1], before,
    "created_at survives re-init");
  fx.done();
});

test("workspace: runtime paths are ignored, the durable record is NOT", () => {
  const fx = fixture("ws-ignore");
  fx.cli("workspace-init", "--project", fx.P);
  const gi = readFileSync(join(fx.repo, ".gitignore"), "utf8");
  for (const d of WS.RUNTIME_DIRS) assert.match(gi, new RegExp(`^\\.sch-loop/${d}/$`, "m"), d);
  assert.doesNotMatch(gi, /^\.sch-loop\/?$/m, "the whole workspace must never be ignored");

  // git itself is the proof, not the text of the file
  git(fx.repo, "add", "-A"); git(fx.repo, "commit", "-q", "-m", "ws");
  mkdirSync(join(fx.repo, ".sch-loop", "runs", "RUN-x"), { recursive: true });
  writeFileSync(join(fx.repo, ".sch-loop", "runs", "RUN-x", "stdout.log"), "secret worker output");
  mkdirSync(join(fx.repo, ".sch-loop", "handoffs", "1"), { recursive: true });
  writeFileSync(join(fx.repo, ".sch-loop", "handoffs", "1", "RUN-x.md"), "# handoff");
  const status = git(fx.repo, "status", "--porcelain", "--untracked-files=all");
  assert.doesNotMatch(status, /runs\/RUN-x/, "run evidence is ignored");
  assert.match(status, /handoffs\/1\/RUN-x\.md/, "a handoff is trackable");
  assert.ok(git(fx.repo, "ls-files").includes(".sch-loop/project.yaml"), "the manifest is tracked");
  fx.done();
});

test("workspace: a second init on an existing .gitignore does not duplicate rules", () => {
  const fx = fixture("ws-ignore2");
  fx.cli("workspace-init", "--project", fx.P);
  fx.cli("workspace-init", "--project", fx.P);
  const gi = readFileSync(join(fx.repo, ".gitignore"), "utf8");
  assert.equal(gi.split("\n").filter((l) => l.trim() === ".sch-loop/runs/").length, 1);
  fx.done();
});

test("workspace: a .sch-loop symlink is refused", { skip: symlinkSupported() ? false : "symlinks need privileges here" }, () => {
  const fx = fixture("ws-symlink");
  const outside = join(fx.home, "outside-workspace");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(fx.repo, ".sch-loop"), "junction");
  assert.throws(() => fx.cli("workspace-init", "--project", fx.P), /symlink or junction/i);
  assert.ok(!existsSync(join(outside, "project.yaml")), "nothing was written through the link");
  fx.done();
});

test("workspace: a file at .sch-loop is refused", () => {
  const fx = fixture("ws-file");
  writeFileSync(join(fx.repo, ".sch-loop"), "not a directory");
  assert.throws(() => fx.cli("workspace-init", "--project", fx.P), /not a directory/i);
  fx.done();
});

test("workspace: a manifest belonging to another project is refused", () => {
  const fx = fixture("ws-conflict");
  mkdirSync(join(fx.repo, ".sch-loop"), { recursive: true });
  writeFileSync(join(fx.repo, ".sch-loop", "project.yaml"),
    "schema_version: 1\nproject_id: someone-else\nrepository_root: .\ncreated_at: x\nupdated_at: x\n");
  assert.throws(() => fx.cli("workspace-init", "--project", fx.P), /belongs to project "someone-else"/);
  assert.match(readFileSync(join(fx.repo, ".sch-loop", "project.yaml"), "utf8"), /someone-else/, "not taken over");
  fx.done();
});

test("workspace: a manifest from a newer schema is refused", () => {
  const fx = fixture("ws-schema");
  mkdirSync(join(fx.repo, ".sch-loop"), { recursive: true });
  writeFileSync(join(fx.repo, ".sch-loop", "project.yaml"),
    `schema_version: 99\nproject_id: ${fx.P}\nrepository_root: .\n`);
  assert.throws(() => fx.cli("workspace-init", "--project", fx.P), /newer than this SCH build/);
  const v = WS.validateWorkspace({ projectId: fx.P, repoPath: fx.repo });
  assert.equal(v.ok, false);
  assert.match(v.problems[0].message, /unsupported schema_version/);
  fx.done();
});

test("workspace: validate rejects a manifest declaring another project", () => {
  const fx = fixture("ws-val");
  fx.cli("workspace-init", "--project", fx.P);
  writeFileSync(join(fx.repo, ".sch-loop", "project.yaml"),
    "schema_version: 1\nproject_id: other\nrepository_root: .\n");
  const v = WS.validateWorkspace({ projectId: fx.P, repoPath: fx.repo });
  assert.equal(v.ok, false);
  assert.match(v.problems.map((p) => p.message).join(" "), /declares project "other"/);
  fx.done();
});

test("workspace: a non-git folder, and a subdirectory of a repository, are both refused", () => {
  const fx = fixture("ws-nogit");
  const plain = join(fx.home, "plain");
  mkdirSync(plain, { recursive: true });
  assert.throws(() => WS.initWorkspace({ projectId: fx.P, repoPath: plain }), /not a git repository/);
  assert.throws(() => WS.initWorkspace({ projectId: fx.P, repoPath: join(fx.repo, "src") }),
    /repository root is/, "a subdirectory is not the root");
  assert.ok(!existsSync(join(fx.repo, "src", ".sch-loop")));
  fx.done();
});

test("workspace: nothing user-global is written", () => {
  const fx = fixture("ws-global");
  const settings = join(homedir(), ".claude", "settings.json");
  const before = existsSync(settings) ? statSync(settings).mtimeMs : null;
  fx.cli("workspace-init", "--project", fx.P);
  const after = existsSync(settings) ? statSync(settings).mtimeMs : null;
  assert.equal(after, before, "~/.claude/settings.json must not be touched");
  fx.done();
});

test("workspace: safeRelative refuses absolute paths, traversal and link escapes", () => {
  const fx = fixture("ws-safe");
  assert.equal(WS.safeRelative(fx.repo, "src/app.js"), "src/app.js");
  assert.equal(WS.safeRelative(fx.repo, "./src/app.js"), "src/app.js");
  assert.equal(WS.safeRelative(fx.repo, "src\\app.js"), "src/app.js");
  assert.equal(WS.safeRelative(fx.repo, "/etc/passwd"), null);
  assert.equal(WS.safeRelative(fx.repo, "C:\\Windows\\system32"), null);
  assert.equal(WS.safeRelative(fx.repo, "../outside.txt"), null);
  assert.equal(WS.safeRelative(fx.repo, "src/../../outside.txt"), null);
  assert.equal(WS.safeRelative(fx.repo, "\\\\server\\share"), null);
  if (symlinkSupported()) {
    const outside = join(fx.home, "escape-target");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "loot.txt"), "x");
    try {
      symlinkSync(outside, join(fx.repo, "linked"), "junction");
      assert.equal(WS.safeRelative(fx.repo, "linked/loot.txt"), null, "a link out of the repository is an escape");
    } catch { /* privileges */ }
  }
  fx.done();
});

test("workspace: contains() is case-correct for this platform", () => {
  const base = process.platform === "win32" ? "D:\\repo" : "/repo";
  assert.equal(WS.contains(base, join(base, "src", "a.js")), true);
  assert.equal(WS.contains(base, base), true);
  assert.equal(WS.contains(base, process.platform === "win32" ? "D:\\repo-other\\a" : "/repo-other/a"), false);
  if (process.platform === "win32") assert.equal(WS.contains("D:\\Repo", "d:\\repo\\src"), true);
});

function symlinkSupported() {
  try {
    const probe = join(process.env.TEMP || process.env.TMPDIR || "/tmp", `sch-symlink-probe-${process.pid}`);
    mkdirSync(probe + "-target", { recursive: true });
    symlinkSync(probe + "-target", probe, "junction");
    rmSync(probe, { recursive: true, force: true }); rmSync(probe + "-target", { recursive: true, force: true });
    return true;
  } catch { return false; }
}

// The engine's own commands stay wired.
test("workspace: workspace-status reports a missing workspace precisely", () => {
  const fx = fixture("ws-status");
  const r = JSON.parse(fx.cli("workspace-status", "--project", fx.P));
  assert.equal(r.ok, false);
  assert.match(r.problems[0].message, /workspace-init/, "the fix is in the message");
  assert.ok(!existsSync(join(fx.repo, ".sch-loop")), "status never creates anything");
  execFileSync("node", [join(ROOT, "scripts", "state.mjs"), "workspace-init", "--project", fx.P],
    { env: { ...process.env, SCH_HOME: fx.home }, stdio: "pipe" });
  assert.equal(JSON.parse(fx.cli("workspace-status", "--project", fx.P)).ok, true);
  fx.done();
});
