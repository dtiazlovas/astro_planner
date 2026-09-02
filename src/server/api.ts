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

// One shared credential rather than accounts: one person uses this app, and the
// thing being protected is a single database. HTTP Basic because the browser
// owns the prompt and then sends the header on every subsequent same-origin
// request by itself — no client code, and nothing for the SPA to store.
//
// Unset means unset. A box on the home LAN with no API_SECRET behaves exactly as
// it always has, so nothing has to change to keep running this at home; setting
// the variable is what turns the check on, which is what a public deployment
// wants.
const API_SECRET = process.env.API_SECRET?.trim()
const API_USER = process.env.API_USER?.trim() || 'astro'
const expectedHeader = API_SECRET
  ? `Basic ${Buffer.from(`${API_USER}:${API_SECRET}`).toString('base64')}`
  : null

const requireAuth: express.RequestHandler = (req, res, next) => {
  if (!expectedHeader) return next()

  const given = Buffer.from(req.get('authorization') ?? '')
  const want = Buffer.from(expectedHeader)
  // timingSafeEqual throws unless both sides are the same length, so length is
  // compared first and short-circuits. That leaks how long the credential is
  // and nothing about its contents; the comparison itself stays constant-time.
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next()

  res.set('WWW-Authenticate', 'Basic realm="astro-planner", charset="UTF-8"')
  res.status(401).json({ error: 'Unauthorized' })
}

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
      // The failure is only visible in the process log.
      .catch(error => { console.error('Blob DB: snapshot failed', error) })
      .then(() => { sendResponse(...args) })
    return res
  }) as typeof res.end

  next()
}

// The local counterpart of the middleware above, for a deployment where the
// database is a file on a disk that stays put. Same trigger — a request that
// could have changed something and did not fail — and the opposite timing:
// nothing is held up for it, because the snapshot lands on the disk the write
// has already reached, and it runs once the writes stop rather than per request.
// See localBackup.ts, including for why this and the scheduled job in
// scripts/backup-daily.js both exist.
const backupAfterWriting: express.RequestHandler = (req, res, next) => {
  if (READ_METHODS.has(req.method)) return next()
  // 'finish' rather than wrapping res.end(): there is nothing for the client to
  // wait for, so there is no reason to sit in the response path.
  res.on('finish', () => { if (res.statusCode < 400) scheduleLocalBackup() })
  next()
}

export const createApiApp = (): express.Express => {
  const app = express()

  // No CORS: in every deployment the client is served from the same origin as
  // this router — our own process when it serves dist/public, Vercel's CDN in
  // front of the same domain there.
  //
  // Auth goes first, ahead of the body parser and of anything that reaches for
  // the blob store. An unauthenticated request must not be able to make this
  // process download the database or parse a body it is not allowed to send —
  // on a serverless host both are real cost, not just wasted work.
  //
  // Mounted pathless rather than under /api, so when this process also serves
  // the client (index.ts) the document itself is behind the same credential.
  // That is what makes the browser ask on the first page load instead of on a
  // background fetch.
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
