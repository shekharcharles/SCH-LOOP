#!/usr/bin/env node
// SCH Loop — PreToolUse hook. Wired in a project's .claude/settings.json, it
// intercepts every Bash tool call; if the command is a `git commit`/`git push`,
// it runs secret-scan first and BLOCKS the commit when secrets are staged. This
// makes the secret gate unbypassable — even if the agent forgets to run it.
//
// Hook contract: reads the tool payload on stdin; exit 0 = allow, exit 2 = block
// (stderr is shown to the agent).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCAN = join(dirname(fileURLToPath(import.meta.url)), "secret-scan.mjs");

const block = (why) => { console.error("BLOCKED by secret-scan: " + why); process.exit(2); };

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let cmd = "";
  try { cmd = JSON.parse(input)?.tool_input?.command || ""; } catch { process.exit(0); } // unparseable payload = not a git command we can gate
  // Only gate real commits/pushes; everything else passes straight through.
  if (!/\bgit\b[\s\S]*\b(commit|push)\b/.test(cmd)) process.exit(0);
  // FAIL CLOSED: never allow the commit unless the scanner ran and said clean.
  if (!existsSync(SCAN)) block("the scanner is missing — cannot verify this commit is clean.");
  let out;
  try {
    out = execFileSync("node", [SCAN], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // exit 1 = findings; anything else = the scanner itself failed. Both block.
    return block(e.status === 1
      ? "staged changes contain a secret or a sensitive file (.env / key / CLAUDE.md). Remove it (use env vars) / gitignore it, re-stage, and retry. Do not bypass."
      : `the scanner failed to run (${e.message}) — refusing the commit rather than risking a leak.`);
  }
  if (!/CLEAN/.test(out)) block("the scanner did not report CLEAN — refusing the commit.");
  process.exit(0);
});
