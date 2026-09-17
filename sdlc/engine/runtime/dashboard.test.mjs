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
    assert.match(page.body, /<title>SCH·LOOP<\/title>/);
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
  const src = fs.readFileSync(new URL("./dashboard-page.mjs", import.meta.url), "utf8");
  const page = src.slice(src.indexOf("const PAGE = "));
  const inner = page.slice(page.indexOf("`") + 1, page.lastIndexOf("`"));
  assert.equal(inner.includes("`"), false, "a backtick inside PAGE ends the literal early");
});

test("a seat set to a CLI that is not installed still names that CLI in the page", () => {
  // The dropdown used to list only installed CLIs, so a seat configured for an absent one fell back to
  // displaying the first option: the critic seat read "claude" while its argv said antigravity.
  const src = fs.readFileSync(new URL("./dashboard-page.mjs", import.meta.url), "utf8");
  assert.match(src, /function providerOptions\(cur\)/);
  assert.match(src, /\[\.\.\.new Set\(\[\.\.\.installed\(\),cur\]/, "the current provider is always an option");
  assert.match(src, /not installed/, "and an absent one says so rather than being hidden");
});

test("the page is in the SCH-LOOP console language, not a default one", () => {
  // The look is part of the product: near-black ground, red as the structural accent, terminal green
  // for live-and-good, monospace throughout. It was rebuilt once from scratch in a generic style
  // because nobody had written the palette down anywhere a test could see it.
  const src = fs.readFileSync(new URL("./dashboard-page.mjs", import.meta.url), "utf8");
  for (const token of ["--ground:#0a0a0a", "--panel:#121212", "--rule:#282828", "--ink:#eaeaea", "--brand:#ff2a2a", "--live:#4af626"]) {
    assert.ok(src.includes(token), `the console palette lost ${token}`);
  }
  assert.match(src, /ui-monospace/, "the language is monospace");
  assert.match(src, /Archivo Black/, "and its wordmark is Archivo Black");
  assert.match(src, /repeating-linear-gradient\(0deg/, "the scanline overlay is part of it");
  assert.match(src, /border-bottom:2px solid var\(--brand\)/, "red is structure, not decoration");

  // Light mode is a first-class ground, not an inversion: it follows the system and an explicit
  // choice wins over it.
  assert.match(src, /prefers-color-scheme:light/, "a paper ground exists");
  assert.match(src, /:root\[data-theme="light"\]/, "and an explicit choice overrides the system");
  assert.match(src, /localStorage/, "and is remembered");

  // Product UI is read at a consistent DPI. A heading that shrinks in a narrow column is worse at
  // both ends, so the type scale is fixed rem, never clamp().
  assert.doesNotMatch(src, /font-size:\s*clamp\(/, "type is a fixed scale, not fluid");
  // Colour alone cannot carry state: every state ships a drawn mark beside the word.
  assert.match(src, /const MARK=\{/, "states are drawn marks");
  assert.doesNotMatch(src, /innerHTML\s*=/, "no markup sink on the page");
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

test("the page's own script parses — the module compiling proves nothing about it", async () => {
  // The page is a string inside a module. `node --check` on the module is happy with any syntax error
  // living in that string, so a missing paren shipped a blank dashboard that only a browser console
  // reported. Compile the script the way the browser will.
  const { PAGE } = await import("./dashboard-page.mjs");
  const i = PAGE.indexOf("<script>"), j = PAGE.lastIndexOf("</script>");
  assert.ok(i > 0 && j > i, "the page has a script block");
  assert.doesNotThrow(() => new Function(PAGE.slice(i + 8, j)), "the page script must compile");
});

test("the page is one self-contained document with no runtime dependency but fonts", async () => {
  const { PAGE } = await import("./dashboard-page.mjs");
  const remote = [...PAGE.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map(m => m[1]);
  for (const u of remote) assert.match(u, /^https:\/\/fonts\.(googleapis|gstatic)\.com(\/|$)/, `unexpected remote asset: ${u}`);
  assert.doesNotMatch(PAGE, /<script[^>]+src=/, "no external script");
});

test("a span given a height also declares display — an inline box ignores both", async () => {
  // The progress meter and the skeleton bars are spans with a height and nothing else. An inline box
  // drops height and width silently, so the page rendered a blank track at every percentage and a
  // skeleton of invisible rows. Nothing threw; it just looked finished and was not.
  const { PAGE } = await import("./dashboard-page.mjs");
  const css = PAGE.slice(PAGE.indexOf("<style>"), PAGE.indexOf("</style>"));
  for (const sel of [".meter .fill", ".sk"]) {
    const rule = css.slice(css.indexOf(sel + "{"));
    assert.match(rule.slice(0, rule.indexOf("}")), /display:block/, `${sel} must be a block to have a height`);
  }
});

test("a fixed bar that a class shows must have a rule that the hidden attribute wins", async () => {
  // `display:flex` on the class beats the user agent's `[hidden]{display:none}`, so the settings
  // action bar sat at the bottom of the home page offering to save something home cannot save.
  const { PAGE } = await import("./dashboard-page.mjs");
  assert.match(PAGE, /\.bar\[hidden\]\{display:none\}/, "the bar must honour its own hidden attribute");
});

test("a duration never prints a sixtieth minute", async () => {
  const { PAGE } = await import("./dashboard-page.mjs");
  const src = PAGE.slice(PAGE.indexOf("const dur="));
  const dur = new Function("return " + src.slice(src.indexOf("=") + 1, src.indexOf("};") + 1))();
  assert.equal(dur(5 * 36e5 + 59.6 * 6e4), "6h00", "5h59m36s carries into the hour, it is not 5h60");
  assert.equal(dur(36e5 + 6e4), "1h01");
  assert.equal(dur(50 * 6e4), "50m");
  assert.equal(dur(null), "—");
});

test("a project's files are served, and nothing else is", async () => {
  // The viewer is the reason to open a project at all — and the one place a local server hands a file
  // over because a query string asked for it. Both halves are tested together: what it serves, and
  // what it refuses however the path is spelled.
  const root = proj();
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n\ntext\n");
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=hunter2\n");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sch-ghome-"));
  const prev = process.env.SCH_GLOBAL_HOME;
  process.env.SCH_GLOBAL_HOME = home;
  let server = null;
  try {
    const { registerProject, idFor } = await import("./registry.mjs");
    registerProject(root, { name: "demo" });
    const id = idFor(root);
    server = await listen(createServer());

    const tree = await get(server, "/api/files/" + encodeURIComponent(id));
    assert.equal(tree.status, 200);
    const paths = tree.body.entries.map(e => e.path);
    assert.ok(paths.includes("README.md"), "the project's own files are listed");
    assert.equal(paths.includes(".env"), false, "a credential is never listed");

    const file = await get(server, "/api/file/" + encodeURIComponent(id) + "?path=README.md");
    assert.equal(file.status, 200);
    assert.equal(file.body.lang, "markdown");
    assert.match(file.body.text, /# demo/);

    for (const bad of ["../../../etc/passwd", "..%2F..%2Fsecret.txt", ".env"]) {
      const r = await get(server, "/api/file/" + encodeURIComponent(id) + "?path=" + encodeURIComponent(bad));
      assert.equal(r.status, 400, `${bad} must be refused`);
    }
    assert.equal((await get(server, "/api/files/not-a-project")).status, 404);
  } finally {
    if (server) server.close();
    if (prev === undefined) delete process.env.SCH_GLOBAL_HOME; else process.env.SCH_GLOBAL_HOME = prev;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the page builds every node itself — file content never becomes markup", async () => {
  // The viewer renders files the page did not write. One innerHTML anywhere in it turns a markdown
  // document into a script the operator's browser runs on localhost.
  const { PAGE } = await import("./dashboard-page.mjs");
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("])
    assert.equal(PAGE.includes(sink), false, `the page must not use ${sink}`);
});
