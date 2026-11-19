import { Router, Request, Response } from 'express'
import { getPsfswAnchors, ensurePsfswAnchor, setPsfswAnchor } from '../services/apPsfswAnchorService.js'

const router = Router()

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getPsfswAnchors())
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// `replace` marks a deliberate re-baseline; without it an existing anchor is
// left in force and returned unchanged.
router.post('/', async (req: Request, res: Response) => {
  const { object, filter, panel, anchor, subs, replace } = req.body as
    { object?: number; filter?: number; panel?: string | null; anchor?: number; subs?: number; replace?: boolean }
  if (typeof object !== 'number' || typeof filter !== 'number') {
    res.status(400).json({ error: 'object and filter must be numbers' }); return
  }
  if (panel != null && typeof panel !== 'string') {
    res.status(400).json({ error: 'panel must be a string' }); return
  }
  if (typeof anchor !== 'number' || !isFinite(anchor) || anchor <= 0) {
    res.status(400).json({ error: 'anchor must be a positive number' }); return
  }
  // A plain object's pairs are keyed with panel ''.
  const panelKey = panel?.trim() ?? ''
  try {
    const row = replace
      ? await setPsfswAnchor(object, filter, panelKey, anchor, subs ?? 0)
      : await ensurePsfswAnchor(object, filter, panelKey, anchor, subs ?? 0)
    res.json(row)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
