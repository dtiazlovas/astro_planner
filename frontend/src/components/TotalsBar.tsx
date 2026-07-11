import { useEffect, useState } from 'react'
import { getAllFilterStats } from '../api'
import type { ObjectFilterStat } from '../types'
import { useEquipment } from '../context/EquipmentContext'
import FilterBadge from './FilterBadge'

const fmtDuration = (s: number): string => {
  if (s <= 0) return '—'
  return `${Math.round(s / 3600)}h`
}

// `refreshKey` changes (e.g. on page navigation) trigger a refetch so totals
// stay current after imports/edits without a global store.
export default function TotalsBar({ refreshKey }: { refreshKey?: string | number }) {
  const { activeId } = useEquipment()
  const [stats, setStats] = useState<ObjectFilterStat[]>([])

  useEffect(() => {
    let cancelled = false
    getAllFilterStats(activeId).then(s => { if (!cancelled) setStats(s) }).catch(() => { if (!cancelled) setStats([]) })
    return () => { cancelled = true }
  }, [activeId, refreshKey])

  const shown = stats.filter(s => s.total_seconds > 0)
  // Display preference: Luminance and Sulphur trade places in the
  // total-time ordering coming from the API.
  const iL = shown.findIndex(s => s.filter_name === 'Luminance')
  const iS = shown.findIndex(s => s.filter_name === 'Sulphur')
  if (iL !== -1 && iS !== -1) [shown[iL], shown[iS]] = [shown[iS], shown[iL]]
  if (!shown.length) return null

  const grand = shown.reduce((n, s) => n + s.total_seconds, 0)

  return (
    <div className="totals-bar">
      <span className="totals-bar__label">Totals</span>
      <div className="totals-bar__items">
        {shown.map(s => (
          <span key={s.filter_name ?? 'none'} className="totals-bar__item"
            style={s.filter_name === 'Luminance' ? { margin: '0 0.5rem' } : undefined}>
            <FilterBadge name={s.filter_name} />
            <span className="totals-bar__time">{fmtDuration(s.total_seconds)}</span>
          </span>
        ))}
      </div>
      <span className="totals-bar__grand" title="Total integration time across all filters">Σ {fmtDuration(grand)}</span>
    </div>
  )
}
