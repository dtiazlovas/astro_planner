import sql from 'mssql'
import { connectToDatabase } from '../db.js'
import type { ApSetting } from '../models/ApSetting.js'

async function ensureTable(): Promise<void> {
  const pool = await connectToDatabase()
  await pool.request().query(`
    IF OBJECT_ID('ap_settings', 'U') IS NULL
      CREATE TABLE ap_settings (
        [name] nvarchar(200) NOT NULL,
        [value] nvarchar(max) NULL,
        CONSTRAINT PK_ap_settings PRIMARY KEY ([name])
      )
  `)
}

let tableReady = false
async function ready(): Promise<void> {
  if (!tableReady) { await ensureTable(); tableReady = true }
}

export const getSetting = async (name: string): Promise<ApSetting | null> => {
  await ready()
  const pool = await connectToDatabase()
  const result = await pool.request()
    .input('name', sql.NVarChar(200), name)
    .query<ApSetting>('SELECT [name], [value] FROM ap_settings WHERE [name] = @name')
  return result.recordset[0] ?? null
}

export const setSetting = async (name: string, value: string): Promise<ApSetting> => {
  await ready()
  const pool = await connectToDatabase()
  await pool.request()
    .input('name', sql.NVarChar(200), name)
    .input('value', sql.NVarChar(sql.MAX), value)
    .query(`
      MERGE ap_settings AS t
      USING (VALUES (@name, @value)) AS s ([name], [value]) ON t.[name] = s.[name]
      WHEN MATCHED THEN UPDATE SET [value] = s.[value]
      WHEN NOT MATCHED THEN INSERT ([name], [value]) VALUES (s.[name], s.[value]);
    `)
  return { name, value }
}
