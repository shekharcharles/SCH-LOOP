#!/usr/bin/env node
// SCH Loop — the distributed worker seam.
//
// WHAT THIS IS
// `executor.mjs` made the PROVIDER swappable. This file makes the MACHINE
// swappable: a `WorkerTransport` is "somewhere a job can be run", and
// `RemoteExecutor` is an ordinary `AgentExecutor` that runs jobs through one. The
// runner does not change at all.
//
// WHAT THIS IS NOT
// There is no broker here, no protocol on a wire, and no second machine. The only
// transport that ships is LOOPBACK — same process, same filesystem — which proves
// the CONTRACT and nothing about a network. Everything that a network would break
// is written down here as a refusal rather than a hope. See
// docs/adr/0009-the-distributed-worker-seam.md for what is unproven.
//
// The three things that are actually hard, and where each is handled:
//
//   1. LEASES. A lease is proof that exactly one worker owns a task. Locally that
//      proof is `pidAlive`. Across machines a pid is meaningless — pid 4321 on
//      another host may well be alive here, belonging to something else entirely.
//      `holderLiveness` therefore decides liveness DIFFERENTLY depending on who
//      holds the lease, and refuses to recover a foreign one at all.
//   2. EVIDENCE. Every inspection SCH performs — git effects, territory
//      fingerprints, deterministic verification — reads the local filesystem. A
//      transport that cannot put the worker's changes on that filesystem produces
//      a run nobody can verify, so `prepare()` REFUSES it.
//   3. CREDENTIALS. A job envelope carries no environment. Not a filtered one —
//      none. The remote host builds its own from its own allowlist, and a job
//      containing the value of any credential-shaped variable is refused before
//      it is dispatched.

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { AgentExecutor } from "./executor.mjs";
import { writeAtomic } from "./workspace.mjs";

export const SCHEMA_VERSION = 1;

// How often a worker must prove it is alive, and how long silence is tolerated
// before its lease stops counting. The grace is deliberately several intervals:
// one lost heartbeat is a slow disk, three is a dead machine.
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_GRACE_MS = 45_000;

// Which machine this is. `hostname()` is not a strong identity — two hosts can
// share a name — so an operator running more than one worker host must set
// SCH_HOST_ID. A collision here means two machines' leases are indistinguishable,
// which is the one failure this whole file exists to prevent.
export const hostId = (env = process.env) => String(env.SCH_HOST_ID || hostname() || "unknown-host");
export const HOST_ID = hostId();

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const ts = (v) => { const n = Date.parse(v ?? ""); return Number.isFinite(n) ? n : null; };

// ------------------------------------------------------------------- leases

// Is the holder of this lease still working?
//
// The answer depends on WHO holds it, and pretending otherwise is how a lease
// gets stolen from a live worker:
//
//   same host (or a legacy lease with no host at all) → the pid IS the proof.
//   another host → the pid is not ours to read. Only a heartbeat that machine
//                  wrote counts, and staleness is the only signal available.
//
// `recoverable` is separate from `live` on purpose. A dead LOCAL holder can be
// recovered: the operating system just told us its process is gone. A silent
// REMOTE holder cannot: silence is not death, nothing here can kill it, and
// taking its lease would put two workers in one worktree. That is a decision for
// a person, so this says so rather than guessing.
export function holderLiveness(held, { now = Date.now(), host = HOST_ID, graceMs = HEARTBEAT_GRACE_MS } = {}) {
  if (!held || typeof held !== "object")
    return { live: false, basis: "none", recoverable: true, reason: "no lease" };
  const expires = ts(held.expires_at);
  const expired = expires === null || expires < now;
  const holder = held.host_id ?? null;

  if (holder === null || holder === host) {
    const alive = Boolean(held.pid) && pidAlive(Number(held.pid));
    return {
      live: !expired && alive, basis: "pid", recoverable: true,
      reason: `pid ${held.pid}, expires ${held.expires_at}`,
    };
  }

  const beat = ts(held.heartbeat_at) ?? ts(held.acquired_at);
  const fresh = beat !== null && now - beat <= graceMs;
  return {
    live: !expired && fresh, basis: "heartbeat", recoverable: false,
    reason: fresh
      ? `held by ${holder}, another machine, heartbeat ${held.heartbeat_at}`
      : `held by ${holder}, another machine, whose last heartbeat was ${held.heartbeat_at ?? "never"} — nothing here can prove it stopped`,
  };
}

export const holderLive = (held, opts) => holderLiveness(held, opts).live;

// Renew a lease from a heartbeat that CAME FROM THE WORKER. A coordinator that
// renews on its own schedule is recording its own liveness under the worker's
// name, which is worse than not renewing at all.
//
// `host_id` becomes the WORKER's host — so if this coordinator dies, the next
// process to read the file sees a foreign holder and refuses to steal it. `pid`
// is left alone (it is the coordinator's, kept for forensics); the worker's pid,
// if the transport knows one, is recorded separately and is never used as proof.
export function renewLease(file, { runId = null, host = null, pid = null, at = new Date(), ttlMs = HEARTBEAT_GRACE_MS } = {}) {
  let held = null;
  try { held = JSON.parse(readFileSync(file, "utf8")); } catch { return { ok: false, reason: "LEASE_LOST", detail: "the lease file is gone" }; }
  if (runId && held.run_id !== runId)
    return { ok: false, reason: "LEASE_LOST", detail: `the lease now belongs to run ${held.run_id}` };
  const lease = {
    ...held,
    host_id: host ?? held.host_id ?? HOST_ID,
    worker_pid: pid ?? held.worker_pid ?? null,
    heartbeat_at: at.toISOString(),
    expires_at: new Date(at.getTime() + ttlMs).toISOString(),
  };
  try { writeAtomic(file, JSON.stringify(lease, null, 2)); } catch (e) { return { ok: false, reason: "LEASE_LOST", detail: e.message }; }
  return { ok: true, lease };
}

// --------------------------------------------------------------- the envelope

// Everything a worker needs, and nothing that identifies this machine's secrets.
// Note what is ABSENT: no environment, no PATH, no home directory, no token, no
// git config. A worker host builds its own environment from its own allowlist —
// which is `executor.mjs`'s ENV_ALLOW, applied there, not shipped from here.
export function buildJob({ identity = {}, cwd, prompt, args = [], workspace = null, timeoutMs = null } = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    identity: {
      run_id: identity.run_id ?? null, project_id: identity.project_id ?? null,
      task_id: identity.task_id != null ? String(identity.task_id) : null,
      attempt: identity.attempt ?? null, phase_id: identity.phase_id ?? null,
      semantic: identity.semantic ?? null,
    },
    // The path the work happens at. Under a shared filesystem it is this path;
    // under anything else it is a path on the worker's disk that SCH cannot
    // inspect — which is why `prepare()` refuses that case today.
    cwd, workspace: workspace ?? { mode: "shared_filesystem", path: cwd },
    args: (Array.isArray(args) ? args : []).map(String),
    prompt: String(prompt ?? ""),
    timeout_ms: timeoutMs,
    dispatched_by: HOST_ID, dispatched_at: new Date().toISOString(),
  };
}

// A variable whose NAME says it holds a credential. Deliberately broad: a false
// positive costs a refused dispatch, a false negative ships a token to another
// machine. ANTHROPIC_API_KEY matches — the local executor passes it to its own
// child, and a remote worker authenticates on its own host instead.
const CREDENTIAL_NAME = /(token|secret|password|passwd|api[-_]?key|auth|credential|askpass|cookie|private[-_]?key)/i;
const SHORTEST_CREDENTIAL = 8;

// Which credentials from THIS environment appear in the envelope. Scans values,
// not just keys: a secret pasted into a prompt is the same leak as one in an env
// block, and the prompt is the part of a job most likely to have picked one up.
export function credentialLeaks(job, env = process.env) {
  const wire = JSON.stringify(job ?? {});
  const hits = [];
  if (job && job.env !== undefined) hits.push("job.env");
  for (const [name, value] of Object.entries(env)) {
    if (!CREDENTIAL_NAME.test(name)) continue;
    if (typeof value !== "string" || value.length < SHORTEST_CREDENTIAL) continue;
    if (wire.includes(value)) hits.push(name);
  }
  return hits;
}

export function assertCredentialFree(job, env = process.env) {
  const hits = credentialLeaks(job, env);
  if (hits.length)
    throw new Error(`refusing to dispatch: the job envelope carries ${hits.join(", ")} — credentials never leave this machine`);
  return job;
}

// -------------------------------------------------------- transport contract

// "Somewhere a job can be run." Four members, one of which is optional.
//
// `dispatch` resolves as soon as the job is ACCEPTED, with a durable claim and
// the promise of a result — because a transport that only had a single
// request/response could never be reconnected to after a dropped link.
export class WorkerTransport {
  get id() { throw new Error("transport must declare an id"); }
  // Every field here is load-bearing; see RemoteExecutor.prepare().
  capabilities() { return { shared_workspace: false, heartbeat: false, cancellable: false }; }
  async prepare() { return { ok: true, problems: [] }; }
  // → { claim, host_id, result: Promise<worker record> }
  async dispatch() { throw new Error("transport must implement dispatch()"); }
  // Best effort by definition: a message to another machine is not a kill.
  async cancel() { return { ok: false, proof: "none" }; }
}

// ------------------------------------------------------------------ loopback

// The seam, exercised without a network: the job goes to an executor in THIS
// process, on THIS filesystem, and the liveness signal is a timer rather than a
// message. It is a faithful implementation of the contract and a dishonest model
// of a network — it cannot drop a packet, partition, or clock-skew. Its value is
// that every refusal, every lease renewal and every cancellation path above is
// executed end to end by the real runner.
export class LoopbackTransport extends WorkerTransport {
  constructor({ executor, hostId: host = HOST_ID, heartbeatMs = HEARTBEAT_INTERVAL_MS, maxHeartbeats = Infinity } = {}) {
    super();
    this.executor = executor;
    this.hostId = host;
    this.heartbeatMs = heartbeatMs;
    // A test hook, and the only way to simulate the failure that matters most:
    // a worker that stops talking while still running.
    this.maxHeartbeats = maxHeartbeats;
    this.dispatched = [];
    this.cancelled = [];
    this._cancelled = new Set();
    this._n = 0;
  }

  get id() { return "loopback"; }
  capabilities() {
    return {
      shared_workspace: true, heartbeat: true, cancellable: true,
      note: "same process, same filesystem — this proves the contract, not the network",
    };
  }
  async prepare() { return this.executor?.prepare?.() ?? { ok: true, problems: [] }; }

  async dispatch(job, { onHeartbeat = () => {}, onEvent = () => {} } = {}) {
    const claim = `LOOPBACK-${++this._n}-${Date.now().toString(36)}`;
    this.dispatched.push(job);
    let beats = 0, pid = null;
    const beat = () => {
      if (beats >= this.maxHeartbeats) return;
      beats += 1;
      try { onHeartbeat({ claim, host_id: this.hostId, pid, at: new Date().toISOString() }); } catch { /* the worker is not punished for the coordinator */ }
    };
    beat();                                   // accepted IS the first proof of life
    const timer = setInterval(beat, this.heartbeatMs);
    timer.unref?.();

    const result = this.executor.execute({
      cwd: job.cwd, prompt: job.prompt, identity: job.identity, extraArgs: job.args,
      isCancelled: () => this._cancelled.has(claim),
      onEvent: (type, payload) => { if (payload?.pid) pid = payload.pid; onEvent(type, { ...payload, host_id: this.hostId, transport: this.id }); },
    }).finally(() => clearInterval(timer));

    return { claim, host_id: this.hostId, result };
  }

  async cancel(claim, reason = "cancelled by SCH") {
    this.cancelled.push({ claim, reason, at: new Date().toISOString() });
    this._cancelled.add(claim);
    try { this.executor.cancel?.(reason); } catch { /* recorded below either way */ }
    // In-process, so this one IS provable. A network transport must return
    // "requested" here and must never claim more.
    return { ok: true, proof: "in-process kill; a network transport has no such proof" };
  }
}

// ------------------------------------------------------------ the executor

// An ordinary AgentExecutor whose child happens to be somewhere else. The runner
// hands it a job the same way it hands one to ClaudeCliExecutor and gets back the
// same record shape.
export class RemoteExecutor extends AgentExecutor {
  constructor({ transport, leaseFile = null, heartbeatGraceMs = HEARTBEAT_GRACE_MS, env = process.env } = {}) {
    super();
    this.transport = transport;
    this.leaseFile = leaseFile;
    this.graceMs = Number(heartbeatGraceMs) || HEARTBEAT_GRACE_MS;
    this.parentEnv = env;
    this._claim = null;
    this._cancelReason = null;
    // What actually happened to the liveness contract, for the run record and
    // for anyone asking "did this thing ever prove it was alive?".
    this.observed = { heartbeats: 0, lease_renewals: 0, holder: null, last_heartbeat_at: null };
  }

  get id() { return `remote:${this.transport?.id ?? "unknown"}`; }
  capabilities() {
    const c = this.transport?.capabilities?.() ?? {};
    return { fresh_context: true, streaming: false, cancellable: Boolean(c.cancellable), structured_handoff: true, distributed: true, transport: this.transport?.id ?? null, ...c };
  }

  // The three refusals. Each one is a property a network silently removes, and a
  // run that proceeds without it produces evidence nobody can trust.
  async prepare() {
    const problems = [];
    if (!this.transport) problems.push({ code: "ENVIRONMENT_MISSING", message: "no transport configured — a remote executor without a transport has nowhere to run" });
    const c = this.transport?.capabilities?.() ?? {};
    if (this.transport && !c.shared_workspace)
      problems.push({ code: "POLICY_VIOLATION", message: `transport "${this.transport.id}" cannot put the worker's changes on this filesystem — git effects, territory fingerprints and verification all read local disk, so its evidence could never be inspected. Returning a workspace from a remote host is NOT implemented.` });
    if (this.transport && !c.heartbeat)
      problems.push({ code: "POLICY_VIOLATION", message: `transport "${this.transport.id}" reports no heartbeat — a worker whose liveness cannot be observed may not hold a task lease` });
    if (this.transport && !c.cancellable)
      problems.push({ code: "POLICY_VIOLATION", message: `transport "${this.transport.id}" cannot cancel a running job — SCH owns the timeout and the kill, never the worker` });
    const t = this.transport ? await this.transport.prepare() : { ok: false, problems: [] };
    problems.push(...(t.problems ?? []));
    return { ok: problems.length === 0, problems };
  }

  cancel(reason = "operator cancelled") {
    this._cancelReason = reason;
    if (this._claim) { try { this.transport.cancel(this._claim, reason); } catch { /* best effort, as documented */ } }
  }

  async execute({ cwd, prompt, identity = {}, extraArgs = [], isCancelled = () => false, onEvent = () => {}, leaseFile = null } = {}) {
    const started = Date.now();
    const base = {
      executable: null, args: [], cwd, pid: null, started_at: new Date(started).toISOString(),
      ended_at: null, duration_ms: 0, stdout: "", stderr: "", exit_code: null, signal: null,
      timed_out: false, cancelled: false, cleanup: null, stdout_evidence: null, stderr_evidence: null,
      environment_names: [],
      // Where the work happened, on the record. A run whose evidence cannot name
      // its machine is not auditable once more than one machine exists.
      transport: this.transport?.id ?? null, host_id: null, claim: null, distributed: true,
      heartbeats: 0,
    };
    const fail = (code, message, extra = {}) => ({
      ...base, ...extra, ended_at: new Date().toISOString(), duration_ms: Date.now() - started,
      ok: false, failure: { code, message },
    });

    const prep = await this.prepare();
    if (!prep.ok) return fail(prep.problems[0].code, prep.problems[0].message);

    const job = buildJob({ identity, cwd, prompt, args: extraArgs, workspace: { mode: "shared_filesystem", path: cwd } });
    try { assertCredentialFree(job, this.parentEnv); }
    catch (e) { return fail("POLICY_VIOLATION", e.message); }

    const lease = leaseFile ?? this.leaseFile;
    let last = Date.now(), lost = null;
    const onHeartbeat = (beat) => {
      last = Date.now();
      this.observed.heartbeats += 1;
      this.observed.last_heartbeat_at = beat?.at ?? new Date().toISOString();
      this.observed.holder = { host_id: beat?.host_id ?? null, pid: beat?.pid ?? null };
      if (!lease) return;
      const r = renewLease(lease, { runId: identity.run_id, host: beat?.host_id, pid: beat?.pid, ttlMs: this.graceMs });
      if (r.ok) this.observed.lease_renewals += 1;
      else lost = r;
    };

    let d;
    try { d = await this.transport.dispatch(job, { onHeartbeat, onEvent }); }
    catch (e) { return fail("AGENT_PROCESS_FAILURE", `transport "${this.transport.id}" refused the job: ${e.message}`); }
    this._claim = d.claim;
    base.claim = d.claim ?? null;
    base.host_id = d.host_id ?? this.observed.holder?.host_id ?? null;

    // The watchdog. It answers one question — "is the machine holding this task
    // still talking to us?" — and it is the only thing standing between a silent
    // remote worker and a second worker in the same worktree.
    const tick = Math.max(10, Math.min(250, Math.floor(this.graceMs / 4)));
    const verdict = await new Promise((done) => {
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; clearInterval(poll); done(v); };
      const poll = setInterval(() => {
        if (lost) return finish({ kind: "lease_lost", detail: lost.detail });
        if (Date.now() - last > this.graceMs) return finish({ kind: "silent", after_ms: Date.now() - last });
        let want = false;
        try { want = Boolean(isCancelled()); } catch { want = false; }
        if (want || this._cancelReason) return finish({ kind: "cancelled" });
      }, tick);
      d.result.then((record) => finish({ kind: "done", record }), (e) => finish({ kind: "error", error: e }));
    });

    // Anything other than a clean finish means telling the other machine to stop
    // — and then waiting for whatever record it produces anyway, because a
    // partial record of a run that touched the repository is evidence.
    let record = verdict.record ?? null, cancelProof = null;
    if (verdict.kind !== "done") {
      const reason = verdict.kind === "cancelled" ? (this._cancelReason ?? "run cancelled")
        : verdict.kind === "silent" ? `no heartbeat for ${verdict.after_ms}ms`
        : "the lease is no longer ours";
      try { cancelProof = await this.transport.cancel(d.claim, reason); }
      catch (e) { cancelProof = { ok: false, proof: `cancel failed: ${e.message}` }; }
      try { record = await d.result; } catch { record = null; }
    }
    this._claim = null;

    const host = base.host_id ?? this.observed.holder?.host_id ?? null;
    const merged = {
      ...base, ...(record ?? {}),
      transport: this.transport.id, host_id: host, claim: d.claim ?? null, distributed: true,
      heartbeats: this.observed.heartbeats,
      remote_cancel: cancelProof,
      ended_at: new Date().toISOString(), duration_ms: Date.now() - started,
    };

    if (verdict.kind === "silent")
      return { ...merged, ok: false, cancelled: true, failure: { code: "LEASE_LOST",
        message: `the worker on ${host ?? "the remote host"} stopped sending heartbeats ${verdict.after_ms}ms ago; SCH asked the transport to cancel the job but cannot prove it stopped — it may still be running there, so this task's lease will not be handed to anyone else automatically` } };
    if (verdict.kind === "lease_lost")
      return { ...merged, ok: false, cancelled: true, failure: { code: "LEASE_LOST", message: `this run no longer holds the task lease: ${verdict.detail}` } };
    if (verdict.kind === "cancelled")
      return { ...merged, ok: false, cancelled: true, failure: { code: "CANCELLED", message: this._cancelReason ?? "run cancelled" } };
    if (verdict.kind === "error")
      return { ...merged, ok: false, failure: { code: "AGENT_PROCESS_FAILURE", message: `transport "${this.transport.id}" failed: ${verdict.error?.message ?? verdict.error}` } };
    return merged;
  }
}
