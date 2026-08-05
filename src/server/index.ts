import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { closeDatabaseConnection, connectToDatabase } from './db.js'

const app = express()
const PORT = process.env.PORT ?? 5000
// Host matters on PaaS (Render, Fly, …): a service reachable only on loopback
// fails their port scan. Node already listens on all interfaces when no host is
// given, but saying so is cheaper than debugging it.
const HOST = process.env.HOST ?? '0.0.0.0'
// Dev is the mode you opt into; anything else is production. The other way
// round bites on hosts that set NODE_ENV=production during the build, because
// npm then skips devDependencies and vite/esbuild are missing at build time.
const isProduction = process.env.NODE_ENV !== 'development'

// Production: dist/server.js, with the built client beside it in dist/public.
// Dev: src/server/index.ts, and Vite is rooted at the repo (where index.html is).
const here = path.dirname(fileURLToPath(import.meta.url))
const clientDir = path.join(here, 'public')
const repoRoot = path.join(here, '..', '..')

// No CORS: the client is served by this same process, so every request is
// same-origin.
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

// The client comes off this same process: built assets in production, Vite as
// middleware in dev so there is still one port and one command, HMR intact.
// Vite is imported dynamically (and left external when bundling) so production
// never loads the dev toolchain.
const mountClient = async (): Promise<void> => {
  if (isProduction) {
    // Asset filenames are content-hashed and can be cached hard; index.html
    // must not be, or browsers stay on the previous build after a deploy.
    app.use(express.static(clientDir, { index: false, maxAge: '1y' }))
    app.get(/.*/, (_req, res) => { res.sendFile(path.join(clientDir, 'index.html')) })
    return
  }

  const { createServer } = await import('vite')
  const vite = await createServer({
    root: repoRoot,
    server: { middlewareMode: true },
    appType: 'spa',
  })
  app.use(vite.middlewares)
}

const startServer = async (): Promise<void> => {
  try {
    connectToDatabase()
    console.log('Connected to SQLite')

    await mountClient()

    app.listen(Number(PORT), HOST, () => {
      console.log(`Astro Planner on http://localhost:${PORT}${isProduction ? '' : '  (dev — HMR on)'}`)
    })
  } catch (error) {
    console.error('Failed to start', error)
    process.exit(1)
  }
}

const shutdown = (): void => {
  closeDatabaseConnection()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

startServer()
