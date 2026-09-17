// The front half of the lifecycle: brainstorm → PRD → architecture → plan, ending where sch-tickets
// picks up. Design §3.10.
//
// These existed only as skill prose. No run had ever produced BRAINSTORM.md, PRD.md or ARCHITECTURE.md,
// `lifecycle_stage` had never moved off BRAINSTORM, and the chain was broken at its first link anyway:
// sch-brainstorm wrote `.sch-loop/discovery/brief.md` while sch-prd read `.sch-loop/BRAINSTORM.md`.
//
// The split is the same one the rest of the engine uses. The judgement is the model's and lives in the
// skill file, which is where it can be edited. The orchestration is code: which stage is next, what it
// may read, whether what came back is substantive, and when the project is allowed to move on.
//
// Stage seats are READ-ONLY. They return the document on stdout and the engine writes the file. A stage
// that could write its own artifact could also write anything else in the project, and there is no reason
// to hand out that power to get a markdown file back.
import fs from "node:fs";
import path from "node:path";
import { callSeat } from "./seats.mjs";
import { appendEvent } from "./report.mjs";
import { notify } from "./notify.mjs";

export const GOAL_FILE = ".sch-loop/GOAL.md";

// `substantive` is the same idea as level 2 of goal-backward verification: a file that exists proves
// nothing. Each stage names the shape its own skill promises to produce.
export const STAGES = [
  {
    id: "brainstorm", skill: "sch-brainstorm", artifact: ".sch-loop/BRAINSTORM.md", reads: [],
    needsGoal: true,
    substantive: t => [
      [(t.match(/^## /gm) || []).length >= 3, "fewer than three sections"],
      [/^#{1,3}\s*(locked )?decisions?\b/im.test(t), "no decisions section — a brainstorm that locks nothing cannot be built on"],
      [t.length >= 600, "too short to have explored anything"],
    ],
  },
  {
    id: "prd", skill: "sch-prd", artifact: ".sch-loop/PRD.md", reads: [".sch-loop/BRAINSTORM.md"],
    substantive: t => [
      // sch-prd teaches `CAT-NN` (AUTH-01, TRACK-03). An earlier version of this gate demanded `R-01`,
      // a format that skill has never asked for — a gate checking a shape its own prompt never specified.
      [/\b[A-Z]{2,}-\d+\b/.test(t), "no requirement IDs in the CAT-NN form the skill specifies"],
      [/^#{1,3}\s*problem\b/im.test(t), "no problem statement"],
      [t.length >= 600, "too short to be a PRD"],
    ],
  },
  {
    id: "architecture", skill: "sch-architecture", artifact: ".sch-loop/ARCHITECTURE.md",
    reads: [".sch-loop/PRD.md", ".sch-loop/BRAINSTORM.md"],
    substantive: t => [
      [/```mermaid/.test(t), "no mermaid diagram — the diagram is the point of this stage"],
      [/^#{1,3}\s*(responsibilit|component)/im.test(t), "no responsibility or component map"],
      [t.length >= 600, "too short to be an architecture"],
    ],
  },
  {
    id: "plan", skill: "sch-plan", artifact: ".sch-loop/PLAN.md",
    reads: [".sch-loop/ARCHITECTURE.md", ".sch-loop/PRD.md"],
    substantive: t => [
      [/^##+\s*Phase\s+\d/m.test(t), "no `## Phase N` headings — sch-tickets slices on these"],
      [t.length >= 400, "too short to be a plan"],
    ],
  },
];

export const stageById = id => STAGES.find(s => s.id === id) || null;

const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), "utf8"); } catch { return null; } };

// Why a stage is or is not complete. A stage whose artifact is present but hollow is NOT complete, and
// the reason is reported rather than left for someone to notice downstream.
export function stageStatus(projectRoot, stage) {
  const text = read(projectRoot, stage.artifact);
  if (text === null) return { id: stage.id, complete: false, why: "not written yet" };
  const failures = stage.substantive(text).filter(([ok]) => !ok).map(([, why]) => why);
  return failures.length
    ? { id: stage.id, complete: false, why: `${stage.artifact} exists but is not substantive: ${failures.join("; ")}` }
    : { id: stage.id, complete: true, why: `${stage.artifact}, ${text.length} chars` };
}

export function stageReport(projectRoot) { return STAGES.map(s => stageStatus(projectRoot, s)); }

// The first incomplete stage. Null means the front half is done and sch-tickets is next.
export function nextStage(projectRoot) {
  const hit = STAGES.find(s => !stageStatus(projectRoot, s).complete);
  return hit || null;
}

export const goal = projectRoot => (read(projectRoot, GOAL_FILE) || "").trim() || null;

export function setGoal(projectRoot, text) {
  const f = path.join(projectRoot, GOAL_FILE);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `# Goal\n\n${String(text).trim()}\n`);
  return f;
}

// The skill file IS the instructions. Keeping the prose there means it can be edited without touching
// the engine, and the engine never grows a second, quietly diverging copy of the same guidance.
// Skills live at `<engine>/skills/` in a checkout and at `<project>/.claude/skills/` once installed —
// sch-setup deliberately puts them where the CLI can see them, which is NOT under `.claude/sch/`.
// Looking in only one of those is why the first live run of this died on a path that does not exist in
// an installed project.
export function skillsRoots({ engineRoot, projectRoot }) {
  return [engineRoot && path.join(engineRoot, "skills"), projectRoot && path.join(projectRoot, ".claude", "skills")].filter(Boolean);
}

export function skillBody(roots, skill) {
  const candidates = (Array.isArray(roots) ? roots : [path.join(roots, "skills")]).map(r => path.join(r, skill, "SKILL.md"));
  const hit = candidates.find(f => fs.existsSync(f));
  if (!hit) throw new Error(`skill ${skill} not found in ${candidates.join(" or ")}`);
  return fs.readFileSync(hit, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

export function stagePrompt({ stage, instructions, goalText, inputs, projectRoot }) {
  return [
    `You are running the ${stage.id.toUpperCase()} stage of the SCH-LOOP lifecycle for the project at ${projectRoot}.`,
    "",
    "Your instructions are the skill below. Follow it exactly.",
    "",
    "--- SKILL: " + stage.skill + " ---",
    instructions,
    "--- END SKILL ---",
    "",
    goalText ? `THE GOAL THIS PROJECT WAS STARTED FOR:\n${goalText}` : "",
    "",
    ...inputs.map(i => `--- INPUT ${i.rel} ---\n${i.text}\n--- END ${i.rel} ---`),
    "",
    "You may read the repository to ground what you write. You cannot write files; that is done for you.",
    "",
    `Reply with ONLY the finished contents of ${stage.artifact}, as markdown, starting at its top-level`,
    "heading. No preamble, no explanation, no code fence around the whole document.",
    "",
    "Do not ask questions. Where a real answer is unavailable, write the line as",
    '"Assumption — needs validation via <method>" and carry on. Never invent a fact and present it as known.',
  ].filter(l => l !== "").join("\n");
}

// Strip a fence the model wrapped the whole document in anyway, which is the single most common way this
// output arrives malformed.
export function cleanDocument(text) {
  let t = String(text || "").trim();
  const whole = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*)\n```$/);
  if (whole) t = whole[1].trim();
  return t;
}

export async function runStage({
  projectRoot, engineRoot, stage, seat, config = {}, goalText = null,
  ask = callSeat, timeoutMs = 20 * 60_000, force = false,
}) {
  const st = stageStatus(projectRoot, stage);
  if (st.complete && !force) return { id: stage.id, skipped: true, ...st };

  // A stage cannot be run before the stage it reads from. Without this the PRD seat is handed an empty
  // BRAINSTORM and writes a confident document about nothing.
  const missing = stage.reads.filter(rel => {
    const prior = STAGES.find(s => s.artifact === rel);
    return prior ? !stageStatus(projectRoot, prior).complete : read(projectRoot, rel) === null;
  });
  if (missing.length) throw new Error(`${stage.id} needs ${missing.join(", ")} first — run the earlier stage`);

  const goalNow = goalText || goal(projectRoot);
  if (stage.needsGoal && !goalNow) throw new Error(`${stage.id} needs a goal: pass --goal "<what you want built>" (it is kept in ${GOAL_FILE})`);
  if (goalText) setGoal(projectRoot, goalText);

  const inputs = stage.reads.map(rel => ({ rel, text: read(projectRoot, rel) })).filter(i => i.text);
  const prompt = stagePrompt({ stage, instructions: skillBody(skillsRoots({ engineRoot, projectRoot }), stage.skill), goalText: goalNow, inputs, projectRoot });

  appendEvent(projectRoot, { type: "stage.start", stage: stage.id, artifact: stage.artifact });
  const started = Date.now();
  let answer;
  try {
    answer = await ask(seat, { prompt, system: `You produce the ${stage.id} document for a software project. You write nothing to disk.`, cwd: projectRoot, mode: "review", timeoutMs });
  } catch (e) {
    appendEvent(projectRoot, { type: "stage.failed", stage: stage.id, error: e.message });
    throw new Error(`${stage.id} seat failed: ${e.message}`);
  }

  const doc = cleanDocument(answer.text);
  if (!doc) {
    appendEvent(projectRoot, { type: "stage.failed", stage: stage.id, error: "empty document" });
    throw new Error(`${stage.id} produced nothing`);
  }

  // Written first, then judged. A rejected draft stays on disk as `<artifact>.rejected` so the next
  // attempt starts from something rather than from a description of what was wrong with it.
  const target = path.join(projectRoot, stage.artifact);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const failures = stage.substantive(doc).filter(([ok]) => !ok).map(([, why]) => why);
  if (failures.length) {
    fs.writeFileSync(target + ".rejected", doc);
    appendEvent(projectRoot, { type: "stage.rejected", stage: stage.id, failures });
    throw new Error(`${stage.id} came back hollow: ${failures.join("; ")} — draft kept at ${stage.artifact}.rejected`);
  }
  fs.writeFileSync(target, doc.endsWith("\n") ? doc : doc + "\n");

  advanceLifecycle(projectRoot, stage.id);
  appendEvent(projectRoot, { type: "stage.done", stage: stage.id, chars: doc.length, ms: Date.now() - started });
  await notify(projectRoot, `SCH ✓ ${stage.id} written — ${stage.artifact}`, { config, level: "info" });

  const after = nextStage(projectRoot);
  return { id: stage.id, ok: true, artifact: stage.artifact, chars: doc.length, ms: Date.now() - started, next: after ? after.id : "tickets" };
}

// `lifecycle_stage` is what `go` reads to decide where it is. It had never moved because nothing ever
// moved it.
export function advanceLifecycle(projectRoot, completedStageId) {
  const f = path.join(projectRoot, ".sch-loop", "state.json");
  let s = {};
  try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* a missing state file is rebuilt below */ }
  const after = nextStage(projectRoot);
  s.lifecycle_stage = (after ? after.id : "tickets").toUpperCase();
  s.last_event = `STAGE_${completedStageId.toUpperCase()}_DONE`;
  s.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
  return s.lifecycle_stage;
}

// Turning the plan into the queue. This is the seam where the front half hands over to the loop, and it
// is the one stage whose output is structured rather than prose — so it is validated as data, ticket by
// ticket, before a single line reaches task.md.
//
// Same rule as the rest: the seat proposes, code disposes. A rejected ticket is named with its reason
// rather than quietly dropped, because a requirement that falls out here is a planning error nobody
// would otherwise see.
export function ticketsPrompt({ instructions, plan, architecture, prd, projectRoot }) {
  return [
    `You are turning an approved plan into the executable queue for the project at ${projectRoot}.`,
    "",
    "--- SKILL: sch-tickets ---",
    instructions,
    "--- END SKILL ---",
    "",
    `--- .sch-loop/PLAN.md ---\n${plan}\n--- END PLAN ---`,
    architecture ? `--- .sch-loop/ARCHITECTURE.md ---\n${architecture}\n--- END ARCHITECTURE ---` : "",
    prd ? `--- .sch-loop/PRD.md ---\n${prd}\n--- END PRD ---` : "",
    "",
    "Read the repository so `allowed_paths` and `read_first` name files that will really exist or really do.",
    "",
    "Do NOT run any command. Reply with ONLY a JSON array of ticket objects, in the order they should run,",
    "using exactly the field names the skill documents. Every ticket needs: phase, phaseName, type, title,",
    "size, action, acceptance. Code types (build, test, chore) also need allowed_paths and verify.",
    "`verify` commands are argv arrays and must be able to fail.",
    "",
    "No prose, no markdown fence, no commentary. The array is the whole reply.",
  ].filter(Boolean).join("\n");
}

export function parseTickets(text) {
  let t = cleanDocument(text);
  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) t = fence[1].trim();
  const i = t.indexOf("["), j = t.lastIndexOf("]");
  if (i < 0 || j <= i) throw new Error("the seat did not return a JSON array of tickets");
  const arr = JSON.parse(t.slice(i, j + 1));
  if (!Array.isArray(arr) || !arr.length) throw new Error("the seat returned an empty ticket list");
  return arr;
}

export async function runTicketsStage({
  projectRoot, engineRoot, seat, config = {}, ask = callSeat, timeoutMs = 20 * 60_000,
  write = null, force = false,
}) {
  const plan = read(projectRoot, ".sch-loop/PLAN.md");
  if (!plan) throw new Error("no .sch-loop/PLAN.md — run the plan stage first");
  const planStage = stageById("plan");
  const ps = stageStatus(projectRoot, planStage);
  if (!ps.complete) throw new Error(`the plan is not ready: ${ps.why}`);

  const existing = (read(projectRoot, "task.md") || "").match(/^- \[[ ~x!?]\] T\d/gm) || [];
  if (existing.length && !force) return { skipped: true, why: `task.md already holds ${existing.length} ticket(s) — use --force to add more`, tickets: existing.length };

  const { writeTicket } = write ? { writeTicket: write } : await import("./tickets.mjs");
  const prompt = ticketsPrompt({
    instructions: skillBody(skillsRoots({ engineRoot, projectRoot }), "sch-tickets"),
    plan, architecture: read(projectRoot, ".sch-loop/ARCHITECTURE.md"), prd: read(projectRoot, ".sch-loop/PRD.md"),
    projectRoot,
  });

  appendEvent(projectRoot, { type: "stage.start", stage: "tickets", artifact: "task.md" });
  const started = Date.now();
  let answer;
  try { answer = await ask(seat, { prompt, system: "You turn an approved plan into an executable ticket queue. You write nothing to disk and you run no commands.", cwd: projectRoot, mode: "review", timeoutMs }); }
  catch (e) { appendEvent(projectRoot, { type: "stage.failed", stage: "tickets", error: e.message }); throw new Error(`tickets seat failed: ${e.message}`); }

  const proposed = parseTickets(answer.text);

  // Each ticket is validated as it is written, and a rejection is named. Dropping one silently would
  // lose a requirement between the plan and the queue, which is the one thing this seam must not do.
  const written = [], rejected = [];
  for (const t of proposed) {
    try { written.push(writeTicket(projectRoot, t)); }
    catch (e) { rejected.push({ title: t?.title || "(untitled)", error: e.message }); }
  }
  if (!written.length) {
    appendEvent(projectRoot, { type: "stage.rejected", stage: "tickets", failures: rejected.map(r => r.error) });
    throw new Error(`every proposed ticket was invalid: ${rejected.map(r => `${r.title}: ${r.error}`).join(" | ")}`);
  }

  advanceLifecycle(projectRoot, "tickets");
  appendEvent(projectRoot, { type: "stage.done", stage: "tickets", written: written.length, rejected: rejected.length, ms: Date.now() - started });
  await notify(projectRoot, `SCH ✓ ${written.length} ticket(s) queued from the plan${rejected.length ? `, ${rejected.length} rejected` : ""}`, { config, level: rejected.length ? "warn" : "info" });
  return { ok: true, written: written.map(t => t.id), rejected, ms: Date.now() - started };
}
