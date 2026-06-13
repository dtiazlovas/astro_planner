import { Router, Request, Response } from 'express'
import { getAllApFilters, createApFilter, updateApFilter, deleteApFilter } from '../services/apFilterService.js'

const router = Router()

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getAllApFilters())
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/', async (req: Request, res: Response) => {
  const { name, aliases, folder } = req.body as { name?: string; aliases?: string | null; folder?: string | null }
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return }
  try {
    res.status(201).json(await createApFilter(name.trim(), aliases ?? null, folder ?? null))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { name, aliases, folder } = req.body as { name?: string; aliases?: string | null; folder?: string | null }
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return }
  try {
    const updated = await updateApFilter(id, name.trim(), aliases ?? null, folder ?? null)
    if (!updated) { res.status(404).json({ error: 'Not found' }); return }
    res.json(updated)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  try {
    const deleted = await deleteApFilter(id)
    if (!deleted) { res.status(404).json({ error: 'Not found' }); return }
    res.status(204).end()
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
