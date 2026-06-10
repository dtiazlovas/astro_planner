import sql from 'mssql'
import { connectToDatabase } from '../db.js'
import type { ApObjectSession, ApObjectSessionRow, CreateApObjectSessionDto } from '../models/ApObjectSession.js'

type UpdateApObjectSessionDto = Partial<Pick<ApObjectSession, 'object' | 'frames' | 'exposure' | 'filter'>>

const SELECT_JOINED = `
  SELECT
    os.id, os.object, os.session, os.frames, os.exposure, os.filter,
    o.name     AS object_name,
    e.duration AS exposure_duration,
    f.name     AS filter_name,
    ps.id      AS plan_session_id,
    p.id       AS plan_id,
    p.name     AS plan_name
  FROM ap_object_session os
  JOIN ap_object   o  ON o.id  = os.object
  JOIN ap_exposure e  ON e.id  = os.exposure
  JOIN ap_filter   f  ON f.id  = os.filter
  LEFT JOIN ap_plan_session ps ON ps.session = os.id
  LEFT JOIN ap_plan         p  ON p.id = ps.planid
`

export const getBySession = async (sessionId: number): Promise<ApObjectSessionRow[]> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('session', sql.Int, sessionId)
    .query<ApObjectSessionRow>(`${SELECT_JOINED} WHERE os.session = @session ORDER BY os.id`)
  return result.recordset
}

export const createApObjectSession = async (data: CreateApObjectSessionDto): Promise<ApObjectSessionRow> => {
  const pool = await connectToDatabase()
  const insert = await pool.request()
    .input('object',   sql.Int, data.object)
    .input('session',  sql.Int, data.session)
    .input('frames',   sql.Int, data.frames)
    .input('exposure', sql.Int, data.exposure)
    .input('filter',   sql.Int, data.filter)
    .query<{ id: number }>(`
      INSERT INTO ap_object_session (object, session, frames, exposure, filter)
      OUTPUT INSERTED.id
      VALUES (@object, @session, @frames, @exposure, @filter)
    `)
  const newId = insert.recordset[0].id
  const result = await pool.request()
    .input('id', sql.Int, newId)
    .query<ApObjectSessionRow>(`${SELECT_JOINED} WHERE os.id = @id`)
  return result.recordset[0]
}

export const updateApObjectSession = async (id: number, data: UpdateApObjectSessionDto): Promise<ApObjectSessionRow | null> => {
  const setClauses: string[] = []
  const pool = await connectToDatabase()
  const req = pool.request().input('id', sql.Int, id)

  if (data.object   !== undefined) { setClauses.push('object = @object');     req.input('object',   sql.Int, data.object) }
  if (data.frames   !== undefined) { setClauses.push('frames = @frames');     req.input('frames',   sql.Int, data.frames) }
  if (data.exposure !== undefined) { setClauses.push('exposure = @exposure'); req.input('exposure', sql.Int, data.exposure) }
  if (data.filter   !== undefined) { setClauses.push('filter = @filter');     req.input('filter',   sql.Int, data.filter) }

  if (setClauses.length === 0) {
    const result = await pool.request().input('id', sql.Int, id)
      .query<ApObjectSessionRow>(`${SELECT_JOINED} WHERE os.id = @id`)
    return result.recordset[0] ?? null
  }

  await req.query(`UPDATE ap_object_session SET ${setClauses.join(', ')} WHERE id = @id`)
  const result = await pool.request().input('id', sql.Int, id)
    .query<ApObjectSessionRow>(`${SELECT_JOINED} WHERE os.id = @id`)
  return result.recordset[0] ?? null
}

export const deleteApObjectSession = async (id: number): Promise<boolean> => {
  const pool = await connectToDatabase()
  await pool.request().input('id', sql.Int, id)
    .query('DELETE FROM ap_plan_session WHERE session = @id')
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM ap_object_session OUTPUT DELETED.id WHERE id = @id')
  return result.recordset.length > 0
}
