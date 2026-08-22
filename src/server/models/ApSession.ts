export interface ApSession {
  id: number
  name: string
  start: Date
  duration: Date | null
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

type Derived = 'id' | 'calculated_seconds' | 'frames' | 'culled_frames' | 'culled_seconds'

export type CreateApSessionDto = Omit<ApSession, Derived>
export type UpdateApSessionDto = Partial<Omit<ApSession, Derived>>
