// Astronomical helpers computed locally (no network): deterministic, instant,
// offline, and rate-limit free — important when a month view needs a value for
// ~40 day cells at once.

// Default imaging latitude (Austin, TX) — used until the user sets their own.
export const DEFAULT_LATITUDE = 30.2672

const BASE = '/api'
const LATITUDE_KEY = 'latitude'

// Persisted observer latitude. Longitude isn't needed for darkness *length*
// (only for absolute clock times), so only latitude is stored.
export async function fetchLatitude(): Promise<number> {
  try {
    const res = await fetch(`${BASE}/settings/${LATITUDE_KEY}`)
    if (res.ok) {
      const data = await res.json() as { value: string | null }
      const v = parseFloat(data.value ?? '')
      if (!isNaN(v) && v >= -90 && v <= 90) return v
    }
  } catch {}
  return DEFAULT_LATITUDE
}

export async function saveLatitude(lat: number): Promise<void> {
  await fetch(`${BASE}/settings/${LATITUDE_KEY}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: String(lat) }),
  })
}

// "30.3°N" / "12.5°S" / "0.0°"
export function formatLatitude(lat: number): string {
  const hemi = lat > 0 ? 'N' : lat < 0 ? 'S' : ''
  return `${Math.abs(lat).toFixed(1)}°${hemi}`
}

const RAD = Math.PI / 180

// Solar declination (radians) for a calendar date, via the standard
// low-precision model (accurate to ≈0.01°). Declination changes slowly across a
// night, so the exact hour is immaterial to a darkness-length calculation.
function solarDeclination(date: Date): number {
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate()
  // Julian Day Number at 12h UT (Fliegel–Van Flandern).
  const a = Math.floor((14 - m) / 12)
  const yy = y + 4800 - a
  const mm = m + 12 * a - 3
  const jdn = d + Math.floor((153 * mm + 2) / 5) + 365 * yy
    + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045
  const n = jdn - 2451545.0 // days since J2000
  const L = (280.460 + 0.9856474 * n) % 360
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD
  const eps = (23.439 - 0.0000004 * n) * RAD
  return Math.asin(Math.sin(eps) * Math.sin(lambda))
}

/**
 * Length, in hours, of astronomical darkness (Sun below −18°) for the night
 * that begins on the evening of `date` at the given latitude. Returns 0 when the
 * Sun never drops below −18° (polar summer) and 24 when it never rises above it
 * (polar winter). Austin (lat ≈30°) always yields a normal value year-round.
 */
export function astronomicalDarknessHours(date: Date, latDeg: number): number {
  const dec = solarDeclination(date)
  const lat = latDeg * RAD
  const alt = -18 * RAD
  const cosH = (Math.sin(alt) - Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * Math.cos(dec))
  if (cosH <= -1) return 0
  if (cosH >= 1) return 24
  const Hdeg = Math.acos(cosH) / RAD // half-arc the Sun spends above −18°, in degrees
  return 24 - (2 * Hdeg) / 15         // remaining hours are astronomical night
}

const sinDeg = (deg: number) => Math.sin(deg * RAD)
const norm360 = (deg: number) => ((deg % 360) + 360) % 360

// Mean synodic month — the average new-moon-to-new-moon interval.
const SYNODIC_DAYS = 29.530588853

// Days elapsed since J2000.0 (2000-01-01 12:00 UT). UT is used in place of TT;
// the ~70 s difference is far below the precision of the series below.
function daysSinceJ2000(date: Date): number {
  return date.getTime() / 86400000 - 10957.5
}

// Geocentric ecliptic longitudes of the Sun and Moon, plus the Moon's ecliptic
// latitude, all in degrees. Truncated Meeus series — good to a few arcminutes,
// which is far finer than a phase readout needs.
function sunMoonPositions(d: number) {
  const Ms = norm360(357.5291 + 0.98560028 * d)          // Sun mean anomaly
  const sunLon = norm360(280.459 + 0.98564736 * d + 1.915 * sinDeg(Ms) + 0.020 * sinDeg(2 * Ms))

  const Lm = 218.316 + 13.176396 * d                     // Moon mean longitude
  const Mm = 134.963 + 13.064993 * d                     // Moon mean anomaly
  const F = 93.272 + 13.229350 * d                       // argument of latitude
  const D = 297.850 + 12.190749 * d                      // mean elongation from the Sun
  const moonLon = norm360(
    Lm + 6.289 * sinDeg(Mm) + 1.274 * sinDeg(2 * D - Mm) + 0.658 * sinDeg(2 * D)
    + 0.214 * sinDeg(2 * Mm) - 0.186 * sinDeg(Ms) - 0.114 * sinDeg(2 * F)
  )
  const moonLat = 5.128 * sinDeg(F)

  return { sunLon, moonLon, moonLat }
}

export interface MoonPhase {
  /** Illuminated fraction of the disc, 0 (new) to 1 (full). */
  illumination: number
  /** Position in the cycle: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  age: number
  /** True while the lit limb is growing (age < 0.5). */
  waxing: boolean
  /** Human label, e.g. "Waxing gibbous". */
  name: string
  /** Whole days until the next new moon — the useful number for planning. */
  daysToNewMoon: number
}

// Named windows around the four principal phases. ±0.02 of a cycle is ±~14h,
// so "Full moon" shows for roughly the night either side of the exact instant.
function phaseName(age: number): string {
  if (age < 0.02 || age >= 0.98) return 'New moon'
  if (age < 0.23) return 'Waxing crescent'
  if (age < 0.27) return 'First quarter'
  if (age < 0.48) return 'Waxing gibbous'
  if (age < 0.52) return 'Full moon'
  if (age < 0.73) return 'Waning gibbous'
  if (age < 0.77) return 'Last quarter'
  return 'Waning crescent'
}

// ── Object positions ───────────────────────────────────────────────

/** J2000 equatorial coordinates, both in degrees. */
export interface SkyPosition { ra: number; dec: number }

// "00h42m44.3s", "00:42:44", "+41°16′07″", "-05 23 28", "41d16m09s" → [sign, value]
// in the leading unit. Separators are anything that isn't part of a number.
function parseSexagesimal(s: string): number | null {
  const t = s.trim()
  const neg = /^[-−–]/.test(t)
  const parts = t.replace(/^[-−–+]/, '').split(/[^\d.]+/).filter(Boolean).map(Number)
  if (parts.length === 0 || parts.length > 3 || parts.some(p => !isFinite(p))) return null
  const [a, b = 0, c = 0] = parts
  if (b >= 60 || c >= 60) return null
  const v = a + b / 60 + c / 3600
  return neg ? -v : v
}

// A bare number is degrees. A string is hours when it is written the way RA
// usually is — with an "h", colons, or space-separated fields — and degrees
// otherwise ("10.68", "10°41′").
function parseRa(v: unknown): number | null {
  if (typeof v === 'number') return isFinite(v) && v >= 0 && v < 360 ? v : null
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim()
  const hours = /h/i.test(s) || s.includes(':') || /\d\s+\d/.test(s)
  const n = parseSexagesimal(s)
  if (n === null || n < 0) return null
  const deg = hours ? n * 15 : n
  return deg < 360 ? deg : null
}

function parseDec(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseSexagesimal(v) : null
  return n !== null && isFinite(n) && n >= -90 && n <= 90 ? n : null
}

/**
 * Reads an object's free-form position field. Accepts `{"ra", "dec"}` (any key
 * case) as degrees or sexagesimal strings; returns null for anything it can't
 * read unambiguously, including the stored '{}' for "no position".
 */
export function parsePosition(json: string | null | undefined): SkyPosition | null {
  if (!json || !json.trim()) return null
  let o: unknown
  try { o = JSON.parse(json) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const keyed = new Map(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), v]))
  const ra = parseRa(keyed.get('ra'))
  const dec = parseDec(keyed.get('dec') ?? keyed.get('de'))
  return ra !== null && dec !== null ? { ra, dec } : null
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "00h42m44.3s" */
export function formatRa(deg: number): string {
  const tenths = Math.round((((deg % 360) + 360) % 360) / 15 * 36000) % (24 * 36000)
  const h = Math.floor(tenths / 36000), m = Math.floor(tenths / 600) % 60, s = (tenths % 600) / 10
  return `${pad2(h)}h${pad2(m)}m${s.toFixed(1).padStart(4, '0')}s`
}

/** "+41°16′07″" */
export function formatDec(deg: number): string {
  const secs = Math.round(Math.abs(deg) * 3600)
  const d = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = secs % 60
  return `${deg < 0 ? '−' : '+'}${pad2(d)}°${pad2(m)}′${pad2(s)}″`
}

/** The stored form — readable in the text field and accepted by parsePosition. */
export function formatPositionJson(p: SkyPosition): string {
  return JSON.stringify({ ra: formatRa(p.ra), dec: formatDec(p.dec).replace('−', '-') })
}

// ── An object's coming night ───────────────────────────────────────

/** Altitude the sky card measures "usable" time against. */
export const USABLE_ALTITUDE = 30

// Ecliptic → equatorial, degrees in and out.
function toEquatorial(lonDeg: number, latDeg: number, d: number): SkyPosition {
  const e = (23.439 - 0.0000004 * d) * RAD, l = lonDeg * RAD, b = latDeg * RAD
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l)) / RAD
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l)) / RAD
  return { ra: norm360(ra), dec }
}

function altitudeOf(haDeg: number, decDeg: number, latDeg: number): number {
  const s = Math.sin(latDeg * RAD) * Math.sin(decDeg * RAD)
    + Math.cos(latDeg * RAD) * Math.cos(decDeg * RAD) * Math.cos(haDeg * RAD)
  return Math.asin(Math.max(-1, Math.min(1, s))) / RAD
}

/** Great-circle separation in degrees (haversine — stable at small angles). */
export function separationDeg(a: SkyPosition, b: SkyPosition): number {
  const dDec = (b.dec - a.dec) * RAD, dRa = (b.ra - a.ra) * RAD
  const h = Math.sin(dDec / 2) ** 2 + Math.cos(a.dec * RAD) * Math.cos(b.dec * RAD) * Math.sin(dRa / 2) ** 2
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) / RAD
}

/**
 * The evening on which the next (or current) astronomical night begins. The
 * local clock stands in for solar time here — it can be an hour or so out, which
 * only matters in the hour around dawn.
 */
export function upcomingNightEvening(latDeg: number, now: Date = new Date()): Date {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (now.getHours() >= 12) return today
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const dawnHour = astronomicalDarknessHours(yesterday, latDeg) / 2
  const hoursPastMidnight = (now.getTime() - today.getTime()) / 3600_000
  return hoursPastMidnight < dawnHour ? yesterday : today
}

export interface NightSky {
  /** Evening the night begins on. */
  evening: Date
  darkHours: number
  /** Object altitude at the start and end of darkness, and its peak within it. */
  altStart: number
  altEnd: number
  altMax: number
  /** Where in the night the peak falls, 0 (dusk) to 1 (dawn). */
  altMaxAt: number
  hoursAboveUsable: number
  /** Moon at the middle of the night. */
  moonSeparation: number
  moonIllumination: number
  moonUpHours: number
  /** Samples across darkness, for the sparkline: [0..1 through the night, object alt, moon alt]. */
  track: [number, number, number][]
}

/**
 * How an object sits in astronomical darkness on the night beginning `evening`.
 * Needs no longitude: darkness is a range of the Sun's hour angle, and every
 * other body's hour angle is the Sun's plus the RA difference, so altitudes over
 * the dark hours follow from latitude alone. Longitude would only turn them into
 * clock times, which this deliberately doesn't report. Returns null when the Sun
 * never reaches −18°.
 *
 * Precision is a degree or so — mean J2000 coordinates, low-order Sun and Moon
 * series, the local clock standing in for solar time when placing the Moon —
 * which is far finer than the "is it high, is the Moon near" question needs.
 */
export function nightSky(target: SkyPosition, latDeg: number, evening: Date): NightSky | null {
  const darkHours = astronomicalDarknessHours(evening, latDeg)
  if (darkHours <= 0) return null
  const midnight = new Date(evening.getFullYear(), evening.getMonth(), evening.getDate() + 1).getTime()
  const steps = Math.max(12, Math.round(darkHours * 12)) // every 5 minutes
  const stepHours = darkHours / steps

  const track: [number, number, number][] = []
  let altMax = -90, altMaxAt = 0, above = 0, moonUp = 0
  let moonSeparation = 0, moonIllumination = 0
  for (let i = 0; i <= steps; i++) {
    const offsetHours = -darkHours / 2 + i * stepHours
    const d = daysSinceJ2000(new Date(midnight + offsetHours * 3600_000))
    const { sunLon, moonLon, moonLat } = sunMoonPositions(d)
    const sun = toEquatorial(sunLon, 0, d)
    const moon = toEquatorial(moonLon, moonLat, d)
    // Local sidereal time from the Sun: its hour angle is 180° at solar midnight.
    const lst = 180 + offsetHours * 15 + sun.ra
    const alt = altitudeOf(lst - target.ra, target.dec, latDeg)
    const geoMoonAlt = altitudeOf(lst - moon.ra, moon.dec, latDeg)
    const moonAlt = geoMoonAlt - 0.95 * Math.cos(geoMoonAlt * RAD) // lunar parallax

    const f = i / steps
    track.push([f, alt, moonAlt])
    if (alt > altMax) { altMax = alt; altMaxAt = f }
    // Trapezoid weights: each sample owns one step, the two ends half each.
    const weight = (i === 0 || i === steps) ? stepHours / 2 : stepHours
    if (alt >= USABLE_ALTITUDE) above += weight
    if (moonAlt > 0) moonUp += weight
    if (i === Math.round(steps / 2)) {
      moonSeparation = separationDeg(target, moon)
      const elong = norm360(moonLon - sunLon)
      moonIllumination = (1 - Math.cos(moonLat * RAD) * Math.cos(elong * RAD)) / 2
    }
  }

  return {
    evening, darkHours,
    altStart: track[0][1], altEnd: track[track.length - 1][1], altMax, altMaxAt,
    hoursAboveUsable: above,
    moonSeparation, moonIllumination, moonUpHours: moonUp,
    track,
  }
}

/** Moon phase at `date` (default: now), computed locally. */
export function moonPhase(date: Date = new Date()): MoonPhase {
  const d = daysSinceJ2000(date)
  const { sunLon, moonLon, moonLat } = sunMoonPositions(d)

  // Elongation of the Moon east of the Sun: 0° at new, 180° at full.
  const elongation = norm360(moonLon - sunLon)
  // True angular separation, then the standard illuminated-fraction relation.
  const cosPsi = Math.cos(moonLat * RAD) * Math.cos(elongation * RAD)
  const illumination = (1 - cosPsi) / 2
  const age = elongation / 360

  // First guess from the mean rate, then Newton-style corrections against the
  // real elongation; three passes settle to within minutes.
  let t = d + ((360 - elongation) % 360) / 360 * SYNODIC_DAYS
  for (let i = 0; i < 3; i++) {
    const p = sunMoonPositions(t)
    const e = norm360(p.moonLon - p.sunLon)
    const signed = e > 180 ? e - 360 : e // degrees past new, negative if before
    t -= (signed / 360) * SYNODIC_DAYS
  }

  return {
    illumination,
    age,
    waxing: elongation < 180,
    name: phaseName(age),
    daysToNewMoon: Math.max(0, Math.round(t - d)),
  }
}
