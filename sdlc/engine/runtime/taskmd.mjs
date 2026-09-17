#!/usr/bin/env node
// SCH-LOOP — task.md: the human-readable queue. Read top to bottom, never renumbered.
//
//   ## Phase <id> — <name>   (<done>/<total> done)
//   - [<status>] <ID>-<slug>  <type>  <Title>  deps:<A,B|->  [size:S] [council:true] [gate:blocking-human] [after:ID]
//
// status: ' ' pending · '~' in progress · 'x' done · '!' blocked · '?' needs human
// ID: T<phase>.<n>[a-z]  — a letter suffix marks a ticket inserted after <n>.
//
// Every mutation returns new text that differs from the input only on the lines it
// had to touch, so a diff of task.md always reads as one event.

import fs from "node:fs";

const PHASE_RE = /^## Phase (\d+(?:\.\d+)?) — (.+?)(?:\s+\((\d+)\/(\d+) done\))?\s*$/;
const TICKET_RE = /^- \[( |~|x|!|\?)\] (T\d+(?:\.\d+)?\.\d+[a-z]?)(?:-([a-z0-9-]+))?\s+(\w+)\s+(.+?)\s+deps:(\S+)(?:\s+(.*?))?\s*$/;
export const STATUS = { " ": "pending", "~": "in_progress", x: "done", "!": "blocked", "?": "needs_human" };

export function parse(text) {
  const lines = text.split("\n");
  const phases = [];
  let cur = null;
  lines.forEach((line, i) => {
    let m = line.match(PHASE_RE);
    if (m) { cur = { id: m[1], name: m[2], line: i, done: m[3] ? +m[3] : null, total: m[4] ? +m[4] : null, tickets: [] }; phases.push(cur); return; }
    m = line.match(TICKET_RE);
    if (m && cur) {
      const fields = {};
      for (const kv of (m[7] || "").split(/\s+/).filter(Boolean)) { const j = kv.indexOf(":"); if (j > 0) fields[kv.slice(0, j)] = kv.slice(j + 1); }
      cur.tickets.push({ id: m[2], slug: m[3] || "", status: m[1], type: m[4], title: m[5], deps: m[6] === "-" ? [] : m[6].split(","), fields, line: i, phase: cur.id });
    }
  });
  return { lines, phases, tickets: phases.flatMap(p => p.tickets) };
}

export function next(doc) {
  const byId = new Map(doc.tickets.map(t => [t.id, t]));
  for (const t of doc.tickets) {
    if (t.status !== " ") continue;
    if (t.deps.every(d => byId.get(d)?.status === "x")) return t;
  }
  return null;
}

function counterLine(phase) {
  const done = phase.tickets.filter(t => t.status === "x").length;
  return `## Phase ${phase.id} — ${phase.name}   (${done}/${phase.tickets.length} done)`;
}

export function recount(text) {
  const doc = parse(text);
  for (const p of doc.phases) doc.lines[p.line] = counterLine(p);
  return doc.lines.join("\n");
}

export function setStatus(text, id, glyph) {
  if (!(glyph in STATUS)) throw new Error(`unknown status glyph ${JSON.stringify(glyph)}`);
  const doc = parse(text);
  const t = doc.tickets.find(t => t.id === id);
  if (!t) throw new Error(`no ticket ${id} in task.md`);
  doc.lines[t.line] = doc.lines[t.line].replace(/^- \[.\]/, `- [${glyph}]`);
  return recount(doc.lines.join("\n"));
}

function nextId(phase, after) {
  if (!after) {
    const ints = phase.tickets.map(t => +t.id.split(".").pop().replace(/[a-z]$/, ""));
    return `T${phase.id}.${(ints.length ? Math.max(...ints) : 0) + 1}`;
  }
  const base = after.id.replace(/[a-z]$/, "");
  const used = new Set(phase.tickets.map(t => t.id).filter(x => x.startsWith(base) && /[a-z]$/.test(x)).map(x => x.slice(-1)));
  for (let c = 97; c <= 122; c++) { const ch = String.fromCharCode(c); if (!used.has(ch)) return `${base}${ch}`; }
  throw new Error(`no free suffix after ${after.id}`);
}

function formatLine({ id, slug, type, title, deps, size, extra = {} }) {
  const tail = [size ? `size:${size}` : null, ...Object.entries(extra).map(([k, v]) => `${k}:${v}`)].filter(Boolean).join("  ");
  return `- [ ] ${id}${slug ? "-" + slug : ""}  ${type}  ${title}  deps:${deps.length ? deps.join(",") : "-"}${tail ? "  " + tail : ""}`;
}

// insert({after:"T1.3", ...}) → T1.3a directly below T1.3 (and below its existing suffixes)
// insert({phase:"2", ...})    → T2.<max+1> at the end of phase 2
export function insert(text, spec) {
  let doc = parse(text);
  let phase, after = null, at;
  if (spec.after) {
    after = doc.tickets.find(t => t.id === spec.after);
    if (!after) throw new Error(`no ticket ${spec.after} to insert after`);
    phase = doc.phases.find(p => p.id === after.phase);
    const base = after.id.replace(/[a-z]$/, "");
    const family = phase.tickets.filter(t => t.id.replace(/[a-z]$/, "") === base);
    at = family[family.length - 1].line + 1;
  } else {
    phase = doc.phases.find(p => p.id === String(spec.phase));
    if (!phase) {
      // A queue writer must be able to open a phase: the first insert into an empty task.md has no
      // header to land under. Naming it is required, so a phase is never created by accident.
      if (!spec.phaseName) throw new Error(`no phase ${spec.phase} in task.md — pass phaseName to create it`);
      const header = `## Phase ${spec.phase} — ${spec.phaseName}   (0/0 done)`;
      const later = doc.phases.find(p => Number(p.id) > Number(spec.phase));
      const insertAt = later ? later.line : doc.lines.length;
      doc.lines.splice(insertAt, 0, "", header);
      doc = parse(doc.lines.join("\n"));
      phase = doc.phases.find(p => p.id === String(spec.phase));
    }
    at = phase.tickets.length ? phase.tickets[phase.tickets.length - 1].line + 1 : phase.line + 1;
  }
  const id = spec.id || nextId(phase, after);
  if (doc.tickets.some(t => t.id === id)) throw new Error(`ticket ${id} already exists`);
  const line = formatLine({ id, slug: spec.slug, type: spec.type, title: spec.title, deps: spec.deps || [], size: spec.size, extra: spec.extra });
  doc.lines.splice(at, 0, line);
  return recount(doc.lines.join("\n"));
}

// CLI: node taskmd.mjs <file> next | status <id> <glyph> | insert <json> | recount | list
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const [file, cmd, ...rest] = process.argv.slice(2);
  if (!file || !cmd) { console.error("usage: taskmd.mjs <task.md> next|list|recount|status <id> <glyph>|insert '<json>'"); process.exit(2); }
  const text = fs.readFileSync(file, "utf8");
  const write = out => { fs.writeFileSync(file, out); console.log("ok"); };
  switch (cmd) {
    case "next": { const t = next(parse(text)); console.log(JSON.stringify(t)); break; }
    case "list": console.log(JSON.stringify(parse(text).tickets.map(({ line, ...t }) => ({ ...t, status: STATUS[t.status] })), null, 2)); break;
    case "recount": write(recount(text)); break;
    case "status": write(setStatus(text, rest[0], rest[1] ?? " ")); break;
    case "insert": write(insert(text, JSON.parse(rest[0]))); break;
    default: console.error(`unknown command ${cmd}`); process.exit(2);
  }
}
