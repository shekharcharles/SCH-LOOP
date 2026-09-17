import { EventEmitter } from "node:events";
export const bus = new EventEmitter();
bus.setMaxListeners(200);
export function emit(type, data={}) {
  bus.emit("event", { type, at:new Date().toISOString(), ...data });
}
