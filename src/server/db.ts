import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadDbToFile, isBlobEnabled, remoteEtag, remoteVersion, uploadDbFromFile } from './blobDb.js'

let db: Database.Database | null = null

// A relative SQLITE_PATH is resolved against the app root, not the working
// directory: SQLite creates a database when the file is absent, so a launch
// from the wrong directory would silently open a brand-new empty one instead
// of failing. dist/server.js is one level below the root, src/server/db.ts two.
export const appRoot = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return process.env.NODE_ENV === 'development' ? path.join(here, '..', '..') : path.join(here, '..')
}

// Where the file lives, with its directory guaranteed to exist. Deliberately
// free of side effects on the file itself, so the blob restore can drop a
// database in before anything decides the file is missing.
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

    -- The fixed divisor a target+filter's PSFSW values are shown against.
    -- Set once from the median of that pair's subs and then left alone: a
    -- scale recomputed from a growing population would move every previously
    -- seen number, which is exactly what makes subs incomparable across time.
    CREATE TABLE IF NOT EXISTS ap_psfsw_anchor (
      object INTEGER NOT NULL REFERENCES ap_object(id),
      filter INTEGER NOT NULL REFERENCES ap_filter(id),
      anchor REAL    NOT NULL,
      subs   INTEGER NOT NULL,
      set_at TEXT    NOT NULL,
      PRIMARY KEY (object, filter)
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
  // Migrate: mark the records of subs that were culled — rejected by an approve
  // line or dropped by eye. The file is gone (never copied in, or deleted from
  // the object folder), so the record no longer stands for a sub in the
  // library; it is kept only so the night it was shot on can report what was
  // thrown away. Everything that reasons about files on disk skips these.
  try { database.exec('ALTER TABLE ap_imported ADD COLUMN culled INTEGER NOT NULL DEFAULT 0') } catch {}
  // Migrate: link each import record to the session entry it was imported
  // under. session_id alone can't say which entry of a multi-filter session a
  // file belongs to, so deleting one entry couldn't take its records with it.
  // No ON DELETE CASCADE: entry deletion is handled explicitly, and a cascade
  // would silently drop records (and their saved analysis) when a file sync
  // merges duplicate entries.
  try { database.exec('ALTER TABLE ap_imported ADD COLUMN object_session_id INTEGER REFERENCES ap_object_session(id)') } catch {}
  // Migrate: the exposure the sub was shot at, as the import parsed it from the
  // filename. Records that belong to an entry take their length from the entry,
  // so this only has to answer for the ones that don't: a night whose every sub
  // was culled has no entry to ask, and without this its cull time would be
  // zero no matter how long it spent shooting.
  try { database.exec('ALTER TABLE ap_imported ADD COLUMN exposure INTEGER REFERENCES ap_exposure(id)') } catch {}
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
    console.log(`SQLite: ${dbPath}`)
    db = new Database(dbPath)
    // Rollback journal rather than WAL. One writer, a few dozen rows a session:
    // WAL's concurrent readers buy nothing here, while its -shm shared-memory
    // file costs — it is what keeps the database off a Windows bind mount, and
    // it is a second sidecar to account for every time the file is copied or
    // replaced. DELETE removes the journal at the end of each transaction, so
    // at rest the database is exactly one file.
    //
    // Set explicitly even though it is SQLite's own default: the mode is
    // persistent in the file header, so an existing WAL database converts only
    // because this line runs, and converting is the point.
    //
    // The trade: a reader in another process — the backup container's VACUUM
    // INTO — and a write here can now block each other, where WAL let them
    // overlap. better-sqlite3 gives every connection a 5s busy timeout, which
    // is ample for a megabyte.
    db.pragma('journal_mode = DELETE')
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
  const database = connectToDatabase()

  if (restored) {
    console.log('Restored database from Vercel Blob')
  } else {
    // Nothing stored yet. Whatever we just opened — an empty schema on a fresh
    // host, or a real local database — becomes the stored one. To populate a new
    // store from an existing database instead, push it first: `npm run db:push`.
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
 * Return once the database on disk is safely in the blob — nothing queued and
 * nothing in flight.
 *
 * Waiting for an upload this caller did not start is the whole point. Two
 * callers overlap on every write (the response path and the request handler),
 * and an earlier version returned early when it found the dirty flag already
 * claimed — leaving the caller believing the snapshot had landed while it was
 * still uploading. On a host that suspends the instance as soon as the handler
 * resolves, that is a lost write.
 */
export const flushDatabaseToBlob = async (): Promise<void> => {
  if (!isBlobEnabled()) return
  for (;;) {
    if (dirty) {
      dirty = false
      const run = uploadSnapshot()
      // pending must never reject: it is awaited by callers that did not start
      // it and have no business handling its failure. The initiator below still
      // sees the error, and the re-armed flag makes the next write retry.
      pending = run.catch(() => { dirty = true })
      await run
      // A write may have arrived while that was uploading; go round again.
      continue
    }
    const inFlight = pending
    await inFlight.catch(() => {})
    // Nothing queued while we waited, and no newer upload started behind us.
    if (!dirty && inFlight === pending) return
  }
}

// How long a read may serve without re-checking the store. Writes always check.
// Zero would be correct and slow: one page load fires a dozen API calls, and a
// round trip on each is latency for a change that cannot have happened in
// between. A couple of seconds collapses a burst into one check.
const READ_REVALIDATE_MS = Number(process.env.BLOB_REVALIDATE_MS ?? 2000)

let lastCheckedAt = 0
let refreshing: Promise<void> | null = null

/**
 * Make sure this instance is working from the store's current database.
 *
 * Instances are not told when another one writes, so a copy pulled at boot goes
 * stale silently: reads serve old data, and — worse — a write branches off the
 * stale copy and uploads a version missing whatever the other instance did.
 * Checking the version before handling a request is what keeps several
 * instances from diverging.
 *
 * `force` is for writes, which must branch off the current version. Reads are
 * allowed to be up to READ_REVALIDATE_MS behind.
 */
export const refreshDatabaseFromBlob = async (force: boolean): Promise<void> => {
  if (!isBlobEnabled()) return
  if (!force && Date.now() - lastCheckedAt < READ_REVALIDATE_MS) return
  // One check at a time; concurrent callers ride along with it.
  if (refreshing) return refreshing

  refreshing = (async () => {
    // Our own unsent changes go up first, or replacing the file would discard
    // them. After this the local copy and the store agree on our work.
    await flushDatabaseToBlob()

    const current = await remoteVersion()
    lastCheckedAt = Date.now()
    if (current === null || current === remoteEtag()) return

    // The store moved on: another instance wrote. Take its version — ours is
    // already in it, because the flush above went first.
    console.log(`Blob DB: store changed elsewhere (${remoteEtag()} → ${current}) — reloading`)
    closeDatabaseConnection()
    await downloadDbToFile(dbFilePath())
    connectToDatabase()
  })().finally(() => { refreshing = null })

  return refreshing
}

export const closeDatabaseConnection = (): void => {
  db?.close()
  db = null
}
