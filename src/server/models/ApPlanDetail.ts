export interface ApPlanDetail {
  id: number
  planid: number
  filter: number
  duration: number
}

export type CreateApPlanDetailDto = Pick<ApPlanDetail, 'planid' | 'filter' | 'duration'>
export type UpdateApPlanDetailDto = Partial<Pick<ApPlanDetail, 'filter' | 'duration'>>
