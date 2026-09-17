import { callSeat } from "./seats.mjs";

export function buildJudgePrompt({requirements, output, verification, evidenceNotes=""}) {
  return `You are the JUDGE. You did not produce this work and you have no stake in it.
Assume it may be wrong and verify it against evidence.

ORIGINAL REQUIREMENTS
${requirements}

OUTPUT TO CHECK
${output}

DETERMINISTIC VERIFICATION EVIDENCE
${JSON.stringify(verification,null,2)}

ADDITIONAL EVIDENCE
${evidenceNotes || "(none)"}

Rules:
1. Evaluate every requirement one by one.
2. Cite concrete evidence for every PASS or FAIL.
3. "Looks correct" is not evidence.
4. Check for unsupported additions, invented facts, scope violations, and missing requirements.
5. Do NOT fix, rewrite, or suggest wording.
6. If any required deterministic check failed, overall verdict MUST be FAIL.
7. Return JSON only with this exact shape:
{
  "verdict":"PASS"|"FAIL",
  "checks":[{"requirement":"...","status":"PASS"|"FAIL","evidence":"..."}],
  "unsupportedChanges":[],
  "scopeViolations":[],
  "failures":[{"id":"J-001","requirement":"...","reason":"...","evidence":"...","preventiveRule":"..."}]
}`;
}

function extractJson(text) {
  const t = String(text).trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("judge did not return JSON");
  return JSON.parse(m[0]);
}

export async function runJudge({seat, providerId, model, requirements, output, verification, evidenceNotes, cwd}) {
  const prompt = buildJudgePrompt({requirements,output,verification,evidenceNotes});
  const { text: raw } = await callSeat(seat || {providerId, model}, {
    system:"You are a strict independent verification judge. You report only; you never repair.",
    prompt, cwd, mode:"review"
  });
  const parsed = extractJson(raw);
  if (!["PASS","FAIL"].includes(parsed.verdict)) throw new Error("invalid judge verdict");
  if (!verification.passed) parsed.verdict = "FAIL";
  return {raw, parsed};
}
