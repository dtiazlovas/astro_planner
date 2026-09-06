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

// Routes only — no listener, no client — so Vercel can import them without the
// port binding or the Vite dev import.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// One shared credential, not accounts. Basic auth so the browser owns the prompt
// and the SPA stores nothing; unset means the check is off.
const API_SECRET = process.env.API_SECRET?.trim()
const API_USER = process.env.API_USER?.trim() || 'astro'
const expectedHeader = API_SECRET
  ? `Basic ${Buffer.from(`${API_USER}:${API_SECRET}`).toString('base64')}`
  : null

const requireAuth: express.RequestHandler = (req, res, next) => {
  if (!expectedHeader) return next()

  const given = Buffer.from(req.get('authorization') ?? '')
  const want = Buffer.from(expectedHeader)
  // timingSafeEqual throws on a length mismatch, so length is checked first.
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next()

  res.set('WWW-Authenticate', 'Basic realm="astro-planner", charset="UTF-8"')
  res.status(401).json({ error: 'Unauthorized' })
}

// A write from a superseded local copy would upload a database missing another
// instance's work. A failed check serves the local copy: stale beats an outage.
const revalidateBeforeHandling: express.RequestHandler = (req, res, next) => {
  if (!isBlobEnabled()) return next()
  refreshDatabaseFromBlob(!READ_METHODS.has(req.method)).then(
    () => next(),
    error => { console.error('Blob DB: refresh failed, serving the local copy', error); next() }
  )
}

// Holds res.end() until the write is uploaded, so a 2xx means it is stored.
// Uploading after the response loses it: the instance can be suspended the
// moment the response flushes, and an upload in flight never finishes.
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
      // Still responds on failure: the change is in the local database and the
      // re-armed dirty flag makes the next write retry.
      .catch(error => { console.error('Blob DB: snapshot failed', error) })
      .then(() => { sendResponse(...args) })
    return res
  }) as typeof res.end

  next()
}

// The disk-backed counterpart. Nothing waits for it — the snapshot lands on the
// disk the write already reached. See localBackup.ts.
const backupAfterWriting: express.RequestHandler = (req, res, next) => {
  if (READ_METHODS.has(req.method)) return next()
  res.on('finish', () => { if (res.statusCode < 400) scheduleLocalBackup() })
  next()
}

export const createApiApp = (): express.Express => {
  const app = express()

  // Auth first, so an unauthenticated request can't make the process parse a
  // body or download the database. Pathless, so the client document is behind it
  // too and the browser prompts on the first page load. (No CORS: same origin.)
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

  // Never falls through to the SPA: a mistyped endpoint would answer 200 with
  // index.html.
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }) })

  return app
}
