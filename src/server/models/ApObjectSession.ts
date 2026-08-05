export interface ApObjectSession {
  id: number
  object: number
  session: number
  frames: number
  exposure: number
  filter: number
}

export interface ApObjectSessionRow extends ApObjectSession {
  object_name: string
  exposure_duration: number
  filter_name: string | null
  plan_session_id: number | null
  plan_id: number | null
  plan_name: string | null
}

export type CreateApObjectSessionDto = Omit<ApObjectSession, 'id'>
