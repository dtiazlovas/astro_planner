// ── FITS parsing / frame-quality analysis ───────────────────────────────────
// Runs in the browser (see fitsWorker.ts) on buffers read from user-picked
// files, so source frames can live anywhere the user can browse to.
// FITS files are laid out as a sequence of 2880-byte blocks. The primary header
// is ASCII, split into 80-byte "cards"; the pixel data array follows, aligned to
// the next 2880-byte boundary. We parse only what we need to sample pixels and
// estimate a signal-to-noise ratio. Mono images only (NAXIS == 2).

const BLOCK = 2880
const CARD = 80

const ascii = new TextDecoder('latin1')

interface FitsHeader {
  cards: Record<string, string>
  dataStart: number
}

function readHeader(bytes: Uint8Array): FitsHeader {
  const cards: Record<string, string> = {}
  let offset = 0
  let ended = false
  while (offset + BLOCK <= bytes.length && !ended) {
    for (let i = 0; i < BLOCK; i += CARD) {
      const card = ascii.decode(bytes.subarray(offset + i, offset + i + CARD))
      const keyword = card.slice(0, 8).trim()
      if (keyword === 'END') { ended = true; break }
      if (!keyword || card[8] !== '=') continue
      const raw = card.slice(9).trim()
      let value: string
      if (raw.startsWith("'")) {
        // String value: everything up to the closing quote.
        const end = raw.indexOf("'", 1)
        value = (end === -1 ? raw.slice(1) : raw.slice(1, end)).trim()
      } else {
        // Numeric / logical value: strip trailing "/ comment".
        const slash = raw.indexOf('/')
        value = (slash === -1 ? raw : raw.slice(0, slash)).trim()
      }
      if (!(keyword in cards)) cards[keyword] = value
    }
    offset += BLOCK
  }
  // Data begins at the block boundary following the END card.
  return { cards, dataStart: offset }
}

export interface FitsAnalysis {
  fileName: string
  snr: number | null
  /** median star FWHM in pixels (moment-based; lower is better) */
  fwhm: number | null
  dateObs: string | null
  width: number | null
  height: number | null
  stars?: number
  error?: string
}

// FITS numeric data is big-endian; DataView reads default to big-endian.
function readSample(dv: DataView, off: number, bitpix: number): number {
  switch (bitpix) {
    case 8:   return dv.getUint8(off)
    case 16:  return dv.getInt16(off)
    case 32:  return dv.getInt32(off)
    case -32: return dv.getFloat32(off)
    case -64: return dv.getFloat64(off)
    default:  throw new Error(`Unsupported BITPIX ${bitpix}`)
  }
}

// Loads the whole 2-D image into a Float32Array in physical units.
function buildPixels(dv: DataView, dataStart: number, npix: number, bitpix: number, bzero: number, bscale: number): Float32Array {
  const bpp = Math.abs(bitpix) / 8
  const px = new Float32Array(npix)
  const limit = dv.byteLength
  for (let i = 0; i < npix; i++) {
    const off = dataStart + i * bpp
    if (off + bpp > limit) break
    px[i] = bzero + bscale * readSample(dv, off, bitpix)
  }
  return px
}

// Robust sky background & noise via iterative k-sigma clipping over a subsample.
// Rejecting stars/signal each pass leaves the true sky statistics.
function estimateSky(px: Float32Array): { bg: number; sigma: number } {
  const n = px.length
  const stride = Math.max(1, Math.floor(n / 200_000))
  const vals: number[] = []
  for (let i = 0; i < n; i += stride) vals.push(px[i])
  if (!vals.length) return { bg: 0, sigma: 1e-6 }

  let lo = -Infinity, hi = Infinity, mean = 0, std = 0
  for (let iter = 0; iter < 5; iter++) {
    let sum = 0, cnt = 0
    for (const v of vals) if (v >= lo && v <= hi) { sum += v; cnt++ }
    if (!cnt) break
    mean = sum / cnt
    let s2 = 0
    for (const v of vals) if (v >= lo && v <= hi) { const d = v - mean; s2 += d * d }
    std = Math.sqrt(s2 / Math.max(1, cnt - 1))
    lo = mean - 3 * std; hi = mean + 3 * std
  }
  return { bg: mean, sigma: std > 0 ? std : 1e-6 }
}

// PSF Signal Weight (PixInsight PSFSW), faithful structural analog.
// PixInsight defines (ImageWeighting doc, §2.5):
//
//                (Σ Fᵢ) · (Σ M̄ᵢ)
//     PSFSW  =  ─────────────────── · K
//                     σ · b̄
//
//   Σ Fᵢ   — sum of per-star PSF fluxes  → total signal
//   Σ M̄ᵢ  — sum of per-star MEAN fluxes → signal concentration (rewards small,
//            sharp stars, i.e. resolution/focus/seeing)
//   σ      — noise estimate (error term)
//   b̄      — robust mean background (penalises gradients, clouds, poor
//            transparency, moonlight)
//   K      — normalization constant; PixInsight calibrates it to unit median.
//
// Approximations vs the reference implementation (all documented for honesty):
//   • Flux/mean-flux come from moment-based ("hybrid PSF/aperture") photometry
//     rather than a full nonlinear PSF fit.
//   • σ is the iterative k-sigma sky noise (PI uses MRS multiresolution noise).
//   • b̄ is the clipped mean sky (PI uses a 256px MMT large-scale background).
//   • K is applied later as unit-median normalization over the analyzed set.
const R_PHOT = 4, R_IN = 6, R_OUT = 9, DETECT_SIGMA = 5, MAX_STARS = 300, MIN_SEP = 8

function computePsfSignalWeight(px: Float32Array, w: number, h: number): { weight: number | null; stars: number; fwhm: number | null } {
  const { bg, sigma } = estimateSky(px)
  const thr = bg + DETECT_SIGMA * sigma
  const margin = R_OUT + 1
  if (w <= 2 * margin || h <= 2 * margin) return { weight: null, stars: 0, fwhm: null }

  // Collect local maxima (only test neighbours for the few pixels above threshold).
  const cand: { x: number; y: number; v: number }[] = []
  for (let y = margin; y < h - margin; y++) {
    const row = y * w
    for (let x = margin; x < w - margin; x++) {
      const idx = row + x
      const v = px[idx]
      if (v <= thr) continue
      if (v < px[idx - 1] || v < px[idx + 1] || v < px[idx - w] || v < px[idx + w] ||
          v < px[idx - w - 1] || v < px[idx - w + 1] || v < px[idx + w - 1] || v < px[idx + w + 1]) continue
      cand.push({ x, y, v })
    }
  }
  cand.sort((a, b) => b.v - a.v)

  // Greedily pick the brightest well-separated stars.
  const chosen: { x: number; y: number }[] = []
  const sep2 = MIN_SEP * MIN_SEP
  for (const c of cand) {
    if (chosen.length >= MAX_STARS) break
    if (chosen.some(s => (s.x - c.x) ** 2 + (s.y - c.y) ** 2 < sep2)) continue
    chosen.push({ x: c.x, y: c.y })
  }
  if (!chosen.length) return { weight: null, stars: 0, fwhm: null }

  let sumFlux = 0        // Σ Fᵢ  — total signal
  let sumMeanFlux = 0    // Σ M̄ᵢ — signal concentration
  let stars = 0
  const fwhms: number[] = []
  for (const { x, y } of chosen) {
    // Local sky = median of the annulus.
    const ann: number[] = []
    for (let dy = -R_OUT; dy <= R_OUT; dy++)
      for (let dx = -R_OUT; dx <= R_OUT; dx++) {
        const r2 = dx * dx + dy * dy
        if (r2 >= R_IN * R_IN && r2 <= R_OUT * R_OUT) ann.push(px[(y + dy) * w + (x + dx)])
      }
    ann.sort((a, b) => a - b)
    const localSky = ann.length ? ann[ann.length >> 1] : bg

    // Flux-weighted centroid within the photometry disk (positive weights only).
    let sw = 0, swx = 0, swy = 0
    for (let dy = -R_PHOT; dy <= R_PHOT; dy++)
      for (let dx = -R_PHOT; dx <= R_PHOT; dx++) {
        if (dx * dx + dy * dy > R_PHOT * R_PHOT) continue
        const val = px[(y + dy) * w + (x + dx)] - localSky
        if (val > 0) { sw += val; swx += val * dx; swy += val * dy }
      }
    if (sw <= 0) continue
    const cx = swx / sw, cy = swy / sw

    // Total flux (Fᵢ) and second moments → effective PSF area = 2π·σx·σy.
    let flux = 0, mxx = 0, myy = 0
    for (let dy = -R_PHOT; dy <= R_PHOT; dy++)
      for (let dx = -R_PHOT; dx <= R_PHOT; dx++) {
        if (dx * dx + dy * dy > R_PHOT * R_PHOT) continue
        const val = px[(y + dy) * w + (x + dx)] - localSky
        flux += val
        if (val > 0) { const ux = dx - cx, uy = dy - cy; mxx += val * ux * ux; myy += val * uy * uy }
      }
    const varx = mxx / sw, vary = myy / sw
    if (flux <= 0 || varx <= 0 || vary <= 0) continue
    const area = 2 * Math.PI * Math.sqrt(varx * vary)   // effective PSF footprint (px)
    if (area <= 0) continue

    sumFlux += flux
    sumMeanFlux += flux / area                          // M̄ᵢ — mean PSF flux
    // FWHM from the same second moments: 2√(2·ln2) × geometric-mean sigma.
    fwhms.push(2.3548 * Math.pow(varx * vary, 0.25))
    stars++
  }
  if (!stars) return { weight: null, stars: 0, fwhm: null }

  fwhms.sort((a, b) => a - b)
  const fwhm = fwhms[fwhms.length >> 1]

  const b = Math.max(bg, 1e-6)
  const raw = (sumFlux * sumMeanFlux) / (sigma * b)
  return { weight: raw, stars, fwhm }
}

// ── XISF (PixInsight) support ────────────────────────────────────────────────
// Calibrated subs are usually saved as .xisf. Monolithic XISF 1.0 layout:
// 8-byte signature "XISF0100", uint32 LE header length, 4 reserved bytes, then
// an XML header describing the image and its attached pixel block.

const attrOf = (tag: string, name: string): string | null =>
  tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null

function analyzeXisfBuffer(fileName: string, buf: ArrayBuffer): FitsAnalysis {
  const bytes = new Uint8Array(buf)
  const dv = new DataView(buf)
  const headerLen = dv.getUint32(8, true)
  const xml = new TextDecoder().decode(bytes.subarray(16, Math.min(16 + headerLen, bytes.length)))
  const imgTag = xml.match(/<Image\b[^>]*>/)?.[0]
  if (!imgTag) throw new Error('No image in XISF header')
  const geometry = (attrOf(imgTag, 'geometry') ?? '').split(':').map(Number)
  const [w, h] = geometry
  const channels = geometry.length > 2 ? geometry[2] : 1
  if (!w || !h) throw new Error('Not a XISF image')
  if (channels !== 1) throw new Error('Only mono images are supported')
  if (attrOf(imgTag, 'compression')) throw new Error('Compressed XISF not supported')
  const location = (attrOf(imgTag, 'location') ?? '').split(':')
  if (location[0] !== 'attachment') throw new Error('Unsupported XISF data location')
  const dataStart = parseInt(location[1], 10)
  const sampleFormat = attrOf(imgTag, 'sampleFormat') ?? 'UInt16'
  const littleEndian = (attrOf(imgTag, 'byteOrder') ?? 'little') !== 'big'
  const dateObs = xml.match(/<FITSKeyword\b[^>]*name="DATE-OBS"[^>]*value="([^"]*)"/)?.[1]?.replace(/'/g, '').trim() ?? null

  const readers: Record<string, { bpp: number; read: (off: number) => number }> = {
    UInt8:   { bpp: 1, read: off => dv.getUint8(off) },
    UInt16:  { bpp: 2, read: off => dv.getUint16(off, littleEndian) },
    UInt32:  { bpp: 4, read: off => dv.getUint32(off, littleEndian) },
    Float32: { bpp: 4, read: off => dv.getFloat32(off, littleEndian) },
    Float64: { bpp: 8, read: off => dv.getFloat64(off, littleEndian) },
  }
  const reader = readers[sampleFormat]
  if (!reader) throw new Error(`Unsupported XISF sample format ${sampleFormat}`)

  const npix = w * h
  const px = new Float32Array(npix)
  const limit = dv.byteLength
  for (let i = 0; i < npix; i++) {
    const off = dataStart + i * reader.bpp
    if (off + reader.bpp > limit) break
    px[i] = reader.read(off)
  }

  const { weight, stars, fwhm } = computePsfSignalWeight(px, w, h)
  if (weight == null) throw new Error('No stars detected')
  return { fileName, snr: weight, fwhm: fwhm != null ? Math.round(fwhm * 100) / 100 : null, dateObs, width: w, height: h, stars }
}

// Dispatches on the file signature: XISF or FITS.
export function analyzeFitsBuffer(fileName: string, buf: ArrayBuffer): FitsAnalysis {
  const head = new Uint8Array(buf)
  if (head.length >= 8 && ascii.decode(head.subarray(0, 8)) === 'XISF0100')
    return analyzeXisfBuffer(fileName, buf)
  return analyzeFitsImage(fileName, buf)
}

function analyzeFitsImage(fileName: string, buf: ArrayBuffer): FitsAnalysis {
  const bytes = new Uint8Array(buf)
  const dv = new DataView(buf)
  const { cards, dataStart } = readHeader(bytes)
  const bitpix = parseInt(cards.BITPIX, 10)
  const naxis = parseInt(cards.NAXIS, 10)
  const w = parseInt(cards.NAXIS1, 10)
  const h = parseInt(cards.NAXIS2, 10)
  const naxis3 = cards.NAXIS3 !== undefined ? parseInt(cards.NAXIS3, 10) : 1
  const dateObs = cards['DATE-OBS'] ?? null

  if (!Number.isFinite(bitpix) || !Number.isFinite(w) || !Number.isFinite(h))
    throw new Error('Not a FITS image')
  // Mono only for now: a 2-D array (or a 3-D array with a single plane).
  if (naxis !== 2 && !(naxis === 3 && naxis3 === 1))
    throw new Error('Only mono images are supported')

  const px = buildPixels(dv, dataStart, w * h,
    bitpix,
    cards.BZERO !== undefined ? parseFloat(cards.BZERO) : 0,
    cards.BSCALE !== undefined ? parseFloat(cards.BSCALE) : 1)

  const { weight, stars, fwhm } = computePsfSignalWeight(px, w, h)
  if (weight == null) throw new Error('No stars detected')
  // `snr` carries the raw PSF Signal Weight here; normalized to unit median later.
  return { fileName, snr: weight, fwhm: fwhm != null ? Math.round(fwhm * 100) / 100 : null, dateObs, width: w, height: h, stars }
}
