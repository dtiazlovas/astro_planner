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
  return connectToDatabase().prepare(`${SELECT_JOINED} WHERE os.session = @session ORDER BY os.id`).all({ session: sessionId }) as ApObjectSessionRow[]
}

export const createApObjectSession = async (data: CreateApObjectSessionDto): Promise<ApObjectSessionRow> => {
  const db = connectToDatabase()
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO ap_object_session (object, session, frames, exposure, filter)
    VALUES (@object, @session, @frames, @exposure, @filter)
  `).run(data)
  return db.prepare(`${SELECT_JOINED} WHERE os.id = @id`).get({ id: Number(lastInsertRowid) }) as ApObjectSessionRow
}

export const updateApObjectSession = async (id: number, data: UpdateApObjectSessionDto): Promise<ApObjectSessionRow | null> => {
  const setClauses: string[] = []
  const params: Record<string, unknown> = { id }

  if (data.object   !== undefined) { setClauses.push('object = @object');     params.object = data.object }
  if (data.frames   !== undefined) { setClauses.push('frames = @frames');     params.frames = data.frames }
  if (data.exposure !== undefined) { setClauses.push('exposure = @exposure'); params.exposure = data.exposure }
  if (data.filter   !== undefined) { setClauses.push('filter = @filter');     params.filter = data.filter }

  const db = connectToDatabase()
  if (setClauses.length > 0) {
    db.prepare(`UPDATE ap_object_session SET ${setClauses.join(', ')} WHERE id = @id`).run(params)
  }
  return (db.prepare(`${SELECT_JOINED} WHERE os.id = @id`).get({ id }) as ApObjectSessionRow) ?? null
}

export const deleteApObjectSession = async (id: number): Promise<boolean> => {
  const db = connectToDatabase()
  db.prepare('DELETE FROM ap_plan_session WHERE session = @id').run({ id })
  const { changes } = db.prepare('DELETE FROM ap_object_session WHERE id = @id').run({ id })
  return changes > 0
}
