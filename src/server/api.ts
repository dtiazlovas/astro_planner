import express from 'express'
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
import apEquipmentRouter from './routes/apEquipment.js'
import apFitsRouter from './routes/apFits.js'

// The API half of the app, with no listener and no client mounting. Kept
// separate from index.ts so a serverless host (Vercel) can import the routes
// without dragging in the port binding or the Vite dev import — there the
// platform owns the listener and a CDN serves the client.
export const createApiApp = (): express.Express => {
  const app = express()

  // No CORS: in every deployment the client is served from the same origin as
  // this router — our own process locally and on Render, Vercel's CDN in front
  // of the same domain there.
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
  app.use('/api/equipment', apEquipmentRouter)
  app.use('/api/fits', apFitsRouter)

  // An unknown /api path is a 404 in its own right — it must never fall through
  // to the SPA, or a mistyped endpoint would answer 200 with index.html.
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }) })

  return app
}
