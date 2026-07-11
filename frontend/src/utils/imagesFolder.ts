// ── Images-folder access via the File System Access API ─────────────────────
// The user grants the browser read/write access to their images folder once
// (Settings → Choose folder); the directory handle is persisted in IndexedDB
// and reused across sessions. The backend never touches the filesystem.
// Chromium-only: Firefox/Safari do not implement showDirectoryPicker.

const DB_NAME = 'astro-planner'
const STORE = 'fs-handles'
const KEY = 'images-folder'

export const isFolderAccessSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbRequest<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = op(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export async function getStoredImagesFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await idbRequest('readonly', s => s.get(KEY)) as FileSystemDirectoryHandle | undefined ?? null
  } catch {
    return null
  }
}

// Opens the browser folder picker and persists the chosen handle.
// Returns null only if the user cancelled; other failures throw.
export async function pickImagesFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFolderAccessSupported) throw new Error('This browser does not support local folder access')
  let handle: FileSystemDirectoryHandle
  try {
    handle = await window.showDirectoryPicker({ id: 'images-folder', mode: 'readwrite' })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null // user cancelled
    throw err
  }
  try {
    await idbRequest('readwrite', s => s.put(handle, KEY))
  } catch (err) {
    console.error('Failed to persist images folder handle', err)
    throw new Error('Folder was selected but could not be saved for reuse')
  }
  return handle
}

// Returns the stored handle with readwrite permission granted, or null.
// Call from a user gesture: a permission prompt may need transient activation.
export async function ensureImagesFolderAccess(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await getStoredImagesFolder()
  if (!handle) return null
  const desc = { mode: 'readwrite' as const }
  try {
    if (await handle.queryPermission(desc) === 'granted') return handle
    if (await handle.requestPermission(desc) === 'granted') return handle
  } catch {}
  return null
}

export interface CopyItem {
  files: File[]
  objectFolder: string
  filterName: string
}

export interface CopyStats { copied: number; skipped: number; failed: number }

// Folder settings may contain nested paths ("Galaxies/M31") — resolve each segment.
const segments = (s: string) => s.split(/[\\/]/).map(p => p.trim()).filter(Boolean)

async function getDestDir(root: FileSystemDirectoryHandle, item: CopyItem): Promise<FileSystemDirectoryHandle> {
  let dir = root
  for (const part of [...segments(item.objectFolder), ...segments(item.filterName)])
    dir = await dir.getDirectoryHandle(part, { create: true })
  return dir
}

export async function copyFilesToObjectFolders(
  root: FileSystemDirectoryHandle,
  items: CopyItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<CopyStats> {
  const stats: CopyStats = { copied: 0, skipped: 0, failed: 0 }
  const total = items.reduce((n, i) => n + i.files.length, 0)
  let done = 0
  for (const item of items) {
    let destDir: FileSystemDirectoryHandle | null = null
    for (const file of item.files) {
      try {
        if (!destDir) destDir = await getDestDir(root, item)
        let exists = true
        try { await destDir.getFileHandle(file.name) } catch { exists = false }
        if (exists) {
          stats.skipped++
        } else {
          const dest = await destDir.getFileHandle(file.name, { create: true })
          const writable = await dest.createWritable()
          try {
            await writable.write(file)
            await writable.close()
          } catch (err) {
            // Don't leave a partial file behind — a re-run would then skip it.
            try { await writable.abort() } catch {}
            try { await destDir.removeEntry(file.name) } catch {}
            throw err
          }
          stats.copied++
        }
      } catch {
        stats.failed++
      }
      onProgress?.(++done, total)
    }
  }
  return stats
}
