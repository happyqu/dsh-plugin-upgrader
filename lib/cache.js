/**
 * Result cache with TTL, a concurrency ceiling, and in-flight request de-duplication.
 *
 * `pnpm view` is a network call. Rendering the upgrade centre must never fire one per
 * plugin per render, so every check passes through here:
 *
 *   - TTL (default 6h) keeps a settled answer for reuse.
 *   - The concurrency ceiling bounds how many `pnpm view` runs overlap; a profile with
 *     twenty third-party plugins would otherwise fork twenty node processes at once.
 *   - De-duplication makes a second caller for the same plugin await the first call's
 *     result instead of starting a second process.
 *   - A FAILED check never overwrites a previous success. The stale value is kept and
 *     flagged, because replacing "0.1.4 is available" with "registry unreachable" every
 *     time the network blips would be actively worse for the user.
 */

/** @typedef {{value: any, at: number, stale?: boolean, error?: any}} CacheEntry */

export class CheckCache {
  /**
   * @param {object} [options] - cache policy.
   * @param {number} [options.ttlMs] - how long a successful result stays fresh.
   * @param {number} [options.concurrency] - maximum overlapping checks.
   */
  constructor({ ttlMs = 6 * 60 * 60 * 1000, concurrency = 3 } = {}) {
    this.ttlMs = Math.max(0, Number(ttlMs) || 0)
    this.concurrency = Math.max(1, Math.min(16, Number(concurrency) || 3))
    /** @type {Map<string, CacheEntry>} */
    this.entries = new Map()
    /** @type {Map<string, Promise<any>>} */
    this.inFlight = new Map()
    this.active = 0
    /** @type {Array<() => void>} */
    this.waiters = []
  }

  /**
   * Drop every cached result, preserving nothing.
   * @returns {void}
   */
  clear() {
    this.entries.clear()
  }

  /**
   * Read a cached entry when it is still fresh.
   * @param {string} key - the cache key.
   * @returns {any|null} the cached value, or null when absent or expired.
   */
  peek(key) {
    const entry = this.entries.get(key)
    if (entry === undefined) return null
    if (Date.now() - entry.at > this.ttlMs) return null
    return entry.value
  }

  /**
   * Read a cached entry regardless of age, flagging how stale it is.
   * @param {string} key - the cache key.
   * @returns {{value: any, ageMs: number, stale: boolean}|null} the stored value.
   */
  peekAny(key) {
    const entry = this.entries.get(key)
    if (entry === undefined) return null
    const ageMs = Date.now() - entry.at
    return { value: entry.value, ageMs, stale: ageMs > this.ttlMs }
  }

  /**
   * Reserve one concurrency slot, queueing until one is free.
   * @returns {Promise<() => void>} a release function; call it exactly once.
   */
  async acquire() {
    if (this.active < this.concurrency) {
      this.active += 1
      return () => this.release()
    }
    await new Promise((resolve) => this.waiters.push(resolve))
    this.active += 1
    return () => this.release()
  }

  /**
   * Release one concurrency slot and wake the next waiter.
   * @returns {void}
   */
  release() {
    this.active = Math.max(0, this.active - 1)
    const next = this.waiters.shift()
    if (next !== undefined) next()
  }

  /**
   * Get a value, computing it at most once concurrently and caching successes.
   * @template T
   * @param {string} key - the cache key.
   * @param {() => Promise<T>} produce - the expensive computation.
   * @param {object} [options] - call policy.
   * @param {boolean} [options.force] - ignore a fresh cached value and recompute.
   * @returns {Promise<{value: T, cached: boolean, stale: boolean}>} the value and its provenance.
   */
  async get(key, produce, { force = false } = {}) {
    if (!force) {
      const fresh = this.peek(key)
      if (fresh !== null) return { value: fresh, cached: true, stale: false }
    }

    const pending = this.inFlight.get(key)
    if (pending !== undefined) {
      const value = await pending
      const previous = this.peekAny(key)
      return { value, cached: true, stale: previous?.stale ?? false }
    }

    const run = (async () => {
      const release = await this.acquire()
      try {
        return await produce()
      } finally {
        release()
      }
    })()
    this.inFlight.set(key, run)

    try {
      const value = await run
      const failed = isFailureRecord(value)
      if (!failed) {
        this.entries.set(key, { value, at: Date.now() })
        return { value, cached: false, stale: false }
      }
      // Keep the last good answer; surface the failure alongside it.
      const previous = this.peekAny(key)
      if (previous !== null) {
        return { value: previous.value, cached: true, stale: true, error: value }
      }
      return { value, cached: false, stale: false }
    } finally {
      this.inFlight.delete(key)
    }
  }
}

/**
 * Decide whether a produced record represents a failed check.
 * @param {any} value - the produced record.
 * @returns {boolean} true for error records.
 */
function isFailureRecord(value) {
  return typeof value === 'object' && value !== null && value.status === 'error'
}
