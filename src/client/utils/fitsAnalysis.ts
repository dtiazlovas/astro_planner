import type { FitsAnalysis } from './fits'

// Analyzes FITS files in a dedicated worker so the pixel loops don't block the
// UI. Files are processed one at a time: each frame is held fully in memory as
// a Float32Array while analyzed, so this also bounds memory use.
// When `signal` aborts, the run stops after the in-flight file and the partial
// results are returned.
export async function analyzeFitsFiles(
  files: File[],
  // Called after each file completes. `result` is that file's analysis, so
  // callers can render results incrementally instead of waiting for the batch.
  onProgress?: (done: number, total: number, result: FitsAnalysis) => void,
  signal?: AbortSignal,
): Promise<FitsAnalysis[]> {
  if (!files.length) return []
  const worker = new Worker(new URL('./fitsWorker.ts', import.meta.url), { type: 'module' })
  try {
    const results: FitsAnalysis[] = []
    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) break
      const file = files[i]
      const result = await new Promise<FitsAnalysis>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<{ result?: FitsAnalysis; error?: string }>) => resolve(
          e.data.result ?? {
            fileName: file.name, snr: null, fwhm: null, dateObs: null, width: null, height: null,
            error: e.data.error ?? 'Analysis failed',
          },
        )
        worker.onerror = () => reject(new Error('Analysis worker failed'))
        worker.postMessage({ file })
      })
      results.push(result)
      onProgress?.(i + 1, files.length, result)
    }
    return results
  } finally {
    worker.terminate()
  }
}
