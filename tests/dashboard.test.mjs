// The control plane.
//
// The dashboard can halt a project, answer a blocked question and disarm scope.
// Before this it listened on every interface and asked nobody who they were, so
// these tests exist to keep "no unauthenticated dashboard writes" a fact rather
// than a sentence in the README.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, ROOT } from "./helpers.mjs";

const NL = String.fromCharCode(10);

// Start the real server on an ephemeral port with a throwaway SCH_HOME, and wait
// for it to say where it is listening.
async function dashboard(fx, extraEnv = {}) {
  const child = spawn(process.execPath, [join(ROOT, "scripts", "dashboard.mjs")], {
    env: { ...process.env, SCH_HOME: fx.home, SCH_PORT: "0", SCH_BIND: "127.0.0.1", NODE_NO_WARNINGS: "1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("the dashboard never reported a port: " + buf)), 15000);
    child.stdout.on("data", (d) => {
      buf += d;
      const m = buf.match(/:(\d+)\b/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    child.on("exit", (c) => { clearTimeout(t); reject(new Error(`exited ${c}: ${buf}`)); });
  });
  return { child, port, base: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

const tokenOf = (fx) => readFileSync(join(fx.home, "dashboard-token"), "utf8").trim();

test("an unauthenticated request is refused and reveals nothing", async () => {
  const fx = fixture("dash-401");
  const d = await dashboard(fx);
  try {
    const r = await fetch(d.base + "/");
    assert.equal(r.status, 401);
    const body = await r.text();
    assert.ok(!body.includes(fx.P), "a refusal must not leak which projects exist");
  } finally { d.stop(); fx.done(); }
});

test("a wrong token is refused", async () => {
  const fx = fixture("dash-wrong");
  const d = await dashboard(fx);
  try {
    const r = await fetch(d.base + "/", { headers: { authorization: "Bearer not-the-token" } });
    assert.equal(r.status, 401);
  } finally { d.stop(); fx.done(); }
});

test("the right token is admitted", async () => {
  const fx = fixture("dash-ok");
  const d = await dashboard(fx);
  try {
    const r = await fetch(d.base + "/", { headers: { authorization: `Bearer ${tokenOf(fx)}` } });
    assert.equal(r.status, 200);
  } finally { d.stop(); fx.done(); }
});

test("a write without a token is refused even with a valid CSRF shape", async () => {
  const fx = fixture("dash-write");
  const d = await dashboard(fx);
  try {
    const r = await fetch(d.base + "/scope", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: d.base, host: `127.0.0.1:${d.port}` },
      body: new URLSearchParams({ project: fx.P, action: "halt", csrf: "anything" }).toString(),
      redirect: "manual",
    });
    assert.equal(r.status, 401, "halting a project must require authentication");
  } finally { d.stop(); fx.done(); }
});

test("a token in the query sets a cookie, and the cookie alone then works", async () => {
  const fx = fixture("dash-cookie");
  const d = await dashboard(fx);
  try {
    const r = await fetch(`${d.base}/?token=${tokenOf(fx)}`, { redirect: "manual" });
    const cookie = r.headers.get("set-cookie") ?? "";
    assert.match(cookie, /sch_token=/, "the phone link must be usable once, then stop being needed");
    const jar = cookie.split(";")[0];
    const again = await fetch(d.base + "/", { headers: { cookie: jar } });
    assert.equal(again.status, 200);
  } finally { d.stop(); fx.done(); }
});

test("the token file is created once and survives a restart", async () => {
  const fx = fixture("dash-persist");
  const a = await dashboard(fx);
  const first = tokenOf(fx);
  a.stop();
  const b = await dashboard(fx);
  try {
    assert.equal(tokenOf(fx), first, "a token that rotates on restart cannot be bookmarked");
    assert.ok(existsSync(join(fx.home, "dashboard-token")));
  } finally { b.stop(); fx.done(); }
});

test("the run projection shows what the worker was given, never the skill bodies", async () => {
  const { RUN } = await import("./helpers.mjs");
  const fx = fixture("dash-pack");
  try {
    const p = RUN.runProjection(fx.P, { limit: 5 });
    assert.ok(Array.isArray(p.runs), "a projection must always answer with a run list");
    for (const r of p.runs) {
      if (!r.pack) continue;
      assert.equal(typeof r.pack.manifest_name, "string");
      assert.ok(Array.isArray(r.pack.skills));
      assert.ok(!JSON.stringify(r.pack).includes("SKILL.md content"),
        "a pack summary carries names, never instructions");
    }
  } finally { fx.done(); }
});
