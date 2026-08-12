import { analyzeFitsBuffer, decodeImageBuffer, type FitsAnalysis } from './fits'
import { renderPreview, PREVIEW_MAX_DIM } from './fitsPreview'

// Dedicated worker: receives one File per message, replies with its analysis
// and/or a blink preview. Both come off a single decode, so asking for the
// preview alongside the analysis costs little beyond the encode.
// Typed via a narrow cast because tsconfig uses the DOM lib, not WebWorker.

export interface WorkerRequest {
  file: File
  /** Omit to skip the (expensive) star detection when only a preview is wanted. */
  analyze?: boolean
  /** Longest edge for the preview; omit to skip preview generation. */
  previewMaxDim?: number
}

export interface WorkerReply {
  result?: FitsAnalysis
  preview?: { blob: Blob; width: number; height: number }
  error?: string
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
  postMessage(msg: WorkerReply): void
}

async function encode(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height)
  const g = canvas.getContext('2d')
  if (!g) throw new Error('No 2D context in worker')
  g.putImageData(new ImageData(rgba, width, height), 0, 0)
  // WebP holds up far better than JPEG on noisy astro frames at this size.
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })
}

ctx.onmessage = async e => {
  const { file, analyze = true, previewMaxDim } = e.data
  try {
    const buf = await file.arrayBuffer()
    const reply: WorkerReply = {}

    if (previewMaxDim) {
      const decoded = decodeImageBuffer(buf)
      const { rgba, width, height } = renderPreview(decoded, previewMaxDim || PREVIEW_MAX_DIM)
      reply.preview = { blob: await encode(rgba, width, height), width, height }
      // Star detection is the slow half; only pay for it when asked.
      if (analyze) {
        try {
          reply.result = analyzeFitsBuffer(file.name, buf)
        } catch (err) {
          reply.result = {
            fileName: file.name, snr: null, fwhm: null, dateObs: decoded.dateObs,
            width: decoded.width, height: decoded.height,
            error: err instanceof Error ? err.message : 'Analysis failed',
          }
        }
      }
    } else {
      reply.result = analyzeFitsBuffer(file.name, buf)
    }

    ctx.postMessage(reply)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read frame'
    ctx.postMessage({
      error: message,
      result: analyze
        ? { fileName: file.name, snr: null, fwhm: null, dateObs: null, width: null, height: null, error: message }
        : undefined,
    })
  }
}
