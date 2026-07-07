import { connectToDatabase } from '../db.js'
import type { ApEquipment } from '../models/ApEquipment.js'

const COLS = 'id, name, focal_length, focal_ratio, reducer, sensor, binning'

export interface EquipmentInput {
  name: string
  focal_length: number
  focal_ratio: number
  reducer: number
  sensor: string
  binning: number
}

export const getAllApEquipment = async (): Promise<ApEquipment[]> => {
  return connectToDatabase().prepare(`SELECT ${COLS} FROM ap_equipment ORDER BY id`).all() as ApEquipment[]
}

export const createApEquipment = async (data: EquipmentInput): Promise<ApEquipment> => {
  const db = connectToDatabase()
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO ap_equipment (name, focal_length, focal_ratio, reducer, sensor, binning) VALUES (@name, @focal_length, @focal_ratio, @reducer, @sensor, @binning)'
  ).run(data)
  return db.prepare(`SELECT ${COLS} FROM ap_equipment WHERE id = @id`).get({ id: Number(lastInsertRowid) }) as ApEquipment
}

export const updateApEquipment = async (id: number, data: EquipmentInput): Promise<ApEquipment | null> => {
  const db = connectToDatabase()
  const { changes } = db.prepare(
    'UPDATE ap_equipment SET name = @name, focal_length = @focal_length, focal_ratio = @focal_ratio, reducer = @reducer, sensor = @sensor, binning = @binning WHERE id = @id'
  ).run({ ...data, id })
  if (!changes) return null
  return db.prepare(`SELECT ${COLS} FROM ap_equipment WHERE id = @id`).get({ id }) as ApEquipment
}

export const deleteApEquipment = async (id: number): Promise<boolean> => {
  const db = connectToDatabase()
  // Detach the rig from any sessions/plans that reference it before removing it
  db.prepare('UPDATE ap_session SET equipment = NULL WHERE equipment = @id').run({ id })
  db.prepare('UPDATE ap_plan SET equipment = NULL WHERE equipment = @id').run({ id })
  const { changes } = db.prepare('DELETE FROM ap_equipment WHERE id = @id').run({ id })
  return changes > 0
}
