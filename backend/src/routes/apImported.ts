import { Router, Request, Response } from 'express'
import { checkImported, recordImported, copyFilesToObjectFolders, type CopyItem, type CopyStats } from '../services/apImportedService.js'

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
  const { names, sessionId } = req.body as { names?: string[]; sessionId?: number }
  if (!Array.isArray(names)) { res.status(400).json({ error: 'names must be an array' }); return }
  if (typeof sessionId !== 'number') { res.status(400).json({ error: 'sessionId must be a number' }); return }
  try {
    await recordImported(names, sessionId)
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/copy-to-object-folders', async (req: Request, res: Response) => {
  const { items } = req.body as { items?: CopyItem[] }
  if (!Array.isArray(items)) { res.status(400).json({ error: 'items must be an array' }); return }
  try {
    const stats: CopyStats = await copyFilesToObjectFolders(items)
    res.json({ ok: true, ...stats })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
