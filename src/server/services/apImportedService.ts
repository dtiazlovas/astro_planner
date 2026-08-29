import { connectToDatabase } from '../db.js'

// Every name in the IN list is bound as its own parameter, and one statement can
// hold only SQLITE_MAX_VARIABLE_NUMBER of them — so a long enough list does not
// return a wrong answer, it fails the statement outright. Chunking keeps the
// statement a fixed size no matter how many names the caller sends. The other
// functions here bind one row at a time inside a transaction and are already
// bounded; this is the only query whose shape grows with its input.
const CHECK_CHUNK = 500

// Culled records are deliberately not "imported": their sub was rejected and
// deleted, so offering the same file again is the right answer if it turns up
// in a capture folder a second time.
export const checkImported = async (names: string[]): Promise<string[]> => {
  if (!names.length) return []
  const db = connectToDatabase()
  const found: string[] = []
  for (let offset = 0; offset < names.length; offset += CHECK_CHUNK) {
    const chunk = names.slice(offset, offset + CHECK_CHUNK)
    const placeholders = chunk.map((_, i) => `@n${i}`).join(', ')
    const params = Object.fromEntries(chunk.map((n, i) => [`n${i}`, n]))
    const rows = db.prepare(`SELECT filename FROM ap_imported WHERE filename IN (${placeholders}) AND culled = 0`).all(params) as { filename: string }[]
    for (const row of rows) found.push(row.filename)
  }
  return found
}

// `objectSessionId` ties each file to the session entry it was imported under,
// so deleting that entry can take its records with it. Re-recording a known
// file re-points it rather than leaving the old link in place.
// `culled` records a sub the import rejected: no file was copied anywhere, and
// the row exists only to be counted against its night. Re-importing a file that
// was culled before clears the flag, since the row then describes a real sub.
// `exposureId` is how long the sub was shot for, kept on the row itself so a
// culled sub with no entry behind it still knows what it cost. A caller that
// doesn't know it leaves the stored value alone rather than erasing it.
export const recordImported = async (names: string[], sessionId: number, objectSessionId: number | null = null, culled = false, exposureId: number | null = null): Promise<void> => {
  if (!names.length) return
  const db = connectToDatabase()
  const insert = db.prepare('INSERT OR IGNORE INTO ap_imported (filename, session_id, object_session_id, culled, exposure) VALUES (@filename, @sessionId, @objectSessionId, @culled, @exposureId)')
  const update = db.prepare('UPDATE ap_imported SET session_id = @sessionId, object_session_id = @objectSessionId, culled = @culled, exposure = COALESCE(@exposureId, exposure) WHERE filename = @filename')
  db.transaction((ns: string[]) => {
    for (const filename of ns) {
      const params = { filename, sessionId, objectSessionId, culled: culled ? 1 : 0, exposureId }
      if (insert.run(params).changes === 0) update.run(params)
    }
  })(names)
}

// Flags existing records as culled instead of deleting them: the subs are off
// disk, but what they cost the night they were shot on is worth keeping. The
// session and entry links stay, so the record is still cleaned up when its
// session is deleted.
export const cullImported = async (names: string[]): Promise<number> => {
  if (!names.length) return 0
  const db = connectToDatabase()
  const stmt = db.prepare('UPDATE ap_imported SET culled = 1 WHERE filename = @filename')
  let culled = 0
  db.transaction((ns: string[]) => { for (const filename of ns) culled += stmt.run({ filename }).changes })(names)
  return culled
}

// Points records at an existing entry, taking the session from the entry itself
// so the two can't disagree. Used by the object file sync to attribute records
// predating the link, and to move them off entries it is about to merge away.
export const relinkImported = async (names: string[], objectSessionId: number): Promise<number> => {
  if (!names.length) return 0
  const db = connectToDatabase()
  const entry = db.prepare('SELECT session FROM ap_object_session WHERE id = @id').get({ id: objectSessionId }) as { session: number } | undefined
  if (!entry) return 0
  const stmt = db.prepare('UPDATE ap_imported SET object_session_id = @objectSessionId, session_id = @sessionId WHERE filename = @filename')
  let relinked = 0
  db.transaction((ns: string[]) => {
    for (const filename of ns) relinked += stmt.run({ filename, objectSessionId, sessionId: entry.session }).changes
  })(names)
  return relinked
}

export interface ImportedRow {
  filename: string
  session_id: number | null
  object_session_id: number | null
  psfsw: number | null
  fwhm: number | null
  culled: number
}

export const getAllImported = async (): Promise<ImportedRow[]> => {
  return connectToDatabase().prepare('SELECT filename, session_id, object_session_id, psfsw, fwhm, culled FROM ap_imported').all() as ImportedRow[]
}

// Persists per-file quality analysis (raw PSFSW + FWHM) on existing records.
export const saveImportedAnalysis = async (items: { filename: string; psfsw: number | null; fwhm: number | null }[]): Promise<number> => {
  if (!items.length) return 0
  const db = connectToDatabase()
  const stmt = db.prepare('UPDATE ap_imported SET psfsw = @psfsw, fwhm = @fwhm WHERE filename = @filename')
  let updated = 0
  db.transaction((rows: typeof items) => {
    for (const r of rows) updated += stmt.run({ filename: r.filename, psfsw: r.psfsw, fwhm: r.fwhm }).changes
  })(items)
  return updated
}

export const removeImported = async (names: string[]): Promise<number> => {
  if (!names.length) return 0
  const db = connectToDatabase()
  const stmt = db.prepare('DELETE FROM ap_imported WHERE filename = @filename')
  let removed = 0
  db.transaction((ns: string[]) => { for (const filename of ns) removed += stmt.run({ filename }).changes })(names)
  return removed
}
