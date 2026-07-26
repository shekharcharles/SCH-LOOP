#!/usr/bin/env node
// SCH Loop — the knowledge graph.
//
// WHY THIS EXISTS
// A fresh subagent knows nothing, so it rediscovers the same ground on every
// task: the same greps, the same reads, the same "where does this live". That
// rediscovery is the single largest cost in a pass. Everything the loop learns —
// a choke point, an endpoint, a JS function doing crypto, a finding, a decision —
// is thrown away the moment the subagent returns.
//
// This is where it goes instead. One store, queried through an MCP tool, so an
// agent asks a question and gets the answer plus its call paths, rather than
// reading a 2.9 MB bundle again.
//
// WHY IT IS SELF-CONTAINED
// node:sqlite ships inside Node (24+): FTS5 ranked search and recursive CTE graph
// traversal, with zero npm dependencies. No server, no vector database, no
// install step. The store is one file per project under projects/<id>/graph.db.
//
// WHY BOTH JOBS SHARE IT
// Dev and offensive work ask the same shape of question — "what is this, what
// touches it, what did we learn". A code indexer only answers the first. Here a
// recon-discovered endpoint and the symbol that serves it are two nodes and an
// edge, so a finding three days later resolves to code without re-reading files.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.SCH_HOME || join(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = (project) => join(ROOT, "projects", project, "graph.db");

// What a node can be. Code kinds and engagement kinds live in one table on
// purpose — the join between them is the whole point.
export const KINDS = new Set([
  "symbol", "file", "module",              // code
  "endpoint", "param", "role", "host",     // attack surface / runtime
  "finding", "evidence",                   // offensive results
  "decision", "lesson", "note",            // the loop's own memory
]);
export const EDGE_KINDS = new Set([
  "calls", "imports", "defines", "contains",
  "handles", "protects", "encrypts", "authenticates",
  "evidences", "supersedes", "relates", "touches",
]);

const now = () => new Date().toISOString();

export function open(project) {
  const p = dbPath(project);
  mkdirSync(dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS node(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
      path TEXT, line INTEGER, lang TEXT, summary TEXT, meta TEXT,
      createdAt TEXT, updatedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS node_kind ON node(kind);
    CREATE INDEX IF NOT EXISTS node_name ON node(name);
    CREATE INDEX IF NOT EXISTS node_path ON node(path);
    CREATE TABLE IF NOT EXISTS edge(
      src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL,
      meta TEXT, createdAt TEXT,
      PRIMARY KEY(src, dst, kind)
    );
    CREATE INDEX IF NOT EXISTS edge_dst ON edge(dst);
    -- FTS is a plain (non-content) table kept in step by upsert/remove, so a
    -- rebuild is never needed and a rename cannot leave a stale row behind.
    --
    -- 'porter' stemming matters more than it looks: without it "encrypted" does
    -- not find a summary that says "encrypts", which is exactly how a person
    -- phrases the question three days later.
    CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
      id UNINDEXED, name, terms, summary, path, tokenize='porter unicode61'
    );
  `);
  return db;
}

// Stable id: same symbol in the same file is the same node across passes, so
// re-recording a fact updates it rather than duplicating it.
export const nodeId = (kind, name, path = "") =>
  `${kind}:${(path || "").replace(/\\/g, "/")}#${name}`.toLowerCase();

// An identifier is several words wearing a disguise. FTS treats decryptPayload
// as ONE token, so a search for "payload" finds nothing. Index the parts too.
export function splitIdent(s = "") {
  return [...new Set(String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")   // camelCase  -> camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // HTTPServer -> HTTP Server
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 1)
    .map((w) => w.toLowerCase()))].join(" ");
}

export function upsertNode(db, n) {
  if (!KINDS.has(n.kind)) throw new Error(`unknown node kind: ${n.kind}`);
  if (!n.name) throw new Error("node needs a name");
  const id = n.id || nodeId(n.kind, n.name, n.path);
  const meta = n.meta ? JSON.stringify(n.meta) : null;
  const existing = db.prepare("SELECT id FROM node WHERE id=?").get(id);
  if (existing) {
    db.prepare(`UPDATE node SET kind=?, name=?, path=?, line=?, lang=?,
                summary=COALESCE(?, summary), meta=COALESCE(?, meta), updatedAt=? WHERE id=?`)
      .run(n.kind, n.name, n.path ?? null, n.line ?? null, n.lang ?? null, n.summary ?? null, meta, now(), id);
    db.prepare("DELETE FROM node_fts WHERE id=?").run(id);
  } else {
    db.prepare(`INSERT INTO node(id,kind,name,path,line,lang,summary,meta,createdAt,updatedAt)
                VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(id, n.kind, n.name, n.path ?? null, n.line ?? null, n.lang ?? null, n.summary ?? null, meta, now(), now());
  }
  const row = db.prepare("SELECT summary FROM node WHERE id=?").get(id);
  db.prepare("INSERT INTO node_fts(id,name,terms,summary,path) VALUES(?,?,?,?,?)")
    .run(id, n.name, splitIdent(n.name + " " + (n.path ?? "")), row?.summary ?? "", n.path ?? "");
  return id;
}

export function addEdge(db, src, dst, kind, meta) {
  if (!EDGE_KINDS.has(kind)) throw new Error(`unknown edge kind: ${kind}`);
  db.prepare("INSERT OR REPLACE INTO edge(src,dst,kind,meta,createdAt) VALUES(?,?,?,?,?)")
    .run(src, dst, kind, meta ? JSON.stringify(meta) : null, now());
}

// FTS5 rejects bare punctuation and unbalanced quotes, and an agent's query is
// free text — sanitise to terms and prefix-match the last one so partial names
// ("decryptPay") still resolve.
function ftsQuery(q) {
  const terms = String(q).toLowerCase().match(/[a-z0-9_./-]{2,}/g) || [];
  if (!terms.length) return null;
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(" OR ");
}

export function search(db, query, { kind, limit = 12 } = {}) {
  const q = ftsQuery(query);
  if (!q) return [];
  const rows = db.prepare(`
    SELECT n.id, n.kind, n.name, n.path, n.line, n.lang, n.summary
    FROM node_fts f JOIN node n ON n.id = f.id
    WHERE node_fts MATCH ? ${kind ? "AND n.kind = ?" : ""}
    ORDER BY rank LIMIT ?`).all(...(kind ? [q, kind, limit] : [q, limit]));
  return rows;
}

// What depends on this, and what it depends on — the question that makes a
// rename safe, and the one grep answers slowest.
export function neighbours(db, id, depth = 2) {
  const callers = db.prepare(`
    WITH RECURSIVE up(id, d) AS (
      SELECT ?, 0
      UNION SELECT e.src, up.d+1 FROM edge e JOIN up ON e.dst = up.id WHERE up.d < ?
    )
    SELECT n.id, n.kind, n.name, n.path, n.line, up.d AS depth
    FROM up JOIN node n ON n.id = up.id WHERE up.d > 0 ORDER BY up.d, n.name`).all(id, depth);
  const uses = db.prepare(`
    WITH RECURSIVE down(id, d) AS (
      SELECT ?, 0
      UNION SELECT e.dst, down.d+1 FROM edge e JOIN down ON e.src = down.id WHERE down.d < ?
    )
    SELECT n.id, n.kind, n.name, n.path, n.line, down.d AS depth
    FROM down JOIN node n ON n.id = down.id WHERE down.d > 0 ORDER BY down.d, n.name`).all(id, depth);
  return { callers, uses };
}

export function explore(db, query, { depth = 2, limit = 6 } = {}) {
  const hits = search(db, query, { limit });
  return hits.map((h) => {
    const { callers, uses } = neighbours(db, h.id, depth);
    const edges = db.prepare(`SELECT e.kind, n.name AS other, 'out' AS dir FROM edge e JOIN node n ON n.id=e.dst WHERE e.src=?
                              UNION ALL
                              SELECT e.kind, n.name AS other, 'in' AS dir FROM edge e JOIN node n ON n.id=e.src WHERE e.dst=?`)
      .all(h.id, h.id);
    return { ...h, edges, callers, uses };
  });
}

export function stats(db) {
  const byKind = db.prepare("SELECT kind, COUNT(*) n FROM node GROUP BY kind ORDER BY n DESC").all();
  const edges = db.prepare("SELECT kind, COUNT(*) n FROM edge GROUP BY kind ORDER BY n DESC").all();
  const tot = db.prepare("SELECT COUNT(*) n FROM node").get().n;
  return { nodes: tot, edges: edges.reduce((s, e) => s + e.n, 0), byKind, byEdge: edges };
}

// ---- CLI -------------------------------------------------------------------
// The loop writes facts through this; the MCP server reads through the exports.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[++i];
  const project = flags.project;
  const die = (m) => { console.error(m); process.exit(1); };
  if (!project && cmd !== "help") die("need --project <id>");
  const out = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2));

  if (cmd === "record") {
    // node graph.mjs record --project p --kind symbol --name f --path a.py --summary "..."
    const db = open(project);
    const id = upsertNode(db, {
      kind: flags.kind, name: flags.name, path: flags.path, lang: flags.lang,
      line: flags.line ? Number(flags.line) : undefined, summary: flags.summary,
    });
    // --edge "kind:otherKind:otherName[:otherPath]" repeated via | separator
    for (const spec of (flags.edge || "").split("|").filter(Boolean)) {
      const [ekind, okind, oname, opath] = spec.split(":");
      const oid = upsertNode(db, { kind: okind, name: oname, path: opath });
      addEdge(db, id, oid, ekind);
    }
    out({ recorded: id });
  } else if (cmd === "search") {
    out(search(open(project), flags.q ?? rest.filter((r) => !r.startsWith("--")).join(" "), { kind: flags.kind, limit: Number(flags.limit ?? 12) }));
  } else if (cmd === "explore") {
    out(explore(open(project), flags.q ?? rest.filter((r) => !r.startsWith("--")).join(" "), { depth: Number(flags.depth ?? 2) }));
  } else if (cmd === "stats") {
    out(stats(open(project)));
  } else {
    out(`SCH Loop knowledge graph — self-contained (node:sqlite, no dependencies)

  graph.mjs record  --project <id> --kind <kind> --name <name> [--path p] [--line n]
                    [--summary "what it is"] [--edge "calls:symbol:other[:path]|..."]
  graph.mjs search  --project <id> --q "<text>" [--kind <kind>] [--limit n]
  graph.mjs explore --project <id> --q "<text>" [--depth 2]
  graph.mjs stats   --project <id>

node kinds: ${[...KINDS].join(" ")}
edge kinds: ${[...EDGE_KINDS].join(" ")}`);
  }
}
