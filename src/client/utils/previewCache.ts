// ── Blink preview cache (IndexedDB) ─────────────────────────────────────────
// Generating a preview means decoding the whole source frame, so previews are
// kept between sessions rather than rebuilt each time the viewer opens.
//
// Entries are keyed on folder + file name and validated against the source
// file's size and mtime, so a re-captured or re-calibrated sub regenerates on
// its own. PREVIEW_VERSION invalidates everything when the render changes.
//
// The store is bounded: once it exceeds CACHE_CAP_BYTES the least recently
// used folders are dropped. Nothing here is load-bearing — a miss only costs
// the time to render the preview again.

import { PREVIEW_VERSION } from './fitsPreview'

const DB_NAME = 'astro-planner-previews'
const DB_VERSION = 1
const STORE = 'previews'

export const CACHE_CAP_BYTES = 500 * 1024 * 1024

export interface PreviewRecord {
  /** identity of the source file, not its location — see keyOf */
  key: string
  /** where it was last viewed from; groups entries for eviction and clearing */
  folder: string
  name: string
  blob: Blob
  width: number
  height: number
  srcSize: number
  srcModified: number
  version: number
  bytes: number
  lastUsed: number
}

const promisify = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' })
        store.createIndex('folder', 'folder')
        store.createIndex('lastUsed', 'lastUsed')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  // A failed open must not poison every later call.
  dbPromise.catch(() => { dbPromise = null })
  return dbPromise
}

const tx = async (mode: IDBTransactionMode) =>
  (await openDb()).transaction(STORE, mode).objectStore(STORE)

/**
 * Keyed on the file's identity rather than where it happens to sit, so a sub
 * previewed while importing is still cached once it has been copied into its
 * object folder and is blinked from there. Size and mtime are part of the key,
 * so an edited file simply misses instead of returning a stale preview.
 */
const keyOf = (name: string, size: number, modified: number) => `${name}|${size}|${modified}`

/**
 * Ask the browser not to evict this origin's storage under disk pressure.
 * Best-effort: a refusal just means previews may be cleared automatically.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/** Cached preview for a source file, or null if absent or from an older render. */
export async function getPreview(
  name: string, srcSize: number, srcModified: number,
): Promise<PreviewRecord | null> {
  try {
    const rec = await promisify<PreviewRecord | undefined>(
      (await tx('readonly')).get(keyOf(name, srcSize, srcModified)) as IDBRequest<PreviewRecord | undefined>,
    )
    if (!rec || rec.version !== PREVIEW_VERSION) return null
    return rec
  } catch {
    return null
  }
}

export async function putPreview(
  rec: Omit<PreviewRecord, 'key' | 'version' | 'bytes' | 'lastUsed'>,
): Promise<void> {
  try {
    const store = await tx('readwrite')
    store.put({
      ...rec,
      key: keyOf(rec.name, rec.srcSize, rec.srcModified),
      version: PREVIEW_VERSION,
      bytes: rec.blob.size,
      lastUsed: Date.now(),
    } satisfies PreviewRecord)
  } catch {
    // A full or unavailable store just means previews regenerate next time.
  }
}

/**
 * Mark a folder as just used, in one transaction, so eviction drops whole
 * stale folders rather than scattered frames from the set you are viewing.
 */
export async function touchFolder(folder: string): Promise<void> {
  try {
    // Read and write in separate transactions: an IndexedDB transaction can
    // auto-commit once its request queue drains, which an await between the
    // read and the writes risks.
    const recs = await promisify<PreviewRecord[]>(
      (await tx('readonly')).index('folder').getAll(folder) as IDBRequest<PreviewRecord[]>,
    )
    if (!recs.length) return
    const store = await tx('readwrite')
    const now = Date.now()
    for (const r of recs) store.put({ ...r, lastUsed: now })
  } catch {
    // Non-fatal: eviction ordering is a heuristic, not correctness.
  }
}

export async function cacheStats(): Promise<{ count: number; bytes: number }> {
  try {
    const recs = await promisify<PreviewRecord[]>(
      (await tx('readonly')).getAll() as IDBRequest<PreviewRecord[]>,
    )
    return { count: recs.length, bytes: recs.reduce((n, r) => n + (r.bytes || 0), 0) }
  } catch {
    return { count: 0, bytes: 0 }
  }
}

export async function clearCache(): Promise<void> {
  try { (await tx('readwrite')).clear() } catch { /* nothing to clear */ }
}

export async function clearFolder(folder: string): Promise<void> {
  try {
    const keys = await promisify<IDBValidKey[]>(
      (await tx('readonly')).index('folder').getAllKeys(folder),
    )
    if (!keys.length) return
    const store = await tx('readwrite')
    for (const k of keys) store.delete(k)
  } catch { /* nothing to clear */ }
}

/** Drop least-recently-used entries until the store fits under the cap. */
export async function enforceCap(maxBytes = CACHE_CAP_BYTES): Promise<void> {
  try {
    const recs = await promisify<PreviewRecord[]>(
      (await tx('readonly')).getAll() as IDBRequest<PreviewRecord[]>,
    )
    let total = recs.reduce((n, r) => n + (r.bytes || 0), 0)
    if (total <= maxBytes) return
    recs.sort((a, b) => a.lastUsed - b.lastUsed)
    const store = await tx('readwrite')
    for (const r of recs) {
      if (total <= maxBytes) break
      store.delete(r.key)
      total -= r.bytes || 0
    }
  } catch { /* best effort */ }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
