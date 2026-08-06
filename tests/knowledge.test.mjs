// Automatic knowledge ingestion: a project's own durable documents become a
// bounded, hashed index, and a task draws a few RELEVANT lines from it.
//
// What these tests pin is the opposite of "load the corpus": an irrelevant
// entry contributes ZERO characters, everything left out is recorded with a
// reason, and the same repository ingests to the same hash twice. No model, no
// network, no real repository — every fixture is temporary.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, fakeExecutor, run, ROOT, url } from "./helpers.mjs";

const KN = await import(url(join(ROOT, "scripts", "knowledge.mjs")));

// A credential is ASSEMBLED at runtime: a literal one in a committed test file
// is exactly what the secret gate blocks, and it is right to block it.
const FAKE_TOKEN = ["gh" + "p", "0".repeat(36) + "ab"].join("_");

// Durable documents of the kind a real project keeps.
function docs(repo, { extra = {} } = {}) {
  mkdirSync(join(repo, "docs", "adr"), { recursive: true });
  writeFileSync(join(repo, "PRD.md"),
    "# Invoice exporter\n\n## Goals\n\nThe exporter writes one CSV per invoice batch.\n\n"
    + "## Non-goals\n\nNo PDF rendering.\n");
  writeFileSync(join(repo, "docs", "adr", "0004-pagination.md"),
    "# ADR 0004 — pagination is cursor based\n\n## Decision\n\n"
    + "The invoice exporter paginates by cursor, never by offset: an offset page shifts under concurrent writes.\n");
  writeFileSync(join(repo, "LESSONS.md"),
    "# Lessons\n\n- Guarding a repository property by asking the filesystem fails on Windows, ask git plumbing instead.\n");
  // Not on the allowlist: a scratch note and source code are never ingested.
  writeFileSync(join(repo, "notes.md"), "# Scratch\n\nrandom thinking about the invoice exporter cursor\n");
  for (const [p, text] of Object.entries(extra)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), text);
  }
}

const TASK = { title: "paginate the invoice exporter", ac: ["AC-1: cursor pagination"], notes: "", files: ["src/exporter.js"] };

test("knowledge: durable documents are ingested, typed and hashed; nothing else is", () => {
  const fx = fixture("kn-ingest");
  try {
    docs(fx.repo);
    const ix = KN.ingest(fx.repo);
    assert.equal(ix.ok, true, JSON.stringify(ix));
    const sources = ix.documents.map((d) => d.source).sort();
    assert.deepEqual(sources, ["LESSONS.md", "PRD.md", "docs/adr/0004-pagination.md"],
      "only the allowlisted durable documents are ingested");
    assert.equal(ix.documents.find((d) => d.source === "PRD.md").category, "FACT");
    assert.equal(ix.documents.find((d) => d.source.startsWith("docs/adr/")).category, "DECISION");
    assert.equal(ix.documents.find((d) => d.source === "LESSONS.md").category, "LESSON");
    assert.ok(ix.entries.length >= 4, "a document splits into entries at its headings");
    for (const e of ix.entries) assert.match(e.hash, /^[0-9a-f]{64}$/);
    assert.match(ix.index_hash, /^[0-9a-f]{64}$/);
  } finally { fx.done(); }
});

test("knowledge: the same repository ingests to the same hash twice", () => {
  const fx = fixture("kn-deterministic");
  try {
    docs(fx.repo);
    const a = KN.ingest(fx.repo), b = KN.ingest(fx.repo);
    assert.equal(a.index_hash, b.index_hash, "ingestion must be deterministic — no clock, no ordering luck");
    assert.deepEqual(a.entries.map((e) => e.id), b.entries.map((e) => e.id));
  } finally { fx.done(); }
});

test("knowledge: an entry is bounded, and what was cut is counted", () => {
  const fx = fixture("kn-bounded");
  try {
    docs(fx.repo, { extra: { "docs/adr/0005-huge.md": "# ADR 0005 — huge\n\n## Decision\n\n" + "invoice cursor detail. ".repeat(2000) } });
    const ix = KN.ingest(fx.repo);
    const big = ix.entries.filter((e) => e.source === "docs/adr/0005-huge.md");
    assert.ok(big.length > 0);
    for (const e of big) assert.ok(e.characters <= KN.LIMITS.entry_characters, `entry is ${e.characters} characters`);
    assert.ok(big.some((e) => e.omitted_characters > 0), "the cut has to be on the record, not silent");
  } finally { fx.done(); }
});

test("knowledge: a credential in a document never enters the index", () => {
  const fx = fixture("kn-secret");
  try {
    docs(fx.repo, { extra: { "docs/adr/0006-deploy.md": `# ADR 0006 — deploy\n\n## Decision\n\nUse the invoice exporter token ${FAKE_TOKEN} for staging.\n` } });
    const ix = KN.ingest(fx.repo);
    const all = JSON.stringify(ix);
    assert.ok(!all.includes(FAKE_TOKEN), "a credential must not survive ingestion");
    assert.equal(ix.documents.find((d) => d.source === "docs/adr/0006-deploy.md").redacted, true,
      "and the fact that it was redacted is recorded");
  } finally { fx.done(); }
});

test("knowledge: an irrelevant entry contributes ZERO characters and says why", () => {
  const fx = fixture("kn-relevance");
  try {
    docs(fx.repo);
    const sel = KN.select(KN.ingest(fx.repo), TASK, { maxCharacters: 3000 });
    const text = sel.lines.join("\n");
    assert.match(text, /cursor/i, "the ADR that bears on this task is included");
    assert.ok(!/Windows/i.test(text), "an unrelated lesson costs nothing");
    const dropped = sel.manifest.omitted.find((o) => /LESSONS\.md/.test(o.source ?? ""));
    assert.ok(dropped, "an omission is recorded, not silent: " + JSON.stringify(sel.manifest.omitted));
    assert.equal(dropped.characters, 0);
    assert.match(dropped.reason, /relevan/i);
  } finally { fx.done(); }
});

test("knowledge: selection never exceeds the character budget it was given", () => {
  const fx = fixture("kn-budget");
  try {
    docs(fx.repo);
    const ix = KN.ingest(fx.repo);
    const sel = KN.select(ix, TASK, { maxCharacters: 120 });
    assert.ok(sel.manifest.contributed_characters <= 120,
      `contributed ${sel.manifest.contributed_characters} characters against a 120 budget`);
    assert.equal(sel.manifest.unit, "characters");
    assert.ok(sel.manifest.omitted.some((o) => /budget/i.test(o.reason)),
      "what the budget pushed out is named: " + JSON.stringify(sel.manifest.omitted));
    assert.equal(sel.manifest.index_hash, ix.index_hash,
      "the manifest carries the index hash so two runs can be compared without the text");
  } finally { fx.done(); }
});

test("knowledge: a repository with no durable documents ingests to nothing, and says so", () => {
  const fx = fixture("kn-empty");
  try {
    const sel = KN.select(KN.ingest(fx.repo), TASK, { maxCharacters: 3000 });
    assert.deepEqual(sel.lines, []);
    assert.equal(sel.manifest.contributed_characters, 0);
    assert.equal(sel.manifest.documents_ingested, 0);
  } finally { fx.done(); }
});

test("knowledge: a run draws on the index and records exactly what it used", async () => {
  const fx = fixture("kn-run");
  try {
    docs(fx.repo);
    initWorkspace(fx);
    const t = addTask(fx, { title: "paginate the invoice exporter", ac: "AC-1: cursor pagination" });
    const rec = await run(fx, t, fakeExecutor(fx, { write: [{ path: "src/exporter.js", content: "// cursor\n" }] }));
    assert.equal(rec.outcome, "VERIFIED", JSON.stringify(rec.failure));
    const man = JSON.parse(readFileSync(join(rec.run_dir, "knowledge-manifest.json"), "utf8"));
    assert.ok(man.included.length > 0, "the run drew something from the project's own documents");
    assert.ok(man.included.every((i) => i.hash && !i.text), "the manifest carries hashes, never the text");
    const prompt = readFileSync(join(rec.run_dir, "prompt.txt"), "utf8");
    assert.match(prompt, /RELEVANT KNOWLEDGE/);
    assert.match(prompt, /cursor/i);
    assert.ok(!/No PDF rendering/.test(prompt), "the corpus is never loaded whole");
    assert.ok(existsSync(join(rec.run_dir, "knowledge-manifest.json")));
  } finally { fx.done(); }
});
