import sql from 'mssql'
import { connectToDatabase } from '../db.js'
import type { ApSession, CreateApSessionDto, UpdateApSessionDto } from '../models/ApSession.js'

const SELECT_WITH_CALC = `
  SELECT
    s.id, s.name, s.start, s.duration, s.duration_set, s.comment,
    CAST(COALESCE(SUM(os.frames * e.duration), 0) AS int) AS calculated_seconds
  FROM ap_session s
  LEFT JOIN ap_object_session os ON os.session = s.id
  LEFT JOIN ap_exposure e ON e.id = os.exposure
`
const GROUP_BY = `GROUP BY s.id, s.name, s.start, s.duration, s.duration_set, s.comment`

export const getApSessionById = async (id: number): Promise<ApSession | null> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query<ApSession>(`${SELECT_WITH_CALC} WHERE s.id = @id ${GROUP_BY}`)
  return result.recordset[0] ?? null
}

export const getAllApSessions = async (): Promise<ApSession[]> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .query<ApSession>(`${SELECT_WITH_CALC} ${GROUP_BY} ORDER BY s.start DESC`)
  return result.recordset
}

export const createApSession = async (data: CreateApSessionDto): Promise<ApSession> => {
  const pool = await connectToDatabase()
  const insert = await pool.request()
    .input('name', sql.NVarChar(1000), data.name)
    .input('start', sql.DateTime, data.start)
    .input('duration', sql.DateTime, data.duration ?? null)
    .input('duration_set', sql.Bit, data.duration_set)
    .input('comment', sql.NVarChar(1000), data.comment ?? null)
    .query<{ id: number }>(`
      INSERT INTO ap_session (name, start, duration, duration_set, comment)
      OUTPUT INSERTED.id
      VALUES (@name, @start, @duration, @duration_set, @comment)
    `)
  return (await getApSessionById(insert.recordset[0].id))!
}

export const updateApSession = async (id: number, data: UpdateApSessionDto): Promise<ApSession | null> => {
  const setClauses: string[] = []
  const pool = await connectToDatabase()
  const req = pool.request().input('id', sql.Int, id)

  if (data.name !== undefined) { setClauses.push('name = @name'); req.input('name', sql.NVarChar(1000), data.name) }
  if (data.start !== undefined) { setClauses.push('start = @start'); req.input('start', sql.DateTime, data.start) }
  if ('duration' in data) { setClauses.push('duration = @duration'); req.input('duration', sql.DateTime, data.duration ?? null) }
  if (data.duration_set !== undefined) { setClauses.push('duration_set = @duration_set'); req.input('duration_set', sql.Bit, data.duration_set) }
  if ('comment' in data) { setClauses.push('comment = @comment'); req.input('comment', sql.NVarChar(1000), data.comment ?? null) }

  if (setClauses.length === 0) return getApSessionById(id)

  await req.query(`UPDATE ap_session SET ${setClauses.join(', ')} WHERE id = @id`)
  return getApSessionById(id)
}

export const deleteApSession = async (id: number): Promise<boolean> => {
  const pool = await connectToDatabase()
  await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM ap_object_session WHERE session = @id')
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM ap_session OUTPUT DELETED.id WHERE id = @id')
  return result.recordset.length > 0
}
