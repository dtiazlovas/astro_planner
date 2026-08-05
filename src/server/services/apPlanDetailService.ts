import { connectToDatabase } from '../db.js'
import type { ApPlanDetail, CreateApPlanDetailDto, UpdateApPlanDetailDto } from '../models/ApPlanDetail.js'

const SELECT = 'SELECT id, planid, filter, duration FROM ap_plan_details'

export const getDetailsByPlan = async (planId: number): Promise<ApPlanDetail[]> => {
  return connectToDatabase().prepare(`${SELECT} WHERE planid = @planid ORDER BY id`).all({ planid: planId }) as ApPlanDetail[]
}

export const getDetailById = async (id: number): Promise<ApPlanDetail | null> => {
  return (connectToDatabase().prepare(`${SELECT} WHERE id = @id`).get({ id }) as ApPlanDetail) ?? null
}

export const createDetail = async (data: CreateApPlanDetailDto): Promise<ApPlanDetail> => {
  const { lastInsertRowid } = connectToDatabase().prepare(`
    INSERT INTO ap_plan_details (planid, filter, duration) VALUES (@planid, @filter, @duration)
  `).run({ planid: data.planid, filter: data.filter, duration: data.duration })
  return (await getDetailById(Number(lastInsertRowid)))!
}

export const updateDetail = async (id: number, data: UpdateApPlanDetailDto): Promise<ApPlanDetail | null> => {
  const setClauses: string[] = []
  const params: Record<string, unknown> = { id }

  if (data.filter   !== undefined) { setClauses.push('filter = @filter');     params.filter = data.filter }
  if (data.duration !== undefined) { setClauses.push('duration = @duration'); params.duration = data.duration }

  if (setClauses.length === 0) return getDetailById(id)
  connectToDatabase().prepare(`UPDATE ap_plan_details SET ${setClauses.join(', ')} WHERE id = @id`).run(params)
  return getDetailById(id)
}

export const deleteDetail = async (id: number): Promise<boolean> => {
  const { changes } = connectToDatabase().prepare('DELETE FROM ap_plan_details WHERE id = @id').run({ id })
  return changes > 0
}
