// The distributed worker seam: the transport contract, the cross-host lease
// predicate, the credential-free job envelope, and the LOOPBACK transport that
// exercises all of it end to end.
//
// There is no broker and no second machine here. Everything below runs in this
// process, on this filesystem. What is proven is the SEAM — the contract, the
// refusals and the lease arithmetic. What is NOT proven is that any of it works
// over a network; see docs/adr/0009-the-distributed-worker-seam.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixture, initWorkspace, addTask, fakeExecutor, run, RUN, SECRET_ENV, ROOT, url } from "./helpers.mjs";

const RW = await import(url(join(ROOT, "scripts", "remoteworker.mjs")));

const iso = (ms) => new Date(Date.now() + ms).toISOString();

// A transport that lies about what it can do, so the refusals can be tested
// without inventing a network.
class StubTransport extends RW.WorkerTransport {
  constructor(caps) { super(); this.caps = caps; }
  get id() { return "stub"; }
  capabilities() { return this.caps; }
  dispatch() { throw new Error("this transport must never be dispatched to"); }
}

// ------------------------------------------------------------- the contract

test("remote seam: a transport that cannot return the workspace is refused before anything runs", async () => {
  const exec = new RW.RemoteExecutor({ transport: new StubTransport({ shared_workspace: false, heartbeat: true, cancellable: true }) });
  const prep = await exec.prepare();
  assert.equal(prep.ok, false);
  assert.equal(prep.problems[0].code, "POLICY_VIOLATION");
  assert.match(prep.problems[0].message, /evidence/i, "the refusal must name the reason: the evidence cannot come back");
});

test("remote seam: a worker whose liveness cannot be observed may not hold a lease", async () => {
  const exec = new RW.RemoteExecutor({ transport: new StubTransport({ shared_workspace: true, heartbeat: false, cancellable: true }) });
  const prep = await exec.prepare();
  assert.equal(prep.ok, false);
  assert.equal(prep.problems[0].code, "POLICY_VIOLATION");
  assert.match(prep.problems[0].message, /heartbeat/i);
});

test("remote seam: a worker that cannot be cancelled is refused — SCH owns the kill", async () => {
  const exec = new RW.RemoteExecutor({ transport: new StubTransport({ shared_workspace: true, heartbeat: true, cancellable: false }) });
  const prep = await exec.prepare();
  assert.equal(prep.ok, false);
  assert.match(prep.problems[0].message, /cancel/i);
});

// ------------------------------------------------------------ credentials

test("remote seam: the job envelope carries no environment at all", () => {
  const job = RW.buildJob({
    identity: { run_id: "RUN-1", project_id: "p", task_id: "1", attempt: 1 },
    cwd: "/somewhere", prompt: "do the thing", args: ["-p"],
  });
  assert.equal(job.env, undefined, "a job must never carry an environment — the remote host builds its own");
  assert.equal(job.identity.run_id, "RUN-1");
  assert.deepEqual(RW.credentialLeaks(job, process.env), []);
});

test("remote seam: a credential value anywhere in the envelope refuses the dispatch", () => {
  const secret = "ghp_" + "9".repeat(36);
  const env = { GITHUB_TOKEN: secret, PATH: "/usr/bin" };
  const job = RW.buildJob({ identity: { run_id: "RUN-2" }, cwd: "/w", prompt: `use ${secret} to push` });
  assert.deepEqual(RW.credentialLeaks(job, env), ["GITHUB_TOKEN"]);
  assert.throws(() => RW.assertCredentialFree(job, env), /GITHUB_TOKEN/);
});

test("remote seam: the operator's model credentials are not shipped either", () => {
  const key = "sk-ant-" + "a".repeat(40);
  const env = { ANTHROPIC_API_KEY: key };
  const job = RW.buildJob({ identity: { run_id: "RUN-3" }, cwd: "/w", prompt: key });
  assert.deepEqual(RW.credentialLeaks(job, env), ["ANTHROPIC_API_KEY"],
    "the local executor passes ANTHROPIC_API_KEY to its child; a remote worker authenticates on its own machine");
});

// ------------------------------------------------------------- the lease

test("remote lease: a pid is evidence only on the machine that owns it", () => {
  const live = { host_id: RW.HOST_ID, pid: process.pid, run_id: "R", expires_at: iso(60_000) };
  assert.equal(RW.holderLiveness(live).basis, "pid");
  assert.equal(RW.holderLive(live), true);

  // The same pid number, claimed by another machine. It IS alive here, and that
  // says nothing whatsoever about the holder.
  const foreignSilent = { host_id: "another-machine", pid: process.pid, run_id: "R",
    expires_at: iso(60_000), heartbeat_at: iso(-10 * 60_000) };
  const l = RW.holderLiveness(foreignSilent);
  assert.equal(l.basis, "heartbeat", "a foreign holder's pid must never be consulted");
  assert.equal(l.live, false);

  // A pid that does not exist here at all, with a fresh heartbeat: alive.
  const foreignFresh = { host_id: "another-machine", pid: 999_999_99, run_id: "R",
    expires_at: iso(60_000), heartbeat_at: iso(-100) };
  assert.equal(RW.holderLive(foreignFresh), true);
  assert.equal(RW.holderLiveness(foreignFresh).basis, "heartbeat");
});

test("remote lease: a silent remote holder is not live, and not recoverable either", () => {
  const silent = { host_id: "another-machine", pid: 4321, run_id: "R",
    expires_at: iso(-60_000), heartbeat_at: iso(-10 * 60_000) };
  const l = RW.holderLiveness(silent);
  assert.equal(l.live, false);
  assert.equal(l.recoverable, false, "nothing here can prove the remote worker stopped, so nothing here may take its lease");
  assert.match(l.reason, /another machine/i);

  // A LOCAL holder that is gone is recoverable exactly as before.
  const gone = { host_id: RW.HOST_ID, pid: 999_999_99, run_id: "R", expires_at: iso(-60_000) };
  assert.equal(RW.holderLiveness(gone).recoverable, true);
  // …and so is a legacy lease written before host_id existed.
  assert.equal(RW.holderLiveness({ pid: 999_999_99, run_id: "R", expires_at: iso(-60_000) }).recoverable, true);
});

test("remote lease: acquireLease refuses a stale foreign lease instead of stealing it", () => {
  const fx = fixture("rw-lease"); const wsDir = initWorkspace(fx);
  const t = addTask(fx);
  const p = RUN.leasePath(wsDir, t);
  writeFileSync(p, JSON.stringify({
    schema_version: 1, project_id: fx.P, task_id: String(t), run_id: "RUN-ELSEWHERE",
    host_id: "another-machine", pid: 4321,
    acquired_at: iso(-60 * 60_000), heartbeat_at: iso(-59 * 60_000), expires_at: iso(-30 * 60_000),
  }, null, 2));

  const got = RUN.acquireLease(wsDir, { projectId: fx.P, taskId: t, runId: "RUN-HERE" });
  assert.equal(got.ok, false);
  assert.equal(got.failure.code, "LEASE_CONFLICT");
  assert.match(got.failure.message, /another-machine/);
  assert.ok(existsSync(p), "the foreign lease file is left exactly where it was");
  assert.equal(JSON.parse(readFileSync(p, "utf8")).run_id, "RUN-ELSEWHERE");

  // A stale LOCAL lease is still recovered — the old behaviour is untouched.
  writeFileSync(p, JSON.stringify({ project_id: fx.P, task_id: String(t), run_id: "RUN-DEAD",
    pid: 999_999_99, acquired_at: iso(-60_000), expires_at: iso(-1000) }, null, 2));
  const again = RUN.acquireLease(wsDir, { projectId: fx.P, taskId: t, runId: "RUN-HERE" });
  assert.equal(again.ok, true);
  assert.equal(again.recovered.run_id, "RUN-DEAD");
  assert.equal(again.lease.host_id, RW.HOST_ID, "every lease now names the machine that holds it");
  fx.done();
});

// ---------------------------------------------------------------- loopback

test("loopback: a task runs end to end through the transport and is VERIFIED", async () => {
  const fx = fixture("rw-e2e"); initWorkspace(fx);
  const t = addTask(fx);
  const transport = new RW.LoopbackTransport({
    executor: fakeExecutor(fx, { write: [{ path: "src/remote.js", content: "from the seam\n" }] }),
    heartbeatMs: 20,
  });
  const exec = new RW.RemoteExecutor({ transport, heartbeatGraceMs: 5000 });
  assert.equal(exec.id, "remote:loopback");

  const rec = await run(fx, t, exec);
  assert.equal(rec.outcome, "VERIFIED", JSON.stringify(rec.failure));
  assert.equal(readFileSync(join(fx.repo, "src", "remote.js"), "utf8"), "from the seam\n");

  // it really went through the seam
  assert.equal(transport.dispatched.length, 1);
  const job = transport.dispatched[0];
  assert.equal(job.identity.run_id, rec.run_id);
  assert.equal(job.env, undefined);
  const wire = JSON.stringify(job);
  for (const [name, value] of Object.entries(SECRET_ENV))
    assert.ok(!wire.includes(value), `${name}'s value was about to be shipped to another machine`);

  // the run record names the machine the work happened on
  const w = JSON.parse(readFileSync(join(rec.run_dir, "worker.json"), "utf8"));
  assert.equal(w.host_id, transport.hostId);
  assert.equal(w.transport, "loopback");

  // liveness came FROM the worker, not from the coordinator's optimism
  assert.ok(exec.observed.heartbeats > 0, "the remote worker proved it was alive at least once");
  assert.ok(exec.observed.lease_renewals > 0, "each heartbeat renewed the lease");
  assert.equal(exec.observed.holder.host_id, transport.hostId);
  fx.done();
});

test("loopback: a remote worker that goes silent loses the lease and is cancelled", async () => {
  const fx = fixture("rw-silent"); initWorkspace(fx);
  const t = addTask(fx);
  const transport = new RW.LoopbackTransport({
    executor: fakeExecutor(fx, { sleepMs: 30_000, write: [{ path: "src/half.js", content: "half\n" }] }, { timeoutMs: 60_000 }),
    heartbeatMs: 20, maxHeartbeats: 2,          // then it stops talking, and keeps running
  });
  const exec = new RW.RemoteExecutor({ transport, heartbeatGraceMs: 400 });

  const rec = await run(fx, t, exec);
  assert.equal(rec.outcome, "FAILED");
  assert.equal(rec.failure.code, "LEASE_LOST");
  assert.match(rec.failure.message, /heartbeat/i);
  assert.match(rec.failure.message, /may still be running/i, "SCH cannot prove a silent remote worker stopped");
  assert.equal(transport.cancelled.length, 1, "the transport was asked to cancel — best effort, and recorded as such");
  fx.done();
});
