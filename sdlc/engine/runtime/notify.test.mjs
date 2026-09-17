// A notification that was not delivered and not recorded is a lie the loop told about itself. Every test
// here is a way that used to happen.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { notify, record, unread, markAllRead, logPath, orchestratorTarget } from "./notify.mjs";

const proj = () => fs.mkdtempSync(path.join(os.tmpdir(), "sch-notify-"));
const lines = root => fs.readFileSync(logPath(root), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));

test("with no transport configured the message is still recorded, not skipped", async () => {
  const root = proj();
  const r = await notify(root, "SCH ✓ T1.1 done — Add priority", { config: {}, ticket: "T1.1" });
  assert.equal(r.recorded, true);
  assert.equal(r.delivered, false);
  assert.equal(r.target, null);
  const [n] = lines(root);
  assert.equal(n.text, "SCH ✓ T1.1 done — Add priority");
  assert.equal(n.ticket, "T1.1");
  assert.equal(n.read, false);
});

test("a configured transport is used, and its success is reported", async () => {
  const root = proj();
  const sent = [];
  const r = await notify(root, "hello", { config: { orchestrator_agent: "pane-7" }, deliver: async (text, o) => { sent.push([text, o.target]); return { ok: true }; } });
  assert.deepEqual(sent, [["hello", "pane-7"]]);
  assert.equal(r.delivered, true);
  assert.equal(unread(root).length, 1, "and it is still recorded — delivery is a second sink, not the only one");
});

test("a transport that fails does not lose the message", async () => {
  const root = proj();
  const r = await notify(root, "hello", { config: { orchestrator_agent: "pane-7" }, deliver: async () => ({ ok: false, error: "herdr not on PATH" }) });
  assert.equal(r.delivered, false);
  assert.match(r.delivery.error, /not on PATH/);
  assert.equal(unread(root).length, 1);
});

test("a transport that throws does not take the ticket down with it", async () => {
  const root = proj();
  const r = await notify(root, "hello", { config: { orchestrator_agent: "x" }, deliver: async () => { throw new Error("pane is gone"); } });
  assert.equal(r.delivered, false);
  assert.match(r.delivery.error, /pane is gone/);
  assert.equal(unread(root).length, 1);
});

test("notify_required turns an undelivered message into a recorded error, not silence", async () => {
  const root = proj();
  await notify(root, "SCH ✓ T1.1 done", { config: { notify_required: true } });
  const rows = lines(root);
  assert.equal(rows.length, 2, "the message, and an error saying it did not reach anyone");
  assert.equal(rows[1].level, "error");
  assert.match(rows[1].text, /could not be delivered/);
  assert.match(rows[1].text, /no orchestrator target/);
});

test("notify_required is quiet when delivery works", async () => {
  const root = proj();
  await notify(root, "hi", { config: { notify_required: true, orchestrator_agent: "p" }, deliver: async () => ({ ok: true }) });
  assert.equal(lines(root).length, 1);
});

test("unread filters by level and markAllRead clears without deleting the history", () => {
  const root = proj();
  record(root, { level: "info", text: "a" });
  record(root, { level: "warn", text: "b" });
  record(root, { level: "error", text: "c" });
  assert.equal(unread(root).length, 3);
  assert.deepEqual(unread(root, { level: "warn" }).map(n => n.text), ["b"]);
  assert.equal(markAllRead(root), 3);
  assert.equal(unread(root).length, 0);
  assert.equal(lines(root).length, 3, "history is kept, only the flag moves");
  assert.equal(markAllRead(root), 0, "and a second pass has nothing to do");
});

test("env overrides config for the target, and neither is an error", () => {
  const before = process.env.SCH_ORCHESTRATOR_AGENT;
  try {
    delete process.env.SCH_ORCHESTRATOR_AGENT;
    assert.equal(orchestratorTarget({}), null);
    assert.equal(orchestratorTarget({ orchestrator_agent: "from-config" }), "from-config");
    process.env.SCH_ORCHESTRATOR_AGENT = "from-env";
    assert.equal(orchestratorTarget({ orchestrator_agent: "from-config" }), "from-env");
  } finally {
    if (before === undefined) delete process.env.SCH_ORCHESTRATOR_AGENT; else process.env.SCH_ORCHESTRATOR_AGENT = before;
  }
});

test("an unwritable log is survivable — reporting success must not fail the ticket", async () => {
  const root = proj();
  // A directory where the file belongs: appendFileSync cannot write it, and notify must not throw.
  fs.mkdirSync(logPath(root), { recursive: true });
  const r = await notify(root, "hello", { config: {} });
  assert.equal(r.recorded, false);
  assert.equal(r.delivered, false);
});

test("a corrupt line in the log does not hide the notifications around it", () => {
  const root = proj();
  record(root, { level: "info", text: "before" });
  fs.appendFileSync(logPath(root), "{ not json\n");
  record(root, { level: "info", text: "after" });
  assert.deepEqual(unread(root).map(n => n.text), ["before", "after"]);
});
