// ── Blink previews: downsample + autostretch ────────────────────────────────
// Turns a decoded linear frame into a small 8-bit image that shows faint
// signal, so frames can be flicked through and compared. Runs in the FITS
// worker (see fitsWorker.ts) off the back of the same decode the quality
// analysis uses.

import type { DecodedImage } from './fits'

/** Longest edge of a generated preview, in pixels. */
export const PREVIEW_MAX_DIM = 1920

/**
 * Bumping this invalidates every cached preview — change it whenever the
 * downsample or stretch below changes, or old and new frames will not be
 * comparable within one blink run.
 */
export const PREVIEW_VERSION = 1

export interface PreviewStats {
  /** normalized median of the downsampled frame (the sky level) */
  median: number
  /** shadows clipping point applied, in normalized units */
  shadows: number
  /** midtones balance applied */
  midtones: number
}

/**
 * Midtones Transfer Function — the curve PixInsight's ScreenTransferFunction
 * is built on. `m` is the midtone balance: 0.5 is identity, lower brightens.
 */
export function mtf(m: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (m === 0.5) return x
  return ((m - 1) * x) / (((2 * m - 1) * x) - m)
}

/**
 * Area-average downsample to at most `maxDim` on the longest edge.
 *
 * Averaging happens in linear space, before any stretch — that is the
 * physically correct order, and it is also what keeps the noise from being
 * exaggerated. The trade-off is that averaging suppresses pixel-scale noise,
 * so this is a tool for frame-level problems (trailing, cloud, gradients,
 * satellites, focus drift) rather than for judging read noise.
 */
function downsample(px: Float32Array, w: number, h: number, maxDim: number) {
  const scale = Math.max(w, h) / maxDim
  if (scale <= 1) return { px, w, h }

  const ow = Math.max(1, Math.round(w / scale))
  const oh = Math.max(1, Math.round(h / scale))
  const out = new Float32Array(ow * oh)

  for (let oy = 0; oy < oh; oy++) {
    const y0 = Math.floor((oy * h) / oh)
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * h) / oh))
    for (let ox = 0; ox < ow; ox++) {
      const x0 = Math.floor((ox * w) / ow)
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * w) / ow))
      let sum = 0, n = 0
      for (let y = y0; y < y1; y++) {
        const row = y * w
        for (let x = x0; x < x1; x++) { sum += px[row + x]; n++ }
      }
      out[oy * ow + ox] = sum / n
    }
  }
  return { px: out, w: ow, h: oh }
}

/**
 * PixInsight's AutoStretch: clip the shadows a few deviations below the sky
 * level, then pick the midtone balance that lands the sky at 25% grey.
 * Uses average absolute deviation from the median, as the reference
 * implementation does, rather than MAD.
 */
const TARGET_BACKGROUND = 0.25
const SHADOWS_CLIP = -2.8

/** Enough samples for a stable median; sorting the full frame is far slower
 *  and moves the result by well under a grey level. */
const STAT_SAMPLES = 200_000

function autostretchParams(norm: Float32Array): PreviewStats {
  const stride = Math.max(1, Math.floor(norm.length / STAT_SAMPLES))
  const n = Math.ceil(norm.length / stride)
  const sample = new Float32Array(n)
  for (let i = 0, j = 0; j < n; i += stride, j++) sample[j] = norm[i]
  sample.sort()
  const median = sample[n >> 1]

  let dev = 0
  for (let i = 0; i < n; i++) dev += Math.abs(sample[i] - median)
  const avgDev = dev / n

  const shadows = Math.min(1, Math.max(0, median + SHADOWS_CLIP * avgDev))
  const midtones = mtf(TARGET_BACKGROUND, median - shadows)
  return { median, shadows, midtones }
}

export interface RenderedPreview {
  /** RGBA, ready for ImageData / putImageData */
  rgba: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
  stats: PreviewStats
}

/** Decoded linear frame → downsampled, autostretched 8-bit RGBA. */
export function renderPreview(img: DecodedImage, maxDim = PREVIEW_MAX_DIM): RenderedPreview {
  const { px, w, h } = downsample(img.px, img.width, img.height, maxDim)

  // Normalize to [0,1] against the downsampled frame's own range. Averaging
  // has already pulled hot pixels down, so the max is a real star rather than
  // a single defective sensel.
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < px.length; i++) {
    const v = px[i]
    if (!Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) { lo = 0; hi = 1 }
  const span = hi - lo

  const norm = new Float32Array(px.length)
  for (let i = 0; i < px.length; i++) {
    const v = (px[i] - lo) / span
    norm[i] = v < 0 ? 0 : v > 1 ? 1 : v
  }

  const stats = autostretchParams(norm)
  const { shadows, midtones } = stats
  const range = Math.max(1e-9, 1 - shadows)

  const rgba = new Uint8ClampedArray(px.length * 4)
  for (let i = 0; i < norm.length; i++) {
    const clipped = (norm[i] - shadows) / range
    const g = Math.round(mtf(midtones, clipped < 0 ? 0 : clipped > 1 ? 1 : clipped) * 255)
    const o = i * 4
    rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255
  }

  return { rgba, width: w, height: h, stats }
}

/**
 * 256-entry lookup applying an extra midtone lift on top of an already
 * autostretched preview, so brightness can be adjusted live without decoding
 * the source frame again. `amount` runs 0 (unchanged) → 1 (much brighter).
 */
export function midtoneLut(amount: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256)
  // 0.5 is identity for the MTF; drive it down towards 0.08 as amount rises.
  const m = 0.5 - 0.42 * Math.min(1, Math.max(0, amount))
  for (let i = 0; i < 256; i++) lut[i] = Math.round(mtf(m, i / 255) * 255)
  return lut
}
