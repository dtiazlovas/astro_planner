import { connectToDatabase } from '../db.js'
import type { ApSession, CreateApSessionDto, UpdateApSessionDto } from '../models/ApSession.js'

const SELECT_WITH_CALC = `
  SELECT
    s.id, s.name, s.start, s.duration, s.duration_set, s.comment,
    CAST(COALESCE(SUM(os.frames * e.duration), 0) AS INTEGER) AS calculated_seconds
  FROM ap_session s
  LEFT JOIN ap_object_session os ON os.session = s.id
  LEFT JOIN ap_exposure e ON e.id = os.exposure
`
const GROUP_BY = `GROUP BY s.id, s.name, s.start, s.duration, s.duration_set, s.comment`

function toIso(val: Date | string | null | undefined): string | null {
  if (val == null) return null
  return val instanceof Date ? val.toISOString() : val
}

function mapSession(row: any): ApSession {
  return {
    ...row,
    start: new Date(row.start),
    duration: row.duration ? new Date(row.duration) : null,
    duration_set: !!row.duration_set,
  }
}

export const getApSessionById = async (id: number): Promise<ApSession | null> => {
  const row = connectToDatabase().prepare(`${SELECT_WITH_CALC} WHERE s.id = @id ${GROUP_BY}`).get({ id }) as any
  return row ? mapSession(row) : null
}

export const getAllApSessions = async (): Promise<ApSession[]> => {
  return (connectToDatabase().prepare(`${SELECT_WITH_CALC} ${GROUP_BY} ORDER BY s.start DESC`).all() as any[]).map(mapSession)
}

export const createApSession = async (data: CreateApSessionDto): Promise<ApSession> => {
  const { lastInsertRowid } = connectToDatabase().prepare(`
    INSERT INTO ap_session (name, start, duration, duration_set, comment)
    VALUES (@name, @start, @duration, @duration_set, @comment)
  `).run({
    name: data.name,
    start: toIso(data.start),
    duration: toIso(data.duration ?? null),
    duration_set: data.duration_set ? 1 : 0,
    comment: data.comment ?? null,
  })
  return (await getApSessionById(Number(lastInsertRowid)))!
}

export const updateApSession = async (id: number, data: UpdateApSessionDto): Promise<ApSession | null> => {
  const setClauses: string[] = []
  const params: Record<string, unknown> = { id }

  if (data.name !== undefined)         { setClauses.push('name = @name');                params.name = data.name }
  if (data.start !== undefined)        { setClauses.push('start = @start');              params.start = toIso(data.start) }
  if ('duration' in data)              { setClauses.push('duration = @duration');        params.duration = toIso(data.duration ?? null) }
  if (data.duration_set !== undefined) { setClauses.push('duration_set = @duration_set'); params.duration_set = data.duration_set ? 1 : 0 }
  if ('comment' in data)               { setClauses.push('comment = @comment');          params.comment = data.comment ?? null }

  if (setClauses.length === 0) return getApSessionById(id)
  connectToDatabase().prepare(`UPDATE ap_session SET ${setClauses.join(', ')} WHERE id = @id`).run(params)
  return getApSessionById(id)
}

export const deleteApSession = async (id: number): Promise<boolean> => {
  const db = connectToDatabase()
  db.prepare('DELETE FROM ap_object_session WHERE session = @id').run({ id })
  const { changes } = db.prepare('DELETE FROM ap_session WHERE id = @id').run({ id })
  return changes > 0
}
