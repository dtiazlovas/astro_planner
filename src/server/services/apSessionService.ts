import { connectToDatabase } from '../db.js'
import type { ApSession, CreateApSessionDto, UpdateApSessionDto } from '../models/ApSession.js'

// Exposure thrown away with the culled subs, taken from the entry each record
// is linked to. A record with no entry — its whole entry was culled, or the
// entry has since been deleted — falls back to the exposure stored on the
// record itself, and failing that to the night's average seconds per frame,
// which is exact unless that night mixed exposure lengths. The average is the
// last resort for a reason: a night that kept nothing has no entries to average
// and would otherwise report its whole loss as zero.
const CULLED_SECONDS = `
  CAST(COALESCE(SUM(COALESCE(ce.duration, ie.duration, (
    SELECT CAST(SUM(os2.frames * e2.duration) AS REAL) / NULLIF(SUM(os2.frames), 0)
      FROM ap_object_session os2
      JOIN ap_exposure e2 ON e2.id = os2.exposure
     WHERE os2.session = i.session_id
  ))), 0) AS INTEGER)
`

// `frames`/`culled_frames`/`culled_seconds` are the night's cull stats: subs
// kept versus subs measured, rejected and deleted. Culled figures come from
// subqueries rather than joins — a second join against the per-entry rows would
// multiply the frame sums.
const SELECT_WITH_CALC = `
  SELECT
    s.id, s.name, s.start, s.duration, s.duration_set, s.comment, s.equipment,
    CAST(COALESCE(SUM(os.frames * e.duration), 0) AS INTEGER) AS calculated_seconds,
    CAST(COALESCE(SUM(os.frames), 0) AS INTEGER) AS frames,
    (SELECT COUNT(*) FROM ap_imported i WHERE i.session_id = s.id AND i.culled = 1) AS culled_frames,
    (SELECT ${CULLED_SECONDS}
       FROM ap_imported i
       LEFT JOIN ap_object_session cos ON cos.id = i.object_session_id
       LEFT JOIN ap_exposure ce ON ce.id = cos.exposure
       LEFT JOIN ap_exposure ie ON ie.id = i.exposure
      WHERE i.session_id = s.id AND i.culled = 1) AS culled_seconds
  FROM ap_session s
  LEFT JOIN ap_object_session os ON os.session = s.id
  LEFT JOIN ap_exposure e ON e.id = os.exposure
`
const GROUP_BY = `GROUP BY s.id, s.name, s.start, s.duration, s.duration_set, s.comment, s.equipment`

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

export const getAllApSessions = async (equipment?: number): Promise<ApSession[]> => {
  const where = equipment !== undefined ? 'WHERE s.equipment = @equipment' : ''
  const params = equipment !== undefined ? { equipment } : {}
  return (connectToDatabase().prepare(`${SELECT_WITH_CALC} ${where} ${GROUP_BY} ORDER BY s.start DESC`).all(params) as any[]).map(mapSession)
}

export const createApSession = async (data: CreateApSessionDto): Promise<ApSession> => {
  const { lastInsertRowid } = connectToDatabase().prepare(`
    INSERT INTO ap_session (name, start, duration, duration_set, comment, equipment)
    VALUES (@name, @start, @duration, @duration_set, @comment, @equipment)
  `).run({
    name: data.name,
    start: toIso(data.start),
    duration: toIso(data.duration ?? null),
    duration_set: data.duration_set ? 1 : 0,
    comment: data.comment ?? null,
    equipment: data.equipment ?? null,
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
  if ('equipment' in data)             { setClauses.push('equipment = @equipment');      params.equipment = data.equipment ?? null }

  if (setClauses.length === 0) return getApSessionById(id)
  connectToDatabase().prepare(`UPDATE ap_session SET ${setClauses.join(', ')} WHERE id = @id`).run(params)
  return getApSessionById(id)
}

export const deleteApSession = async (id: number): Promise<boolean> => {
  const db = connectToDatabase()
  return db.transaction((): boolean => {
    const entries = 'SELECT id FROM ap_object_session WHERE session = @id'
    db.prepare('DELETE FROM ap_imported WHERE session_id = @id').run({ id })
    // Also by entry: a record linked to one of these entries but carrying a
    // different session_id would otherwise hold the foreign key open.
    db.prepare(`DELETE FROM ap_imported WHERE object_session_id IN (${entries})`).run({ id })
    db.prepare(`DELETE FROM ap_plan_session WHERE session IN (${entries})`).run({ id })
    db.prepare('DELETE FROM ap_object_session WHERE session = @id').run({ id })
    const { changes } = db.prepare('DELETE FROM ap_session WHERE id = @id').run({ id })
    return changes > 0
  })()
}
