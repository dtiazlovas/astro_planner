import { connectToDatabase } from '../db.js'
import type { ApObject, ObjectFilterStat, PlanProgressItem, CreateApObjectDto, UpdateApObjectDto } from '../models/ApObject.js'

const SELECT_WITH_CALC = `
  SELECT
    o.id, o.name, o.type, o.position_json, o.comment, o.active, o.aliases, o.priority, o.folder,
    CAST(COALESCE(SUM(os.frames * e.duration), 0) AS INTEGER) AS total_seconds
  FROM ap_object o
  LEFT JOIN ap_object_session os ON os.object = o.id
  LEFT JOIN ap_exposure e ON e.id = os.exposure
`
const GROUP_BY = `GROUP BY o.id, o.name, o.type, o.position_json, o.comment, o.active, o.aliases, o.priority, o.folder`

function mapObject(row: any): ApObject {
  return { ...row, active: !!row.active }
}

export const getAllApObjects = async (): Promise<ApObject[]> => {
  return (connectToDatabase().prepare(`${SELECT_WITH_CALC} ${GROUP_BY} ORDER BY o.priority ASC, o.id ASC`).all() as any[]).map(mapObject)
}

export const getApObjectById = async (id: number): Promise<ApObject | null> => {
  const row = connectToDatabase().prepare(`${SELECT_WITH_CALC} WHERE o.id = @id ${GROUP_BY}`).get({ id }) as any
  return row ? mapObject(row) : null
}

export const getObjectFilterStats = async (objectId: number): Promise<ObjectFilterStat[]> => {
  return connectToDatabase().prepare(`
    SELECT
      f.name AS filter_name,
      CAST(COALESCE(SUM(os.frames * e.duration), 0) AS INTEGER) AS total_seconds
    FROM ap_object_session os
    JOIN ap_exposure e ON e.id = os.exposure
    JOIN ap_filter f ON f.id = os.filter
    WHERE os.object = @objectId
    GROUP BY f.id, f.name
    ORDER BY total_seconds DESC
  `).all({ objectId }) as ObjectFilterStat[]
}

export const getObjectPlanProgress = async (objectId: number): Promise<PlanProgressItem[]> => {
  return connectToDatabase().prepare(`
    WITH ActivePlan AS (
      SELECT id FROM ap_plan WHERE object = @objectId AND active = 1 ORDER BY id LIMIT 1
    )
    SELECT
      pd.filter   AS filter_id,
      f.name      AS filter_name,
      pd.duration AS target_minutes,
      CAST(COALESCE(SUM(os.frames * e.duration), 0) AS INTEGER) AS captured_seconds,
      COALESCE(SUM(os.frames), 0) AS total_frames
    FROM ActivePlan ap
    JOIN ap_plan_details pd ON pd.planid = ap.id
    JOIN ap_filter f        ON f.id = pd.filter
    LEFT JOIN ap_plan_session  ps ON ps.planid = ap.id
    LEFT JOIN ap_object_session os ON os.id = ps.session AND os.filter = pd.filter
    LEFT JOIN ap_exposure e        ON e.id = os.exposure
    GROUP BY pd.filter, f.name, pd.duration
    ORDER BY pd.filter
  `).all({ objectId }) as PlanProgressItem[]
}

export const createApObject = async (data: CreateApObjectDto): Promise<ApObject> => {
  const db = connectToDatabase()
  const { max } = db.prepare('SELECT COALESCE(MAX(priority), -1) as max FROM ap_object').get() as { max: number }
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO ap_object (name, type, position_json, comment, active, aliases, priority, folder)
    VALUES (@name, @type, @position_json, @comment, @active, @aliases, @priority, @folder)
  `).run({
    name: data.name, type: data.type, position_json: data.position_json,
    comment: data.comment ?? null, active: data.active ? 1 : 0, aliases: data.aliases ?? null,
    priority: max + 1, folder: data.folder ?? null,
  })
  return (await getApObjectById(Number(lastInsertRowid)))!
}

export const updateApObject = async (id: number, data: UpdateApObjectDto): Promise<ApObject | null> => {
  const setClauses: string[] = []
  const params: Record<string, unknown> = { id }

  if (data.name !== undefined)          { setClauses.push('name = @name');                   params.name = data.name }
  if (data.type !== undefined)          { setClauses.push('type = @type');                   params.type = data.type }
  if (data.position_json !== undefined) { setClauses.push('position_json = @position_json'); params.position_json = data.position_json }
  if ('comment' in data)                { setClauses.push('comment = @comment');             params.comment = data.comment ?? null }
  if (data.active !== undefined)        { setClauses.push('active = @active');               params.active = data.active ? 1 : 0 }
  if ('aliases' in data)                { setClauses.push('aliases = @aliases');             params.aliases = data.aliases ?? null }
  if ('folder' in data)                 { setClauses.push('folder = @folder');               params.folder = data.folder ?? null }

  if (setClauses.length === 0) return getApObjectById(id)
  connectToDatabase().prepare(`UPDATE ap_object SET ${setClauses.join(', ')} WHERE id = @id`).run(params)
  return getApObjectById(id)
}

export const deleteApObject = async (id: number): Promise<boolean> => {
  const db = connectToDatabase()
  db.prepare('DELETE FROM ap_object_session WHERE object = @id').run({ id })
  const { changes } = db.prepare('DELETE FROM ap_object WHERE id = @id').run({ id })
  return changes > 0
}

export const reorderAllApObjects = async (ids: number[]): Promise<void> => {
  const db = connectToDatabase()
  const upd = db.prepare('UPDATE ap_object SET priority = @priority WHERE id = @id')
  db.transaction(() => { ids.forEach((id, i) => upd.run({ priority: i, id })) })()
}
