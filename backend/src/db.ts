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
  `)
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
