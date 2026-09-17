import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/todo.mjs";

test("add returns a copy with an id and lists it", () => {
  const s = createStore();
  const a = s.add("  write tests ");
  assert.deepEqual(a, { id: 1, title: "write tests", done: false, priority: "normal" });
  assert.deepEqual(s.list(), [a]);
});

test("add rejects empty titles", () => {
  const s = createStore();
  assert.throws(() => s.add(""), /title required/);
  assert.throws(() => s.add(42), /title required/);
});

test("complete flips done without mutating earlier copies", () => {
  const s = createStore();
  const a = s.add("x");
  const done = s.complete(a.id);
  assert.equal(done.done, true);
  assert.equal(a.done, false);
});

test("remove deletes and unknown ids throw", () => {
  const s = createStore();
  const a = s.add("x");
  s.remove(a.id);
  assert.deepEqual(s.list(), []);
  assert.throws(() => s.remove(99), /no item 99/);
  assert.throws(() => s.complete(99), /no item 99/);
});

test("add defaults priority to normal", () => {
  const s = createStore();
  assert.equal(s.add("x").priority, "normal");
});

test("add accepts an explicit priority", () => {
  const s = createStore();
  assert.equal(s.add("x", "high").priority, "high");
  assert.equal(s.add("y", "low").priority, "low");
});

test("add rejects an unknown priority", () => {
  const s = createStore();
  assert.throws(() => s.add("x", "urgent"), /priority/);
});

test("list and complete carry the priority through", () => {
  const s = createStore();
  const a = s.add("x", "high");
  assert.equal(s.list()[0].priority, "high");
  assert.equal(s.complete(a.id).priority, "high");
});

test("remove on an already-removed id throws", () => {
  const s = createStore();
  const a = s.add("x");
  s.remove(a.id);
  assert.throws(() => s.remove(a.id), new RegExp(`no item ${a.id}`));
});

test("list returns copies: mutating a listed item does not change the store", () => {
  const s = createStore();
  s.add("x");
  const listed = s.list()[0];
  listed.title = "tampered";
  listed.done = true;
  const [fresh] = s.list();
  assert.equal(fresh.title, "x");
  assert.equal(fresh.done, false);
});

test("list filters by priority", () => {
  const s = createStore();
  const hi = s.add("a", "high");
  s.add("b", "low");
  const hi2 = s.add("c", "high");
  assert.deepEqual(s.list({ priority: "high" }), [hi, hi2]);
  assert.deepEqual(s.list({ priority: "low" }).map(i => i.title), ["b"]);
  assert.deepEqual(s.list({ priority: "normal" }), []);
});

test("list with no argument still returns every item, as copies", () => {
  const s = createStore();
  s.add("a", "high");
  s.add("b", "low");
  assert.equal(s.list().length, 2);
  s.list()[0].title = "tampered";
  assert.equal(s.list()[0].title, "a");
});

test("list rejects an unknown priority the same way add does", () => {
  const s = createStore();
  assert.throws(() => s.list({ priority: "urgent" }), /priority must be one of low\|normal\|high/);
});

test("filtered list returns copies: mutating a filtered item does not change the store", () => {
  const s = createStore();
  s.add("keep me", "high");
  const filtered = s.list({ priority: "high" })[0];
  filtered.title = "tampered";
  filtered.done = true;
  const [fresh] = s.list({ priority: "high" });
  assert.equal(fresh.title, "keep me");
  assert.equal(fresh.done, false);
});
