import { Router, Request, Response } from 'express'
import { setPlanSession, deletePlanSession } from '../services/apPlanSessionService.js'

const router = Router()

router.post('/', async (req: Request, res: Response) => {
  const { session, planid } = req.body
  if (!session || !planid) {
    res.status(400).json({ error: 'session and planid are required' }); return
  }
  try {
    res.status(201).json(await setPlanSession({ session: Number(session), planid: Number(planid) }))
  } catch (err) {
    console.error('setPlanSession error:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' })
  }
})

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (Number.isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    const deleted = await deletePlanSession(id)
    if (!deleted) { res.status(404).json({ error: 'Not found' }); return }
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
