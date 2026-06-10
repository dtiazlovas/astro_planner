import sql from 'mssql'
import { connectToDatabase } from '../db.js'
import type { ApPlanSession, CreateApPlanSessionDto } from '../models/ApPlanSession.js'

const SELECT = 'SELECT id, session, planid FROM ap_plan_session'

export const getPlanSessionBySession = async (sessionId: number): Promise<ApPlanSession | null> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('session', sql.Int, sessionId)
    .query<ApPlanSession>(`${SELECT} WHERE session = @session`)
  return result.recordset[0] ?? null
}

export const setPlanSession = async (data: CreateApPlanSessionDto): Promise<ApPlanSession> => {
  const pool = await connectToDatabase()
  await pool.request()
    .input('session', sql.Int, data.session)
    .query('DELETE FROM ap_plan_session WHERE session = @session')
  await pool.request()
    .input('session', sql.Int, data.session)
    .input('planid',  sql.Int, data.planid)
    .query('INSERT INTO ap_plan_session (session, planid) VALUES (@session, @planid)')
  return (await getPlanSessionBySession(data.session))!
}

export const assignUnassignedToActivePlan = async (objectId: number): Promise<number> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('objectId', sql.Int, objectId)
    .query(`
      WITH ActivePlan AS (
        SELECT TOP 1 id FROM ap_plan WHERE [object] = @objectId AND active = 1 ORDER BY id
      )
      INSERT INTO ap_plan_session ([session], planid)
      SELECT os.id, ap.id
      FROM ap_object_session os
      CROSS JOIN ActivePlan ap
      WHERE os.object = @objectId
      AND NOT EXISTS (
        SELECT 1 FROM ap_plan_session ps WHERE ps.[session] = os.id
      )
    `)
  return result.rowsAffected[0]
}

export const deletePlanSession = async (id: number): Promise<boolean> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM ap_plan_session OUTPUT DELETED.id WHERE id = @id')
  return result.recordset.length > 0
}
