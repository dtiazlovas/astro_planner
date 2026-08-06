// Vercel serverless entrypoint. Everything under /api is rewritten here by
// vercel.json; the built client is served straight off the CDN, so this module
// never touches static files or Vite.
//
// An Express app *is* an (req, res) handler, so the platform can invoke it
// directly — there is no listener here, and no port to bind.
import { createApiApp } from '../src/server/api.js'
import { connectToDatabase } from '../src/server/db.js'

// Module scope, not per-request: a warm instance reuses both the connection and
// the app across invocations, and better-sqlite3 is synchronous so there is
// nothing to await. Cold starts pay for the schema init and the seed copy once.
connectToDatabase()

export default createApiApp()
