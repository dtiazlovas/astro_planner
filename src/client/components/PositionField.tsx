import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { parsePosition, formatRa, formatDec, formatPositionJson } from '../utils/astro'
import { resolveObjectName, type LookupResult } from '../utils/objectLookup'

/**
 * The object position input, with a lookup dialog beside it and a line under it
 * saying how the text was read — the sky card only appears for a position this
 * can parse, so a typo should be visible here rather than as a missing icon.
 */
export default function PositionField({ id, value, onChange, objectName, aliases }: {
  id?: string
  value: string
  onChange: (v: string) => void
  /** Seeds the lookup; aliases are offered as one-click alternatives. */
  objectName: string
  aliases: string
}) {
  const [lookupOpen, setLookupOpen] = useState(false)
  const trimmed = value.trim()
  const parsed = parsePosition(trimmed)

  return (
    <>
      <div className="position-field">
        <input id={id} value={value} onChange={e => onChange(e.target.value)} spellCheck={false}
          placeholder='{"ra": "00h42m44s", "dec": "+41°16′09″"}' />
        <button type="button" className="btn btn-ghost position-field__lookup" onClick={() => setLookupOpen(true)}
          title="Look up coordinates by name (CDS Sesame: SIMBAD, NED, VizieR)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
          Look up
        </button>
      </div>
      {trimmed && trimmed !== '{}' && (
        parsed
          ? <span className="position-field__hint">RA {formatRa(parsed.ra)} · Dec {formatDec(parsed.dec)}</span>
          : <span className="position-field__hint position-field__hint--bad">
              Not readable as a position — needs "ra" and "dec", in degrees or as 00h42m44s / +41°16′09″
            </span>
      )}
      {lookupOpen && createPortal(
        <LookupDialog objectName={objectName} aliases={aliases}
          onUse={r => { onChange(formatPositionJson(r)); setLookupOpen(false) }}
          onClose={() => setLookupOpen(false)} />,
        // Portalled out so it isn't a form inside the object form: Enter in the
        // search box must not submit the object.
        document.body,
      )}
    </>
  )
}

function LookupDialog({ objectName, aliases, onUse, onClose }: {
  objectName: string
  aliases: string
  onUse: (r: LookupResult) => void
  onClose: () => void
}) {
  const candidates = [objectName, ...aliases.split(/[;,]/)].map(s => s.trim()).filter((s, i, all) => s && all.indexOf(s) === i)
  const [query, setQuery] = useState(candidates[0] ?? '')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LookupResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const search = async (q: string) => {
    if (!q.trim()) return
    setQuery(q)
    abortRef.current?.abort()
    const ctl = new AbortController()
    abortRef.current = ctl
    setBusy(true); setResult(null); setMessage(null)
    try {
      const r = await resolveObjectName(q, ctl.signal)
      if (ctl.signal.aborted) return
      if (r) setResult(r)
      else setMessage(`Nothing found for "${q.trim()}". Nicknames aren't always known — try a catalogue designation (NGC 7000, Sh2-129, IC 1805).`)
    } catch (e) {
      if (ctl.signal.aborted) return
      setMessage(`Lookup failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (!ctl.signal.aborted) setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop modal-backdrop--stacked" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-dialog" role="dialog" aria-label="Look up coordinates">
        <div className="modal-dialog__header">
          <span className="modal-dialog__title">Look up coordinates</span>
          <button type="button" className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div className="position-field">
          <input value={query} onChange={e => setQuery(e.target.value)} autoFocus spellCheck={false}
            placeholder="M31, NGC 7000, Heart Nebula…"
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); search(query) } }} />
          <button type="button" className="btn btn-primary" disabled={busy || !query.trim()} onClick={() => search(query)}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </div>
        {candidates.length > 1 && (
          <div className="lookup-chips">
            <span className="cell-muted">Try:</span>
            {candidates.map(c => (
              <button key={c} type="button" className="btn-sm" disabled={busy} onClick={() => search(c)}>{c}</button>
            ))}
          </div>
        )}
        {message && <div className="lookup-message">{message}</div>}
        {result && (
          <div className="lookup-result">
            <div className="lookup-result__name">
              {result.name}
              {result.otype && <span className="type-badge">{result.otype}</span>}
            </div>
            <div className="lookup-result__coords">RA {formatRa(result.ra)} · Dec {formatDec(result.dec)}</div>
            <div className="cell-muted lookup-result__source">J2000, from {result.source}</div>
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => onUse(result)}>Use this position</button>
            </div>
          </div>
        )}
        <span className="cell-muted lookup-footnote">
          Resolved by CDS Sesame (Strasbourg). Only the name you search is sent.
        </span>
      </div>
    </div>
  )
}
