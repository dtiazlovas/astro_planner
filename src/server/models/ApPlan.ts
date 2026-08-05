export interface ApPlan {
  id: number
  object: number
  name: string
  active: boolean
  equipment: number | null
}

export type CreateApPlanDto = Omit<ApPlan, 'id'>
export type UpdateApPlanDto = Partial<Omit<ApPlan, 'id' | 'object'>>
