#!/usr/bin/env node
// SCH Loop — CERT-In report generator. Reads a project's findings + scope and
// writes a client-ready report (Markdown + self-contained print-to-PDF HTML) to
// projects/<id>/reports/. Called by sch-ship, or directly:
//
//   node scripts/report.mjs --project <id> [--author "Name"] [--classification Confidential]

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadState, getProject, coverageSummary } from "./state.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) f[argv[i].slice(2)] = argv[++i];
  return f;
}

const SEV_ORDER = ["critical", "high", "medium", "low", "info"];
const sevRank = (s) => { const i = SEV_ORDER.indexOf((s || "info").toLowerCase()); return i === -1 ? 99 : i; };
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const today = () => new Date().toISOString().slice(0, 10);

// Overall risk = worst validated severity present.
function overallRisk(validated) {
  for (const s of SEV_ORDER) if (validated.some((f) => (f.severity || "").toLowerCase() === s)) return s;
  return "informational";
}

export function buildReport(projectId, opts = {}) {
  const p = getProject(projectId);
  if (!p) throw new Error("no such project: " + projectId);
  const s = loadState(projectId);
  const sc = p.scope || {};
  const findings = s.findings || [];
  const validated = findings.filter((f) => f.status === "validated").sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.id - b.id);
  const clean = findings.filter((f) => f.status === "tested-clean");
  // Everything that is neither a confirmed issue nor a proven-clean class:
  // observations, candidates, and the COVERAGE GAP entries an honest tester
  // records when a cell could not be reached. These were being dropped on the
  // floor — one engagement had nine, four of them coverage gaps, and the report
  // silently claimed complete coverage anyway. A gap you cannot see is worse
  // than one you can: it reads as tested.
  const open = findings.filter((f) => !["validated", "tested-clean", "false-positive"].includes(f.status))
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.id - b.id);
  const gaps = open.filter((f) => /coverage gap|not tested|untested|could not/i.test(`${f.title} ${f.notes || ""}`));

  // THE COVERAGE GATE. A report that omits an untested cell does not read as
  // silent — it reads as tested and clean, which is a false statement to a
  // regulated client. Every cell must be resolved: tested, or honestly marked
  // blocked/not-applicable with a reason.
  const cov = coverageSummary(s);
  if (cov.byStatus.untested && !opts.forceCoverage) {
    throw new Error(
      `COVERAGE INCOMPLETE — ${cov.byStatus.untested} of ${cov.total} cell(s) are still untested, so this report cannot claim coverage.\n` +
      cov.untestedCells.map((c) => "  · " + c).join("\n") +
      `\nTest them, or mark each honestly: coverage-set --status blocked --note "<what stopped you>" | --status not-applicable --note "<why>".\n` +
      `Override only with the operator's agreement: --force-coverage (the report will say the matrix is incomplete).`);
  }

  const author = opts.author || "SCH Loop assessment team";
  const classification = opts.classification || "Confidential";
  const reportId = `${(p.client || p.name || projectId).replace(/[^A-Za-z0-9]+/g, "-")}-${projectId}-${today()}`.toUpperCase();

  const counts = {}; for (const sev of SEV_ORDER) counts[sev] = validated.filter((f) => (f.severity || "").toLowerCase() === sev).length;
  const risk = overallRisk(validated);

  const meta = {
    reportId, client: p.client || "—", engagement: p.name || projectId, domain: p.domain,
    ref: sc.ref || "—", targets: (sc.targets || []).join(", ") || "—",
    date: today(), author, classification,
    compliance: (sc.compliance || []), counts, risk,
    validated, clean, open, gaps, total: findings.length,
    cov, coverage: s.coverage || [], forced: !!opts.forceCoverage && !!cov.byStatus.untested,
  };
  const md = renderMarkdown(meta);
  const html = renderHtml(meta);

  const dir = join(ROOT, "projects", projectId, "reports");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, reportId);
  writeFileSync(base + ".md", md);
  writeFileSync(base + ".html", html);
  return { md: base + ".md", html: base + ".html", reportId, counts, risk };
}

function sevTableRows(counts) {
  return SEV_ORDER.map((s) => `| ${s[0].toUpperCase() + s.slice(1)} | ${counts[s]} |`).join("\n");
}

function renderMarkdown(m) {
  const findingBlocks = m.validated.length ? m.validated.map((f, i) => `
### ${i + 1}. ${f.title}  — **${(f.severity || "info").toUpperCase()}**

| | |
|---|---|
| **Category / ID** | ${f.category || "—"} |
| **Severity** | ${f.severity || "—"} |
| **CVSS v3.1** | ${f.cvss || "—"} |
| **Target** | ${f.target || m.targets} |
| **Status** | ${f.status} |

**Description / Impact**
${f.notes || "See evidence."}

**Evidence:** ${f.evidence || "(attached separately)"}
`).join("\n---\n") : "\n_No exploitable findings validated._\n";

  const cleanList = m.clean.length
    ? m.clean.map((f) => `- ${f.category ? f.category + " — " : ""}${f.title}`).join("\n")
    : "_None recorded._";

  const openList = m.open.length
    ? m.open.map((f) => `- **${(f.severity || "info").toUpperCase()}** — ${f.title}${f.target ? ` (${f.target})` : ""}\n  ${(f.notes || "").split("\n")[0]}`).join("\n")
    : "_None recorded._";

  const compliance = m.compliance.length
    ? m.compliance.map((c) => `- **${c}** — findings mapped to applicable controls; see per-finding categories.`).join("\n")
    : "_No compliance frameworks specified for this engagement._";

  return `# Penetration Test Report — ${m.engagement}

**Report ID:** ${m.reportId}
**Client:** ${m.client}
**Engagement type:** ${m.domain}
**Authorization ref:** ${m.ref}
**Scope:** ${m.targets}
**Date:** ${m.date}
**Author:** ${m.author}
**Classification:** ${m.classification}

---

## 1. Executive summary

This report presents the results of an authorized ${m.domain} assessment of the
scope listed above, conducted under authorization reference ${m.ref}. The
assessment identified **${m.validated.length} validated finding(s)**. The overall
risk rating is **${m.risk.toUpperCase()}**, driven by the highest-severity
validated issue.

### Severity summary

| Severity | Count |
|---|---|
${sevTableRows(m.counts)}

## 2. Findings
${findingBlocks}

## 3. Controls that held (tested-clean coverage)

The following classes were tested and no issue was found — recorded to
demonstrate coverage (zero false negatives), not omission:

${cleanList}

## 4. Observations and coverage gaps

Recorded but not carried as validated findings: observations whose impact is
conditional, and classes that could **not** be tested in this engagement. Listed
so coverage is claimed honestly — an untested cell is stated, never implied clean.

${openList}

## 5. Compliance mapping

${compliance}

## 6. Methodology & coverage

Testing followed the SCH Loop ${m.domain} methodology (OWASP WSTG / ASVS / API
Top-10 as applicable), phase by phase, with coverage tracked per endpoint ×
class × role. Total tracked test outcomes: ${m.total}
(${m.validated.length} validated, ${m.clean.length} tested-clean,
${m.open.length} observed/untested${m.gaps.length ? ` — including ${m.gaps.length} explicit coverage gap(s)` : ""}).

### Coverage matrix

${m.cov.total ? `**${m.cov.covered} of ${m.cov.total} cells covered (${m.cov.pct}%)** — \
${m.cov.byStatus.validated} validated, ${m.cov.byStatus["tested-clean"]} tested-clean, \
${m.cov.byStatus.blocked} blocked, ${m.cov.byStatus["not-applicable"]} not applicable\
${m.cov.byStatus.untested ? `, **${m.cov.byStatus.untested} UNTESTED**` : ""}.

| Endpoint | Class | Role | Outcome | Note |
|---|---|---|---|---|
${m.coverage.map((c) => `| ${c.endpoint} | ${c.class} | ${c.role} | ${c.status}${c.finding ? ` (#${c.finding})` : ""} | ${(c.note || "").split("\n")[0]} |`).join("\n")}` : "_No coverage matrix was declared for this engagement._"}
${m.forced ? "\n> **This matrix is incomplete.** The report was generated with the coverage gate overridden; the untested cells above were not assessed and must not be read as clean.\n" : ""}

---
_Generated by SCH Loop. ${m.classification}. Distribute only to authorized
recipients of ${m.client}._
`;
}

function renderHtml(m) {
  const badge = (sev) => `<span class="sev ${sev}">${sev.toUpperCase()}</span>`;
  const rows = m.validated.map((f, i) => `
    <div class="finding">
      <h3>${i + 1}. ${esc(f.title)} ${badge((f.severity || "info").toLowerCase())}</h3>
      <table class="kv">
        <tr><th>Category / ID</th><td>${esc(f.category || "—")}</td></tr>
        <tr><th>CVSS v3.1</th><td>${esc(f.cvss || "—")}</td></tr>
        <tr><th>Target</th><td>${esc(f.target || m.targets)}</td></tr>
        <tr><th>Status</th><td>${esc(f.status)}</td></tr>
        ${(f.parents && f.parents.length) ? `<tr><th>Attack chain</th><td>chained from finding(s) #${f.parents.join(", #")} (depth ${f.chainDepth})</td></tr>` : ""}
      </table>
      <p class="desc">${esc(f.notes || "See evidence.")}</p>
      <p class="ev"><strong>Evidence:</strong> ${esc(f.evidence || "(attached separately)")}</p>
    </div>`).join("") || "<p><em>No exploitable findings validated.</em></p>";

  const sevRows = SEV_ORDER.map((s) => `<tr><td>${badge(s)}</td><td>${m.counts[s]}</td></tr>`).join("");
  const clean = m.clean.length ? "<ul>" + m.clean.map((f) => `<li>${esc(f.category ? f.category + " — " : "")}${esc(f.title)}</li>`).join("") + "</ul>" : "<p><em>None recorded.</em></p>";
  const comp = m.compliance.length ? "<ul>" + m.compliance.map((c) => `<li><strong>${esc(c)}</strong> — findings mapped to applicable controls.</li>`).join("") + "</ul>" : "<p><em>None specified.</em></p>";
  const openHtml = m.open.length ? "<ul>" + m.open.map((f) => `<li>${badge((f.severity || "info").toLowerCase())} ${esc(f.title)}${f.target ? ` <em>(${esc(f.target)})</em>` : ""}<br><span class="ev">${esc((f.notes || "").split("\n")[0])}</span></li>`).join("") + "</ul>" : "<p><em>None recorded.</em></p>";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(m.reportId)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font: 12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; color:#111; max-width:900px; margin:auto; padding:24px; }
  h1 { font-size:22px; border-bottom:3px solid #c00; padding-bottom:8px; }
  h2 { font-size:16px; margin-top:28px; border-bottom:1px solid #ddd; padding-bottom:4px; }
  h3 { font-size:14px; margin:0 0 8px; }
  table { border-collapse:collapse; width:100%; margin:8px 0; }
  th,td { border:1px solid #ccc; padding:6px 9px; text-align:left; vertical-align:top; }
  table.kv th { width:150px; background:#f6f6f6; }
  .meta td { border:0; padding:2px 8px 2px 0; } .meta th { border:0; text-align:left; width:170px; padding:2px 0; }
  .sev { font-size:10px; font-weight:700; padding:2px 7px; border-radius:3px; color:#fff; }
  .critical{background:#7c0000}.high{background:#c00}.medium{background:#e67e00}.low{background:#2a7}.info{background:#777}
  .finding { border:1px solid #e2e2e2; border-left:4px solid #c00; padding:10px 14px; margin:12px 0; page-break-inside:avoid; }
  .desc { white-space:pre-wrap; } .ev { color:#555; font-size:11px; }
  .cls { float:right; font-size:10px; color:#c00; border:1px solid #c00; padding:2px 8px; text-transform:uppercase; }
  footer { margin-top:30px; border-top:1px solid #ddd; padding-top:8px; color:#777; font-size:10px; }
</style></head><body>
  <span class="cls">${esc(m.classification)}</span>
  <h1>Penetration Test Report — ${esc(m.engagement)}</h1>
  <table class="meta">
    <tr><th>Report ID</th><td>${esc(m.reportId)}</td></tr>
    <tr><th>Client</th><td>${esc(m.client)}</td></tr>
    <tr><th>Engagement type</th><td>${esc(m.domain)}</td></tr>
    <tr><th>Authorization ref</th><td>${esc(m.ref)}</td></tr>
    <tr><th>Scope</th><td>${esc(m.targets)}</td></tr>
    <tr><th>Date</th><td>${esc(m.date)}</td></tr>
    <tr><th>Author</th><td>${esc(m.author)}</td></tr>
    <tr><th>Overall risk</th><td>${badge(m.risk === "informational" ? "info" : m.risk)}</td></tr>
  </table>
  <h2>1. Executive summary</h2>
  <p>Authorized ${esc(m.domain)} assessment conducted under authorization reference
     ${esc(m.ref)}. <strong>${m.validated.length}</strong> validated finding(s). Overall risk:
     <strong>${esc(m.risk.toUpperCase())}</strong>.</p>
  <table><tr><th>Severity</th><th>Count</th></tr>${sevRows}</table>
  <h2>2. Findings</h2>
  ${rows}
  <h2>3. Controls that held (tested-clean coverage)</h2>
  ${clean}
  <h2>4. Observations and coverage gaps</h2>
  <p>Recorded but not carried as validated findings: observations whose impact is
     conditional, and classes that could <strong>not</strong> be tested. Listed so
     coverage is claimed honestly — an untested cell is stated, never implied clean.</p>
  ${openHtml}
  <h2>5. Compliance mapping</h2>
  ${comp}
  <h2>6. Methodology &amp; coverage</h2>
  <p>SCH Loop ${esc(m.domain)} methodology (OWASP WSTG / ASVS / API Top-10 as applicable),
     phase by phase, coverage tracked per endpoint × class × role. Total outcomes:
     ${m.total} (${m.validated.length} validated, ${m.clean.length} tested-clean,
     ${m.open.length} observed/untested${m.gaps.length ? ` — including ${m.gaps.length} explicit coverage gap(s)` : ""}).</p>
  ${m.cov.total ? `<p><strong>${m.cov.covered} of ${m.cov.total} coverage cells covered (${m.cov.pct}%)</strong> —
     ${m.cov.byStatus.validated} validated, ${m.cov.byStatus["tested-clean"]} tested-clean,
     ${m.cov.byStatus.blocked} blocked, ${m.cov.byStatus["not-applicable"]} not applicable${m.cov.byStatus.untested ? `, <strong>${m.cov.byStatus.untested} untested</strong>` : ""}.</p>
  <table><tr><th>Endpoint</th><th>Class</th><th>Role</th><th>Outcome</th><th>Note</th></tr>
  ${m.coverage.map((c) => `<tr><td>${esc(c.endpoint)}</td><td>${esc(c.class)}</td><td>${esc(c.role)}</td><td>${esc(c.status)}${c.finding ? ` (#${c.finding})` : ""}</td><td>${esc((c.note || "").split("\n")[0])}</td></tr>`).join("")}
  </table>` : "<p><em>No coverage matrix was declared for this engagement.</em></p>"}
  ${m.forced ? `<p style="border:2px solid #c00;padding:8px"><strong>This matrix is incomplete.</strong> The report was generated with the coverage gate overridden; the untested cells above were not assessed and must not be read as clean.</p>` : ""}
  <footer>Generated by SCH Loop · ${esc(m.classification)} · Distribute only to authorized recipients of ${esc(m.client)}. Open in a browser and Print → Save as PDF.</footer>
</body></html>`;
}

if (process.argv[1] && process.argv[1].endsWith("report.mjs")) {
  const argv = process.argv.slice(2);
  const f = parseFlags(argv);
  if (!f.project) { console.error("need --project <id>"); process.exit(1); }
  try {
    const r = buildReport(f.project, { author: f.author, classification: f.classification,
      forceCoverage: argv.includes("--force-coverage") });
    console.log("report written:\n  " + r.md + "\n  " + r.html + "\n  risk: " + r.risk.toUpperCase());
  } catch (e) { console.error("error: " + e.message); process.exit(1); }
}
