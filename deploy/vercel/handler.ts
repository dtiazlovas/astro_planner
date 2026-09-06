// Vercel serverless entrypoint. Everything under /api is rewritten here by
// vercel.json; the built client is served straight off the CDN, so this module
// never touches static files or Vite.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApiApp } from '../../src/server/api.js'
import { flushDatabaseToBlob, initDatabase } from '../../src/server/db.js'

// Module scope, not per-request, so a warm instance reuses it. Started rather
// than awaited: the download overlaps with the rest of instance startup, and the
// handler is what waits on it.
const ready = initDatabase()

const app = createApiApp()

// The app could be invoked directly, but two things bracket it: the database has
// to have finished downloading, or a cold instance's first request reads an
// empty file; and the trailing flush is a safety net for anything marked dirty
// outside snapshotBeforeResponding, which is where the real snapshot happens.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await ready

  await new Promise<void>(resolve => {
    res.on('finish', resolve)
    res.on('close', resolve)
    app(req as never, res as never)
  })

  try {
    await flushDatabaseToBlob()
  } catch (error) {
    console.error('Blob DB: snapshot failed', error)
  }
}
