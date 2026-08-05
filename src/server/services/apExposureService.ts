import { connectToDatabase } from '../db.js'
import type { ApExposure } from '../models/ApExposure.js'

export const getAllApExposures = async (): Promise<ApExposure[]> => {
  return connectToDatabase().prepare('SELECT id, duration FROM ap_exposure ORDER BY duration').all() as ApExposure[]
}
