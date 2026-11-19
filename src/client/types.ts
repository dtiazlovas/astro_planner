export interface ApObjectType {
  id: number
  name: string
}

export interface ApObject {
  id: number
  name: string
  type: number
  position_json: string
  comment: string | null
  active: boolean
  aliases: string | null
  priority: number
  folder: string | null
  /** Mosaic grid; 1×1 for a plain object. */
  mosaic_rows: number
  mosaic_cols: number
  /** Panel suffixes, row-major, rows × cols long; null for a plain object. */
  mosaic_panels: string[] | null
  total_seconds: number
  /** Captured time on entries not linked to any plan. */
  unassigned_seconds: number
}

export interface PanelStat {
  panel: string | null
  total_seconds: number
}

export interface PanelProgress {
  panel: string | null
  captured_seconds: number
  total_frames: number
}

export interface FilterExposureStat {
  duration: number
  frames: number
}

export interface ObjectFilterStat {
  filter_name: string | null
  total_seconds: number
  // Per-exposure frame counts; populated by the per-object stats only.
  exposures?: FilterExposureStat[]
  // Per-panel split for mosaics; per-object stats only.
  panels?: PanelStat[]
}

export interface PlanProgressItem {
  filter_id: number
  filter_name: string | null
  /** Per panel for a mosaic. */
  target_minutes: number
  captured_seconds: number
  total_frames: number
  panels?: PanelProgress[]
}

// `priority` is server-assigned on create (new objects go to the end of the ordering);
// the mosaic layout defaults to 1×1 when left out.
export type CreateApObjectDto =
  Omit<ApObject, 'id' | 'total_seconds' | 'unassigned_seconds' | 'priority' | 'mosaic_rows' | 'mosaic_cols' | 'mosaic_panels'>
  & Partial<Pick<ApObject, 'mosaic_rows' | 'mosaic_cols' | 'mosaic_panels'>>

export interface ApSession {
  id: number
  name: string
  start: string
  duration: string | null
  duration_set: boolean
  comment: string | null
  equipment: number | null
  calculated_seconds: number
  // Cull stats for the night: subs kept, and subs culled (measured, rejected
  // and deleted — never part of `frames` or `calculated_seconds`).
  frames: number
  culled_frames: number
  culled_seconds: number
}

export type CreateApSessionDto = Omit<ApSession, 'id' | 'calculated_seconds' | 'frames' | 'culled_frames' | 'culled_seconds'>

export interface ApExposure {
  id: number
  duration: number
}

export interface ApFilter {
  id: number
  name: string | null
  aliases: string | null
  folder: string | null
}

export interface ApObjectSession {
  id: number
  object: number
  session: number
  frames: number
  exposure: number
  filter: number
  /** Mosaic panel suffix; null for a plain object or an unrecognised panel. */
  panel: string | null
  object_name: string
  exposure_duration: number
  filter_name: string | null
  plan_session_id: number | null
  plan_id: number | null
  plan_name: string | null
}

export type CreateApObjectSessionDto =
  Omit<ApObjectSession, 'id' | 'panel' | 'object_name' | 'exposure_duration' | 'filter_name' | 'plan_session_id' | 'plan_id' | 'plan_name'>
  & { panel?: string | null }

export interface ApPlan {
  id: number
  object: number
  name: string
  active: boolean
  equipment: number | null
}

export interface ApPlanDetail {
  id: number
  planid: number
  filter: number
  duration: number
}

export interface ApPlanSession {
  id: number
  session: number
  planid: number
}

export interface ApEquipment {
  id: number
  name: string
  focal_length: number
  focal_ratio: number
  reducer: number
  sensor: string
  binning: number
}

export type CreateApEquipmentDto = Omit<ApEquipment, 'id'>
