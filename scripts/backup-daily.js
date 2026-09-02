// Takes one snapshot of the database per day, plus one on every start, and
// prunes the old ones.
//
// Runs as the `backup` service in compose.yaml, so a daily backup needs nothing
// installed on the host and no Task Scheduler or cron entry — anyone who runs
// `docker compose up` gets it. Snapshots land in the bind-mounted ./backups, so
// they are visible on the host and survive deleting the database volume.
//
// Starting always takes one, which makes `docker compose restart backup` the
// way to force a snapshot on demand — and covers a machine that is switched off
// at BACKUP_AT and would otherwise never reach it.
//
// This is the floor, not the whole story: the server rewrites the same day's
// file a few seconds after each burst of writes (src/server/localBackup.ts), so
// an import at 22:00 is in a snapshot at 22:00 rather than waiting for 03:00
// tomorrow. What this job still covers is a day nothing was written, a day the
// server was never up — and the one that matters most, a day that path has
// quietly stopped working.
//
// Configuration (all optional):
//   BACKUP_AT     HH:MM to run at, container-local time. Default 03:00.
//                 The container is UTC unless TZ is set in compose.yaml.
//   BACKUP_KEEP   how many days of snapshots to retain. Default 7. One file per
//                 day, so this is a number of days rather than of runs.
//   BACKUP_DIR    where to write them. Default /backups in a container.
//   SQLITE_PATH   which database to copy. Default ./data/astro_planner.db.
import fs from 'node:fs'
import path from 'node:path'
import { dayName, defaultBackupDir, snapshotOver, sourcePath } from './snapshot-db.js'

const dir = process.env.BACKUP_DIR?.trim() || defaultBackupDir()
const keep = Math.max(1, Number(process.env.BACKUP_KEEP ?? 7) || 7)
const at = (process.env.BACKUP_AT?.trim() || '03:00').split(':')
const atHour = Math.min(23, Math.max(0, Number(at[0]) || 0))
const atMinute = Math.min(59, Math.max(0, Number(at[1]) || 0))

const log = (...args) => console.log(`[backup ${new Date().toISOString()}]`, ...args)

// Snapshots carry a date in the name, so the prefix identifies ours and nothing
// else in the folder is touched — a hand-made copy keeps its own name and is
// never pruned. `.db` at the end also excludes the `.partial` file a snapshot is
// written through, which would otherwise be counted and pruned as history.
const existing = () => {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(n => /^astro_planner-.*\.db$/.test(n))
    .sort() // ISO dates sort chronologically
}

const prune = () => {
  const all = existing()
  for (const name of all.slice(0, Math.max(0, all.length - keep))) {
    fs.rmSync(path.join(dir, name), { force: true })
    log(`pruned ${name}`)
  }
}

// The filenames are the record of what has run — there is no state file, and
// with the day in the name the check is just whether today's file is there.
// UTC, like the name itself, which is the same day as BACKUP_AT while the
// container is UTC; under a TZ far enough east that BACKUP_AT falls before
// midnight UTC the two dates differ by one, and since both sides of the
// comparison shift together that still comes to one snapshot a day.
const takenToday = () => fs.existsSync(path.join(dir, dayName()))

// The newest snapshot is also kept under the database's own file name —
// astro_planner.db, or whatever SQLITE_PATH is pointed at. The timestamped
// files are the history; this is the one to reach for when you just want the
// current data out of the volume, because it sits at a path you can type.
// Restoring, opening it in a SQLite browser, or `npm run db:upload --
// backups/astro_planner.db` then never involves reading a timestamp out of a
// directory listing.
//
// prune() cannot touch it: the name carries no `-<timestamp>`, so it does not
// match the pattern above.
const latestPath = () => path.join(dir, path.basename(sourcePath()))

const writeLatest = (snapshot) => {
  const latest = latestPath()
  // A BACKUP_DIR pointing at the database's own folder would make these the
  // same file, and copying a snapshot over the live database — its WAL still
  // beside it, describing the file that was just replaced — destroys data
  // rather than backing it up.
  if (path.resolve(latest) === path.resolve(sourcePath())) {
    return log(`not writing the latest copy: ${latest} is the live database`)
  }
  try {
    // A plain copy — the snapshot is already consistent and self-contained, so
    // there is nothing for a second VACUUM to do. Written beside the target and
    // renamed in, so an interrupted run leaves yesterday's copy whole instead
    // of a truncated one.
    fs.copyFileSync(snapshot, `${latest}.partial`)
    // Sidecars belong to the file they were made from. Left in place beside a
    // replaced database, SQLite replays an unrelated log over it. A snapshot is
    // written in rollback mode, so -journal is the one that can actually appear
    // here — after someone opens this copy in a SQLite browser — but a file
    // switched to WAL leaves the other two, and all three are cheap to clear.
    for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(latest + suffix, { force: true })
    fs.renameSync(`${latest}.partial`, latest)
    log(`latest copy at ${path.basename(latest)}`)
  } catch (err) {
    // Its own try/catch: the history snapshot has already landed, and losing
    // the convenience copy is not a failed backup.
    log('latest copy FAILED —', err instanceof Error ? err.message : err)
  }
}

const runOnce = () => {
  try {
    const { target, size } = snapshotOver(sourcePath(), path.join(dir, dayName()))
    log(`wrote ${path.basename(target)} (${(size / 1024).toFixed(0)} KB)`)
    writeLatest(target)
    prune()
  } catch (err) {
    // Never exit on failure: a backup that dies on one bad night stops backing
    // up every night after it. The next run is the retry.
    log('FAILED —', err instanceof Error ? err.message : err)
  }
}

// A timer this long does not land exactly where it was aimed. Inside a VM the
// loop's clock and the wall clock disagree by tens of parts per million, which
// over 24 hours is seconds: the 03:00 wake-up reliably fired at 02:59:56 here.
// Recomputing then found 03:00 still four seconds ahead and slept for it, so
// every day ran twice, four seconds apart. Day-named files absorb that now — the
// second run overwrites the first — but the run is a VACUUM of the whole
// database, so it is still worth not doing twice. Anything closer than this
// counts as the target already met, and the next run belongs to tomorrow.
const EARLY_TOLERANCE_MS = 5 * 60 * 1000

const msUntilNextRun = () => {
  const now = new Date()
  const next = new Date(now)
  next.setHours(atHour, atMinute, 0, 0)
  if (next - now < EARLY_TOLERANCE_MS) next.setDate(next.getDate() + 1)
  return next - now
}

log(`daily at ${String(atHour).padStart(2, '0')}:${String(atMinute).padStart(2, '0')}, keeping ${keep}, into ${dir}`)

// Unconditionally, even if today already has one: a start is a deliberate act,
// so `docker compose restart backup` is how you force a snapshot without
// remembering a command. It costs nothing now that the name is the day's — a
// restart refreshes today's file rather than spending one of BACKUP_KEEP.
log('snapshot on start')
runOnce()

const schedule = () => {
  const wait = msUntilNextRun()
  log(`next run in ${(wait / 3600000).toFixed(1)}h`)
  // Chained timeouts rather than setInterval: each wait is recomputed from the
  // clock, so the run time cannot drift and a DST shift is absorbed.
  setTimeout(() => {
    // The tolerance above keeps the timer from firing twice for one day, and
    // this keeps the *rule* — one a day — true whatever the timer does, since
    // a start earlier today may already have covered it.
    if (takenToday()) log('a snapshot already exists for today — skipping')
    else runOnce()
    schedule()
  }, wait)
}
schedule()
