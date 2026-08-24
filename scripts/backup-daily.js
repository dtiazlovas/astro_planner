// Takes one snapshot of the database per day and prunes the old ones.
//
// Runs as the `backup` service in compose.yaml, so a daily backup needs nothing
// installed on the host and no Task Scheduler or cron entry — anyone who runs
// `docker compose up` gets it. Snapshots land in the bind-mounted ./backups, so
// they are visible on the host and survive deleting the database volume.
//
// Configuration (all optional):
//   BACKUP_AT     HH:MM to run at, container-local time. Default 03:00.
//                 The container is UTC unless TZ is set in compose.yaml.
//   BACKUP_KEEP   how many snapshots to retain. Default 7.
//   BACKUP_DIR    where to write them. Default /backups in a container.
//   SQLITE_PATH   which database to copy. Default ./data/astro_planner.db.
import fs from 'node:fs'
import path from 'node:path'
import { defaultBackupDir, snapshotName, snapshotTo, sourcePath } from './snapshot-db.js'

const dir = process.env.BACKUP_DIR?.trim() || defaultBackupDir()
const keep = Math.max(1, Number(process.env.BACKUP_KEEP ?? 7) || 7)
const at = (process.env.BACKUP_AT?.trim() || '03:00').split(':')
const atHour = Math.min(23, Math.max(0, Number(at[0]) || 0))
const atMinute = Math.min(59, Math.max(0, Number(at[1]) || 0))

const log = (...args) => console.log(`[backup ${new Date().toISOString()}]`, ...args)

// Snapshots are named from their timestamp, so the prefix identifies ours and
// nothing else in the folder is touched — a hand-made copy keeps its own name
// and is never pruned.
const existing = () => {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(n => /^astro_planner-.*\.db$/.test(n))
    .sort() // ISO timestamps sort chronologically
}

const prune = () => {
  const all = existing()
  for (const name of all.slice(0, Math.max(0, all.length - keep))) {
    fs.rmSync(path.join(dir, name), { force: true })
    log(`pruned ${name}`)
  }
}

const takenToday = () => {
  const today = new Date().toISOString().slice(0, 10)
  return existing().some(n => n.startsWith(`astro_planner-${today}`))
}

const runOnce = () => {
  try {
    const { target, size } = snapshotTo(sourcePath(), path.join(dir, snapshotName()))
    log(`wrote ${path.basename(target)} (${(size / 1024).toFixed(0)} KB)`)
    prune()
  } catch (err) {
    // Never exit on failure: a backup that dies on one bad night stops backing
    // up every night after it. The next run is the retry.
    log('FAILED —', err instanceof Error ? err.message : err)
  }
}

const msUntilNextRun = () => {
  const now = new Date()
  const next = new Date(now)
  next.setHours(atHour, atMinute, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  return next - now
}

log(`daily at ${String(atHour).padStart(2, '0')}:${String(atMinute).padStart(2, '0')}, keeping ${keep}, into ${dir}`)

// Catch up on start. A machine that is only switched on during the day would
// otherwise never reach the scheduled time and never back up at all.
if (takenToday()) log('a snapshot already exists for today — skipping catch-up')
else runOnce()

const schedule = () => {
  const wait = msUntilNextRun()
  log(`next run in ${(wait / 3600000).toFixed(1)}h`)
  // Chained timeouts rather than setInterval: each wait is recomputed from the
  // clock, so the run time cannot drift and a DST shift is absorbed.
  setTimeout(() => { runOnce(); schedule() }, wait)
}
schedule()
