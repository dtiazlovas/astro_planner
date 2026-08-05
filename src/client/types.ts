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
  total_seconds: number
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
}

export interface PlanProgressItem {
  filter_id: number
  filter_name: string | null
  target_minutes: number
  captured_seconds: number
  total_frames: number
}

// `priority` is server-assigned on create (new objects go to the end of the ordering)
export type CreateApObjectDto = Omit<ApObject, 'id' | 'total_seconds' | 'priority'>

export interface ApSession {
  id: number
  name: string
  start: string
  duration: string | null
  duration_set: boolean
  comment: string | null
  equipment: number | null
  calculated_seconds: number
}

export type CreateApSessionDto = Omit<ApSession, 'id' | 'calculated_seconds'>

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
  object_name: string
  exposure_duration: number
  filter_name: string | null
  plan_session_id: number | null
  plan_id: number | null
  plan_name: string | null
}

export type CreateApObjectSessionDto = Omit<ApObjectSession, 'id' | 'object_name' | 'exposure_duration' | 'filter_name' | 'plan_session_id' | 'plan_id' | 'plan_name'>

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
