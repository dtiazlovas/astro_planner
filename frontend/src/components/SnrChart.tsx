import { useEffect, useMemo, useRef, useState } from 'react'

export interface SnrPoint {
  fileName: string
  snr: number
  /** epoch ms used for left-to-right ordering (capture time) */
  time: number
}

interface Props {
  points: SnrPoint[]
  threshold: number
  onThresholdChange: (value: number) => void
  /** axis / tooltip label for the plotted metric */
  metricLabel?: string
  /** which side of the threshold is approved: 'above' (default, e.g. PSFSW) or 'below' (e.g. FWHM) */
  goodDirection?: 'above' | 'below'
}

const H = 300
const M = { top: 16, right: 40, bottom: 28, left: 46 }

const APPROVED = '#4ade80'
const REJECTED = '#6b7280'
const LINE = '#f59e0b'

export default function SnrChart({ points, threshold, onThresholdChange, metricLabel = 'PSFSW', goodDirection = 'above' }: Props) {
  const isApproved = (v: number) => goodDirection === 'above' ? v >= threshold : v <= threshold
  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [w, setW] = useState(720)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => setW(Math.max(320, entries[0].contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Points arrive already sorted by time; x is just the capture order.
  const sorted = useMemo(() => [...points].sort((a, b) => a.time - b.time), [points])

  const plotW = Math.max(60, w - M.left - M.right)
  const plotH = H - M.top - M.bottom

  const yMax = useMemo(() => {
    const max = Math.max(threshold, ...sorted.map(p => p.snr), 1)
    return max * 1.1
  }, [sorted, threshold])
  const yMin = 0

  const xFor = (i: number) => M.left + (sorted.length <= 1 ? plotW / 2 : (i / (sorted.length - 1)) * plotW)
  const yFor = (v: number) => M.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH
  const yToValue = (py: number) => {
    const v = yMin + ((M.top + plotH - py) / plotH) * (yMax - yMin)
    return Math.max(yMin, Math.min(yMax, v))
  }

  const thY = yFor(threshold)
  const approvedCount = sorted.filter(p => isApproved(p.snr)).length

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      // The SVG scales to its box, so convert client px to SVG user units.
      const py = ((e.clientY - rect.top) / rect.height) * H
      onThresholdChange(Math.round(yToValue(py) * 100) / 100)
    }
    const onUp = () => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, yMax]) // eslint-disable-line react-hooks/exhaustive-deps

  const yTicks = useMemo(() => {
    const ticks: number[] = []
    const step = niceStep(yMax, 5)
    for (let v = 0; v <= yMax; v += step) ticks.push(Math.round(v * 100) / 100)
    return ticks
  }, [yMax])

  return (
    <div ref={wrapRef} className="snr-chart">
      <div className="snr-chart__legend">
        <span><span className="snr-dot" style={{ background: APPROVED }} /> Approved · {approvedCount}</span>
        <span><span className="snr-dot" style={{ background: REJECTED }} /> Rejected · {sorted.length - approvedCount}</span>
        <span className="snr-chart__threshold-label">{metricLabel} {goodDirection === 'above' ? '≥' : '≤'} {threshold.toFixed(2)}</span>
      </div>
      <svg ref={svgRef} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} style={{ touchAction: 'none', userSelect: 'none' }}>
        {/* y grid + labels */}
        {yTicks.map(t => (
          <g key={t}>
            <line x1={M.left} y1={yFor(t)} x2={M.left + plotW} y2={yFor(t)} stroke="#ffffff14" />
            <text x={M.left - 8} y={yFor(t) + 4} textAnchor="end" fontSize="11" fill="#9ca3af">{t}</text>
          </g>
        ))}
        {/* axes */}
        <line x1={M.left} y1={M.top} x2={M.left} y2={M.top + plotH} stroke="#ffffff33" />
        <line x1={M.left} y1={M.top + plotH} x2={M.left + plotW} y2={M.top + plotH} stroke="#ffffff33" />
        <text x={M.left + plotW / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="#9ca3af">Capture order →</text>
        <text x={14} y={M.top + plotH / 2} textAnchor="middle" fontSize="11" fill="#9ca3af" transform={`rotate(-90 14 ${M.top + plotH / 2})`}>{metricLabel}</text>

        {/* threshold line */}
        <line x1={M.left} y1={thY} x2={M.left + plotW} y2={thY} stroke={LINE} strokeWidth={1.5} strokeDasharray="5 4" />

        {/* points */}
        {sorted.map((p, i) => (
          <circle
            key={p.fileName}
            cx={xFor(i)} cy={yFor(p.snr)} r={3.5}
            fill={isApproved(p.snr) ? APPROVED : REJECTED}
            opacity={isApproved(p.snr) ? 1 : 0.55}
          >
            <title>{`${p.fileName}\n${metricLabel} ${p.snr.toFixed(3)}`}</title>
          </circle>
        ))}

        {/* draggable triangle handle on the right edge */}
        <g
          transform={`translate(${M.left + plotW}, ${thY})`}
          style={{ cursor: 'ns-resize' }}
          onPointerDown={e => { e.preventDefault(); setDragging(true) }}
        >
          <polygon points="0,0 16,-8 16,8" fill={LINE} />
          <rect x="0" y="-9" width="22" height="18" fill="transparent" />
        </g>
      </svg>
    </div>
  )
}

function niceStep(max: number, targetTicks: number): number {
  const raw = max / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)))
  const norm = raw / mag
  const step = norm >= 5 ? 5 : norm >= 2 ? 2 : 1
  return Math.max(step * mag, 0.01)
}
