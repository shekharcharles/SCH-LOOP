#!/usr/bin/env node
// SCH-LOOP fence 3 of 3: PreToolUse guard for Bash. Blocks destructive commands
// a bypass-permissions executor must never run. Exit 2 blocks; reason on stderr.
// Sources: GSD executor prohibitions (#2075 git clean, #3542 git stash), ECC safety-guard.

const BLOCKED = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, "rm -rf"],
  [/\bgit\s+(-C\s+\S+\s+)?reset\s+--hard\b/, "git reset --hard"],
  [/\bgit\s+(-C\s+\S+\s+)?push\b[^|;&]*(--force\b|-f\b|--force-with-lease\b)/, "git push --force"],
  [/\bgit\s+(-C\s+\S+\s+)?clean\b/, "git clean (deletes untracked work in worktrees)"],
  [/\bgit\s+(-C\s+\S+\s+)?stash\b/, "git stash (stash list is shared across worktrees)"],
  [/\bgit\s+(-C\s+\S+\s+)?checkout\s+(--\s+)?\.(\s|$)/, "git checkout -- . (blanket discard)"],
  [/\bgit\s+(-C\s+\S+\s+)?restore\s+\.(\s|$)/, "git restore . (blanket discard)"],
  [/\bgit\s+(-C\s+\S+\s+)?add\s+(-A\b|--all\b|\.(\s|$))/, "git add -A / git add . (stage files individually)"],
  [/\bgit\s+(-C\s+\S+\s+)?update-ref\s+refs\/heads\//, "git update-ref on a branch"],
  [/--no-verify\b/, "--no-verify (hook bypass)"],
  [/\bdrop\s+(table|database|schema)\b/i, "DROP TABLE/DATABASE"],
  [/\bdd\s+if=/, "dd"],
  [/\bmkfs\b/, "mkfs"],
  [/\bchmod\s+(-R\s+)?777\b/, "chmod 777"],
  [/\b(npm|pnpm|yarn|bun|pip|pip3|cargo)\s+(install|add|i)\s+\S/, "package install (human gate — open a `human` ticket)"],
  [/\bcurl\b[^|]*\|\s*(ba)?sh\b/, "curl | sh"],
];

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => raw += c);
process.stdin.on("end", () => {
  let d; try { d = JSON.parse(raw); } catch { process.exit(0); }
  if (d.tool_name !== "Bash") process.exit(0);
  const cmd = typeof d.tool_input?.command === "string" ? d.tool_input.command : "";
  for (const [re, label] of BLOCKED) {
    if (re.test(cmd)) { process.stderr.write(`[sch destructive-bash] BLOCKED: ${label}. Command: ${cmd.slice(0, 200)}\n`); process.exit(2); }
  }
  process.exit(0);
});
