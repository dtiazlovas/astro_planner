import { Router, Request, Response } from 'express'
import { getAllApEquipment, createApEquipment, updateApEquipment, deleteApEquipment, type EquipmentInput } from '../services/apEquipmentService.js'

const router = Router()

const ALLOWED_SENSORS = ['585', '571', '455']
const ALLOWED_BINNING = [1, 2]

function parseBody(body: any): { data?: EquipmentInput; error?: string } {
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return { error: 'name is required' }

  const focal_length = Number(body?.focal_length)
  if (!Number.isFinite(focal_length) || focal_length <= 0) return { error: 'focal_length must be a positive number' }

  const focal_ratio = Number(body?.focal_ratio)
  if (!Number.isFinite(focal_ratio) || focal_ratio <= 0) return { error: 'focal_ratio must be a positive number' }

  const reducer = body?.reducer === undefined || body?.reducer === null || body?.reducer === '' ? 1.0 : Number(body.reducer)
  if (!Number.isFinite(reducer) || reducer <= 0) return { error: 'reducer must be a positive number' }

  const sensor = String(body?.sensor ?? '')
  if (!ALLOWED_SENSORS.includes(sensor)) return { error: `sensor must be one of ${ALLOWED_SENSORS.join(', ')}` }

  const binning = Number(body?.binning)
  if (!ALLOWED_BINNING.includes(binning)) return { error: `binning must be one of ${ALLOWED_BINNING.join(', ')}` }

  return { data: { name, focal_length, focal_ratio, reducer, sensor, binning } }
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getAllApEquipment())
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/', async (req: Request, res: Response) => {
  const { data, error } = parseBody(req.body)
  if (error) { res.status(400).json({ error }); return }
  try {
    res.status(201).json(await createApEquipment(data!))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { data, error } = parseBody(req.body)
  if (error) { res.status(400).json({ error }); return }
  try {
    const updated = await updateApEquipment(id, data!)
    if (!updated) { res.status(404).json({ error: 'Not found' }); return }
    res.json(updated)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  try {
    const deleted = await deleteApEquipment(id)
    if (!deleted) { res.status(404).json({ error: 'Not found' }); return }
    res.status(204).end()
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
