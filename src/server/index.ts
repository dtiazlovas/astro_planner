import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createApiApp } from './api.js'
import { closeDatabaseConnection, connectToDatabase } from './db.js'

const app = createApiApp()
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
