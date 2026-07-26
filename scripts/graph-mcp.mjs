#!/usr/bin/env node
// SCH Loop — MCP server over the knowledge graph.
//
// Hand-written JSON-RPC over stdio: no SDK, no npm dependency. Any MCP client
// speaks this — Claude Code, Codex, OpenCode — so the loop's memory is not tied
// to one vendor's tooling.
//
//   claude mcp add sch-graph -- node <SCH_HOME>/scripts/graph-mcp.mjs
//
// PROTOCOL NOTE: stdout carries JSON-RPC and NOTHING else. Every diagnostic goes
// to stderr; a stray console.log corrupts the stream and the client silently
// drops the server.

import { open, search, explore, stats, upsertNode, addEdge, KINDS, EDGE_KINDS } from "./graph.mjs";

const PROTOCOL = "2024-11-05";
const log = (...a) => console.error("[sch-graph]", ...a);

const TOOLS = [
  {
    name: "sch_graph_search",
    description:
      "Find what the loop already knows about this codebase or engagement — symbols, files, endpoints, parameters, roles, findings, decisions and lessons. Ask BEFORE grepping or reading files: a hit returns the location and a one-line summary, so you skip the discovery pass entirely. Matches natural phrasing (stemmed, and identifiers are split, so 'encrypted payload' finds decryptPayload).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "SCH Loop project id, e.g. pmcms" },
        query: { type: "string", description: "What you are looking for, in plain words or a symbol name" },
        kind: { type: "string", description: `Optional filter: ${[...KINDS].join(" | ")}` },
        limit: { type: "number", description: "Max results (default 12)" },
      },
      required: ["project", "query"],
    },
  },
  {
    name: "sch_graph_explore",
    description:
      "Like search, but also returns the call paths: everything that CALLS each hit (the blast radius you must check before renaming anything) and everything it calls. Use this instead of grepping for callers — it is one round-trip and it includes edges recorded from runtime/recon, which grep cannot see.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        query: { type: "string" },
        depth: { type: "number", description: "How many hops to follow (default 2)" },
      },
      required: ["project", "query"],
    },
  },
  {
    name: "sch_graph_record",
    description:
      "Write what you just learned back into the graph so the next task does not rediscover it. Record a choke point you located, an endpoint recon found, a JS function doing crypto, a finding, a decision, or a lesson — with edges to whatever it relates to. This is what makes the loop cheaper over time; a discovery that is not recorded is paid for again.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        nodes: {
          type: "array",
          description: "Facts to record",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", description: [...KINDS].join(" | ") },
              name: { type: "string" },
              path: { type: "string", description: "Repo-relative file, if it has one" },
              line: { type: "number" },
              lang: { type: "string" },
              summary: { type: "string", description: "One line: what it is and why it matters" },
            },
            required: ["kind", "name"],
          },
        },
        edges: {
          type: "array",
          description: "Relationships between recorded facts, by name",
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "name of the source node" },
              to: { type: "string", description: "name of the target node" },
              kind: { type: "string", description: [...EDGE_KINDS].join(" | ") },
            },
            required: ["from", "to", "kind"],
          },
        },
      },
      required: ["project", "nodes"],
    },
  },
  {
    name: "sch_graph_stats",
    description: "How much this project's graph knows: node and edge counts by kind.",
    inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
  },
];

function call(name, args) {
  const project = args.project;
  if (!project) throw new Error("project is required");
  const db = open(project);

  if (name === "sch_graph_search") {
    const rows = search(db, args.query, { kind: args.kind, limit: args.limit ?? 12 });
    if (!rows.length) return "No match. Nothing has been recorded about this yet — locate it the normal way, then record it with sch_graph_record so the next task does not repeat the work.";
    return rows.map((r) =>
      `${r.kind} ${r.name}${r.path ? `  ${r.path}${r.line ? ":" + r.line : ""}` : ""}` +
      (r.summary ? `\n    ${r.summary}` : "")).join("\n");
  }

  if (name === "sch_graph_explore") {
    const hits = explore(db, args.query, { depth: args.depth ?? 2 });
    if (!hits.length) return "No match. Nothing recorded yet for that.";
    return hits.map((h) => {
      const L = [`${h.kind} ${h.name}${h.path ? `  ${h.path}${h.line ? ":" + h.line : ""}` : ""}`];
      if (h.summary) L.push(`  ${h.summary}`);
      if (h.callers.length) L.push(`  callers (check before renaming): ${h.callers.map((c) => `${c.name}${c.path ? " @" + c.path : ""}`).join(", ")}`);
      if (h.uses.length) L.push(`  uses: ${h.uses.map((u) => u.name).join(", ")}`);
      return L.join("\n");
    }).join("\n\n");
  }

  if (name === "sch_graph_record") {
    const ids = new Map();
    for (const n of args.nodes ?? []) ids.set(n.name, upsertNode(db, n));
    let edged = 0;
    for (const e of args.edges ?? []) {
      const from = ids.get(e.from), to = ids.get(e.to);
      if (!from || !to) { log(`edge skipped, unknown node: ${e.from} -> ${e.to}`); continue; }
      addEdge(db, from, to, e.kind); edged++;
    }
    return `Recorded ${ids.size} node(s) and ${edged} edge(s) into ${project}.`;
  }

  if (name === "sch_graph_stats") {
    const s = stats(db);
    return `${s.nodes} nodes, ${s.edges} edges\n` +
      s.byKind.map((k) => `  ${k.kind}: ${k.n}`).join("\n") +
      (s.byEdge.length ? "\n  --\n" + s.byEdge.map((k) => `  ${k.kind}: ${k.n}`).join("\n") : "");
  }
  throw new Error("unknown tool: " + name);
}

// ---- JSON-RPC over stdio ---------------------------------------------------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32000, message } });

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log("bad JSON line"); continue; }
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} },
                    serverInfo: { name: "sch-graph", version: "1.0.0" } });
      } else if (method === "tools/list") {
        reply(id, { tools: TOOLS });
      } else if (method === "tools/call") {
        const text = call(params.name, params.arguments ?? {});
        reply(id, { content: [{ type: "text", text }] });
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
});
process.stdin.on("end", () => process.exit(0));
log("ready on stdio");
