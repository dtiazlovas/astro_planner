import { Router, Request, Response } from 'express'
import { analyzeFitsFiles } from '../services/apFitsService.js'

const router = Router()

router.post('/analyze', async (req: Request, res: Response) => {
  const { fileNames, normalize } = req.body as { fileNames?: string[]; normalize?: boolean }
  if (!Array.isArray(fileNames)) { res.status(400).json({ error: 'fileNames must be an array' }); return }
  try {
    res.json(await analyzeFitsFiles(fileNames, normalize !== false))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
