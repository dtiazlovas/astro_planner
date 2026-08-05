import { Router, Request, Response } from 'express'
import { getAllApExposures } from '../services/apExposureService.js'

const router = Router()

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getAllApExposures())
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
