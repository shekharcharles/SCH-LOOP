import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/todo.mjs";

test("add returns a copy with an id and lists it", () => {
  const s = createStore();
  const a = s.add("  write tests ");
  assert.deepEqual(a, { id: 1, title: "write tests", done: false });
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
