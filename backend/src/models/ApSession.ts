export interface ApSession {
  id: number
  name: string
  start: Date
  duration: Date | null
  duration_set: boolean
  comment: string | null
  calculated_seconds: number
}

export type CreateApSessionDto = Omit<ApSession, 'id' | 'calculated_seconds'>
export type UpdateApSessionDto = Partial<Omit<ApSession, 'id' | 'calculated_seconds'>>
