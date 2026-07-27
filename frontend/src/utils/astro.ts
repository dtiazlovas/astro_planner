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
