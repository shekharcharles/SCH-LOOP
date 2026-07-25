#!/usr/bin/env node
// SCH Loop — PreToolUse hook. Wired in a project's .claude/settings.json, it
// intercepts every Bash tool call; if the command is a `git commit`/`git push`,
// it runs secret-scan first and BLOCKS the commit when secrets are staged. This
// makes the secret gate unbypassable — even if the agent forgets to run it.
//
// Hook contract: reads the tool payload on stdin; exit 0 = allow, exit 2 = block
// (stderr is shown to the agent).

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCAN = join(dirname(fileURLToPath(import.meta.url)), "secret-scan.mjs");

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let cmd = "";
  try { cmd = JSON.parse(input)?.tool_input?.command || ""; } catch {}
  // Only gate real commits/pushes; everything else passes straight through.
  if (!/\bgit\b[\s\S]*\b(commit|push)\b/.test(cmd)) process.exit(0);
  try {
    execFileSync("node", [SCAN], { stdio: ["ignore", "ignore", "ignore"] }); // exit 0 = clean
    process.exit(0);
  } catch {
    console.error("BLOCKED by secret-scan: staged changes contain a secret or a sensitive file (.env / key / CLAUDE.md). Remove it (use env vars) / gitignore it, re-stage, and try again. Do not bypass.");
    process.exit(2); // block the git commit/push
  }
});
