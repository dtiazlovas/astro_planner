import { analyzeFitsBuffer, type FitsAnalysis } from './fits'

// Dedicated worker: receives one File per message, replies with its analysis.
// Typed via a narrow cast because tsconfig uses the DOM lib, not WebWorker.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<{ file: File }>) => void) | null
  postMessage(msg: { result: FitsAnalysis }): void
}

ctx.onmessage = async e => {
  const { file } = e.data
  let result: FitsAnalysis
  try {
    result = analyzeFitsBuffer(file.name, await file.arrayBuffer())
  } catch (err) {
    result = {
      fileName: file.name, snr: null, fwhm: null, dateObs: null, width: null, height: null,
      error: err instanceof Error ? err.message : 'Analysis failed',
    }
  }
  ctx.postMessage({ result })
}
