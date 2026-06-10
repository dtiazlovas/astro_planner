import { connectToDatabase } from '../db.js'

export const checkImported = async (names: string[]): Promise<string[]> => {
  if (!names.length) return []
  const db = connectToDatabase()
  const placeholders = names.map((_, i) => `@n${i}`).join(', ')
  const params = Object.fromEntries(names.map((n, i) => [`n${i}`, n]))
  return (db.prepare(`SELECT filename FROM ap_imported WHERE filename IN (${placeholders})`).all(params) as { filename: string }[]).map(r => r.filename)
}

export const recordImported = async (names: string[]): Promise<void> => {
  if (!names.length) return
  const db = connectToDatabase()
  const stmt = db.prepare('INSERT OR IGNORE INTO ap_imported (filename) VALUES (@filename)')
  db.transaction((ns: string[]) => { for (const filename of ns) stmt.run({ filename }) })(names)
}
