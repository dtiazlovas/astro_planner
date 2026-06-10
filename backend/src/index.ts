import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import healthRouter from './routes/health.js'
import apObjectTypesRouter from './routes/apObjectTypes.js'
import apObjectsRouter from './routes/apObjects.js'
import apSessionsRouter from './routes/apSessions.js'
import apObjectSessionsRouter from './routes/apObjectSessions.js'
import apExposuresRouter from './routes/apExposures.js'
import apFiltersRouter from './routes/apFilters.js'
import apSettingsRouter from './routes/apSettings.js'
import apImportedRouter from './routes/apImported.js'
import apPlansRouter from './routes/apPlans.js'
import apPlanDetailsRouter from './routes/apPlanDetails.js'
import apPlanSessionsRouter from './routes/apPlanSessions.js'
import { closeDatabaseConnection, connectToDatabase } from './db.js'

const app = express()
const PORT = process.env.PORT ?? 5000

app.use(cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:3000' }))
app.use(express.json())

app.use('/api/health', healthRouter)
app.use('/api/object-types', apObjectTypesRouter)
app.use('/api/objects', apObjectsRouter)
app.use('/api/sessions', apSessionsRouter)
app.use('/api/object-sessions', apObjectSessionsRouter)
app.use('/api/exposures', apExposuresRouter)
app.use('/api/filters', apFiltersRouter)
app.use('/api/settings', apSettingsRouter)
app.use('/api/imported', apImportedRouter)
app.use('/api/plans', apPlansRouter)
app.use('/api/plan-details', apPlanDetailsRouter)
app.use('/api/plan-sessions', apPlanSessionsRouter)

const startServer = async (): Promise<void> => {
  try {
    await connectToDatabase()
    console.log('Connected to MSSQL')

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`)
    })
  } catch (error) {
    console.error('Failed to connect to MSSQL', error)
    process.exit(1)
  }
}

const shutdown = async (): Promise<void> => {
  await closeDatabaseConnection()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

void startServer()
