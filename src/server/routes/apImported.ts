import { Router, Request, Response } from 'express'
import { checkImported, recordImported, relinkImported, cullImported, getAllImported, removeImported, saveImportedAnalysis } from '../services/apImportedService.js'

const router = Router()

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getAllImported())
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/analysis', async (req: Request, res: Response) => {
  const { items } = req.body as { items?: { filename?: string; psfsw?: number | null; fwhm?: number | null }[] }
  if (!Array.isArray(items) || items.some(i => typeof i?.filename !== 'string')) {
    res.status(400).json({ error: 'items must be an array of { filename, psfsw, fwhm }' }); return
  }
  try {
    const updated = await saveImportedAnalysis(items.map(i => ({ filename: i.filename!, psfsw: i.psfsw ?? null, fwhm: i.fwhm ?? null })))
    res.json({ updated })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/cull', async (req: Request, res: Response) => {
  const { names } = req.body as { names?: string[] }
  if (!Array.isArray(names)) { res.status(400).json({ error: 'names must be an array' }); return }
  try {
    res.json({ culled: await cullImported(names) })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/remove', async (req: Request, res: Response) => {
  const { names } = req.body as { names?: string[] }
  if (!Array.isArray(names)) { res.status(400).json({ error: 'names must be an array' }); return }
  try {
    res.json({ removed: await removeImported(names) })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

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
  const { names, sessionId, objectSessionId } = req.body as { names?: string[]; sessionId?: number; objectSessionId?: number | null }
  if (!Array.isArray(names)) { res.status(400).json({ error: 'names must be an array' }); return }
  if (typeof sessionId !== 'number') { res.status(400).json({ error: 'sessionId must be a number' }); return }
  if (objectSessionId != null && typeof objectSessionId !== 'number') { res.status(400).json({ error: 'objectSessionId must be a number' }); return }
  try {
    await recordImported(names, sessionId, objectSessionId ?? null)
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/relink', async (req: Request, res: Response) => {
  const { names, objectSessionId } = req.body as { names?: string[]; objectSessionId?: number }
  if (!Array.isArray(names)) { res.status(400).json({ error: 'names must be an array' }); return }
  if (typeof objectSessionId !== 'number') { res.status(400).json({ error: 'objectSessionId must be a number' }); return }
  try {
    res.json({ relinked: await relinkImported(names, objectSessionId) })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
