import { connectToDatabase } from '../db.js'
import type { ApExposure } from '../models/ApExposure.js'

export const getAllApExposures = async (): Promise<ApExposure[]> => {
  const pool = await connectToDatabase()
  const result = await pool.request()
    .query<ApExposure>('SELECT id, duration FROM ap_exposure ORDER BY duration')
  return result.recordset
}
