#!/usr/bin/env node
// SCH Loop — push a notification (blocked question / task done / critical
// finding) to your phone. Formats correctly per service: ntfy wants a plain-text
// body + headers, Slack and Teams want their own JSON shapes. No webhook set →
// prints locally (harmless no-op), so the loop can always call it.
//
//   SCH_NOTIFY_WEBHOOK=<url> node scripts/notify.mjs "CR-4821 blocked: need creds" \
//     [--title "SCH Loop"] [--tags warning] [--priority high] [--click <url>]

const args = process.argv.slice(2);
const FLAGS = new Set(["title", "tags", "priority", "click"]);
const flag = (name, def = "") => { const i = args.indexOf("--" + name); return i !== -1 ? (args[i + 1] ?? def) : def; };
// the message is everything that is neither a flag nor a flag's value
const msg = args.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const prev = args[i - 1];
  return !(prev && prev.startsWith("--") && FLAGS.has(prev.slice(2)));
}).join(" ").trim() || "(no message)";

const title = flag("title", "SCH Loop");
const url = process.env.SCH_NOTIFY_WEBHOOK;

if (!url) { console.log(`[notify] ${title}: ${msg}  (set SCH_NOTIFY_WEBHOOK to push to your phone)`); process.exit(0); }

let opts;
if (/ntfy\./i.test(url)) {
  // ntfy: the BODY is the message text; title/tags/priority ride in headers.
  // (Posting JSON here is what produced the raw-JSON notification.)
  // HTTP headers are ByteStrings — non-ASCII (em dash, accents, emoji) throws.
  // The body is UTF-8 and keeps them; the title is flattened to safe ASCII.
  const asciiTitle = title.replace(/[‐-―]/g, "-").replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"').replace(/[^\x20-\x7E]/g, "").trim() || "SCH Loop";
  const headers = { "content-type": "text/plain; charset=utf-8", Title: asciiTitle };
  const tags = flag("tags"); if (tags) headers.Tags = tags;
  const prio = flag("priority"); if (prio) headers.Priority = prio;
  const click = flag("click"); if (click) headers.Click = click;
  opts = { method: "POST", headers, body: msg };
} else if (url.includes("webhook.office.com")) {
  opts = { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ "@type": "MessageCard", "@context": "http://schema.org/extensions", summary: title, themeColor: "FF2A2A", title, text: msg }) };
} else {
  // Slack-compatible / generic JSON
  opts = { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `*${title}*\n${msg}`, title, message: msg }) };
}

try {
  const r = await fetch(url, opts);
  console.log(r.ok ? "[notify] sent" : `[notify] webhook returned ${r.status}`);
} catch (e) { console.log("[notify] failed: " + e.message + " (message not lost — it's on the dashboard)"); }
