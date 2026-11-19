import { useMemo, useState } from 'react'
import { nightSky, formatLatitude, USABLE_ALTITUDE, type SkyPosition, type NightSky } from '../utils/astro'

/**
 * Icon on an object card that opens a card on the coming night: the object's
 * altitude through astronomical darkness and how close the Moon sits. Opens on
 * hover or focus, and toggles on click so it also works on touch.
 */
export default function ObjectSky({ position, latitude, evening }: {
  position: SkyPosition
  latitude: number
  evening: Date
}) {
  const [open, setOpen] = useState(false)
  // Cheap (one pass of ~150 samples), but there's no reason to run it for every
  // card on every render — only the one being looked at.
  const sky = useMemo(() => open ? nightSky(position, latitude, evening) : null,
    [open, position.ra, position.dec, latitude, evening.getTime()])

  return (
    <span className="obj-sky" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="obj-sky__btn" aria-expanded={open} aria-label="Tonight's sky for this object"
        onClick={() => setOpen(o => !o)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 19h18" />
          <path d="M5 19a7 7 0 0 1 14 0" strokeDasharray="2 2.6" />
          <path d="M14.5 4.5l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && (
        <div className="obj-sky__card" role="tooltip">
          {sky ? <SkyCard sky={sky} latitude={latitude} />
            : <div className="cal-card__empty">No astronomical darkness tonight at {formatLatitude(latitude)}</div>}
        </div>
      )}
    </span>
  )
}

const deg = (v: number) => `${Math.round(v)}°`
const hrs = (h: number) => `${h.toFixed(1)}h`

function SkyCard({ sky, latitude }: { sky: NightSky; latitude: number }) {
  const heading = sky.evening.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const moonPct = Math.round(sky.moonIllumination * 100)
  const moonDown = sky.moonUpHours < 0.05
  const neverUp = sky.altMax <= 0

  // Rising / transiting / setting, from where the peak falls in the night.
  const shape = neverUp ? 'below the horizon all night'
    : sky.altMaxAt <= 0.02 ? 'sinking all night'
    : sky.altMaxAt >= 0.98 ? 'rising all night'
    : `peaks ${hrs(sky.altMaxAt * sky.darkHours)} into darkness`

  return (
    <>
      <div className="cal-card__head">
        <span className="cal-card__date">Night of {heading}</span>
        <span className="cal-card__sessions">{hrs(sky.darkHours)} dark</span>
      </div>
      <Sparkline sky={sky} />
      <div className="cal-card__rows">
        <div className="cal-card__row">
          <span className="cal-card__label">Altitude</span>
          <span className="cal-card__value">
            {neverUp ? '—' : <>{deg(sky.altStart)} → <span className="obj-sky__peak">{deg(sky.altMax)}</span> → {deg(sky.altEnd)}</>}
          </span>
          <span className="cal-card__note">dusk → peak → dawn · {shape}</span>
        </div>
        <div className="cal-card__row">
          <span className="cal-card__label">Above {USABLE_ALTITUDE}°</span>
          <span className="cal-card__value">{hrs(sky.hoursAboveUsable)}</span>
          <span className="cal-card__note">of {hrs(sky.darkHours)} astronomical dark</span>
        </div>
        <div className="cal-card__row">
          <span className="cal-card__label">Moon distance</span>
          <span className="cal-card__value obj-sky__moon">{deg(sky.moonSeparation)}</span>
          <span className="cal-card__note">
            {moonPct}% lit · {moonDown ? 'below the horizon all darkness' : `up ${hrs(sky.moonUpHours)} of darkness`}
          </span>
        </div>
      </div>
      <div className="cal-card__foot">At {formatLatitude(latitude)} · Moon distance at mid-darkness</div>
    </>
  )
}

const W = 228, H = 54

/** Object (solid) and Moon (dashed) altitude across darkness, 0–90°, with the usable line. */
function Sparkline({ sky }: { sky: NightSky }) {
  const x = (f: number) => (f * W).toFixed(1)
  const y = (alt: number) => (H - Math.max(0, Math.min(90, alt)) / 90 * H).toFixed(1)
  const pts = (i: 1 | 2) => sky.track.map(s => `${x(s[0])},${y(s[i])}`).join(' ')
  return (
    <svg className="obj-sky__spark" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2={W} y1={y(USABLE_ALTITUDE)} y2={y(USABLE_ALTITUDE)} className="obj-sky__usable" />
      <polyline points={pts(2)} className="obj-sky__moon-line" />
      <polyline points={pts(1)} className="obj-sky__obj-line" />
    </svg>
  )
}
