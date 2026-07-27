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
  seconds: number
  count: number
  sessions: ApSession[]
}

interface MonthAgg {
  key: string
  date: Date
  used: number   // seconds imaged
  missed: number // seconds of astronomical darkness on imaged nights left unused
}

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
      const n = map.get(k) ?? { date, seconds: 0, count: 0, sessions: [] }
      n.seconds += Number(s.calculated_seconds) || 0
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

  // Per-month totals across every month present in the data: imaging time and
  // the astronomical darkness on those imaged nights that went unused.
  const months = useMemo(() => {
    const map = new Map<string, MonthAgg>()
    for (const n of nights.values()) {
      const mk = `${n.date.getFullYear()}-${pad(n.date.getMonth() + 1)}`
      const darkSec = astronomicalDarknessHours(n.date, latitude) * 3600
      const m = map.get(mk) ?? { key: mk, date: new Date(n.date.getFullYear(), n.date.getMonth(), 1), used: 0, missed: 0 }
      m.used += n.seconds
      m.missed += Math.max(0, darkSec - n.seconds)
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
    <div className="objects-page">
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
  const maxTotal = Math.max(1, ...months.map(m => m.used + m.missed))
  return (
    <div className="cal-months">
      <div className="cal-months__head">
        <span className="cal-months__title">Monthly dark-time usage — {formatLatitude(lat)}</span>
        <span className="cal-months__legend">
          <span className="cal-legend"><span className="cal-legend__swatch cal-legend__swatch--used" /> Imaged</span>
          <span className="cal-legend"><span className="cal-legend__swatch cal-legend__swatch--missed" /> Missed dark</span>
        </span>
      </div>
      <div className="cal-months__bars">
        {months.map((m, i) => {
          const total = m.used + m.missed
          const usedPct = (m.used / maxTotal) * 100
          const missedPct = (m.missed / maxTotal) * 100
          const pct = total > 0 ? Math.round(m.used / total * 100) : 0
          const showYear = i === 0 || m.date.getFullYear() !== months[i - 1].date.getFullYear()
          return (
            <button key={m.key} className={`cal-month-col ${m.key === selectedKey ? 'cal-month-col--selected' : ''}`}
              onClick={() => onPick(m.date)}
              title={`${m.date.toLocaleString(undefined, { month: 'long', year: 'numeric' })} · ${fmtDur(m.used)} imaged · ${fmtDur(m.missed)} missed dark · ${pct}% used`}>
              <span className="cal-month-col__track">
                <span className="cal-month-col__missed" style={{ height: `${missedPct}%` }} />
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
  return (
    <div className="cal-summary">
      <div className="cal-stat"><span className="cal-stat__value">{nights.length}</span><span className="cal-stat__label">night{nights.length !== 1 ? 's' : ''}</span></div>
      <div className="cal-stat"><span className="cal-stat__value">{totalSessions}</span><span className="cal-stat__label">session{totalSessions !== 1 ? 's' : ''}</span></div>
      <div className="cal-stat"><span className="cal-stat__value">{fmtDur(totalSeconds)}</span><span className="cal-stat__label">integration</span></div>
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
        {cells.map(d => {
          const n = nights.get(keyOf(d))
          const inMonth = d.getMonth() === cursor.getMonth()
          const darkH = astronomicalDarknessHours(d, lat)
          const pct = n && darkH > 0 ? Math.round((n.seconds / 3600) / darkH * 100) : 0
          const fillPct = Math.min(100, pct) // clamp: a night can't exceed its darkness
          const title = n
            ? `${fmtDur(n.seconds)} imaged · ${pct}% of ${fmtDur(darkH * 3600)} astronomical dark (${formatLatitude(lat)}) · ${n.count} session${n.count !== 1 ? 's' : ''}`
            : `No sessions · ${fmtDur(darkH * 3600)} astronomical dark`
          return (
            <div
              key={keyOf(d)}
              className={`cal-cell ${inMonth ? '' : 'cal-cell--out'} ${sameDay(d, today) ? 'cal-cell--today' : ''}`}
              title={title}
            >
              {n && fillPct < 100 && <span className="cal-cell__missed" style={{ height: `${100 - fillPct}%` }} />}
              {n && <span className="cal-cell__fill" style={{ height: `${fillPct}%` }} />}
              <span className="cal-cell__top">
                <span className="cal-cell__num">{d.getDate()}</span>
                {n && <span className="cal-cell__count">{n.count}●</span>}
              </span>
              {n && (
                <span className="cal-cell__body">
                  <span className="cal-cell__dur">{fmtDur(n.seconds)}</span>
                  <span className="cal-cell__pct" title={`${pct}% of ${fmtDur(darkH * 3600)} astronomical darkness`}>
                    {pct}% dark
                  </span>
                </span>
              )}
            </div>
          )
        })}
      </div>
      <p className="cal-caption">
        Each cell is one night's astronomical darkness (Sun below −18°) at {formatLatitude(lat)}:
        the <strong>bright column</strong> is the share spent imaging, the <strong className="cal-caption__missed">dim band</strong> above it the darkness that went unused. Hover for details.
      </p>
    </>
  )
}
