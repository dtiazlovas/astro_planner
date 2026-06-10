export interface ApObject {
  id: number
  name: string
  type: number
  position_json: string
  comment: string | null
  active: boolean
  aliases: string | null
  total_seconds: number
}

export interface ObjectFilterStat {
  filter_name: string | null
  total_seconds: number
}

export interface PlanProgressItem {
  filter_id: number
  filter_name: string | null
  target_minutes: number
  captured_seconds: number
}

export type CreateApObjectDto = Omit<ApObject, 'id' | 'total_seconds'>
export type UpdateApObjectDto = Partial<Omit<ApObject, 'id' | 'total_seconds'>>
