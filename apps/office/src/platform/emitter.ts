// The part of Node's EventEmitter the editor code uses (on, once, off, emit).
type Listener = (...args: any[]) => void;

export class EventEmitter {
  private readonly listeners = new Map<string | symbol, Listener[]>();
  on(name: string | symbol, listener: Listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    return this;
  }
  addListener(name: string | symbol, listener: Listener) {
    return this.on(name, listener);
  }
  once(name: string | symbol, listener: Listener) {
    const wrapped: Listener = (...args) => {
      this.off(name, wrapped);
      listener(...args);
    };
    return this.on(name, wrapped);
  }
  off(name: string | symbol, listener: Listener) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((entry) => entry !== listener));
    return this;
  }
  removeListener(name: string | symbol, listener: Listener) {
    return this.off(name, listener);
  }
  removeAllListeners(name?: string | symbol) {
    if (name === undefined) this.listeners.clear();
    else this.listeners.delete(name);
    return this;
  }
  emit(name: string | symbol, ...args: unknown[]) {
    const current = this.listeners.get(name) ?? [];
    for (const listener of current) listener(...args);
    return current.length > 0;
  }
  listenerCount(name: string | symbol) {
    return this.listeners.get(name)?.length ?? 0;
  }
  setMaxListeners() {
    return this;
  }
}

export default EventEmitter;
