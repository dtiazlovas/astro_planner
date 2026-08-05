import { connectToDatabase } from '../db.js'
import type { ApFilter } from '../models/ApFilter.js'

export const getAllApFilters = async (): Promise<ApFilter[]> => {
  return connectToDatabase().prepare('SELECT id, name, aliases, folder FROM ap_filter ORDER BY id').all() as ApFilter[]
}

export const createApFilter = async (name: string, aliases: string | null, folder: string | null): Promise<ApFilter> => {
  const db = connectToDatabase()
  const { lastInsertRowid } = db.prepare('INSERT INTO ap_filter (name, aliases, folder) VALUES (@name, @aliases, @folder)').run({ name, aliases, folder })
  return db.prepare('SELECT id, name, aliases, folder FROM ap_filter WHERE id = @id').get({ id: Number(lastInsertRowid) }) as ApFilter
}

export const updateApFilter = async (id: number, name: string, aliases: string | null, folder: string | null): Promise<ApFilter | null> => {
  const db = connectToDatabase()
  const { changes } = db.prepare('UPDATE ap_filter SET name = @name, aliases = @aliases, folder = @folder WHERE id = @id').run({ name, aliases, folder, id })
  if (!changes) return null
  return db.prepare('SELECT id, name, aliases, folder FROM ap_filter WHERE id = @id').get({ id }) as ApFilter
}

// As with objects: the entries being removed are referenced by import records
// and plan links, which have to go first or the delete fails on the foreign key.
export const deleteApFilter = async (id: number): Promise<boolean> => {
  const db = connectToDatabase()
  return db.transaction((): boolean => {
    const entries = 'SELECT id FROM ap_object_session WHERE filter = @id'
    db.prepare(`DELETE FROM ap_imported WHERE object_session_id IN (${entries})`).run({ id })
    db.prepare(`DELETE FROM ap_plan_session WHERE session IN (${entries})`).run({ id })
    db.prepare('DELETE FROM ap_object_session WHERE filter = @id').run({ id })
    const { changes } = db.prepare('DELETE FROM ap_filter WHERE id = @id').run({ id })
    return changes > 0
  })()
}
