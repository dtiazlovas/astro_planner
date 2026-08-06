import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { blobActivity, blobKey, downloadDbToFile, isBlobEnabled, remoteEtag, uploadDbFromFile } from './blobDb.js'

let db: Database.Database | null = null

// A relative SQLITE_PATH is resolved against the app root, not the working
// directory: SQLite creates a database when the file is absent, so a launch
// from the wrong directory would silently open a brand-new empty one instead
// of failing. dist/server.js is one level below the root, src/server/db.ts two.
const appRoot = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return process.env.NODE_ENV === 'development' ? path.join(here, '..', '..') : path.join(here, '..')
}

// Optional starting point for a database that doesn't exist yet: a checked-in
// data/seed.db is copied into place on first boot. That's how data reaches a
// host whose only writable storage is a fresh mounted disk. It is strictly a
// seed — once the real file exists it is never touched again, so a redeploy
// can't roll live data back to whatever the repo happened to hold.
const seedIfAbsent = (target: string): void => {
  if (fs.existsSync(target)) return
  const seed = [path.resolve(process.cwd(), 'data', 'seed.db'), path.resolve(appRoot(), 'data', 'seed.db')]
    .find(candidate => fs.existsSync(candidate))
  if (!seed) return
  fs.copyFileSync(seed, target)
  console.log(`Seeded database from ${seed}`)
}

// Where the file lives, with its directory guaranteed to exist. Deliberately
// free of side effects on the file itself, so the blob restore can drop a
// database in before anything decides the file is missing and seeds one.
export const dbFilePath = (): string => {
  const configured = process.env.SQLITE_PATH?.trim() || './data/astro_planner.db'
  const full = path.isAbsolute(configured) ? configured : path.resolve(appRoot(), configured)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  return full
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ap_object_types (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ap_filter (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name    TEXT,
      aliases TEXT
    );

    CREATE TABLE IF NOT EXISTS ap_exposure (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      duration INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ap_object (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      type          INTEGER NOT NULL REFERENCES ap_object_types(id),
      position_json TEXT    NOT NULL,
      comment       TEXT,
      active        INTEGER NOT NULL DEFAULT 1,
      aliases       TEXT
    );

    CREATE TABLE IF NOT EXISTS ap_session (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      start        TEXT    NOT NULL,
      duration     TEXT,
      duration_set INTEGER NOT NULL DEFAULT 0,
      comment      TEXT
    );

    CREATE TABLE IF NOT EXISTS ap_object_session (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      object   INTEGER NOT NULL REFERENCES ap_object(id),
      session  INTEGER NOT NULL REFERENCES ap_session(id),
      frames   INTEGER NOT NULL,
      exposure INTEGER NOT NULL REFERENCES ap_exposure(id),
      filter   INTEGER NOT NULL REFERENCES ap_filter(id)
    );

    CREATE TABLE IF NOT EXISTS ap_plan (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      object INTEGER NOT NULL REFERENCES ap_object(id),
      name   TEXT    NOT NULL,
      active INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ap_plan_details (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      planid   INTEGER NOT NULL REFERENCES ap_plan(id),
      filter   INTEGER NOT NULL REFERENCES ap_filter(id),
      duration INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ap_plan_session (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      session INTEGER NOT NULL REFERENCES ap_object_session(id),
      planid  INTEGER NOT NULL REFERENCES ap_plan(id)
    );

    CREATE TABLE IF NOT EXISTS ap_settings (
      name  TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS ap_imported (
      filename TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ap_equipment (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      focal_length INTEGER NOT NULL,
      focal_ratio  REAL    NOT NULL,
      reducer      REAL    NOT NULL DEFAULT 1.0,
      sensor       TEXT    NOT NULL,
      binning      INTEGER NOT NULL DEFAULT 1
    );
  `)

  // Migrate: add priority column if missing
  try { database.exec('ALTER TABLE ap_object ADD COLUMN priority INTEGER NOT NULL DEFAULT 0') } catch {}
  // Migrate: add session_id FK to ap_imported
  try { database.exec('ALTER TABLE ap_imported ADD COLUMN session_id INTEGER REFERENCES ap_session(id) ON DELETE CASCADE') } catch {}
  // Migrate: add folder column to ap_object
  try { database.exec('ALTER TABLE ap_object ADD COLUMN folder TEXT') } catch {}
  // Migrate: add folder column to ap_filter with defaults for built-in filters
  try { database.exec('ALTER TABLE ap_filter ADD COLUMN folder TEXT') } catch {}
  // Migrate: tag sessions and plans with the equipment (rig) used
  try { database.exec('ALTER TABLE ap_session ADD COLUMN equipment INTEGER REFERENCES ap_equipment(id)') } catch {}
  try { database.exec('ALTER TABLE ap_plan ADD COLUMN equipment INTEGER REFERENCES ap_equipment(id)') } catch {}
  // Migrate: persist per-file quality analysis (raw PSFSW + FWHM in pixels)
  try { database.exec('ALTER TABLE ap_imported ADD COLUMN psfsw REAL') } catch {}
  try { database.exec('ALTER TABLE ap_imported ADD COLUMN fwhm REAL') } catch {}
  // Migrate: link each import record to the session entry it was imported
  // under. session_id alone can't say which entry of a multi-filter session a
  // file belongs to, so deleting one entry couldn't take its records with it.
  // No ON DELETE CASCADE: entry deletion is handled explicitly, and a cascade
  // would silently drop records (and their saved analysis) when a file sync
  // merges duplicate entries.
  try { database.exec('ALTER TABLE ap_imported ADD COLUMN object_session_id INTEGER REFERENCES ap_object_session(id)') } catch {}
  // One row per file. Without this, `INSERT OR IGNORE` was a plain insert and
  // a file could sit in two rows — the entry link is only authoritative if a
  // second, unlinked row for the same file can't exist. Fold any duplicates
  // into the newest row first, keeping whatever the older ones knew.
  try {
    const dupes = (database.prepare(
      'SELECT COUNT(*) AS c FROM (SELECT filename FROM ap_imported GROUP BY filename HAVING COUNT(*) > 1)'
    ).get() as { c: number }).c
    if (dupes > 0) {
      database.transaction(() => {
        database.exec(`
          UPDATE ap_imported AS t SET
            psfsw      = COALESCE(t.psfsw,      (SELECT MAX(o.psfsw)      FROM ap_imported o WHERE o.filename = t.filename)),
            fwhm       = COALESCE(t.fwhm,       (SELECT MAX(o.fwhm)       FROM ap_imported o WHERE o.filename = t.filename)),
            session_id = COALESCE(t.session_id, (SELECT MAX(o.session_id) FROM ap_imported o WHERE o.filename = t.filename))
        `)
        database.exec('DELETE FROM ap_imported WHERE rowid NOT IN (SELECT MAX(rowid) FROM ap_imported GROUP BY filename)')
      })()
    }
    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_imported_filename ON ap_imported(filename)')
  } catch {}
  // Backfill the link where it is unambiguous: a session with exactly one entry
  // leaves no doubt which entry its records belong to. Records of multi-entry
  // sessions need the filename patterns to attribute, so an object file sync
  // links those as it re-attributes files to entries.
  try {
    database.exec(`
      UPDATE ap_imported SET object_session_id = (
        SELECT os.id FROM ap_object_session os WHERE os.session = ap_imported.session_id
      )
      WHERE object_session_id IS NULL AND session_id IS NOT NULL
        AND (SELECT COUNT(*) FROM ap_object_session os WHERE os.session = ap_imported.session_id) = 1
    `)
  } catch {}
  for (const [name, folder] of [['Luminance','Lum'],['Red','R'],['Green','G'],['Blue','B'],['H-alpha','Ha'],['Oxygen','Oiii'],['Sulphur','Sii']]) {
    database.prepare('UPDATE ap_filter SET folder = @folder WHERE name = @name AND folder IS NULL').run({ folder, name })
  }
  // Initialise unique priorities for existing rows that all share the default 0
  const allZero = (database.prepare('SELECT COUNT(*) as c FROM ap_object WHERE priority != 0').get() as { c: number }).c === 0
  const objCount = (database.prepare('SELECT COUNT(*) as c FROM ap_object').get() as { c: number }).c
  if (allZero && objCount > 1) {
    const rows = database.prepare('SELECT id FROM ap_object ORDER BY id').all() as { id: number }[]
    const upd = database.prepare('UPDATE ap_object SET priority = @priority WHERE id = @id')
    database.transaction(() => { rows.forEach((r, i) => upd.run({ priority: i, id: r.id })) })()
  }

  const empty = (database.prepare('SELECT COUNT(*) as c FROM ap_object_types').get() as { c: number }).c === 0
  if (empty) {
    const insert = database.prepare('INSERT INTO ap_object_types (name) VALUES (@name)')
    database.transaction(() => {
      for (const name of ['Star', 'Star cluster', 'Emission nebula', 'Reflection nebula', 'Galaxy']) {
        insert.run({ name })
      }
    })()
  }

  const settingsEmpty = (database.prepare('SELECT COUNT(*) as c FROM ap_settings').get() as { c: number }).c === 0
  if (settingsEmpty) {
    database.prepare('INSERT INTO ap_settings (name, value) VALUES (@name, @value)')
      .run({ name: 'file_pattern', value: 'Light_{target}_*_{duration}.0s_Bin1_{filter}_{short_datetime}_{filenumber}.fit' })
  }

  const exposuresEmpty = (database.prepare('SELECT COUNT(*) as c FROM ap_exposure').get() as { c: number }).c === 0
  if (exposuresEmpty) {
    const insert = database.prepare('INSERT INTO ap_exposure (duration) VALUES (@duration)')
    database.transaction(() => {
      for (const duration of [30, 60, 120, 180, 240, 300, 600]) {
        insert.run({ duration })
      }
    })()
  }

  // Seed a default rig, then tag any existing/untagged sessions and plans with it
  const equipmentEmpty = (database.prepare('SELECT COUNT(*) as c FROM ap_equipment').get() as { c: number }).c === 0
  if (equipmentEmpty) {
    database.prepare(
      'INSERT INTO ap_equipment (name, focal_length, focal_ratio, reducer, sensor, binning) VALUES (@name, @focal_length, @focal_ratio, @reducer, @sensor, @binning)'
    ).run({ name: 'Default Rig', focal_length: 250, focal_ratio: 4.9, reducer: 1.0, sensor: '571', binning: 1 })
  }
  const defaultRig = database.prepare('SELECT id FROM ap_equipment ORDER BY id LIMIT 1').get() as { id: number } | undefined
  if (defaultRig) {
    database.prepare('UPDATE ap_session SET equipment = @id WHERE equipment IS NULL').run({ id: defaultRig.id })
    database.prepare('UPDATE ap_plan SET equipment = @id WHERE equipment IS NULL').run({ id: defaultRig.id })
  }

  const filtersEmpty = (database.prepare('SELECT COUNT(*) as c FROM ap_filter').get() as { c: number }).c === 0
  if (filtersEmpty) {
    const insert = database.prepare('INSERT INTO ap_filter (name, aliases, folder) VALUES (@name, @aliases, @folder)')
    database.transaction(() => {
      for (const { name, aliases, folder } of [
        { name: 'Luminance', aliases: 'L;Lum',       folder: 'Lum' },
        { name: 'Red',       aliases: 'R',            folder: 'R' },
        { name: 'Green',     aliases: 'G',            folder: 'G' },
        { name: 'Blue',      aliases: 'B',            folder: 'B' },
        { name: 'H-alpha',   aliases: 'H;Ha',         folder: 'Ha' },
        { name: 'Oxygen',    aliases: 'O;Oiii;OIII',  folder: 'Oiii' },
        { name: 'Sulphur',   aliases: 'S;Sii;Siii',   folder: 'Sii' },
      ]) {
        insert.run({ name, aliases, folder })
      }
    })()
  }
}

export const connectToDatabase = (): Database.Database => {
  if (!db) {
    const dbPath = dbFilePath()
    seedIfAbsent(dbPath)
    console.log(`SQLite: ${dbPath}`)
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    initSchema(db)
  }
  return db
}

/**
 * Open the database, pulling it from Vercel Blob first when one is configured.
 *
 * Callers that only need a handle keep using the synchronous
 * connectToDatabase() — every service does. This exists for the two entrypoints,
 * which have to await the restore before the first request is served.
 */
export const initDatabase = async (): Promise<Database.Database> => {
  if (db) return db

  if (!isBlobEnabled()) return connectToDatabase()

  const dbPath = dbFilePath()
  const restored = await downloadDbToFile(dbPath)
  restoredAtBoot = restored
  const database = connectToDatabase()

  if (restored) {
    console.log('Restored database from Vercel Blob')
  } else {
    // Nothing stored yet. Whatever we just opened — a restored-from-seed copy on
    // a fresh host, or a real local database — becomes the stored one, which is
    // how data first gets into the store without a separate migration step.
    console.log('No database in Vercel Blob yet — uploading the local one')
    markDatabaseDirty()
    await flushDatabaseToBlob()
  }

  return database
}

// Snapshot bookkeeping. A request marks the database dirty when it finishes
// successfully; the flush coalesces a burst of writes into one upload, because
// each upload ships the entire file.
let dirty = false
let pending: Promise<void> = Promise.resolve()
let restoredAtBoot: boolean | null = null

// On a serverless host the process logs are the only window into what happened,
// and each instance has its own. This is the same picture over HTTP, so
// /api/health can answer "is the blob actually being used, and by which
// instance" without digging through Vercel's log viewer. Hitting it repeatedly
// and seeing the instance change is itself the finding: more than one instance
// is serving, and they hold independent copies of the database.
const INSTANCE = `${Math.random().toString(36).slice(2, 8)}`
const BOOTED_AT = new Date().toISOString()

export const databaseStatus = (): Record<string, unknown> => ({
  instance: INSTANCE,
  bootedAt: BOOTED_AT,
  path: dbFilePath(),
  blob: isBlobEnabled()
    ? {
        enabled: true,
        key: blobKey(),
        // null means initDatabase() has not run — the entrypoint never awaited it.
        restoredAtBoot,
        pendingSnapshot: dirty,
        remoteVersion: remoteEtag(),
        ...blobActivity(),
      }
    : {
        enabled: false,
        // The single most common deployment mistake: the store exists but was
        // never connected to the project, so the token never reaches the code
        // and every write dies with the instance.
        reason: 'BLOB_READ_WRITE_TOKEN is not set in this environment',
      },
})

export const markDatabaseDirty = (): void => { dirty = true }

const uploadSnapshot = async (): Promise<void> => {
  const database = connectToDatabase()
  const snapshot = path.join(os.tmpdir(), `astro-planner-snapshot-${process.pid}-${Date.now()}.db`)
  fs.rmSync(snapshot, { force: true })
  // VACUUM INTO, not a file copy: it takes a read transaction, folds the WAL in
  // and writes one self-contained file. Copying the live database instead would
  // race an in-flight write and would leave the committed-but-uncheckpointed
  // tail behind in the WAL we are not shipping.
  database.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`)
  try {
    await uploadDbFromFile(snapshot)
  } finally {
    fs.rmSync(snapshot, { force: true })
  }
}

/**
 * Push a snapshot if anything has changed since the last one. Safe to call
 * concurrently: overlapping callers await the in-flight upload rather than
 * starting a second one, and a failure re-arms the dirty flag so the next write
 * tries again.
 */
export const flushDatabaseToBlob = async (): Promise<void> => {
  if (!isBlobEnabled()) return
  await pending.catch(() => {})
  if (!dirty) return
  dirty = false
  const run = uploadSnapshot()
  pending = run.catch(() => { dirty = true })
  await run
}

export const closeDatabaseConnection = (): void => {
  db?.close()
  db = null
}
