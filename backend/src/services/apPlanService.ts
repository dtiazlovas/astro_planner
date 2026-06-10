import { connectToDatabase } from '../db.js'
import type { ApPlan, CreateApPlanDto, UpdateApPlanDto } from '../models/ApPlan.js'

const SELECT = 'SELECT id, object, name, active FROM ap_plan'

function mapPlan(row: any): ApPlan {
  return { ...row, active: !!row.active }
}

export const getAllPlans = async (): Promise<ApPlan[]> => {
  return (connectToDatabase().prepare(`${SELECT} ORDER BY name`).all() as any[]).map(mapPlan)
}

export const getPlansByObject = async (objectId: number): Promise<ApPlan[]> => {
  return (connectToDatabase().prepare(`${SELECT} WHERE object = @object ORDER BY name`).all({ object: objectId }) as any[]).map(mapPlan)
}

export const getPlanById = async (id: number): Promise<ApPlan | null> => {
  const row = connectToDatabase().prepare(`${SELECT} WHERE id = @id`).get({ id }) as any
  return row ? mapPlan(row) : null
}

export const createPlan = async (data: CreateApPlanDto): Promise<ApPlan> => {
  const { lastInsertRowid } = connectToDatabase().prepare(`
    INSERT INTO ap_plan (object, name, active) VALUES (@object, @name, @active)
  `).run({ object: data.object, name: data.name, active: data.active ? 1 : 0 })
  return (await getPlanById(Number(lastInsertRowid)))!
}

export const updatePlan = async (id: number, data: UpdateApPlanDto): Promise<ApPlan | null> => {
  const setClauses: string[] = []
  const params: Record<string, unknown> = { id }

  if (data.name   !== undefined) { setClauses.push('name = @name');     params.name = data.name }
  if (data.active !== undefined) { setClauses.push('active = @active'); params.active = data.active ? 1 : 0 }

  if (setClauses.length === 0) return getPlanById(id)
  connectToDatabase().prepare(`UPDATE ap_plan SET ${setClauses.join(', ')} WHERE id = @id`).run(params)
  return getPlanById(id)
}

export const deletePlan = async (id: number): Promise<boolean> => {
  const db = connectToDatabase()
  db.prepare('DELETE FROM ap_plan_session WHERE planid = @id').run({ id })
  db.prepare('DELETE FROM ap_plan_details WHERE planid = @id').run({ id })
  const { changes } = db.prepare('DELETE FROM ap_plan WHERE id = @id').run({ id })
  return changes > 0
}
