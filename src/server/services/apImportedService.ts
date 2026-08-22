import fs from 'node:fs/promises'
import path from 'node:path'
import { connectToDatabase } from '../db.js'

// Culled records are deliberately not "imported": their sub was rejected and
// deleted, so offering the same file again is the right answer if it turns up
// in a capture folder a second time.
export const checkImported = async (names: string[]): Promise<string[]> => {
  if (!names.length) return []
  const db = connectToDatabase()
  const placeholders = names.map((_, i) => `@n${i}`).join(', ')
  const params = Object.fromEntries(names.map((n, i) => [`n${i}`, n]))
  return (db.prepare(`SELECT filename FROM ap_imported WHERE filename IN (${placeholders}) AND culled = 0`).all(params) as { filename: string }[]).map(r => r.filename)
}

// `objectSessionId` ties each file to the session entry it was imported under,
// so deleting that entry can take its records with it. Re-recording a known
// file re-points it rather than leaving the old link in place.
// `culled` records a sub the import rejected: no file was copied anywhere, and
// the row exists only to be counted against its night. Re-importing a file that
// was culled before clears the flag, since the row then describes a real sub.
export const recordImported = async (names: string[], sessionId: number, objectSessionId: number | null = null, culled = false): Promise<void> => {
  if (!names.length) return
  const db = connectToDatabase()
  const insert = db.prepare('INSERT OR IGNORE INTO ap_imported (filename, session_id, object_session_id, culled) VALUES (@filename, @sessionId, @objectSessionId, @culled)')
  const update = db.prepare('UPDATE ap_imported SET session_id = @sessionId, object_session_id = @objectSessionId, culled = @culled WHERE filename = @filename')
  db.transaction((ns: string[]) => {
    for (const filename of ns) {
      const params = { filename, sessionId, objectSessionId, culled: culled ? 1 : 0 }
      if (insert.run(params).changes === 0) update.run(params)
    }
  })(names)
}

// Flags existing records as culled instead of deleting them: the subs are off
// disk, but what they cost the night they were shot on is worth keeping. The
// session and entry links stay, so the record is still cleaned up when its
// session is deleted.
export const cullImported = async (names: string[]): Promise<number> => {
  if (!names.length) return 0
  const db = connectToDatabase()
  const stmt = db.prepare('UPDATE ap_imported SET culled = 1 WHERE filename = @filename')
  let culled = 0
  db.transaction((ns: string[]) => { for (const filename of ns) culled += stmt.run({ filename }).changes })(names)
  return culled
}

// Points records at an existing entry, taking the session from the entry itself
// so the two can't disagree. Used by the object file sync to attribute records
// predating the link, and to move them off entries it is about to merge away.
export const relinkImported = async (names: string[], objectSessionId: number): Promise<number> => {
  if (!names.length) return 0
  const db = connectToDatabase()
  const entry = db.prepare('SELECT session FROM ap_object_session WHERE id = @id').get({ id: objectSessionId }) as { session: number } | undefined
  if (!entry) return 0
  const stmt = db.prepare('UPDATE ap_imported SET object_session_id = @objectSessionId, session_id = @sessionId WHERE filename = @filename')
  let relinked = 0
  db.transaction((ns: string[]) => {
    for (const filename of ns) relinked += stmt.run({ filename, objectSessionId, sessionId: entry.session }).changes
  })(names)
  return relinked
}

export interface ImportedRow {
  filename: string
  session_id: number | null
  object_session_id: number | null
  psfsw: number | null
  fwhm: number | null
  culled: number
}

export const getAllImported = async (): Promise<ImportedRow[]> => {
  return connectToDatabase().prepare('SELECT filename, session_id, object_session_id, psfsw, fwhm, culled FROM ap_imported').all() as ImportedRow[]
}

// Persists per-file quality analysis (raw PSFSW + FWHM) on existing records.
export const saveImportedAnalysis = async (items: { filename: string; psfsw: number | null; fwhm: number | null }[]): Promise<number> => {
  if (!items.length) return 0
  const db = connectToDatabase()
  const stmt = db.prepare('UPDATE ap_imported SET psfsw = @psfsw, fwhm = @fwhm WHERE filename = @filename')
  let updated = 0
  db.transaction((rows: typeof items) => {
    for (const r of rows) updated += stmt.run({ filename: r.filename, psfsw: r.psfsw, fwhm: r.fwhm }).changes
  })(items)
  return updated
}

export const removeImported = async (names: string[]): Promise<number> => {
  if (!names.length) return 0
  const db = connectToDatabase()
  const stmt = db.prepare('DELETE FROM ap_imported WHERE filename = @filename')
  let removed = 0
  db.transaction((ns: string[]) => { for (const filename of ns) removed += stmt.run({ filename }).changes })(names)
  return removed
}

// Lists file names (recursively) inside the given object folder under the
// images folder. Returns null when the images folder isn't configured.
export const listObjectFolderFiles = async (objectFolder: string): Promise<string[] | null> => {
  const db = connectToDatabase()
  const setting = db.prepare("SELECT value FROM ap_settings WHERE name = 'images_folder'").get() as { value: string } | undefined
  const imagesFolder = setting?.value?.trim()
  if (!imagesFolder) return null
  const root = path.resolve(imagesFolder)
  const dir = path.resolve(root, objectFolder)
  if (dir !== root && !dir.startsWith(root + path.sep)) return null // traversal guard
  const names: string[] = []
  const scan = async (current: string) => {
    try {
      const entries = await fs.readdir(current, { withFileTypes: true })
      await Promise.all(entries.map(entry =>
        entry.isDirectory() ? scan(path.join(current, entry.name)) : Promise.resolve(void names.push(entry.name))
      ))
    } catch {}
  }
  await scan(dir)
  return names
}

const stemOf = (n: string) => n.replace(/\.[^.]+$/, '').toLowerCase()
const baseOf = (s: string): string => {
  // Strip trailing "_<alpha...>" processing suffixes; numeric ones are frame numbers.
  while (true) {
    const t = s.replace(/_[a-z][a-z0-9]*$/, '')
    if (t === s) return s
    s = t
  }
}

// Deletes the given subs from the object folder — every file sharing a base
// name (extension and processing suffixes ignored), so derived copies go too.
// Returns null when the images folder isn't configured.
export const deleteObjectFolderFiles = async (objectFolder: string, fileNames: string[]): Promise<{ deleted: number; failed: number } | null> => {
  const db = connectToDatabase()
  const setting = db.prepare("SELECT value FROM ap_settings WHERE name = 'images_folder'").get() as { value: string } | undefined
  const imagesFolder = setting?.value?.trim()
  if (!imagesFolder) return null
  const root = path.resolve(imagesFolder)
  const dir = path.resolve(root, objectFolder)
  if (dir !== root && !dir.startsWith(root + path.sep)) return null // traversal guard
  const targets = new Set(fileNames.map(n => baseOf(stemOf(n))))
  const stats = { deleted: 0, failed: 0 }
  const scan = async (current: string) => {
    try {
      const entries = await fs.readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) { await scan(full); continue }
        if (!targets.has(baseOf(stemOf(entry.name)))) continue
        try { await fs.unlink(full); stats.deleted++ } catch { stats.failed++ }
      }
    } catch {}
  }
  await scan(dir)
  return stats
}

export interface CopyItem {
  fileNames: string[]
  objectFolder: string
  filterName: string
}

export async function buildFileIndex(dir: string): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  const scan = async (current: string) => {
    try {
      const entries = await fs.readdir(current, { withFileTypes: true })
      await Promise.all(entries.map(entry => {
        const full = path.join(current, entry.name)
        return entry.isDirectory() ? scan(full) : Promise.resolve(void index.set(entry.name, full))
      }))
    } catch {}
  }
  await scan(dir)
  return index
}

export interface SourceDeleteStats { deleted: number; failed: number; notFound: number; skipped: number }

// Deletes the subs an import copied from, located by name in the same tree
// copyFilesToObjectFolders searches. Anything found inside the images folder is
// left alone and counted as skipped — that file is the copy, not the source,
// and it is all that remains of the sub. Returns null when the images folder
// isn't configured.
export const deleteSourceFiles = async (fileNames: string[]): Promise<SourceDeleteStats | null> => {
  const stats: SourceDeleteStats = { deleted: 0, failed: 0, notFound: 0, skipped: 0 }
  if (!fileNames.length) return stats
  const db = connectToDatabase()
  const setting = db.prepare("SELECT value FROM ap_settings WHERE name = 'images_folder'").get() as { value: string } | undefined
  const imagesFolder = setting?.value?.trim()
  if (!imagesFolder) return null

  const root = path.resolve(imagesFolder)
  const index = await buildFileIndex(path.dirname(root))
  for (const fileName of new Set(fileNames)) {
    const srcPath = index.get(fileName)
    if (!srcPath) { stats.notFound++; continue }
    const resolved = path.resolve(srcPath)
    if (resolved === root || resolved.startsWith(root + path.sep)) { stats.skipped++; continue }
    try { await fs.unlink(resolved); stats.deleted++ } catch { stats.failed++ }
  }
  return stats
}

export interface CopyStats { copied: number; skipped: number; notFound: number; failed: number }

export const copyFilesToObjectFolders = async (items: CopyItem[]): Promise<CopyStats> => {
  const stats: CopyStats = { copied: 0, skipped: 0, notFound: 0, failed: 0 }
  if (!items.length) return stats
  const db = connectToDatabase()
  const setting = db.prepare("SELECT value FROM ap_settings WHERE name = 'images_folder'").get() as { value: string } | undefined
  const imagesFolder = setting?.value?.trim()
  if (!imagesFolder) return stats

  // Search the parent of imagesFolder so files in sibling folders (e.g. camera dumps) are found,
  // while files already inside imagesFolder are detected and skipped below.
  const searchRoot = path.dirname(imagesFolder)
  const index = await buildFileIndex(searchRoot)

  const imagesFolderPrefix = imagesFolder + path.sep

  for (const item of items) {
    const destDir = path.join(imagesFolder, item.objectFolder, item.filterName)
    let destDirCreated = false
    for (const fileName of item.fileNames) {
      const srcPath = index.get(fileName)
      if (!srcPath) { stats.notFound++; continue }
      // File is already inside the images folder — no copy needed
      if (srcPath.startsWith(imagesFolderPrefix)) { stats.skipped++; continue }
      if (!destDirCreated) { await fs.mkdir(destDir, { recursive: true }); destDirCreated = true }
      const destPath = path.join(destDir, fileName)
      try {
        await fs.copyFile(srcPath, destPath, fs.constants.COPYFILE_EXCL)
        stats.copied++
      } catch (err: any) {
        if (err?.code === 'EEXIST') stats.skipped++
        else stats.failed++
      }
    }
  }

  return stats
}
