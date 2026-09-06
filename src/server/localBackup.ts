// Re-snapshots today's backup seconds after a burst of writes, so the newest
// copy is as fresh as the last import or cull rather than as the scheduled run in
// scripts/backup-daily.js — which is kept, since it still lands on a day this has
// silently stopped working. One file per day shared with it, so BACKUP_KEEP
// counts days and a bad second import of a day rolls back to yesterday.
//
//   BACKUP_DIR             where snapshots go. Shared with backup-daily.js.
//   BACKUP_AFTER_WRITE_MS  quiet period before the snapshot, default 10000; 0 off.
import fs from 'node:fs'
import path from 'node:path'
import { isBlobEnabled } from './blobDb.js'
import { appRoot, connectToDatabase, dbFilePath } from './db.js'

// Quiet time, not a period: every write restarts the clock, so an import's
// dozens of calls settle into one snapshot.
const QUIET_MS = Number(process.env.BACKUP_AFTER_WRITE_MS ?? 10_000)

const log = (...args: unknown[]): void => console.log(`[backup ${new Date().toISOString()}]`, ...args)

// Duplicated from scripts/snapshot-db.js (different tsconfig projects, and this
// file is bundled). They must agree on the name or each writes its own file for
// one day — change both together.
const backupDir = (): string =>
  process.env.BACKUP_DIR?.trim() || (fs.existsSync('/backups') ? '/backups' : path.join(appRoot(), 'backups'))

/** Matches dayName() in scripts/snapshot-db.js. */
const dayFileName = (at = new Date()): string => `astro_planner-${at.toISOString().slice(0, 10)}.db`

/**
 * Write the database over `target`, atomically. VACUUM INTO takes a read
 * transaction, where a copy would race an in-flight write; it also refuses an
 * existing target, so it writes beside it and renames in rather than leaving a
 * window with no backup under the name at all.
 */
const snapshotOnto = (target: string): number => {
  const partial = `${target}.partial`
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(partial + suffix, { force: true })

  connectToDatabase().exec(`VACUUM INTO '${partial.replace(/'/g, "''")}'`)
  const { size } = fs.statSync(partial)

  // Sidecars describe the file being replaced; left in place, SQLite replays
  // them over the new one.
  for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(target + suffix, { force: true })
  fs.renameSync(partial, target)
  return size
}

/** The newest snapshot under the database's own name; backup-daily.js writes it too. */
const writeLatest = (snapshot: string): void => {
  const latest = path.join(backupDir(), path.basename(dbFilePath()))
  // A BACKUP_DIR pointing at the database's own folder makes these one file, and
  // copying a snapshot over the live database destroys data.
  if (path.resolve(latest) === path.resolve(dbFilePath())) return
  fs.copyFileSync(snapshot, `${latest}.partial`)
  for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(latest + suffix, { force: true })
  fs.renameSync(`${latest}.partial`, latest)
}

const run = (): void => {
  let target
  try {
    const dir = backupDir()
    fs.mkdirSync(dir, { recursive: true })
    target = path.join(dir, dayFileName())
    const size = snapshotOnto(target)
    log(`wrote ${path.basename(target)} (${(size / 1024).toFixed(0)} KB)`)
  } catch (err) {
    // Logged, never thrown: the success response has already gone out and the
    // write is in the database either way.
    log('FAILED —', err instanceof Error ? err.message : err)
    return
  }
  // Separately caught: losing the convenience copy is not a failed backup.
  try {
    writeLatest(target)
  } catch (err) {
    log('latest copy FAILED —', err instanceof Error ? err.message : err)
  }
}

let timer: ReturnType<typeof setTimeout> | null = null

/** Note that something was written; snapshot once the writing stops. */
export const scheduleLocalBackup = (): void => {
  // With a blob store the local file is a working copy other instances replace,
  // and every write is already uploaded before its response goes out.
  if (isBlobEnabled() || !(QUIET_MS > 0)) return

  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    run()
  }, QUIET_MS)
}
