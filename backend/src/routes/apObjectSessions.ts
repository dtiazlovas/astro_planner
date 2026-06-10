import { Router, Request, Response } from 'express'
import {
  getBySession,
  createApObjectSession,
  updateApObjectSession,
  deleteApObjectSession
} from '../services/apObjectSessionService.js'

const router = Router()

router.get('/', async (req: Request, res: Response) => {
  const sessionId = Number(req.query.session)
  if (Number.isNaN(sessionId)) { res.status(400).json({ error: 'session query param required' }); return }
  try {
    res.json(await getBySession(sessionId))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/', async (req: Request, res: Response) => {
  const { object, session, frames, exposure, filter } = req.body as Record<string, unknown>
  if (!object || !session || !frames || !exposure || !filter) {
    res.status(400).json({ error: 'object, session, frames, exposure and filter are required' })
    return
  }
  try {
    res.status(201).json(await createApObjectSession({
      object:   Number(object),
      session:  Number(session),
      frames:   Number(frames),
      exposure: Number(exposure),
      filter:   Number(filter),
    }))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  const { object, frames, exposure, filter } = req.body as Record<string, unknown>
  const data = {
    ...(object   !== undefined && { object:   Number(object) }),
    ...(frames   !== undefined && { frames:   Number(frames) }),
    ...(exposure !== undefined && { exposure: Number(exposure) }),
    ...(filter   !== undefined && { filter:   Number(filter) }),
  }
  try {
    const item = await updateApObjectSession(id, data)
    if (!item) { res.status(404).json({ error: 'Not found' }); return }
    res.json(item)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    const deleted = await deleteApObjectSession(id)
    if (!deleted) { res.status(404).json({ error: 'Not found' }); return }
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
