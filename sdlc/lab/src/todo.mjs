// Sample app under test. Deliberately small: the lab proves the loop, not the app.
// Behaviour the first tickets will extend (priority, due dates, persistence).

const PRIORITIES = ["low", "normal", "high"];

export function createStore() {
  const items = new Map();
  let nextId = 1;
  return {
    add(title, priority = "normal") {
      if (typeof title !== "string" || title.trim() === "") throw new Error("title required");
      if (!PRIORITIES.includes(priority)) throw new Error(`priority must be one of ${PRIORITIES.join("|")}`);
      const item = { id: nextId++, title: title.trim(), done: false, priority };
      items.set(item.id, item);
      return { ...item };
    },
    list({ priority } = {}) {
      if (priority !== undefined && !PRIORITIES.includes(priority)) {
        throw new Error(`priority must be one of ${PRIORITIES.join("|")}`);
      }
      return [...items.values()]
        .filter(i => priority === undefined || i.priority === priority)
        .map(i => ({ ...i }));
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
