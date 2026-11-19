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

export interface FilterExposureStat {
  duration: number
  frames: number
}

export interface PanelStat {
  panel: string | null
  total_seconds: number
}

export interface ObjectFilterStat {
  filter_name: string | null
  total_seconds: number
  // Per-exposure frame counts; populated by the per-object stats only.
  exposures?: FilterExposureStat[]
  // Per-panel split for mosaics; per-object stats only.
  panels?: PanelStat[]
}

export interface PanelProgress {
  panel: string | null
  captured_seconds: number
  total_frames: number
}

export interface PlanProgressItem {
  filter_id: number
  filter_name: string | null
  /** Per panel for a mosaic — the whole object's target is this × panel count. */
  target_minutes: number
  captured_seconds: number
  total_frames: number
  panels?: PanelProgress[]
}

type Computed = 'id' | 'total_seconds' | 'unassigned_seconds'
export type CreateApObjectDto = Omit<ApObject, Computed>
export type UpdateApObjectDto = Partial<Omit<ApObject, Computed>>
