#!/usr/bin/env node
// SCH Loop — automatic ingestion of a project's OWN durable documents.
//
// WHY THIS EXISTS
// Every project already writes down what it is for and what it decided: a PRD,
// a scope, ADRs, a lessons file. A worker is started in a fresh process that has
// read none of it, so the same question gets re-derived — or worse, re-decided
// — once per task. Telling the worker to "go and read the docs" costs a search
// loop and still misses; pasting the documents in costs the whole corpus.
//
// So this module does the third thing: read the durable documents ONCE, cut
// them into hashed entries, and give a task the few entries that bear on it.
//
// THE POINT IS THE BOUND, NOT THE INGESTION. Following ADR 0002: the corpus is
// never loaded whole, retrieval is task-specific, and provenance is mandatory.
// The discipline is `evidence.mjs`'s — an entry that does not bear on this task
// contributes ZERO characters, and every omission is recorded with its reason.
// Cost is counted in CHARACTERS. There is no tokenizer here and no token count
// is invented.
//
// A DOCUMENT IS DATA, NEVER AUTHORITY. An ingested entry is compiled into the
// prompt beside the safety kernel, never instead of it: it cannot widen an
// allowed path, grant a tool or authorize a push, and what the worker actually
// did to the repository is inspected afterwards regardless of what any document
// said. Ingestion is also allowlisted by NAME rather than by extension, so a
// `.env`, a key or a client engagement file is unreachable rather than filtered.
//
// DETERMINISTIC. No model, no network, no embeddings: the same repository and
// the same task produce the same entries in the same order, and `index_hash`
// lets two runs be proven to have used the same knowledge WITHOUT the text
// being transmitted anywhere.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, posix } from "node:path";
// Redaction is NOT reimplemented here. A credential that got written into a PRD
// is caught by the same patterns that protect a compiled prompt, so there is one
// definition to keep correct rather than two that drift.
import { redactPrompt } from "./runner.mjs";

export const SCHEMA_VERSION = 1;

// Bounds, in one place. Every one of them is a refusal to let the corpus grow
// into the prompt: worst case this index is documents × entries × characters,
// and the SELECTION a task actually pays for is `selection_characters`.
export const LIMITS = {
  max_documents: 40,
  max_document_bytes: 262144,
  max_entries_per_document: 40,
  max_entries: 400,
  entry_characters: 600,
  selection_characters: 3000,
  max_selected_entries: 6,
  max_recorded_omissions: 25,
  // An entry that shares nothing with the task is not "weakly relevant", it is
  // irrelevant, and it costs nothing.
  min_score: 2,
};

// The allowlist IS the secret defence. Nothing is ingested because it happens to
// be markdown: a document is read only if this table names it, so a `.env`, a
// key, a client engagement file or a scratch note can never be reached in the
// first place. Categories are ADR 0002's.
const ROOT_DOCUMENTS = [
  [/^(PRD|SCOPE|SPEC|REQUIREMENTS|CHARTER)\.md$/i, "FACT"],
  [/^(LESSONS|LEARNING)\.md$/i, "LESSON"],
  [/^(CONVENTIONS|CONTRIBUTING|ARCHITECTURE)\.md$/i, "REPOSITORY_CONVENTION"],
];
const DOCUMENT_DIRS = [
  ["docs/adr", "DECISION"],
  ["docs/decisions", "DECISION"],
  ["docs/lessons", "LESSON"],
];
// Which category wins a tie. A decision somebody made outranks a fact somebody
// observed, which outranks a rule of thumb.
const CATEGORY_RANK = { DECISION: 0, SECURITY_POLICY: 0, FACT: 1, REPOSITORY_CONVENTION: 2, LESSON: 3 };

const sha = (s) => createHash("sha256").update(String(s ?? "")).digest("hex");

// -------------------------------------------------------------- ingestion

// Bounded discovery: the repository root (not recursed) plus three named
// directories. No walk, so a big repository costs the same as a small one.
function discover(repoRoot, limits) {
  const found = [], skipped = [];
  const list = (dir) => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

  for (const e of list(repoRoot))
    if (e.isFile())
      for (const [re, category] of ROOT_DOCUMENTS)
        if (re.test(e.name)) { found.push({ source: e.name, category }); break; }

  for (const [rel, category] of DOCUMENT_DIRS)
    for (const e of list(join(repoRoot, rel)))
      if (e.isFile() && /\.md$/i.test(e.name)) found.push({ source: posix.join(rel, e.name), category });

  found.sort((a, b) => a.source.localeCompare(b.source));
  if (found.length > limits.max_documents) {
    for (const d of found.slice(limits.max_documents))
      skipped.push({ source: d.source, reason: `over the ${limits.max_documents}-document ingestion cap` });
    found.length = limits.max_documents;
  }
  return { found, skipped };
}

// Cut at markdown headings, carrying the heading CHAIN so "## Decision" is not
// stranded without the ADR title that gives it meaning. A heading with no body
// of its own contributes nothing — its text lives on in its children.
function split(text, limits) {
  const out = [];
  const stack = [];
  let heading = [], buf = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (!body) return;
    const raw = body.replace(/\s+/g, " ").trim();
    const kept = raw.length > limits.entry_characters ? raw.slice(0, limits.entry_characters - 1) + "…" : raw;
    out.push({ heading: heading.join(" › "), text: kept, omitted_characters: Math.max(0, raw.length - kept.length) });
  };
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (!m) { buf.push(line); continue; }
    flush();
    const level = m[1].length, title = m[2].trim();
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title });
    heading = stack.map((s) => s.title);
  }
  flush();
  return out;
}

// Read the project's durable documents into a bounded, hashed index. Never
// throws: a project with no documents ingests to nothing and says so, which is
// a normal answer rather than a failure.
export function ingest(repoRoot, { limits = LIMITS } = {}) {
  if (!repoRoot || !existsSync(repoRoot))
    return { ok: false, why: `no such directory: ${repoRoot}`, index_hash: sha(""), documents: [], entries: [], skipped: [] };

  const { found, skipped } = discover(repoRoot, limits);
  const documents = [], entries = [];

  for (const d of found) {
    let raw, bytesOmitted = 0;
    try {
      const full = join(repoRoot, d.source);
      const bytes = statSync(full).size;
      raw = readFileSync(full, "utf8");
      if (Buffer.byteLength(raw, "utf8") > limits.max_document_bytes) {
        const cut = Buffer.from(raw, "utf8").subarray(0, limits.max_document_bytes).toString("utf8");
        bytesOmitted = bytes - Buffer.byteLength(cut, "utf8");
        raw = cut;
      }
    } catch (e) { skipped.push({ source: d.source, reason: `unreadable: ${e.code ?? e.message}` }); continue; }

    // REDACT BEFORE ANYTHING ELSE. The index is written to a run artifact and
    // rendered into a prompt; a credential must not survive into either, and the
    // only safe place to stop it is at the door.
    const red = redactPrompt(raw);
    const all = split(red.text, limits);
    if (!all.length) { skipped.push({ source: d.source, reason: "no prose under any heading" }); continue; }
    const parts = all.slice(0, limits.max_entries_per_document);
    if (all.length > parts.length)
      skipped.push({ source: d.source, reason: `${all.length - parts.length} further section(s) over the ${limits.max_entries_per_document}-per-document entry cap` });

    let n = 0;
    for (const p of parts) {
      if (entries.length >= limits.max_entries) { skipped.push({ source: d.source, reason: `over the ${limits.max_entries}-entry index cap` }); break; }
      entries.push({
        id: `${d.source}#${n++}`, source: d.source, category: d.category,
        heading: p.heading, text: p.text, characters: p.text.length,
        omitted_characters: p.omitted_characters,
        hash: sha(`${d.source}\n${p.heading}\n${p.text}`),
        terms: terms(p.text), heading_terms: terms(p.heading),
      });
    }
    documents.push({
      source: d.source, category: d.category, document_hash: sha(red.text),
      entries: n, characters: raw.length, bytes_omitted: bytesOmitted, redacted: red.redacted,
    });
  }

  return {
    ok: true, schema_version: SCHEMA_VERSION, unit: "characters",
    documents, entries, skipped,
    // Content-addressed, so "did these two runs see the same knowledge?" is
    // answerable from the manifests alone, without either carrying the text.
    index_hash: sha(entries.map((e) => e.hash).join("|")),
  };
}

// ---------------------------------------------------------------- matching

// Words too common to carry meaning. Small on purpose — a long stop list is a
// second thing to maintain, and a common word scores everywhere equally so it
// changes the ORDER very little.
const STOP = new Set(("the and for with that this from into not but you your our are was were has have had its it's "
  + "all any can may must should will would when where which who what how why does did done use used using "
  + "add adds added new old per each some more most other than then there they their them these those "
  + "task tasks project file files code make made only also same such very well work works").split(" "));

// Crude, deliberately: lowercase, split on anything that is not alphanumeric,
// drop a trailing plural. No stemmer, no dictionary — a heuristic that is easy
// to predict beats a clever one nobody can reproduce by hand.
function terms(s) {
  const out = new Set();
  for (const w of String(s ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
  }
  return [...out];
}

// Everything the task says about itself. Its files count twice over: the path is
// matched literally (a document naming the file is about the file) and its
// segments join the term set.
function taskTerms(task) {
  const files = (task?.files ?? []).map(String);
  const text = [task?.title ?? "", ...(task?.ac ?? []), ...(task?.ng ?? []), task?.notes ?? "", task?.brief ?? "", ...files].join(" ");
  return { words: new Set(terms(text)), files };
}

function score(entry, tt) {
  let shared = 0, headingShared = 0;
  for (const t of entry.terms) if (tt.words.has(t)) shared++;
  for (const t of entry.heading_terms) if (tt.words.has(t)) headingShared++;
  // A document that names the task's file is about the task's file.
  const named = tt.files.filter((f) => f.length > 3 && entry.text.includes(f)).length;
  // THE BODY DECIDES; the heading only amplifies. Without this a document whose
  // TITLE matches drags all of its sections in — which is how "retrieval is
  // task-specific" quietly becomes "load the whole document".
  if (!shared && !named) return 0;
  return shared + 2 * headingShared + 3 * named;
}

// ---------------------------------------------------------------- selection

const render = (e) => `[${e.category} ${e.source}${e.heading ? ` › ${e.heading}` : ""}] ${e.text}`;

// Choose the few entries that bear on THIS task, inside a character budget, and
// record everything that did not make it and why. The return value is the
// `knowledge` argument `compilePrompt` already takes: an array of lines.
export function select(index, task, { maxCharacters = LIMITS.selection_characters, limits = LIMITS } = {}) {
  const tt = taskTerms(task);
  const scored = (index?.entries ?? []).map((e) => ({ e, score: score(e, tt), line: render(e) }));

  const omitted = [];
  let omittedCharacters = 0, omittedCount = 0;
  const omit = (s, reason) => {
    omittedCharacters += s.line.length; omittedCount++;
    if (omitted.length < limits.max_recorded_omissions)
      // `characters: 0` is the whole point: this entry cost the prompt nothing.
      omitted.push({ id: s.e.id, source: s.e.source, heading: s.e.heading, hash: s.e.hash, characters: 0, would_have_cost: s.line.length, reason });
  };

  const relevant = [];
  for (const s of scored) {
    if (s.score < limits.min_score) omit(s, `below the relevance threshold for this task (score ${s.score} < ${limits.min_score})`);
    else relevant.push(s);
  }
  // Deterministic order all the way down: score, then category, then source,
  // then entry id — never insertion luck.
  relevant.sort((a, b) => b.score - a.score
    || (CATEGORY_RANK[a.e.category] ?? 9) - (CATEGORY_RANK[b.e.category] ?? 9)
    || a.e.source.localeCompare(b.e.source)
    || a.e.id.localeCompare(b.e.id));

  const included = [], lines = [];
  let used = 0, full = false;
  for (const s of relevant) {
    const cost = s.line.length + (lines.length ? 1 : 0);          // the newline between lines
    if (included.length >= limits.max_selected_entries) { omit(s, `over the ${limits.max_selected_entries}-entry selection cap`); continue; }
    if (full || used + cost > maxCharacters) { full = true; omit(s, `the ${maxCharacters}-character knowledge budget had ${maxCharacters - used} left`); continue; }
    used += cost; lines.push(s.line);
    included.push({ id: s.e.id, source: s.e.source, category: s.e.category, heading: s.e.heading, hash: s.e.hash, characters: s.line.length, score: s.score });
  }

  return {
    lines,
    manifest: {
      schema_version: SCHEMA_VERSION,
      unit: "characters", note: "character counts, not tokens — no tokenizer is used",
      index_hash: index?.index_hash ?? sha(""),
      // The selection, hashed: two runs given the same knowledge match here even
      // though neither manifest carries a word of it.
      selection_hash: sha(included.map((i) => i.hash).join("|")),
      documents_ingested: index?.documents?.length ?? 0,
      documents: (index?.documents ?? []).map((d) => ({ source: d.source, category: d.category, document_hash: d.document_hash, entries: d.entries, redacted: d.redacted, bytes_omitted: d.bytes_omitted })),
      documents_skipped: index?.skipped ?? [],
      entries_total: index?.entries?.length ?? 0,
      budget_characters: maxCharacters,
      contributed_characters: used,
      included,
      omitted,
      omitted_entries: omittedCount,
      omitted_characters: omittedCharacters,
      omissions_recorded: omitted.length,
      omissions_unrecorded: Math.max(0, omittedCount - omitted.length),
      redacted: (index?.documents ?? []).some((d) => d.redacted),
    },
  };
}

// What a caller actually wants: ingest, select, done. Never throws — a project
// whose documents cannot be read runs without them and says so in the manifest,
// because failing a task over a missing PRD would be absurd.
export function compileKnowledge({ repoRoot, task, maxCharacters = LIMITS.selection_characters } = {}) {
  try {
    return select(ingest(repoRoot), task, { maxCharacters });
  } catch (e) {
    return { lines: [], manifest: { schema_version: SCHEMA_VERSION, unit: "characters", index_hash: sha(""), documents_ingested: 0, contributed_characters: 0, included: [], omitted: [], error: String(e?.message ?? e) } };
  }
}
