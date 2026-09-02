// Writes a consistent copy of the live SQLite database somewhere else.
//
//   npm run db:snapshot                 # ./backups (or /backups in a container)
//   npm run db:snapshot -- some/file.db # explicit destination
//
// VACUUM INTO rather than a file copy: it takes a read transaction, folds the
// WAL in and writes one self-contained file, so the result is safe to open even
// while the server is writing to the original. Copying the file instead would
// race an in-flight write and leave the committed-but-uncheckpointed tail
// behind in the WAL. Same reasoning as uploadSnapshot() in src/server/db.ts.
//
// This exists because the container keeps the database on a named volume, out
// of Explorer's reach — see compose.yaml. It is also the module behind
// backup-daily.js, which is why the pieces are exported.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The database being copied: SQLITE_PATH, or the default beside the app. */
export const sourcePath = () => {
  const configured = process.env.SQLITE_PATH?.trim() || './data/astro_planner.db'
  return path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured)
}

/** /backups is where compose mounts the host folder; outside a container there is no such path. */
export const defaultBackupDir = () =>
  fs.existsSync('/backups') ? '/backups' : path.join(repoRoot, 'backups')

/** A filename that sorts chronologically and is legal on Windows (no colons). */
export const snapshotName = (at = new Date()) =>
  `astro_planner-${at.toISOString().replace(/[:.]/g, '-').replace('Z', '')}.db`

/**
 * The name every snapshot taken on one UTC day shares, so writing it again
 * replaces that day's copy instead of adding another.
 *
 * This is what makes BACKUP_KEEP a number of days. With a full timestamp in the
 * name, a week of container restarts — each one snapshots on start — left three
 * or four days of history under BACKUP_KEEP=7, because every restart consumed a
 * slot. It is also the file src/server/localBackup.ts rewrites after a write, so
 * the two paths converge on one file per day rather than interleaving.
 */
export const dayName = (at = new Date()) => `astro_planner-${at.toISOString().slice(0, 10)}.db`

export const snapshotTo = (source, target) => {
  if (!fs.existsSync(source)) throw new Error(`No database at ${source}`)

  fs.mkdirSync(path.dirname(target), { recursive: true })
  // VACUUM INTO refuses to write to a file that already exists, which is the
  // behaviour we want for a timestamped snapshot but not for an explicit
  // destination the caller reused. The sidecars have to go with it: left
  // behind, they belong to the database just deleted, and SQLite either fails
  // with SQLITE_CANTOPEN or — worse, for -journal — rolls an unrelated
  // transaction back over the new file. That matters when the destination is a
  // live database path: restoring over one is exactly this case. All three
  // suffixes, because both journal modes turn up here — a WAL database has
  // -wal/-shm, while a snapshot is written in rollback mode and gets -journal.
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(target + suffix, { force: true })

  const db = new Database(source, { readonly: true })
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
  return { target, size: fs.statSync(target).size }
}

/**
 * snapshotTo() for a target that may already hold a snapshot worth keeping
 * until the new one exists.
 *
 * snapshotTo() clears the target first, because VACUUM INTO refuses to write to
 * a file that is already there. That is right for a name nothing has used yet
 * and wrong for one being replaced: between the delete and the end of the VACUUM
 * there is no snapshot under that name at all, and a run interrupted in that
 * window destroys the copy it was supposed to improve on. Writing beside the
 * target and renaming in makes the replacement atomic — at every instant the
 * target is either the old snapshot or the new one, never a partial file and
 * never missing.
 */
export const snapshotOver = (source, target) => {
  const { size } = snapshotTo(source, `${target}.partial`)
  // Sidecars sitting beside the target describe the file about to be replaced.
  // Left in place, SQLite replays them over the new one. A snapshot is written
  // in rollback mode so -journal is the likely one — after someone opened this
  // copy in a SQLite browser — but a file switched to WAL leaves the other two.
  for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(target + suffix, { force: true })
  fs.renameSync(`${target}.partial`, target)
  return { target, size }
}

// Only when run directly, so backup-daily.js can import the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = sourcePath()
  if (!fs.existsSync(source)) {
    console.error(`No database at ${source} — set SQLITE_PATH if it lives elsewhere.`)
    process.exit(1)
  }
  const target = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(defaultBackupDir(), snapshotName())
  const { size } = snapshotTo(source, target)
  console.log(`Snapshot: ${target} (${(size / 1024).toFixed(0)} KB)`)
}
