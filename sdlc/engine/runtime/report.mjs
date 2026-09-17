// The executor's report envelope (SSSF typed envelope): what it claims, what was verified, what to tell
// the next ticket. The orchestrator reads THIS, never the transcript.
import fs from "node:fs";
import path from "node:path";

export function writeReport(projectRoot, r) {
  const dir = path.join(projectRoot, ".sch-loop", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const env = {
    schema: 1, id: r.id, status: r.status, at: new Date().toISOString(),
    summary: r.summary || "", artifacts: r.artifacts || [], tests: r.tests || null,
    review: r.review || null, judge: r.judge || null, attempts: r.attempts ?? 0, run_id: r.run_id || null,
    usage: r.usage || null, context_tokens: r.context_tokens ?? null, cost_usd: r.cost_usd ?? null,
    notes_for_next: r.notes_for_next || "", what_did_not_work: r.what_did_not_work || [],
    branch: r.branch || null, merged_head: r.merged_head || null,
  };
  fs.writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify(env, null, 2) + "\n");
  const md = [
    `# ${env.id} — ${env.status}`, "",
    env.summary, "",
    `- attempts: ${env.attempts}`, `- files: ${env.artifacts.join(", ") || "-"}`,
    `- tests: ${env.tests ? (env.tests.passed ? "pass" : "FAIL " + (env.tests.failed || []).join(", ")) : "-"}`,
    `- judge: ${env.judge?.verdict || "-"}`, `- context tokens: ${env.context_tokens ?? "unknown"}`, `- cost: ${env.cost_usd ?? "unknown"}`,
    "", env.what_did_not_work.length ? `## What did not work\n${env.what_did_not_work.map(x => `- ${x}`).join("\n")}` : "",
    env.notes_for_next ? `## Notes for next ticket\n${env.notes_for_next}` : "",
  ].filter(Boolean).join("\n");
  fs.writeFileSync(path.join(dir, `${r.id}.md`), md + "\n");
  return env;
}

export function readReport(projectRoot, id) {
  const f = path.join(projectRoot, ".sch-loop", "reports", `${id}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

export function appendEvent(projectRoot, ev) {
  const f = path.join(projectRoot, ".sch-loop", "events.jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...ev }) + "\n");
}
