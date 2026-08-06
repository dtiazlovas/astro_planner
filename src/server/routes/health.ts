import { Router, Request, Response } from 'express'
import { databaseStatus } from '../db.js'

const router = Router()

// Deliberately includes where the database is coming from. On Vercel this is
// the quickest way to tell a working blob-backed deployment from one that is
// silently running on a /tmp file it is about to lose — the two behave
// identically until the instance goes away.
router.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), database: databaseStatus() })
})

export default router
