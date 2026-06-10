import { connectToDatabase } from '../db.js'
import type { ApPlanSession, CreateApPlanSessionDto } from '../models/ApPlanSession.js'

const SELECT = 'SELECT id, session, planid FROM ap_plan_session'

export const getPlanSessionBySession = async (sessionId: number): Promise<ApPlanSession | null> => {
  return (connectToDatabase().prepare(`${SELECT} WHERE session = @session`).get({ session: sessionId }) as ApPlanSession) ?? null
}

export const setPlanSession = async (data: CreateApPlanSessionDto): Promise<ApPlanSession> => {
  const db = connectToDatabase()
  db.prepare('DELETE FROM ap_plan_session WHERE session = @session').run({ session: data.session })
  db.prepare('INSERT INTO ap_plan_session (session, planid) VALUES (@session, @planid)').run({ session: data.session, planid: data.planid })
  return (await getPlanSessionBySession(data.session))!
}

export const assignUnassignedToActivePlan = async (objectId: number): Promise<number> => {
  const { changes } = connectToDatabase().prepare(`
    WITH ActivePlan AS (
      SELECT id FROM ap_plan WHERE object = @objectId AND active = 1 ORDER BY id LIMIT 1
    )
    INSERT INTO ap_plan_session (session, planid)
    SELECT os.id, ap.id
    FROM ap_object_session os
    CROSS JOIN ActivePlan ap
    WHERE os.object = @objectId
    AND NOT EXISTS (
      SELECT 1 FROM ap_plan_session ps WHERE ps.session = os.id
    )
  `).run({ objectId })
  return changes
}

export const deletePlanSession = async (id: number): Promise<boolean> => {
  const { changes } = connectToDatabase().prepare('DELETE FROM ap_plan_session WHERE id = @id').run({ id })
  return changes > 0
}
