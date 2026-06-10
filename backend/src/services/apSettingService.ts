import { connectToDatabase } from '../db.js'
import type { ApSetting } from '../models/ApSetting.js'

export const getSetting = async (name: string): Promise<ApSetting | null> => {
  return (connectToDatabase().prepare('SELECT name, value FROM ap_settings WHERE name = @name').get({ name }) as ApSetting) ?? null
}

export const setSetting = async (name: string, value: string): Promise<ApSetting> => {
  connectToDatabase().prepare('INSERT OR REPLACE INTO ap_settings (name, value) VALUES (@name, @value)').run({ name, value })
  return { name, value }
}
