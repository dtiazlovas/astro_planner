import { useEffect, useRef, useState } from 'react'
import { formatLatitude } from '../utils/astro'

interface Props {
  value: number
  /** Fired continuously as the line is dragged / value edited (live UI). */
  onChange: (lat: number) => void
  /** Fired once the change settles (drag end, input commit) — persist here. */
  onCommit?: (lat: number) => void
}

const clampLat = (v: number) => Math.max(-90, Math.min(90, v))
// Latitude → vertical position on the map: +90 at top (0%), −90 at bottom (100%).
const latToPct = (lat: number) => ((90 - lat) / 180) * 100

// Very simplified continent outlines as [lon, lat] rings. Latitudes are the
// point — they're kept roughly faithful so land lines up with the scale; shapes
// are deliberately coarse. Equirectangular: x = lon + 180, y = 90 − lat.
const CONTINENTS: [number, number][][] = [
  // North America
  [[-159, 58], [-165, 60], [-168, 65], [-164, 68], [-156, 71], [-140, 70], [-128, 70], [-110, 73], [-95, 72], [-85, 74], [-78, 73], [-72, 68], [-64, 61], [-60, 55], [-56, 52], [-55, 48], [-60, 47], [-66, 49], [-70, 47], [-66, 44], [-70, 41], [-74, 40], [-76, 35], [-81, 31], [-80, 25], [-84, 30], [-90, 29], [-95, 29], [-97, 26], [-97, 22], [-104, 20], [-106, 23], [-110, 24], [-113, 29], [-114, 32], [-117, 33], [-121, 35], [-124, 40], [-124, 48], [-130, 54], [-135, 58], [-142, 60], [-150, 59], [-155, 58], [-159, 58]],
  // Central America
  [[-92, 18], [-88, 17], [-84, 11], [-80, 9], [-77, 8], [-79, 9], [-83, 13], [-88, 15], [-92, 18]],
  // Greenland
  [[-46, 60], [-40, 63], [-32, 66], [-24, 69], [-20, 72], [-22, 76], [-28, 80], [-40, 83], [-52, 82], [-58, 76], [-55, 70], [-52, 65], [-46, 60]],
  // South America
  [[-77, 8], [-72, 11], [-64, 11], [-60, 6], [-51, 5], [-50, 1], [-44, -2], [-38, -5], [-35, -8], [-39, -13], [-41, -22], [-48, -25], [-54, -34], [-58, -38], [-63, -41], [-65, -45], [-69, -51], [-74, -53], [-72, -49], [-73, -44], [-72, -37], [-71, -30], [-70, -23], [-70, -18], [-76, -14], [-81, -6], [-80, -3], [-81, 0], [-78, 3], [-77, 8]],
  // Africa
  [[-16, 15], [-17, 21], [-13, 28], [-10, 31], [-6, 36], [0, 36], [10, 37], [11, 34], [19, 31], [25, 32], [31, 31], [34, 28], [36, 22], [38, 17], [43, 12], [48, 12], [51, 11], [48, 6], [44, 10], [41, 3], [41, -4], [39, -9], [35, -18], [32, -26], [27, -34], [20, -35], [15, -28], [13, -22], [11, -16], [9, -6], [9, 3], [3, 5], [-5, 5], [-8, 4], [-13, 9], [-16, 15]],
  // Madagascar
  [[47, -12], [50, -15], [50, -19], [47, -24], [44, -23], [44, -19], [45, -15], [47, -12]],
  // Eurasia
  [[-9, 43], [-9, 44], [-4, 48], [-1, 49], [1, 50], [3, 51], [6, 53], [8, 55], [8, 57], [10, 59], [6, 58], [6, 62], [10, 64], [14, 67], [20, 70], [26, 71], [33, 70], [41, 68], [50, 69], [60, 70], [68, 73], [77, 74], [90, 76], [105, 77], [115, 76], [128, 73], [140, 73], [152, 71], [160, 70], [169, 69], [172, 66], [164, 61], [160, 59], [163, 56], [156, 51], [155, 55], [149, 59], [142, 54], [138, 54], [135, 48], [131, 43], [129, 39], [127, 35], [126, 37], [122, 40], [121, 37], [120, 34], [122, 31], [121, 28], [118, 24], [112, 22], [109, 18], [106, 10], [103, 9], [100, 8], [100, 13], [98, 16], [95, 16], [93, 20], [89, 22], [87, 21], [83, 18], [80, 13], [77, 8], [74, 15], [71, 21], [68, 23], [65, 25], [61, 25], [57, 25], [57, 22], [59, 22], [58, 15], [52, 16], [45, 13], [43, 13], [38, 21], [35, 28], [34, 31], [36, 36], [32, 36], [28, 37], [26, 39], [23, 40], [19, 40], [16, 41], [13, 40], [12, 44], [8, 44], [4, 43], [3, 42], [0, 40], [-2, 36], [-6, 36], [-9, 37], [-9, 43]],
  // Australia
  [[114, -22], [122, -18], [130, -12], [137, -12], [142, -11], [145, -15], [147, -19], [150, -25], [150, -32], [148, -38], [143, -39], [137, -35], [130, -32], [123, -34], [115, -35], [113, -26], [114, -22]],
  // Tasmania
  [[145, -41], [148, -41], [148, -43], [146, -43], [145, -41]],
  // New Zealand (North)
  [[172, -34], [174, -37], [178, -38], [176, -41], [173, -41], [172, -37], [172, -34]],
  // New Zealand (South)
  [[167, -44], [171, -43], [174, -46], [168, -47], [166, -45], [167, -44]],
  // Japan
  [[130, 31], [132, 34], [136, 35], [140, 36], [142, 40], [141, 43], [144, 44], [140, 42], [137, 37], [133, 34], [130, 33], [130, 31]],
  // Great Britain
  [[-5, 50], [-3, 51], [0, 52], [-1, 54], [-3, 55], [-2, 58], [-5, 58], [-6, 55], [-5, 53], [-5, 50]],
  // Ireland
  [[-10, 52], [-6, 52], [-6, 55], [-10, 55], [-10, 52]],
  // Iceland
  [[-24, 65], [-20, 66], [-14, 65], [-18, 64], [-22, 64], [-24, 65]],
  // Sri Lanka
  [[80, 9], [82, 8], [82, 6], [80, 6], [80, 9]],
  // Sumatra
  [[95, 5], [99, 2], [104, -2], [106, -6], [102, -5], [98, 0], [95, 5]],
  // Java
  [[105, -6], [112, -7], [114, -8], [108, -8], [105, -7], [105, -6]],
  // Borneo
  [[109, 2], [115, 5], [118, 4], [117, -2], [111, -3], [109, 0], [109, 2]],
  // New Guinea
  [[131, -1], [141, -2], [147, -6], [150, -10], [144, -9], [137, -8], [132, -4], [131, -1]],
  // Philippines
  [[120, 18], [124, 17], [126, 10], [122, 7], [120, 12], [120, 18]],
  // Antarctica (coastal band)
  [[-180, -72], [-150, -74], [-120, -73], [-90, -72], [-60, -71], [-30, -70], [0, -69], [30, -68], [60, -67], [90, -66], [120, -68], [150, -71], [180, -72], [180, -85], [-180, -85], [-180, -72]],
]

const ringToPath = (ring: [number, number][]): string =>
  ring.map(([lon, lat], i) => `${i === 0 ? 'M' : 'L'}${(lon + 180).toFixed(1)} ${(90 - lat).toFixed(1)}`).join(' ') + ' Z'

// Labeled reference parallels (astronomical/geographic).
const REFERENCE_LINES: { lat: number; label: string }[] = [
  { lat: 66.56, label: 'Arctic Circle' },
  { lat: 23.44, label: 'Tropic of Cancer' },
  { lat: 0, label: 'Equator' },
  { lat: -23.44, label: 'Tropic of Capricorn' },
  { lat: -66.56, label: 'Antarctic Circle' },
]

export default function LatitudePicker({ value, onChange, onCommit }: Props) {
  const mapRef = useRef<HTMLDivElement>(null)
  // Geometry captured at drag start so mid-drag layout shifts don't feed back.
  const dragRectRef = useRef<{ top: number; height: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [text, setText] = useState(value.toFixed(2))

  // Keep the text box in sync with the value unless the user is mid-edit.
  useEffect(() => { setText(value.toFixed(2)) }, [value])

  const latFromClientY = (clientY: number): number => {
    const r = dragRectRef.current
    if (!r) return value
    const ratio = (clientY - r.top) / r.height
    return clampLat(Math.round((90 - ratio * 180) * 100) / 100)
  }

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => onChange(latFromClientY(e.clientY))
    const onUp = (e: PointerEvent) => {
      onChange(latFromClientY(e.clientY))
      onCommit?.(latFromClientY(e.clientY))
      setDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging]) // eslint-disable-line react-hooks/exhaustive-deps

  const startDrag = (e: React.PointerEvent) => {
    const el = mapRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    dragRectRef.current = { top: r.top, height: r.height }
    onChange(latFromClientY(e.clientY))
    setDragging(true)
  }

  const commitText = () => {
    const v = parseFloat(text)
    if (!isNaN(v)) {
      const c = clampLat(Math.round(v * 100) / 100)
      onChange(c)
      onCommit?.(c)
      setText(c.toFixed(2))
    } else {
      setText(value.toFixed(2))
    }
  }

  const selPct = latToPct(value)

  return (
    <div className="lat-picker">
      <div
        ref={mapRef}
        className={`lat-picker__map ${dragging ? 'lat-picker__map--dragging' : ''}`}
        onPointerDown={startDrag}
      >
        <svg className="lat-picker__geo" viewBox="0 0 360 180" preserveAspectRatio="none" aria-hidden="true">
          {CONTINENTS.map((ring, i) => <path key={i} d={ringToPath(ring)} />)}
        </svg>

        <span className="lat-picker__hemi lat-picker__hemi--n">N</span>
        <span className="lat-picker__hemi lat-picker__hemi--s">S</span>

        {REFERENCE_LINES.map(l => (
          <div key={l.lat} className="lat-picker__ref" style={{ top: `${latToPct(l.lat)}%` }}>
            <span className="lat-picker__ref-label">{l.label}</span>
          </div>
        ))}

        {/* current-latitude line + handle */}
        <div className="lat-picker__line" style={{ top: `${selPct}%` }}>
          <span className="lat-picker__badge">{formatLatitude(value)}</span>
          <span className="lat-picker__handle" />
        </div>
      </div>

      <div className="lat-picker__controls">
        <label htmlFor="lat-input">Latitude</label>
        <input
          id="lat-input"
          type="number"
          min={-90}
          max={90}
          step={0.1}
          value={text}
          onChange={e => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitText() } }}
          style={{ width: '6rem' }}
        />
        <span className="cell-muted">° &nbsp;(positive = North, negative = South)</span>
      </div>
    </div>
  )
}
