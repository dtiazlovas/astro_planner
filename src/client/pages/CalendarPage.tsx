import { useState, useEffect, useMemo } from 'react'
import { getSessions } from '../api'
import type { ApSession } from '../types'
import { useEquipment } from '../context/EquipmentContext'
import { fetchDayStartHour } from '../utils/filePattern'
import { astronomicalDarknessHours, fetchLatitude, formatLatitude, DEFAULT_LATITUDE } from '../utils/astro'

const pad = (n: number) => String(n).padStart(2, '0')

// Integration time, compact ("2h 15m" / "45m" / "—").
const fmtDur = (seconds: number): string => {
  if (seconds <= 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`
}

// The observing night a session belongs to: shift by day_start_hour (default
// 16:00) so frames captured after midnight fall under the previous evening —
// the same convention the importer uses to group frames into sessions.
const nightDate = (iso: string, dayStartHour: number): Date => {
  const d = new Date(iso)
  const shifted = new Date(d.getTime() - dayStartHour * 3600000)
  return new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate())
}
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const sameDay = (a: Date, b: Date) => keyOf(a) === keyOf(b)

// Monday-based start of the week containing d (local midnight) — used to align
// the month grid's leading row.
const startOfWeek = (d: Date): Date => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dow = (x.getDay() + 6) % 7 // Mon = 0 … Sun = 6
  x.setDate(x.getDate() - dow)
  return x
}
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

interface Night {
  date: Date
  seconds: number       // exposure kept
  culledSeconds: number // exposure shot and then thrown away
  count: number
  frames: number // subs kept
  culled: number // subs measured, rejected and deleted
  sessions: ApSession[]
}

interface MonthAgg {
  key: string
  date: Date
  used: number   // seconds imaged
  culled: number // seconds spent on subs that were culled
  missed: number // darkness on imaged nights that was never exposed at all
  frames: number
  culledFrames: number
}

// Share of a night's shot subs that were thrown away, as a whole percent.
const cullPct = (kept: number, culled: number): number => {
  const shot = kept + culled
  return shot > 0 ? Math.round(culled / shot * 100) : 0
}

// "12 subs culled (1h 0m) · 8% of 154 shot" — the phrase every cull tooltip uses.
const cullText = (kept: number, culled: number, culledSeconds: number): string =>
  `${culled} sub${culled !== 1 ? 's' : ''} culled${culledSeconds > 0 ? ` (${fmtDur(culledSeconds)})` : ''} · ${cullPct(kept, culled)}% of ${kept + culled} shot`

export default function CalendarPage() {
  const { activeId } = useEquipment()
  const [sessions, setSessions] = useState<ApSession[]>([])
  const [dayStartHour, setDayStartHour] = useState(16)
  const [latitude, setLatitude] = useState(DEFAULT_LATITUDE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Cursor is the first of the displayed month.
  const [cursor, setCursor] = useState<Date>(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })

  useEffect(() => {
    setLoading(true)
    Promise.all([getSessions(activeId), fetchDayStartHour(), fetchLatitude()])
      .then(([s, dsh, lat]) => { setSessions(s); setDayStartHour(dsh); setLatitude(lat) })
      .catch(() => setError('Failed to load calendar data'))
      .finally(() => setLoading(false))
  }, [activeId])

  // Bucket every session into its observing night.
  const nights = useMemo(() => {
    const map = new Map<string, Night>()
    for (const s of sessions) {
      if (!s.start) continue
      const date = nightDate(s.start, dayStartHour)
      const k = keyOf(date)
      const n = map.get(k) ?? { date, seconds: 0, culledSeconds: 0, count: 0, frames: 0, culled: 0, sessions: [] }
      n.seconds += Number(s.calculated_seconds) || 0
      n.culledSeconds += Number(s.culled_seconds) || 0
      n.frames += Number(s.frames) || 0
      n.culled += Number(s.culled_frames) || 0
      n.count += 1
      n.sessions.push(s)
      map.set(k, n)
    }
    return map
  }, [sessions, dayStartHour])

  const nightsIn = (from: Date, toExclusive: Date): Night[] =>
    [...nights.values()]
      .filter(n => n.date >= from && n.date < toExclusive)
      .sort((a, b) => a.date.getTime() - b.date.getTime())

  // Per-month totals across every month present in the data: imaging time, the
  // exposure culled out of it, and the astronomical darkness on those imaged
  // nights that went unused. The three are disjoint slices of the same
  // darkness, so culled time comes out of the unused share, not the kept one.
  const months = useMemo(() => {
    const map = new Map<string, MonthAgg>()
    for (const n of nights.values()) {
      const mk = `${n.date.getFullYear()}-${pad(n.date.getMonth() + 1)}`
      const darkSec = astronomicalDarknessHours(n.date, latitude) * 3600
      const m = map.get(mk) ?? { key: mk, date: new Date(n.date.getFullYear(), n.date.getMonth(), 1), used: 0, culled: 0, missed: 0, frames: 0, culledFrames: 0 }
      m.used += n.seconds
      m.culled += Math.min(n.culledSeconds, Math.max(0, darkSec - n.seconds))
      m.missed += Math.max(0, darkSec - n.seconds - n.culledSeconds)
      m.frames += n.frames
      m.culledFrames += n.culled
      map.set(mk, m)
    }
    return [...map.values()].sort((a, b) => a.date.getTime() - b.date.getTime())
  }, [nights, latitude])

  const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`

  const goToday = () => {
    const now = new Date()
    setCursor(new Date(now.getFullYear(), now.getMonth(), 1))
  }
  const stepMonth = (dir: 1 | -1) => setCursor(c => new Date(c.getFullYear(), c.getMonth() + dir, 1))

  const monthLabel = cursor.toLocaleString(undefined, { month: 'long', year: 'numeric' })

  return (
    <div className="objects-page calendar-page">
      <div className="page-header">
        <h2>Calendar</h2>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {!loading && months.length > 0 && (
        <MonthsBar months={months} selectedKey={monthKey(cursor)} lat={latitude}
          onPick={d => setCursor(new Date(d.getFullYear(), d.getMonth(), 1))} />
      )}

      <div className="cal-nav">
        <button className="btn btn-ghost" onClick={() => stepMonth(-1)} title="Previous month">‹</button>
        <button className="btn btn-ghost" onClick={goToday}>Today</button>
        <button className="btn btn-ghost" onClick={() => stepMonth(1)} title="Next month">›</button>
        <span className="cal-period-label">{monthLabel}</span>
      </div>

      {loading
        ? <p className="state-msg">Loading…</p>
        : <MonthView cursor={cursor} nights={nights} nightsIn={nightsIn} lat={latitude} />}
    </div>
  )
}

// ── All-months column chart (imaged vs missed dark) ─────────────────
function MonthsBar({ months, selectedKey, lat, onPick }: {
  months: MonthAgg[]; selectedKey: string; lat: number; onPick: (d: Date) => void
}) {
  const maxTotal = Math.max(1, ...months.map(m => m.used + m.culled + m.missed))
  const anyCulled = months.some(m => m.culled > 0 || m.culledFrames > 0)
  return (
    <div className="cal-months">
      <div className="cal-months__head">
        <span className="cal-months__title">Monthly dark-time usage — {formatLatitude(lat)}</span>
        <span className="cal-months__legend">
          <span className="cal-legend"><span className="cal-legend__swatch cal-legend__swatch--used" /> Imaged</span>
          {anyCulled && <span className="cal-legend"><span className="cal-legend__swatch cal-legend__swatch--culled" /> Culled</span>}
          <span className="cal-legend"><span className="cal-legend__swatch cal-legend__swatch--missed" /> Missed dark</span>
        </span>
      </div>
      <div className="cal-months__bars">
        {months.map((m, i) => {
          const total = m.used + m.culled + m.missed
          const usedPct = (m.used / maxTotal) * 100
          const culledPct = (m.culled / maxTotal) * 100
          const missedPct = (m.missed / maxTotal) * 100
          const pct = total > 0 ? Math.round(m.used / total * 100) : 0
          const showYear = i === 0 || m.date.getFullYear() !== months[i - 1].date.getFullYear()
          return (
            <button key={m.key} className={`cal-month-col ${m.key === selectedKey ? 'cal-month-col--selected' : ''}`}
              onClick={() => onPick(m.date)}
              title={`${m.date.toLocaleString(undefined, { month: 'long', year: 'numeric' })} · ${fmtDur(m.used)} imaged · ${fmtDur(m.missed)} missed dark · ${pct}% used${m.culledFrames > 0 ? ` · ${cullText(m.frames, m.culledFrames, m.culled)}` : ''}`}>
              <span className="cal-month-col__track">
                <span className="cal-month-col__missed" style={{ height: `${missedPct}%` }} />
                {culledPct > 0 && <span className="cal-month-col__culled" style={{ height: `${culledPct}%` }} />}
                <span className="cal-month-col__used" style={{ height: `${usedPct}%` }} />
              </span>
              <span className="cal-month-col__label">
                {m.date.toLocaleString(undefined, { month: 'short' })}
                {showYear && <span className="cal-month-col__year">{m.date.getFullYear()}</span>}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Summary strip ───────────────────────────────────────────────────
function Summary({ nights }: { nights: Night[] }) {
  const totalSeconds = nights.reduce((a, n) => a + n.seconds, 0)
  const totalSessions = nights.reduce((a, n) => a + n.count, 0)
  const totalFrames = nights.reduce((a, n) => a + n.frames, 0)
  const totalCulled = nights.reduce((a, n) => a + n.culled, 0)
  const totalCulledSeconds = nights.reduce((a, n) => a + n.culledSeconds, 0)
  return (
    <div className="cal-summary">
      <div className="cal-stat"><span className="cal-stat__value">{nights.length}</span><span className="cal-stat__label">night{nights.length !== 1 ? 's' : ''}</span></div>
      <div className="cal-stat"><span className="cal-stat__value">{totalSessions}</span><span className="cal-stat__label">session{totalSessions !== 1 ? 's' : ''}</span></div>
      <div className="cal-stat"><span className="cal-stat__value">{fmtDur(totalSeconds)}</span><span className="cal-stat__label">integration</span></div>
      <div className="cal-stat"><span className="cal-stat__value">{totalFrames}</span><span className="cal-stat__label">sub{totalFrames !== 1 ? 's' : ''} kept</span></div>
      {/* Hidden when nothing was culled — culling is optional, and a month that
          never used it should not be shown a zero it never earned. */}
      {totalCulled > 0 && (
        <div className="cal-stat cal-stat--culled" title={cullText(totalFrames, totalCulled, totalCulledSeconds)}>
          <span className="cal-stat__value">{totalCulled}</span>
          <span className="cal-stat__label">culled · {fmtDur(totalCulledSeconds)}</span>
        </div>
      )}
    </div>
  )
}

// ── Hover card: one night, spelled out ──────────────────────────────
// Rendered inside every cell and revealed by CSS on hover, so the grid stays
// free of positioning state and nothing re-renders when the pointer moves. The
// rows mirror the bar underneath, swatch for swatch, so the card reads as an
// expansion of the column rather than a separate set of numbers.
function NightCard({ date, night, darkSeconds, lat, usedPct }: {
  date: Date; night: Night | undefined; darkSeconds: number; lat: number; usedPct: number
}) {
  const heading = date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
  const missed = night ? Math.max(0, darkSeconds - night.seconds - night.culledSeconds) : darkSeconds
  return (
    <div className="cal-card" role="tooltip">
      <div className="cal-card__head">
        <span className="cal-card__date">{heading}</span>
        {night && <span className="cal-card__sessions">{night.count} session{night.count !== 1 ? 's' : ''}</span>}
      </div>
      {night ? (
        <div className="cal-card__rows">
          <CardRow swatch="used" label="Imaged" value={fmtDur(night.seconds)} note={`${night.frames} sub${night.frames !== 1 ? 's' : ''}`} />
          {night.culled > 0 && (
            <CardRow swatch="culled" label="Culled" value={fmtDur(night.culledSeconds)}
              note={`${night.culled} sub${night.culled !== 1 ? 's' : ''} · ${cullPct(night.frames, night.culled)}% of ${night.frames + night.culled} shot`} />
          )}
          <CardRow swatch="missed" label="Missed dark" value={fmtDur(missed)} note="never exposed" />
        </div>
      ) : (
        <div className="cal-card__empty">Nothing imaged this night</div>
      )}
      <div className="cal-card__foot">
        {fmtDur(darkSeconds)} astronomical dark at {formatLatitude(lat)}
        {night && ` · ${usedPct}% used`}
      </div>
    </div>
  )
}

function CardRow({ swatch, label, value, note }: { swatch: string; label: string; value: string; note: string }) {
  return (
    <div className={`cal-card__row cal-card__row--${swatch}`}>
      <span className={`cal-card__swatch cal-card__swatch--${swatch}`} />
      <span className="cal-card__label">{label}</span>
      <span className="cal-card__value">{value}</span>
      <span className="cal-card__note">{note}</span>
    </div>
  )
}

// ── Month grid: each cell is a night's darkness budget ──────────────
function MonthView({ cursor, nights, nightsIn, lat }: {
  cursor: Date; nights: Map<string, Night>; nightsIn: (a: Date, b: Date) => Night[]; lat: number
}) {
  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  const gridStart = startOfWeek(monthStart)
  const today = new Date()

  const monthNights = nightsIn(monthStart, monthEnd)
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))

  return (
    <>
      <Summary nights={monthNights} />
      <div className="cal-grid">
        {WEEKDAYS.map(w => <div key={w} className="cal-grid__weekday">{w}</div>)}
        {cells.map((d, i) => {
          const n = nights.get(keyOf(d))
          const inMonth = d.getMonth() === cursor.getMonth()
          const darkH = astronomicalDarknessHours(d, lat)
          const pct = n && darkH > 0 ? Math.round((n.seconds / 3600) / darkH * 100) : 0
          const fillPct = Math.min(100, pct) // clamp: a night can't exceed its darkness
          // The culled band stacks on the kept column and is clamped to what is
          // left of the night, so the two together can never overrun the cell.
          const culledPct = n && darkH > 0
            ? Math.min(100 - fillPct, Math.round((n.culledSeconds / 3600) / darkH * 100))
            : 0
          // The card is placed by the cell it belongs to: it opens downwards on
          // the top row and hugs the grid's edge columns, so it can't be cut off
          // by the top of the page or run off the side.
          const col = i % 7
          const place = [
            i < 7 ? 'cal-cell--pop-below' : '',
            col <= 1 ? 'cal-cell--pop-left' : col >= 5 ? 'cal-cell--pop-right' : '',
          ].join(' ')
          return (
            <div
              key={keyOf(d)}
              className={`cal-cell ${inMonth ? '' : 'cal-cell--out'} ${sameDay(d, today) ? 'cal-cell--today' : ''} ${place}`}
            >
              {n && fillPct + culledPct < 100 && <span className="cal-cell__missed" style={{ height: `${100 - fillPct - culledPct}%` }} />}
              {n && culledPct > 0 && (
                <span className={`cal-cell__culled-bar ${fillPct === 0 ? 'cal-cell__culled-bar--base' : ''}`}
                  style={{ bottom: `${fillPct}%`, height: `${culledPct}%` }} />
              )}
              {n && <span className="cal-cell__fill" style={{ height: `${fillPct}%` }} />}
              <span className="cal-cell__top">
                <span className="cal-cell__num">{d.getDate()}</span>
                {n && <span className="cal-cell__count">{n.count}●</span>}
              </span>
              {n && (
                <span className="cal-cell__body">
                  <span className="cal-cell__dur">{fmtDur(n.seconds)}</span>
                  <span className="cal-cell__pct">{pct}% dark</span>
                </span>
              )}
              <NightCard date={d} night={n} darkSeconds={darkH * 3600} lat={lat} usedPct={pct} />
            </div>
          )
        })}
      </div>
      <p className="cal-caption">
        Each cell is one night's astronomical darkness (Sun below −18°) at {formatLatitude(lat)}:
        the <strong>bright column</strong> is the share spent imaging, the <strong className="cal-caption__culled">red band</strong> above it exposure that was shot and then culled,
        and the <strong className="cal-caption__missed">dim band</strong> on top the darkness that went unused. Hover for details.
      </p>
    </>
  )
}
