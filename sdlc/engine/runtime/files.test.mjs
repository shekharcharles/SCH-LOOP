import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tree, readFile, langOf, isSecret, resolveInside, MAX_BYTES } from "./files.mjs";

const mk = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-files-"));
  const w = (rel, body) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
    return f;
  };
  return { root, w };
};

test("the tree lists work and skips machinery", () => {
  const { root, w } = mk();
  w("README.md", "# hi");
  w("src/app.js", "export const a = 1;\n");
  w("node_modules/left-pad/index.js", "nope");
  w(".git/config", "nope");
  const { entries } = tree(root);
  const paths = entries.map(e => e.path);
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("src/app.js"));
  assert.ok(paths.includes("src"));
  assert.equal(paths.some(p => p.startsWith("node_modules")), false, "node_modules is machinery");
  assert.equal(paths.some(p => p.startsWith(".git/")), false, ".git is machinery");
});

test("a credential is not listed and is not served", () => {
  const { root, w } = mk();
  w(".env", "TOKEN=hunter2");
  w("deploy/server.pem", "-----BEGIN PRIVATE KEY-----");
  w("ok.txt", "fine");
  const paths = tree(root).entries.map(e => e.path);
  assert.deepEqual(paths.filter(p => p !== "deploy" && p !== "ok.txt"), [], "no credential appears in the tree");
  for (const bad of [".env", "deploy/server.pem"]) {
    assert.throws(() => readFile(root, bad), /credential/, `${bad} must not be served`);
  }
  assert.equal(readFile(root, "ok.txt").text, "fine");
});

test("nothing outside the project is readable, whatever the path says", () => {
  const { root, w } = mk();
  w("in.txt", "inside");
  const outside = path.join(root, "..", "sch-outside-probe.txt");
  fs.writeFileSync(outside, "secret neighbour");
  try {
    for (const esc of ["../sch-outside-probe.txt", "..\\sch-outside-probe.txt",
                       "src/../../sch-outside-probe.txt", path.resolve(outside)]) {
      assert.throws(() => readFile(root, esc), /outside the project/, `escaped with ${esc}`);
    }
    assert.equal(readFile(root, "in.txt").text, "inside");
  } finally { fs.rmSync(outside, { force: true }); }
});

test("a symlink pointing out of the project is still out of the project", { skip: process.platform === "win32" && !process.env.CI }, () => {
  const { root } = mk();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sch-elsewhere-"));
  fs.writeFileSync(path.join(outside, "keys.txt"), "not yours");
  try { fs.symlinkSync(outside, path.join(root, "link")); } catch { return; }  // no symlink privilege
  assert.throws(() => resolveInside(root, "link/keys.txt"), /outside the project/);
});

test("a file too big to read says so instead of shipping a megabyte", () => {
  const { root, w } = mk();
  w("big.log", "x".repeat(MAX_BYTES + 10));
  const r = readFile(root, "big.log");
  assert.equal(r.truncated, true);
  assert.equal(r.text, "");
  assert.match(r.why, /past the/);
});

test("a binary file is reported, not rendered as mojibake", () => {
  const { root } = mk();
  fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  const r = readFile(root, "logo.png");
  assert.equal(r.lang, "binary");
  assert.equal(r.text, "");
});

test("the language is the file's, not a guess made in the page", () => {
  assert.equal(langOf("docs/PLAN.md"), "markdown");
  assert.equal(langOf("runtime/build.mjs"), "javascript");
  assert.equal(langOf("tools/scan.py"), "python");
  assert.equal(langOf("Dockerfile"), "shell");
  assert.equal(langOf("data.json"), "json");
  assert.equal(langOf("notes"), "text");
});

test("isSecret is about the shape of a name, not where it sits", () => {
  for (const p of [".env", "app/.env.production", "certs/site.key", "x/id_rsa", "conf/secrets.yaml"])
    assert.equal(isSecret(p), true, p);
  for (const p of ["README.md", "src/keyboard.js", "environment.md"])
    assert.equal(isSecret(p), false, p);
});

test("CRLF is normalised so the viewer never draws a blank line between every line", () => {
  const { root, w } = mk();
  w("win.md", "# one\r\n\r\ntwo\r\n");
  assert.equal(readFile(root, "win.md").text, "# one\n\ntwo\n");
});
