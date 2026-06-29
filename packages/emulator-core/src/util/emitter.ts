/**
 * Minimal typed event emitter used across the HAL so the core can notify
 * observers (the web UI, the BIOS, dev tools) without depending on any
 * particular framework. `Events` maps an event name to its payload type.
 */
export type Listener<T> = (payload: T) => void;

export class Emitter<Events> {
  private readonly listeners = new Map<keyof Events, Set<Listener<unknown>>>();

  /** Subscribe to `event`. Returns an unsubscribe function. */
  on<K extends keyof Events>(
    event: K,
    listener: Listener<Events[K]>,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<unknown>);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<unknown>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Iterate a copy so listeners may unsubscribe during dispatch.
    for (const listener of [...set]) {
      (listener as Listener<Events[K]>)(payload);
    }
  }

  /** Remove every listener. Used when tearing down a device instance. */
  clear(): void {
    this.listeners.clear();
  }
}
