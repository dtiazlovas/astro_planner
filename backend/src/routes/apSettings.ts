import { Router, Request, Response } from 'express'
import { getSetting, setSetting } from '../services/apSettingService.js'

const router = Router()

router.get('/:key', async (req: Request, res: Response) => {
  try {
    const item = await getSetting(req.params.key)
    if (!item) { res.status(404).json({ error: 'Not found' }); return }
    res.json(item)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/:key', async (req: Request, res: Response) => {
  const { value } = req.body as { value?: string }
  if (value === undefined) { res.status(400).json({ error: 'value is required' }); return }
  try {
    res.json(await setSetting(req.params.key, value))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
