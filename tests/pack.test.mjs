import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fixture, ROOT, url } from "./helpers.mjs";

const PACK = await import(url(join(ROOT, "scripts", "pack.mjs")));

// A skill on disk, shaped the way the registry reports one.
function skillOnDisk(dir, id, body, { bucket = "recommended" } = {}) {
  const d = join(dir, id);
  mkdirSync(d, { recursive: true });
  const text = `---\nname: ${id}\ndescription: test skill ${id}\n---\n${body}\n`;
  const p = join(d, "SKILL.md");
  writeFileSync(p, text);
  return {
    skill_id: id, name: id, bucket, reason: "test",
    content_hash: createHash("sha256").update(text).digest("hex").slice(0, 32),
    source_path: p,
  };
}

test("the pack root is outside the repository and outside SCH_HOME", () => {
  const fx = fixture("pack-root");
  try {
    const p = PACK.packPathFor(fx.P, 1, { root: PACK.packsRoot() });
    assert.ok(!p.startsWith(fx.repo), "a pack must not live inside the repository");
    assert.ok(!p.startsWith(fx.home), "a pack must not live inside SCH_HOME");
  } finally { fx.done(); }
});

test("buildPack writes a generated manifest and the selected skills", () => {
  const fx = fixture("pack-build");
  const root = join(fx.home, "packs");
  const src = join(fx.home, "src-skills");
  try {
    const s = skillOnDisk(src, "alpha", "do alpha things");
    const r = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [s], root });
    assert.equal(r.ok, true, r.message);

    const manifest = JSON.parse(readFileSync(join(r.path, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(typeof manifest.name, "string");
    assert.ok(manifest.name.length > 0);
    assert.equal(manifest.hooks, undefined, "a generated manifest must never register hooks");

    const copied = readFileSync(join(r.path, "skills", "alpha", "SKILL.md"), "utf8");
    assert.match(copied, /do alpha things/);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].skill_id, "alpha");
  } finally { fx.done(); }
});

test("buildPack refuses a skill whose content moved since approval", () => {
  const fx = fixture("pack-hash");
  const root = join(fx.home, "packs");
  const src = join(fx.home, "src-skills");
  try {
    const s = skillOnDisk(src, "beta", "original");
    writeFileSync(s.source_path, "---\nname: beta\n---\ntampered\n");
    const r = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [s], root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "PACK_HASH_MISMATCH");
    assert.match(r.message, /beta/);
  } finally { fx.done(); }
});

test("hooks, scripts and nested manifests beside a skill are refused, and recorded", () => {
  const fx = fixture("pack-hooks");
  const root = join(fx.home, "packs");
  const src = join(fx.home, "src-skills");
  try {
    const s = skillOnDisk(src, "gamma", "gamma body");
    const d = join(src, "gamma");
    writeFileSync(join(d, "install.sh"), "#!/bin/sh\necho pwned\n");
    mkdirSync(join(d, ".claude-plugin"), { recursive: true });
    writeFileSync(join(d, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "evil", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo pwned" }] }] } }));

    // A supporting document the SKILL.md would reference.
    mkdirSync(join(d, "references"), { recursive: true });
    writeFileSync(join(d, "references", "detail.md"), "# the detail gamma refers to\n");

    const r = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [s], root });
    assert.equal(r.ok, true, r.message);
    assert.equal(existsSync(join(r.path, "skills", "gamma", "install.sh")), false,
      "a script beside a skill must not be copied into the pack");
    assert.equal(existsSync(join(r.path, "skills", "gamma", ".claude-plugin")), false,
      "a nested plugin manifest must not be copied into the pack");
    assert.equal(readFileSync(join(r.path, "skills", "gamma", "references", "detail.md"), "utf8"),
      "# the detail gamma refers to\n",
      "a supporting DOCUMENT must be carried — a SKILL.md pointing at a missing file is a broken skill");
    assert.ok(r.refusals.length >= 2, "every refusal is recorded, not silently dropped");
    assert.ok(r.refusals.some((x) => /install\.sh/.test(x.path)));

    const manifest = JSON.parse(readFileSync(join(r.path, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.hooks, undefined, "a source hook must never reach the generated manifest");
  } finally { fx.done(); }
});

test("an empty selection produces a valid pack with no skills", () => {
  const fx = fixture("pack-empty");
  const root = join(fx.home, "packs");
  try {
    const r = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [], root });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.entries.length, 0);
    assert.ok(existsSync(join(r.path, ".claude-plugin", "plugin.json")),
      "an empty pack is still a valid plugin, so the worker gets no catalogue rather than a broken flag");
  } finally { fx.done(); }
});

test("buildPack is idempotent and replaces a stale pack rather than merging into it", () => {
  const fx = fixture("pack-rebuild");
  const root = join(fx.home, "packs");
  const src = join(fx.home, "src-skills");
  try {
    const a = skillOnDisk(src, "one", "first");
    const r1 = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [a], root });
    const b = skillOnDisk(src, "two", "second");
    const r2 = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [b], root });
    assert.equal(r2.ok, true, r2.message);
    assert.equal(r2.path, r1.path);
    assert.equal(existsSync(join(r2.path, "skills", "one")), false,
      "a rebuilt pack must not still carry the previous task's skills");
    assert.equal(existsSync(join(r2.path, "skills", "two")), true);
  } finally { fx.done(); }
});

test("a symlink beside a skill is refused rather than followed off disk", () => {
  const fx = fixture("pack-symlink");
  const root = join(fx.home, "packs");
  const src = join(fx.home, "src-skills");
  try {
    const s = skillOnDisk(src, "delta", "delta body");
    const d = join(src, "delta");
    const secret = join(fx.home, "secret.md");
    writeFileSync(secret, "# should never leave the operator's disk\n");
    try {
      symlinkSync(secret, join(d, "escape.md"));
    } catch (e) {
      // This sandbox has no privilege to create symlinks (observed: EPERM on
      // Windows without developer mode). The refusal path is exercised
      // elsewhere by inspection; skip rather than fail on an environment limit.
      return;
    }

    const r = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [s], root });
    assert.equal(r.ok, true, r.message);
    assert.equal(existsSync(join(r.path, "skills", "delta", "escape.md")), false,
      "a symlink must not be followed into the pack even when its name looks like a document");
    assert.ok(r.refusals.some((x) => /escape\.md/.test(x.path) && /symlink/.test(x.why)));
  } finally { fx.done(); }
});

test("removePack deletes the pack and reports it", () => {
  const fx = fixture("pack-remove");
  const root = join(fx.home, "packs");
  try {
    const r = PACK.buildPack({ projectId: fx.P, taskId: 1, skills: [], root });
    const rm = PACK.removePack({ projectId: fx.P, taskId: 1, root });
    assert.equal(rm.ok, true);
    assert.equal(rm.removed, true);
    assert.equal(existsSync(r.path), false);
    assert.equal(PACK.packState({ projectId: fx.P, taskId: 1, root }).exists, false);
  } finally { fx.done(); }
});
