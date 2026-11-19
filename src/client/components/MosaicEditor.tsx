import { useState } from 'react'

// ── Mosaic layout editor ─────────────────────────────────────────────────────
// A rows × cols picker; past 1×1 it shows the grid, and each cell is clicked to
// set the suffix the capture tool glues onto the target for that panel
// ("fossil2" → panel "2"). The suffix is also the panel's folder name inside
// each filter folder.

export interface MosaicValue { rows: number; cols: number; panels: string[] | null }

export const PLAIN_MOSAIC: MosaicValue = { rows: 1, cols: 1, panels: null }
/** The size picker's extent. */
const PICKER_SIDE = 4

/**
 * Suffixes for a grid, keeping whatever the previous grid had at the same row
 * and column. New cells get a guess: "1", "2", … for a strip, row-then-column
 * ("11", "12", "21") for a grid.
 */
export function resizePanels(rows: number, cols: number, prev: MosaicValue): string[] | null {
  if (rows * cols <= 1) return null
  const out: string[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const kept = prev.panels && r < prev.rows && c < prev.cols ? prev.panels[r * prev.cols + c] : undefined
      out.push(kept ?? (rows === 1 || cols === 1 ? String(r * cols + c + 1) : `${r + 1}${c + 1}`))
    }
  }
  return out
}

const normSuffix = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** What's wrong with a layout, mirroring the server's checks; null when fine. */
export function mosaicProblem(v: MosaicValue): string | null {
  if (!v.panels) return null
  const trimmed = v.panels.map(p => p.trim())
  if (trimmed.some(p => !p)) return 'Every panel needs a suffix'
  if (trimmed.some(p => /[\\/:*?"<>|]/.test(p))) return 'Suffixes become folder names — avoid \\ / : * ? " < > |'
  if (trimmed.some(p => !normSuffix(p))) return 'Suffixes need at least one letter or digit'
  const seen = new Set<string>()
  for (const p of trimmed) {
    if (seen.has(normSuffix(p))) return `"${p}" is used twice (case and separators are ignored when matching)`
    seen.add(normSuffix(p))
  }
  return null
}

interface Props {
  value: MosaicValue
  onChange: (v: MosaicValue) => void
  /** Shown under the grid, e.g. the object name, to preview a matched target. */
  objectName?: string
  /** Entries already recorded against these panels — a resize won't carry them. */
  hasCapturedTime?: boolean
  idPrefix?: string
}

export default function MosaicEditor({ value, onChange, objectName, hasCapturedTime, idPrefix = 'mosaic' }: Props) {
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  // The size under the pointer while dragging across the picker; null when idle.
  const [dragSize, setDragSize] = useState<{ rows: number; cols: number } | null>(null)
  const problem = mosaicProblem(value)

  const setSize = (rows: number, cols: number) => {
    setEditing(null)
    if (rows === value.rows && cols === value.cols) return
    onChange({ rows, cols, panels: resizePanels(rows, cols, value) })
  }

  // The picker cell under a point. Hit-testing by position rather than
  // per-cell enter events, because pointer capture (which keeps the drag alive
  // when the pointer strays outside) routes every event to the grid itself.
  const cellAt = (x: number, y: number): { rows: number; cols: number } | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    const r = el?.dataset.pickRow, c = el?.dataset.pickCol
    return r && c ? { rows: Number(r), cols: Number(c) } : null
  }

  const onPickerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const hit = cellAt(e.clientX, e.clientY)
    if (!hit) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragSize(hit)
  }
  const onPickerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragSize) return
    const hit = cellAt(e.clientX, e.clientY)
    if (hit && (hit.rows !== dragSize.rows || hit.cols !== dragSize.cols)) setDragSize(hit)
  }
  const onPickerUp = () => {
    if (dragSize) setSize(dragSize.rows, dragSize.cols)
    setDragSize(null)
  }

  const shown = dragSize ?? { rows: value.rows, cols: value.cols }

  const startEdit = (i: number) => {
    setEditing(i)
    setDraft(value.panels?.[i] ?? '')
  }

  const commit = () => {
    if (editing == null || !value.panels) return
    const panels = [...value.panels]
    panels[editing] = draft.trim()
    onChange({ ...value, panels })
    setEditing(null)
  }

  const sample = objectName?.trim() && value.panels?.[0] ? `${objectName.trim()}${value.panels[0]}` : null
  const side = Math.max(PICKER_SIDE, value.rows, value.cols)

  return (
    <div className="mosaic-editor">
      <div className="mosaic-editor__size">
        <div id={`${idPrefix}-picker`} className="mosaic-picker" role="group"
          aria-label="Mosaic size — drag from the top-left cell"
          style={{ gridTemplateColumns: `repeat(${side}, 1fr)` }}
          onPointerDown={onPickerDown} onPointerMove={onPickerMove}
          onPointerUp={onPickerUp} onPointerCancel={() => setDragSize(null)}>
          {Array.from({ length: side * side }, (_, i) => {
            const r = Math.floor(i / side) + 1, c = i % side + 1
            const on = r <= shown.rows && c <= shown.cols
            return (
              <button key={i} type="button" tabIndex={-1}
                className={`mosaic-picker__cell${on ? ' mosaic-picker__cell--on' : ''}${dragSize && on ? ' mosaic-picker__cell--drag' : ''}`}
                data-pick-row={r} data-pick-col={c}
                aria-label={`${c} wide × ${r} tall`} />
            )
          })}
        </div>
        <div className="mosaic-editor__size-text">
          <span className="mosaic-editor__dims">{shown.cols} × {shown.rows}</span>
          <span className="cell-muted mosaic-editor__hint">
            {dragSize
              ? 'Release to set'
              : value.panels
                ? 'Drag to resize · click a panel below to set its suffix'
                : 'Single frame — drag from the top-left to make a mosaic'}
          </span>
        </div>
      </div>

      {value.panels && (
        <>
          <div className="mosaic-editor__grid" style={{ gridTemplateColumns: `repeat(${value.cols}, minmax(0, 1fr))` }}>
            {value.panels.map((p, i) => (
              editing === i ? (
                <input key={i} className="mosaic-editor__cell mosaic-editor__cell--editing" autoFocus
                  value={draft} spellCheck={false} aria-label={`Suffix for row ${Math.floor(i / value.cols) + 1}, column ${i % value.cols + 1}`}
                  onChange={e => setDraft(e.target.value)}
                  onBlur={commit}
                  onKeyDown={e => {
                    // Enter would submit the surrounding form.
                    if (e.key === 'Enter') { e.preventDefault(); commit() }
                    if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
                  }} />
              ) : (
                <button key={i} type="button"
                  className={`mosaic-editor__cell${p.trim() ? '' : ' mosaic-editor__cell--empty'}`}
                  onClick={() => startEdit(i)}
                  title={`Row ${Math.floor(i / value.cols) + 1}, column ${i % value.cols + 1} — click to change the suffix`}>
                  {p.trim() || 'set'}
                </button>
              )
            ))}
          </div>
          {problem
            ? <span className="mosaic-editor__problem">{problem}</span>
            : sample && <span className="cell-muted mosaic-editor__hint">Matches targets like <code className="inline-code">{sample}</code>; subs go to a <code className="inline-code">{value.panels[0]}</code> folder inside each filter folder.</span>}
          {hasCapturedTime && (
            <span className="cell-muted mosaic-editor__hint">Renaming a suffix carries its captured time over; resizing the grid doesn't — those entries keep their old suffix until a sync.</span>
          )}
        </>
      )}
    </div>
  )
}
