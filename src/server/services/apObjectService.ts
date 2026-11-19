import { connectToDatabase } from '../db.js'
import type { ApObject, ObjectFilterStat, PlanProgressItem, CreateApObjectDto, UpdateApObjectDto } from '../models/ApObject.js'

// When `@equipment` is non-null, only count captures from sessions taken with that rig.
const SELECT_WITH_CALC = `
  SELECT
    o.id, o.name, o.type, o.position_json, o.comment, o.active, o.aliases, o.priority, o.folder,
    o.mosaic_rows, o.mosaic_cols, o.mosaic_panels,
    CAST(COALESCE(SUM(os.frames * e.duration), 0) AS INTEGER) AS total_seconds,
    -- Counted in total_seconds but invisible to plan progress until linked.
    CAST(COALESCE(SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM ap_plan_session ps WHERE ps.session = os.id)
      THEN os.frames * e.duration ELSE 0 END), 0) AS INTEGER) AS unassigned_seconds
  FROM ap_object o
  LEFT JOIN ap_object_session os ON os.object = o.id
    AND (@equipment IS NULL OR os.session IN (SELECT id FROM ap_session WHERE equipment = @equipment))
  LEFT JOIN ap_exposure e ON e.id = os.exposure
`
const GROUP_BY = `GROUP BY o.id, o.name, o.type, o.position_json, o.comment, o.active, o.aliases, o.priority, o.folder, o.mosaic_rows, o.mosaic_cols, o.mosaic_panels`

// ── Mosaic layout ────────────────────────────────────────────────────────────
// A suffix becomes a folder name and is matched against the tail of a filename's
// target, so it must be non-empty, free of path characters, and distinct from its
// siblings once case and separators are ignored (the way names are matched).
export const MAX_MOSAIC_SIDE = 10
const BAD_SUFFIX_CHARS = /[\\/:*?"<>|]/
const normSuffix = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export class MosaicValidationError extends Error {}

export interface MosaicLayout { rows: number; cols: number; panels: string[] | null }

/** Validates a requested layout; 1×1 always comes back with `panels: null`. */
export function validateMosaic(rows: unknown, cols: unknown, panels: unknown): MosaicLayout {
  const r = Number(rows ?? 1), c = Number(cols ?? 1)
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 1 || c < 1 || r > MAX_MOSAIC_SIDE || c > MAX_MOSAIC_SIDE)
    throw new MosaicValidationError(`Mosaic size must be between 1×1 and ${MAX_MOSAIC_SIDE}×${MAX_MOSAIC_SIDE}`)
  if (r === 1 && c === 1) return { rows: 1, cols: 1, panels: null }
  if (!Array.isArray(panels) || panels.length !== r * c || panels.some(p => typeof p !== 'string'))
    throw new MosaicValidationError(`A ${r}×${c} mosaic needs ${r * c} panel suffixes`)
  const trimmed = (panels as string[]).map(p => p.trim())
  if (trimmed.some(p => !p)) throw new MosaicValidationError('Every mosaic panel needs a suffix')
  if (trimmed.some(p => BAD_SUFFIX_CHARS.test(p))) throw new MosaicValidationError('Panel suffixes become folder names — avoid \\ / : * ? " < > |')
  if (trimmed.some(p => !normSuffix(p))) throw new MosaicValidationError('Panel suffixes need at least one letter or digit')
  const seen = new Set<string>()
  for (const p of trimmed) {
    const n = normSuffix(p)
    if (seen.has(n)) throw new MosaicValidationError(`Panel suffix "${p}" is used twice (case and separators are ignored when matching)`)
    seen.add(n)
  }
  return { rows: r, cols: c, panels: trimmed }
}

const parsePanels = (json: unknown): string[] | null => {
  if (typeof json !== 'string' || !json) return null
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) && v.every(p => typeof p === 'string') ? v : null
  } catch { return null }
}

// Position is optional; the column is NOT NULL, so "no position" is stored as
// '{}' — the same value the import dialog writes for a blank field.
const EMPTY_POSITION = '{}'
function positionOrEmpty(value: string | null | undefined): string {
  const v = (value ?? '').trim()
  return v === '' ? EMPTY_POSITION : v
}

function mapObject(row: any): ApObject {
  const panels = parsePanels(row.mosaic_panels)
  const rows = Number(row.mosaic_rows) || 1, cols = Number(row.mosaic_cols) || 1
  // A grid whose stored suffixes don't fit it is shown as a plain object rather
  // than half a mosaic.
  const valid = panels !== null && panels.length === rows * cols && rows * cols > 1
  return {
    ...row,
    active: !!row.active,
    mosaic_rows: valid ? rows : 1,
    mosaic_cols: valid ? cols : 1,
    mosaic_panels: valid ? panels : null,
  }
}

export const getAllApObjects = async (equipment: number | null = null): Promise<ApObject[]> => {
  return (connectToDatabase().prepare(`${SELECT_WITH_CALC} ${GROUP_BY} ORDER BY o.priority ASC, o.id ASC`).all({ equipment }) as any[]).map(mapObject)
}

export const getApObjectById = async (id: number, equipment: number | null = null): Promise<ApObject | null> => {
  const row = connectToDatabase().prepare(`${SELECT_WITH_CALC} WHERE o.id = @id ${GROUP_BY}`).get({ id, equipment }) as any
  return row ? mapObject(row) : null
}

// Total integration time per filter across every object/session (optionally one rig).
export const getAllFilterStats = async (equipment: number | null = null): Promise<ObjectFilterStat[]> => {
  return connectToDatabase().prepare(`
    SELECT
      f.name AS filter_name,
      CAST(COALESCE(SUM(os.frames * e.duration), 0) AS INTEGER) AS total_seconds
    FROM ap_object_session os
    JOIN ap_exposure e ON e.id = os.exposure
    JOIN ap_filter f ON f.id = os.filter
    WHERE (@equipment IS NULL OR os.session IN (SELECT id FROM ap_session WHERE equipment = @equipment))
    GROUP BY f.id, f.name
    ORDER BY total_seconds DESC
  `).all({ equipment }) as ObjectFilterStat[]
}

export const getObjectFilterStats = async (objectId: number, equipment: number | null = null): Promise<ObjectFilterStat[]> => {
  const rows = connectToDatabase().prepare(`
    SELECT
      f.id AS filter_id,
      f.name AS filter_name,
      e.duration AS duration,
      os.panel AS panel,
      COALESCE(SUM(os.frames), 0) AS frames,
      CAST(COALESCE(SUM(os.frames * e.duration), 0) AS INTEGER) AS total_seconds
    FROM ap_object_session os
    JOIN ap_exposure e ON e.id = os.exposure
    JOIN ap_filter f ON f.id = os.filter
    WHERE os.object = @objectId
    AND (@equipment IS NULL OR os.session IN (SELECT id FROM ap_session WHERE equipment = @equipment))
    GROUP BY f.id, f.name, e.duration, os.panel
  `).all({ objectId, equipment }) as { filter_id: number; filter_name: string | null; duration: number; panel: string | null; frames: number; total_seconds: number }[]

  const byFilter = new Map<number, ObjectFilterStat>()
  for (const r of rows) {
    const stat = byFilter.get(r.filter_id) ?? { filter_name: r.filter_name, total_seconds: 0, exposures: [], panels: [] }
    stat.total_seconds += r.total_seconds
    const exp = stat.exposures!.find(x => x.duration === r.duration)
    if (exp) exp.frames += r.frames; else stat.exposures!.push({ duration: r.duration, frames: r.frames })
    const pan = stat.panels!.find(x => x.panel === r.panel)
    if (pan) pan.total_seconds += r.total_seconds; else stat.panels!.push({ panel: r.panel, total_seconds: r.total_seconds })
    byFilter.set(r.filter_id, stat)
  }
  const stats = [...byFilter.values()]
  for (const s of stats) s.exposures!.sort((a, b) => b.duration - a.duration)
  return stats.sort((a, b) => b.total_seconds - a.total_seconds)
}

// For a mosaic the plan's per-filter target applies to every panel, so captured
// time is reported per panel as well as in total; the client sets each panel
// against the target, so one panel running ahead can't hide one left behind.
export const getObjectPlanProgress = async (objectId: number, equipment: number | null = null): Promise<PlanProgressItem[]> => {
  const rows = connectToDatabase().prepare(`
    WITH ActivePlan AS (
      SELECT id FROM ap_plan
      WHERE object = @objectId AND active = 1 AND (@equipment IS NULL OR equipment = @equipment)
      ORDER BY id LIMIT 1
    )
    SELECT
      pd.filter   AS filter_id,
      f.name      AS filter_name,
      pd.duration AS target_minutes,
      os.panel    AS panel,
      CAST(COALESCE(SUM(os.frames * e.duration), 0) AS INTEGER) AS captured_seconds,
      COALESCE(SUM(os.frames), 0) AS total_frames
    FROM ActivePlan ap
    JOIN ap_plan_details pd ON pd.planid = ap.id
    JOIN ap_filter f        ON f.id = pd.filter
    LEFT JOIN ap_plan_session  ps ON ps.planid = ap.id
    LEFT JOIN ap_object_session os ON os.id = ps.session AND os.filter = pd.filter
    LEFT JOIN ap_exposure e        ON e.id = os.exposure
    GROUP BY pd.filter, f.name, pd.duration, os.panel
    ORDER BY pd.filter
  `).all({ objectId, equipment }) as { filter_id: number; filter_name: string | null; target_minutes: number; panel: string | null; captured_seconds: number; total_frames: number }[]

  const byFilter = new Map<number, PlanProgressItem>()
  for (const r of rows) {
    const item = byFilter.get(r.filter_id)
      ?? { filter_id: r.filter_id, filter_name: r.filter_name, target_minutes: r.target_minutes, captured_seconds: 0, total_frames: 0, panels: [] }
    item.captured_seconds += r.captured_seconds
    item.total_frames += r.total_frames
    // A filter with nothing captured comes back as one all-NULL row.
    if (r.total_frames > 0) item.panels!.push({ panel: r.panel, captured_seconds: r.captured_seconds, total_frames: r.total_frames })
    byFilter.set(r.filter_id, item)
  }
  return [...byFilter.values()]
}

export const createApObject = async (data: CreateApObjectDto): Promise<ApObject> => {
  const db = connectToDatabase()
  const { max } = db.prepare('SELECT COALESCE(MAX(priority), -1) as max FROM ap_object').get() as { max: number }
  const mosaic = validateMosaic(data.mosaic_rows, data.mosaic_cols, data.mosaic_panels)
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO ap_object (name, type, position_json, comment, active, aliases, priority, folder, mosaic_rows, mosaic_cols, mosaic_panels)
    VALUES (@name, @type, @position_json, @comment, @active, @aliases, @priority, @folder, @mosaic_rows, @mosaic_cols, @mosaic_panels)
  `).run({
    name: data.name, type: data.type, position_json: positionOrEmpty(data.position_json),
    comment: data.comment ?? null, active: data.active ? 1 : 0, aliases: data.aliases ?? null,
    priority: max + 1, folder: data.folder ?? null,
    mosaic_rows: mosaic.rows, mosaic_cols: mosaic.cols,
    mosaic_panels: mosaic.panels ? JSON.stringify(mosaic.panels) : null,
  })
  return (await getApObjectById(Number(lastInsertRowid)))!
}

/**
 * Renaming a cell's suffix in place (same grid size) carries that panel's entries
 * and frozen PSFSW scales over to the new name, so a typo fix doesn't orphan the
 * time already shot. Two-phase through temporary names, so swapping two suffixes
 * can't collide on the anchor key. A resized grid renames nothing: positions no
 * longer correspond, and the old suffixes stay on their entries.
 */
function carryPanelRenames(id: number, before: ApObject | null, after: MosaicLayout): void {
  if (!before?.mosaic_panels || !after.panels) return
  if (before.mosaic_rows !== after.rows || before.mosaic_cols !== after.cols) return
  const renames = before.mosaic_panels
    .map((from, i) => ({ from, to: after.panels![i], tmp: `\u0000mosaic-rename-${i}` }))
    .filter(r => r.from !== r.to)
  if (!renames.length) return
  const db = connectToDatabase()
  const entries = db.prepare('UPDATE ap_object_session SET panel = @to WHERE object = @id AND panel = @from')
  const anchors = db.prepare('UPDATE ap_psfsw_anchor SET panel = @to WHERE object = @id AND panel = @from')
  for (const r of renames) { entries.run({ id, from: r.from, to: r.tmp }); anchors.run({ id, from: r.from, to: r.tmp }) }
  for (const r of renames) { entries.run({ id, from: r.tmp, to: r.to }); anchors.run({ id, from: r.tmp, to: r.to }) }
}

export const updateApObject = async (id: number, data: UpdateApObjectDto): Promise<ApObject | null> => {
  const setClauses: string[] = []
  const params: Record<string, unknown> = { id }

  if (data.name !== undefined)          { setClauses.push('name = @name');                   params.name = data.name }
  if (data.type !== undefined)          { setClauses.push('type = @type');                   params.type = data.type }
  if ('position_json' in data)          { setClauses.push('position_json = @position_json'); params.position_json = positionOrEmpty(data.position_json) }
  if ('comment' in data)                { setClauses.push('comment = @comment');             params.comment = data.comment ?? null }
  if (data.active !== undefined)        { setClauses.push('active = @active');               params.active = data.active ? 1 : 0 }
  if ('aliases' in data)                { setClauses.push('aliases = @aliases');             params.aliases = data.aliases ?? null }
  if ('folder' in data)                 { setClauses.push('folder = @folder');               params.folder = data.folder ?? null }

  // The layout is one value: any part of it sent means all of it is replaced.
  let mosaic: MosaicLayout | null = null
  if ('mosaic_rows' in data || 'mosaic_cols' in data || 'mosaic_panels' in data) {
    mosaic = validateMosaic(data.mosaic_rows, data.mosaic_cols, data.mosaic_panels)
    setClauses.push('mosaic_rows = @mosaic_rows', 'mosaic_cols = @mosaic_cols', 'mosaic_panels = @mosaic_panels')
    params.mosaic_rows = mosaic.rows
    params.mosaic_cols = mosaic.cols
    params.mosaic_panels = mosaic.panels ? JSON.stringify(mosaic.panels) : null
  }

  if (setClauses.length === 0) return getApObjectById(id)
  const db = connectToDatabase()
  const before = mosaic ? await getApObjectById(id) : null
  db.transaction(() => {
    db.prepare(`UPDATE ap_object SET ${setClauses.join(', ')} WHERE id = @id`).run(params)
    if (mosaic) carryPanelRenames(id, before, mosaic)
  })()
  return getApObjectById(id)
}

// Innermost first: with foreign keys on, anything left pointing at a row makes
// its delete fail. Three things reference the object — its session entries
// (which carry import records and plan links), its plans (details, plan links)
// and its frozen PSFSW anchors.
export const deleteApObject = async (id: number): Promise<boolean> => {
  const db = connectToDatabase()
  return db.transaction((): boolean => {
    const entries = 'SELECT id FROM ap_object_session WHERE object = @id'
    const plans = 'SELECT id FROM ap_plan WHERE object = @id'
    db.prepare(`DELETE FROM ap_imported WHERE object_session_id IN (${entries})`).run({ id })
    db.prepare(`DELETE FROM ap_plan_session WHERE session IN (${entries}) OR planid IN (${plans})`).run({ id })
    db.prepare(`DELETE FROM ap_plan_details WHERE planid IN (${plans})`).run({ id })
    db.prepare('DELETE FROM ap_object_session WHERE object = @id').run({ id })
    db.prepare('DELETE FROM ap_plan WHERE object = @id').run({ id })
    db.prepare('DELETE FROM ap_psfsw_anchor WHERE object = @id').run({ id })
    const { changes } = db.prepare('DELETE FROM ap_object WHERE id = @id').run({ id })
    return changes > 0
  })()
}

export const reorderAllApObjects = async (ids: number[]): Promise<void> => {
  const db = connectToDatabase()
  const upd = db.prepare('UPDATE ap_object SET priority = @priority WHERE id = @id')
  db.transaction(() => { ids.forEach((id, i) => upd.run({ priority: i, id })) })()
}
