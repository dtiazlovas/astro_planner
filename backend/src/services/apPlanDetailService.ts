import sql from 'mssql'
import { connectToDatabase } from '../db.js'
import type { ApPlanDetail, CreateApPlanDetailDto, UpdateApPlanDetailDto } from '../models/ApPlanDetail.js'

const SELECT = 'SELECT id, planid, [filter], duration FROM ap_plan_details'

export const getDetailsByPlan = async (planId: number): Promise<ApPlanDetail[]> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('planid', sql.Int, planId)
    .query<ApPlanDetail>(`${SELECT} WHERE planid = @planid ORDER BY id`)
  return result.recordset
}

export const getDetailById = async (id: number): Promise<ApPlanDetail | null> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query<ApPlanDetail>(`${SELECT} WHERE id = @id`)
  return result.recordset[0] ?? null
}

export const createDetail = async (data: CreateApPlanDetailDto): Promise<ApPlanDetail> => {
  const pool = await connectToDatabase()
  const insert = await pool.request()
    .input('planid',   sql.Int, data.planid)
    .input('filter',   sql.Int, data.filter)
    .input('duration', sql.Int, data.duration)
    .query<{ id: number }>(`
      INSERT INTO ap_plan_details (planid, [filter], duration)
      OUTPUT INSERTED.id
      VALUES (@planid, @filter, @duration)
    `)
  return (await getDetailById(insert.recordset[0].id))!
}

export const updateDetail = async (id: number, data: UpdateApPlanDetailDto): Promise<ApPlanDetail | null> => {
  const setClauses: string[] = []
  const pool = await connectToDatabase()
  const req = pool.request().input('id', sql.Int, id)

  if (data.filter   !== undefined) { setClauses.push('[filter] = @filter');   req.input('filter',   sql.Int, data.filter) }
  if (data.duration !== undefined) { setClauses.push('duration = @duration'); req.input('duration', sql.Int, data.duration) }

  if (setClauses.length === 0) return getDetailById(id)
  await req.query(`UPDATE ap_plan_details SET ${setClauses.join(', ')} WHERE id = @id`)
  return getDetailById(id)
}

export const deleteDetail = async (id: number): Promise<boolean> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM ap_plan_details OUTPUT DELETED.id WHERE id = @id')
  return result.recordset.length > 0
}
