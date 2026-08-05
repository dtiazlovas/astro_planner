import { connectToDatabase } from '../db.js'
import type { ApObjectType, CreateApObjectTypeDto, UpdateApObjectTypeDto } from '../models/ApObjectType.js'

export const getAllApObjectTypes = async (): Promise<ApObjectType[]> => {
  return connectToDatabase().prepare('SELECT id, name FROM ap_object_types ORDER BY id').all() as ApObjectType[]
}

export const getApObjectTypeById = async (id: number): Promise<ApObjectType | null> => {
  return (connectToDatabase().prepare('SELECT id, name FROM ap_object_types WHERE id = @id').get({ id }) as ApObjectType) ?? null
}

export const createApObjectType = async (data: CreateApObjectTypeDto): Promise<ApObjectType> => {
  const { lastInsertRowid } = connectToDatabase().prepare('INSERT INTO ap_object_types (name) VALUES (@name)').run({ name: data.name })
  return (await getApObjectTypeById(Number(lastInsertRowid)))!
}

export const updateApObjectType = async (id: number, data: UpdateApObjectTypeDto): Promise<ApObjectType | null> => {
  if (data.name === undefined) return getApObjectTypeById(id)
  connectToDatabase().prepare('UPDATE ap_object_types SET name = @name WHERE id = @id').run({ name: data.name, id })
  return getApObjectTypeById(id)
}

export const deleteApObjectType = async (id: number): Promise<boolean> => {
  const { changes } = connectToDatabase().prepare('DELETE FROM ap_object_types WHERE id = @id').run({ id })
  return changes > 0
}
