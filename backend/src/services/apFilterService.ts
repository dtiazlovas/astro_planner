import sql from 'mssql'
import { connectToDatabase } from '../db.js'
import type { ApFilter } from '../models/ApFilter.js'

export const getAllApFilters = async (): Promise<ApFilter[]> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .query<ApFilter>('SELECT id, name, aliases FROM ap_filter ORDER BY id')
  return result.recordset
}

export const createApFilter = async (name: string, aliases: string | null): Promise<ApFilter> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('name', sql.NVarChar(200), name)
    .input('aliases', sql.NVarChar(sql.MAX), aliases)
    .query<ApFilter>(`
      INSERT INTO ap_filter ([name], [aliases])
      OUTPUT INSERTED.id, INSERTED.[name], INSERTED.[aliases]
      VALUES (@name, @aliases)
    `)
  return result.recordset[0]
}

export const updateApFilter = async (id: number, name: string, aliases: string | null): Promise<ApFilter | null> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('id', sql.Int, id)
    .input('name', sql.NVarChar(200), name)
    .input('aliases', sql.NVarChar(sql.MAX), aliases)
    .query<ApFilter>(`
      UPDATE ap_filter
      SET [name] = @name, [aliases] = @aliases
      OUTPUT INSERTED.id, INSERTED.[name], INSERTED.[aliases]
      WHERE id = @id
    `)
  return result.recordset[0] ?? null
}

export const deleteApFilter = async (id: number): Promise<boolean> => {
  const pool = await connectToDatabase()
  await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM ap_object_session WHERE filter = @id')
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM ap_filter OUTPUT DELETED.id WHERE id = @id')
  return result.recordset.length > 0
}
