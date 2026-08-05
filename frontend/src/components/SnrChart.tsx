import { useEffect, useId, useMemo, useRef, useState } from 'react'

export interface SnrPoint {
  fileName: string
  snr: number
  /** epoch ms used for left-to-right ordering (capture time) */
  time: number
  /** not yet measured — drawn as a faint baseline marker, excluded from counts */
  pending?: boolean
}

interface Props {
  points: SnrPoint[]
  threshold: number
  onThresholdChange: (value: number) => void
  /** axis / tooltip label for the plotted metric */
  metricLabel?: string
  /** which side of the threshold is approved: 'above' (default, e.g. PSFSW) or 'below' (e.g. FWHM) */
  goodDirection?: 'above' | 'below'
  /**
   * Values (same units as `points.snr`) from previously-analyzed subs of the
   * same target/filter — different files. Rendered as a background density
   * gradient so the new frames can be read against the historical spread.
   */
  historical?: number[]
  /** When true (e.g. while analysis is still streaming), the threshold handle can't be dragged. */
  disabled?: boolean
  /**
   * When supplied, subs become clickable: the chart asks for confirmation and
   * then calls this. Rejecting with an Error shows its message in the dialog.
   */
  onOpenFile?: (point: SnrPoint) => Promise<void> | void
}

const H = 300
const M = { top: 16, right: 40, bottom: 28, left: 46 }

const APPROVED = '#4ade80'
const REJECTED = '#6b7280'
const LINE = '#f59e0b'
const BAND = '#818cf8'

export default function SnrChart({ points, threshold, onThresholdChange, metricLabel = 'PSFSW', goodDirection = 'above', historical, disabled = false, onOpenFile }: Props) {
  const isApproved = (v: number) => goodDirection === 'above' ? v >= threshold : v <= threshold
  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  // SVG geometry captured at drag start. Using a fixed rect for the whole
  // gesture stops layout shifts mid-drag (e.g. cull controls appearing and
  // resizing/recentering the surrounding modal) from feeding back into the
  // computed value and rubber-banding the handle.
  const dragRectRef = useRef<{ top: number; height: number } | null>(null)
  const [w, setW] = useState(720)
  const [dragging, setDragging] = useState(false)
  /** index into `sorted` of the sub under the cursor, null when not hovering */
  const [hover, setHover] = useState<number | null>(null)
  /** last cursor x in SVG user units — kept in a ref so re-snapping costs no render */
  const hoverXRef = useRef<number | null>(null)
  const [confirmOpen, setConfirmOpen] = useState<SnrPoint | null>(null)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => setW(Math.max(320, entries[0].contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Points arrive already sorted by time; x is just the capture order.
  const sorted = useMemo(() => [...points].sort((a, b) => a.time - b.time), [points])
  const hist = useMemo(() => (historical ?? []).filter(v => v != null && isFinite(v)), [historical])
  const bandId = useId()

  const plotW = Math.max(60, w - M.left - M.right)
  const plotH = H - M.top - M.bottom

  const yMax = useMemo(() => {
    const max = Math.max(threshold, ...sorted.map(p => p.snr), ...hist, 1)
    return max * 1.1
  }, [sorted, threshold, hist])
  const yMin = 0

  const xFor = (i: number) => M.left + (sorted.length <= 1 ? plotW / 2 : (i / (sorted.length - 1)) * plotW)
  const yFor = (v: number) => M.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH
  const yToValue = (py: number) => {
    const v = yMin + ((M.top + plotH - py) / plotH) * (yMax - yMin)
    return Math.max(yMin, Math.min(yMax, v))
  }

  const thY = yFor(threshold)
  const measured = sorted.filter(p => !p.pending)
  const pendingCount = sorted.length - measured.length
  const approvedCount = measured.filter(p => isApproved(p.snr)).length
  // Indexed lookup, so a stale index from a shrinking series just clears the hover.
  const hoverPoint = hover != null ? sorted[hover] ?? null : null

  const idxAt = (ux: number) => {
    const t = sorted.length <= 1 ? 0 : ((ux - M.left) / plotW) * (sorted.length - 1)
    return Math.max(0, Math.min(sorted.length - 1, Math.round(t)))
  }

  // Points stream in while analysis runs, which re-spreads every x position. Without
  // this the crosshair would drift away from a stationary cursor until the next move.
  useEffect(() => {
    const ux = hoverXRef.current
    if (ux == null || !sorted.length) return
    const i = idxAt(ux)
    setHover(h => h === i ? h : i)
  }, [sorted.length, plotW]) // eslint-disable-line react-hooks/exhaustive-deps

  // Kernel-density gradient stops for the historical spread. Offset runs 0→1
  // top→bottom of the plot (high→low value), opacity tracks relative density.
  const densityStops = useMemo(() => {
    if (hist.length < 2) return null
    const N = 28
    const range = yMax - yMin || 1
    const bw = Math.max(range * 0.04, 0.02)
    const dens: number[] = []
    let maxD = 0
    for (let i = 0; i <= N; i++) {
      const v = yMax - (i / N) * range
      let d = 0
      for (const x of hist) { const z = (v - x) / bw; d += Math.exp(-0.5 * z * z) }
      dens.push(d)
      if (d > maxD) maxD = d
    }
    return dens.map((d, i) => ({ offset: i / N, opacity: maxD > 0 ? d / maxD : 0 }))
  }, [hist, yMax])

  const histMedian = useMemo(() => {
    if (!hist.length) return null
    const s = [...hist].sort((a, b) => a - b)
    return s[s.length >> 1]
  }, [hist])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      const rect = dragRectRef.current
      if (!rect) return
      // The SVG scales to its box, so convert client px to SVG user units.
      // rect is fixed at drag start so mid-drag layout shifts don't feed back.
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
        <span><span className="snr-dot" style={{ background: REJECTED }} /> Rejected · {measured.length - approvedCount}</span>
        {pendingCount > 0 && (
          <span><span className="snr-dot" style={{ background: 'transparent', border: `1px solid ${REJECTED}` }} /> Pending · {pendingCount}</span>
        )}
        {hist.length > 0 && (
          <span><span className="snr-dot" style={{ background: BAND }} /> Past subs · {hist.length}</span>
        )}
        <span className="snr-chart__threshold-label">{metricLabel} {goodDirection === 'above' ? '≥' : '≤'} {threshold.toFixed(2)}</span>
      </div>
      <svg ref={svgRef} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} style={{ touchAction: 'none', userSelect: 'none' }}>
        {/* historical density band (behind everything) */}
        {densityStops && (
          <>
            <defs>
              <linearGradient id={bandId} x1="0" y1={M.top} x2="0" y2={M.top + plotH} gradientUnits="userSpaceOnUse">
                {densityStops.map((s, i) => (
                  <stop key={i} offset={s.offset} stopColor={BAND} stopOpacity={s.opacity * 0.4} />
                ))}
              </linearGradient>
            </defs>
            <rect x={M.left} y={M.top} width={plotW} height={plotH} fill={`url(#${bandId})`} />
            {histMedian != null && (
              <line x1={M.left} y1={yFor(histMedian)} x2={M.left + plotW} y2={yFor(histMedian)}
                stroke={BAND} strokeWidth={1} strokeDasharray="2 3" opacity={0.6}>
                <title>{`Past subs median ${metricLabel} ${histMedian.toFixed(3)}`}</title>
              </line>
            )}
          </>
        )}
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

        {/* past subs as a faint ghost series, spread in their own capture order */}
        {hist.map((v, i) => (
          <circle
            key={`hist-${i}`}
            cx={M.left + (hist.length <= 1 ? plotW / 2 : (i / (hist.length - 1)) * plotW)}
            cy={yFor(v)} r={1.6} fill={BAND} opacity={0.4}
          />
        ))}

        {/* threshold line */}
        <line x1={M.left} y1={thY} x2={M.left + plotW} y2={thY} stroke={LINE} strokeWidth={1.5} strokeDasharray="5 4" />

        {/* points — pending ones sit at the worst edge as faint hollow markers
            until measured, then move to their value */}
        {sorted.map((p, i) => p.pending ? (
          <circle
            key={p.fileName}
            cx={xFor(i)} cy={yFor(goodDirection === 'above' ? yMin : yMax)} r={2.5}
            fill="none" stroke={REJECTED} strokeWidth={1} opacity={0.3}
          >
            <title>{`${p.fileName}\n(measuring…)`}</title>
          </circle>
        ) : (
          <circle
            key={p.fileName}
            cx={xFor(i)} cy={yFor(p.snr)} r={3.5}
            fill={isApproved(p.snr) ? APPROVED : REJECTED}
            opacity={isApproved(p.snr) ? 1 : 0.55}
          >
            <title>{`${p.fileName}\n${metricLabel} ${p.snr.toFixed(3)}`}</title>
          </circle>
        ))}

        {/* hover capture over the plot area — snaps to the nearest sub in capture order */}
        <rect
          x={M.left} y={M.top} width={plotW} height={plotH} fill="transparent"
          onPointerMove={e => {
            const svg = svgRef.current
            if (!svg || !sorted.length || dragging) return
            const r = svg.getBoundingClientRect()
            // SVG scales to its box, so convert client px to user units first.
            const ux = ((e.clientX - r.left) / r.width) * w
            hoverXRef.current = ux
            const i = idxAt(ux)
            setHover(h => h === i ? h : i) // same index → React bails out, no re-render
          }}
          onPointerLeave={() => { hoverXRef.current = null; setHover(null) }}
          style={{ cursor: onOpenFile ? 'pointer' : 'default' }}
          onClick={e => {
            const svg = svgRef.current
            if (!onOpenFile || !svg || !sorted.length) return
            // Resolved from the click itself rather than hover state, so a tap
            // that never produced a pointermove still hits the right sub.
            const r = svg.getBoundingClientRect()
            const p = sorted[idxAt(((e.clientX - r.left) / r.width) * w)]
            if (!p) return
            setOpenError(null)
            setConfirmOpen(p)
          }}
        />

        {/* crosshair + readout for the hovered sub (hidden mid-drag) */}
        {hoverPoint && !dragging && (() => {
          const i = hover as number
          const x = xFor(i)
          const py = hoverPoint.pending ? yFor(goodDirection === 'above' ? yMin : yMax) : yFor(hoverPoint.snr)
          const ok = !hoverPoint.pending && isApproved(hoverPoint.snr)
          const name = hoverPoint.fileName.length > 42 ? `…${hoverPoint.fileName.slice(-41)}` : hoverPoint.fileName
          const value = hoverPoint.pending ? 'measuring…' : `${metricLabel} ${hoverPoint.snr.toFixed(3)}`
          const meta = `#${i + 1}/${sorted.length}`
          const line2 = `${value}  ·  ${meta}`
          const hint = onOpenFile ? 'click to open in default app' : null
          // ~6.1px per char at 11px in the default UI font — close enough to size the box.
          const boxW = Math.max(name.length, line2.length, hint?.length ?? 0) * 6.1 + 16
          const boxH = hint ? 53 : 38
          const flip = x + 12 + boxW > M.left + plotW
          const bx = Math.max(M.left + 2, flip ? x - 12 - boxW : x + 12)
          const by = Math.max(M.top + 2, Math.min(M.top + plotH - boxH - 2, py - boxH / 2))
          return (
            <g pointerEvents="none">
              <line x1={x} y1={M.top} x2={x} y2={M.top + plotH} stroke="#ffffff59" strokeWidth={1} strokeDasharray="3 3" />
              <circle cx={x} cy={py} r={6} fill="none" stroke={hoverPoint.pending ? REJECTED : ok ? APPROVED : REJECTED} strokeWidth={1.5} />
              <circle cx={x} cy={py} r={2} fill="#e2e8f0" />
              <rect x={bx} y={by} width={boxW} height={boxH} rx={4} fill="#0f0f1e" fillOpacity={0.96} stroke="#3730a3" />
              <text x={bx + 8} y={by + 15} fontSize="11" fill="#e2e8f0">{name}</text>
              <text x={bx + 8} y={by + 30} fontSize="11">
                <tspan fill={hoverPoint.pending ? '#9ca3af' : ok ? APPROVED : REJECTED}>{value}</tspan>
                <tspan fill="#6b7280">{'  ·  '}{meta}</tspan>
              </text>
              {hint && <text x={bx + 8} y={by + 45} fontSize="10" fill="#6b7280">{hint}</text>}
            </g>
          )
        })()}

        {/* draggable triangle handle on the right edge */}
        <g
          transform={`translate(${M.left + plotW}, ${thY})`}
          style={{ cursor: disabled ? 'default' : 'ns-resize', opacity: disabled ? 0.4 : 1 }}
          onPointerDown={disabled ? undefined : e => {
            e.preventDefault()
            const svg = svgRef.current
            if (svg) { const r = svg.getBoundingClientRect(); dragRectRef.current = { top: r.top, height: r.height } }
            setDragging(true)
          }}
        >
          <polygon points="0,0 16,-8 16,8" fill={LINE} />
          {!disabled && <rect x="0" y="-9" width="22" height="18" fill="transparent" />}
        </g>
      </svg>

      {confirmOpen && (
        <div className="modal-backdrop" onClick={() => { if (!opening) setConfirmOpen(null) }}>
          <div className="modal-dialog" onClick={e => e.stopPropagation()}>
            <div className="modal-dialog__header">
              <span className="modal-dialog__title">Open this sub?</span>
            </div>
            <p style={{ color: '#e2e8f0', margin: 0, wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.85rem' }}>
              {confirmOpen.fileName}
            </p>
            <p className="cell-muted" style={{ fontSize: '0.85rem', margin: 0 }}>
              Opens in the default application for this file type, on the machine running the server.
            </p>
            {openError && <div className="error-banner">{openError}</div>}
            <div className="form-actions">
              <button className="btn btn-primary" onClick={async () => {
                if (!onOpenFile) return
                setOpening(true)
                setOpenError(null)
                try {
                  await onOpenFile(confirmOpen)
                  setConfirmOpen(null)
                } catch (err) {
                  // Kept open so the reason (folder not set, file not found) stays visible.
                  setOpenError(err instanceof Error ? err.message : 'Failed to open the file')
                } finally {
                  setOpening(false)
                }
              }} disabled={opening}>
                {opening ? 'Opening…' : 'Open'}
              </button>
              <button className="btn btn-ghost" onClick={() => setConfirmOpen(null)} disabled={opening}>Cancel</button>
            </div>
          </div>
        </div>
      )}
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
