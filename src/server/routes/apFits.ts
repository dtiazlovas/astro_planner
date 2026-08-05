import { Router, Request, Response } from 'express'
import { analyzeFitsFiles, openFileInDefaultApp } from '../services/apFitsService.js'

const router = Router()

const OPEN_ERRORS: Record<string, { status: number; error: string }> = {
  'invalid-name':     { status: 400, error: 'A single file name is required' },
  'no-images-folder': { status: 409, error: 'Images folder is not set (Settings → Images Folder)' },
  'not-found':        { status: 404, error: 'File not found on the server, near the images folder' },
  'launch-failed':    { status: 500, error: 'The OS could not open the file' },
}

router.post('/analyze', async (req: Request, res: Response) => {
  const { fileNames, normalize } = req.body as { fileNames?: string[]; normalize?: boolean }
  if (!Array.isArray(fileNames)) { res.status(400).json({ error: 'fileNames must be an array' }); return }
  try {
    res.json(await analyzeFitsFiles(fileNames, normalize !== false))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Opens one sub in the OS default application, on the machine running the server.
router.post('/open', async (req: Request, res: Response) => {
  const { fileName } = req.body as { fileName?: string }
  if (typeof fileName !== 'string') { res.status(400).json({ error: 'fileName must be a string' }); return }
  try {
    const result = await openFileInDefaultApp(fileName)
    if (result.ok) { res.json({ path: result.path }); return }
    const { status, error } = OPEN_ERRORS[result.reason]
    res.status(status).json({ error: result.detail ? `${error}: ${result.detail}` : error })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
