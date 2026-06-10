import { Router, Request, Response } from 'express'
import {
  getAllApSessions,
  getApSessionById,
  createApSession,
  updateApSession,
  deleteApSession
} from '../services/apSessionService.js'
import type { CreateApSessionDto, UpdateApSessionDto } from '../models/ApSession.js'

const router = Router()

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getAllApSessions())
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    const item = await getApSessionById(id)
    if (!item) { res.status(404).json({ error: 'Not found' }); return }
    res.json(item)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/', async (req: Request, res: Response) => {
  const body = req.body as Partial<CreateApSessionDto>
  if (!body.name || !body.start || body.duration_set === undefined) {
    res.status(400).json({ error: 'name, start, and duration_set are required' })
    return
  }
  try {
    res.status(201).json(await createApSession({
      name: body.name,
      start: new Date(body.start as unknown as string),
      duration: body.duration ? new Date(body.duration as unknown as string) : null,
      duration_set: body.duration_set,
      comment: body.comment ?? null
    }))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  const body = req.body as Record<string, unknown>
  const data: UpdateApSessionDto = {}
  if (body.name !== undefined) data.name = body.name as string
  if (body.start !== undefined) data.start = new Date(body.start as string)
  if ('duration' in body) data.duration = body.duration ? new Date(body.duration as string) : null
  if (body.duration_set !== undefined) data.duration_set = body.duration_set as boolean
  if ('comment' in body) data.comment = (body.comment as string | null) ?? null
  try {
    const item = await updateApSession(id, data)
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
    const deleted = await deleteApSession(id)
    if (!deleted) { res.status(404).json({ error: 'Not found' }); return }
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
