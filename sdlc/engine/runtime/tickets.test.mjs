import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { slugify, validateTicket, writeTicket, loadTicket, ticketToBuildSpec, TICKET_TYPES } from "./tickets.mjs";

const TASK_MD = `# task.md — t
<!-- legend -->

## Phase 1 — Foundation   (0/1 done)
- [ ] T1.1-login-tracer  build  Tracer: login end-to-end  deps:-  size:S
`;

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sch-tickets-"));
  fs.mkdirSync(path.join(root, ".sch-loop", "tickets"), { recursive: true });
  fs.writeFileSync(path.join(root, "task.md"), TASK_MD);
  return root;
}

const good = () => ({
  id: "T1.2", type: "build", phase: "1", title: "Password reset flow", size: "M",
  deps: ["T1.1"], read_first: ["src/todo.mjs"], allowed_paths: ["src/**", "tests/**"],
  action: "Add reset flow.", acceptance: ["valid email → 202"], must_not: ["no test deleted"],
  verify: [{ name: "test", command: "npm", args: ["test"] }], requirements: ["AUTH-03"],
});

test("slugify makes ≤4-word kebab slugs", () => {
  assert.equal(slugify("Password reset flow"), "password-reset-flow");
  assert.equal(slugify("Rate-limit the /auth/reset endpoint (v2)!"), "rate-limit-the-auth-reset");
  assert.equal(slugify("  Tracer: login end-to-end (UI→API→DB) "), "tracer-login-end-to-end-ui");
});

test("validateTicket accepts a full build ticket and rejects broken ones", () => {
  assert.deepEqual(validateTicket(good()), []);
  assert.ok(validateTicket({ ...good(), type: "wizardry" }).some(e => /type/.test(e)));
  assert.ok(validateTicket({ ...good(), allowed_paths: [] }).some(e => /allowed_paths/.test(e)));
  assert.ok(validateTicket({ ...good(), verify: [{ name: "x", command: "npm test" }] }).some(e => /args|argv/.test(e)));
  assert.ok(validateTicket({ ...good(), acceptance: [] }).some(e => /acceptance/.test(e)));
  assert.ok(validateTicket({ ...good(), id: "T1.2-with-slug" }).some(e => /id/.test(e)));
  assert.ok(validateTicket({ ...good(), size: "XXL" }).some(e => /size/.test(e)));
});

test("non-build types relax TDD-specific fields", () => {
  const spike = { id: "T2.1", type: "spike", phase: "2", title: "Evaluate lib", size: "S", deps: [], action: "Try it", acceptance: ["decision written"], allowed_paths: [".sch-loop/reports/**"] };
  assert.deepEqual(validateTicket(spike), []);
  const human = { id: "T1.5", type: "human", phase: "1", title: "Check email", deps: ["T1.2"], action: "Open Gmail", acceptance: ["email renders"], gate: "blocking-human" };
  assert.deepEqual(validateTicket(human), []);
  assert.ok(TICKET_TYPES.includes("decision"));
});

test("writeTicket writes json and the task.md line; loadTicket reads it back", () => {
  const root = tmpProject();
  const t = writeTicket(root, { ...good(), id: undefined, after: "T1.1" });
  assert.equal(t.id, "T1.1a");
  assert.equal(t.slug, "password-reset-flow");
  assert.ok(fs.existsSync(path.join(root, ".sch-loop", "tickets", "T1.1a-password-reset-flow.json")));
  const md = fs.readFileSync(path.join(root, "task.md"), "utf8");
  assert.match(md, /- \[ \] T1\.1a-password-reset-flow\s+build\s+Password reset flow\s+deps:T1\.1\s+size:M/);
  assert.match(md, /\(0\/2 done\)/);
  assert.equal(loadTicket(root, "T1.1a").title, "Password reset flow");
  const t2 = writeTicket(root, { ...good(), id: undefined, phase: "1", title: "Avatar upload" });
  assert.equal(t2.id, "T1.2");
});

test("writeTicket refuses invalid tickets and never touches task.md", () => {
  const root = tmpProject();
  assert.throws(() => writeTicket(root, { ...good(), acceptance: [] }), /acceptance/);
  assert.equal(fs.readFileSync(path.join(root, "task.md"), "utf8"), TASK_MD);
});

test("ticketToBuildSpec maps to the engine's build spec", () => {
  const spec = ticketToBuildSpec(good(), "D:/proj");
  assert.equal(spec.ticketId, "T1.2");
  assert.deepEqual(spec.allowedPaths, ["src/**", "tests/**"]);
  assert.ok(spec.requirements.includes("valid email → 202"));
  assert.ok(spec.requirements.some(r => /MUST NOT: no test deleted/.test(r)));
  assert.deepEqual(spec.verificationChecks[0], { name: "test", command: "npm", args: ["test"] });
  assert.equal(spec.cwd, "D:/proj");
  assert.match(spec.ticket, /Password reset flow/);
  assert.match(spec.ticket, /read_first[\s\S]*src\/todo\.mjs/i);
});
