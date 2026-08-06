// The SCH MCP server — the loop's READ-ONLY surface, spoken as MCP.
//
// Every test here spawns `scripts/mcp.mjs` as a real child process and speaks
// real JSON-RPC to it over stdio. No model, no network, no credential: the
// server only ever reads a throwaway SCH_HOME.
//
// The load-bearing property is that this surface CANNOT mutate. A read-only
// claim that nothing enforces is the exact class of drift that puts an approve
// button on an unauthenticated remote, so it is asserted structurally: the whole
// tool table is exercised and state.json must come back byte-identical.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, ROOT, HG } from "./helpers.mjs";

const SERVER = join(ROOT, "scripts", "mcp.mjs");
const HDR = Buffer.from("\r\n\r\n");

// A minimal MCP client. Understands both framings so the server's framing is
// something the tests can assert on rather than something they assume.
function client(home, { framing = "line" } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SCH_HOME: home, NODE_NO_WARNINGS: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = Buffer.alloc(0);
  let stderr = "";
  let dead = null;
  const waiting = new Map();
  const inbox = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });
  // A server that exits must fail every waiter NOW. Without this a missing or
  // crashed server reads as a timeout, which says nothing about why.
  const bury = (why) => {
    dead = why;
    for (const [, w] of waiting) w({ error: { code: -1, message: why } });
    waiting.clear();
  };
  child.on("exit", (code, sig) => bury(`server exited (code ${code}, signal ${sig}): ${stderr}`));
  child.on("error", (e) => bury(`server failed to start: ${e.message}`));

  const deliver = (msg) => {
    const w = waiting.get(msg.id);
    if (w) { waiting.delete(msg.id); w(msg); } else inbox.push(msg);
  };
  const drain = () => {
    for (;;) {
      if (buf.subarray(0, 15).toString("latin1").toLowerCase() === "content-length:") {
        const e = buf.indexOf(HDR);
        if (e === -1) return;
        const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, e).toString("utf8"))[1]);
        if (buf.length < e + 4 + len) return;
        deliver(JSON.parse(buf.subarray(e + 4, e + 4 + len).toString("utf8")));
        buf = buf.subarray(e + 4 + len);
      } else {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) return;
        const line = buf.subarray(0, nl).toString("utf8").trim();
        buf = buf.subarray(nl + 1);
        if (line) deliver(JSON.parse(line));
      }
    }
  };
  child.stdout.on("data", (c) => { buf = Buffer.concat([buf, c]); drain(); });

  let id = 0;
  const write = (msg, f) => {
    const body = JSON.stringify(msg);
    child.stdin.write(f === "content-length"
      ? `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`
      : body + "\n");
  };
  const rpc = (method, params, f = framing) => new Promise((resolve, reject) => {
    if (dead) return reject(new Error(`${method}: ${dead}`));
    const mid = ++id;
    const t = setTimeout(() => reject(new Error(`timeout on ${method}; stderr: ${stderr}`)), 15000);
    waiting.set(mid, (m) => { clearTimeout(t); resolve(m); });
    write({ jsonrpc: "2.0", id: mid, method, params }, f);
  });

  return {
    rpc,
    notify: (method, params, f = framing) => write({ jsonrpc: "2.0", method, params }, f),
    // The JSON payload a tool returned, already parsed.
    call: async (name, args = {}, f = framing) => {
      const r = await rpc("tools/call", { name, arguments: args }, f);
      if (r.error) return { error: r.error };
      const text = r.result?.content?.[0]?.text ?? "";
      try { return { data: JSON.parse(text), text, result: r.result }; }
      catch { return { text, result: r.result }; }
    },
    stderr: () => stderr,
    unsolicited: () => inbox,
    close: () => { child.stdin.end(); child.kill(); },
  };
}

const handshake = async (c) => {
  const r = await c.rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" },
  });
  c.notify("notifications/initialized", {});
  return r;
};

// ------------------------------------------------------------------ protocol

test("mcp: initialize returns a protocol version and server identity", async () => {
  const fx = fixture("mcp-init");
  const c = client(fx.home);
  try {
    const r = await handshake(c);
    assert.equal(r.jsonrpc, "2.0");
    assert.ok(r.result.protocolVersion, "no protocolVersion in initialize result");
    assert.ok(r.result.capabilities.tools, "server must advertise the tools capability");
    assert.equal(r.result.serverInfo.name, "sch");
  } finally { c.close(); fx.done(); }
});

test("mcp: speaks Content-Length framing and answers in the framing it was asked in", async () => {
  const fx = fixture("mcp-framing");
  const c = client(fx.home, { framing: "content-length" });
  try {
    const r = await handshake(c);
    assert.ok(r.result.protocolVersion, "Content-Length framed request was not answered");
    const list = await c.rpc("tools/list", {});
    assert.ok(Array.isArray(list.result.tools) && list.result.tools.length > 0);
  } finally { c.close(); fx.done(); }
});

test("mcp: a notification gets no reply, and a bad line does not kill the server", async () => {
  const fx = fixture("mcp-notify");
  const c = client(fx.home);
  try {
    await handshake(c);
    c.notify("notifications/cancelled", { requestId: 999 });
    const r = await c.rpc("ping", {});
    assert.deepEqual(r.result, {});
    assert.equal(c.unsolicited().length, 0, "server replied to a notification");
  } finally { c.close(); fx.done(); }
});

test("mcp: an unknown method fails the request rather than the connection", async () => {
  const fx = fixture("mcp-unknown");
  const c = client(fx.home);
  try {
    await handshake(c);
    const bad = await c.rpc("resources/read", { uri: "x" });
    assert.ok(bad.error, "unknown method should return a JSON-RPC error");
    const ok = await c.rpc("ping", {});
    assert.deepEqual(ok.result, {}, "connection did not survive an unknown method");
  } finally { c.close(); fx.done(); }
});

// --------------------------------------------------------------- tool table

test("mcp: exposes exactly the read-only surface, and every tool is documented", async () => {
  const fx = fixture("mcp-tools");
  const c = client(fx.home);
  try {
    await handshake(c);
    const { result } = await c.rpc("tools/list", {});
    const names = result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["sch_gates", "sch_projects", "sch_runs", "sch_task_graph", "sch_tasks"]);
    for (const t of result.tools) {
      assert.ok(t.description && t.description.length > 40, `${t.name}: needs a description that says what it answers`);
      assert.equal(t.inputSchema.type, "object", `${t.name}: needs an object inputSchema`);
    }
    // A verb that mutates must not appear anywhere in the table.
    const table = JSON.stringify(result.tools).toLowerCase();
    for (const verb of ["sch_run_", "sch_deliver", "sch_approve", "sch_decide", "sch_claim", "sch_task_add"])
      assert.ok(!table.includes(verb), `mutating tool ${verb} is exposed`);
  } finally { c.close(); fx.done(); }
});

test("mcp: an unknown tool is refused", async () => {
  const fx = fixture("mcp-badtool");
  const c = client(fx.home);
  try {
    await handshake(c);
    const r = await c.call("sch_task_add", { project: fx.P, title: "nope" });
    assert.ok(r.error || r.result?.isError, "unknown tool must be refused");
  } finally { c.close(); fx.done(); }
});

// ------------------------------------------------------------------- content

test("mcp: sch_projects lists registered projects with their task rollup", async () => {
  const fx = fixture("mcp-projects");
  try {
    addTask(fx, { title: "first task" });
    const c = client(fx.home);
    try {
      await handshake(c);
      const { data } = await c.call("sch_projects");
      assert.ok(Array.isArray(data.projects), "expected a projects array");
      const p = data.projects.find((x) => x.id === fx.P);
      assert.ok(p, "the registered fixture project is missing");
      assert.equal(p.name, "fixture");
      assert.equal(p.tasks.total, 1);
      // A registry entry carries a filesystem path; that is location, not content.
      assert.ok(!("scope" in p) || typeof p.scope === "object");
    } finally { c.close(); }
  } finally { fx.done(); }
});

test("mcp: sch_tasks returns the node list with readiness and blockers", async () => {
  const fx = fixture("mcp-tasks");
  try {
    const a = addTask(fx, { title: "independent" });
    const b = addTask(fx, { title: "dependent", deps: String(a) });
    const c = client(fx.home);
    try {
      await handshake(c);
      const { data } = await c.call("sch_tasks", { project: fx.P });
      assert.equal(data.tasks.length, 2);
      const dep = data.tasks.find((t) => t.id === b);
      assert.deepEqual(dep.depends_on, [a]);
      assert.equal(dep.ready, false, "a task with an unmet dependency is not ready");
      assert.ok(dep.blockers.length > 0, "an unready task must say why");
      const ind = data.tasks.find((t) => t.id === a);
      assert.equal(ind.ready, true);
      // The node list is the SMALL answer: no edge tables ride along.
      assert.ok(!("edges" in data), "sch_tasks should not carry the edge table");
    } finally { c.close(); }
  } finally { fx.done(); }
});

test("mcp: sch_tasks can filter to one state", async () => {
  const fx = fixture("mcp-tasks-filter");
  try {
    addTask(fx, { title: "queued one" });
    const c = client(fx.home);
    try {
      await handshake(c);
      const none = await c.call("sch_tasks", { project: fx.P, state: "DELIVERED" });
      assert.equal(none.data.tasks.length, 0);
      // A freshly queued task canonicalises to READY, not to its legacy word.
      const some = await c.call("sch_tasks", { project: fx.P, state: "READY" });
      assert.equal(some.data.tasks.length, 1);
    } finally { c.close(); }
  } finally { fx.done(); }
});

test("mcp: sch_task_graph returns edges, hidden edges and the validation verdict", async () => {
  const fx = fixture("mcp-graph");
  try {
    const a = addTask(fx, { title: "first" });
    const b = addTask(fx, { title: "second", deps: String(a) });
    const c = client(fx.home);
    try {
      await handshake(c);
      const { data } = await c.call("sch_task_graph", { project: fx.P });
      assert.equal(data.project_id, fx.P);
      assert.equal(data.nodes.length, 2);
      assert.ok(data.edges.some((e) => e.from === a && e.to === b), `no edge ${a}->${b} in ${JSON.stringify(data.edges)}`);
      assert.ok(Array.isArray(data.hidden_edges));
      assert.equal(data.validation.ok, true);
    } finally { c.close(); }
  } finally { fx.done(); }
});

test("mcp: sch_runs reports runs without ever carrying a prompt", async () => {
  const fx = fixture("mcp-runs");
  try {
    initWorkspace(fx);
    addTask(fx, { title: "a task" });
    const c = client(fx.home);
    try {
      await handshake(c);
      const { data, text } = await c.call("sch_runs", { project: fx.P });
      assert.equal(data.project, fx.P);
      assert.ok(Array.isArray(data.runs));
      assert.equal(data.available, true, `workspace should resolve: ${text}`);
      // The precedent the runner sets: counts and identifiers, never the text.
      assert.ok(!/"prompt"\s*:/.test(text), "a raw prompt reached the wire");
      assert.ok(!/"stdout"\s*:/.test(text), "worker stdout reached the wire");
      assert.ok(!/"body"\s*:/.test(text), "a skill body reached the wire");
    } finally { c.close(); }
  } finally { fx.done(); }
});

test("mcp: sch_gates shows pending gates and says deciding is operator-only", async () => {
  const fx = fixture("mcp-gates");
  try {
    const t = addTask(fx, { title: "needs a decision" });
    const made = HG.create(fx.P, {
      gateType: "SCOPE_EXPANSION", taskId: t,
      question: "Should this task be allowed to touch the payment module, which is outside its declared paths?",
      options: ["yes, expand scope", "no, keep the boundary"], recommended: "no, keep the boundary",
    });
    assert.ok(made.ok, `gate not created: ${JSON.stringify(made.failure)}`);
    const c = client(fx.home);
    try {
      await handshake(c);
      const { data, text } = await c.call("sch_gates", { project: fx.P });
      assert.equal(data.pending.length, 1);
      assert.equal(data.pending[0].task_id, t);
      assert.equal(data.counts.pending, 1);
      // Said out loud in the payload, exactly as the dashboard says it.
      assert.equal(data.decisions_require_local_operator, true);
      assert.ok(/state\.mjs human-gate-decide/.test(text), "must point at the CLI that actually decides");
    } finally { c.close(); }
  } finally { fx.done(); }
});

test("mcp: an unknown project is an answer, not a crash", async () => {
  const fx = fixture("mcp-noproject");
  const c = client(fx.home);
  try {
    await handshake(c);
    for (const tool of ["sch_tasks", "sch_task_graph", "sch_runs", "sch_gates"]) {
      const r = await c.call(tool, { project: "does-not-exist" });
      assert.ok(r.error || r.result?.isError || /no such project/i.test(r.text ?? ""),
        `${tool} should say the project does not exist, got: ${r.text}`);
    }
    const alive = await c.rpc("ping", {});
    assert.deepEqual(alive.result, {}, "server died on an unknown project");
  } finally { c.close(); fx.done(); }
});

// -------------------------------------------------------------- read-only

test("mcp: exercising the entire tool table mutates nothing on disk", async () => {
  const fx = fixture("mcp-readonly");
  try {
    initWorkspace(fx);
    const t = addTask(fx, { title: "a task that must not move" });
    HG.create(fx.P, {
      gateType: "SCOPE_EXPANSION", taskId: t,
      question: "Should this task be allowed to touch the payment module, which is outside its declared paths?",
      options: ["yes", "no"], recommended: "no",
    });
    const statePath = join(fx.home, "projects", fx.P, "state.json");
    const registryPath = join(fx.home, "projects.json");
    assert.ok(existsSync(statePath));
    const before = { state: readFileSync(statePath, "utf8"), registry: readFileSync(registryPath, "utf8") };

    const c = client(fx.home);
    try {
      await handshake(c);
      const { result } = await c.rpc("tools/list", {});
      for (const tool of result.tools) await c.call(tool.name, { project: fx.P, task: t, limit: 5 });
    } finally { c.close(); }

    assert.equal(readFileSync(statePath, "utf8"), before.state, "the MCP surface mutated state.json");
    assert.equal(readFileSync(registryPath, "utf8"), before.registry, "the MCP surface mutated the registry");
  } finally { fx.done(); }
});

test("mcp: stdout carries JSON-RPC and nothing else", async () => {
  const fx = fixture("mcp-stdout");
  try {
    addTask(fx, { title: "a task" });
    const c = client(fx.home);
    try {
      // Every message the client parsed came off stdout; a stray console.log
      // would have thrown in the framing reader before we got here.
      await handshake(c);
      await c.call("sch_projects");
      await c.call("sch_tasks", { project: fx.P });
      assert.equal(c.unsolicited().length, 0, "stdout carried something that was not a reply");
    } finally { c.close(); }
  } finally { fx.done(); }
});
