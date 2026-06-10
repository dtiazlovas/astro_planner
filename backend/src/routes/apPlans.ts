import { Router, Request, Response } from 'express'
import { getAllPlans, getPlansByObject, getPlanById, createPlan, updatePlan, deletePlan } from '../services/apPlanService.js'

const router = Router()

router.get('/', async (req: Request, res: Response) => {
  try {
    if (req.query.object !== undefined) {
      const objectId = Number(req.query.object)
      if (Number.isNaN(objectId)) { res.status(400).json({ error: 'Invalid object id' }); return }
      res.json(await getPlansByObject(objectId))
    } else {
      res.json(await getAllPlans())
    }
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    const plan = await getPlanById(id)
    if (!plan) { res.status(404).json({ error: 'Not found' }); return }
    res.json(plan)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/', async (req: Request, res: Response) => {
  const { object, name, active } = req.body
  if (!object || !name) { res.status(400).json({ error: 'object and name are required' }); return }
  try {
    res.status(201).json(await createPlan({
      object: Number(object), name,
      active: active ?? true,
    }))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    const plan = await updatePlan(id, req.body)
    if (!plan) { res.status(404).json({ error: 'Not found' }); return }
    res.json(plan)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    const deleted = await deletePlan(id)
    if (!deleted) { res.status(404).json({ error: 'Not found' }); return }
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
