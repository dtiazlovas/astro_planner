import sql from 'mssql'
import { connectToDatabase } from '../db.js'

export const checkImported = async (names: string[]): Promise<string[]> => {
  if (!names.length) return []
  const pool = await connectToDatabase()
  const req = pool.request()
  names.forEach((n, i) => req.input(`n${i}`, sql.NVarChar(500), n))
  const inClause = names.map((_, i) => `@n${i}`).join(', ')
  const result = await req.query<{ filename: string }>(
    `SELECT [filename] FROM ap_imported WHERE [filename] IN (${inClause})`
  )
  return result.recordset.map(r => r.filename)
}

export const recordImported = async (names: string[]): Promise<void> => {
  if (!names.length) return
  const pool = await connectToDatabase()
  for (const name of names) {
    await pool.request()
      .input('filename', sql.NVarChar(500), name)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM ap_imported WHERE [filename] = @filename)
          INSERT INTO ap_imported ([filename]) VALUES (@filename)
      `)
  }
}
