import Database from 'better-sqlite3'
import path from 'node:path'

let db: Database.Database | null = null

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
    const dbPath = process.env.SQLITE_PATH ?? path.join(process.cwd(), 'astro-planner.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    initSchema(db)
  }
  return db
}

export const closeDatabaseConnection = (): void => {
  db?.close()
  db = null
}
