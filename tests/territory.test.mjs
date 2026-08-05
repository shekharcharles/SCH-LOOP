// Detection, not prevention.
//
// A worker runs as the operator, so nothing here stops it writing where it
// likes. What these tests pin is that when it writes into SCH's own territory —
// the main repository, a sibling task's checkout — the run says so afterwards
// rather than reporting a clean bill of health.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixture, ROOT, url } from "./helpers.mjs";

const T = await import(url(join(ROOT, "scripts", "territory.mjs")));

test("an unchanged directory fingerprints the same twice", () => {
  const fx = fixture("terr-same");
  try {
    const a = T.fingerprint(fx.repo);
    const b = T.fingerprint(fx.repo);
    assert.equal(a.ok, true);
    assert.equal(a.hash, b.hash);
    assert.equal(T.compare(a, b).same, true);
  } finally { fx.done(); }
});

test("a new file changes the fingerprint and is named", () => {
  const fx = fixture("terr-added");
  try {
    const before = T.fingerprint(fx.repo);
    writeFileSync(join(fx.repo, "src", "intruder.js"), "// written from elsewhere\n");
    const after = T.fingerprint(fx.repo);
    const d = T.compare(before, after);
    assert.equal(d.same, false);
    assert.ok(d.added.some((p) => p.endsWith("intruder.js")), JSON.stringify(d.added));
  } finally { fx.done(); }
});

test("a modified file is detected even at the same size", () => {
  const fx = fixture("terr-modified");
  try {
    const f = join(fx.repo, "src", "app.js");
    writeFileSync(f, "// aaaa\n");
    const before = T.fingerprint(fx.repo);
    writeFileSync(f, "// bbbb\n");                     // same byte count
    const after = T.fingerprint(fx.repo);
    const d = T.compare(before, after);
    assert.equal(d.same, false, "a same-size edit must still be visible");
    assert.ok(d.changed.some((p) => p.endsWith("app.js")), JSON.stringify(d));
  } finally { fx.done(); }
});

test("excluded directories are not watched, and say so", () => {
  const fx = fixture("terr-exclude");
  try {
    mkdirSync(join(fx.repo, ".sch-loop", "runs"), { recursive: true });
    const before = T.fingerprint(fx.repo, { exclude: [".sch-loop", ".git"] });
    writeFileSync(join(fx.repo, ".sch-loop", "runs", "evidence.json"), "{}");
    const after = T.fingerprint(fx.repo, { exclude: [".sch-loop", ".git"] });
    assert.equal(T.compare(before, after).same, true,
      "SCH writing its own evidence must not look like a worker escaping");
    assert.deepEqual(before.excluded, [".sch-loop", ".git"],
      "what was NOT watched has to be on the record");
  } finally { fx.done(); }
});

test("a walk that hits its limit reports truncation instead of a clean result", () => {
  const fx = fixture("terr-truncated");
  try {
    for (let i = 0; i < 12; i++) writeFileSync(join(fx.repo, "src", `f${i}.js`), String(i));
    const fp = T.fingerprint(fx.repo, { maxEntries: 5 });
    assert.equal(fp.truncated, true, "a bounded walk must admit when it stopped early");
    assert.ok(fp.entries <= 5);
  } finally { fx.done(); }
});

test("comparing two truncated fingerprints is INCONCLUSIVE, never 'same'", () => {
  const fx = fixture("terr-inconclusive");
  try {
    for (let i = 0; i < 12; i++) writeFileSync(join(fx.repo, "src", `g${i}.js`), String(i));
    const before = T.fingerprint(fx.repo, { maxEntries: 5 });
    const after = T.fingerprint(fx.repo, { maxEntries: 5 });
    const d = T.compare(before, after);
    assert.equal(d.inconclusive, true,
      "a check that could not see everything must not report everything is fine");
    assert.notEqual(d.same, true);
  } finally { fx.done(); }
});

test("a directory that does not exist is reported, not treated as empty", () => {
  const fx = fixture("terr-missing");
  try {
    const fp = T.fingerprint(join(fx.repo, "nowhere"));
    assert.equal(fp.ok, false);
    assert.match(fp.why ?? "", /does not exist|ENOENT/i);
  } finally { fx.done(); }
});
