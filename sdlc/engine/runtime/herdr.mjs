// Herdr is transport only: open a pane, send text, nudge an agent. State stays in .sch-loop/.
// Verified surface on this machine (herdr.exe): `tab create --cwd --label`, `pane run <id> <cmd>...`,
// `pane send-text <id> <text>`, `agent prompt <target> <text> [--wait --until idle --timeout ms]`, `agent list`.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { locate } from "./providers.mjs";
const execFileP = promisify(execFile);

let _bin;
export async function herdrBin() { if (_bin === undefined) _bin = await locate("herdr"); return _bin; }

async function run(args, timeout = 10000) {
  const bin = await herdrBin();
  if (!bin) return { ok: false, error: "herdr not on PATH" };
  try { const { stdout } = await execFileP(bin, args, { timeout, windowsHide: true }); return { ok: true, out: stdout.trim() }; }
  catch (e) { return { ok: false, error: String(e.stderr || e.message).trim().slice(0, 400) }; }
}

export const tabCreate = ({ cwd, label }) => run(["tab", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
export const paneRun = (paneId, argv) => run(["pane", "run", paneId, ...argv]);
export const paneSendText = (paneId, text) => run(["pane", "send-text", paneId, text]);
export const agentList = () => run(["agent", "list"]);

// Nudge the orchestrator agent. target = config.orchestrator_agent (a herdr agent id/name) or env.
export async function notifyOrchestrator(text, { target = process.env.SCH_ORCHESTRATOR_AGENT } = {}) {
  if (!target) return { ok: false, skipped: true, error: "no orchestrator target (config orchestrator_agent / SCH_ORCHESTRATOR_AGENT)" };
  const r = await run(["agent", "prompt", target, text]);
  return r.ok ? r : await paneSendText(target, text);
}
