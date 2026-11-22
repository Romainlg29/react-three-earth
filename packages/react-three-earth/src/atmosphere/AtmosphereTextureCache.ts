import type { AtmosphereParameters } from './AtmosphereParameters.js'

/**
 * Bumped whenever the precomputation's output changes for the same parameters (shaders, sample counts,
 * texture layout), so that textures cached by an older version are never used.
 */
export const ATMOSPHERE_PRECOMPUTE_VERSION = 1

/** The contents of the three lookup textures, as read back from the GPU (RGBA, rows bottom-up). */
export interface AtmosphereTextureData {
  transmittance: Float32Array
  irradiance: Float32Array
  /** 32-bit floats, or half floats as raw 16-bit words, matching `scatteringHalfFloat`. */
  scattering: Float32Array | Uint16Array
  scatteringHalfFloat: boolean
}

interface StoredEntry {
  key: string
  storedAtMilliseconds: number
  data: AtmosphereTextureData
}

const DATABASE_NAME = 'react-three-earth-atmosphere'
const STORE_NAME = 'atmosphere-textures'

/**
 * The identity of a set of lookup textures: every parameter (sizes included), the scattering texture's
 * storage type and the precomputation version. Plain JSON, so it is stable across sessions.
 */
export function createAtmosphereCacheKey(parameters: AtmosphereParameters, scatteringHalfFloat: boolean): string {
  const fields: Record<string, unknown> = {}
  for (const name of Object.keys(parameters).sort()) fields[name] = (parameters as unknown as Record<string, unknown>)[name]
  return JSON.stringify({ version: ATMOSPHERE_PRECOMPUTE_VERSION, scatteringHalfFloat, parameters: fields })
}

function promisify<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

/**
 * Keeps generated lookup textures in IndexedDB, so that a later visit with the same parameters skips
 * generation (8 MB with half-float scattering, 16 MB with 32-bit). Holds the `maximumEntries` most recent
 * sets. Every method fails soft: without IndexedDB (private browsing, workers without it, quota), reads
 * miss and writes are dropped.
 */
export class AtmosphereTextureCache {
  readonly maximumEntries: number

  protected database: Promise<IDBDatabase | null> | null = null

  constructor(maximumEntries = 2) {
    this.maximumEntries = Math.max(1, maximumEntries)
  }

  /** The textures stored under this key, or null. */
  async read(key: string): Promise<AtmosphereTextureData | null> {
    const database = await this.open()
    if (database === null) return null
    try {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const entry = (await promisify(transaction.objectStore(STORE_NAME).get(key))) as StoredEntry | undefined
      return entry?.data ?? null
    } catch {
      return null
    }
  }

  /** Stores the textures under this key, evicting the oldest sets beyond `maximumEntries`. */
  async write(key: string, data: AtmosphereTextureData): Promise<void> {
    const database = await this.open()
    if (database === null) return
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const entry: StoredEntry = { key, storedAtMilliseconds: Date.now(), data }
      store.put(entry)
      const entries = (await promisify(store.getAll())) as StoredEntry[]
      const others = entries.filter(other => other.key !== key).sort((a, b) => b.storedAtMilliseconds - a.storedAtMilliseconds)
      for (const stale of others.slice(this.maximumEntries - 1)) store.delete(stale.key)
      await transactionDone(transaction)
    } catch (error) {
      console.warn('Atmosphere: could not cache the lookup textures.', error)
    }
  }

  /** Removes every stored set. */
  async clear(): Promise<void> {
    const database = await this.open()
    if (database === null) return
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).clear()
      await transactionDone(transaction)
    } catch {
      // Nothing to clear.
    }
  }

  protected open(): Promise<IDBDatabase | null> {
    if (this.database === null) {
      this.database = new Promise(resolve => {
        if (typeof indexedDB === 'undefined') return resolve(null)
        try {
          const request = indexedDB.open(DATABASE_NAME, 1)
          request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'key' })
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => resolve(null)
          request.onblocked = () => resolve(null)
        } catch {
          resolve(null)
        }
      })
    }
    return this.database
  }
}
