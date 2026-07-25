#!/usr/bin/env node
// SCH Loop — push a notification (blocked question / task done / critical
// finding) to your phone. Posts to the webhook in SCH_NOTIFY_WEBHOOK; supports
// Slack, Microsoft Teams, and ntfy/generic JSON. No webhook set → prints locally
// (harmless no-op), so the loop can always call it.
//
//   SCH_NOTIFY_WEBHOOK=<url> node scripts/notify.mjs "CR-4821 blocked: need creds" [--title "SCH Loop"]

const args = process.argv.slice(2);
const ti = args.indexOf("--title");
const title = ti !== -1 ? args[ti + 1] : "SCH Loop";
const msg = args.filter((a, i) => a !== "--title" && i !== ti + (ti !== -1 ? 1 : -99)).join(" ").trim() || "(no message)";
const url = process.env.SCH_NOTIFY_WEBHOOK;

if (!url) { console.log(`[notify] ${title}: ${msg}  (set SCH_NOTIFY_WEBHOOK to push to your phone)`); process.exit(0); }

const body = url.includes("webhook.office.com")               // Microsoft Teams card
  ? { "@type": "MessageCard", "@context": "http://schema.org/extensions", summary: title, themeColor: "FF2A2A", title, text: msg }
  : { text: `*${title}*\n${msg}`, title, message: msg };       // Slack / ntfy / generic

try {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  console.log(r.ok ? "[notify] sent" : `[notify] webhook returned ${r.status}`);
} catch (e) { console.log("[notify] failed: " + e.message + " (message not lost — it's on the dashboard)"); }
