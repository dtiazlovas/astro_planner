import sql from 'mssql'
import { connectToDatabase } from '../db.js'
import type { ApObject, ObjectFilterStat, PlanProgressItem, CreateApObjectDto, UpdateApObjectDto } from '../models/ApObject.js'

const SELECT_WITH_CALC = `
  SELECT
    o.id, o.name, o.type, o.position_json, o.comment, o.active, o.aliases,
    CAST(ISNULL(SUM(os.frames * e.duration), 0) AS int) AS total_seconds
  FROM ap_object o
  LEFT JOIN ap_object_session os ON os.object = o.id
  LEFT JOIN ap_exposure e ON e.id = os.exposure
`
const GROUP_BY = `GROUP BY o.id, o.name, o.type, o.position_json, o.comment, o.active, o.aliases`

export const getAllApObjects = async (): Promise<ApObject[]> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .query<ApObject>(`${SELECT_WITH_CALC} ${GROUP_BY} ORDER BY o.id`)
  return result.recordset
}

export const getApObjectById = async (id: number): Promise<ApObject | null> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query<ApObject>(`${SELECT_WITH_CALC} WHERE o.id = @id ${GROUP_BY}`)
  return result.recordset[0] ?? null
}

export const getObjectFilterStats = async (objectId: number): Promise<ObjectFilterStat[]> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('objectId', sql.Int, objectId)
    .query<ObjectFilterStat>(`
      SELECT
        f.name AS filter_name,
        CAST(ISNULL(SUM(os.frames * e.duration), 0) AS int) AS total_seconds
      FROM ap_object_session os
      JOIN ap_exposure e ON e.id = os.exposure
      JOIN ap_filter f ON f.id = os.filter
      WHERE os.object = @objectId
      GROUP BY f.id, f.name
      ORDER BY total_seconds DESC
    `)
  return result.recordset
}

export const getObjectPlanProgress = async (objectId: number): Promise<PlanProgressItem[]> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('objectId', sql.Int, objectId)
    .query<PlanProgressItem>(`
      WITH ActivePlan AS (
        SELECT TOP 1 id FROM ap_plan WHERE [object] = @objectId AND active = 1 ORDER BY id
      )
      SELECT
        pd.[filter]  AS filter_id,
        f.name       AS filter_name,
        pd.duration  AS target_minutes,
        CAST(COALESCE(SUM(os.frames * e.duration), 0) AS int) AS captured_seconds
      FROM ActivePlan ap
      JOIN ap_plan_details pd ON pd.planid = ap.id
      JOIN ap_filter f        ON f.id = pd.[filter]
      LEFT JOIN ap_plan_session  ps ON ps.planid = ap.id
      LEFT JOIN ap_object_session os ON os.id = ps.session AND os.[filter] = pd.[filter]
      LEFT JOIN ap_exposure   e  ON e.id = os.exposure
      GROUP BY pd.[filter], f.name, pd.duration
      ORDER BY pd.[filter]
    `)
  return result.recordset
}

export const createApObject = async (data: CreateApObjectDto): Promise<ApObject> => {
  const pool = await connectToDatabase()
  const insert = await pool.request()
    .input('name', sql.NVarChar(1000), data.name)
    .input('type', sql.Int, data.type)
    .input('position_json', sql.NVarChar(1000), data.position_json)
    .input('comment', sql.NVarChar(1000), data.comment ?? null)
    .input('active', sql.Bit, data.active)
    .input('aliases', sql.NVarChar(1000), data.aliases ?? null)
    .query<{ id: number }>(`
      INSERT INTO ap_object (name, type, position_json, comment, active, aliases)
      OUTPUT INSERTED.id
      VALUES (@name, @type, @position_json, @comment, @active, @aliases)
    `)
  return (await getApObjectById(insert.recordset[0].id))!
}

export const updateApObject = async (id: number, data: UpdateApObjectDto): Promise<ApObject | null> => {
  const setClauses: string[] = []
  const pool = await connectToDatabase()
  const req = pool.request().input('id', sql.Int, id)

  if (data.name !== undefined) { setClauses.push('name = @name'); req.input('name', sql.NVarChar(1000), data.name) }
  if (data.type !== undefined) { setClauses.push('type = @type'); req.input('type', sql.Int, data.type) }
  if (data.position_json !== undefined) { setClauses.push('position_json = @position_json'); req.input('position_json', sql.NVarChar(1000), data.position_json) }
  if ('comment' in data) { setClauses.push('comment = @comment'); req.input('comment', sql.NVarChar(1000), data.comment ?? null) }
  if (data.active !== undefined) { setClauses.push('active = @active'); req.input('active', sql.Bit, data.active) }
  if ('aliases' in data) { setClauses.push('aliases = @aliases'); req.input('aliases', sql.NVarChar(1000), data.aliases ?? null) }

  if (setClauses.length === 0) return getApObjectById(id)

  await req.query(`UPDATE ap_object SET ${setClauses.join(', ')} WHERE id = @id`)
  return getApObjectById(id)
}

export const deleteApObject = async (id: number): Promise<boolean> => {
  const pool = await connectToDatabase()
  await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM ap_object_session WHERE [object] = @id')
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM ap_object OUTPUT DELETED.id WHERE id = @id')
  return result.recordset.length > 0
}
