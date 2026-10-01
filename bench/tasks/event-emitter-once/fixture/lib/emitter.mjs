/**
 * Minimal event emitter. `once` registers a listener for a single emit and
 * MUST be removable afterwards both via its unsubscribe function and via
 * plain off(event, fn) with the ORIGINAL function — once-wrappers are
 * marked with .original so off can resolve them.
 */
export class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(event, fn) {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const wrapped = (...args) => fn(...args);
    this.on(event, wrapped);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const list = this.listeners.get(event);
    if (!list) return;
    let index = list.indexOf(fn);
    if (index === -1) index = list.findIndex((handler) => handler.original === fn);
    if (index !== -1) list.splice(index, 1);
  }

  emit(event, ...args) {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args);
  }

  listenerCount(event) {
    return (this.listeners.get(event) ?? []).length;
  }
}
