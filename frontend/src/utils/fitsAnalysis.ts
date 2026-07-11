import type { FitsAnalysis } from './fits'

// Analyzes FITS files in a dedicated worker so the pixel loops don't block the
// UI. Files are processed one at a time: each frame is held fully in memory as
// a Float32Array while analyzed, so this also bounds memory use.
export async function analyzeFitsFiles(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<FitsAnalysis[]> {
  if (!files.length) return []
  const worker = new Worker(new URL('./fitsWorker.ts', import.meta.url), { type: 'module' })
  try {
    const results: FitsAnalysis[] = []
    for (let i = 0; i < files.length; i++) {
      results.push(await new Promise<FitsAnalysis>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<{ result: FitsAnalysis }>) => resolve(e.data.result)
        worker.onerror = () => reject(new Error('Analysis worker failed'))
        worker.postMessage({ file: files[i] })
      }))
      onProgress?.(i + 1, files.length)
    }
    return results
  } finally {
    worker.terminate()
  }
}
