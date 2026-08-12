import { PREVIEW_MAX_DIM } from './fitsPreview'
import { getPreview, putPreview, enforceCap, touchFolder, requestPersistence } from './previewCache'
import type { WorkerReply } from './fitsWorker'

export interface PreviewReady {
  index: number
  blob: Blob
  /** true when it came from the cache rather than being rendered now */
  cached: boolean
}

/**
 * Fills in blink previews for `files`, newest work last: cached entries are
 * handed back immediately, misses are rendered one at a time in a worker so
 * only one frame is held in memory at once.
 *
 * `onReady` fires per frame so the viewer can start blinking before the whole
 * set is built. Aborting stops after the frame in flight.
 */
export async function buildPreviews(
  scope: string,
  files: File[],
  onReady: (p: PreviewReady) => void,
  signal?: AbortSignal,
): Promise<void> {
  void requestPersistence()
  void touchFolder(scope)

  // Serve everything already cached before doing any decoding, so a revisit
  // is instant and a partial set still starts fast.
  const misses: number[] = []
  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) return
    const f = files[i]
    const hit = await getPreview(f.name, f.size, f.lastModified)
    if (hit) onReady({ index: i, blob: hit.blob, cached: true })
    else misses.push(i)
  }
  if (!misses.length || signal?.aborted) return

  const worker = new Worker(new URL('./fitsWorker.ts', import.meta.url), { type: 'module' })
  try {
    for (const i of misses) {
      if (signal?.aborted) break
      const file = files[i]
      const reply = await new Promise<WorkerReply>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<WorkerReply>) => resolve(e.data)
        worker.onerror = () => reject(new Error('Preview worker failed'))
        // Star detection is the slow half and the viewer does not need it.
        worker.postMessage({ file, analyze: false, previewMaxDim: PREVIEW_MAX_DIM })
      })
      if (!reply.preview) continue   // unreadable frame: skip, keep going
      const { blob, width, height } = reply.preview
      onReady({ index: i, blob, cached: false })
      await putPreview({
        folder: scope, name: file.name, blob, width, height,
        srcSize: file.size, srcModified: file.lastModified,
      })
    }
  } finally {
    worker.terminate()
    void enforceCap()
  }
}
