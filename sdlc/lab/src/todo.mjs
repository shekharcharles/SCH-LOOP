// Sample app under test. Deliberately small: the lab proves the loop, not the app.
// Behaviour the first tickets will extend (priority, due dates, persistence).

export function createStore() {
  const items = new Map();
  let nextId = 1;
  return {
    add(title) {
      if (typeof title !== "string" || title.trim() === "") throw new Error("title required");
      const item = { id: nextId++, title: title.trim(), done: false };
      items.set(item.id, item);
      return { ...item };
    },
    list() {
      return [...items.values()].map(i => ({ ...i }));
    },
    complete(id) {
      const item = items.get(id);
      if (!item) throw new Error(`no item ${id}`);
      items.set(id, { ...item, done: true });
      return { ...items.get(id) };
    },
    remove(id) {
      if (!items.delete(id)) throw new Error(`no item ${id}`);
    },
  };
}
