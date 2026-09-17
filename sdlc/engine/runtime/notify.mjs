// Telling the orchestrator what happened. Design §3.8.
//
// The rule here is that a notification is never lost. The previous version went straight at Herdr and
// returned `{skipped: true}` when no target was configured — which it was for every run this engine has
// ever made — so every "SCH ✓ T1.1 done" the loop believed it sent went nowhere, and every caller threw
// the result away. A run could finish having notified nobody and report that it had.
//
// So: the durable log is the notification. It is written first, it is written with plain appendFileSync,
// and it cannot depend on a terminal multiplexer being installed. Herdr is a second sink on top — nice
// when it is there, never the thing that decides whether the message survived.
import fs from "node:fs";
import path from "node:path";
import { notifyOrchestrator } from "./herdr.mjs";

export const LEVELS = ["info", "warn", "error"];
export const logPath = projectRoot => path.join(projectRoot, ".sch-loop", "notifications.jsonl");

// The durable sink. Returns false rather than throwing: a notification that cannot be written must not
// take down the ticket that was trying to report success.
export function record(projectRoot, entry) {
  try {
    const f = logPath(projectRoot);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), read: false, ...entry }) + "\n");
    return true;
  } catch { return false; }
}

export function unread(projectRoot, { level = null } = {}) {
  let text = "";
  try { text = fs.readFileSync(logPath(projectRoot), "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } })
    .filter(n => !n.read && (!level || n.level === level));
}

export function markAllRead(projectRoot) {
  let text = "";
  try { text = fs.readFileSync(logPath(projectRoot), "utf8"); } catch { return 0; }
  const rows = text.split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  const n = rows.filter(r => !r.read).length;
  if (n) fs.writeFileSync(logPath(projectRoot), rows.map(r => JSON.stringify({ ...r, read: true })).join("\n") + "\n");
  return n;
}

// Where an out-of-band nudge should go. Config first so a project can set it once; env overrides for a
// one-off run. Absent from both is a legitimate configuration, not an error.
export const orchestratorTarget = (config = {}) => process.env.SCH_ORCHESTRATOR_AGENT || config.orchestrator_agent || null;

export async function notify(projectRoot, text, { config = {}, level = "info", ticket = null, deliver = notifyOrchestrator } = {}) {
  const target = orchestratorTarget(config);
  const recorded = record(projectRoot, { level, ticket, text, target });

  let delivery = { attempted: false };
  if (target) {
    try {
      const r = await deliver(text, { target });
      delivery = { attempted: true, ok: !!r?.ok, error: r?.ok ? undefined : (r?.error || "unknown") };
    } catch (e) { delivery = { attempted: true, ok: false, error: e.message }; }
  }

  // `notify_required: true` says this project depends on the out-of-band nudge — someone is watching a
  // pane, not the log. Silence would then be a lie, so it is said out loud on stderr and kept in the log.
  const required = config.notify_required === true;
  if (required && !delivery.ok) {
    const why = !target ? "no orchestrator target configured (config orchestrator_agent / SCH_ORCHESTRATOR_AGENT)" : delivery.error;
    process.stderr.write(`[sch notify] UNDELIVERED (notify_required): ${text}\n[sch notify] ${why}\n`);
    record(projectRoot, { level: "error", ticket, text: `notification could not be delivered: ${why}`, target });
  }

  return { recorded, delivered: delivery.ok === true, target, delivery, text, level };
}
