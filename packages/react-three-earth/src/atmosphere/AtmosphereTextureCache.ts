import type { AtmosphereParameters } from './AtmosphereParameters.js'

/**
 * Part of every cache key: bump it whenever the precomputation's output changes for the same parameters
 * (AtmosphereModel.ts, precompute.ts, AtmosphereTextures.ts), so that cached textures from an older version
 * are never used. A unit test fails when those files change, as a reminder.
 */
export const ATMOSPHERE_PRECOMPUTE_VERSION = 2

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

const DATABASE_NAME = 'earthkit-atmosphere'
const DATABASE_VERSION = 2
const STORE_NAME = 'atmosphere-textures'
const AGE_INDEX = 'storedAtMilliseconds'

/**
 * The identity of a set of lookup textures: every parameter (sizes included), the scattering texture's
 * storage type and the precomputation version. Plain JSON, so it is stable across sessions.
 */
export function createAtmosphereCacheKey(parameters: AtmosphereParameters, scatteringHalfFloat: boolean): string {
  return JSON.stringify({ version: ATMOSPHERE_PRECOMPUTE_VERSION, scatteringHalfFloat, parameters: sortKeys(parameters) })
}

/** A copy with object keys sorted at every level, so that key order never changes the JSON. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const name of Object.keys(value).sort()) result[name] = sortKeys((value as Record<string, unknown>)[name])
  return result
}

/** FNV-1a hash of a string, as 8 hex digits: a short fingerprint, not a security measure. */
export function hashString(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
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
      // Walks keys only, newest first, never loading the other sets' textures.
      const cursorRequest = store.index(AGE_INDEX).openKeyCursor(null, 'prev')
      // The new set always stays, even if a clock moved back makes it look older.
      let kept = 1
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (cursor === null) return
        if (cursor.primaryKey !== key) {
          if (kept < this.maximumEntries) kept++
          else store.delete(cursor.primaryKey)
        }
        cursor.continue()
      }
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

  /** The database, opened once; a failed or closed connection is opened again on the next call. */
  protected open(): Promise<IDBDatabase | null> {
    if (this.database === null) {
      const forget = (): void => {
        this.database = null
      }
      this.database = new Promise(resolve => {
        if (typeof indexedDB === 'undefined') return resolve(null)
        try {
          const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
          request.onupgradeneeded = () => {
            const database = request.result
            if (database.objectStoreNames.contains(STORE_NAME)) database.deleteObjectStore(STORE_NAME)
            database.createObjectStore(STORE_NAME, { keyPath: 'key' }).createIndex(AGE_INDEX, AGE_INDEX)
          }
          request.onsuccess = () => {
            const database = request.result
            // Let another tab upgrade the database: close, and reopen on the next call.
            database.onversionchange = () => {
              database.close()
              forget()
            }
            database.onclose = forget
            resolve(database)
          }
          request.onerror = () => {
            forget()
            resolve(null)
          }
          // Another tab holds an older version open: miss this time. The request still completes once
          // that tab lets go, and onsuccess closes nothing, so drop the connection then.
          request.onblocked = () => {
            request.onsuccess = () => request.result.close()
            forget()
            resolve(null)
          }
        } catch {
          // Thrown synchronously (IndexedDB forbidden here): it would throw again, so the miss is kept.
          resolve(null)
        }
      })
    }
    return this.database
  }
}
