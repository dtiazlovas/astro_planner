import express from 'express'
import { isBlobEnabled } from './blobDb.js'
import { flushDatabaseToBlob, markDatabaseDirty, refreshDatabaseFromBlob } from './db.js'
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
// When the database lives in Vercel Blob, a write that only reached the local
// file is a write that disappears with the instance. Snapshot after any request
// that could have changed something — read methods are skipped, and so are
// failures, which either rolled back or never got as far as the database.
//
// The snapshot is taken *before* the response goes out, by holding res.end()
// until the upload lands. Doing it afterwards is the obvious design and it is
// wrong here: a serverless instance can be suspended the instant the response
// is flushed, and any upload still in flight simply never finishes. Nothing
// visible fails — the client has its 200 — and the write is gone by the next
// cold start. Paying the upload latency inside the request is what makes a 2xx
// mean the change is actually stored.
//
// Costs a round trip to the store on every write. At this size, with one user,
// that is the right trade for the guarantee.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// The other half of sharing a store between instances. Snapshotting on the way
// out is pointless if this instance is working from a copy another one has
// already superseded — the write would branch off the stale version and upload
// a database missing the other instance's work.
//
// A failed check serves from the local copy rather than failing the request:
// stale data beats an outage, and the next request tries again.
const revalidateBeforeHandling: express.RequestHandler = (req, res, next) => {
  if (!isBlobEnabled()) return next()
  refreshDatabaseFromBlob(!READ_METHODS.has(req.method)).then(
    () => next(),
    error => { console.error('Blob DB: refresh failed, serving the local copy', error); next() }
  )
}

const snapshotBeforeResponding: express.RequestHandler = (req, res, next) => {
  if (!isBlobEnabled() || READ_METHODS.has(req.method)) return next()

  const sendResponse = res.end.bind(res) as (...args: unknown[]) => express.Response
  let holdingResponse = false

  res.end = ((...args: unknown[]) => {
    // A second end() while the first is waiting would send the response early;
    // Node would reject the write anyway, so drop it.
    if (holdingResponse) return res
    if (res.statusCode >= 400) return sendResponse(...args)

    holdingResponse = true
    markDatabaseDirty()
    flushDatabaseToBlob()
      // The response still goes out on failure: the change is in the local
      // database and the dirty flag is re-armed, so the next write retries.
      // /api/health reports it as blob.lastError.
      .catch(error => { console.error('Blob DB: snapshot failed', error) })
      .then(() => { sendResponse(...args) })
    return res
  }) as typeof res.end

  next()
}

export const createApiApp = (): express.Express => {
  const app = express()

  // No CORS: in every deployment the client is served from the same origin as
  // this router — our own process locally and on Render, Vercel's CDN in front
  // of the same domain there.
  app.use(express.json())
  app.use(revalidateBeforeHandling)
  app.use(snapshotBeforeResponding)

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
