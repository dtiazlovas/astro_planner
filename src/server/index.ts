import 'dotenv/config'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createApiApp } from './api.js'
import { closeDatabaseConnection, flushDatabaseToBlob, initDatabase } from './db.js'

const app = createApiApp()
const PORT = process.env.PORT ?? 5000
// All interfaces, so the app is reachable from a phone on the network or from
// outside a container. HOST is where a loopback-only bind would go.
const HOST = process.env.HOST ?? '0.0.0.0'
// Dev is opted into (`npm run dev` sets it); anything else is production. The
// other way round bites on a host that sets NODE_ENV=production for the build,
// since npm then skips devDependencies and vite/esbuild go missing.
const isProduction = process.env.NODE_ENV !== 'development'

// Production: dist/server.js, with the built client beside it in dist/public.
// Dev: src/server/index.ts, and Vite is rooted at the repo (where index.html is).
const here = path.dirname(fileURLToPath(import.meta.url))
const clientDir = path.join(here, 'public')
const repoRoot = path.join(here, '..', '..')

// The client comes off this same process: built assets in production, Vite as
// middleware in dev, so there is one port and one command either way. Vite is
// imported dynamically (and left external when bundling) so production never
// loads the dev toolchain.
const mountClient = async (server: http.Server): Promise<void> => {
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
    // Handing Vite our own HTTP server makes HMR share the app's port; without
    // it, middleware mode opens a WebSocket server on 24678 that collides with
    // any other Vite project, or a stale copy of this one.
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  })
  app.use(vite.middlewares)
}

const startServer = async (): Promise<void> => {
  try {
    await initDatabase()
    console.log('Connected to SQLite')

    // Created up front rather than via app.listen(), so Vite has something to
    // attach its HMR socket to before connections are accepted.
    const server = http.createServer(app)
    await mountClient(server)

    server.listen(Number(PORT), HOST, () => {
      console.log(`Astro Planner on http://localhost:${PORT}${isProduction ? '' : '  (dev — HMR on)'}`)
    })
  } catch (error) {
    console.error('Failed to start', error)
    process.exit(1)
  }
}

// A blob snapshot may still be queued or in flight when the process is asked to
// stop, and exiting through it would drop the last write. Bounded by a deadline,
// because a stalled upload must not be able to keep the process alive.
let shuttingDown = false

const shutdown = (): void => {
  if (shuttingDown) return
  shuttingDown = true
  const finish = (): void => {
    closeDatabaseConnection()
    process.exit(0)
  }
  setTimeout(() => {
    console.error('Blob DB: final snapshot did not finish in time — exiting anyway')
    finish()
  }, 5000)
  flushDatabaseToBlob()
    .catch(error => { console.error('Blob DB: final snapshot failed', error) })
    .then(finish, finish)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

startServer()
