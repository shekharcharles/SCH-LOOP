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

test("the server serves the page, the state, and refuses a bad POST with a reason", async () => {
  const root = proj();
  const server = await listen(createServer(root));
  try {
    const page = await get(server, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /SCH·LOOP \/\/ ROLES/);

    const st = await get(server, "/api/state");
    assert.equal(st.status, 200);
    assert.ok(Array.isArray(st.body.seats), "it reports which CLIs are installed");
    assert.ok(st.body.presets.claude, "and the flag presets the page toggles");
    for (const r of ROLE_SEATS) assert.ok(typeof st.body.resolved[r] === "string", `${r} shows the argv it would spawn`);

    const bad = good(); bad.reviewer.spawn = [...BYPASS];
    const rejected = await get(server, "/api/roles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bad) });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /read-only/);

    const ok = good(); ok.executor.model = "sonnet";
    const saved = await get(server, "/api/roles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ok) });
    assert.equal(saved.status, 200);
    assert.equal(readRoles(root).executor.model, "sonnet", "and a good one reaches disk");
  } finally { server.close(); }
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
