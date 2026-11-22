interface Entry<Value> {
  count: number
  controller: AbortController
  promise: Promise<Value>
  /** Set once the promise resolves. */
  value: Value | undefined
  resolved: boolean
  failed: boolean
  bytes: number
  /** Taken out of the cache by `discard` while locked: freed by its last lease, never retained. */
  discarded: boolean
}

/** A lock on one cache entry, released through the lease itself, so it survives a `discard` of its key. */
export interface Lease<Value> {
  readonly promise: Promise<Value>
  /** Ends the lock. Calling it again does nothing. */
  release(): void
}

export interface RefCountedCacheOptions<Value> {
  /** Loads a value. Must stop (reject) when the signal aborts, and free what it allocated so far. */
  load: (key: string, signal: AbortSignal) => Promise<Value>
  /** Frees a loaded value that left the cache. */
  dispose: (value: Value, key: string) => void
  /** Bytes a value holds, for the budget of unused values kept. Default: 0. */
  getByteLength?: (value: Value) => number
  /** Unused, loaded values are kept (most recent first) until they pass this many bytes. Default: 0. */
  retainedBytes?: number
}

/**
 * A cache of values locked by key: the first `lock` loads, the last `release` frees. A released value can
 * be kept for reuse within a byte budget; a value still loading when its last lock goes is aborted.
 *
 * `discard` takes a key out so the next lock loads it again (its content changed). Holders of the old value
 * keep it until they let go, so they must hold it through `acquire` leases, not `lock` / `release` by key.
 */
export class RefCountedCache<Value> {
  protected readonly entries = new Map<string, Entry<Value>>()
  /** Loaded, unlocked entries in least-recently-used order. */
  protected readonly unused = new Map<string, Entry<Value>>()
  protected unusedBytes = 0
  protected readonly options: Required<RefCountedCacheOptions<Value>>

  constructor(options: RefCountedCacheOptions<Value>) {
    this.options = { getByteLength: () => 0, retainedBytes: 0, ...options }
  }

  /** Values loaded or loading. */
  get size(): number {
    return this.entries.size
  }

  /** Keys loaded or loading, locked or kept for reuse. */
  keys(): IterableIterator<string> {
    return this.entries.keys()
  }

  lock(key: string): Promise<Value> {
    return this.lockEntry(key).promise
  }

  /** Locks a key like `lock`, returning a lease that releases this very entry, even after a `discard`. */
  acquire(key: string): Lease<Value> {
    const entry = this.lockEntry(key)
    let released = false
    return {
      promise: entry.promise,
      release: () => {
        if (released) return
        released = true
        this.releaseEntry(key, entry)
      },
    }
  }

  /**
   * Takes a key out of the cache: the next lock loads it again. An unlocked value is freed now; a locked one
   * (or one still loading) stays with its leases and is freed by the last one.
   */
  discard(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    if (entry.count === 0) {
      this.revive(key, entry)
      this.drop(key, entry)
      return
    }
    this.entries.delete(key)
    entry.discarded = true
  }

  protected lockEntry(key: string): Entry<Value> {
    let entry = this.entries.get(key)
    if (entry !== undefined) {
      if (entry.count === 0) this.revive(key, entry)
      entry.count++
      return entry
    }
    const controller = new AbortController()
    const created: Entry<Value> = { count: 1, controller, promise: undefined as never, value: undefined, resolved: false, failed: false, bytes: 0, discarded: false }
    created.promise = this.options.load(key, controller.signal).then(value => {
      if (controller.signal.aborted) {
        this.options.dispose(value, key)
        throw controller.signal.reason
      }
      created.value = value
      created.resolved = true
      created.bytes = this.options.getByteLength(value)
      return value
    })
    // A failed load stays (as upstream DataCache does) until its last lock goes, then the next lock retries.
    created.promise.catch(() => void (created.failed = true))
    this.entries.set(key, created)
    return created
  }

  /** The pending or loaded value of a locked key, without taking a lock. */
  peek(key: string): Promise<Value> | null {
    const entry = this.entries.get(key)
    return entry !== undefined && entry.count > 0 ? entry.promise : null
  }

  /** Whether this key is locked and its value still loading (neither loaded nor failed). */
  isLoading(key: string): boolean {
    const entry = this.entries.get(key)
    return entry !== undefined && entry.count > 0 && !entry.resolved && !entry.failed
  }

  /** The loaded value, if this key is locked and done loading. */
  get(key: string): Value | null {
    const entry = this.entries.get(key)
    return entry !== undefined && entry.resolved && entry.count > 0 ? entry.value! : null
  }

  release(key: string): void {
    const entry = this.entries.get(key)
    if (entry !== undefined) this.releaseEntry(key, entry)
  }

  protected releaseEntry(key: string, entry: Entry<Value>): void {
    if (entry.count === 0) return
    entry.count--
    if (entry.count > 0) return
    if (entry.resolved && !entry.discarded && this.options.retainedBytes > 0) {
      this.unused.set(key, entry)
      this.unusedBytes += entry.bytes
      this.trim()
      return
    }
    this.drop(key, entry)
  }

  /** Frees everything, locked or not. Leases released later do nothing. */
  dispose(): void {
    for (const [key, entry] of this.entries) {
      entry.count = 0
      entry.discarded = true
      this.drop(key, entry)
    }
    this.unused.clear()
    this.unusedBytes = 0
  }

  protected revive(key: string, entry: Entry<Value>): void {
    if (this.unused.delete(key)) this.unusedBytes -= entry.bytes
  }

  protected trim(): void {
    for (const [key, entry] of this.unused) {
      if (this.unusedBytes <= this.options.retainedBytes) break
      this.unused.delete(key)
      this.unusedBytes -= entry.bytes
      this.drop(key, entry)
    }
  }

  protected drop(key: string, entry: Entry<Value>): void {
    if (this.entries.get(key) === entry) this.entries.delete(key)
    if (entry.resolved) this.options.dispose(entry.value!, key)
    else entry.controller.abort(new DOMException('RefCountedCache: released', 'AbortError'))
  }
}
