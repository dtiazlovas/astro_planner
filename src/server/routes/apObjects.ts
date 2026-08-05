import { Router, Request, Response } from 'express'
import {
  getAllApObjects,
  getApObjectById,
  getAllFilterStats,
  getObjectFilterStats,
  getObjectPlanProgress,
  createApObject,
  updateApObject,
  deleteApObject,
  reorderAllApObjects
} from '../services/apObjectService.js'
import { assignUnassignedToActivePlan } from '../services/apPlanSessionService.js'
import type { CreateApObjectDto, UpdateApObjectDto } from '../models/ApObject.js'

const router = Router()

const equipmentParam = (req: Request): number | null => {
  if (req.query.equipment === undefined) return null
  const n = Number(req.query.equipment)
  return Number.isNaN(n) ? null : n
}

router.get('/', async (req: Request, res: Response) => {
  try {
    res.json(await getAllApObjects(equipmentParam(req)))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/reorder', async (req: Request, res: Response) => {
  const { ids } = req.body as { ids?: unknown }
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'number')) {
    res.status(400).json({ error: 'ids must be an array of numbers' }); return
  }
  try {
    await reorderAllApObjects(ids)
    res.json(await getAllApObjects())
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/:id/assign-to-plan', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    const assigned = await assignUnassignedToActivePlan(id, equipmentParam(req))
    res.json({ assigned })
  } catch (err) {
    console.error('assignUnassignedToActivePlan error:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' })
  }
})

router.get('/:id/plan-progress', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    res.json(await getObjectPlanProgress(id, equipmentParam(req)))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:id/filter-stats', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    res.json(await getObjectFilterStats(id, equipmentParam(req)))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Global per-filter totals — declared before '/:id' so it isn't captured as an id.
router.get('/filter-stats', async (req: Request, res: Response) => {
  try {
    res.json(await getAllFilterStats(equipmentParam(req)))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    const item = await getApObjectById(id)
    if (!item) { res.status(404).json({ error: 'Not found' }); return }
    res.json(item)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/', async (req: Request, res: Response) => {
  const body = req.body as Partial<CreateApObjectDto>
  if (!body.name || body.type === undefined || !body.position_json) {
    res.status(400).json({ error: 'name, type, and position_json are required' })
    return
  }
  try {
    res.status(201).json(await createApObject({
      name: body.name,
      type: body.type,
      position_json: body.position_json,
      comment: body.comment ?? null,
      active: body.active ?? true,
      aliases: body.aliases ?? null,
      priority: 0,
      folder: body.folder ?? null,
    }))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    const item = await updateApObject(id, req.body as UpdateApObjectDto)
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
    const deleted = await deleteApObject(id)
    if (!deleted) { res.status(404).json({ error: 'Not found' }); return }
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
