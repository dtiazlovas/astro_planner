import sql from 'mssql'
import { connectToDatabase } from '../db.js'
import type { ApObjectType, CreateApObjectTypeDto, UpdateApObjectTypeDto } from '../models/ApObjectType.js'

export const getAllApObjectTypes = async (): Promise<ApObjectType[]> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .query<ApObjectType>('SELECT id, name FROM ap_object_types ORDER BY id')
  return result.recordset
}

export const getApObjectTypeById = async (id: number): Promise<ApObjectType | null> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query<ApObjectType>('SELECT id, name FROM ap_object_types WHERE id = @id')
  return result.recordset[0] ?? null
}

export const createApObjectType = async (data: CreateApObjectTypeDto): Promise<ApObjectType> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('name', sql.NVarChar(100), data.name)
    .query<ApObjectType>(
      'INSERT INTO ap_object_types (name) OUTPUT INSERTED.id, INSERTED.name VALUES (@name)'
    )
  return result.recordset[0]
}

export const updateApObjectType = async (id: number, data: UpdateApObjectTypeDto): Promise<ApObjectType | null> => {
  if (data.name === undefined) return getApObjectTypeById(id)
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('id', sql.Int, id)
    .input('name', sql.NVarChar(100), data.name)
    .query<ApObjectType>(
      'UPDATE ap_object_types SET name = @name OUTPUT INSERTED.id, INSERTED.name WHERE id = @id'
    )
  return result.recordset[0] ?? null
}

export const deleteApObjectType = async (id: number): Promise<boolean> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM ap_object_types OUTPUT DELETED.id WHERE id = @id')
  return result.recordset.length > 0
}
