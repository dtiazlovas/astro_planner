import sql from 'mssql'
import { connectToDatabase } from '../db.js'
import type { ApPlan, CreateApPlanDto, UpdateApPlanDto } from '../models/ApPlan.js'

const SELECT = 'SELECT id, [object], name, active FROM ap_plan'

export const getAllPlans = async (): Promise<ApPlan[]> => {
  const pool = await connectToDatabase()
  const result = await pool.request().query<ApPlan>(`${SELECT} ORDER BY name`)
  return result.recordset
}

export const getPlansByObject = async (objectId: number): Promise<ApPlan[]> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('object', sql.Int, objectId)
    .query<ApPlan>(`${SELECT} WHERE [object] = @object ORDER BY name`)
  return result.recordset
}

export const getPlanById = async (id: number): Promise<ApPlan | null> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query<ApPlan>(`${SELECT} WHERE id = @id`)
  return result.recordset[0] ?? null
}

export const createPlan = async (data: CreateApPlanDto): Promise<ApPlan> => {
  const pool = await connectToDatabase()
  const insert = await pool.request()
    .input('object', sql.Int,           data.object)
    .input('name',   sql.NVarChar(1000), data.name)
    .input('active', sql.Bit,            data.active)
    .query<{ id: number }>(`
      INSERT INTO ap_plan ([object], name, active)
      OUTPUT INSERTED.id
      VALUES (@object, @name, @active)
    `)
  return (await getPlanById(insert.recordset[0].id))!
}

export const updatePlan = async (id: number, data: UpdateApPlanDto): Promise<ApPlan | null> => {
  const setClauses: string[] = []
  const pool = await connectToDatabase()
  const req = pool.request().input('id', sql.Int, id)

  if (data.name   !== undefined) { setClauses.push('name = @name');     req.input('name',   sql.NVarChar(1000), data.name) }
  if (data.active !== undefined) { setClauses.push('active = @active'); req.input('active', sql.Bit,            data.active) }

  if (setClauses.length === 0) return getPlanById(id)
  await req.query(`UPDATE ap_plan SET ${setClauses.join(', ')} WHERE id = @id`)
  return getPlanById(id)
}

export const deletePlan = async (id: number): Promise<boolean> => {
  const pool = await connectToDatabase()
  await pool.request().input('id', sql.Int, id)
    .query('DELETE FROM ap_plan_session WHERE planid = @id')
  await pool.request().input('id', sql.Int, id)
    .query('DELETE FROM ap_plan_details WHERE planid = @id')
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM ap_plan OUTPUT DELETED.id WHERE id = @id')
  return result.recordset.length > 0
}
