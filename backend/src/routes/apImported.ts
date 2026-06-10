import { Router, Request, Response } from 'express'
import { checkImported, recordImported } from '../services/apImportedService.js'

const router = Router()

router.post('/check', async (req: Request, res: Response) => {
  const { names } = req.body as { names?: string[] }
  if (!Array.isArray(names)) { res.status(400).json({ error: 'names must be an array' }); return }
  try {
    res.json(await checkImported(names))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/record', async (req: Request, res: Response) => {
  const { names } = req.body as { names?: string[] }
  if (!Array.isArray(names)) { res.status(400).json({ error: 'names must be an array' }); return }
  try {
    await recordImported(names)
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
