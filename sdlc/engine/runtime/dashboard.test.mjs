// The Roles page is the answer to "nothing hard-coded": which CLI, which model, which flags, per seat.
// It must not be able to write a configuration that buildTicket will then refuse to run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateRoles, saveRoles, readRoles, createServer, ROLE_SEATS } from "./dashboard.mjs";

const BYPASS = ["claude", "--dangerously-skip-permissions", "-p"];
const READ_ONLY = ["claude", "--dangerously-skip-permissions", "--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit", "-p"];
const good = () => ({
  executor: { provider: "claude", model: null, spawn: [...BYPASS] },
  reviewer: { provider: "claude", model: null, spawn: [...READ_ONLY] },
  judge: { provider: "claude", model: null, spawn: [...READ_ONLY] },
  council: [{ role: "architect", provider: "claude", model: null, spawn: [...READ_ONLY], enabled: true }],
});
function proj(roles = good()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-dash-"));
  fs.mkdirSync(path.join(root, ".sch-loop"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sch-loop", "roles.json"), JSON.stringify(roles, null, 2));
  return root;
}
const get = async (server, url, init) => {
  const { port } = server.address();
  const r = await fetch(`http://127.0.0.1:${port}${url}`, init);
  return { status: r.status, body: r.headers.get("content-type").includes("json") ? await r.json() : await r.text() };
};
const listen = server => new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));

test("a valid configuration saves", () => {
  const root = proj();
  const roles = good();
  roles.executor.model = "opus";
  saveRoles(root, roles);
  assert.equal(readRoles(root).executor.model, "opus");
});

test("the page cannot save a reviewer or judge that is able to write", () => {
  for (const seat of ["reviewer", "judge"]) {
    const roles = good();
    roles[seat].spawn = [...BYPASS];
    const errs = validateRoles(roles);
    assert.ok(errs.some(e => e.includes(seat) && /read-only/.test(e)), `${seat}: ${errs.join("; ")}`);
    assert.throws(() => saveRoles(proj(), roles), /read-only/);
  }
});

test("a codex read-only sandbox counts as read-only too", () => {
  const roles = good();
  roles.reviewer = { provider: "codex", model: null, spawn: ["codex", "exec", "--sandbox", "read-only"] };
  roles.judge = { provider: "codex", model: null, spawn: ["codex", "exec", "--sandbox", "read-only"] };
  assert.deepEqual(validateRoles(roles), []);
});

test("an empty or missing spawn is refused — an unspawnable seat is not a configuration", () => {
  for (const mutate of [r => { r.executor.spawn = []; }, r => { delete r.executor; }, r => { r.executor.spawn = "claude -p"; }]) {
    const roles = good(); mutate(roles);
    assert.ok(validateRoles(roles).some(e => e.startsWith("executor")), JSON.stringify(validateRoles(roles)));
  }
});

test("a council seat needs a role and an argv", () => {
  const roles = good();
  roles.council = [{ provider: "claude", spawn: [...READ_ONLY] }, { role: "skeptic", provider: "codex", spawn: [] }];
  const errs = validateRoles(roles);
  assert.ok(errs.some(e => /council\[0\]\.role/.test(e)));
  assert.ok(errs.some(e => /council\[1\]\.spawn/.test(e)));
});

test("a rejected save leaves the file exactly as it was", () => {
  const root = proj();
  const before = fs.readFileSync(path.join(root, ".sch-loop", "roles.json"), "utf8");
  const roles = good();
  roles.judge.spawn = [...BYPASS];
  assert.throws(() => saveRoles(root, roles));
  assert.equal(fs.readFileSync(path.join(root, ".sch-loop", "roles.json"), "utf8"), before);
});

test("one server, three views: projects, a project, and the global defaults", async () => {
  const root = proj();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sch-ghome-"));
  const prev = process.env.SCH_GLOBAL_HOME;
  process.env.SCH_GLOBAL_HOME = home;
  let server = null;
  try {
    const { registerProject, saveGlobalRoles, idFor } = await import("./registry.mjs");
    saveGlobalRoles(good());
    registerProject(root, { name: "demo" });
    server = await listen(createServer());

    const page = await get(server, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /SCH·LOOP \/\/ OPS/);
    assert.equal((await get(server, "/p/anything")).status, 200, "a project URL serves the same page");
    assert.equal((await get(server, "/settings")).status, 200);

    const h = await get(server, "/api/home");
    assert.equal(h.status, 200);
    assert.ok(h.body.projects.some(p => p.root === path.resolve(root)), "the registered project is listed");
    assert.ok(Array.isArray(h.body.seats));

    const st = await get(server, "/api/settings");
    assert.equal(st.status, 200);
    assert.ok(st.body.roles.executor, "the global defaults are served");
    assert.ok(st.body.presets.claude);

    const id = idFor(root);
    const pj = await get(server, "/api/project/" + encodeURIComponent(id));
    assert.equal(pj.status, 200);
    assert.equal(pj.body.project.name, "demo");
    for (const r of ROLE_SEATS) assert.ok(typeof pj.body.resolved[r] === "string", r + " shows the argv it would spawn");

    assert.equal((await get(server, "/api/project/nope")).status, 404);

    const bad = good(); bad.reviewer.spawn = [...BYPASS];
    const rejected = await get(server, "/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bad) });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /read-only/);

    const ok = good(); ok.executor.model = "sonnet";
    const saved = await get(server, "/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ok) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.roles.executor.model, "sonnet", "and a good one reaches disk");

  } finally {
    server?.close();
    if (prev === undefined) delete process.env.SCH_GLOBAL_HOME; else process.env.SCH_GLOBAL_HOME = prev;
  }
});

test("an unknown path is a 404, not a stack trace", async () => {
  const server = await listen(createServer(proj()));
  try {
    const r = await get(server, "/api/../../etc/passwd");
    assert.equal(r.status, 404);
  } finally { server.close(); }
});

test("the page template holds no backtick — it is a template literal, and one breaks the module", () => {
  // Twice now a comment written into this literal contained a backtick and turned the rest of the file
  // into a syntax error that surfaced as an unrelated test failing to load.
  const src = fs.readFileSync(new URL("./dashboard.mjs", import.meta.url), "utf8");
  const page = src.slice(src.indexOf("const PAGE = "));
  const inner = page.slice(page.indexOf("`") + 1, page.lastIndexOf("`"));
  assert.equal(inner.includes("`"), false, "a backtick inside PAGE ends the literal early");
});

test("a seat set to a CLI that is not installed still names that CLI in the page", () => {
  // The dropdown used to list only installed CLIs, so a seat configured for an absent one fell back to
  // displaying the first option: the critic seat read "claude" while its argv said antigravity.
  const src = fs.readFileSync(new URL("./dashboard.mjs", import.meta.url), "utf8");
  assert.match(src, /function providerOptions\(current\)/);
  assert.match(src, /\[\.\.\.new Set\(\[\.\.\.installed\(\), current\]/, "the current provider is always an option");
  assert.doesNotMatch(src, /installed\(\)\.map\(p => el\("option"/, "no dropdown is built from the installed list alone");
});

test("the page is in the SCH-LOOP console language, not a default one", () => {
  // The look is part of the product: near-black ground, red as the structural accent, terminal green
  // for live-and-good, monospace throughout. It was rebuilt once from scratch in a generic style
  // because nobody had written the palette down anywhere a test could see it.
  const src = fs.readFileSync(new URL("./dashboard.mjs", import.meta.url), "utf8");
  for (const token of ["--bg:#0a0a0a", "--panel:#121212", "--line:#282828", "--fg:#eaeaea", "--red:#ff2a2a", "--green:#4af626"]) {
    assert.ok(src.includes(token), `the console palette lost ${token}`);
  }
  assert.match(src, /ui-monospace/, "the language is monospace");
  assert.match(src, /Archivo Black/, "and its headings are Archivo Black");
  assert.match(src, /repeating-linear-gradient\(0deg/, "the scanline overlay is part of it");
  assert.match(src, /border-bottom:2px solid var\(--red\)/, "red is structure, not decoration");
  assert.doesNotMatch(src, /prefers-color-scheme/, "there is one theme and it is dark");
});

test("a scratch directory is never registered, and old ones are pruned", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sch-ghome-"));
  const prev = process.env.SCH_GLOBAL_HOME;
  process.env.SCH_GLOBAL_HOME = home;
  try {
    const { registerProject, listProjects, isScratch, rejects, projectsFile } = await import("./registry.mjs");
    // A temp directory is a test fixture. Registering one is how fourteen throwaway projects ended up
    // on a real operator's dashboard.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sch-scratch-"));
    fs.mkdirSync(path.join(scratch, ".sch-loop"), { recursive: true });
    assert.equal(isScratch(scratch), true);
    // The guard protects the DEFAULT registry, which is the one an operator looks at.
    const prevHome = process.env.SCH_GLOBAL_HOME;
    delete process.env.SCH_GLOBAL_HOME;
    let r;
    try { r = registerProject(scratch); } finally { process.env.SCH_GLOBAL_HOME = prevHome; }
    assert.equal(r.skipped, "scratch directory");
    assert.equal(listProjects().length, 0, "it never reaches the register");

    // One that slipped in before the rule existed is pruned by the same rule, not a second one: the
    // guard and the pruner used to decide separately, so a project one accepted the other deleted.
    fs.writeFileSync(projectsFile(), JSON.stringify([{ id: "x", root: scratch, name: "old" }], null, 2));
    assert.equal(listProjects().length, 1);
    const before = process.env.SCH_GLOBAL_HOME;
    let pruned;
    try { delete process.env.SCH_GLOBAL_HOME; pruned = rejects(scratch); } finally { process.env.SCH_GLOBAL_HOME = before; }
    assert.equal(pruned, true, "the pruner and the guard share one rule");
    assert.equal(rejects(scratch), false, "and it is off when the registry is already isolated");
  } finally { if (prev === undefined) delete process.env.SCH_GLOBAL_HOME; else process.env.SCH_GLOBAL_HOME = prev; }
});
