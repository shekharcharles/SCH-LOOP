#!/usr/bin/env node
// SCH Loop — MCP server over the loop's own state.
//
// The graph MCP (graph-mcp.mjs) answers "what does the loop know about this
// codebase". This one answers "what is the loop DOING": projects, tasks,
// dependencies, supervised runs and the decisions waiting on a person. Together
// they let another agent orient without shelling out to the CLI and parsing it.
//
//   claude mcp add sch -- node <SCH_HOME>/scripts/mcp.mjs
//
// Hand-written JSON-RPC over stdio: no SDK, no npm dependency, so Claude Code,
// Codex and OpenCode all speak to it the same way.
//
// READ ONLY, and structurally so. Every handler below is a call to an existing
// projection function and nothing else — no writer is imported into this file,
// so there is no mutation for a future edit to reach for by accident. This is
// the same rule the dashboard follows: deciding a gate, claiming a task,
// delivering and approving are operator authority and stay on the CLI. A surface
// any agent can call is not the place to exercise authority.
//
// NOTHING here carries a prompt, a skill body or a credential. The projections
// were built to expose identifiers, hashes and character counts instead, and
// this server reuses them rather than re-deriving state — re-deriving is how a
// second, less careful copy of that rule gets written.
//
// PROTOCOL NOTE: stdout carries JSON-RPC and NOTHING else. Every diagnostic goes
// to stderr; a stray console.log corrupts the stream and the client silently
// drops the server.

import { loadRegistry, loadState, getProject } from "./state.mjs";
import { projectGraph } from "./taskgraph.mjs";
import { canonicalState, STATES } from "./transitions.mjs";
import { runProjection } from "./runner.mjs";
import { projection as gateProjection, pending as pendingGates } from "./humangates.mjs";

const PROTOCOL = "2024-11-05";
const log = (...a) => console.error("[sch-mcp]", ...a);
const now = () => new Date().toISOString();
// A limit an agent supplies is an argument, not an authority: clamp it so a
// careless (or hostile) `limit: 1e9` cannot turn a read into a memory event.
const bounded = (n, dflt, max = 50) => Math.max(1, Math.min(max, Number(n) || dflt));

const project = { type: "string", description: "SCH Loop project id, e.g. pmcms" };

const TOOLS = [
  {
    name: "sch_projects",
    description:
      "Every project the loop is registered to run, with how many tasks each one has, what state they are in, and how many decisions are waiting on a human. Start here when you do not already know the project id the other tools want.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sch_tasks",
    description:
      "The task queue for one project: id, title, phase, canonical state, whether it is ready to run and — when it is not — the blockers saying why. This is the small answer; ask sch_task_graph only when you need the dependency edges themselves.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        state: { type: "string", description: `Optional filter, one of: ${STATES.join(" | ")}` },
        phase: { type: "number", description: "Optional: only tasks in this phase" },
      },
      required: ["project"],
    },
  },
  {
    name: "sch_task_graph",
    description:
      "The whole dependency graph for one project: nodes, the authored edges with their typed reason, the hidden edges the audit inferred from overlapping file paths, and the structural validation verdict (cycles, missing upstreams, duplicates). Ask this before assuming two tasks can run in either order.",
    inputSchema: { type: "object", properties: { project }, required: ["project"] },
  },
  {
    name: "sch_runs",
    description:
      "Supervised external runs for one project: what ran, on which task, how it went, which skills the worker was actually given, and whether it is waiting on a person. Bounded by design — stdout, stderr and the prompt stay on disk and are referenced by count and location, never inlined.",
    inputSchema: {
      type: "object",
      properties: { project, limit: { type: "number", description: "Most recent N runs (default 10, max 50)" } },
      required: ["project"],
    },
  },
  {
    name: "sch_gates",
    description:
      "Typed human decision gates for one project: what is being asked, the options, the recommended default, and what has already been decided. READ ONLY — deciding a gate is operator authority and happens on the CLI. The payload tells you the exact command.",
    inputSchema: {
      type: "object",
      properties: { project, limit: { type: "number", description: "Most recent N per bucket (default 50)" } },
      required: ["project"],
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// ---- handlers ---------------------------------------------------------------
//
// Each one returns a plain object. Every project-scoped tool goes through the
// same existence check, so "no such project" is one answer with one wording
// rather than five subtly different failures.

function projectsPayload() {
  return {
    projects: (loadRegistry().projects ?? []).map((p) => {
      const s = loadState(p.id);
      const tasks = s.tasks ?? [];
      const by_state = {};
      for (const t of tasks) { const st = canonicalState(t); by_state[st] = (by_state[st] ?? 0) + 1; }
      return {
        id: p.id, name: p.name ?? p.id, domain: p.domain ?? null, path: p.path ?? null,
        tasks: { total: tasks.length, by_state },
        gates_pending: pendingGates(p.id, { state: s }).length,
      };
    }),
    decisions_require_local_operator: true,
    generated_at: now(),
  };
}

function tasksPayload(id, args) {
  const g = projectGraph(id, { canonicalState });
  let tasks = g.nodes;
  if (args.state) tasks = tasks.filter((t) => t.state === String(args.state).toUpperCase());
  if (args.phase !== undefined && args.phase !== null) tasks = tasks.filter((t) => t.phase === Number(args.phase));
  // Deliberately NOT the edge table: an agent asking "what is on the queue"
  // should not be handed the whole graph to read past.
  return { project_id: g.project_id, project: g.project, tasks, validation: g.validation, generated_at: g.generated_at };
}

const HANDLERS = {
  sch_projects: () => projectsPayload(),
  sch_tasks: (id, args) => tasksPayload(id, args),
  sch_task_graph: (id) => projectGraph(id, { canonicalState }),
  sch_runs: (id, args) => runProjection(id, { limit: bounded(args.limit, 10) }),
  sch_gates: (id, args) => gateProjection(id, { limit: bounded(args.limit, 50) }),
};

function call(name, args) {
  if (!TOOL_NAMES.has(name)) throw new Error(`unknown tool: ${name}`);
  if (name !== "sch_projects") {
    if (!args.project) return { isError: true, text: "project is required — call sch_projects to list the ids." };
    if (!getProject(args.project)) return { isError: true, text: `no such project: ${args.project}` };
  }
  return { text: JSON.stringify(HANDLERS[name](args.project, args), null, 2) };
}

// ---- JSON-RPC over stdio ----------------------------------------------------
//
// Two framings exist in the wild: newline-delimited JSON (what the MCP stdio
// transport specifies, and what graph-mcp.mjs speaks) and LSP-style
// Content-Length headers. Reading both costs a few lines and removes a whole
// class of "the client just silently dropped the server". Replies go back in
// whatever framing the request arrived in, so neither client has to be told.

const HDR = Buffer.from("\r\n\r\n");
let framed = false;                      // framing of the message being handled

function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(framed
    ? `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`
    : body + "\n");
}
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32000, message } });

function handle(msg, wasFramed) {
  framed = wasFramed;
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: PROTOCOL, capabilities: { tools: {} },
        serverInfo: { name: "sch", version: "1.0.0" },
        instructions: "Read-only view of the SCH Loop: projects, tasks, the dependency graph, supervised runs and human decision gates. Nothing here can start, deliver or approve anything — those are operator actions on the CLI.",
      });
    } else if (method === "tools/list") {
      reply(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      const r = call(params?.name, params?.arguments ?? {});
      reply(id, { content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) });
    } else if (method === "ping") {
      reply(id, {});
    } else if (id !== undefined) {
      fail(id, "unknown method: " + method);
    }
    // notifications (no id) need no reply
  } catch (e) {
    if (id !== undefined) fail(id, e.message);
    else log("error handling notification:", e.message);
  }
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (buf.subarray(0, 15).toString("latin1").toLowerCase() === "content-length:") {
      const e = buf.indexOf(HDR);
      if (e === -1) return;
      const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, e).toString("utf8"));
      if (!m) { log("bad Content-Length header"); buf = buf.subarray(e + 4); continue; }
      const len = Number(m[1]);
      if (buf.length < e + 4 + len) return;
      const body = buf.subarray(e + 4, e + 4 + len).toString("utf8");
      buf = buf.subarray(e + 4 + len);
      try { handle(JSON.parse(body), true); } catch { log("bad JSON in framed message"); }
    } else {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      const line = buf.subarray(0, nl).toString("utf8").trim();
      buf = buf.subarray(nl + 1);
      if (!line) continue;
      try { handle(JSON.parse(line), false); } catch { log("bad JSON line"); }
    }
  }
});
process.stdin.on("end", () => process.exit(0));
log("ready on stdio");
