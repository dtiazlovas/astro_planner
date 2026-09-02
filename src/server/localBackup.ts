// A local snapshot that keeps up with the work rather than with the clock.
//
// scripts/backup-daily.js is the floor: one snapshot a day, whether or not
// anything happened and whether or not the server is up. Its weakness is the
// gap. A 03:00 snapshot predates everything imported or culled after it, so an
// import at 04:00 and a cull at 20:00 spend the rest of the day with no copy of
// them anywhere; if the database goes bad at 22:00, the newest thing that can be
// restored is yesterday. Imports happen once or twice a day, which is to say the
// gap is almost always wider than the interval between the events worth
// protecting.
//
// This closes it from the other side: a few seconds after the last write of a
// burst, today's snapshot is taken again. Culls matter here at least as much as
// imports — a sub deleted in error is the one thing this app cannot undo, and
// until now the record of what it was sat in the same 24-hour blind spot.
//
// The two paths share one filename per day (dayName() in scripts/snapshot-db.js,
// mirrored below), so writes overwrite the day's snapshot instead of adding to
// it. BACKUP_KEEP therefore means days, and the retention window is unchanged by
// any of this — what changes is how fresh the newest file is.
//
// What it does NOT do is replace the scheduled job. This one only runs while the
// process is up and only when something is written, and — the reason worth
// keeping the job for — a day when this code has silently stopped working is a
// day the scheduled snapshot still lands.
//
// The trade accepted here: the second import of a day overwrites the state from
// before the first. If import #2 is the bad one, the rollback is to yesterday
// rather than to this morning. Raising BACKUP_KEEP costs one file per extra day
// and is the lever for that.
//
// Configuration:
//   BACKUP_DIR             where snapshots go. Shared with backup-daily.js;
//                          defaults the same way, /backups in a container.
//   BACKUP_AFTER_WRITE_MS  quiet period before the snapshot. Default 10000.
//                          Set to 0 to turn this path off and leave the
//                          scheduled job to it.
import fs from 'node:fs'
import path from 'node:path'
import { isBlobEnabled } from './blobDb.js'
import { appRoot, connectToDatabase, dbFilePath } from './db.js'

// Long enough that an import — dozens of /imported/record calls — settles into
// one snapshot, short enough that closing the laptop after importing does not
// lose it. Every write restarts the clock, so this is quiet time, not a period.
const QUIET_MS = Number(process.env.BACKUP_AFTER_WRITE_MS ?? 10_000)

const log = (...args: unknown[]): void => console.log(`[backup ${new Date().toISOString()}]`, ...args)

// Deliberately duplicated from scripts/snapshot-db.js rather than imported:
// scripts/ belongs to tsconfig.node.json and this file to tsconfig.server.json,
// and it is bundled into dist/server.js by esbuild. Reaching across that
// boundary for two small functions would tangle both. They have to agree on the
// name, though — that is what stops the two paths writing separate files for one
// day — so a change to either belongs in both.
const backupDir = (): string =>
  process.env.BACKUP_DIR?.trim() || (fs.existsSync('/backups') ? '/backups' : path.join(appRoot(), 'backups'))

/** The name every snapshot taken on one UTC day shares. Matches dayName() in scripts/snapshot-db.js. */
const dayFileName = (at = new Date()): string => `astro_planner-${at.toISOString().slice(0, 10)}.db`

/**
 * Write the database over `target`, atomically.
 *
 * VACUUM INTO rather than a file copy — it takes a read transaction and writes
 * one self-contained file, where copying would race an in-flight write. Same
 * reasoning as uploadSnapshot() in db.ts.
 *
 * VACUUM INTO also refuses a file that already exists, so overwriting means
 * clearing the target first — and between that and the end of the VACUUM there
 * is no snapshot under that name at all. A run interrupted in that window
 * destroys the copy it was meant to improve on, which is a strange thing for a
 * backup to do. Writing beside the target and renaming in means the target is
 * always either the old snapshot or the new one.
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
 * Keep the newest snapshot under the database's own name too — the copy to
 * reach for without reading a date out of a directory listing. backup-daily.js
 * maintains the same file; if only that one did, this copy would be up to a day
 * behind the day file beside it, which is the opposite of its purpose.
 */
const writeLatest = (snapshot: string): void => {
  const latest = path.join(backupDir(), path.basename(dbFilePath()))
  // A BACKUP_DIR pointing at the database's own folder makes these one file, and
  // copying a snapshot over the live database destroys data rather than backing
  // it up.
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
    // Logged, never thrown. This runs after a response that has already gone out
    // reporting success, and the write it follows is safely in the database
    // either way — a failed backup must not be able to look like a failed write.
    // The next write retries, and the scheduled job is the backstop.
    log('FAILED —', err instanceof Error ? err.message : err)
    return
  }
  // Its own try/catch: the snapshot has landed, and losing the convenience copy
  // is not a failed backup.
  try {
    writeLatest(target)
  } catch (err) {
    log('latest copy FAILED —', err instanceof Error ? err.message : err)
  }
}

let timer: ReturnType<typeof setTimeout> | null = null

/**
 * Note that something was written; snapshot once the writing stops.
 *
 * An import is dozens of requests, and each one restarting the clock is what
 * turns the whole burst into a single snapshot at the end of it rather than a
 * VACUUM of the database per file recorded.
 */
export const scheduleLocalBackup = (): void => {
  // With a blob store the local file is a working copy that other instances
  // replace under us, and every write is already uploaded before its response
  // goes out. There is nothing here to protect and no stable file to copy.
  if (isBlobEnabled() || !(QUIET_MS > 0)) return

  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    run()
  }, QUIET_MS)
}
