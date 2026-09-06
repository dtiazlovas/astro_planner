import crypto from 'node:crypto'
import express from 'express'
import { isBlobEnabled } from './blobDb.js'
import { flushDatabaseToBlob, markDatabaseDirty, refreshDatabaseFromBlob } from './db.js'
import { scheduleLocalBackup } from './localBackup.js'
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
import apPsfswAnchorsRouter from './routes/apPsfswAnchors.js'


// The API half of the app, with no listener and no client mounting. Kept
// separate from index.ts so a serverless host (Vercel) can import the routes
// without dragging in the port binding or the Vite dev import.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// One shared credential rather than accounts: one person, one database. HTTP
// Basic because the browser owns the prompt and then sends the header on every
// same-origin request by itself, so the SPA stores nothing. Unset means unset —
// a box on the home LAN with no API_SECRET runs unauthenticated.
const API_SECRET = process.env.API_SECRET?.trim()
const API_USER = process.env.API_USER?.trim() || 'astro'
const expectedHeader = API_SECRET
  ? `Basic ${Buffer.from(`${API_USER}:${API_SECRET}`).toString('base64')}`
  : null

const requireAuth: express.RequestHandler = (req, res, next) => {
  if (!expectedHeader) return next()

  const given = Buffer.from(req.get('authorization') ?? '')
  const want = Buffer.from(expectedHeader)
  // timingSafeEqual throws on a length mismatch, so length is checked first: it
  // leaks the credential's length and nothing about its contents.
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next()

  res.set('WWW-Authenticate', 'Basic realm="astro-planner", charset="UTF-8"')
  res.status(401).json({ error: 'Unauthorized' })
}

// The other half of sharing a store between instances: a write from a superseded
// local copy would branch off the stale version and upload a database missing the
// other instance's work. A failed check serves the local copy rather than failing
// the request — stale data beats an outage, and the next request tries again.
const revalidateBeforeHandling: express.RequestHandler = (req, res, next) => {
  if (!isBlobEnabled()) return next()
  refreshDatabaseFromBlob(!READ_METHODS.has(req.method)).then(
    () => next(),
    error => { console.error('Blob DB: refresh failed, serving the local copy', error); next() }
  )
}

// Holds res.end() until the write is uploaded, so a 2xx means the change is
// stored. Uploading after the response is the obvious design and is wrong here:
// a serverless instance can be suspended the instant the response flushes, and
// an upload still in flight never finishes — the client has its 200 and the
// write is gone by the next cold start. Costs a round trip per write.
const snapshotBeforeResponding: express.RequestHandler = (req, res, next) => {
  if (!isBlobEnabled() || READ_METHODS.has(req.method)) return next()

  const sendResponse = res.end.bind(res) as (...args: unknown[]) => express.Response
  let holdingResponse = false

  res.end = ((...args: unknown[]) => {
    // A second end() while the first is waiting would send the response early.
    if (holdingResponse) return res
    if (res.statusCode >= 400) return sendResponse(...args)

    holdingResponse = true
    markDatabaseDirty()
    flushDatabaseToBlob()
      // The response still goes out on failure: the change is in the local
      // database and the dirty flag is re-armed, so the next write retries.
      .catch(error => { console.error('Blob DB: snapshot failed', error) })
      .then(() => { sendResponse(...args) })
    return res
  }) as typeof res.end

  next()
}

// The local counterpart, for a deployment where the database is a file on a disk
// that stays put. Same trigger, opposite timing: the snapshot lands on the disk
// the write already reached, so nothing waits for it. See localBackup.ts.
const backupAfterWriting: express.RequestHandler = (req, res, next) => {
  if (READ_METHODS.has(req.method)) return next()
  res.on('finish', () => { if (res.statusCode < 400) scheduleLocalBackup() })
  next()
}

export const createApiApp = (): express.Express => {
  const app = express()

  // No CORS: the client is same-origin in every deployment.
  //
  // Auth goes first, ahead of the body parser and of anything that reaches for
  // the blob store — an unauthenticated request must not be able to make this
  // process download the database or parse a body. Pathless rather than under
  // /api, so when this process also serves the client the document itself is
  // behind the credential and the browser prompts on the first page load.
  app.use(requireAuth)
  app.use(express.json())
  app.use(revalidateBeforeHandling)
  app.use(snapshotBeforeResponding)
  app.use(backupAfterWriting)

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
  app.use('/api/psfsw-anchors', apPsfswAnchorsRouter)

  // An unknown /api path is a 404 in its own right — it must never fall through
  // to the SPA, or a mistyped endpoint would answer 200 with index.html.
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }) })

  return app
}
