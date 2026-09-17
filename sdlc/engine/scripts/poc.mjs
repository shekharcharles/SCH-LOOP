#!/usr/bin/env node
// SCH Loop — PoC capture. Writes ONE reproducible proof file per finding, in a
// shape a client's engineer can re-run without the report next to them.
//
// finding-add refuses a validated finding whose evidence is missing, and a
// shared phase write-up is not a PoC for eight findings. That gate is only fair
// if capturing a PoC is easier than not doing it — this is that path.
//
//   # capture live (runs curl, records the real request and response)
//   node scripts/poc.mjs --project <id> --name idor-statement \
//     --url "https://api.example.com/v1/statements/9911" --method GET \
//     --header "Authorization: Bearer <tokenA>" --role broker-A \
//     --title "IDOR: broker A reads broker B's statement" \
//     --note "9911 belongs to broker B; A's token returns it in full"
//
//   # or record an exchange you already have (Playwright/Burp/decrypted body)
//   node scripts/poc.mjs --project <id> --name xss-search --from exchange.txt \
//     --title "Reflected XSS in q" --screenshot reports/evidence/xss-search.png
//
// Prints the project-relative path to pass straight to `finding-add --evidence`.

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { getProject } from "./state.mjs";

const argv = process.argv.slice(2);
const flags = {}; const many = { header: [] };
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const k = argv[i].slice(2);
  if (k === "header") many.header.push(argv[++i]); else flags[k] = argv[++i];
}
const die = (m) => { console.error("error: " + m); process.exit(1); };

const projectId = flags.project || process.env.SCH_PROJECT || die("need --project <id>");
const proj = getProject(projectId) || die("no such project: " + projectId);
const home = proj.path || die(`project ${projectId} has no path — set one with project-meta`);
const name = (flags.name || die("need --name <short-slug>")).toLowerCase().replace(/[^a-z0-9]+/g, "-");

// Redact anything that would put a live credential in a deliverable. The PoC
// must prove the issue, not hand the reader a working token.
const KEEP = flags["keep-secrets"] === "true";
const redact = (s) => KEEP ? s : String(s)
  .replace(/(Authorization:\s*Bearer\s+)[\w.\-]+/gi, "$1<REDACTED-TOKEN>")
  .replace(/(Cookie:\s*)(.+)/gi, (_, p) => p + "<REDACTED-COOKIES>")
  .replace(/("?(?:password|passwd|pwd|otp|pin|secret|api[_-]?key)"?\s*[:=]\s*"?)([^",&\s]+)/gi, "$1<REDACTED>");

let exchange;
if (flags.from) {
  exchange = readFileSync(flags.from, "utf8");
} else if (flags.url) {
  // -i keeps the response headers; --max-time stops a hung target wedging a pass
  const args = ["-s", "-i", "--max-time", flags.timeout || "30", "-X", (flags.method || "GET").toUpperCase()];
  for (const h of many.header) args.push("-H", h);
  if (flags.data) args.push("--data-binary", flags.data);
  args.push(flags.url);
  const shown = ["curl", ...args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a))].join(" ");
  let res;
  try { res = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }); }
  catch (e) { res = (e.stdout || "") + "\n[curl exited " + e.status + "] " + (e.stderr || ""); }
  exchange = `$ ${redact(shown)}\n\n${res}`;
} else {
  die("need --url (capture live) or --from <file> (record an exchange you already have)");
}

const body = exchange.length > 20000 ? exchange.slice(0, 20000) + "\n\n[...truncated — full capture kept out of the report...]" : exchange;
const shot = flags.screenshot ? `\n## Screenshot\n\n![proof](${flags.screenshot.replace(/^\.?\//, "")})\n` : "";
const md = `# PoC — ${flags.title || name}

| | |
|---|---|
| **Captured** | ${new Date().toISOString()} |
| **Target** | ${flags.url || flags.target || "(see exchange)"} |
| **Role / account** | ${flags.role || "anon"}${flags.account ? ` (${flags.account})` : ""} |
| **Preconditions** | ${flags.preconditions || "none beyond the stated role"} |

## What this proves

${flags.note || "_(state, in one sentence, what an attacker gains here)_"}

## Reproduce

\`\`\`http
${redact(body)}
\`\`\`
${shot}
---
_Credentials and tokens are redacted. Captured by SCH Loop for ${proj.client || projectId}; confidential._
`;

const rel = join("reports", "evidence", name + ".md").replace(/\\/g, "/");
const abs = join(home, rel);
if (existsSync(abs) && flags.overwrite !== "true") die(`${rel} already exists — pass --overwrite true, or use a different --name`);
mkdirSync(dirname(abs), { recursive: true });
writeFileSync(abs, md);
console.log(rel);
