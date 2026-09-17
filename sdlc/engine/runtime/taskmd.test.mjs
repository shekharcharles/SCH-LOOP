import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, next, setStatus, insert, recount } from "./taskmd.mjs";

const SAMPLE = `# task.md — lab
<!-- legend -->

## Phase 1 — Foundation   (2/4 done)
- [x] T1.1-login-tracer  build  Tracer: login end-to-end          deps:-     size:S
- [x] T1.2-auth-tests    test   Contract tests for /auth            deps:T1.1  size:S
- [~] T1.3-reset-flow    build  Password reset flow                 deps:T1.2  size:M
- [ ] T1.4-reset-email   human  Verify reset email renders          deps:T1.3  gate:blocking-human

## Phase 2 — Profiles   (0/2 done)
- [ ] T2.1-resize-spike  spike  Evaluate image-resize lib           deps:-     size:S  council:true
- [ ] T2.2-avatar-upload build  Avatar upload                       deps:T2.1,T1.3  size:M
`;

test("parse reads phases, tickets, fields", () => {
  const doc = parse(SAMPLE);
  assert.equal(doc.phases.length, 2);
  assert.equal(doc.phases[0].id, "1");
  assert.equal(doc.phases[0].tickets.length, 4);
  const t = doc.phases[0].tickets[3];
  assert.deepEqual({ id: t.id, slug: t.slug, status: t.status, type: t.type, deps: t.deps, gate: t.fields.gate },
    { id: "T1.4", slug: "reset-email", status: "?".replace("?", " "), type: "human", deps: ["T1.3"], gate: "blocking-human" });
  assert.equal(doc.phases[1].tickets[1].deps.join(","), "T2.1,T1.3");
  assert.equal(doc.phases[1].tickets[0].fields.council, "true");
});

test("next picks first pending ticket whose deps are all done, top to bottom", () => {
  // T1.3 is in progress, T1.4 depends on it → blocked; T2.1 has no deps → next
  assert.equal(next(parse(SAMPLE)).id, "T2.1");
  const done = setStatus(SAMPLE, "T1.3", "x");
  assert.equal(next(parse(done)).id, "T1.4");
});

test("next returns null when nothing is dispatchable", () => {
  const text = setStatus(setStatus(SAMPLE, "T2.1", "!"), "T2.2", "!");
  assert.equal(next(parse(text)), null);
});

test("setStatus changes only that line and the phase counter", () => {
  const out = setStatus(SAMPLE, "T1.3", "x");
  const a = SAMPLE.split("\n"), b = out.split("\n");
  assert.equal(a.length, b.length);
  const changed = a.map((l, i) => l !== b[i] ? i : -1).filter(i => i >= 0);
  assert.deepEqual(changed, [3, 6]);
  assert.match(b[3], /\(3\/4 done\)/);
  assert.match(b[6], /^- \[x\] T1\.3-reset-flow/);
});

test("insert after a ticket gets a suffix id and lands right below it", () => {
  const out = insert(SAMPLE, { after: "T1.3", slug: "reset-rate-limit", type: "build", title: "Rate-limit reset endpoint", deps: ["T1.3"], size: "S" });
  const doc = parse(out);
  const ids = doc.phases[0].tickets.map(t => t.id);
  assert.deepEqual(ids, ["T1.1", "T1.2", "T1.3", "T1.3a", "T1.4"]);
  assert.match(out, /\(2\/5 done\)/);
  const again = insert(out, { after: "T1.3", slug: "reset-audit", type: "docs", title: "Audit log entry", deps: ["T1.3a"], size: "XS" });
  assert.deepEqual(parse(again).phases[0].tickets.map(t => t.id), ["T1.1", "T1.2", "T1.3", "T1.3a", "T1.3b", "T1.4"]);
  // inserted ticket is dispatched before T1.4 once T1.3 is done
  assert.equal(next(parse(setStatus(out, "T1.3", "x"))).id, "T1.3a");
});

test("insert at phase end gets the next integer id", () => {
  const out = insert(SAMPLE, { phase: "2", slug: "avatar-crop", type: "build", title: "Crop avatar", deps: ["T2.2"], size: "S" });
  assert.deepEqual(parse(out).phases[1].tickets.map(t => t.id), ["T2.1", "T2.2", "T2.3"]);
  assert.match(out, /- \[ \] T2\.3-avatar-crop\s+build\s+Crop avatar\s+deps:T2\.2\s+size:S/);
});

test("insert rejects unknown anchors and duplicate slugs are fine", () => {
  assert.throws(() => insert(SAMPLE, { after: "T9.9", slug: "x", type: "build", title: "x", deps: [], size: "S" }), /T9\.9/);
  assert.throws(() => insert(SAMPLE, { phase: "7", slug: "x", type: "build", title: "x", deps: [], size: "S" }), /phase 7/);
});

test("recount rewrites stale counters only", () => {
  const stale = SAMPLE.replace("(2/4 done)", "(0/9 done)");
  assert.equal(recount(stale), SAMPLE);
});

test("insert can open a phase that does not exist yet, and only when named", () => {
  const empty = "# task.md\n<!-- legend -->\n\n(empty)\n";
  assert.throws(() => insert(empty, { phase: "1", slug: "a", type: "build", title: "A", deps: [] }), /pass phaseName/);
  const out = insert(empty, { phase: "1", phaseName: "Foundation", slug: "first", type: "build", title: "First", deps: [], size: "S" });
  const doc = parse(out);
  assert.equal(doc.phases.length, 1);
  assert.equal(doc.phases[0].name, "Foundation");
  assert.deepEqual(doc.phases[0].tickets.map(t => t.id), ["T1.1"]);
  assert.match(out, /\(0\/1 done\)/);
  // a later phase is created above an existing higher-numbered one, keeping numeric order
  const two = insert(insert(out, { phase: "3", phaseName: "Later", slug: "c", type: "docs", title: "C", deps: [] }), { phase: "2", phaseName: "Middle", slug: "b", type: "build", title: "B", deps: [] });
  assert.deepEqual(parse(two).phases.map(p => p.id), ["1", "2", "3"]);
});
