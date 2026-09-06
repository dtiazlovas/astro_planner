// Re-snapshots today's backup a few seconds after a burst of writes, so the
// newest copy is as fresh as the last import or cull rather than as fresh as the
// scheduled 03:00 run in scripts/backup-daily.js. Both paths are kept: this one
// only runs while the process is up, that one still lands on a day this has
// silently stopped working.
//
// One file per day, shared with backup-daily.js, so BACKUP_KEEP counts days. The
// trade: the second import of a day overwrites the state from before the first,
// and the rollback for a bad import #2 is yesterday.
//
//   BACKUP_DIR             where snapshots go. Shared with backup-daily.js.
//   BACKUP_AFTER_WRITE_MS  quiet period before the snapshot, default 10000.
//                          0 turns this path off.
import fs from 'node:fs'
import path from 'node:path'
import { isBlobEnabled } from './blobDb.js'
import { appRoot, connectToDatabase, dbFilePath } from './db.js'

// Quiet time, not a period: every write restarts the clock, so an import's dozens
// of /imported/record calls settle into one snapshot.
const QUIET_MS = Number(process.env.BACKUP_AFTER_WRITE_MS ?? 10_000)

const log = (...args: unknown[]): void => console.log(`[backup ${new Date().toISOString()}]`, ...args)

// Duplicated from scripts/snapshot-db.js rather than imported — different
// tsconfig projects, and this file is bundled by esbuild. The two must agree on
// the name, or each path writes its own file for one day: change both together.
const backupDir = (): string =>
  process.env.BACKUP_DIR?.trim() || (fs.existsSync('/backups') ? '/backups' : path.join(appRoot(), 'backups'))

/** Matches dayName() in scripts/snapshot-db.js. */
const dayFileName = (at = new Date()): string => `astro_planner-${at.toISOString().slice(0, 10)}.db`

/**
 * Write the database over `target`, atomically.
 *
 * VACUUM INTO takes a read transaction and writes one self-contained file, where
 * a file copy would race an in-flight write. It also refuses an existing target,
 * so it writes beside it and renames in — clearing the target first would leave a
 * window where a backup exists under neither the old copy nor the new one.
 */
const snapshotOnto = (target: string): number => {
  const partial = `${target}.partial`
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(partial + suffix, { force: true })

  connectToDatabase().exec(`VACUUM INTO '${partial.replace(/'/g, "''")}'`)
  const { size } = fs.statSync(partial)

  // Sidecars beside the file being replaced describe *it*; left in place,
  // SQLite replays them over the new one.
  for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(target + suffix, { force: true })
  fs.renameSync(partial, target)
  return size
}

/**
 * Keep the newest snapshot under the database's own name too — the copy to reach
 * for without reading a date out of a directory listing. backup-daily.js writes
 * the same file.
 */
const writeLatest = (snapshot: string): void => {
  const latest = path.join(backupDir(), path.basename(dbFilePath()))
  // A BACKUP_DIR pointing at the database's own folder makes these one file, and
  // copying a snapshot over the live database destroys data rather than backs it up.
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
    // Logged, never thrown: the response reporting success has already gone out
    // and the write is in the database either way. The next write retries, and
    // the scheduled job is the backstop.
    log('FAILED —', err instanceof Error ? err.message : err)
    return
  }
  // Separately caught — the snapshot has landed, and losing the convenience copy
  // is not a failed backup.
  try {
    writeLatest(target)
  } catch (err) {
    log('latest copy FAILED —', err instanceof Error ? err.message : err)
  }
}

let timer: ReturnType<typeof setTimeout> | null = null

/** Note that something was written; snapshot once the writing stops. */
export const scheduleLocalBackup = (): void => {
  // With a blob store the local file is a working copy other instances replace
  // under us, and every write is uploaded before its response goes out.
  if (isBlobEnabled() || !(QUIET_MS > 0)) return

  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    run()
  }, QUIET_MS)
}
