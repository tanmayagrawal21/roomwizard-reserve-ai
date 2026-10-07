/**
 * Tiny TTL cache with request coalescing.
 *
 * The coalescing matters more than the caching here. The appliances are 2013
 * embedded hardware; if five people open the week view at once we want one
 * fan-out, not five. In-flight promises are shared, and only resolved values
 * are cached.
 */

type Entry<T> = { value: T; expiresAt: number };

export class TtlCache<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #inFlight = new Map<string, Promise<T>>();

  readonly #ttlMs: number;

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const hit = this.#entries.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    this.#entries.set(key, { value, expiresAt: Date.now() + this.#ttlMs });
  }

  /** Return the cached value, the in-flight fetch, or start a new fetch. */
  async fetch(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.#inFlight.get(key);
    if (pending) return pending;

    const promise = load()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });

    this.#inFlight.set(key, promise);
    return promise;
  }

  invalidate(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}
