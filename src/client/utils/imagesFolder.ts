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

// Opens the folder picker for a one-off source folder (the capture dump an
// import read from). Not persisted: a source folder is wherever this batch came
// from. Returns null only if the user cancelled.
export async function pickSourceFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFolderAccessSupported) throw new Error('This browser does not support local folder access')
  try {
    return await window.showDirectoryPicker({ id: 'import-source-folder', mode: 'readwrite' })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null // user cancelled
    throw err
  }
}

// True when `dir` is the images folder or sits inside it. Guards the source
// cleanup: the copies an import just made live there, and deleting "sources"
// out of that tree would delete the only copy.
export async function isInsideImagesFolder(dir: FileSystemDirectoryHandle): Promise<boolean> {
  const root = await getStoredImagesFolder()
  if (!root) return false
  try {
    if (await root.isSameEntry(dir)) return true
    return (await root.resolve(dir)) !== null
  } catch {
    return false
  }
}

export interface CopyItem {
  files: File[]
  objectFolder: string
  filterName: string
  /** Mosaic panel suffix — one more folder level inside the filter folder. */
  panelFolder?: string | null
  /** Reimported files: written over an existing copy at the destination
      rather than skipped. */
  replace?: Set<string>
}

export interface CopyStats {
  copied: number; skipped: number; failed: number
  /** Reimported files whose new copy landed and was verified, by object folder
      and the destination folder path under it. */
  replaced: { objectFolder: string; dir: string[]; name: string }[]
}

// Folder settings may contain nested paths ("Galaxies/M31") — resolve each segment.
const segments = (s: string) => s.split(/[\\/]/).map(p => p.trim()).filter(Boolean)

async function getDestDir(root: FileSystemDirectoryHandle, item: CopyItem): Promise<FileSystemDirectoryHandle> {
  let dir = root
  for (const part of [...segments(item.objectFolder), ...segments(item.filterName), ...segments(item.panelFolder ?? '')])
    dir = await dir.getDirectoryHandle(part, { create: true })
  return dir
}

/** A file in an object folder and the folders it sits in, relative to that folder. */
export interface FolderEntry { name: string; dir: string[] }

// Like listObjectFolderFiles, but keeps where each file sits — what deciding
// whether a mosaic sub is in its panel folder needs.
export async function listObjectFolderEntries(root: FileSystemDirectoryHandle, objectFolder: string): Promise<FolderEntry[]> {
  const base = await resolveObjectDir(root, objectFolder)
  if (!base) return []
  const out: FolderEntry[] = []
  const scan = async (d: FileSystemDirectoryHandle, dir: string[]): Promise<void> => {
    for await (const handle of d.values()) {
      if (handle.kind === 'directory') await scan(handle as FileSystemDirectoryHandle, [...dir, handle.name])
      else out.push({ name: handle.name, dir })
    }
  }
  await scan(base, [])
  return out
}

export interface FileMove { name: string; from: string[]; to: string[] }
export interface MoveStats { moved: number; conflicts: number; failed: number }

/**
 * Moves files between folders of one object folder. Copy, read the copy back
 * and compare sizes, and only then remove the original: a sub must never exist
 * in neither place. A destination that already holds a file of that name is
 * left alone along with the source (a conflict, for the user to look at) —
 * nothing here overwrites or deletes a file it hasn't just verified a copy of.
 */
export async function moveObjectFolderFiles(
  root: FileSystemDirectoryHandle,
  objectFolder: string,
  moves: FileMove[],
  onProgress?: (done: number, total: number) => void,
): Promise<MoveStats> {
  const stats: MoveStats = { moved: 0, conflicts: 0, failed: 0 }
  const base = await resolveObjectDir(root, objectFolder)
  if (!base) { stats.failed = moves.length; return stats }
  const dirAt = async (path: string[], create: boolean): Promise<FileSystemDirectoryHandle> => {
    let d = base
    for (const part of path) d = await d.getDirectoryHandle(part, { create })
    return d
  }
  let done = 0
  for (const m of moves) {
    try {
      const fromDir = await dirAt(m.from, false)
      const toDir = await dirAt(m.to, true)
      const src = await (await fromDir.getFileHandle(m.name)).getFile()
      let exists = true
      try { await toDir.getFileHandle(m.name) } catch { exists = false }
      if (exists) {
        stats.conflicts++
      } else {
        const dest = await toDir.getFileHandle(m.name, { create: true })
        const writable = await dest.createWritable()
        try {
          await writable.write(src)
          await writable.close()
        } catch (err) {
          try { await writable.abort() } catch {}
          try { await toDir.removeEntry(m.name) } catch {}
          throw err
        }
        const copied = await dest.getFile()
        if (copied.size !== src.size) {
          // Keep the original; drop the bad copy so a re-run tries again.
          try { await toDir.removeEntry(m.name) } catch {}
          throw new Error(`Copy of ${m.name} is incomplete`)
        }
        await fromDir.removeEntry(m.name)
        stats.moved++
      }
    } catch {
      stats.failed++
    }
    onProgress?.(++done, moves.length)
  }
  return stats
}

// Lists all file names (recursively) inside objectFolder under the images
// folder. A missing object folder just means nothing has been copied yet.
export async function listObjectFolderFiles(root: FileSystemDirectoryHandle, objectFolder: string): Promise<string[]> {
  let dir = root
  try {
    for (const part of segments(objectFolder)) dir = await dir.getDirectoryHandle(part)
  } catch {
    return []
  }
  const names: string[] = []
  const scan = async (d: FileSystemDirectoryHandle): Promise<void> => {
    for await (const handle of d.values()) {
      if (handle.kind === 'directory') await scan(handle as FileSystemDirectoryHandle)
      else names.push(handle.name)
    }
  }
  await scan(dir)
  return names
}

const stemOf = (n: string) => n.replace(/\.[^.]+$/, '').toLowerCase()
const baseOf = (s: string): string => {
  while (true) {
    const t = s.replace(/_[a-z][a-z0-9]*$/, '')
    if (t === s) return s
    s = t
  }
}

async function resolveObjectDir(root: FileSystemDirectoryHandle, objectFolder: string): Promise<FileSystemDirectoryHandle | null> {
  let dir = root
  try {
    for (const part of segments(objectFolder)) dir = await dir.getDirectoryHandle(part)
  } catch {
    return null
  }
  return dir
}

// Reads the given files (by name) from the object folder tree as File objects.
export async function getObjectFolderFiles(root: FileSystemDirectoryHandle, objectFolder: string, names: string[]): Promise<File[]> {
  const dir = await resolveObjectDir(root, objectFolder)
  if (!dir) return []
  const wanted = new Set(names)
  const out: File[] = []
  const scan = async (d: FileSystemDirectoryHandle): Promise<void> => {
    for await (const handle of d.values()) {
      if (handle.kind === 'directory') await scan(handle as FileSystemDirectoryHandle)
      else if (wanted.has(handle.name)) {
        wanted.delete(handle.name)
        out.push(await (handle as FileSystemFileHandle).getFile())
      }
    }
  }
  await scan(dir)
  return out
}

export interface DeleteStats { deleted: number; failed: number }

// Deletes the given subs from the object folder — every file sharing a base
// name (extension and processing suffixes ignored), so derived copies go too.
export async function deleteObjectFolderFiles(root: FileSystemDirectoryHandle, objectFolder: string, fileNames: string[]): Promise<DeleteStats> {
  const stats: DeleteStats = { deleted: 0, failed: 0 }
  const dir = await resolveObjectDir(root, objectFolder)
  if (!dir) return stats
  const targets = new Set(fileNames.map(n => baseOf(stemOf(n))))
  const scan = async (d: FileSystemDirectoryHandle): Promise<void> => {
    // Collect first — don't mutate the directory while iterating it.
    const files: string[] = []
    const dirs: FileSystemDirectoryHandle[] = []
    for await (const handle of d.values()) {
      if (handle.kind === 'directory') dirs.push(handle as FileSystemDirectoryHandle)
      else files.push(handle.name)
    }
    for (const name of files) {
      if (!targets.has(baseOf(stemOf(name)))) continue
      try { await d.removeEntry(name); stats.deleted++ } catch { stats.failed++ }
    }
    for (const sub of dirs) await scan(sub)
  }
  await scan(dir)
  return stats
}

export interface SourceDeleteStats { deleted: number; failed: number; notFound: number }

// Deletes the named subs from a source folder tree. Exact file names only: a
// capture dump holds the originals, so there are no derived copies to sweep up.
// Names not found are reported rather than failed — an import batch can span
// more than one source folder.
export async function deleteFilesFromDirectory(dir: FileSystemDirectoryHandle, fileNames: string[]): Promise<SourceDeleteStats> {
  const wanted = new Set(fileNames)
  const stats: SourceDeleteStats = { deleted: 0, failed: 0, notFound: 0 }
  const scan = async (d: FileSystemDirectoryHandle): Promise<void> => {
    // Collect first — don't mutate the directory while iterating it.
    const files: string[] = []
    const dirs: FileSystemDirectoryHandle[] = []
    for await (const handle of d.values()) {
      if (handle.kind === 'directory') dirs.push(handle as FileSystemDirectoryHandle)
      else files.push(handle.name)
    }
    for (const name of files) {
      if (!wanted.has(name)) continue
      wanted.delete(name)
      try { await d.removeEntry(name); stats.deleted++ } catch { stats.failed++ }
    }
    for (const sub of dirs) await scan(sub)
  }
  await scan(dir)
  stats.notFound = wanted.size
  return stats
}

export async function copyFilesToObjectFolders(
  root: FileSystemDirectoryHandle,
  items: CopyItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<CopyStats> {
  const stats: CopyStats = { copied: 0, skipped: 0, failed: 0, replaced: [] }
  const total = items.reduce((n, i) => n + i.files.length, 0)
  let done = 0
  for (const item of items) {
    let destDir: FileSystemDirectoryHandle | null = null
    const destPath = [...segments(item.filterName), ...segments(item.panelFolder ?? '')]
    for (const file of item.files) {
      try {
        if (!destDir) destDir = await getDestDir(root, item)
        const replacing = item.replace?.has(file.name) ?? false
        let exists = true
        try { await destDir.getFileHandle(file.name) } catch { exists = false }
        if (exists && !replacing) {
          stats.skipped++
        } else if (exists) {
          // Over an existing copy: the writable writes to a swap file and only
          // replaces the original on close, so a failed write leaves the old
          // copy intact rather than truncated — no removeEntry on this path.
          const dest = await destDir.getFileHandle(file.name)
          const writable = await dest.createWritable()
          try {
            await writable.write(file)
            await writable.close()
          } catch (err) {
            try { await writable.abort() } catch {}
            throw err
          }
          if ((await dest.getFile()).size !== file.size) throw new Error(`Copy of ${file.name} is incomplete`)
          stats.copied++
          stats.replaced.push({ objectFolder: item.objectFolder, dir: destPath, name: file.name })
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
          if (replacing) {
            if ((await dest.getFile()).size !== file.size) throw new Error(`Copy of ${file.name} is incomplete`)
            stats.replaced.push({ objectFolder: item.objectFolder, dir: destPath, name: file.name })
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

/**
 * After a reimport has landed a verified copy of each file, removes the earlier
 * copies of those same files left elsewhere in the object folder — an import
 * from before the mosaic panel folders, say. Exact names only: a processing
 * tool's derived copy ("…_c.xisf") is the user's own work and is left alone.
 * Only ever called with `replaced` from copyFilesToObjectFolders, so a file
 * whose new copy didn't land keeps every copy it had.
 */
export async function removeSupersededCopies(
  root: FileSystemDirectoryHandle,
  replaced: CopyStats['replaced'],
): Promise<DeleteStats> {
  const stats: DeleteStats = { deleted: 0, failed: 0 }
  const byObject = new Map<string, Map<string, string[]>>()
  for (const r of replaced) {
    const m = byObject.get(r.objectFolder) ?? new Map<string, string[]>()
    m.set(r.name, r.dir)
    byObject.set(r.objectFolder, m)
  }
  for (const [objectFolder, keep] of byObject) {
    const base = await resolveObjectDir(root, objectFolder)
    if (!base) continue
    const lower = (p: string[]) => p.map(s => s.toLowerCase()).join('/')
    for (const entry of await listObjectFolderEntries(root, objectFolder)) {
      const keptAt = keep.get(entry.name)
      if (!keptAt || lower(entry.dir) === lower(keptAt)) continue
      try {
        let d = base
        for (const part of entry.dir) d = await d.getDirectoryHandle(part)
        await d.removeEntry(entry.name)
        stats.deleted++
      } catch {
        stats.failed++
      }
    }
  }
  return stats
}
