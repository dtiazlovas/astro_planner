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
