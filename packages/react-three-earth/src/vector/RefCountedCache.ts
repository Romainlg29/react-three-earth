interface Entry<Value> {
  count: number
  controller: AbortController
  promise: Promise<Value>
  /** Set once the promise resolves. */
  value: Value | undefined
  resolved: boolean
  bytes: number
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

  lock(key: string): Promise<Value> {
    let entry = this.entries.get(key)
    if (entry !== undefined) {
      if (entry.count === 0) this.revive(key, entry)
      entry.count++
      return entry.promise
    }
    const controller = new AbortController()
    const created: Entry<Value> = { count: 1, controller, promise: undefined as never, value: undefined, resolved: false, bytes: 0 }
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
    created.promise.catch(() => {})
    this.entries.set(key, created)
    entry = created
    return entry.promise
  }

  /** The pending or loaded value of a locked key, without taking a lock. */
  peek(key: string): Promise<Value> | null {
    const entry = this.entries.get(key)
    return entry !== undefined && entry.count > 0 ? entry.promise : null
  }

  /** The loaded value, if this key is locked and done loading. */
  get(key: string): Value | null {
    const entry = this.entries.get(key)
    return entry !== undefined && entry.resolved && entry.count > 0 ? entry.value! : null
  }

  release(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined || entry.count === 0) return
    entry.count--
    if (entry.count > 0) return
    if (entry.resolved && this.options.retainedBytes > 0) {
      this.unused.set(key, entry)
      this.unusedBytes += entry.bytes
      this.trim()
      return
    }
    this.drop(key, entry)
  }

  /** Frees everything, locked or not. */
  dispose(): void {
    for (const [key, entry] of this.entries) this.drop(key, entry)
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
