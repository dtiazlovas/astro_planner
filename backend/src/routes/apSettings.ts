import { Router, Request, Response } from 'express'
import { exec } from 'node:child_process'
import { getSetting, setSetting } from '../services/apSettingService.js'

const router = Router()

router.post('/pick-folder', (_req: Request, res: Response) => {
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select images folder'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }`
  exec(`powershell -NoProfile -Command "${ps}"`, (err, stdout) => {
    if (err) { res.status(500).json({ error: 'Folder picker failed' }); return }
    const path = stdout.trim()
    res.json({ path })
  })
})

router.get('/:key', async (req: Request, res: Response) => {
  try {
    const item = await getSetting(req.params.key)
    if (!item) { res.status(404).json({ error: 'Not found' }); return }
    res.json(item)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/:key', async (req: Request, res: Response) => {
  const { value } = req.body as { value?: string }
  if (value === undefined) { res.status(400).json({ error: 'value is required' }); return }
  try {
    res.json(await setSetting(req.params.key, value))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
