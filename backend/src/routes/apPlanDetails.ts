import { Router, Request, Response } from 'express'
import { getDetailsByPlan, createDetail, updateDetail, deleteDetail } from '../services/apPlanDetailService.js'

const router = Router()

router.get('/', async (req: Request, res: Response) => {
  const planId = Number(req.query.plan)
  if (Number.isNaN(planId)) { res.status(400).json({ error: 'plan query param required' }); return }
  try {
    res.json(await getDetailsByPlan(planId))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/', async (req: Request, res: Response) => {
  const { planid, filter, duration } = req.body
  if (!planid || !filter || duration == null) {
    res.status(400).json({ error: 'planid, filter, duration are required' }); return
  }
  try {
    res.status(201).json(await createDetail({
      planid: Number(planid), filter: Number(filter), duration: Number(duration),
    }))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    const detail = await updateDetail(id, req.body)
    if (!detail) { res.status(404).json({ error: 'Not found' }); return }
    res.json(detail)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    const deleted = await deleteDetail(id)
    if (!deleted) { res.status(404).json({ error: 'Not found' }); return }
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
