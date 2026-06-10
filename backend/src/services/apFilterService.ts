import { connectToDatabase } from '../db.js'
import type { ApFilter } from '../models/ApFilter.js'

export const getAllApFilters = async (): Promise<ApFilter[]> => {
  return connectToDatabase().prepare('SELECT id, name, aliases FROM ap_filter ORDER BY id').all() as ApFilter[]
}

export const createApFilter = async (name: string, aliases: string | null): Promise<ApFilter> => {
  const db = connectToDatabase()
  const { lastInsertRowid } = db.prepare('INSERT INTO ap_filter (name, aliases) VALUES (@name, @aliases)').run({ name, aliases })
  return db.prepare('SELECT id, name, aliases FROM ap_filter WHERE id = @id').get({ id: Number(lastInsertRowid) }) as ApFilter
}

export const updateApFilter = async (id: number, name: string, aliases: string | null): Promise<ApFilter | null> => {
  const db = connectToDatabase()
  const { changes } = db.prepare('UPDATE ap_filter SET name = @name, aliases = @aliases WHERE id = @id').run({ name, aliases, id })
  if (!changes) return null
  return db.prepare('SELECT id, name, aliases FROM ap_filter WHERE id = @id').get({ id }) as ApFilter
}

export const deleteApFilter = async (id: number): Promise<boolean> => {
  const db = connectToDatabase()
  db.prepare('DELETE FROM ap_object_session WHERE filter = @id').run({ id })
  const { changes } = db.prepare('DELETE FROM ap_filter WHERE id = @id').run({ id })
  return changes > 0
}
