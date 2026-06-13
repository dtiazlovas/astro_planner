import fs from 'node:fs/promises'
import path from 'node:path'
import { connectToDatabase } from '../db.js'

export const checkImported = async (names: string[]): Promise<string[]> => {
  if (!names.length) return []
  const db = connectToDatabase()
  const placeholders = names.map((_, i) => `@n${i}`).join(', ')
  const params = Object.fromEntries(names.map((n, i) => [`n${i}`, n]))
  return (db.prepare(`SELECT filename FROM ap_imported WHERE filename IN (${placeholders})`).all(params) as { filename: string }[]).map(r => r.filename)
}

export const recordImported = async (names: string[], sessionId: number): Promise<void> => {
  if (!names.length) return
  const db = connectToDatabase()
  const stmt = db.prepare('INSERT OR IGNORE INTO ap_imported (filename, session_id) VALUES (@filename, @sessionId)')
  db.transaction((ns: string[]) => { for (const filename of ns) stmt.run({ filename, sessionId }) })(names)
}

export interface CopyItem {
  fileNames: string[]
  objectFolder: string
  filterName: string
}

async function buildFileIndex(dir: string): Promise<Map<string, string>> {
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
