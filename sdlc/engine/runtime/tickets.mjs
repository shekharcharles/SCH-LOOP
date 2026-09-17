// SCH-LOOP — tickets: the machine side of task.md. One JSON per ticket under
// .sch-loop/tickets/<id>-<slug>.json, one line in task.md. Schema: design §3.5.
import fs from "node:fs";
import path from "node:path";
import { parse, insert } from "./taskmd.mjs";

export const TICKET_TYPES = ["build", "test", "spike", "research", "docs", "review", "chore", "human", "decision"];
export const SIZES = ["XS", "S", "M", "L"];
// Types that change app code and therefore run TDD + review and need a write boundary.
const CODE_TYPES = new Set(["build", "test", "chore"]);

export function slugify(title, maxWords = 4) {
  // Hyphenated compounds ("end-to-end") stay one word.
  return String(title).toLowerCase().replace(/[^a-z0-9-]+/g, " ").split(/\s+/).map(w => w.replace(/^-+|-+$/g, "")).filter(Boolean).slice(0, maxWords).join("-");
}

export function validateTicket(t) {
  const errs = [];
  const str = (k, req = true) => { if (t[k] == null || t[k] === "") { if (req) errs.push(`${k} required`); } else if (typeof t[k] !== "string") errs.push(`${k} must be a string`); };
  const arr = (k, req = true, itemCheck = null) => {
    if (t[k] == null) { if (req) errs.push(`${k} required`); return; }
    if (!Array.isArray(t[k])) return errs.push(`${k} must be an array`);
    if (req && !t[k].length) errs.push(`${k} must not be empty`);
    if (itemCheck) t[k].forEach((x, i) => { const e = itemCheck(x); if (e) errs.push(`${k}[${i}]: ${e}`); });
  };
  if (t.id != null && !/^T\d+(?:\.\d+)?\.\d+[a-z]?$/.test(t.id)) errs.push(`id must look like T1.4 or T1.4a (no slug), got ${t.id}`);
  if (!TICKET_TYPES.includes(t.type)) errs.push(`type must be one of ${TICKET_TYPES.join("|")}`);
  str("title"); str("action");
  if (t.phase != null && !/^\d+(?:\.\d+)?$/.test(String(t.phase))) errs.push("phase must be like 1 or 1.1");
  if (t.size != null && !SIZES.includes(t.size)) errs.push(`size must be one of ${SIZES.join("|")}`);
  arr("deps", false, d => (/^T\d+(?:\.\d+)?\.\d+[a-z]?$/.test(d) ? null : `bad dep id ${d}`));
  arr("acceptance", true, a => (typeof a === "string" && a.trim() ? null : "must be a non-empty string"));
  arr("must_not", false); arr("read_first", false); arr("requirements", false);
  if (CODE_TYPES.has(t.type)) {
    arr("allowed_paths", true, p => (typeof p === "string" && p.trim() ? null : "must be a glob string"));
    arr("verify", true, v => {
      if (!v || typeof v !== "object") return "must be an object";
      if (!v.command || typeof v.command !== "string") return "command required";
      if (/\s/.test(v.command)) return "command must be a single executable; put flags in args (argv array), never a shell string";
      if (v.args != null && !Array.isArray(v.args)) return "args must be an argv array";
      return null;
    });
  } else {
    arr("allowed_paths", false); arr("verify", false);
  }
  if (t.gate != null && t.gate !== "blocking-human") errs.push("gate must be blocking-human or absent");
  if (t.council != null && typeof t.council !== "boolean") errs.push("council must be boolean");
  if (t.after != null && !/^T\d+(?:\.\d+)?\.\d+[a-z]?$/.test(t.after)) errs.push(`after must be a ticket id, got ${t.after}`);
  return errs;
}

const ticketsDir = root => path.join(root, ".sch-loop", "tickets");
const taskFile = root => path.join(root, "task.md");

export function ticketFile(root, id) {
  const dir = ticketsDir(root);
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).find(f => f === `${id}.json` || f.startsWith(`${id}-`) && f.endsWith(".json"));
  return hit ? path.join(dir, hit) : null;
}

export function loadTicket(root, id) {
  const f = ticketFile(root, id);
  if (!f) throw new Error(`no ticket ${id} under ${ticketsDir(root)}`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

export function saveTicket(root, ticket) {
  const errs = validateTicket(ticket);
  if (errs.length) throw new Error(`invalid ticket ${ticket.id || "(no id)"}: ${errs.join("; ")}`);
  fs.mkdirSync(ticketsDir(root), { recursive: true });
  const f = ticketFile(root, ticket.id) || path.join(ticketsDir(root), `${ticket.id}-${ticket.slug || slugify(ticket.title)}.json`);
  fs.writeFileSync(f, JSON.stringify(ticket, null, 2) + "\n");
  return f;
}

// Validates, assigns id (after:/phase: via taskmd), writes JSON, inserts the task.md line.
// Validation happens BEFORE any write so an invalid ticket never touches task.md.
export function writeTicket(root, input) {
  const t = { status: "pending", attempts: 0, ...input, slug: input.slug || slugify(input.title) };
  const errs = validateTicket(t);
  if (errs.length) throw new Error(`invalid ticket: ${errs.join("; ")}`);
  const text = fs.readFileSync(taskFile(root), "utf8");
  const extra = {};
  if (t.council === true) extra.council = "true";
  if (t.gate) extra.gate = t.gate;
  const spec = { id: t.id, after: t.after, phase: t.phase, phaseName: t.phaseName, slug: t.slug, type: t.type, title: t.title, deps: t.deps || [], size: t.size, extra };
  delete t.phaseName;   // a queue-layout hint, not part of the ticket contract
  const out = insert(text, spec);
  const doc = parse(out);
  const line = doc.tickets.find(x => x.slug === t.slug && x.title === t.title && (t.id ? x.id === t.id : true));
  if (!line) throw new Error("internal: inserted line not found");
  t.id = line.id; t.phase = line.phase;
  delete t.after;
  const file = saveTicket(root, t);
  fs.writeFileSync(taskFile(root), out);
  return { ...t, file };
}

// The shape runtime/cli.mjs build already accepts.
export function ticketToBuildSpec(t, cwd) {
  const requirements = [
    ...(t.acceptance || []),
    ...(t.must_not || []).map(m => `MUST NOT: ${m}`),
  ];
  const ticket = [
    `${t.id} ${t.title} [type:${t.type} size:${t.size || "?"}]`,
    "", t.action, "",
    t.interfaces?.length ? `Interfaces:\n${t.interfaces.map(i => `- ${i}`).join("\n")}\n` : "",
    t.read_first?.length ? `read_first (read these before editing anything):\n${t.read_first.map(f => `- ${f}`).join("\n")}` : "",
    // A ticket that has been through the council carries its verdict into the next brief. Without this
    // the council is a transcript nobody reads and the re-dispatched executor repeats the same red.
    t.council_guidance ? `\nA COUNCIL HAS ALREADY REVIEWED THE FAILED ATTEMPTS ON THIS TICKET. Follow its verdict:\n${t.council_guidance}` : "",
  ].filter(Boolean).join("\n");
  return {
    ticketId: t.id,
    ticket,
    requirements,
    allowedPaths: t.allowed_paths || [],
    verificationChecks: (t.verify || []).map(v => ({ name: v.name || v.command, command: v.command, args: v.args || [], ...(v.timeoutMs ? { timeoutMs: v.timeoutMs } : {}) })),
    maxAttempts: t.maxAttempts ?? 3,
    tags: [t.type, ...(t.requirements || [])],
    type: t.type,
    size: t.size,
    cwd,
  };
}
