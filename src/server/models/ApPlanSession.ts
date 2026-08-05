export interface ApPlanSession {
  id: number
  session: number
  planid: number
}

export type CreateApPlanSessionDto = Pick<ApPlanSession, 'session' | 'planid'>
