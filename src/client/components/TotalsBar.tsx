import { useEffect, useState } from 'react'
import { getAllFilterStats } from '../api'
import type { ObjectFilterStat } from '../types'
import { useEquipment } from '../context/EquipmentContext'
import FilterBadge from './FilterBadge'
import MoonPhase from './MoonPhase'

const fmtDuration = (s: number): string => {
  if (s <= 0) return '—'
  return `${Math.round(s / 3600)}h`
}

// The bar and the header summary want the same numbers and mount together, so
// whichever asks second reuses the first one's request instead of firing a
// duplicate. Only the latest key is held.
let inFlight: { key: string; promise: Promise<ObjectFilterStat[]> } | null = null

function loadStats(activeId: number | null, refreshKey?: string | number): Promise<ObjectFilterStat[]> {
  const key = `${activeId}|${refreshKey}`
  if (inFlight?.key !== key) {
    inFlight = { key, promise: getAllFilterStats(activeId).catch((): ObjectFilterStat[] => []) }
  }
  return inFlight.promise
}

// `refreshKey` changes (e.g. on page navigation) trigger a refetch so totals
// stay current after imports/edits without a global store.
function useFilterStats(refreshKey?: string | number) {
  const { activeId } = useEquipment()
  const [stats, setStats] = useState<ObjectFilterStat[]>([])

  useEffect(() => {
    let cancelled = false
    loadStats(activeId, refreshKey).then(s => { if (!cancelled) setStats(s) })
    return () => { cancelled = true }
  }, [activeId, refreshKey])

  const shown = stats.filter(s => s.total_seconds > 0)
  // Display preference: Luminance and Sulphur trade places in the
  // total-time ordering coming from the API.
  const iL = shown.findIndex(s => s.filter_name === 'Luminance')
  const iS = shown.findIndex(s => s.filter_name === 'Sulphur')
  if (iL !== -1 && iS !== -1) [shown[iL], shown[iS]] = [shown[iS], shown[iL]]

  return { shown, grand: shown.reduce((n, s) => n + s.total_seconds, 0) }
}

function Grand({ seconds, className }: { seconds: number; className: string }) {
  return <span className={className} title="Total integration time across all filters">Σ {fmtDuration(seconds)}</span>
}

/**
 * Grand total and moon phase, sitting beside the rig selector. This is the
 * narrow-layout home for both: the rail carries them itself from 900px up, and
 * CSS hides whichever copy doesn't belong at the current width.
 */
export function TotalsSummary({ refreshKey }: { refreshKey?: string | number }) {
  const { grand } = useFilterStats(refreshKey)

  return (
    <div className="totals-summary">
      {grand > 0 && <Grand seconds={grand} className="totals-summary__grand" />}
      <MoonPhase />
    </div>
  )
}

export default function TotalsBar({ refreshKey }: { refreshKey?: string | number }) {
  const { shown, grand } = useFilterStats(refreshKey)
  const empty = shown.length === 0

  // Rendered even when empty so the rail still has its moon; below the rail
  // breakpoint that leaves nothing to show and CSS drops the bar entirely.
  return (
    <div className={`totals-bar${empty ? ' totals-bar--empty' : ''}`}>
      {!empty && (
        <>
          <span className="totals-bar__label">Totals</span>
          <div className="totals-bar__items">
            {shown.map(s => (
              <span key={s.filter_name ?? 'none'} className="totals-bar__item">
                <FilterBadge name={s.filter_name} />
                <span className="totals-bar__time">{fmtDuration(s.total_seconds)}</span>
              </span>
            ))}
          </div>
          <Grand seconds={grand} className="totals-bar__grand" />
        </>
      )}
      <MoonPhase />
    </div>
  )
}
