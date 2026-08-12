import { useEffect, useRef, useState, useCallback } from 'react'
import { buildPreviews } from '../utils/blinkPreviews'

const FPS_STEPS = [2, 4, 6, 10, 15, 24]

interface Props {
  /** Shown in the title bar — an object name, or what the batch is. */
  title: string
  /**
   * Frames to step through, in display order. Resolved by the caller: folder
   * permission may need to be re-granted, and that needs the click's transient
   * user activation, which is gone by the time a mount effect runs.
   */
  files: File[]
  /** Grouping label for the cache, used for eviction ordering. */
  scope: string
  /** Frames dropped by eye so far. Omit to hide the cull control entirely. */
  dropped?: Set<string>
  /** Whether the quality limit would drop this frame on its own. */
  belowLine?: (fileName: string) => boolean
  /**
   * Toggles the hand-drop on one frame. Not dropping is not the same as
   * forcing a keep — the quality limit still applies either way.
   */
  onToggleDrop?: (fileName: string) => void
  onClose: () => void
}

/**
 * Flick through a target's subs to spot frame-level problems — trailing,
 * cloud, gradients, satellites, focus drift — the way PixInsight's Blink is
 * used. Previews are downsampled and autostretched once, then cached, so
 * stepping between frames is just an image swap.
 */
export default function BlinkViewer({
  title, files, scope, dropped, belowLine, onToggleDrop, onClose,
}: Props) {
  const [urls, setUrls] = useState<(string | null)[]>([])
  const [ready, setReady] = useState(0)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState(6)
  const [gamma, setGamma] = useState(1)
  const [status, setStatus] = useState('Preparing…')
  const [error, setError] = useState<string | null>(null)

  const total = files.length
  const urlsRef = useRef<(string | null)[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  // ── load: pull cached previews, render the rest ───────────────────
  useEffect(() => {
    const ctrl = new AbortController()
    abortRef.current = ctrl

    ;(async () => {
      try {
        // Switching sets swaps `files`, so start from the first frame rather
        // than an index that may not exist in the new one.
        setIndex(0)
        setPlaying(false)
        urlsRef.current = new Array(files.length).fill(null)
        setUrls(urlsRef.current.slice())
        setReady(0)
        setStatus(files.length ? '' : 'No readable frames')

        let done = 0
        await buildPreviews(scope, files, ({ index: i, blob }) => {
          if (ctrl.signal.aborted) return
          const url = URL.createObjectURL(blob)
          urlsRef.current[i] = url
          done++
          setUrls(urlsRef.current.slice())
          setReady(done)
        }, ctrl.signal)
      } catch (err) {
        if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : 'Blink failed')
      } finally {
        if (!ctrl.signal.aborted) setStatus('')
      }
    })()

    return () => {
      ctrl.abort()
      for (const u of urlsRef.current) if (u) URL.revokeObjectURL(u)
      urlsRef.current = []
    }
  }, [files, scope])

  // Stop the page behind scrolling (and hide its scrollbar) while the overlay
  // owns the window.
  useEffect(() => {
    document.documentElement.classList.add('is-blinking')
    return () => document.documentElement.classList.remove('is-blinking')
  }, [])

  // ── navigation ────────────────────────────────────────────────────
  const step = useCallback((delta: number) => {
    setIndex(i => {
      if (!total) return 0
      return (i + delta + total) % total
    })
  }, [total])

  useEffect(() => {
    if (!playing || total < 2) return
    const id = setInterval(() => step(1), Math.round(1000 / fps))
    return () => clearInterval(id)
  }, [playing, fps, total, step])

  // Dropping moves on to the next frame, so a run can be culled without
  // reaching for the arrows; un-dropping stays put, since you are reconsidering
  // the frame in front of you.
  const toggleDrop = useCallback(() => {
    const f = files[index]
    if (!onToggleDrop || !f) return
    setPlaying(false)
    const wasDropped = dropped?.has(f.name) ?? false
    onToggleDrop(f.name)
    if (!wasDropped) step(1)
  }, [files, index, onToggleDrop, dropped, step])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowRight': case 'j': e.preventDefault(); setPlaying(false); step(1); break
        case 'ArrowLeft':  case 'k': e.preventDefault(); setPlaying(false); step(-1); break
        case ' ':                    e.preventDefault(); setPlaying(p => !p); break
        case 'Home':                 e.preventDefault(); setIndex(0); break
        case 'End':                  e.preventDefault(); setIndex(Math.max(0, total - 1)); break
        case 'Escape':               e.preventDefault(); onClose(); break
        case 'x': case 'X':
        case 'd': case 'D':          e.preventDefault(); toggleDrop(); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, total, onClose, toggleDrop])

  // Follow the cursor down the strip. `nearest` scrolls only when the chip is
  // actually off-screen, so stepping within view doesn't jerk the list.
  useEffect(() => {
    stripRef.current?.querySelector('[data-current]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  // Keep neighbours decoded so stepping doesn't stall on image decode.
  const preload = []
  for (let d = -3; d <= 3; d++) {
    const i = total ? (index + d + total) % total : 0
    const u = urls[i]
    if (d !== 0 && u) preload.push(<link key={`${i}-${d}`} rel="preload" as="image" href={u} />)
  }

  const current = urls[index] ?? null
  const pct = total ? Math.round((ready / total) * 100) : 0

  const currentName = files[index]?.name ?? ''
  const isDropped = dropped?.has(currentName) ?? false
  const isBelowLine = belowLine?.(currentName) ?? false
  // Both are vetoes, so a frame is only imported if neither applies.
  const kept = !isDropped && !isBelowLine
  const droppedCount = files.filter(f => dropped?.has(f.name)).length

  return (
    <div className="blink">
      {/* A real gamma curve rather than CSS brightness — lifts faint signal
          without flattening the highlights. */}
      <svg className="blink__defs" aria-hidden="true">
        <filter id="blink-gamma" colorInterpolationFilters="sRGB">
          <feComponentTransfer>
            <feFuncR type="gamma" exponent={gamma} />
            <feFuncG type="gamma" exponent={gamma} />
            <feFuncB type="gamma" exponent={gamma} />
          </feComponentTransfer>
        </filter>
      </svg>
      {preload}

      <div className="blink__bar">
        <span className="blink__title">Blink — {title}</span>
        {total > 0 && (
          <span className="blink__counter">
            {index + 1} / {total}
            {ready < total && <span className="blink__building"> · building {ready}/{total} ({pct}%)</span>}
          </span>
        )}
        {onToggleDrop && droppedCount > 0 && (
          <span className="blink__tally">
            <span className="blink__tally--drop">{droppedCount} dropped by hand</span>
          </span>
        )}
        <button className="btn btn-ghost blink__close" onClick={onClose} title="Close (Esc)">✕</button>
      </div>

      <div className="blink__body">
        <div className={`blink__stage ${onToggleDrop ? (kept ? 'blink__stage--keep' : 'blink__stage--drop') : ''}`}>
          {error ? (
            <div className="error-banner">{error}</div>
          ) : current ? (
            <img
              className="blink__img"
              src={current}
              alt={currentName}
              style={gamma !== 1 ? { filter: 'url(#blink-gamma)' } : undefined}
            />
          ) : (
            <p className="state-msg">{status || (total ? 'Rendering this frame…' : 'Loading…')}</p>
          )}
        </div>

        {/* Capture order down the side: which subs are in, which are out, and
            where you are in the run. Numbers only — the file names are long,
            near-identical, and say nothing at a glance. */}
        {!error && total > 0 && (
          <div className="blink__strip" ref={stripRef}>
            {files.map((f, i) => {
              const isDrop = dropped?.has(f.name) ?? false
              const isBelow = !isDrop && (belowLine?.(f.name) ?? false)
              const state = isDrop ? 'drop' : isBelow ? 'below' : 'keep'
              return (
                <button
                  key={f.name}
                  data-current={i === index ? '' : undefined}
                  className={[
                    'blink__chip',
                    `blink__chip--${state}`,
                    i === index ? 'blink__chip--current' : '',
                    urls[i] ? '' : 'blink__chip--pending',
                  ].filter(Boolean).join(' ')}
                  onClick={() => { setPlaying(false); setIndex(i) }}
                  title={`${i + 1}. ${f.name}\n${
                    isDrop ? 'dropped by hand' : isBelow ? 'below the limit' : 'kept'
                  }${urls[i] ? '' : ' · preview not built yet'}`}
                >{i + 1}</button>
              )
            })}
          </div>
        )}
      </div>

      {!error && (
        <div className="blink__controls">
          <div className="blink__transport">
            <button className="btn btn-secondary" onClick={() => { setPlaying(false); step(-1) }} title="Previous (←)">‹</button>
            <button className="btn btn-primary" onClick={() => setPlaying(p => !p)} title="Play / pause (Space)">
              {playing ? '❚❚' : '▶'}
            </button>
            <button className="btn btn-secondary" onClick={() => { setPlaying(false); step(1) }} title="Next (→)">›</button>

            <label className="blink__field">
              <span>Speed</span>
              <select className="select-dark" value={fps} onChange={e => setFps(Number(e.target.value))}>
                {FPS_STEPS.map(f => <option key={f} value={f}>{f} fps</option>)}
              </select>
            </label>

            <label className="blink__field blink__field--grow">
              <span>Brightness</span>
              <input
                type="range" min={0.35} max={1} step={0.05}
                // Inverted: dragging right lowers the exponent, which lifts.
                value={1.35 - gamma}
                onChange={e => setGamma(Math.round((1.35 - Number(e.target.value)) * 100) / 100)}
              />
            </label>

            <button className="btn btn-ghost" onClick={() => setGamma(1)} disabled={gamma === 1} title="Reset brightness">Reset</button>
          </div>

          <input
            className="blink__scrub"
            type="range"
            min={0}
            max={Math.max(0, total - 1)}
            value={index}
            onChange={e => { setPlaying(false); setIndex(Number(e.target.value)) }}
            disabled={total < 2}
          />

          {onToggleDrop && (
            <div className="blink__verdict">
              {/* One control, three readings: the button always toggles the
                  hand-drop, and its label reports what will actually happen —
                  which the quality limit can decide on its own. */}
              <button
                className={`btn blink__call ${
                  isDropped ? 'blink__call--drop-on' : isBelowLine ? 'blink__call--below' : 'blink__call--keep-on'
                }`}
                onClick={toggleDrop}
                title={isDropped ? 'Drop this frame by hand — click to undo (X)' : 'Drop this frame by hand (X)'}
              >
                {isDropped ? '✕ Dropped by hand' : isBelowLine ? '⊘ Below the limit' : '✓ Importing'}
              </button>
              <span className="blink__state">
                {isDropped
                  ? 'Skipped regardless of score — click or press X to put it back'
                  : isBelowLine
                    ? 'Already skipped by the quality limit'
                    : 'Will be imported unless the quality limit drops it'}
              </span>
            </div>
          )}

          <div className="blink__filename">{currentName}</div>
        </div>
      )}
    </div>
  )
}
