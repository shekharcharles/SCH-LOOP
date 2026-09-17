import fs from "node:fs/promises";
import path from "node:path";
import { SCH, ensureLayout } from "./util.mjs";

const LESSONS = () => path.join(SCH, "learning", "lessons.jsonl");

export async function appendLesson(lesson) {
  await ensureLayout();
  const row = {
    id: lesson.id || `LESSON-${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    source: lesson.source || "judge-rejection",
    ticketId: lesson.ticketId || null,
    category: lesson.category || "general",
    failure: lesson.failure,
    preventiveRule: lesson.preventiveRule,
    paths: lesson.paths || [],
    tags: lesson.tags || []
  };
  await fs.appendFile(LESSONS(), JSON.stringify(row)+"\n", "utf8");
  return row;
}

export async function readLessons() {
  await ensureLayout();
  try {
    const txt = await fs.readFile(LESSONS(), "utf8");
    return txt.split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
  } catch { return []; }
}

export async function relevantLessons({ticketId, paths=[], tags=[]}={}) {
  const all = await readLessons();
  const wanted = new Set([...(paths||[]), ...(tags||[]), ticketId].filter(Boolean).map(x=>String(x).toLowerCase()));
  if (!wanted.size) return all.slice(-20);
  return all.filter(l => {
    const hay = [l.ticketId, l.category, ...(l.paths||[]), ...(l.tags||[])].filter(Boolean).map(x=>String(x).toLowerCase());
    return hay.some(x => [...wanted].some(w => x.includes(w) || w.includes(x)));
  }).slice(-30);
}
