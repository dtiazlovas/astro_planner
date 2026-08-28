import { useEffect, useState } from 'react'
import { moonPhase } from '../utils/astro'

const SIZE = 16
const R = SIZE / 2 - 1
const C = SIZE / 2

/**
 * The lit part of the disc: a half-circle limb closed by the terminator, which
 * projects as a half-ellipse whose width tracks the illuminated fraction. Drawn
 * waxing (lit on the right) and mirrored for a waning moon.
 */
function litPath(illumination: number): string | null {
  if (illumination <= 0.01) return null
  if (illumination >= 0.99) return `M ${C} ${C - R} A ${R} ${R} 0 0 1 ${C} ${C + R} A ${R} ${R} 0 0 1 ${C} ${C - R} Z`
  const rx = R * Math.abs(1 - 2 * illumination)
  // Continuing clockwise (sweep 1) carries the terminator around the dark limb
  // for a gibbous moon; reversing it (sweep 0) bows the terminator back into the
  // lit half, leaving a crescent.
  const sweep = illumination < 0.5 ? 0 : 1
  return `M ${C} ${C - R} A ${R} ${R} 0 0 1 ${C} ${C + R} A ${rx} ${R} 0 0 ${sweep} ${C} ${C - R} Z`
}

export default function MoonPhase() {
  // Recomputed hourly so a window left open overnight doesn't go stale.
  const [phase, setPhase] = useState(() => moonPhase())
  useEffect(() => {
    const id = setInterval(() => setPhase(moonPhase()), 3600_000)
    return () => clearInterval(id)
  }, [])

  const pct = Math.round(phase.illumination * 100)
  const lit = litPath(phase.illumination)
  const newMoon = phase.daysToNewMoon === 0
    ? 'new moon today'
    : `new moon in ${phase.daysToNewMoon} day${phase.daysToNewMoon === 1 ? '' : 's'}`

  return (
    <span className="moon-phase" title={`${phase.name} — ${pct}% illuminated · ${newMoon}`}>
      <span className="moon-phase__label">
        <svg className="moon-phase__glyph" width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <circle cx={C} cy={C} r={R} fill="#15152a" stroke="#33334f" strokeWidth="1" />
          {lit && (
            <path
              d={lit}
              fill="#e2e8f0"
              transform={phase.waxing ? undefined : `translate(${SIZE},0) scale(-1,1)`}
            />
          )}
        </svg>
        <span className="moon-phase__name">{phase.name}</span>
      </span>
      <span className="moon-phase__pct">{pct}%</span>
    </span>
  )
}
