import { Router, Request, Response } from 'express'
import {
  getAllApObjectTypes,
  getApObjectTypeById,
  createApObjectType,
  updateApObjectType,
  deleteApObjectType
} from '../services/apObjectTypeService.js'

const router = Router()

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getAllApObjectTypes())
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    const item = await getApObjectTypeById(id)
    if (!item) { res.status(404).json({ error: 'Not found' }); return }
    res.json(item)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/', async (req: Request, res: Response) => {
  const { name } = req.body as { name?: string }
  if (!name) { res.status(400).json({ error: 'name is required' }); return }
  try {
    res.status(201).json(await createApObjectType({ name }))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    const item = await updateApObjectType(id, req.body as { name?: string })
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
    const deleted = await deleteApObjectType(id)
    if (!deleted) { res.status(404).json({ error: 'Not found' }); return }
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
