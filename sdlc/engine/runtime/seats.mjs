// One door for "ask a model": a roles.json spec (spawned, watched) or a legacy provider seat.
import { invokeModel } from "./providers.mjs";
import { resolveSpawn, runRole } from "./spawn-index.mjs";

export async function callSeat(seat, { prompt, system, cwd, mode = "review", timeoutMs, silenceMs, onEvent }) {
  const full = `${system ? `SYSTEM:\n${system}\n\n` : ""}USER:\n${prompt}`;
  // A seat may carry its own transport. Used by tests to drive the pipeline without a real CLI, and by
  // any future transport that is neither a spawned argv nor a registry provider.
  if (typeof seat?.call === "function") {
    const r = await seat.call({ prompt, system, full, cwd, mode });
    return { text: r.text ?? String(r), usage: r.usage ?? null, cost: r.cost ?? null, sessionId: r.sessionId ?? null, model: r.model ?? seat.model ?? null, events: r.events ?? [], durationMs: r.durationMs ?? null };
  }
  if (seat?.spawn) {
    const { exe, args } = resolveSpawn(seat);
    const r = await runRole({ exe, args, cwd, prompt: full, timeoutMs, silenceMs, onEvent });
    if (r.outcome !== "PASSED") {
      const err = new Error(`${seat.role || seat.provider || exe} ${r.outcome}${r.exitCode != null ? ` exit ${r.exitCode}` : ""}: ${(r.stderr.trim() || r.text).slice(-800)}`);
      err.run = r; throw err;
    }
    return { text: r.text, usage: r.usage, cost: r.cost, sessionId: r.sessionId, model: r.model, events: r.events, durationMs: r.durationMs };
  }
  const text = await invokeModel({ providerId: seat.providerId, model: seat.model, prompt, system, cwd, mode });
  return { text, usage: null, cost: null, sessionId: null, model: seat.model, events: [], durationMs: null };
}
