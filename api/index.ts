// Vercel serverless entrypoint. Everything under /api is rewritten here by
// vercel.json; the built client is served straight off the CDN, so this module
// never touches static files or Vite.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApiApp } from '../src/server/api.js'
import { flushDatabaseToBlob, initDatabase } from '../src/server/db.js'

// Module scope, not per-request: a warm instance reuses the connection, the app
// and — when one is configured — the database pulled down from Vercel Blob.
// Started here rather than awaited, so the download overlaps with whatever else
// the platform is doing to bring the instance up; the handler below is what
// actually waits on it.
const ready = initDatabase()

const app = createApiApp()

// An Express app *is* an (req, res) handler, so the platform could invoke it
// directly — but two things have to bracket it here.
//
// Before: the database has to have finished downloading, or the first request
// on a cold instance would read an empty file.
//
// After: an instance can be frozen the moment the handler resolves, so a
// snapshot left running in the background would simply never finish and the
// write would be lost. Waiting for the response *and then* for the flush costs
// the caller nothing — the response has already been sent — while guaranteeing
// the upload happens while the instance is still allowed to run.
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
