/**
 * Node 22+ reserves the global `localStorage` identifier for its own
 * experimental implementation, which stays inert (throws on access) unless
 * launched with `--localstorage-file`. That shadows whatever a DOM
 * environment like happy-dom would otherwise install, so `lib/myBookings.ts`
 * and `lib/profile.ts` — which rely on the browser-standard global, exactly as
 * they would in a real page — see nothing usable in tests without this.
 *
 * A tiny in-memory shim is simpler and more robust than fighting over which
 * environment's `localStorage` wins, and avoids depending on an exact Node
 * flag reaching whatever worker process the test runner's pool happens to use.
 */
class MemoryStorage implements Storage {
  #data = new Map<string, string>();

  get length(): number {
    return this.#data.size;
  }
  getItem(key: string): string | null {
    return this.#data.has(key) ? this.#data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.#data.set(key, String(value));
  }
  removeItem(key: string): void {
    this.#data.delete(key);
  }
  clear(): void {
    this.#data.clear();
  }
  key(index: number): string | null {
    return [...this.#data.keys()][index] ?? null;
  }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
  writable: true,
});
